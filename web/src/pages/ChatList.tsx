// Chat list (#/chats, optionally ?triggerId=&includeSilent=1). Exists mainly
// so the trigger page's "Runs" link has somewhere to go: the runs of one
// trigger are just its chats (see server.mjs::handleChatList's triggerId
// filter).
import { useEffect, useState } from "react";
import { fetchChatList, type ChatSummary } from "../lib/api";
import { navigateToChat } from "../App";

function fmtWhen(ts: string | null): string {
  if (!ts) return "–";
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return "–";
  return new Date(ms).toLocaleString("en-US");
}

export default function ChatList({ triggerId, includeSilent }: { triggerId?: string; includeSilent?: boolean }) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setChats(null);
    setError(null);
    fetchChatList({ triggerId, includeSilent })
      .then(setChats)
      .catch((e) => setError((e as Error).message));
  }, [triggerId, includeSilent]);

  return (
    <div className="page">
      <header className="page-header">
        <h1>{triggerId ? `Runs of ${triggerId}` : "Chats"}</h1>
        <p className="page-subtitle">
          {triggerId
            ? "Every turn this trigger started, including the quiet ones."
            : "Every chat on this machine. Silent heartbeat runs are hidden."}
        </p>
      </header>

      {error && <div className="error-box">{error}</div>}

      {chats === null ? (
        <div className="empty-box">Loading…</div>
      ) : chats.length === 0 ? (
        <div className="empty-box">{triggerId ? "This trigger has not run yet." : "No chats yet."}</div>
      ) : (
        <div className="session-list">
          {chats.map((chat) => (
            <a
              key={chat.id}
              className="session-row"
              href={`#/chat/${encodeURIComponent(chat.id)}`}
              onClick={(e) => {
                e.preventDefault();
                navigateToChat(chat.id);
              }}
            >
              <div className="session-row-top">
                <span className="session-row-title">{chat.title ?? "(untitled chat)"}</span>
                <span className="session-row-badges">
                  {chat.origin === "trigger" && <span className="badge">trigger</span>}
                  {chat.silent && <span className="badge badge-muted">silent</span>}
                </span>
              </div>
              <div className="session-row-meta">
                <span>{fmtWhen(chat.updatedAt)}</span>
                <span>{chat.eventCount} events</span>
                {chat.triggerId && <span>{chat.triggerId}</span>}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
