// A working note kaprek keeps while a long turn is still running.
//
// The problem this exists for is one every long session has: the model
// compacts, and the first thing to go is what it was actually doing. What
// survives compaction is whatever was written down somewhere the compaction
// cannot reach.
//
// TASK-BOUND, NOT GLOBAL. One checkpoint per chat, next to that chat's
// transcript — never a single working-memory.md. Two agents working in
// parallel on one machine would otherwise overwrite each other's idea of
// "what we are doing", and the loser would be whichever one wrote first.
//
// NOT MEMORY. A checkpoint is a working state, not a fact: it is overwritten
// as the work moves, and it says nothing about what is true beyond this
// chat. Facts go through remember() and get a scope and an age; this gets
// neither.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Tool calls after which a checkpoint is worth writing.
 *
 * Rising gaps rather than "every N": the early part of a turn is where
 * direction is set and cheap to record, and by call eighty a rewrite every
 * twenty calls is noise. Taken from the enforcement spec's own 20/40/80.
 */
export const CHECKPOINT_AT = [20, 40, 80];

export function checkpointPath(dataDir, chatId) {
  return path.join(dataDir, 'chats', chatId, 'checkpoint.json');
}

/**
 * Whether this tool call is one of the thresholds.
 *
 * Exact equality, so a turn passing 20 writes once and not on every call
 * after it.
 */
export function shouldCheckpoint(toolCalls) {
  return CHECKPOINT_AT.includes(toolCalls);
}

/** The first line of the user's own text, as the task. Their words, not a summary of them. */
function taskFrom(events) {
  const first = events.find((event) => event.kind === 'user');
  return (first?.text ?? '').split('\n').find((line) => line.trim() !== '')?.slice(0, 300) ?? '';
}

/**
 * What the assistant said that reads like a decision or a risk.
 *
 * Deliberately a crude filter over the assistant's own sentences rather than
 * a summarizing model call: a checkpoint that costs a turn to write is one
 * nobody will enable, and a wrong summary is worse than a quoted sentence.
 */
function linesMatching(events, pattern, limit) {
  const found = [];
  for (const event of events) {
    if (event.kind !== 'assistant' || typeof event.text !== 'string') continue;
    for (const line of event.text.split('\n')) {
      const trimmed = line.replace(/^[-*]\s*/, '').trim();
      if (trimmed.length < 15 || trimmed.length > 240) continue;
      if (!pattern.test(trimmed)) continue;
      if (!found.includes(trimmed)) found.push(trimmed);
      if (found.length >= limit) return found;
    }
  }
  return found;
}

const DECISION_RE = /\b(decided|chose|choosing|going with|instead of|will use|approach is|because)\b/i;
const RISK_RE = /\b(risk|careful|might break|fails? if|watch out|unclear|not sure|blocked|cannot)\b/i;

/**
 * Builds the checkpoint for a chat from its own transcript.
 *
 * @returns {{chatId: string, task: string, decisions: string[], risks: string[], toolCalls: number, at: string}}
 */
export function buildCheckpoint({ chatId, events = [], toolCalls = 0, now = Date.now }) {
  return {
    chatId,
    task: taskFrom(events),
    decisions: linesMatching(events, DECISION_RE, 5),
    risks: linesMatching(events, RISK_RE, 3),
    toolCalls,
    at: new Date(now()).toISOString(),
  };
}

/** Writes it beside the chat. Best-effort: a checkpoint that cannot be written must not fail a turn. */
export function writeCheckpoint(dataDir, checkpoint) {
  try {
    const target = checkpointPath(dataDir, checkpoint.chatId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

export function readCheckpoint(dataDir, chatId) {
  try {
    return JSON.parse(fs.readFileSync(checkpointPath(dataDir, chatId), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The rehydration block: what this chat was doing, put back after a
 * compaction took it away.
 *
 * Only worth sending when there HAS been a compaction — before that the
 * model still has the conversation, and repeating it back would spend
 * context on something already in context.
 */
export function buildRehydrationPrompt(checkpoint) {
  if (!checkpoint || checkpoint.task === '') return '';
  const lines = ['## Where this conversation was before it was compacted', '', `The task, in the words it was asked in: ${checkpoint.task}`];
  if (checkpoint.decisions.length > 0) lines.push('', 'Decisions already taken (do not re-open them without a reason):', ...checkpoint.decisions.map((entry) => `- ${entry}`));
  if (checkpoint.risks.length > 0) lines.push('', 'Open risks noted earlier:', ...checkpoint.risks.map((entry) => `- ${entry}`));
  lines.push('', 'This is a summary written mid-turn, not a transcript. If it contradicts what you can see, what you can see wins.');
  return lines.join('\n');
}

/** Whether this chat's log shows a compaction — the signal that rehydration is worth sending. */
export function wasCompacted(events = []) {
  return events.some((event) => event.kind === 'compact');
}
