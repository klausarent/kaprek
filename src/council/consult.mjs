// One consultation: ask every peer the same question, independently, and
// report where they agree and where they do not.
//
// Three rules this file exists to enforce, all of them Klaus' own working
// rules turned into code:
//
//   1. A peer never sees the conversation. It gets a package — the question,
//      the files that matter, the constraints, what has already been tried.
//      Live debugging is not delegated: the thread of an investigation does
//      not survive being handed over, and a peer answering from half the
//      context answers confidently and wrongly.
//   2. Peers are asked in parallel and read-only. Two engines writing in one
//      working tree is a corrupted tree; reviews that only read cannot
//      collide.
//   3. Disagreement is the output. A council that always reports consensus
//      has checked nothing. The summary names what everyone agreed on AND
//      what they did not, and never resolves the second into the first.
//
// A peer that never answers is reported as unreachable and blocks nothing —
// Codex' review flagged exactly this: with a consultation sitting between
// the quiz and the plan, one hung peer could otherwise hold up the whole
// flow.

/** How a peer is asked to summarize its position. */
export const VERDICTS = ['agree', 'concerns', 'disagree'];

/** A peer gets this long to answer before it counts as unreachable. */
export const DEFAULT_PEER_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * The package a peer receives. Deliberately not the chat: everything here is
 * something the asker had to state on purpose.
 *
 * @param {string} options.question - what is actually being decided
 * @param {string[]} [options.files] - paths worth reading (never contents:
 *   the peer runs in the same working directory and can read them itself,
 *   and pasting them in is how a package grows past what any model reads)
 * @param {string[]} [options.constraints] - what the answer must respect
 * @param {string[]} [options.tried] - what has already been ruled out
 */
export function buildPackage({ question, files = [], constraints = [], tried = [] }) {
  const section = (title, items) => (items.length > 0 ? `\n## ${title}\n${items.map((item) => `- ${item}`).join('\n')}\n` : '');
  return `You are being asked for an independent second opinion. You have not
seen the conversation this came from, and you do not need it — everything
that matters is below.

## The question
${question}
${section('Files worth reading', files)}${section('Constraints the answer must respect', constraints)}${section('Already tried or ruled out', tried)}
## How to answer
Read what you need, then reply with ONE json object and nothing else:

{"verdict": "agree" | "concerns" | "disagree",
 "summary": "your position in two or three sentences",
 "risks": ["the specific thing that goes wrong, if any"]}

Do not modify any file. Disagree if you disagree — a second opinion that
echoes the first is worthless, and "concerns" is not a polite way of saying
"agree".`;
}

/**
 * Every balanced `{...}` in `text`, in order.
 *
 * Brace counting rather than a regex: peers wrap their JSON in prose and
 * fences no matter how firmly they are asked not to, and a lazy regex either
 * stops at the first inner `}` or swallows two objects into one. Quotes and
 * escapes are tracked so a brace inside a string does not close anything.
 */
function jsonObjects(text) {
  const found = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) found.push(text.slice(start, i + 1));
    }
  }
  return found;
}

/** Parses one peer's answer, or explains why it could not be used. */
export function parseVerdict(raw) {
  const text = typeof raw === 'string' ? raw : '';
  // Read from the back: a peer that reconsiders mid-answer means the last
  // verdict it stated, not the first.
  const attempts = jsonObjects(text);

  for (const candidate of attempts.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (VERDICTS.includes(parsed?.verdict) && typeof parsed?.summary === 'string') {
        return {
          verdict: parsed.verdict,
          summary: parsed.summary,
          risks: Array.isArray(parsed.risks) ? parsed.risks.filter((r) => typeof r === 'string') : [],
        };
      }
    } catch {
      // keep looking — an earlier object may be the real one
    }
  }
  return null;
}

/**
 * Splits verdicts into what everyone shares and what they do not.
 *
 * `consensus` requires every reachable peer to have said 'agree'. One
 * dissenter is enough to make this a decision a human takes — which is the
 * entire reason for asking.
 */
export function summarize(answers) {
  const answered = answers.filter((answer) => answer.verdict !== null);
  const unreachable = answers.filter((answer) => answer.verdict === null);
  const byVerdict = Object.fromEntries(VERDICTS.map((verdict) => [verdict, answered.filter((answer) => answer.verdict === verdict)]));

  return {
    consensus: answered.length > 0 && byVerdict.agree.length === answered.length,
    agreed: byVerdict.agree.map((answer) => answer.peerId),
    dissenting: [...byVerdict.concerns, ...byVerdict.disagree].map((answer) => ({
      peerId: answer.peerId,
      verdict: answer.verdict,
      summary: answer.summary,
      risks: answer.risks,
    })),
    unreachable: unreachable.map((answer) => ({ peerId: answer.peerId, error: answer.error })),
    // Nobody answered at all: not consensus, not dissent, just no council.
    empty: answered.length === 0,
  };
}

/**
 * Asks every peer, in parallel, and returns their answers plus the summary.
 *
 * @param {(peerId: string, prompt: string, options: {signal: AbortSignal}) => Promise<string>} options.askPeer
 *   how to actually reach a peer — injected so this module knows nothing
 *   about processes, and so tests never spawn one
 * @param {number} [options.timeoutMs] - per peer, not for the whole round: a
 *   slow peer must not shorten the deadline of a fast one
 */
export async function consultPeers({ peers = [], askPeer, timeoutMs = DEFAULT_PEER_TIMEOUT_MS, signal, ...packageParts }) {
  const prompt = buildPackage(packageParts);

  const answers = await Promise.all(
    peers.map(async (peerId) => {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        // Raced, not merely signalled: a driver that ignores its abort
        // signal would otherwise hold this consultation open forever, which
        // is the exact failure Codex' review named — one hung peer stalling
        // the flow it sits inside.
        const raw = await Promise.race([
          askPeer(peerId, prompt, { signal: controller.signal }),
          new Promise((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error(signal?.aborted ? 'the consultation was cancelled' : `no answer within ${Math.round(timeoutMs / 1000)}s`)), {
              once: true,
            });
          }),
        ]);
        const verdict = parseVerdict(raw);
        return verdict === null
          ? { peerId, verdict: null, summary: null, risks: [], error: 'the answer could not be read as a verdict', raw }
          : { peerId, ...verdict, error: null, raw };
      } catch (err) {
        // One peer failing is a fact to report, never a reason to lose the
        // others' answers.
        const reason = controller.signal.aborted && !signal?.aborted ? `no answer within ${Math.round(timeoutMs / 1000)}s` : (err?.message ?? String(err));
        return { peerId, verdict: null, summary: null, risks: [], error: reason, raw: null };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }),
  );

  return { prompt, answers, ...summarize(answers) };
}
