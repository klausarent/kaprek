# Gesamtplannung kaprek — Bestand verbessern

Stand: 01.09.2026. Grundlagen: `ERWEITERUNGSPLAN.md` (OpenClaw 2.0, v2026.8.1), `ALMANAC-PLAN.md` (Almanac, YC S26), plus eine eigene Gegenprüfung beider Quellen am 01.09.2026. Dieses Dokument ist die konsolidierte Reihenfolge über alle drei Quellen mit dem Schwerpunkt, **die vorhandenen Features zu verbessern** — keine neuen Oberflächen, kein neues Harness. Die auf Zuruf stehenden Abschnitte GUI/Standalone-App und eigenes Harness bleiben in `ALMANAC-PLAN.md` §1 und §3 und werden hier nur referenziert.

Almanac-Gegenprüfung: der Plan trifft das Produkt (Always-on-Cloud-Agent über iMessage/Slack, selbst-aktualisierendes Wiki mit Zeilen-quellen, Pausieren bei Login/Zahlung, beobachtbare Läufe, widerrufbare Konto-Anbindungen). **Neu gelernt, aber nichts zu bauen:** Almanac hält persönliche Konten privat und lässt nur *destillierte* Erkenntnisse (Entscheidungen, nicht rohe Postfächer) ins geteilte Wiki fließen. Das ist genau kapreks Sichtbarkeitsregel (`visibleScopes()` nur aufwärts) plus Memory-Modell (Fakten statt Transkript-Auszüge) — der Pattern ist bereits implementiert, er heißt nur nicht so. Bestätigung, kein Arbeitsauftrag.

---

## A. Neue Punkte aus der eigenen OpenClaw-Prüfung

Vier Punkte, die in keinem der beiden Pläne stehen. Drei davon sind S — sie gehören in Phase 1, weil sie bestehende Features hart machen, bevor neue gebaut werden.

### A1. `kaprek doctor` (M)

**Ziel.** Formatdrift, halb installierte Hooks und inkonsistente Zustandsdateien sind heute nur indirekt sichtbar (stille `brokenLines`-Zählung, FAQ nennt Doctor „planned but not built"). OpenClaw 2.0 trägt seine gesamte Migrationslast über `openclaw doctor --fix` — inklusive sicherer Konfigurations-Migrationen beim Start vor dem Normalbetrieb.

**Anknüpfung.** `src/parser/parse.mjs` zählt `brokenLines` und still übersprungene unbekannte `type`-Zeilen, aber nichts zeigt sie an. `kaprek hooks status` listet die vier Hooks, prüft aber nicht, ob die Einträge noch *stimmen* (Pfad, Skript vorhanden, `--managed-by`-Marker intakt). Der Search-Index trägt bereits ein Schema-Version und dropped sich bei eigener Änderung selbst. Presets unter `<dataDir>/presets/` werden laut README bei Invalidität mit Warnung übersprungen — aber die Warnung landet nirgends dauerhaft.

**Skizze.**

- `kaprek doctor` prüft ohne Schreibzugriff und gibt einen Bericht: Transkript-Drift (Anteil übersprungener Zeilen pro zuletzt geöffneter Session, Schwellwert-Meldung), Hook-Einträge verifiziert gegen die Dateien, die sie aufrufen, Search-Index-Schema gegen die erwartete Version, Presets-Validität, Ledger-Integrität (letzte Zeile je Session, verwaiste `context/`-State-Dateien), Grants/Awareness für künftige Stores.
- `--fix` nur für die Klasse „sicher reparierbar": verwaiste State-Dateien löschen, Index neu bauen, defekte Hook-Einträge aus der Sicherung wiederherstellen. Alles andere wird gemeldet, nicht angefasst.
- Zwei Klassen, scharf getrennt und im Output benannt: *automatisch reparierbar* vs. *Operator muss hinsehen*. Das ist die eigentliche Lehre aus OpenClaw — nicht der Befehl, sondern die Trennung.
- Später, nicht in der ersten Fassung: sichere Migrationen beim Serverstart (nur idempotente, fingerprint-geprüfte Schritte).

**Risiko.** Gering. `doctor` ist ohnehin im README als geplant benannt; diese Fassung macht das Versprechen wahr, ohne den Startpfad zu verändern.

### A2. Update-Verifikation: gemeldete Version ist die laufende Version (S)

**Ziel.** `kaprek update` meldet heute Erfolg, wenn npm die neue Version installiert hat. OpenClaw hatte exakt diesen Fehlerklasse-Fix: „prevent Git updates from reporting success while serving an old web build". Auf einem Git-Checkout, bei belegtem laufendem Server oder bei npx-Cache-Reuse kann die Platte neu und der Prozess alt sein — und der Erfolg ist gelogen.

**Anknüpfung.** `bin/cli.mjs` / `src/cli/` kennt die eigene Version (`package.json`); die Instance-Lock-Grußantwort (`src/lib/instance-lock.mjs`) liefert bereits pid, Server-Port und Startzeit der laufenden Instanz zurück.

**Skizze.**

- Nach erfolgreichem Update die Version der laufenden Instanz über die Lock-Grußantwort erfragen. Weicht sie von der installierten ab: Erfolgsmeldung um einen Satz ergänzen — „installiert X, läuft noch Y — der laufende Server startet beim nächsten `kaprek stop` neu".
- Auf Git-Checkouts zusätzlich `git status --porcelain` prüfen und bei lokalen Änderungen sagen, dass `git pull` die Arbeitskopie nicht überschreiben darf (der Pfad existiert in der Updatetabelle schon, die Prüfung läuft nur vorher, nie danach).
- Test: Lock-Grußantwort mit gefakten Versionen, beide Zweige.

**Risiko.** Gering. Der Netz-Wächter bleibt unberührt — die Instanz-Frage geht über den bestehenden Loopback-Lock.

### A3. Upgrade-Pfad als Testgegenstand (S, Prozess)

**Ziel.** kapreks README macht Backward-Compatibility-Versprechen („receipts from before this feature still verify", Ledger wächst nur, Presets werden übersprungen statt zu crashen, Index wird bei Schema-Bump gedroppt). OpenClaw hat sein Release bewusst verzögert, um *beide* Wege zu validieren: Frischinstallation und Upgrade über alten Datenbestand. kaprek testet heute den ersten Weg systematisch, den zweiten nur implizit.

**Skizze.**

- Ein Vitest, das ein Data-Dir-Fixture „von gestern" (alte Feldstände: `policy.json` ohne `posture`, `approvals.json` ohne `runId`, Ledger ohne `end`-Events, Index mit alter Schema-Version) gegen die aktuelle Öffnungslogik läuft — dieselbe Art Fixture, die `ALMANAC-PLAN.md` §3.4 E0 für CLI-Streams vorsieht, nur für kapreks eigene Dateien.
- Jedes neue Datenformat zwingend mit einem Alt-Fixture-Artefakt ins Repo (Regel im CONTRIBUTING-artigen Absatz, ein Satz genügt bei diesem Projekt).
- Vor jedem breiteren Release: Rauchlauf „frisches Data-Dir" und „Fixture-Data-Dir" nacheinander, per Skript.

**Risiko.** Gering. Die Fixtures fallen beim nächsten Formatwechsel ohnehin an — dies legt nur fest, dass sie im Repo landen.

### A4. Search-Index gegen *neuere* Schemata sichern (S)

**Ziel.** Der Index dropped sich bei einem Schema-Bump der *eigenen* Version. Der umgekehrte Fall — der Index wurde von einer neueren kaprek-Version geschrieben und trägt eine höhere Schema-Version — ist nicht behandelt: älterer Code auf neuerem State ist genau die Restart-Loop-Falle, die OpenClaw mit „refusing newer-schema state" dicht gemacht hat.

**Skizze.** Beim Öffnen: Schema-Version des Index > erwartete Version → nicht öffnen, nicht löschen (die Daten gehören einer neueren Installation!), Search als nicht verfügbar melden mit dem Hinweis auf die neuere kaprek-Version. Symmetrisch zur bestehenden Drop-Logik, ein Zweig mehr im selben Test.

**Risiko.** Praktisch keins.

---

## B. Konsolidierte Reihenfolge für die Bestands-Features

Beide Pläne bleiben inhaltlich die Referenz (Ziel/Anknüpfung/Skizze stehen dort); hier steht nur die gemergte Reihenfolge und was zusammengehört. Alles vor Phase 4 verbessert ausschließlich vorhandene Features.

**Phase 1 — Aufräumen im Bestand (kein neues Datenformat außer Herkunft-Feld)**

1. **ERW #2 — Approval-Lebenslauf** (`cancelled`, `runId`, Historie-Ansicht): die geparkten Fragen, deren Lauf tot ist, sind heute der lauteste Unfahrzustand.
2. **A2 + A4** — Update-Verifikation und Index-Richtungsschutz: zwei S-Punkte, direkt daneben erledigt.
3. **ERW #3 + ALM 1.2 zusammen** — Memory pro Mission **mit** Herkunft-Feld: das sind dieselben Ansichten in einem Zug; die Herkunft (`sourceKind`, `chatId`, `runId`, importiert = unbestätigt) gehört ins Schema, solange es noch neu ist. Getrennt gebaut würde die Mission-Ansicht zweimal angefasst.
4. **A1 — `kaprek doctor`**: profitiert davon, dass Phase 1 die Zustandsdateien frisch durchdacht hat.
5. **ALM 2.5 Bridge-Hälfte** — Kosten je Auftrag aus dem Stream (S, außerhalb kapreks, macht CONTRACT §10.3 wahr).

**Phase 2 — Approvals scharf stellen**

6. **ERW #1 — Scoped Standing Grants**: baut auf #2 auf (Grant-Nutzung muss in der Historie sichtbar sein, sonst verschwindet die Freigabe).
7. **ERW #4 — skip-if-Vorbedingung**: einzige Pflicht-Anknüpfung ist der Run-Eintrag `skipped: 'condition'`; die Bridge-Kostenmessung aus Phase 1 liefert das Kostenargument für die Blind-Läufe, die damit entfallen.
8. **A3 — Upgrade-Fixtures**: ab hier ändern Stores ihre Felder (Grants, Delivery-Events), also ab hier Pflicht.

**Phase 3 — Sichtbarkeit des Unbeaufsichtigten**

9. **ERW #7 — Morgen-Digest** (nutzt #4 für „übersprungen" und ALM-#5-Art Kostenzeilen).
10. **ERW #8 — Trigger-History Tri-State + Missed-Run-Recovery.**
11. **ALM 2.1 — watch-Trigger** (braucht #4, Polling vor Watcher).
12. **ALM 2.5 kaprek-Hälfte — Tagesbudget je Mission** (deferred Frage bei Überschreitung, Anzeige im Startbild).

**Phase 4 — Läufe, die man verlassen kann (L-Punkte)**

13. **ERW #5 — aussetzbare Relay-Läufe** — der einzige echte Zustandsmodell-Wechsel der ganzen Liste.
14. **ALM 1.3 — Handoff-Knopf** (braucht #13, sonst ein hübscheres Deny).
15. **ERW #9 — Live-Plan-Checkliste im Chat.**
16. **ERW #10 — erfasste Autorität** nur falls „Trigger startet Relay" je geöffnet wird.

**Nicht in dieser Plannung, auf Zuruf:** Startbild (ALM 1.1), PWA/Tauri (ALM 1.5), Formatvertrag/Adapter (ALM 3.4 E0–E2 — E0 ist billig und lohnt unabhängig, es gehört nur nicht zum Bestands-Thema hier), eigener Loop (ALM 3.4 E4, nur bei Auslöser aus ALM 3.3).

**Bewusst nicht übernommen (bestätigt in beiden Quellen):** Cloud-Computer mit fremden Logins, zweiter Chat-Kanal, Org-Wiki, Messaging-first in kaprek. Almanacs Privacy-Pattern (privat vs. destilliert geteilt) ist bereits kapreks Sichtbarkeitsregel — festhalten, nicht bauen.

---

## C. Entscheidungen zu Phase 2 (01.09., mit Klaus abgestimmt)

- **Grants und Posture `auto` — entzündet sich nicht.** Grants entstehen ausschließlich aus einer beantworteten Frage; unter Posture `auto` wird nie gefragt, also kann dort kein Grant entstehen, und ein Anlegen von Hand gibt es bewusst nicht. Die Ausgangsfrage „wie entsteht der erste Grant, wenn nicht gefragt wird" ist damit die Antwort: unter `auto` gar nicht, und der Dialog bietet den Knopf schlicht nicht an. Entstandene Grants bleiben bei einer später gesenkten Decke gespeichert und werden wieder wirksam — sichtbar am Trefferzähler. Eingearbeitet in ERW #1.
- **Digest: Zahlen sind die Vorgabe, die Engine-Zusammenfassung Opt-in.** Kein Modellaufruf im Default; der Schalter je Mission nennt die Kosten, der Turn läuft über den vorhandenen Harness (kein neuer Netz-Client, das „kein Netz außer Update"-Versprechen bleibt intakt). Eingearbeitet in ERW #7.
- **Grants ohne Ablaufdatum.** Die 30-Tage-Vorgabe aus der ersten Skizze ist gestrichen. Ein Grant, der sich still selbst abschaltet, wäre genau die stille Verhaltensänderung, die kaprek sonst überall ausschließt — und ein Lauf, der sich auf ihn berufen hat, sähe sein Versprechen ohne Meldung enden. Die Absicherung ist Sichtbarkeit statt Lebensdauer: Trefferzähler, `lastUsedAt`, Widerruf überall sichtbar, und `kaprek doctor` (A1) meldet lange ungenutzte Grants als Aufräum-Kandidat — entscheiden tut der Operator, nicht die Uhr. Eingearbeitet in ERW #1.
