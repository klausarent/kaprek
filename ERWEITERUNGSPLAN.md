# Erweiterungsplan kaprek

Stand: 31.08.2026. Grundlage: Vergleich von kaprek mit OpenClaw 2.0 (v2026.8.1, <https://docs.openclaw.ai/releases/2026.8.1>). Der Vergleich hat zehn Punkte geliefert, die kaprek übernehmen sollte, plus vier Stellen, an denen kaprek heute schon weiter ist.

Das Dokument ist Arbeitsgrundlage, keine Spezifikation. Pro Punkt steht: Ziel, Anknüpfung an vorhandenen Code, Umsetzungsskizze, Aufwand, Risiko. Implementiert ist nichts davon.

**Aufwandsklassen** (Umfang, keine Kalenderzeit):

- **S** — eine Datei plus Tests, kein neues Datenformat.
- **M** — zwei bis vier Dateien, meist Backend plus eine Web-Seite, Schema-Erweiterung abwärtskompatibel.
- **L** — neues Modul oder Zustandsmodell, Migration bestehender Daten, mehrere Live-Abnahmen.

**Reihenfolge-Empfehlung:** 2 → 3 → 1 → 4 → 8 → 7 → 5 → 6 → 9 → 10. Punkt 2 und 3 räumen auf, was heute schon halb da ist; Punkt 10 setzt 5 und 8 voraus.

---

## Quick Wins

### 1. Scoped Standing Grants

**Ziel.** Wer nachts zum fünften Mal dieselbe Frage bekommt, klickt irgendwann blind. Ein Grant beendet die Wiederholung für genau eine Form von Anfrage — nicht für ein Werkzeug, nicht für eine Mission pauschal — und ist jederzeit widerrufbar.

**Anknüpfung.** `src/server/approval-store.mjs` vergleicht heute schon exakt: `canonicalInput(input)` (rekursiv key-sortiertes JSON) und `questionFingerprint(entry)` = `triggerId \0 toolName \0 canonicalInput`. Der Fingerprint dient bisher nur der Dedupe — eine zweimal gestellte Frage landet auf demselben Record und erhöht `askedCount`. Eine einmal getroffene Entscheidung wird nirgends gemerkt. `src/triggers/runner.mjs` (~L1527–1538) hat eine One-Shot-Vorfreigabe für den Folge-Turn; `_truncated`-Inputs matchen dort bewusst nie. In `src/policy/policy.json` gibt es `hardDenials`, aber keine Allow-Seite; `src/harness/settings.mjs::mergeAskList` schreibt selbstgelernte Werkzeugnamen ausschließlich nach `permissions.ask`, nie nach `permissions.allow`.

**Skizze.**

- Neuer Store `src/policy/grants.mjs`, Persistenz `<dataDir>/grants.jsonl` (append-only, Projektion beim Öffnen — gleiche Bauart wie `src/memory/store.mjs`, damit Widerruf ein Ereignis ist und keine Löschung).
- Grant-Record: `{id, scope, toolName, match, createdAt, createdFromApprovalId, expiresAt, useCount, lastUsedAt, revokedAt, revokedReason}`.
- `scope` ist `mission:<id>`, `project:<label>` oder `global`. Sichtbarkeit läuft **nicht** aufwärts wie beim Memory: ein Mission-Grant gilt nur in dieser Mission. Ein globaler Grant wird beim Anlegen ausdrücklich als solcher bestätigt.
- `match` in zwei Stufen: `exact` (kanonisches Input byte-gleich, das ist der heutige Vergleich) und `shape` (gleicher Werkzeugname, gleiche Schlüsselmenge, Werte gegen ein beim Anlegen aus der konkreten Anfrage abgeleitetes Muster — zum Beispiel Pfad-Präfix unter dem Mission-cwd, Kommando-Kopf bis zum ersten Argument). `shape` wird beim Anlegen als gerenderter Satz gezeigt („immer erlauben: `Write` unter `<mission-cwd>/src/**`"), sonst weiß niemand, was er zusagt.
- Prüfreihenfolge im Approval-Pfad von `src/server/server.mjs`: Hard Denial → Posture-Decke → Grant → Frage. Ein Grant hebt weder ein Hard Denial noch die Posture-Decke auf; unter Posture `auto` ist er wirkungslos, weil dort ohnehin nicht gefragt wird.
- `_truncated`-Inputs und Inputs über der 1-MB-Kappung erzeugen nie einen Grant.
- Jede Grant-Nutzung wird im Approval-Log als `status: 'granted'` mit `grantId` sichtbar, sonst verschwindet die Freigabe aus der Historie und Punkt 2 wird wertlos.
- Web: `web/src/components/ApprovalDialog.tsx` bekommt neben Allow/Deny den Knopf „immer für diese Form", `web/src/pages/Approvals.tsx` einen Abschnitt „Stehende Freigaben" mit Widerruf, Trefferzähler und Datum der letzten Nutzung. Routen `GET /api/grants`, `POST /api/grants`, `DELETE /api/grants/<id>`.

**Aufwand.** M.

**Risiko.** Der `shape`-Matcher ist die gefährliche Hälfte. Ein zu weites Muster ist eine dauerhaft offene Tür, die niemand mehr sieht. Deshalb: Ablaufdatum ist Pflichtfeld mit Vorgabe (30 Tage), Grants ohne Nutzung laufen leise aus, und die Setup-Seite (`#/setup`) zeigt die Zahl aktiver Grants.

### 2. Kanonischer Approval-Lebenszyklus

**Ziel.** Eine geparkte Frage, deren Lauf längst abgebrochen ist, steht heute bis zu 24 Stunden in der Inbox und wartet auf eine Antwort, die niemandem mehr nützt. Und es gibt keine Ansicht dafür, was wann womit beantwortet wurde.

**Anknüpfung.** `approval-store.mjs` kennt `status ∈ {pending, decided, lapsed, expired}`; `sweepLapsed()` läuft faul am Kopf jeder Operation. Fertige Einträge bleiben `APPROVAL_HISTORY_RETENTION_MS = 7d` liegen, Cap `MAX_STORED_APPROVALS = 500`. Die Historie liegt also bereits auf Platte — es fehlt nur die Ansicht. Beim Neustart werden `interactive`-Pendenzen als `expired: 'process gone'` markiert; für `deferred` gibt es diese Behandlung nicht, weil sie den Neustart überleben sollen. Der Record trägt `chatId`, `requestId`, `triggerId`, `pid`, aber keine `runId`.

**Skizze.**

- Feld `runId` beim `put()` mitschreiben (Quelle: `src/orchestrator/runs.mjs`), sonst ist die Zuordnung Frage → Lauf nur über `chatId` und Zeit zu raten.
- Neuer Status `cancelled` mit `cancelledReason ∈ {run-aborted, run-failed, trigger-deleted, mission-archived, shutdown}`. Übergang nur aus `pending`.
- Aufrufer: Abbruchpfad in `src/orchestrator/run.mjs`, `POST /api/relay/<id>/stop`, Trigger-Löschung in `src/triggers/registry.mjs`, Mission-Archivierung in `src/missions/store.mjs`, Shutdown-Handler in `server.mjs`.
- `GET /api/approvals?status=all&limit=&since=` erweitern (heute liefert die Route nur Pendenzen). Antwort trägt Entscheidung, Entscheider-Kanal (Web, Handy-Token, Auto-Deny nach Frist), Dauer bis zur Antwort und — nach Punkt 1 — den auslösenden Grant.
- Web: zweiter Tab in `web/src/pages/Approvals.tsx` mit Filter nach Mission und Trigger.

**Aufwand.** S bis M. Der Store ändert sich wenig, die Aufrufer sind verstreut.

**Risiko.** Gering. Einzige Falle: `cancelled` darf keine bereits getroffene Entscheidung überschreiben, sonst geht ein Ja verloren, auf das ein Lauf sich schon berufen hat.

### 3. Memory-Ansicht pro Mission mit Delete

**Ziel.** „Was weiß kaprek über dieses Projekt?" muss aus der Mission heraus in einem Klick beantwortbar sein, inklusive Vergessen-Knopf.

**Anknüpfung.** Die Bausteine sind da: `src/memory/scopes.mjs` (`person`/`project`/`mission`/`agent`, Sichtbarkeit nur aufwärts, fail-closed), `src/memory/store.mjs` (append-only `<dataDir>/memory/events.jsonl`, `forget()` als Ereignis), `web/src/pages/Memory.tsx` mit Scope-Picker, „Forget" und „Still true", Routen `/api/memory*` samt `DELETE /api/memory/<id>`. `memoryScopeForChat()` in `server.mjs` leitet den Schreib-Scope eines Mission-Chats ab. Was fehlt: der Einstieg von der Mission aus und die gebündelte Sicht über die Kette `mission:<id>` → `project:<label>` → `person:<label>`.

**Skizze.**

- Route `GET /api/missions/<id>/memory`: sammelt über `visibleScopes()` alle von dieser Mission aus lesbaren Einträge und gibt je Eintrag die Herkunft mit (`scope`, `firstSeenAt`, `lastVerifiedAt`, `stale` nach der bestehenden 90-Tage-Regel).
- Mission-Ansicht bekommt eine Memory-Karte: die fünf zuletzt geschriebenen Einträge, Zähler je Scope, Link auf `#/memory` mit vorbelegtem Filter.
- Vergessen läuft über die bestehende Route. Wichtig für die Anzeige: ein Eintrag aus dem Projekt-Scope wirkt auch für andere Missionen — die Karte muss das sagen, bevor jemand ihn wegklickt.
- Sortierung nach `lastVerifiedAt`, veraltete Einträge oben. Das ist die eigentliche Frage hinter „was weiß kaprek": was davon stimmt noch.

**Aufwand.** S bis M. Kein neues Datenmodell.

**Risiko.** Gering.

### 4. Trigger mit skip-if-Vorbedingung

**Ziel.** Ein Schedule, der jeden Morgen um sieben feuert und in neun von zehn Fällen nichts vorfindet, kostet neun Blind-Turns. Die Bedingung soll billig vorab geprüft werden, der übersprungene Lauf sichtbar bleiben.

**Anknüpfung.** `src/triggers/registry.mjs` definiert das Schema (`TRIGGER_TYPES`, `config`, `promptTemplate`, `escalation`, `limits`). `src/triggers/runner.mjs` baut den Prompt und startet den Turn; jeder Lauf landet als Zeile in `<dataDir>/runs.jsonl` (`appendRun()` aus `src/orchestrator/runs.mjs`) mit `origin: 'trigger'`. Claim-Dateien sichern Idempotenz über Prozesse hinweg. `src/server/notify.mjs` liefert das Muster für „genau ein Kommando, nie über eine Shell, Timeout, fail-closed".

**Skizze.**

- Optionales Feld `condition` am Trigger, drei Arten:
  - `file-exists: {path}` — realpath-Containment gegen die erlaubten Wurzeln wie in `src/lib/contain.mjs`.
  - `file-newer-than-last-run: {path}` — Vergleich gegen die `startedAt` des letzten Runs desselben Triggers aus `runs.jsonl`, nicht gegen einen eigenen Zustand.
  - `command: {argv[], timeoutMs}` — Exit-Code 0 heißt wahr. Kein Shell-String, kein `shell: true`, Ausgabe wird verworfen (nur der Code zählt), harte Obergrenze für das Timeout (Vorschlag 5 s).
- Der Runner prüft nach dem Claim und vor `buildPrompt()`. Bei falscher Bedingung: `appendRun({..., skipped: 'condition', conditionKind, durationMs})`, kein Turn, keine Kosten, kein Notify.
- Der Claim wird trotzdem gesetzt, sonst prüft die nächste Tick-Runde dieselbe Bedingung im selben Slot erneut.
- Fehler in der Prüfung (Timeout, Pfad nicht erreichbar) ist **nicht** „falsch": der Lauf findet statt, und der Run trägt `conditionError`. Eine kaputte Bedingung darf einen Trigger nicht stillschweigend stilllegen.
- Web: `web/src/lib/triggerForm.ts` und `web/src/pages/Triggers.tsx` — Bedingung im Formular, „übersprungen (Bedingung)" in der Verlaufsliste.

**Aufwand.** M.

**Risiko.** Das `command`-Feld ist eine Ausführungsfläche. Es gilt derselbe Rahmen wie bei `notify.json`: der Nutzer trägt es ein, kaprek führt genau das aus, ohne Shell-Interpretation. Der statische Netz- und Subprozess-Wächter braucht einen Eintrag mit gepinntem Zweittest.

---

## Mittel

### 5. Relay-Fragen auf die 24h-Inbox umstellen

**Ziel.** Die im README benannte Lücke schließen: ein Relay-Gate lebt heute nur so lange wie der Relay-Turn, eine Trigger-Frage dagegen 24 Stunden. Wer nachts nicht antwortet, verliert den Relay-Lauf, nicht nur die Frage.

**Anknüpfung.** Es sind zwei verschiedene Fragen, und beide sterben mit dem Lauf:

- Das **Kanten-Gate** (`requiresHuman`) liegt schon im Inbox-Store, `mode: 'deferred'`, `kind: RELAY_GATE_KIND` (`src/relay/dispatcher.mjs` ~L425–438), mit `participantsHash` und `budgetSnapshotHash` am Record. Der Record hätte also die 24 h — nur wartet der Lauf mit der Wanduhr (`RELAY_RUN_WALL_MS`, 60 min). Eine Antwort nach Ablauf trifft niemanden mehr.
- Die **Werkzeug-Freigabe innerhalb eines Relay-Schritts** ist `mode: 'interactive'` (`server.mjs`, Kommentar dort: „the question lives as long as the relay turn does"). Das ist bewusst so, weil der CLI-Prozess des Schritts blockiert wartet — ein deferred Replay lief in der M2-Abnahme dreimal auf der falschen Engine.

Dazu: `RELAY_ROUNDS_PER_GATE = 2`, `RELAY_MAX_TURNS = 12`; ein Kanten-Voucher kauft genau eine Passage, und `dispatcher.mjs` ~L731 verwirft ihn schon heute, wenn `participantsHash` oder `budgetSnapshotHash` nicht mehr passen.

**Skizze.**

- Aus „ein wartender Lauf" wird „ein aussetzbarer Lauf". Der Lauf schreibt beim Gate seinen Fortsetzungspunkt auf Platte: `runId`, aktuelle Kante, Schritt-Index, verbrauchtes Budget, `participantsHash`, `budgetSnapshotHash`, `policyVersion`, Rezept-Hash.
- Der Gate-Record bekommt die Inbox-Lifetime (24 h) statt der Turn-Lifetime; `RELAY_RUN_WALL_MS` zählt nur noch aktive Zeit, nicht Wartezeit.
- Beim Beantworten wird der Lauf fortgesetzt, vorher aber neu geprüft: Rezept unverändert? Policy-Version unverändert? Teilnehmer noch dieselben? Budget noch da? Bei Abweichung wird nicht fortgesetzt, sondern gefragt — das ist derselbe Mechanismus wie in Punkt 10, deshalb gehören die beiden zusammen.
- Läuft die 24 h ab, endet der Lauf als `lapsed` mit erhaltenem Fortsetzungspunkt, damit der Verlauf lesbar bleibt.
- Die interaktive Werkzeug-Freigabe im Schritt bleibt, wie sie ist. Sie an die Inbox zu hängen hieße, den blockierten CLI-Prozess sterben zu lassen und den Schritt später neu zu fahren — genau der Replay-Fehler aus M2. Aussetzbar wird die Kante, nicht der laufende Schritt.

**Aufwand.** L. Das ist der einzige Punkt der Liste, der ein Zustandsmodell ändert.

**Risiko.** Ein fortgesetzter Lauf, der gegen eine veraltete Autorität weiterläuft, ist schlimmer als ein verlorener Lauf. Die Prüfung beim Fortsetzen ist Pflicht, nicht Zugabe.

### 6. Lokaler Secret-Store mit richtunggebundener Substitution

**Ziel.** Ein Zugangsdatum soll benutzbar sein, ohne im Chat, im Transkript, in `runs.jsonl` oder in einem Council-Paket zu landen. Redaktion wird damit vom ersten Schutzwall zum Auffangnetz.

**Anknüpfung.** Redaktion sitzt in `src/parser/parse.mjs` (`SECRET_PATTERNS`, `redactSecrets()`, `registerSecret()` für Laufzeitwerte, immer vor `truncate()`). Verbraucher: `src/orchestrator/run.mjs`, `src/triggers/runner.mjs`, `src/council/*`, `src/scan/scan.mjs`, `src/memory/import.mjs`. Der Onboarding-Scanner (`src/scan/environment.mjs`) liest schon heute konsequent nur Namen: `envKeyNames()` gibt Schlüsselnamen zurück, nie Werte. `src/missions/workflow.mjs` lehnt beim Export ab, statt still zu redigieren. Der Egress-Punkt ist eindeutig: `src/harness/claude-code.mjs` — dort startet `spawnFn()` den CLI-Prozess und dort geht der Prompt über `child.stdin.write()` aus kaprek heraus.

**Skizze.**

- Neues Modul `src/secrets/store.mjs`, Persistenz `<dataDir>/secrets.json`, Dateirechte so eng wie die Plattform hergibt.
- Referenz im Prompt: `{{secret:NAME}}`. Der Nutzer tippt den Namen, nie den Wert; die Eingabe des Werts läuft über ein maskiertes Feld und einmalig.
- Substitution ausschließlich am Egress-Punkt in `claude-code.mjs`, unmittelbar vor `stdin.write`, und nur, wenn die Mission den Namen freigegeben hat (Feld `secrets: []` an der Mission, sonst greift kein Platzhalter).
- Richtungsgebunden heißt: der Wert geht nur nach draußen. Auf dem Rückweg wird jeder Wert beim Anlegen per `registerSecret()` eingetragen und damit von der bestehenden Redaktion in allem erfasst, was persistiert wird.
- Sperrflächen ausdrücklich: `council/snapshot.mjs`-Deny-Liste behalten, Workflow-Export lehnt Platzhalter **nicht** ab (der Name darf reisen, der Wert nicht), Memory darf keine Werte aufnehmen.
- Ehrliche Ansage in README und UI: das schützt gegen Transkript, Council-Paket und Export — nicht gegen einen anderen Prozess desselben Betriebssystem-Kontos. Diese Grenze ist dieselbe wie beim Instance-Token, und sie steht dort schon so im README.

**Aufwand.** L.

**Risiko.** Die Versuchung, Verschlüsselung zu bauen, die ohne separates Passwort keine ist. Lieber unverschlüsselt mit klarer Ansage als eine Krypto-Fassade.

### 7. Morgen-Digest pro Mission

**Ziel.** Eine Seite am Morgen: was nachts lief, was fragt, was es gekostet hat.

**Anknüpfung.** Die Datenquellen liegen alle vor: `runs.jsonl` (`costUsd`, `usage`, `tokens` via `sumTokens()`, `durationMs`, `stopReason`, `origin`, `triggerId`), `approvals.json` (offene deferred Fragen), `chats/<id>/events.jsonl`, `missions/events.jsonl`. Zustellung über `src/server/notify.mjs`.

**Skizze.**

- `src/missions/digest.mjs` baut je Mission ein Markdown-Dokument für ein Zeitfenster: Trigger-Ergebnisse (gelaufen, übersprungen nach Punkt 4, fehlgeschlagen), offene Fragen mit Restlaufzeit, Kosten und Tokens des Fensters, dazu die Liste der berührten Dateien aus dem Tape.
- Die Zusammenfassung in drei Sätzen braucht eine Engine. Regel: höchstens ein Turn je Mission und Tag, kleinstes verfügbares Modell, abschaltbar. Ohne Engine oder bei abgeschaltetem Feld erscheint der Digest trotzdem — dann nur mit Zahlen. Der Digest darf nie teurer sein als das, worüber er berichtet.
- Auslieferung: Karte oben in der Mission-Ansicht, Route `GET /api/missions/<id>/digest?since=`, optional ein Trigger vom Typ `schedule`, der den Digest über `notify.json` rausschickt.
- Der Digest wird als Datei unter `<dataDir>/missions/<id>/digests/<datum>.md` abgelegt, damit man ihn später noch lesen kann, wenn `runs.jsonl` schon rotiert ist.

**Aufwand.** M.

**Risiko.** Ein Digest, der niemanden erreicht, ist eine Datei mehr. Die Zustellung (Punkt 8) entscheidet über den Nutzen.

### 8. Trigger-History als Tri-State und Missed-Run-Recovery

**Ziel.** Unterscheiden können: der Lauf fand statt / die Meldung ging raus / ein Mensch hat sie gesehen. Und: nach einem kaprek-Neustart nicht so tun, als hätte es die Lücke nicht gegeben.

**Anknüpfung.** `runs.jsonl` ist append-only und kennt nur „lief". Zustellung passiert in `src/server/notify.mjs` (ein externes Kommando, 10 s Timeout, fail-closed). Für verpasste Läufe gilt heute: `heartbeat` leitet Fälligkeit aus dem letzten Eintrag in `runs.jsonl` ab und holt darum von selbst auf; `schedule` rechnet gegen echte Wanduhr-Fenster (`dueScheduleSlot`) — ein Fenster, das während der Abwesenheit schließt, ist endgültig verpasst und wird nie nachgeholt. Claim-Dateien (`CLAIM_MAX_AGE_MS = 7d`) verhindern Doppelläufe über Prozesse hinweg.

**Skizze.**

- Zustandswechsel gehören nicht in `runs.jsonl` (append-only, unveränderlich). Stattdessen `<dataDir>/trigger-delivery.jsonl` mit Ereignissen `delivered {runId, channel, exitCode, at}` und `seen {runId, channel, at}`, Projektion beim Lesen. Das hält beide Dateien ehrlich.
- `seen` wird gesetzt, wenn der Run in der Web-Oberfläche sichtbar gerendert wurde oder eine zugehörige Frage beantwortet wurde — nicht schon beim Abruf der Liste, sonst bedeutet es nichts.
- Anzeige in `web/src/pages/Triggers.tsx`: drei Punkte je Lauf, ungesehene Läufe oben. Ein Lauf, der lief, aber nie zugestellt wurde, ist der interessante Fall — der zeigt, dass `notify.json` kaputt ist.
- Missed-Run-Recovery beim Start: Lücke zwischen letztem Run und jetzt gegen die Schedule-Fenster jedes Triggers rechnen. Ergebnis ist eine Liste verpasster Fenster, **nicht** eine Reihe von Nachholläufen. Angeboten wird höchstens ein Lauf je Trigger, markiert mit `catchUp: true` und der Zahl der übersprungenen Fenster im Prompt-Kontext. Automatisch nur, wenn der Trigger es ausdrücklich erlaubt (`catchUp: 'ask' | 'once' | 'never'`, Vorgabe `ask`).
- Tageslimits aus `src/triggers/limits.mjs` gelten für Nachholläufe unverändert.

**Aufwand.** M bis L.

**Risiko.** Ein Nachholsturm nach längerer Abwesenheit. Deshalb die harte Grenze von einem Lauf je Trigger, unabhängig davon, wie viele Fenster geschlossen wurden.

---

## Später

### 9. Live-Plan-Checkliste im Chat

**Ziel.** Während ein Plan abgearbeitet wird, im Chat sehen, wo er steht — als Spiegel der Datei, nicht als zweiter Zustand.

**Anknüpfung.** `src/plans/markdown.mjs` kann alles Nötige: `parseSteps()` (fence-fest), `setStep()` schreibt genau eine Zeile um, `planTitle()`. `src/plans/store.mjs` hält nur Metadaten und einen Datei-Hash für Drift-Erkennung; der Planinhalt bleibt eine Markdown-Datei, die dem Nutzer gehört. Die interaktive Ansicht existiert unter `web/src/pages/Plans.tsx` („X of Y done", `DoneControls`); der Chat zeigt heute nur eine nachträgliche Banderole nach einem Guided-Turn.

**Skizze.**

- Seitenspalte im Chat, sichtbar sobald der Chat einen `planId` trägt. Quelle ist immer die Datei, nie ein Zwischenspeicher.
- Aktualisierung nach jedem Turn-Ende und beim SSE-Ereignis `plan.changed`. Kein Datei-Watcher als erster Schritt — der Hash-Vergleich bei Turn-Ende deckt den Normalfall.
- Weicht der Hash von dem beim letzten Lesen ab, zeigt die Spalte „Datei wurde außerhalb geändert" statt still zu überschreiben. Der Plan gehört dem Nutzer.
- Abhaken aus der Spalte ruft dieselbe Route wie die Plans-Seite. Kein zweiter Schreibpfad.

**Aufwand.** M.

**Risiko.** Gering, solange die Spalte nur spiegelt. Ein eigener Fortschrittszustand neben der Datei wäre der Fehler, den kaprek bisher vermieden hat.

### 10. Erfasste Autorität für Automationen

Gilt nur, falls „Trigger startet Relay" jemals geöffnet wird. Das ist heute im README bewusst zu.

**Ziel.** Wenn die Sperre fällt, fällt sie nicht ersatzlos. Eine Automation trägt die Autorität, die beim Anlegen erfasst wurde, und prüft sie bei jedem Lauf gegen die aktuelle Policy — das Modell, das OpenClaw an dieser Stelle nutzt.

**Anknüpfung.** Die Bausteine liegen verstreut schon vor: `policyVersion()` aus `src/policy/policy.mjs` steckt bereits in jedem Receipt-Fingerprint (`src/receipt/receipt.mjs`); `src/relay/dispatcher.mjs` führt `participantsHash` und `budgetSnapshotHash` am Gate-Record; `effectivePosture()` in `src/policy/guards.mjs` kennt die Regel „Mission darf nur verschärfen".

**Skizze.**

- Beim Anlegen der Automation wird ein Autoritäts-Schnappschuss geschrieben: `policyVersion`, Posture, Hard-Denial-Hash, `appScope`, erlaubte Peers, Budget, Rezept-Hash, dazu wer die Automation angelegt hat.
- Vor jedem Lauf wird der Schnappschuss gegen die aktuelle Lage geprüft. Gleich → Lauf. Aktuelle Policy strenger → Lauf unter der strengeren Regel, mit Vermerk. Schnappschuss weiter als die aktuelle Policy → **Halt** und eine deferred Frage, keine stille Anpassung.
- Ein Widerruf von Punkt 1 muss hier durchschlagen: Grants sind Teil der erfassten Autorität und werden bei jedem Lauf frisch aufgelöst, nie eingefroren.
- Reihenfolge: erst Punkt 5 (fortsetzbare Läufe), dann Punkt 8 (sichtbare Zustellung), dann das hier. Ohne beides ist eine automatisch gestartete Relay-Kette eine Kette, die niemand sieht.

**Aufwand.** L.

**Risiko.** Hoch genug, um am Ende der Liste zu stehen.

---

## Ehrenhalber: hier ist kaprek schon weiter

Nichts davon bauen. Festhalten, damit es bei künftigen Umbauten nicht versehentlich verschwindet.

- **Exakte Freigabe, Byte für Byte.** `canonicalInput()` sortiert Schlüssel rekursiv und vergleicht das Ergebnis; gekappte Inputs (`_truncated`) matchen grundsätzlich nie. Ein Ja gilt für genau die Anfrage, die gestellt wurde, nicht für „so etwas Ähnliches".
- **Strukturierte Fragen mit Freitext-Alternative.** Der Quiz-Block (Fence `kaprek-quiz`) rendert Karten statt einer Fragenwand, und jede Approval-Entscheidung kann eine `decision.message` tragen. Wer keine der angebotenen Antworten will, ist nicht ausgesperrt.
- **Memory-Scoping nur aufwärts, fail-closed.** `visibleScopes()` lässt eine Mission ihr Projekt sehen, nie umgekehrt und nie seitwärts. Ein fremder Personen-Baum sieht nichts. Das ist live nachgewiesen worden, nicht nur behauptet.
- **Ehrlichkeits-Stil.** kaprek sagt, was es nicht kann: dass der Prozess keine Grenze gegen andere Prozesse desselben Betriebssystem-Kontos ist, dass es ohne zweite Engine keine Zweitmeinung gibt, dass ein Plan-Verdikt zu einem geänderten Plan `stale` heißt. Der schwerste Fund der eigenen Peer-Reviews war eine Ausgabe, die über das eigene Bind-Verhalten log — genau diese Klasse Fehler bleibt teuer.
