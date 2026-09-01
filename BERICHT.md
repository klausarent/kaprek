# Bericht: Bestandsverbesserung kaprek (Phase 1 + 2)

Stand: 01.09.2026. Umfang: alle elf Arbeitspakete der `DESIGN-SPEC.md` (Revision 2) — P0 bis P8, inklusive der Splits P6a/P6b und P4a/P4b. Grundlagen: `GESAMTPLANUNG.md` (OpenClaw 2.0 + Almanac + eigene Prüfung), `ERWEITERUNGSPLAN.md`, `ALMANAC-PLAN.md`, ein vollständiger Peer-Rundlauf (Codex, Grok, Opus) mit drei Entscheidungen durch Klaus (Grants ohne Ablaufdatum, Digest Zahlen-only als Vorgabe, Grants entstehen nur aus echten Fragen) und einer Spec-Revision nach Opus' Code-Befunden.

Ergebnis: **1.955 Server-Tests und 264 Web-Tests grün** (vor der Runde: 1.800/241), TypeScript sauber, Netz- und Subprozess-Wächter unverändert grün, keine neuen Laufzeit-Abhängigkeiten. Alles auf main, Merge-Commits im `u/<name>`-Stil.

---

## Was kaprek jetzt kann, was vorher nicht ging

**Vorher:** Eine geparkte Frage stand bis zu 24 Stunden in der Inbox, obwohl der Lauf, der sie stellte, längst tot war — und es gab keine Ansicht, was wann womit beantwortet wurde. Wer nachts zum fünften Mal dieselbe Frage bekam, klickte blind oder ließ den Trigger weg. Ein Schedule lief ohne Vorbedingung und verbrannte einen Turn pro Tick, auch wenn nichts vorzufinden war. „Was weiß kaprek über dieses Projekt?" war nicht aus der Mission heraus beantwortbar, und eine Memory-Zeile trug keine Herkunft. Ein Formatwechsel oder ein Downgrade war nur durch Zufall sichtbar; `kaprek update` meldete Erfolg, während noch die alte Version lief. Ein Doctor existierte nicht (README: „planned but not built"). Kaputte Policy-Inhalte luden still zu `posture: 'auto'` mit leeren Hard Denials.

**Nachher:**

- **Standing grants (P6a/P6b).** „Immer für diese Form" minted aus der gerade beantworteten Frage einen widerrufbaren Grant — exact auf einen gesalzenen Hash des *rohen* Inputs (zwei Calls, die sich nur im Secret unterscheiden, sind zwei Formen), optional als shape mit abgeleiteter Form, serverseitiger Beispiele-Vorschau („würde auch erlauben: …") und Bestätigungs-Häkchen vor dem Speichern. Der Grant ist an die beim Bestätigen geltende Autorität gebunden: verschärfte Decke oder Hard Denials machen ihn stale, gelockerte lassen ihn einmal nachfragen, unter `auto` schläft er. Kein Ablaufdatum — Sichtbarkeit statt Lebensdauer: jede Nutzung ist ein Ereignis in `grants.jsonl`, `#/setup` zählt aktive Grants, `doctor` meldet lange ungenutzte.
- **Approval-Lebenslauf (P1).** `cancelled` mit Grund (Lauf abgebrochen/fehlgeschlagen, Trigger gelöscht, Mission archiviert, Shutdown), eigenes `cancelledAt`, ehrliche 409er mit dem Zustand, der den Klick geschlagen hat. Zweiter Tab **History**: Entscheidung, Entscheider-Kanal, Wartezeit, Run-Id.
- **Skip-if-Vorbedingungen (P7).** `file-exists` und `file-newer-than-last-run` — falsche Bedingung: kein Turn, keine Kosten, kein Notify, Run bleibt als `skipped: 'condition'` sichtbar. Kaputte Bedingung: auch kein Lauf, aber laut — Notify, Fehlerzähler, nach fünf in Folge `degraded` am Trigger. `command` wurde bewusst weggelassen (Exec-Oberfläche beim Anlegen, Kindprozess-Problem) und ist im README als Lücke benannt.
- **Morning digest (P8).** Je Mission ein Markdown-Bericht eines Fensters: Läufe, Übersprungen, offene Fragen mit Restlaufzeit, Kosten/Tokens mit `unknown`-Kennzeichnung und Abdeckungszähler, DST-feste Fenster (23/25-h-Tage werden benannt). Zahlen-only, kein Modellaufruf — das „kein Netz außer Update"-Versprechen bleibt intakt.
- **Memory mit Herkunft (P4a/P4b).** Jeder Eintrag trägt Quelle (turn/file/import/manual) als Link auf Thread, Run oder Datei; Importe starten unbestätigt und werden erst durch „Still true" gestempelt. Die Missions-Ansicht hat eine Memory-Karte über die ganze Sichtbarkeitskette mit Zwei-Stufen-Forget und Warnung vor der Reichweite.
- **`kaprek doctor` (P5).** Neun Checks (Transkript-Drift, Hooks, Index- und Policy-Schema, Presets, Ledger, Context-State, Grants, degraded-Trigger), Status je Zeile, `--json`, Exit immer 0 — und `--fix` tut genau zwei Dinge (verwaiste State-Dateien, Index-Neubau), nie mehr.
- **Ehrlicheres Update (P2).** Nach dem Install fragt `kaprek update` die laufende Instanz nach ihrer Version und sagt, wenn der Prozess älter ist als die Platte. Bei lokalen Git-Änderungen kommt der Pull-Hinweis erst nach der Warnung.
- **Härtung gegen Formatdrift und Downgrade (P0/P0.5/P3).** Legacy-Fixtures im Repo, gegen die jede Formatänderung testet; ein Byte-Gleichheits-Wächter beweist, dass das Öffnen nichts kaputt macht. Unbekannte Policy-Inhalte laden zu `posture: 'ask'`, nie zu `auto`. Ein Search-Index oder RMW-JSON einer *neueren* kaprek-Version öffnet read-only statt still degradiert zu werden.

## Entscheidungen, die gefallen sind (und warum)

1. **Grants ohne Ablaufdatum** (Klaus) — ein still abschaltender Grant wäre die stille Verhaltensänderung, die kaprek sonst nirgends zulässt. Schutz ist Sichtbarkeit + Autoritäts-Fingerprint, nicht die Uhr.
2. **Fingerprint schmal, nicht die Gesamtpolicy** (Opus gegen Codex/Grok) — `{posture, hardDenialsHash, missionId, derivationVersion}`. Ein Gesamtpolicy-Hash hätte irrelevante Regel-Edits zu Massen-Rückfragen gemacht, die niemand mehr liest.
3. **Grants nur aus der gerade beantworteten Frage** (alle Peers) — Nonce, einmal konsumierbar; die 7-Tage-Historie minted nichts; Scope nur als serverseitige Schnittmenge, ein Mission-Chat mintet nie breiter als seine Mission.
4. **`inputHash` über den rohen Input** (Opus' Fund K1) — Approval-Records tragen redigiertes Input; ein Match dagegen hätte Key A für Key B freigeben können.
5. **`conditionError` fail-closed und laut** (alle drei Peers gegen Spec R1) — „geschlossen und laut geht gleichzeitig": übersprungen, gemeldet, gezählt. Der Trigger verschwindet nicht stumm.
6. **`command`-Bedingung zurückgestellt** (Grok, von Klaus bestätigt) — zwei Datei-Bedingungen decken den Nutzen; eine argv-Ausführfläche beim Anlegen ist den Rest nicht wert.
7. **P0.5 vorgezogen** — der wichtigste Einzel-Fund der Runde: `loadPolicyFailOpen` fiel bei unbekannten Inhalten still zu `posture: 'auto'` mit leeren Hard Denials. Der Fail-closed-Loader ist die Basis, auf der Grants und Trigger-Verhalten überhaupt stehen.

## Was bewusst nicht gebaut wurde

Digest-Zusammenfassung per Modell (Phase 3, Opt-in), watch-Trigger, Tagesbudgets, aussetzbare Relay-Läufe und Handoff-Knopf (Phase 4), `command`-Bedingung, Global-Grants („immer, überall"), Startzeit-Migrationen im Doctor, Hooks-`--fix`. Jede dieser Lücken ist im README an ihrer Stelle benannt, nicht versteckt.

## Prozessnotizen

Elf Arbeitspakete, mostly parallel in eigenen Git-Worktrees (nachdem die erste Welle im geteilten Tree die Branches verrutscht hatte — inhaltlich folgenlos, aber Worktrees sind ab jetzt Standard für Parallelläufe). Vier Subagenten-Läufe und drei Merge-Konflikt-Sets wurden manuell aufgelöst (Signatur-Vereinigung in `handleApprovalDecision`, doppelte `alreadyError`, Grants-Abschnitt in den Inbox-Tab integriert, `listHistory()` strippt Grant-Intents). Ein vollständiger Peer-Rundlauf vor der Umsetzung hat laut Spec-Revision 2 vier gefährliche Defaults verhindert, bevor eine Zeile davon existierte; der Abstand zwischen „hat die Spec gelesen" und „hat im Code gelesen" war dabei die Qualitätsgrenze unter den Peers.
