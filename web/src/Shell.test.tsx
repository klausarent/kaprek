// Render-Tests für die globale Shell (App.tsx: AppShell + Rail).
//
// Gleiche Technik wie alle Seiten-Tests hier: kein DOM, keine Web-Test-
// Abhängigkeiten — Rail und AppShell sind absichtlich hook-frei und werden
// mit src/test/tree.tsx direkt begangen. App selbst (Hook-Fassade mit
// useHashRoute/useAppStatus) ist hier NICHT gerendert; die Tests prüfen die
// Struktur, die die Shell garantiert: Rail auf jeder Route, dunkles
// Shell-Root, Feed-Spalte nur auf Start, niemals eine zweite Rail.
import { test, expect } from "vitest";
import { AppShell, NAV_ITEMS, MORE_ITEMS, type Route } from "./App";
import { StartContent } from "./pages/Start";
import type { LeitstandResponse } from "./lib/api";
import { findAll, findByType, render, textOf } from "./test/tree";

const NOW = 1_700_000_000_000;

const EMPTY_LEITSTAND: LeitstandResponse = {
  since: NOW,
  running: [],
  pending: [],
  overnight: {
    totals: { ran: 0, skippedCondition: 0, skippedConditionError: 0, failed: 0, costUsd: 0, costKnown: 0, costUnknown: 0, tokens: 0, tokensKnown: 0, tokensUnknown: 0 },
    byMission: [],
  },
  attention: { degradedTriggers: [], staleGrants: [], grantsActive: 0 },
  history: [],
  grants: [],
};

function countRails(root: ReturnType<typeof render>): number {
  return findAll(root, (n) => n.type === "nav" && String(n.props.className ?? "").includes("rail")).length;
}

test("die Rail ist auch auf einer Nicht-Start-Seite sichtbar — Navigieren springt nicht mehr ins alte Design", () => {
  const route: Route = { name: "triggers" };
  const tree = render(
    <AppShell route={route} pendingCount={0}>
      <main className="shell-main" />
    </AppShell>,
  );
  expect(countRails(tree)).toBe(1);
  const labels = findByType(findAll(tree, (n) => n.type === "nav")[0], "a").map((a) => textOf(a).trim());
  for (const label of NAV_ITEMS.map((i) => i.label)) expect(labels).toContain(label);
  for (const label of MORE_ITEMS.map((i) => i.label)) expect(labels).toContain(label);
});

test("das Shell-Root trägt die dunkle Shell-Klasse, ohne die Arbeitsfläche einzuengen", () => {
  const tree = render(
    <AppShell route={{ name: "board" }} pendingCount={0}>
      <main className="shell-main" />
    </AppShell>,
  );
  const shells = findAll(tree, (n) => n.type === "div" && n.props.className === "shell");
  expect(shells).toHaveLength(1);
});

test("der Inbox-Zähler erscheint als Badge an der Rail", () => {
  const tree = render(
    <AppShell route={{ name: "start" }} pendingCount={2}>
      <main className="shell-main" />
    </AppShell>,
  );
  const badges = findAll(tree, (n) => String(n.props.className ?? "").includes("rail-badge"));
  expect(badges).toHaveLength(1);
  expect(textOf(badges[0])).toBe("2");
});

test("auf Start gibt es genau EINE Rail (die der Shell) und den Feed als eigene Spalte — keine doppelte Navigation", () => {
  const tree = render(
    <AppShell route={{ name: "start" }} pendingCount={0}>
      <StartContent data={EMPTY_LEITSTAND} error={null} busyId={null} nowMs={NOW} onDecide={() => {}} onAbort={() => {}} />
    </AppShell>,
  );
  // Genau eine Rail — StartContent hat keine eigene mehr.
  expect(countRails(tree)).toBe(1);
  // Die Feed-Spalte ist ein aside direkt im Shell-Grid, kein Kästchen im Inhalt.
  const feed = findAll(tree, (n) => n.type === "aside" && String(n.props.className ?? "").includes("shell-feed"));
  expect(feed).toHaveLength(1);
  expect(textOf(feed[0])).toContain("Letzte Ereignisse");
  // Die Shell markiert die Dreispaltung (Rail + Arbeitsfläche + Feed).
  const shells = findAll(tree, (n) => n.type === "div" && n.props.className === "shell shell-has-feed");
  expect(shells).toHaveLength(1);
});

test("die Arbeitsfläche ist auf Start dasselbe shell-main wie überall — der Inhalt wechselt, das Gerüst nicht", () => {
  for (const route of [{ name: "start" }, { name: "triggers" }] as Route[]) {
    const tree = render(
      <AppShell route={route} pendingCount={0}>
        {route.name === "start" ? (
          <StartContent data={EMPTY_LEITSTAND} error={null} busyId={null} nowMs={NOW} onDecide={() => {}} onAbort={() => {}} />
        ) : (
          <main className="shell-main" />
        )}
      </AppShell>,
    );
    const mains = findAll(tree, (n) => n.type === "main" && String(n.props.className ?? "").includes("shell-main"));
    expect(mains).toHaveLength(1);
  }
});
