# Briefing: kaprek-GUI-Redesign — Wireframes/Mockups

Für: externe KIs (Design-Entwürfe als HTML-Mockups). Kurz, aber vollständig — lies alles, bevor du entwirfst.

## 1. Was kaprek ist

kaprek ist eine lokale Aufsichtsschicht um die Claude-Code- und Codex-CLIs, die der Nutzer ohnehin installiert hat. Es hält jede Session als durchsuchbaren Thread, läuft Scheduled Triggers durch die CLIs, erzwingt Freigaben vor heiklen Aktionen (Fail-closed, Inbox die Neustarts überlebt) und verwaltet Memory mit Scope-Hierarchie. Kein Account, kein Server, null Laufzeit-Abhängigkeiten, Windows-first, Node 22+. README im Repo (klausarent/kaprek) ist Doku und Positionierung in einem — der Ton dort (kurz, ehrlich, Limits benannt) ist auch der Design-Ton.

## 2. Die Positionsfrage vor jeder Komponente

Das README sagt heute: „Der Browser ist zum Nachschauen da, nicht zum Bedienen." Diese Selbstbeschränkung wird mit der GUI zurückgenommen — **und dann muss die Oberfläche halten, was die Sicherheits-versprechen sagen**: Das Instance-Token darf nicht länger aus `GET /` ausgeliefert werden (Tauri-Hülle übernimmt es später per Init-Script), Fail-closed bleibt Fail-closed, und jede Bedienaktion ist eine echte Aktion mit echtem Effekt, keine Deko. Entwirft keine Ansicht, die etwas verspricht, das der Server nicht kann.

## 3. Der Auftrag

Entwirft den **Leitstand** (Startbild für Wiederkehrer: was läuft gerade, was fragt, was hat die Nacht gekostet) plus die 5-Einträge-Navigation, auf die sich das Redesign geeinigt hat: **Start, Chat, Inbox, Missionen, Sessions**. Alles andere (Triggers, Plans, Council, Memory, Apps, Board, Search, Setup) wandert in ein Untermenü — diese Seiten existieren bereits als Web-UI und werden nicht neu entworfen, aber eure Navigation muss Platz für sie haben.

Gewünscht sind **mindestens zwei deutlich verschiedene Varianten** als eigenständige, self-contained HTML-Dateien (inline CSS/JS, keine Build-Tools, keine externen Assets), klickbar zwischen den Ansichten (hash-Navigation reicht), mit synthetischen Demo-Daten, die als solche erkennbar sind.

## 4. Was die Ansichten zeigen müssen (Daten, die wirklich da sind)

- **Laufende Turns**: Schritt, Engine-Badge (claude/codex), berührte Dateien, Abbruchknopf — Quelle SSE.
- **Inbox**: offene Freigabe-Fragen (Werkzeug, Input-Vorschau, Restlaufzeit gegen 24 h), drei Antworten: Allow, Deny, „immer für diese Form" (Standing Grant, exact/shape). History-Tab: Entscheidung, Entscheider-Kanal (web/phone/auto-deny), Wartezeit.
- **Missionen**: Titel, Ziel, Verzeichnis, verknüpfte Chats, Memory-Karte (Einträge mit Herkunfts-Link, unbestätigte Importe), **Morning-Digest-Karte** (Zahlen-only: Läufe/übersprungen/offene Fragen/Kosten mit `unknown`-Kennzeichnung und Abdeckungszähler).
- **Triggers**: Typ (schedule/heartbeat/clipboard/watch), skip-if-Bedingung, degraded-Zähler nach 5 Fehlern, Tageslimits.
- **Kosten/Tokens**: pro Run und Tag; fehlende Werte sind `unknown`, nie 0.
- **Grants**: Werkzeug, Scope, Trefferzähler, lastUsed, Widerruf.

## 5. Design-Grundsätze (hart)

1. **Jede Zeile handelbar.** Ein Startbild, das nur Zahlen zeigt, ist eine Ansicht mehr. Von jeder Karte aus führt mindestens ein Weg in eine Aktion (Frage beantworten, Lauf abbrechen, Mission öffnen).
2. **Kein zweiter Zustand.** Die GUI aggregiert, was auf Platte liegt (runs.jsonl, approvals, Memory-Events). Kein Fortschritt, den nur die UI kennt; ein Plan-Checkliste spiegelt die Datei, sie besitzt nichts.
3. **Ehrlichkeit als Stil.** `unknown` statt geratener Zahlen, degraded statt grün-tun, „ohne Herkunft" statt ausblenden. Keine Spinner, die Erfolg vortäuschen; leere Zustände sagen, warum sie leer sind.
4. **Fail-closed sichtbar.** Freigaben sind der Kern des Produkts, nicht ein Modal unter vielen. Die Inbox ist eine Hauptansicht, keine Benachrichtigung.
5. **Zwei Bedieneregime nicht vermischen.** Den Terminal-Loop bedient man weiterhin im Terminal; die GUI ist Leitstand und Inbox, kein zweites Chat-Produkt neben dem bestehenden.
6. **Dicht, nicht dekorativ.** Zielgruppe ist ein Operator am Schreibtisch (Windows-first). Keyboard-orientiert erwünscht; keine Dashboard-Kitsch-Widgets (Gauges, Gradients ohne Bedeutung).

## 6. Abgabe

Pro Variante eine HTML-Datei plus 5–10 Sätze Begründung der Anordnung (was ist warum im Blickfeld des Wiederkehrers). Kein Design-System nötig — aber konsistent innerhalb der Variante. Vorlagen zum Vergleich liegen im Repo unter `wireframes/` (Varianten A/B/C); ihr müsst euch nicht daran orientieren, aber nicht schlechter argumentieren als sie.
