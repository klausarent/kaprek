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
  type Effort,
  type ChatStreamEvent,
  type DigestEvent,
  type Engine,
  type RelayRun,
  type GuidedResult,
  type PlanMode,
  type QuizAnswer,
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
import { navigateToChats, navigateToMissions } from "../App";
import EventBlock from "../components/EventBlock";
import WorkFold from "../components/WorkFold";
import RepeatHint from "../components/RepeatHint";
import PlanPrompt, { looksLikePlanning } from "../components/PlanPrompt";
import QuizCard from "../components/QuizCard";
import { formatQuizAnswers } from "../lib/quiz";
import CouncilPanel, { AutoConsultation } from "../components/CouncilPanel";
import { consultCouncil, fetchConsultation, fetchConsultations, type Consultation, type ConsultationRecord } from "../lib/api";
import { navigateToPlans } from "../App";
import { toSimpleItems } from "../lib/simple";
import { EFFORT_LEVELS } from "../lib/api";
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
  // Bumped after every finished turn so the repeat nudge re-checks.
  const [turnsDone, setTurnsDone] = useState(0);
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
  // Simple view folds the work between answers into one line. Default ON:
  // the first thing a newcomer sees should read like a conversation, not
  // like a build log. Remembered, like the approval stance.
  const [simpleView, setSimpleView] = useState(() => window.localStorage.getItem("kaprek-full-view") !== "1");
  const toggleSimpleView = () => {
    setSimpleView((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("kaprek-full-view", next ? "0" : "1");
      } catch {
        // storage blocked — the toggle still works for this session
      }
      return next;
    });
  };
  // Reasoning effort, remembered like the stance. "default" means: say
  // nothing and let the CLI use whatever it is configured for.
  const [effort, setEffort] = useState<Effort | "default">(() => {
    const stored = window.localStorage.getItem("kaprek-effort");
    return (EFFORT_LEVELS as string[]).includes(stored ?? "") ? (stored as Effort) : "default";
  });
  const pickEffort = (value: Effort | "default") => {
    setEffort(value);
    try {
      window.localStorage.setItem("kaprek-effort", value);
    } catch {
      // storage blocked — the select still works for this session
    }
  };
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
      .then(({ chat, events: stored, openQuiz }) => {
        setChatId(initialChatId);
        setEvents(stored.map(toDigestEvent));
        setRelay(chat?.relay ?? null);
        setEngine(chat?.engine ?? "claude-code");
        // A question that was on screen before the reload is still on screen
        // after it. The server reads it back out of the transcript, so there
        // is nothing here to keep in step with anything.
        if (openQuiz) setGuided({ mode: "brainstorm", planPath: null, quiz: openQuiz, plan: null, planError: null, protocolBroken: false });
      })
      .catch((e) => setLoadError((e as Error).message));
  }, [initialChatId, relayReloads]);

  // The council's last word on this chat, restored on open. A review that
  // outlives the turn has to outlive the tab too, or the automatic part is
  // only automatic for whoever stays on the page.
  useEffect(() => {
    if (!initialChatId) return;
    let cancelled = false;
    fetchConsultations(initialChatId)
      .then((records) => {
        if (!cancelled && records.length > 0) setAutoConsultation(records[0]);
      })
      .catch(() => {
        // No council configured, or nothing asked yet. Neither is worth an error.
      });
    return () => {
      cancelled = true;
    };
  }, [initialChatId]);

  // A mission created from a preset parks its first prompt for exactly this
  // moment (see Missions.tsx) — take it once, then clear it so a later visit
  // to the same mission starts empty.
  useEffect(() => {
    if (initialChatId) return;
    try {
      // The mission's own parked prompt first; the plans page parks under the
      // plain key (no mission in hand there) — "Start working on this".
      for (const key of [missionId ? `kaprek-first-prompt-${missionId}` : null, "kaprek-first-prompt"]) {
        if (!key) continue;
        const parked = window.sessionStorage.getItem(key);
        if (parked) {
          setDraft(parked);
          window.sessionStorage.removeItem(key);
          break;
        }
      }
    } catch {
      // storage blocked — the person types their own opener
    }
  }, [initialChatId, missionId]);

  // A whole turn parked by the plans page ("Check against the plan"): the
  // click over there was the send, so it starts here without a second one.
  // Read once and cleared before it runs, so a re-render cannot send twice.
  const parkedTurnSent = useRef(false);
  useEffect(() => {
    if (initialChatId || parkedTurnSent.current) return;
    let parked: { mode?: PlanMode; planId?: string; text?: string } | null = null;
    try {
      const raw = window.sessionStorage.getItem("kaprek-first-turn");
      if (raw) {
        window.sessionStorage.removeItem("kaprek-first-turn");
        parked = JSON.parse(raw);
      }
    } catch {
      parked = null;
    }
    if (!parked?.text) return;
    parkedTurnSent.current = true;
    void handleSend({ mode: parked.mode, planId: parked.planId, text: parked.text });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialChatId]);

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

  // What the last guided turn produced: a quiz to answer, a plan that was
  // written, or the honest admission that the agent ignored the mode.
  const [guided, setGuided] = useState<GuidedResult | null>(null);
  // Whether the "this sounds like planning" offer is on screen. Declining it
  // is remembered for the session — an offer that returns after a no is not
  // an offer.
  const [planOffer, setPlanOffer] = useState(false);
  const [planOfferMuted, setPlanOfferMuted] = useState(false);
  // What the other engines said about the last thing worth asking about.
  const [consultation, setConsultation] = useState<Consultation | null>(null);
  const [consulting, setConsulting] = useState(false);
  // A consultation the server started on its own after a plan. It runs beside
  // the chat and takes minutes, so what is held here is its id — the result
  // is polled, and survives a reload because the server keeps it.
  const [autoConsultation, setAutoConsultation] = useState<ConsultationRecord | null>(null);

  // Polls a running consultation until it ends. Polling rather than a second
  // stream: it ticks four times a minute for a few minutes, and a socket held
  // open for that is more moving parts than the question is worth.
  useEffect(() => {
    if (autoConsultation?.status !== "running") return;
    const id = autoConsultation.id;
    let stop = false;
    const timer = window.setInterval(() => {
      fetchConsultation(id)
        .then((record) => {
          if (!stop) setAutoConsultation(record);
        })
        .catch(() => {
          // A failed poll is a poll; the next one may well succeed.
        });
    }, 15_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [autoConsultation?.id, autoConsultation?.status]);

  const canSend = draft.trim().length > 0 && !streaming;

  /**
   * Asks every configured peer about the turn that just happened. The
   * question is the user's own last message plus what the agent answered —
   * a peer never gets the conversation, only a stated question.
   */
  const askTheOthers = async () => {
    const lastUser = [...events].reverse().find((event) => event.kind === "user");
    const lastAssistant = [...events].reverse().find((event) => event.kind === "assistant");
    if (!lastUser) return;
    setConsulting(true);
    setConsultation(null);
    try {
      setConsultation(
        await consultCouncil({
          question: `A request was made:

${(lastUser as { text: string }).text}

The proposed answer was:

${(lastAssistant as { text?: string })?.text ?? "(nothing yet)"}

Is this the right approach?`,
          ...(missionId ? { missionId } : {}),
        }),
      );
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : String(err));
    } finally {
      setConsulting(false);
    }
  };

  const handleSend = async ({ mode, planId, text: override }: { mode?: PlanMode; planId?: string; text?: string } = {}) => {
    const text = (override ?? draft).trim();
    if (!text || streaming) return;
    // A new turn supersedes whatever the last one asked or offered.
    setGuided(null);
    setPlanOffer(false);
    if (override === undefined) setDraft("");
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
        effort: effort === "default" ? undefined : effort,
        ...(mode ? { mode } : {}),
        ...(planId ? { planId } : {}),
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
      setTurnsDone((n) => n + 1);
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
      case "council-started":
        // Placed on screen as running before anything is known about it: a
        // review nobody can see starting looks exactly like no review.
        setAutoConsultation({
          id: event.consultationId,
          chatId: event.chatId,
          moment: "plan",
          question: "",
          peers: event.peers,
          planPath: null,
          status: "running",
          startedAt: new Date().toISOString(),
          result: null,
          error: null,
          stale: false,
        });
        break;
      case "turn-complete":
        setLastTurn({ costUsd: event.costUsd, stopReason: event.stopReason, errorMessage: event.error?.message ?? null });
        // A guided turn hands back its quiz, its plan, or the admission that
        // the agent ignored the mode.
        setGuided(event.guided ?? null);
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
          {" · "}
          <button type="button" className="link-button" onClick={toggleSimpleView}>
            {simpleView ? "Show every step" : "Simple view"}
          </button>
          {/* A chat with no mission runs in the sandbox workspace. Say so, and
              say where the door is — the recorded first run showed nobody
              finds missions on their own. */}
          {!missionId && (
            <>
              {" · "}
              <span className="chat-scope-hint">
                Runs in the kaprek workspace.{" "}
                <button type="button" className="link-button" onClick={() => navigateToMissions()}>
                  Work in a project directory
                </button>
              </span>
            </>
          )}
        </p>
      </header>

      {/* Only on a chat that exists: a relay run needs somewhere to write. */}
      {chatId && <RelayPanel chatId={chatId} relay={relay} onChanged={() => setRelayReloads((n) => n + 1)} />}

      {loadError && <div className="error-box">{loadError}</div>}

      <div className="chat-events">
        {events.length === 0 && !streaming ? (
          <div className="empty-box">Send a message to start a turn.</div>
        ) : simpleView ? (
          toSimpleItems(events).map((item) =>
            item.kind === "event" ? (
              <EventBlock key={`${chatId ?? "new"}-${item.index}`} event={item.event} />
            ) : (
              <WorkFold
                key={`${chatId ?? "new"}-work-${item.startIndex}`}
                events={item.events}
                keyPrefix={`${chatId ?? "new"}-work-${item.startIndex}`}
              />
            ),
          )
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

      <RepeatHint reloadKey={turnsDone} />

      {streamError && <div className="error-box">{streamError}</div>}
      {lastTurn?.errorMessage && <div className="error-box">{lastTurn.errorMessage}</div>}
      {rateLimitHint && <div className="chat-rate-limit-hint">{rateLimitHint}</div>}
      {turnLine && <div className="chat-turn-line">{turnLine}</div>}

      {guided?.quiz && !guided.quiz.done && (
        <QuizCard
          quiz={guided.quiz}
          busy={streaming}
          onSubmit={(answers: Record<string, QuizAnswer>) => void handleSend({ mode: guided.mode, text: formatQuizAnswers(guided.quiz!, answers) })}
          onSkip={() => setGuided(null)}
        />
      )}

      {guided?.plan && (
        <div className="plan-written">
          <span>
            Plan written: <strong>{guided.plan.title}</strong>
          </span>
          <code className="plan-path">{guided.plan.path}</code>
          <span className="plan-written-actions">
            <button type="button" className="btn btn-small" onClick={() => navigateToPlans()}>
              Open it
            </button>
            <button type="button" className="link-button" onClick={() => void navigator.clipboard?.writeText(guided.plan!.path)}>
              Copy path
            </button>
          </span>
        </div>
      )}

      {guided?.findings && (
        <div className="plan-written">
          {guided.findings.converged ? (
            <span>
              Converged: the work matches the plan{guided.plan ? <> — <strong>{guided.plan.title}</strong> is done</> : null}.
            </span>
          ) : (
            <span>
              {guided.findings.findings.length} gap(s) between the plan and the work
              {guided.plan ? <> — appended to <strong>{guided.plan.title}</strong> as new steps</> : null}.
            </span>
          )}
          {guided.findings.findings.length > 0 && (
            <ul className="plan-steps">
              {guided.findings.findings.map((finding) => (
                <li key={finding.id}>
                  <strong>
                    {finding.id} ({finding.severity}, {finding.gapType}
                    {finding.sourceRef ? `, ${finding.sourceRef}` : ""}):
                  </strong>{" "}
                  {finding.remainingWork}
                  {finding.evidence ? <> — {finding.evidence}</> : null}
                </li>
              ))}
            </ul>
          )}
          {guided.plan && (
            <span className="plan-written-actions">
              <button type="button" className="btn btn-small" onClick={() => navigateToPlans()}>
                Open the plan
              </button>
            </span>
          )}
          {guided.planError && <div className="error-box">{guided.planError}</div>}
        </div>
      )}

      {guided?.protocolBroken && (
        <div className="chat-turn-line">
          {guided.mode === "converge"
            ? "That turn ran as a convergence check, but the agent answered in prose instead of reporting findings — nothing was recorded, and the plan's status did not move."
            : `That turn ran in ${guided.mode} mode, but the agent answered in prose instead of using the quiz — the answer above is all there is.`}
        </div>
      )}

      {/* Asked for by the button. */}
      {(consultation || consulting) && <CouncilPanel consultation={consultation} busy={consulting} />}
      {/* Asked for by nobody: the council fired on its own after a plan. */}
      <AutoConsultation record={autoConsultation} />

      {planOffer && !streaming && (
        <PlanPrompt
          onPick={(mode) => {
            setPlanOffer(false);
            void handleSend({ mode });
          }}
          onDismiss={() => {
            setPlanOffer(false);
            setPlanOfferMuted(true);
          }}
        />
      )}

      <div className="chat-composer">
        <textarea
          className="chat-composer-input"
          placeholder="Message Claude Code… (Enter to send, Shift+Enter for a new line)"
          value={draft}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            // Offered while typing, not after sending: proposing a different
            // way to work once the work has started is an interruption.
            setPlanOffer(!planOfferMuted && !streaming && looksLikePlanning(next));
          }}
          onKeyDown={handleKeyDown}
          disabled={streaming}
          rows={3}
        />
        <div className="chat-composer-actions">
          {/* Per-turn approval stance — 'auto' is the CLI's yolo, and gets a
              warning tint so nobody is surprised what they picked. */}
          <select
            className="chat-effort-select"
            value={effort}
            onChange={(e) => pickEffort(e.target.value as Effort | "default")}
            disabled={streaming}
            aria-label="Effort"
          >
            <option value="default">Effort: default</option>
            {EFFORT_LEVELS.map((level) => (
              <option key={level} value={level}>
                Effort: {level}
              </option>
            ))}
          </select>
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
            <>
              <button type="button" className="link-button" onClick={() => void askTheOthers()} disabled={consulting || events.length === 0}>
                Second opinion
              </button>
              <button type="button" className="btn" onClick={() => void handleSend()} disabled={!canSend}>
                Send
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
