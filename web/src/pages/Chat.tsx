// Chat page (#/chat, #/chat/<id>): a text box that runs a turn against the
// user's own already-authenticated Claude Code CLI (see
// src/harness/claude-code.mjs — no API key ever touches this app) and
// streams the result back live, rendered through the SAME EventBlock.tsx
// the session viewer already uses for finished transcripts.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  answerApproval,
  cancelChatTurn,
  fetchChat,
  fetchEngines,
  streamChatTurn,
  toDigestEvent,
  type ApprovalMode,
  type ChatStreamEvent,
  type DigestEvent,
  type Engine,
  type RelayRun,
} from "../lib/api";
import EngineBadge from "../components/EngineBadge";
import { upsertQuestion } from "../lib/questions";
import RelayPanel from "../components/RelayPanel";
import {
  addApproval,
  buildApprovalAnswer,
  dropExpired,
  removeApproval,
  removeApprovalsForChat,
  type PendingApproval,
} from "../lib/approvals";
import { applyAgentEvent, clearAwaitingApproval, initialAgentPanel, shouldAutoExpand } from "../lib/agents";
import { setStatus } from "../lib/status";
import { navigateToChats } from "../App";
import EventBlock from "../components/EventBlock";
import ApprovalDialog from "../components/ApprovalDialog";
import AgentPanel from "../components/AgentPanel";

/**
 * Turns a live SSE 'tool-start' event into a DigestEvent with `result: null`
 * — ToolBlock (EventBlock.tsx) already renders that as "interrupted / no
 * result", which reads a little off for "still running", but it is the one
 * state EventBlock already knows how to show without changes. Once the
 * matching 'tool-end' arrives, updateToolResult() replaces this same list
 * entry in place so the final render is indistinguishable from a reloaded,
 * fully-persisted tool event.
 */
function pendingToolEvent(event: Extract<ChatStreamEvent, { type: "tool-start" }>): DigestEvent {
  return {
    kind: "tool",
    ts: new Date().toISOString(),
    msgId: null,
    name: event.name,
    input: JSON.stringify(event.input, null, 2),
    result: null,
    resultRef: null,
  };
}

function nowEvent(kind: "assistant" | "thinking" | "user", text: string): DigestEvent {
  return { kind, ts: new Date().toISOString(), msgId: null, text };
}

type TurnSummary = {
  costUsd: number | null;
  stopReason: "result" | "aborted" | "error" | "timeout";
  errorMessage: string | null;
};

export default function Chat({ chatId: initialChatId, missionId }: { chatId?: string; missionId?: string }) {
  const [chatId, setChatId] = useState<string | undefined>(initialChatId);
  // The relay run this chat hosts, if any. Reloaded on demand rather than
  // polled: it changes when the operator does something (start, stop, answer
  // a gate), and those are the moments this component already re-renders.
  const [relay, setRelay] = useState<RelayRun | null>(null);
  const [relayReloads, setRelayReloads] = useState(0);
  const [events, setEvents] = useState<DigestEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [lastTurn, setLastTurn] = useState<TurnSummary | null>(null);
  const [rateLimitHint, setRateLimitHint] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [deciding, setDeciding] = useState(false);
  const [decideError, setDecideError] = useState<string | null>(null);
  const [agentPanel, setAgentPanel] = useState(initialAgentPanel);
  const [panelExpanded, setPanelExpanded] = useState(false);
  // One shared clock for the approval countdown and the turn duration, ticked
  // only while something is actually running or waiting (see below).
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Which engine a NEW chat will run on. Fixed at chat creation server-side;
  // an existing chat only displays what it already is.
  const [engine, setEngine] = useState("claude-code");
  const [engines, setEngines] = useState<Engine[]>([]);
  // Per-turn approval stance, remembered across sessions — the person who
  // works in full auto works in full auto tomorrow too.
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(() => {
    const stored = window.localStorage.getItem("kaprek-approval-mode");
    return stored === "edits" || stored === "auto" ? stored : "ask";
  });
  const pickApprovalMode = (mode: ApprovalMode) => {
    setApprovalMode(mode);
    try {
      window.localStorage.setItem("kaprek-approval-mode", mode);
    } catch {
      // storage full/blocked — the select still works for this session
    }
  };

  const abortRef = useRef<AbortController | null>(null);
  // id -> index into `events`, for the tool-start/tool-end event this turn
  // still hasn't seen the matching end for.
  const pendingToolIndex = useRef<Map<string, number>>(new Map());
  const eventsEndRef = useRef<HTMLDivElement | null>(null);

  // Load an existing chat's history when opened via #/chat/<id>. A brand new
  // chat (no id yet) starts with an empty transcript instead.
  //
  // The early return is safe ONLY because App.tsx gives this component a `key`
  // that changes whenever the user navigates to a new chat (see
  // chatInstanceKey()), so "no id" always means a freshly mounted instance with
  // empty state. Remove that key and this effect silently keeps the previous
  // chat's transcript, chatId, approval stack and agent panel — and the next
  // message goes to the chat the user just tried to leave.
  useEffect(() => {
    if (!initialChatId) return;
    setLoadError(null);
    fetchChat(initialChatId)
      .then(({ chat, events: stored }) => {
        setChatId(initialChatId);
        setEvents(stored.map(toDigestEvent));
        setRelay(chat?.relay ?? null);
        setEngine(chat?.engine ?? "claude-code");
      })
      .catch((e) => setLoadError((e as Error).message));
  }, [initialChatId, relayReloads]);

  // The picker's options — only a brand-new chat needs them; an existing
  // chat's engine is already settled.
  useEffect(() => {
    if (initialChatId) return;
    fetchEngines()
      .then(setEngines)
      .catch(() => setEngines([]));
  }, [initialChatId]);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events]);

  // Abort any in-flight turn if the user navigates away mid-stream.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // The clock only runs while there is something to count: a live turn (the
  // agent panel's duration) or an open approval (its countdown). An idle chat
  // page must not re-render once a second forever.
  const needsClock = streaming || approvals.length > 0;
  useEffect(() => {
    if (!needsClock) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      // An entry whose cosmetic countdown ran out was denied by the server's
      // own timer long since — stop offering buttons for it.
      setApprovals((prev) => dropExpired(prev, now));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [needsClock]);

  // A second agent showing up opens the panel by itself; a single agent leaves
  // it collapsed. Either way the user's own toggle wins afterwards.
  useEffect(() => {
    if (shouldAutoExpand(agentPanel)) setPanelExpanded(true);
  }, [agentPanel]);

  // Feeds the header's status dot (lib/status.ts) — no polling endpoint, just
  // the state this page already holds.
  useEffect(() => {
    setStatus({ turnRunning: streaming, approvalsOpen: approvals.length });
  }, [streaming, approvals.length]);

  useEffect(() => {
    return () => setStatus({ turnRunning: false, approvalsOpen: 0 });
  }, []);

  const canSend = draft.trim().length > 0 && !streaming;

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft("");
    setStreamError(null);
    setLastTurn(null);
    setRateLimitHint(null);
    setEvents((prev) => [...prev, nowEvent("user", text)]);
    pendingToolIndex.current = new Map();
    setAgentPanel(initialAgentPanel());
    setPanelExpanded(false);
    setNowMs(Date.now());

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);

    try {
      await streamChatTurn({
        chatId,
        // Only the turn that CREATES the chat carries the mission and the
        // engine — a follow-up turn takes both from the chat itself,
        // server-side.
        missionId: chatId ? undefined : missionId,
        engine: chatId ? undefined : engine,
        approvalMode,
        text,
        signal: controller.signal,
        onEvent: (event) => handleStreamEvent(event),
      });
    } catch (e) {
      // AbortError is the expected shape of a user-triggered Stop — the
      // server-side turn still resolves (with stopReason 'aborted') and
      // reports itself via its own 'turn-complete' frame before that
      // happens, so this branch only needs to handle a genuine network/fetch
      // failure (including IncompleteStreamError, see streamChatTurn's doc
      // comment — a response body that ends without ever sending
      // 'turn-complete' must surface as an error here, not be treated as a
      // silently successful turn), not the cancel path itself.
      if ((e as Error).name !== "AbortError") {
        setStreamError((e as Error).message || "Stream failed");
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  function handleStreamEvent(event: ChatStreamEvent) {
    // Every frame also feeds the agent panel; irrelevant types are identity
    // there (see lib/agents.ts::applyAgentEvent).
    const seenAt = Date.now();
    setAgentPanel((prev) => applyAgentEvent(prev, event, seenAt));
    switch (event.type) {
      case "chat-id":
        setChatId(event.chatId);
        if (window.location.hash !== `#/chat/${event.chatId}`) {
          window.history.replaceState(null, "", `#/chat/${event.chatId}`);
        }
        break;
      case "init":
        if (event.model) setModel(event.model);
        break;
      case "text":
        setEvents((prev) => [...prev, nowEvent("assistant", event.text)]);
        break;
      case "thinking":
        // Empty thinking (the CLI redacts the text, signature-only) still
        // feeds the agent panel above as activity, but must not stack empty
        // blocks in the transcript.
        if (event.text.trim() !== "") {
          setEvents((prev) => [...prev, nowEvent("thinking", event.text)]);
        }
        break;
      case "tool-start":
        setEvents((prev) => {
          const next = [...prev, pendingToolEvent(event)];
          pendingToolIndex.current.set(event.id, next.length - 1);
          return next;
        });
        break;
      case "tool-end": {
        const idx = pendingToolIndex.current.get(event.id);
        if (idx === undefined) break;
        pendingToolIndex.current.delete(event.id);
        setEvents((prev) => {
          const current = prev[idx];
          if (!current || current.kind !== "tool") return prev;
          const next = prev.slice();
          next[idx] = { ...current, result: event.result };
          return next;
        });
        break;
      }
      case "rate-limit":
        setRateLimitHint("Rate limit signal received from the CLI — this turn may be slower or get throttled.");
        break;
      case "approval":
        // A DEFERRED question was filed, not asked of whoever happens to be
        // on this page: the turn already carried on without an answer. It
        // belongs in the floating box (visible on every route), not in this
        // turn's modal dialog, which exists for questions a turn is waiting on.
        if (event.mode === "deferred") {
          upsertQuestion({ ...event, requestedAt: event.requestedAt ?? seenAt, deadlineAt: event.deadlineAt ?? null });
          break;
        }
        setNowMs(seenAt);
        setApprovals((prev) => addApproval(prev, event, seenAt));
        break;
      case "error":
        setStreamError(event.message);
        break;
      case "result":
        // Superseded by 'turn-complete' below, which carries the same
        // sessionId/costUsd plus the orchestrator's own stopReason/error.
        break;
      case "turn-complete":
        setLastTurn({ costUsd: event.costUsd, stopReason: event.stopReason, errorMessage: event.error?.message ?? null });
        // The server resolved (denied) every approval still pending for this
        // chat when the turn ended — see cleanupApprovalsForChat — so nothing
        // left in the stack for it can still be answered.
        setApprovals((prev) => removeApprovalsForChat(prev, event.chatId));
        break;
      default:
        break;
    }
  }

  /**
   * Answers the visible approval.
   *
   * The entry is removed for exactly two outcomes: the answer landed, or the
   * server says there was nothing left to answer (404/409 — already decided, or
   * its own 10-minute timer got there first; 'gone', no error shown).
   *
   * Any OTHER failure (500, network drop) keeps the entry in the stack and
   * shows the message on the dialog, so the user can press the button again.
   * Dropping it there would take the question away over a transient error and
   * leave the tool call to be auto-denied ten minutes later with no way to
   * intervene.
   */
  const handleDecide = async (entry: PendingApproval, behavior: "allow" | "deny") => {
    if (deciding) return;
    setDeciding(true);
    setDecideError(null);
    const answer = buildApprovalAnswer(entry, behavior);
    try {
      await answerApproval(answer.id, answer.body);
      setApprovals((prev) => removeApproval(prev, entry.chatId, entry.id));
      setAgentPanel((prev) => clearAwaitingApproval(prev, entry.agentId));
    } catch (e) {
      setDecideError(`Could not send your answer (${(e as Error).message}). Try again.`);
    } finally {
      setDeciding(false);
    }
  };

  const handleStop = async () => {
    if (!chatId) {
      // No chat-id frame has arrived yet — abort the fetch locally, there is
      // nothing on the server side to reach yet.
      abortRef.current?.abort();
      return;
    }
    try {
      await cancelChatTurn(chatId);
    } catch (e) {
      setStreamError((e as Error).message || "Failed to cancel");
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const turnLine = useMemo(() => {
    if (!lastTurn) return null;
    const parts: string[] = [];
    if (lastTurn.costUsd !== null) parts.push(`cost $${lastTurn.costUsd.toFixed(4)}`);
    if (model) parts.push(model);
    if (lastTurn.stopReason !== "result") parts.push(lastTurn.stopReason);
    return parts.join(" · ");
  }, [lastTurn, model]);

  return (
    <div className="page chat-page">
      <header className="page-header">
        <h1>Chat</h1>
        <p className="page-subtitle">
          Runs against your own Claude Code CLI, in the background — no API key involved.{" "}
          <a
            href="#/chats"
            onClick={(e) => {
              e.preventDefault();
              navigateToChats();
            }}
          >
            All chats
          </a>
        </p>
      </header>

      {/* Only on a chat that exists: a relay run needs somewhere to write. */}
      {chatId && <RelayPanel chatId={chatId} relay={relay} onChanged={() => setRelayReloads((n) => n + 1)} />}

      {loadError && <div className="error-box">{loadError}</div>}

      <div className="chat-events">
        {events.length === 0 && !streaming ? (
          <div className="empty-box">Send a message to start a turn.</div>
        ) : (
          events.map((ev, i) => <EventBlock key={`${chatId ?? "new"}-${i}`} event={ev} />)
        )}
        <div ref={eventsEndRef} />
      </div>

      <ApprovalDialog
        approvals={approvals}
        nowMs={nowMs}
        currentChatId={chatId}
        busy={deciding}
        error={decideError}
        onDecide={handleDecide}
      />

      <AgentPanel
        state={agentPanel}
        nowMs={nowMs}
        expanded={panelExpanded}
        onToggle={() => setPanelExpanded((prev) => !prev)}
      />

      {streamError && <div className="error-box">{streamError}</div>}
      {lastTurn?.errorMessage && <div className="error-box">{lastTurn.errorMessage}</div>}
      {rateLimitHint && <div className="chat-rate-limit-hint">{rateLimitHint}</div>}
      {turnLine && <div className="chat-turn-line">{turnLine}</div>}

      <div className="chat-composer">
        <textarea
          className="chat-composer-input"
          placeholder="Message Claude Code… (Enter to send, Shift+Enter for a new line)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={streaming}
          rows={3}
        />
        <div className="chat-composer-actions">
          {/* Per-turn approval stance — 'auto' is the CLI's yolo, and gets a
              warning tint so nobody is surprised what they picked. */}
          <select
            className={`chat-approval-select${approvalMode === "auto" ? " chat-approval-select-auto" : ""}`}
            value={approvalMode}
            onChange={(e) => pickApprovalMode(e.target.value as ApprovalMode)}
            disabled={streaming}
            aria-label="Approvals"
          >
            <option value="ask">Ask first</option>
            <option value="edits">Edits free</option>
            <option value="auto">Full auto</option>
          </select>
          {/* A NEW chat picks its engine here; once the chat exists the choice
              is settled and only shows as a badge (default shows nothing). */}
          {!chatId && engines.length > 1 && (
            <select
              className="chat-engine-select"
              value={engine}
              onChange={(e) => setEngine(e.target.value)}
              disabled={streaming}
              aria-label="Engine"
            >
              {engines.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.displayName}
                </option>
              ))}
            </select>
          )}
          {chatId && <EngineBadge engine={engine} engines={engines} />}
          {streaming ? (
            <button type="button" className="btn btn-danger" onClick={handleStop}>
              Stop
            </button>
          ) : (
            <button type="button" className="btn" onClick={handleSend} disabled={!canSend}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
