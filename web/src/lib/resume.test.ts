import { describe, it, expect } from "vitest";
import { resumeErrorText, resumableSessions, type ResumeSession } from "./resume";

describe("resumeErrorText", () => {
  it("prefixes an Error's message with 'Fehler: '", () => {
    expect(resumeErrorText(new Error("server unreachable"))).toBe("Fehler: server unreachable");
  });

  it("stringifies a non-Error throw the same way", () => {
    expect(resumeErrorText("boom")).toBe("Fehler: boom");
  });
});

describe("resumableSessions", () => {
  const now = Date.parse("2026-08-28T08:00:00.000Z");
  const s = (over: Partial<ResumeSession>): ResumeSession => ({
    key: "claude:a",
    engine: "claude",
    id: "a",
    cwd: "C:\\p",
    title: "Aufgabe",
    firstTs: "2026-08-28T07:00:00.000Z",
    lastTs: "2026-08-28T07:00:00.000Z",
    userMsgs: 1,
    hidden: false,
    crash: false,
    ledger: null,
    ...over,
  });

  it("keeps a claude session with no ledger info (--unfiltered's whole point) and one the ledger marked open", () => {
    const list = [s({}), s({ key: "claude:b", id: "b", ledger: { open: true, lastType: "stop", endReason: null } })];
    expect(resumableSessions(list, 24, now).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("drops a claude session the ledger already marked ended, even inside the window", () => {
    const list = [s({ ledger: { open: false, lastType: "end", endReason: "clear" } })];
    expect(resumableSessions(list, 24, now)).toEqual([]);
  });

  it("still applies the time window underneath the ledger filter", () => {
    const old = s({ lastTs: "2026-08-20T07:00:00.000Z", ledger: { open: true, lastType: "stop", endReason: null } });
    expect(resumableSessions([old], 24, now)).toEqual([]);
  });
});
