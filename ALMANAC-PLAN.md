# Almanac-Plan: übernehmbare Patterns für kaprek und die instinct-bridge

Stand: 31.08.2026. Grundlage: Analyse von Almanac (YC S26, Product-Hunt-Launch 27.08.2026, <https://usealmanac.com>), geliefert über die instinct-bridge (Auftrag `2026-08-31-237`). Schwesterdokument zu `ERWEITERUNGSPLAN.md`, das dasselbe für OpenClaw 2.0 macht.

Arbeitsgrundlage, keine Spezifikation. Implementiert ist nichts davon. Pro Punkt steht: was Almanac macht, Anknüpfung an vorhandenen Code, Umsetzungsskizze, Aufwand, Risiko.

**Aufwandsklassen** (identisch zu `ERWEITERUNGSPLAN.md`, Umfang statt Kalenderzeit):

- **S** — eine Datei plus Tests, kein neues Datenformat.
- **M** — zwei bis vier Dateien, meist Backend plus eine Web-Seite, Schema-Erweiterung abwärtskompatibel.
- **L** — neues Modul oder Zustandsmodell, Migration bestehender Daten, mehrere Live-Abnahmen.

Zwei Abschnitte stehen hier auf Zuruf und nicht wegen Almanac: **1. GUI und Standalone-App** und **3. Eigenes Harness**. Die eigentlichen Almanac-Patterns stehen in Abschnitt 2.

---

## 0. Was Almanac ist, und wo der Vergleich aufhört

Almanac ist ein Always-on-Agent für Firmenkontext, bedient über Slack und iMessage. Er arbeitet auf einem eigenen Cloud-Computer mit eigenem Browser, eigenem Terminal und eigenen Logins, pflegt daraus ein selbst-aktualisierendes Wiki mit Quellenlink pro Zeile und meldet sich, wenn er fertig ist. Preis 30/100/200 $ je Nutzer und Monat mit nutzungsbasierten Kappen auf Modell-Verbrauch und Browser-Minuten. Kein SOC2-Claim, keine API, kein Self-Hosting, Doku hinter Login. Auf Product Hunt steht „Built with OpenAI Codex CLI" — auch Almanac ist eine Schicht um eine fremde CLI, nur mit dem Computer in der Cloud statt unter dem Schreibtisch.

Drei Dinge sind darum nicht übernehmbar, und das ist keine Lücke, sondern die Position:

- **Der Cloud-Computer mit eigenen Logins.** kaprek hat einen statischen Netz-Wächter (`src/no-network.test.mjs`), der den Build brechen lässt, sobald irgendwo im Node-Code ein Netz-Client auftaucht. Ein Agent, der sich in fremde Konten einloggt, ist das Gegenteil davon.
- **Das Wiki als Org-Produkt.** Geteiltes Firmenhirn über Gmail, Calendar, Slack und GitHub setzt einen Mandanten und fremde Zugangsdaten voraus. kaprek hat einen Operator und ein Dateisystem.
- **Das Abo-Modell.** Nutzungsbasierte Kappen sind trotzdem interessant, aber als Schutz vor der eigenen Rechnung, nicht als Preisschild (Punkt 2.5).

Was bleibt, ist die Bedienung: Almanac hat gelöst, wie ein Agent sichtbar, unterbrechbar und nachlesbar wird. Genau das fehlt kaprek.

---

## 1. GUI und Standalone-App

Klaus, 31.08.: „Was kaprek noch fehlt ist die intuitive Benutzeroberfläche." Das ist der schwerste Punkt dieses Dokuments, weil er vor der Technik eine Positionsfrage stellt.

### 1.0 Der Positionswechsel steht vor jeder Komponente

Das README sagt heute zwei Sätze, die zusammen die GUI-Frage entscheiden:

> „The browser at `http://127.0.0.1:4900` is for looking things up, not for operating anything." (README.md:40)

> „The fix is a desktop shell that keeps the token out of HTTP entirely; that is on the backlog and not built." (README.md:604, dazu README.md:639)

Der erste Satz ist eine bewusste Selbstbeschränkung: bedient wird im Terminal, die Oberfläche liest. Der zweite Satz benennt die Sicherheitslücke, die eine Desktop-Hülle schließen würde. Eine intuitive Oberfläche zu wollen heißt, den ersten Satz zurückzunehmen — und dann muss die Oberfläche halten, was der zweite verspricht. Beides gehört in denselben Schritt, sonst entsteht eine Bedienfläche, deren Zugangstoken jeder lokale Prozess aus `GET /` lesen kann.

**Empfehlung:** Positionswechsel ausdrücklich ins README schreiben, sobald die erste bedienende Ansicht live geht. Nicht stillschweigend, sonst wird aus dem Ehrlichkeits-Stil eine Behauptung, die nicht mehr stimmt.

### 1.1 Startbild „was läuft gerade" statt Seitenliste

**Almanac.** Jeder Run ist beobachtbar; der Agent meldet sich, wenn er fertig ist. Man landet nicht in einem Menü, sondern im Vorgang.

**kaprek heute.** `web/src/App.tsx` fährt einen selbstgebauten Hash-Router (kein react-router) über 17 Seiten (`#/chat`, `#/list`, `#/missions`, `#/triggers`, `#/approvals`, `#/plans`, `#/council`, `#/memory`, `#/apps`, `#/board`, `#/search`, `#/setup`, `#/experiments` und weitere). Die Hauptnavigation ist im Code ausdrücklich „cut down to the reading surface"; alles Bedienende hängt unter `#/experiments`. Ein Neuankömmling landet im Chat. Was gerade läuft, was fragt und was heute Nacht passiert ist, steht auf drei verschiedenen Seiten.

`#/home` existiert bereits (`web/src/pages/Home.tsx`, Route `GET /api/home`), ist aber ein Einstiegs-Assistent — vier Angebote, drei Fragen, dann Chat. Das ist eine Antwort auf „ich weiß nicht, was ich hier tun soll", nicht auf „was macht das Ding gerade". Beides ist nötig, aber es sind zwei Bilder.

**Skizze.**

- Ein Leitstand als Landeplatz für Wiederkehrer (eigene Route, `#/home` bleibt der Assistent für den ersten Besuch): laufende Turns (Quelle `src/orchestrator/runs.mjs`), offene Fragen (`GET /api/approvals`), die letzten Trigger-Läufe, Kosten des Tages.
- Kein neuer Zustand. Die Karte aggregiert, was bereits auf Platte liegt; jede Zeile verlinkt in die vorhandene Seite.
- Ein Live-Bereich über SSE für den laufenden Turn: aktueller Schritt, Engine (`EngineBadge.tsx`), berührte Dateien, Abbruchknopf.
- Die Navigation wird auf fünf Einträge gekürzt: Start, Chat, Inbox, Missionen, Sessions. Der Rest wandert in ein Untermenü. `#/experiments` bleibt, was es ist.

**Aufwand.** M. Eine neue Seite, eine Aggregations-Route, Navigationsumbau.

**Risiko.** Gering technisch, mittel inhaltlich: ein Startbild, das nur Zahlen zeigt und keine Handlung anbietet, ist eine Ansicht mehr. Es muss von jeder Zeile aus etwas tun können.

### 1.2 Memory als browsbares Wiki mit Herkunft

**Almanac.** Jede Wiki-Zeile ist quellenverlinkt, der Nutzer liest, korrigiert, und die Korrektur gilt ab dann.

**kaprek heute.** `src/memory/store.mjs` ist append-only, `forget()` ist ein Ereignis, `src/memory/scopes.mjs` regelt Sichtbarkeit nur aufwärts, `web/src/pages/Memory.tsx` kann filtern, vergessen und „Still true" setzen. Was fehlt, ist die Herkunft: woher stammt ein Eintrag, welcher Turn, welche Datei, welcher Chat. Punkt 3 des `ERWEITERUNGSPLAN.md` bringt die Mission-Ansicht, aber keine Quelle.

**Skizze.**

- Beim Schreiben eines Memory-Eintrags die Herkunft mitschreiben: `sourceKind ∈ {turn, file, import, manual}`, `chatId`, `runId`, optional Pfad plus Zeilenbereich. `src/memory/import.mjs` kennt die Quelle bereits, sie wird nur nicht behalten.
- In `Memory.tsx` wird die Herkunft zum Link: auf den Thread, auf die Datei, auf den Run. Ein Eintrag ohne Herkunft wird als solcher markiert, nicht versteckt.
- Sortierung nach `lastVerifiedAt`, veraltete Einträge oben — das ist die Frage hinter „was weiß kaprek eigentlich".
- Editieren bleibt, wie es ist: ein neues Ereignis, keine Überschreibung. Almanacs „Korrekturen gelten ab dann" ist genau das Modell, das kaprek schon hat.

**Aufwand.** M. Schema-Erweiterung abwärtskompatibel, Altbestand bleibt ohne Herkunft.

**Risiko.** Gering. Falle: die Herkunft darf keine Secrets transportieren — der Pfad ja, der Inhalt nie. `registerSecret()`/`redactSecrets()` aus `src/parser/parse.mjs` greifen vor dem Schreiben.

### 1.3 Handoff statt Abbruch

**Almanac.** Bei Login, Zahlung oder heikler Entscheidung pingt der Agent den Nutzer oder übergibt den Live-Browser. Der Lauf stirbt nicht, er wartet mit übergebener Kontrolle.

**kaprek heute.** `ApprovalDialog.tsx` und `QuestionBox.tsx` können Allow, Deny und Freitext (`decision.message`); der Quiz-Block rendert Karten. Was fehlt, ist die dritte Antwort: „ich mach das selbst, warte hier".

**Skizze.**

- Dritter Knopf im Approval-Dialog: **Übernehmen**. Der Lauf bleibt stehen, kaprek öffnet den Mission-cwd (Datei-Explorer oder Terminal) und zeigt die vorgeschlagene Aktion als kopierbaren Befehl.
- Nach dem Erledigen: „ich habe es getan" mit optionaler Notiz, die als Beobachtung in den Turn zurückgeht — nicht als Freigabe. Der Unterschied ist wichtig: der Werkzeugaufruf wurde nicht ausgeführt, sondern ersetzt.
- kaprek hat keinen eigenen Browser, an den es übergeben könnte. Der ehrliche Handoff ist das Terminal und der Ordner, nicht ein Bildschirm-Stream.
- Voraussetzung ist ein aussetzbarer Lauf, also Punkt 5 aus `ERWEITERUNGSPLAN.md`. Ohne den ist „Übernehmen" nur ein hübscheres Deny.

**Aufwand.** M, nach Punkt 5 des Erweiterungsplans.

**Risiko.** Mittel. Ein Modell, das glaubt, sein Werkzeugaufruf sei ausgeführt worden, obwohl ein Mensch etwas anderes getan hat, produziert Folgefehler. Die Rückmeldung muss als Beobachtung formuliert sein, nicht als Erfolgsmeldung.

### 1.4 Ein Fenster, kein Browser-Tab

**Almanac.** Slack und iMessage — der Agent wohnt dort, wo der Nutzer ohnehin ist, nicht in einem Tab, den man schließt.

**kaprek heute.** `bin/cli.mjs` öffnet den Browser, der Server bindet `127.0.0.1:4900` (`src/cli/args.mjs`, README.md:75) und weicht bei belegtem Port bis zu zehn Ports nach oben aus. Jede `/api/*`-Route verlangt das Instance-Token im Header `x-kaprek-token`; ins HTML kommt es über `injectTokenMeta()` in `serveStatic()` (`src/server/server.mjs`). CORS-Header gibt es bewusst keine, stattdessen den CSRF-Header `x-app-request: 1` auf allen Nicht-GET-Aufrufen. Die Turn-Streams laufen als POST mit `text/event-stream` und werden im Client als fetch-Stream gelesen, nicht über `EventSource` (`web/src/lib/api.ts`) — für eine Hülle ist das der einfachere Fall, weil kein zweiter Kanal offengehalten wird.

Drei Bausteine der Desktop-Verpackung stehen schon: `scripts/package-win.mjs` baut `dist-zip/kaprek-win.zip` mitsamt Rauchtest (auspacken, doppelklicken, läuft), `kaprek autostart install` trägt den Start in den Autostart-Ordner ein (`src/cli/autostart.mjs`), und `src/lib/instance-lock.mjs` verhindert den zweiten Server auf demselben Data-Dir. Was fehlt, ist das Fenster.

Das ist der Ausgangspunkt für Abschnitt 1.5.

### 1.5 Wege zur Standalone-App

Fünf Optionen, bewertet gegen zwei kaprek-Eigenheiten: der Server hat **null Laufzeit-Abhängigkeiten**, und der statische Netz-Wächter verbietet Netz-Clients im Node-Code. Beides schließt Bequemlichkeiten aus, die anderswo normal sind — ein Auto-Updater zum Beispiel darf nicht im Node-Teil leben, sonst bricht `src/no-network.test.mjs` den Build.

| Option | Was sie löst | Was sie kostet | Aufwand | Risiko |
|---|---|---|---|---|
| **Zip + Autostart** (existiert) | Fremde können es starten | Fühlt sich nicht wie App an, Token liegt im HTML | — | — |
| **PWA / installierbare Seite** | Eigenes Fenster ohne Browser-Chrome, App-Icon, kein Tab | Kein Tray, kein Autostart, Token-Lücke bleibt | S | gering |
| **Tauri v2 ohne gebündeltes Node** | Fenster, Tray, Autostart, Token nie über HTTP | Rust-Toolchain im Build, WebView2 als Plattform-Abhängigkeit | M | mittel |
| **Tauri v2 mit Node-Sidecar** | Läuft auch ohne installiertes Node | Bundling einer Node-Runtime, Signatur-Fragen | L | mittel bis hoch |
| **Electron** | Node ist eingebaut, der Server läuft direkt im Main-Prozess | ~85 MB Chromium und ein großer Abhängigkeitsbaum in einem Zero-Dep-Projekt | M | mittel |

**Empfehlung: Stufenweise, mit Tauri v2 als Ziel und ohne gebündeltes Node — und das Ergebnis heißt dann nicht „standalone".** Solange Node und die CLIs getrennt installiert sein müssen, ist es eine umgebungsabhängige Desktop-Hülle. Das Zip bleibt der Rückfallweg, nicht der abgelöste Vorgänger.

Der entscheidende Punkt wird meist übersehen: **wer kaprek benutzt, hat Node und die `claude`-CLI ohnehin installiert** — sonst gäbe es nichts zu beaufsichtigen. Damit ist die teure Hälfte jeder Desktop-Verpackung, das Mitliefern einer Laufzeit, für die heutige Zielgruppe unnötig. Die Hülle muss nur ein Fenster aufmachen, `node bin/cli.mjs` starten, das Token entgegennehmen und es dem WebView per Init-Script übergeben, statt es in `GET /` auszuliefern.

- **Stufe 1 (S): PWA-Manifest.** `web/index.html` bekommt ein Manifest, `bin/cli.mjs` weist einmalig auf „installieren" hin. Kostet einen Nachmittag, bringt das eigene Fenster und das Icon. Löst das Token-Problem nicht und behauptet es auch nicht.
- **Stufe 2 (M): Tauri-v2-Hülle als eigenes Repo oder Unterordner.** Startet den vorhandenen Server als Kindprozess, liest das Token aus dessen stdout, injiziert es per Init-Script ins WebView, zeigt Tray-Icon und meldet „läuft bereits" statt eines stillen zweiten Starts (`instance-lock` liefert die Antwort dafür schon; Autostart kommt aus `src/cli/autostart.mjs`). Der Server-Code ändert sich an genau einer Stelle: `injectTokenMeta()` schweigt, wenn die Hülle das Token übernimmt — dann steht in `GET /` kein Token mehr, das ein anderer lokaler Prozess abholen kann. Damit ist die im README benannte Lücke geschlossen, und das ist der eigentliche Gewinn, nicht das Icon.
- **Stufe 3 (L, später): Node bündeln.** Erst wenn kaprek Nutzer ohne installiertes Node haben soll. Node 25.5 hat dafür `--build-sea` als Ein-Schritt-Weg (Januar 2026), Tauri dokumentiert Node als Sidecar. Diese Stufe hängt inhaltlich an Abschnitt 3: ein Nutzer ohne Node hat auch keine `claude`-CLI, und dann fehlt kaprek nicht die Laufzeit, sondern das Harness.
- **Electron nur als Rückfallebene**, falls die Rust-Toolchain zum echten Blocker wird. Technisch der glatteste Weg für einen Node-Server, aber ein Projekt, das „zero runtime dependencies" ins README schreibt, verliert damit sein deutlichstes Versprechen.

**Risiken quer über alle Stufen.**

- **Signierung und SmartScreen.** Eine unsignierte Windows-App wird beim ersten Start blockiert. Das Zip hat dieses Problem heute schon, eine `.exe` macht es sichtbarer. Zertifikat kostet Geld und Zeit; ohne das bleibt der erste Start hässlich.
- **Auto-Update.** Der Netz-Wächter zwingt den Updater in die Hülle. Sauber, aber es heißt: zwei Release-Kanäle (npm und App) mit getrennter Versionslogik.
- **Zwei Oberflächen, ein Zustand.** Solange die Hülle nur die vorhandene Web-UI zeigt, gibt es keinen zweiten Frontend-Code. Sobald jemand „native Menüs" will, gibt es ihn. Nicht anfangen.

### 1.7 Einwände aus dem Council (Codex, 31.08.2026)

Der Entwurf ist blind gegen Codex gelaufen. Grok kam nicht durch („max turns"), es gibt also kein Zweitvotum. Was Codex geliefert hat, trifft und steht deshalb hier, statt weggeglättet zu werden:

- **Die Token-Lücke wird kleiner, nicht geschlossen.** Der Satz aus 1.5, Stufe 2, war zu stark. Das Token bleibt für JavaScript im WebView erreichbar — XSS, unerwünschte Navigation oder eingebetteter Fremdinhalt kommen daran. Zur Stufe 2 gehören deshalb zwingend: CSP im WebView, Navigations-Sperre auf die eigene Herkunft, und Tauri-Capabilities so eng wie möglich. Der Gewinn ist, dass `GET /` das Token nicht mehr an jeden lokalen Prozess ausliefert; mehr ist es nicht.
- **Der Bootstrap braucht eine Server-Identität.** Ein feindlicher lokaler Prozess kann den erwarteten Port besetzen, bevor die Hülle verbindet; das WebView bekäme dann das Token auf einen fremden Server. Die Hülle darf sich nicht auf „Port 4900 antwortet" verlassen, sondern muss Kindprozess, Port und WebView-Sitzung aneinander binden (Token aus dem stdout genau dieses Kindes, Abgleich vor der Injektion).
- **`injectTokenMeta()` abschalten ist kein Flag.** Ein Umgebungsschalter, der versehentlich im Browser-Betrieb greift, macht die Oberfläche unbrauchbar oder inkonsistent. Der Hüllen-Modus braucht eine eindeutige, geprüfte Bedingung und einen Test für beide Betriebsarten.
- **PATH.** Ein aus der GUI gestarteter Prozess erbt die Shell-Umgebung nicht zuverlässig. Node und `claude` können installiert und trotzdem nicht auffindbar sein. Zur Stufe 2 gehören Auffinden der ausführbaren Datei, Mindestversions-Prüfung und eine Fehlermeldung, die sagt, was zu tun ist — kein stiller Fehlstart.
- **Lebenszyklus.** Herunterfahren des Kindprozesses, Absturz, stdout-Pufferung, Portwahl, Andocken an eine bereits laufende Instanz, Waisen nach einem Absturz der Hülle: alles ungelöst und alles der Grund, warum solche Hüllen sich „manchmal komisch" verhalten.
- **Das Zero-Dependency-Argument gilt nur für den Server.** Tauri bringt Rust-Crates, WebView2, Plugins, Signierung und eine Release-Infrastruktur mit. Gegen Electron zählt das Argument also schwächer, als es in der Tabelle klingt. Es bleibt bei der Empfehlung, aber aus dem Größen- und Token-Grund, nicht aus Reinheit.
- **Fixtures allein reichen nicht (Abschnitt 3.4, E0).** Aufgezeichnete Ausgaben prüfen kapreks Parser gegen bekannte Beispiele; sie merken nicht, dass eine frisch installierte CLI live etwas anderes spricht. Fixtures brauchen Versions-Metadaten und dazu einen Rauchtest gegen die tatsächlich installierte CLI-Version.
- **Der Auslöser „mehr als zweimal im Quartal" ist willkürlich** und wird in 3.3 entsprechend ersetzt.

Nicht übernommen: Codex hält „N=1" für eine schwache Begründung und will stattdessen Zuverlässigkeit, Kosten, Kontrollbedarf und Upstream-Stabilität als Maßstab. Die Kriterien sind besser, aber die Frage nach der Zahl der Nutzer kam von Klaus und wird beantwortet — die Kriterien stehen jetzt zusätzlich in 3.3.

### 1.6 Marktüberblick: was gerade taugt

Bewertet für den kaprek-Weg, Stand 31.08.2026 (Versionen live geprüft, nicht aus dem Gedächtnis):

- **Tauri v2** (stabil 2.10.1, März 2026): nutzt die Plattform-WebView statt eigenem Chromium, Rust-Backend, Sidecar-Mechanismus für externe Binaries dokumentiert. **Passt.** Empfehlung aus 1.5.
- **Electron**: reifer, vorhersagbares Rendering, größte Paketier-Ökosystem — und Node eingebaut. **Passt technisch, kollidiert mit dem Zero-Dep-Versprechen.**
- **Node SEA** (`--build-sea` seit Node 25.5, Januar 2026; löst den alten `postject`-Mehrschrittweg ab): relevant für Stufe 3. Achtung, die Build-Maschine braucht dann Node 25.5+, während `package.json` heute `>=22` fordert. **Später.**
- **shadcn/ui + Tailwind v4**: Komponenten werden als Quelltext ins Repo kopiert, nicht als Abhängigkeit installiert. Das passt zu kapreks Haltung besser als jede Komponenten-Bibliothek. Nutzen konkret: Command-Palette, Dialog, Toast, Datentabelle — genau die vier Bausteine, die für Abschnitt 1.1 fehlen und die man sonst selbst baut. **Passt, lohnt sich.**
- **AG-UI (CopilotKit)**: Ereignis-Protokoll zwischen Agent-Backend und Frontend, schnell wachsend. kaprek hat eigenes SSE und eigene Event-Blöcke (`EventBlock.tsx`). Ein Protokollwechsel bringt für einen Operator nichts. **Nicht übernehmen** — aber die Ereignisliste einmal gegen die eigenen Blöcke halten, sie ist eine brauchbare Vollständigkeitsprüfung.
- **assistant-ui / AI-Elements-artige Chat-Kits**: fertige Chat-Oberflächen. kaprek hat einen Chat und braucht einen Leitstand. **Nicht übernehmen.**
- **Playwright**: Screenshot-Prüfung der Oberfläche im Testlauf. Passt zum vorhandenen Vitest-Setup und ist der billigste Weg, eine GUI-Umbauwelle abzusichern. **Passt.**

---

## 2. Almanac-Patterns, priorisiert

### 2.1 Proaktivität mit Bericht danach — statt Zeitplan mit Leerlauf

**Almanac.** Bemerkt Arbeit selbst, tut sie, berichtet danach.

**kaprek heute.** Trigger sind zeit- oder heartbeat-getrieben (`src/triggers/registry.mjs`, `runner.mjs`). Der Erweiterungsplan bringt mit Punkt 4 die `skip-if`-Vorbedingung und mit Punkt 7 den Morgen-Digest. Damit ist die Hälfte da: der Agent läuft nicht mehr blind und berichtet hinterher.

**Delta zu Almanac.** Der Auslöser bleibt die Uhr. „Bemerkt Arbeit selbst" heißt, ein Ereignis löst aus: neue Datei im Ordner, Git-Commit auf einem Branch, geänderte Datei unter dem Mission-cwd, neuer Eintrag in einer Datei.

**Skizze.**

- Vierter Trigger-Typ `watch` neben `schedule`, `heartbeat` und der Zwischenablage: beobachtete Pfade mit Debounce, Containment über `src/lib/contain.mjs`, harte Obergrenze für die Zahl beobachteter Pfade.
- Kein Dateisystem-Watcher als erster Schritt — Polling im vorhandenen Tick reicht und ist plattformneutral. `file-newer-than-last-run` aus Punkt 4 ist bereits die halbe Implementierung.
- Tageslimits aus `src/triggers/limits.mjs` gelten unverändert, sonst wird ein Build-Ordner zur Kostenquelle.

**Aufwand.** M, nach Punkt 4 des Erweiterungsplans.

**Risiko.** Mittel. Ein zu weit gefasster Pfad feuert bei jedem Build. Debounce und Limit sind Pflicht, nicht Zugabe.

### 2.2 Selbst-aktualisierendes Wiki mit Quellenlink

Siehe 1.2 — der Pattern ist primär eine GUI- und Datenmodell-Frage. Was hier ergänzend gehört: Almanacs Wiki entsteht **aus Quellen**, nicht aus Chat-Nebenbemerkungen. Für kaprek hieße das ein Import-Lauf, der ein Projekt liest und daraus Fakten mit Herkunft schreibt (`src/memory/import.mjs` und `src/scan/scan.mjs` sind die Anknüpfung). Aufwand M, Risiko mittel: ein Import, der Vermutungen als Fakten schreibt, vergiftet das Memory schneller, als ein Mensch es korrigiert. Regel: importierte Einträge starten mit `lastVerifiedAt = null` und werden in der Oberfläche als unbestätigt geführt.

### 2.3 Beobachtbarkeit jedes Laufs

**Almanac.** Jeder Run ist beobachtbar, während er läuft.

**kaprek heute.** `runs.jsonl` hat `costUsd`, `usage`, `tokens`, `durationMs`, `stopReason`, `origin`, `triggerId`. Punkt 8 des Erweiterungsplans macht Zustellung und Gesehen-Status sichtbar. Der laufende Turn ist im Chat sichtbar, aber nicht als Vorgang mit Fortschritt.

**Skizze.** Das Startbild aus 1.1 ist die Antwort; zusätzlich eine Lauf-Detailseite, die für einen abgeschlossenen Run dieselbe Struktur zeigt wie für einen laufenden: Schritte, Werkzeugaufrufe, berührte Dateien, Kosten, Fragen. Eine Ansicht, zwei Zustände.

**Aufwand.** M (fällt weitgehend mit 1.1 zusammen). **Risiko.** Gering.

### 2.4 Messaging-first

**Almanac.** Slack und iMessage als einziges Interface.

**Stand bei Klaus.** Die Bridge ist das bereits: Aufträge kommen als GitHub-Issues, Ergebnisse gehen als `results/<id>.md` plus Issue-Kommentar zurück, Telegram meldet an Klaus. kaprek hat den `--lan`-Modus mit QR-Code und einem engeren Handy-Token, das nur die Inbox lesen und Fragen beantworten darf.

**Delta.** Was fehlt, ist der Rückweg vom Handy in einen laufenden Chat: heute kann das Handy antworten, aber nicht beauftragen. Das ist eine bewusste Grenze und sollte eine bleiben, solange das Token über LAN reist.

**Empfehlung.** **Nicht übernehmen.** Kein zweiter Chat-Kanal in kaprek. Wenn Messaging, dann über die Bridge, die dafür gebaut ist. Aufwand entfällt, Risiko wäre hoch (ein Messaging-Eingang ist ein Netz-Eingang, und der Netz-Wächter existiert aus gutem Grund).

### 2.5 Nutzungs-Kappen für Modell und Laufzeit

**Almanac.** Nutzungsbasierte Kappen auf Modell-Verbrauch und Browser-Minuten, sichtbar im Tarif.

**kaprek heute.** Die Zahlen liegen in `runs.jsonl`; `src/triggers/limits.mjs` kappt Läufe pro Tag, nicht Kosten.

**Befund Bridge.** Der Watcher kappt über Zeit (30 Minuten je Job) und `--max-turns 120`. Eine Kostenmessung gibt es nicht, obwohl `CONTRACT.md` §10.3 von einer Kostenkappe spricht. Die Daten wären da: der Lauf schreibt `job-<id>.stream.jsonl` mit dem Ergebnis-Ereignis der CLI, das die Gesamtkosten des Laufs trägt.

**Skizze.**

- kaprek: Budget je Mission und Tag in Dollar, geprüft vor dem Start eines Turns, nicht mitten drin. Bei Überschreitung eine deferred Frage statt eines stillen Stopps. Anzeige im Startbild aus 1.1.
- Bridge: Kosten je Auftrag aus dem Stream ziehen, in `state/jobs.json` mitschreiben und im Ergebnis-Kopfblock neben `dauer_min` führen. Das macht §10.3 erst wahr. (Vorschlag — dieser Lauf ändert nichts unter `watcher/`.)

**Aufwand.** kaprek M, Bridge S. **Risiko.** Gering. Falle: eine harte Kappe mitten im Lauf lässt einen halben Zustand zurück; darum vor dem Turn prüfen.

### 2.6 Läuft, wenn der Deckel zu ist

**Almanac.** Eigener Cloud-Computer — der Agent arbeitet weiter, wenn der Laptop schläft.

**Stand bei Klaus.** Der Bridge-Watcher ist ein Windows-Scheduled-Task auf dem PC, alle 15 Minuten. Schläft der Rechner, passiert nichts; der Wachhund meldet die Stille immerhin nach 30 beziehungsweise 120 Minuten. Der Kopfblock kennt bereits `runner: pc|cloud`, aber der Cloud-Runner ist ein Feld ohne Implementierung.

**Skizze.**

- Aufträge markieren, die keine lokalen Pfade und keine lokalen Secrets brauchen (reine Recherche, Textarbeit, Repo-Analyse gegen GitHub). Nur die sind cloud-fähig.
- Für diese Klasse ein zweiter Runner, der nicht auf dem PC liegt. GitHub Actions ist der naheliegende Weg, weil der Auftragsträger ohnehin ein Issue ist.
- Alles mit Pfad unter `Documents\Software`, mit `.env`-Zugriff oder mit Deploy bleibt `runner: pc`. Diese Trennung ist die eigentliche Arbeit, nicht die Pipeline.

**Aufwand.** M bis L. **Risiko.** Hoch, wenn die Trennung unsauber ist: ein Cloud-Runner mit Zugriff auf lokale Zugangsdaten wäre genau der Schritt, den kaprek und die Bridge bisher nicht gehen. Lieber wenige cloud-fähige Aufträge als eine unscharfe Grenze.

### 2.7 Live-Browser-Übergabe

Siehe 1.3. Als eigenständiger Pattern: **nicht übernehmen** in der Almanac-Form. kaprek hat keinen eigenen Browser, und einen zu bauen hieße, den Netz-Wächter aufzugeben. Der übernehmbare Kern ist der Handoff-Knopf, nicht der Bildschirm.

---

## 3. Eigenes Harness

Klaus, 31.08.: „Und ein eigenes Harness." Gemeint ist der Schritt von Supervision um `claude` und `codex` herum zu einem eigenen Agent-Loop.

### 3.1 Was heute an der CLI hängt

Wichtig für die Einordnung: kaprek parst keine Terminal-Ausgabe. Beide Engines laufen über strukturierte Protokolle.

- `src/harness/claude-code.mjs` startet `claude -p --output-format stream-json --input-format stream-json --verbose` — JSON-Zeilen in beide Richtungen. Freigaben kommen als `control_request`/`can_use_tool` über denselben Strom zurück und werden per `request_id` beantwortet; `mapLine()` übersetzt die Ereignisse. Der Prompt geht über `child.stdin.write()` raus, das ist der Egress-Punkt.
- `src/harness/codex.mjs` startet `codex app-server` und spricht JSON-RPC über stdio (`initialize` → `thread/start` bzw. `thread/resume` → `turn/start`), Freigaben sind blockierende Server-Anfragen.
- `src/harness/adapter.mjs` hält den Vertrag, `src/harness/registry.mjs` die Engine-Liste samt Fähigkeiten, `src/harness/fake.mjs` die Testdoppel. Eine Adapter-Schicht existiert also bereits — sie ist nur nirgends gegen echte Ausgaben festgenagelt.
- `src/parser/parse.mjs` ist **nicht** der Live-Parser, sondern der Digest-Parser für die Transkript-JSONL-Dateien auf Platte (Viewer, Suche, Resume). Er hängt am Dateiformat von Claude Code, nicht am Stream.
- `src/harness/settings.mjs` schreibt gelernte Werkzeugnamen in die Permission-Listen der CLI — kapreks Freigabe-Logik hängt am Einstellungsformat der fremden CLI.

Die Bruchfläche ist damit scharf benennbar, und es sind fünf Kanten, keine diffuse Abhängigkeit: (a) argv-Flags der CLIs, (b) das `stream-json`-Ereignis-Schema, (c) Resume-IDs von Claude und Codex, (d) die beiden Freigabe-Kanäle, (e) das Transkript-Dateiformat unter `~/.claude/projects`.

Ein eigenes Harness müsste ersetzen: den Loop, das Tool-Calling, das Kontext-Management und die Freigabe-Abfrage im Loop. Von diesen vier ist nichts delegierbar — entweder man hat den Loop oder man beobachtet einen fremden.

### 3.2 Die Abhängigkeit ist real, aber sie ist nicht die teuerste Zahl

Das Muster aus dem OpenClaw-Vergleich gilt hier genauso: eine fremde CLI ändert Ausgabeformate, Flags und Voreinstellungen ohne Rücksicht auf Beobachter. Jeder solche Wechsel trifft `parse.mjs` und `settings.mjs`.

Zwei kaufmännische Fakten kommen dazu, beide am 31.08.2026 recherchiert und gegen die eigene Abrechnung nachzuprüfen, bevor jemand darauf plant:

- Seit dem 15.06.2026 zieht der headless-Weg (`claude -p` und das Agent SDK) laut Anthropic-Hilfe nicht mehr aus dem interaktiven Abo-Kontingent, sondern aus einem getrennten Agent-SDK-Guthaben zu API-Raten. Wenn das für kapreks Trigger- und Council-Läufe gilt, ist der CLI-Weg kein Flatrate-Weg mehr — und das schwächt genau das Argument, mit dem man ein eigenes Harness bisher verworfen hat.
- Anthropic untersagt Abo-OAuth für Dritt-Produkte. Ein eigenes Harness in kaprek dürfte sich also nicht am Abo bedienen, sondern bräuchte einen API-Key des Nutzers. Damit fällt kapreks Satz „no API key, no account" — für ein öffentliches Werkzeug ist das ein Positionsverlust, kein Detail.

### 3.3 Ehrliche Einordnung für N=1

**Für einen einzelnen Operator ist ein vollständiges eigenes Harness Overkill.** Nicht weil es zu schwer wäre, sondern weil es ein täglich von Zehntausenden getestetes Harness gegen eines tauscht, das nur Klaus testet. Der Gewinn wäre Unabhängigkeit vom Format; der Verlust wäre jede Verbesserung, die in den CLIs von selbst ankommt, plus die Pflicht, Kontext-Management und Tool-Calling dauerhaft nachzuziehen.

Drei Ausnahmen, in denen es sich lohnt — und nur diese drei:

1. **Formatvertrag festnageln (S bis M, lohnt sofort).** Die Adapter-Schicht steht bereits (`adapter.mjs`, `registry.mjs`, `fake.mjs`); was fehlt, sind Fixtures echter Stream-Ausgaben beider Engines und Tests, die brechen, wenn sich das Format ändert. Heute merkt kaprek einen Bruch erst im Live-Lauf. Das ist die billigste Versicherung gegen den teuersten Fehler — und sie ist kein Harness, sondern Hygiene.
2. **Mini-Harness für nicht-agentische Turns (M, opt-in).** Digest-Zusammenfassung, Titelvorschlag, Klassifikation: ein HTTP-Aufruf gegen ein kleines Modell, kein Loop, kein Werkzeug. Bricht allerdings sowohl das „kein Netz"-Versprechen des Node-Codes als auch „kein API-Key" — deshalb nur als ausdrücklich einzuschaltendes Extra mit eigenem README-Absatz, oder gar nicht.
3. **Eigener Loop (L+, nur bei Auslöser).** Nicht die Häufigkeit von Änderungen entscheidet, sondern ihre Schwere: ein einziger Bruch, der Freigaben, Resume oder unbeaufsichtigte Läufe unbrauchbar macht, wiegt schwerer als zehn harmlose Formatwechsel. Gerechtfertigt ist der eigene Loop, wenn eines davon eintritt: ein Bruch trifft einen dieser drei Kernwege und lässt sich nicht im Adapter auffangen; kaprek soll Nutzer bedienen, die keine CLI installiert haben (das ist die Verbindung zu Abschnitt 1.5, Stufe 3); oder die Abrechnung macht den CLI-Weg dauerhaft teurer als den direkten.

Codex' Einwand dazu ist berechtigt: „ein Operator" ist für sich kein Argument. Die Maßstäbe sind Zuverlässigkeit, Kosten, benötigte Kontrolltiefe und Stabilität der fremden Schnittstelle. Sie fallen heute alle vier zugunsten der CLIs aus — die Zuverlässigkeit, weil die CLIs täglich unter echter Last laufen; die Kosten, solange die Abrechnungsfrage aus 3.2 nicht anders beantwortet ist; die Kontrolltiefe, weil kaprek Freigaben bereits über strukturierte Kanäle bekommt statt über geratene Ausgaben; die Stabilität, weil beide Anbieter maschinenlesbare Modi pflegen. Kippt einer dieser vier, kippt das Verdikt — nicht wenn die Nutzerzahl steigt. Ebenfalls offen und ehrlich zu benennen: dass ein eigener Loop „jede Verbesserung der CLIs verliert", ist eine Annahme, kein Messwert. Bevor E4 startet, gehört eine Fähigkeits-Gegenüberstellung auf den Tisch (das ist genau E2).

### 3.4 Migrationspfad in Etappen

- **E0 — Formatvertrag.** Fixtures und Verträge-Tests für die Stream-Ausgaben beider Engines, mit Versions-Metadaten am Fixture und einem Rauchtest gegen die tatsächlich installierte CLI-Version — sonst prüft man nur sich selbst. Aufwand S. Ohne Nutzen-Verlust, auch wenn nie ein Harness kommt.
- **E1 — Adapter-Schicht.** Ein Modul je Engine, das rohe CLI-Ereignisse in kapreks eigenes Ereignis-Modell übersetzt; der Rest des Codes sieht die CLI nicht mehr. Aufwand M.
- **E2 — Fähigkeits-Matrix.** Je Engine festhalten, was sie kann (Resume, Werkzeug-Freigabe, Kostenmeldung, Strukturierte Ausgabe) und was kaprek deshalb anders macht. Aufwand S. Nebengewinn: die Council-Auswahl wird begründbar statt gefühlt.
- **E3 — Mini-Harness** für die drei bis vier nicht-agentischen Aufgaben, hinter einem Schalter. Aufwand M.
- **E4 — eigener Loop**, nur bei Auslöser aus 3.3. Aufwand L+, eigenes Zustandsmodell, eigene Abnahme.

E0 bis E2 sind auch dann richtig, wenn E4 nie kommt. Das ist der Test für einen guten Migrationspfad: die frühen Etappen müssen sich allein tragen.

---

## 4. Was bewusst nicht übernommen wird

- **Eigener Cloud-Computer mit fremden Logins.** Widerspricht dem Netz-Wächter und der Position „local only".
- **Browser-Automation mit Zahlungen.** Nichts, was Geld ausgibt, ohne dass ein Mensch den Knopf drückt.
- **Geteiltes Org-Wiki.** Ein Operator, ein Dateisystem. Der Mandanten-Teil von Almanac hat für kaprek keinen Adressaten.
- **Zweiter Chat-Kanal in kaprek.** Messaging läuft über die Bridge.
- **Doku hinter Login, kein Self-Hosting.** Almanacs Schwäche, nicht sein Feature — kaprek ist Apache-2.0 und liest sich selbst vor.

---

## 5. Reihenfolge-Empfehlung

1. **1.1 Startbild** — größter sichtbarer Sprung je Aufwand, alles andere hängt sich daran an.
2. **1.5 Stufe 1 (PWA)** — ein Nachmittag, macht aus dem Tab ein Fenster.
3. **2.5 Kostenmessung Bridge (S)** — schließt eine Lücke zwischen Vertrag und Implementierung.
4. **1.2 Memory mit Herkunft** — macht das Memory prüfbar, statt es zu vergrößern.
5. **3.4 E0/E1 (Formatvertrag, Adapter)** — Versicherung, bevor die nächste CLI-Version kommt.
6. **1.5 Stufe 2 (Tauri-Hülle)** — schließt die Token-Lücke aus README.md:604 und macht die App zur App.
7. **1.3 Handoff** — braucht vorher Punkt 5 aus `ERWEITERUNGSPLAN.md` (aussetzbare Läufe).
8. **2.1 Watch-Trigger** — braucht vorher Punkt 4 aus `ERWEITERUNGSPLAN.md`.
9. **2.6 Cloud-Runner** — erst, wenn die Trennung cloud-fähig/nicht-cloud-fähig sauber definiert ist.
10. **3.4 E3/E4** — nur bei Auslöser.

Die Punkte 1, 2, 4 und 6 zusammen sind das, was Klaus mit „intuitive Benutzeroberfläche" meint. Die Punkte 5 und 10 sind das Harness-Thema, und die ehrliche Antwort darauf steht in 3.3: die ersten beiden Etappen lohnen sich, der eigene Loop nicht — noch nicht.

---

## Quellen

- Almanac: <https://usealmanac.com>, <https://usealmanac.com/pricing>, <https://www.ycombinator.com/companies/almanac>, <https://www.producthunt.com/products/almanac-5> (Analyse geliefert über die Bridge, Auftrag `2026-08-31-237`).
- Tauri v2 Sidecar und Stand: <https://v2.tauri.app/develop/sidecar/>, <https://v2.tauri.app/learn/sidecar-nodejs/>.
- Node.js Single Executable Applications: <https://nodejs.org/api/single-executable-applications.html>.
- Claude-Abo und Agent SDK: <https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan>.
- AG-UI: <https://github.com/ag-ui-protocol/ag-ui>.
- Intern: `ERWEITERUNGSPLAN.md`, `README.md`, `C:\Users\karent\Documents\Software\instinct-bridge\CONTRACT.md`.
