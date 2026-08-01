// One collapsed run of agent work — "Worked · 6 steps · Read, Bash" —
// expandable into the real blocks. Simple view shows these folded; the full
// view never renders this component at all.
import { useState } from "react";
import EventBlock from "./EventBlock";
import { describeWork } from "../lib/simple";
import type { DigestEvent } from "../lib/api";

export default function WorkFold({ events, keyPrefix }: { events: DigestEvent[]; keyPrefix: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="work-fold">
      <button type="button" className="work-fold-toggle" onClick={() => setOpen((prev) => !prev)} aria-expanded={open}>
        <span className="work-fold-caret">{open ? "▾" : "▸"}</span>
        {describeWork(events)}
      </button>
      {open && (
        <div className="work-fold-body">
          {events.map((event, i) => (
            <EventBlock key={`${keyPrefix}-${i}`} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}
