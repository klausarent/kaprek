// #/experiments — everything the nav no longer links to directly. Nothing
// here was deleted: the routes and pages still work, this page is just the
// signpost for them until the terminal-parity features (kaprek resume,
// council, hooks) have proven themselves for a week in daily use.
const ITEMS: { href: string; label: string; note: string }[] = [
  { href: "#/chat", label: "Chat", note: "kaprek-eigene Turns mit Engine-Wahl" },
  { href: "#/chats", label: "Chat-Liste", note: "alle kaprek-Chats" },
  { href: "#/home", label: "Home", note: "geführte Missionen (Oma-Eingang)" },
  { href: "#/missions", label: "Missionen", note: "Missionen und ihre Chats" },
  { href: "#/plans", label: "Pläne", note: "Guided Planning, Converge-Gate" },
  { href: "#/council", label: "Council", note: "Rollen, Stufen, Konsultationen" },
  { href: "#/triggers", label: "Trigger", note: "geplante und Clipboard-Turns" },
  { href: "#/apps", label: "Apps", note: "sandboxed MCP-Tools" },
];

export function Experiments() {
  return (
    <main className="page experiments">
      <h1>Experimente</h1>
      <p className="muted">
        Eingefroren am 28.08.2026: diese Seiten bleiben erreichbar, werden aber nicht weiterentwickelt, bis die Terminal-Parität
        (kaprek resume, council, Hooks) eine Woche im Alltag bestanden hat.
      </p>
      <ul>
        {ITEMS.map((it) => (
          <li key={it.href}>
            <a href={it.href}>{it.label}</a> <span className="muted">— {it.note}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
