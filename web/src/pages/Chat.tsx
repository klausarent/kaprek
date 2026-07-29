// Chat page (#/chat, #/chat/<id>): a text box that runs a turn against the
// user's own already-authenticated Claude Code CLI (see
// src/harness/claude-code.mjs — no API key ever touches this app) and
// streams the result back live, rendered through the SAME EventBlock.tsx
// the session viewer already uses for finished transcripts.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  cancelChatTurn,
  fetchChat,
  streamChatTurn,
  toDigestEvent,
  type ChatStreamEvent,
  type DigestEvent,
} from "../lib/api";
import EventBlock from "../components/EventBlock";

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

export default function Chat({ chatId: initialChatId }: { chatId?: string }) {
  const [chatId, setChatId] = useState<string | undefined>(initialChatId);
  const [events, setEvents] = useState<DigestEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [lastTurn, setLastTurn] = useState<TurnSummary | null>(null);
  const [rateLimitHint, setRateLimitHint] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // id -> index into `events`, for the tool-start/tool-end event this turn
  // still hasn't seen the matching end for.
  const pendingToolIndex = useRef<Map<string, number>>(new Map());
  const eventsEndRef = useRef<HTMLDivElement | null>(null);

  // Load an existing chat's history when opened via #/chat/<id>. A brand new
  // chat (no id yet) starts with an empty transcript instead.
  useEffect(() => {
    if (!initialChatId) return;
    setLoadError(null);
    fetchChat(initialChatId)
      .then(({ events: stored }) => {
        setChatId(initialChatId);
        setEvents(stored.map(toDigestEvent));
      })
      .catch((e) => setLoadError((e as Error).message));
  }, [initialChatId]);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events]);

  // Abort any in-flight turn if the user navigates away mid-stream.
  useEffect(() => {
    return () => abortRef.current?.abort();
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

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);

    try {
      await streamChatTurn({
        chatId,
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
        setEvents((prev) => [...prev, nowEvent("thinking", event.text)]);
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
      case "error":
        setStreamError(event.message);
        break;
      case "result":
        // Superseded by 'turn-complete' below, which carries the same
        // sessionId/costUsd plus the orchestrator's own stopReason/error.
        break;
      case "turn-complete":
        setLastTurn({ costUsd: event.costUsd, stopReason: event.stopReason, errorMessage: event.error?.message ?? null });
        break;
      default:
        break;
    }
  }

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
        <p className="page-subtitle">Runs against your own Claude Code CLI, in the background — no API key involved.</p>
      </header>

      {loadError && <div className="error-box">{loadError}</div>}

      <div className="chat-events">
        {events.length === 0 && !streaming ? (
          <div className="empty-box">Send a message to start a turn.</div>
        ) : (
          events.map((ev, i) => <EventBlock key={`${chatId ?? "new"}-${i}`} event={ev} />)
        )}
        <div ref={eventsEndRef} />
      </div>

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
