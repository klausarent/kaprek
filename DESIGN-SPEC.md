# Design-Spec kaprek — Phase 1 und 2

Stand: 01.09.2026. Grundlage: `GESAMTPLANUNG.md` (Konsolidierung), `ERWEITERUNGSPLAN.md`, `ALMANAC-PLAN.md`, plus ein Council-Lauf vom 01.09.2026 (`<dataDir>/council/cli/`, Grok: concerns, kam truncated zurück ohne substanziellen Inhalt; Codex: disagree mit zehn Einzel punkten). Die Codex-Einwände sind in diese Spec eingearbeitet, die wichtigsten Änderungen gegen die Gesamtplannung:

1. **A3 (Upgrade-Fixtures) rückt an den Anfang**, vor jede Persistenzänderung. Phase 1 verändert `approvals.json` (`runId`) und Memory-Ereignisse (Herkunft) — Alt-Fixtures erst nach diesen Änderungen anzulegen verfehlt ihren Zweck.
2. **A2 und A4 sind getrennte Pakete** (unterschiedliche Fehlerklassen). A2 braucht zuerst eine Protokollprüfung: liefert die Lock-Grußantwort (`src/lib/instance-lock.mjs`) überhaupt eine Version? Wenn nicht, wird sie abwärtskompatibel erweitert.
3. **ERW#3 + ALM 1.2 bleiben zusammengelegt**, bekommen aber getrennte Abnahme-Kriterien: (a) Scope-Aggregation und Delete-Warnung, (b) persistierte, redigierte Herkunft samt Altbestand ohne Herkunft.
4. **Grants: kein Ablaufdatum, aber ein Autoritäts-Fingerprint.** Der Kompromiss zwischen „keine Uhr" (Klaus) und „unbefristete shape-Grants sind eine dauerhaft erweiterte Berechtigung" (Codex): ein `shape`-Grant trägt einen Fingerprint der Autorität, die beim Anlegen galt — `policyVersion`, Mission-cwd, abgeleitetes Muster. Stimmt der Fingerprint beim Treffer nicht mehr, gilt der Grant als **stale**: er hebt die Frage nicht auf, sie wird einmal neu gestellt, und der Grant wird mit dem neuen Fingerprint neu bestätigt oder verworfen. Genau das Muster, das kapreks Pläne bei „Edited outside kaprek" schon verwenden — ein staleness-Vergleich, kein Ablaufdatum. `exact`-Grants brauchen keinen Fingerprint: byte-gleich heißt byte-gleich.
5. **Grant-Reaktivierung nie still.** Wird die Posture-Decke gesenkt und ein gespeicherter Grant wird wieder wirksam, stellt sein **erster Treffer einmal neu** die Frage (gleicher Mechanismus wie 4). Der Trefferzähler zeigt Reaktivierung erst nach Nutzung — er ist Anzeige, nicht Schutz.
6. **`POST /api/grants` leitet sich serverseitig ab.** Der Client schickt nur `approvalId` und die gewählte Abstufung (`exact`/`shape`); Werkzeugname, kanonisches Input, Scope und Muster entnimmt der Server dem gespeicherten, entschiedenen Approval-Record. Ein Approval gilt als Quelle nur, wenn `status: 'decided'`, Entscheidung `allow` und kein `_truncated`-Input. Alles andere ist 409. Damit kann ein Client kein Muster konstruieren, das niemand freigegeben hat.
7. **Digest: Ehrlichkeitsregel für unvollständige Zahlen.** Ein Wert, den eine Engine nicht geliefert hat, erscheint weder als 0 noch in einer Summe, die ihn stillschweigend einschließt: `unknown`-Kennzeichnung je Feld, Abdeckungszähler im Kopf („Kosten bekannt für 3 von 5 Läufen"), Zeitfenster in lokaler Zeit definiert (Vorgabe: gestern 00:00–24:00, konfigurierbar).
8. **skip-if `conditionError` bleibt fail-open, mit Begründung.** Ein unbeaufsichtigter Trigger mit kaputter Bedingung stillzulegen wäre die stillere Schlechtere: der Trigger hört auf zu existieren, ohne dass es jemand sieht. Der Lauf findet statt, trägt `conditionError` sichtbar, und der Notify-Kopf nennt es. Die Valdierungs-Verträge stehen im Paket P7.

Nicht Bestandteil dieser Spec: Phase 3/4 (Digest-Engine-Schalter, watch-Trigger, Budgets, aussetzbare Läufe, Handoff), GUI, Harness. Für Subagenten gilt: **Der README-Absatz zum jeweiligen Feature gehört zum Paket** — kapreks Dokumentationsstil ist Teil der Abnahme, nicht Zugabe.

---

## Arbeitspakete Phase 1

Jedes Paket ist selbstständig startbar, sofern nichts anderes steht. Konventionen: Vitest, wie im Repo vorhanden; jeder Store append-only oder schema-versioniert; keine neuen Laufzeit-Abhängigkeiten; Netz- und Subprozess-Wächter (`src/no-network.test.mjs`) dürfen keine neuen Einträge bekommen, außer wo ausdrücklich genannt.

### P0 — Upgrade-Fixtures (A3, vor allem anderen)

**Ziel.** Ein Fixture-Data-Dir „von gestern" wird bei jedem Testlauf gegen die aktuelle Öffnungslogik gelaufen; jedes künftige Formatänderungs-Paket erweitert es pflichtmäßig.

**Umfang.** Fixtures unter `src/testdata/legacy-datadir/` mit manifest (`createdAt`, `kaprekVersion`, Feldstände je Datei): `approvals.json` ohne `runId` und ohne `cancelled`, `policy.json` ohne `posture`/`hardDenials`, Ledger mit `start`/`stop` ohne `end`, `search.db` mit alter Schema-Version, Preset mit fehlerhaftem JSON daneben, `context/`-State-Datei älter als 7 Tage. Test: alle Öffnungs-/Migrationspfade gegen dieses Dir, Assertions auf erwartete Lesbarkeit je Feld.

**DoD.** Test läuft grün ohne dass Legacy-Felder ergänzt wurden; jedes spätere Persistenz-Paket (P1, P4) liefert sein Alt-Fixture im selben PR mit; README bekommt zwei Sätze unter „Updating" („kaprek liest Datenbestände älterer Versionen; die Fixtures dafür liegen im Repo").

**Aufwand.** S.

### P1 — Approval-Lebenslauf (ERW #2)

**Ziel/Anknüpfung.** Wie ERW #2: `runId` am Record, Status `cancelled` mit `cancelledReason ∈ {run-aborted, run-failed, trigger-deleted, mission-archived, shutdown}`, Historie-Route und -Tab.

**Zusätzlich aus dem Council.**

- **Race-Regel:** `cancelled` darf eine bereits getroffene Entscheidung nie überschreiben; gleichzeitiges `decide()` und `cancel()` auf demselben Record ist atomar (der Store ist single-threaded, die Reihenfolge im selben Tick entscheidet — Test für beide Reihenfolgen).
- **Idempotenz:** zweimal `cancel` oder `cancel` auf `decided` ist ein No-op mit `ok: true`, kein Fehler, kein zweites Ereignis.
- Rückwärtslesen: Records ohne `runId` (Legacy-Fixture P0) sind gültig, Historie zeigt „—" statt Run-Link.

**DoD.** Aufrufpfade verdrahtet (`run.mjs`-Abbruch, Relay-Stop, Trigger-Löschung, Mission-Archiv, Shutdown); `GET /api/approvals?status=all` mit Entscheidung, Entscheider-Kanal, Dauer, `runId`; zweiter Tab in `Approvals.tsx` mit Filter Mission/Trigger; Tests: Race beide Richtungen, Idempotenz, Legacy-Record, sweep berührt `cancelled` nicht vor Ablauf der Retention.

**Aufwand.** S bis M.

### P2 — Update-Verifikation (A2, eigenständig)

**Ziel.** `kaprek update` meldet Erfolg nur über die Platte hinaus ehrlich: mit der Version, die die laufende Instanz tatsächlich trägt.

**Schritte.** Erst prüfen, was die Lock-Grußantwort (`instance-lock.mjs`) liefert — pid, Port, Startzeit sind dokumentiert, eine Version ist es **nicht**. Grußantwort um `version` erweitern (abwärtskompatibel: fehlt das Feld bei einer älteren laufenden Instanz, antwortet `kaprek update` „läuft Version: unbekannt (vor <datum> gestartet)" statt zu raten). Danach der Meldungspfad aus GESAMTPLANUNG A2: Abweichung → ein Zusatzsatz; Git-Checkout → `git status --porcelain` vorher, nie nach dem Pull-Vorschlag.

**DoD.** Tests mit gefakten Grußantworten in vier Varianten (neu/alt/ohne Versionsfeld/keine Instanz); Netz-Wächter unberührt (Loopback-Lock ist der erlaubte Eintrag).

**Aufwand.** S.

### P3 — Search-Index gegen neuere Schemata (A4, eigenständig)

**Umfang.** Beim Öffnen: `schemaVersion` des Index > erwartete → Index weder öffnen noch löschen; Search meldet „wurde von einer neueren kaprek-Version geschrieben" mit Hinweis. Schreibzugriffe auf den Index sind in diesem Zustand komplett aus (kein Reindex-Button, der ihn overwrite'n würde — der Button zeigt denselben Hinweis). Symmetrischer Zweig zur bestehenden Drop-Logik, ein Test mehr in derselben Datei.

**DoD.** Test: neueres Schema → Meldung, keine Löschung, kein Crash; Legacy-Fixture (P0) deckt die alte Richtung ab.

**Aufwand.** S.

### P4 — Memory pro Mission mit Herkunft (ERW #3 + ALM 1.2, zwei Abnahmegruppen)

**(a) Mission-Ansicht.** `GET /api/missions/<id>/memory` via `visibleScopes()`, Einträge mit `scope`, `firstSeenAt`, `lastVerifiedAt`, `stale`; Memory-Karte in der Mission-Ansicht (fünf letzte, Zähler je Scope, Link nach `#/memory` mit Filter); Sortierung `lastVerifiedAt`, veraltete oben; die Karte sagt explizit, dass Projekt-Scope-Einträge auch für andere Missionen gelten — **vor** dem Forget-Knopf.

**(b) Herkunft.** Felder `sourceKind ∈ {turn, file, import, manual}`, `chatId`, `runId`, optional `path` (+Zeilenbereich) an Memory-Ereignissen; `redactSecrets()` läuft vor dem Schreiben (Pfad ja, Inhalt nie); importierte Einträge starten mit `lastVerifiedAt: null` und erscheinen als „unbestätigt"; Altbestand ohne Herkunft wird als solcher markiert, nie versteckt; `src/memory/import.mjs` schreibt die Quelle mit statt sie wie bisher zu verwerfen. In `Memory.tsx` wird Herkunft zum Link (Thread, Run, Datei).

**DoD.** (a) Route-Test gegen echte Scope-Kette (mission → project → person), Delete-Warnung sichtbar; (b) Schema-Erweiterung rückwärtslesend (P0-Fixture), Redaction-Test auf `path`-Feld, Import-Test mit `lastVerifiedAt: null`.

**Aufwand.** M.

### P5 — `kaprek doctor`, erste Fassung (A1, bewusst schmal)

**Umfang der ersten Abnahme — nur lesen, zwei sichere Fixes:**

- Checks: Transkript-Drift (Anteil `brokenLines`/unbekannter `type` je der zehn zuletzt geschriebenen Session-Dateien, Meldung ab Schwelle 1 %), Hook-Einträge gegen die Dateien verifiziert (Pfad existiert, `--managed-by`-Marker), Index-Schema (beide Richtungen, P3-Logik wiederverwendet), Presets-Validität (mit Dateiname der verworfenen), Ledger-Konsistenz (letzte Zeile je Session), verwaiste `context/`-State-Dateien.
- `--fix` nur für: verwaiste State-Dateien löschen, Index-Neubau anstoßen. Alles andere nur Meldung.
- Output: ein Abschnitt je Check, je Check ein Status `ok` / `warn` / `fail` + ein Satz; Exit 0 immer, `--json` für maschinenleses Format. Keine Grant-/Digest-Awareness (Stores existieren noch nicht).

**Bewusst nicht in dieser Fassung:** Startzeit-Migrationen, `--fix` für Hooks, Berichte über Stores, die P6/P7 erst einführen.

**DoD.** Tests je Check mit je einem ok- und einem kaputtem Fixture; `--fix` nur auf Kopie des Fixture-Dirs getestet; README-Absatz (der FAQ-Eintrag „doctor planned but not built" wird ersetzt).

**Aufwand.** M.

---

## Arbeitspakete Phase 2

### P6 — Scoped Standing Grants (ERW #1 mit Council-Amendments)

**Kern aus ERW #1 unverändert:** Store `src/policy/grants.mjs`, `<dataDir>/grants.jsonl` append-only, Projektion beim Öffnen, Widerruf als Ereignis; Prüfreihenfolge Hard Denial → Posture-Decke → Grant → Frage; `_truncated`/>1 MiB nie grantbar; jede Nutzung als `status: 'granted'` mit `grantId` im Approval-Log; UI-Knopf „immer für diese Form" plus Abschnitt „Stehende Freigaben" mit Widerruf, Trefferzähler, `lastUsedAt`.

**Council-Amendments, verbindlich:**

- **Serverseitige Ableitung:** `POST /api/grants` nimmt nur `{approvalId, match: 'exact'|'shape'}` (optional `scope`, Vorgabe aus dem Approval-Kontext). Quelle muss `status: 'decided'`, `allow`, kein `_truncated` sein; Werkzeugname, kanonisches Input, Muster und Scope kommen aus dem Record. 409 sonst.
- **Autoritäts-Fingerprint am `shape`-Grant:** `{policyVersion, missionCwd, matchPattern}`. Stimmt ein Treffer nicht → Grant ist `stale`: hebt nicht auf, Frage wird normal gestellt, Record markiert `stale-hit`; beantwortet der Nutzer wieder mit „immer für diese Form", wird der Grant mit neuem Fingerprint neu bestätigt (neues Ereignis, altes bleibt mit `supersededBy` in der Historie). `exact`-Grants ohne Fingerprint.
- **Reaktivierung nach Posture-Änderung:** erster Treffer eines unter höherer Decke gespeicherten Grants stellt einmal neu die Frage (derselbe stale-Mechanismus). Kein stiller erster Vollzug.
- **Kein Ablaufdatum.** `kaprek doctor` (P5, spätere Fassung) meldet Grants mit langer Nichtnutzung als Aufräum-Kandidat.

**DoD.** Tests: Ableitung aus decided/abgelehnt/truncated-Approval; exact-Treffer byte-gleich inkl. Key-Sortierung; shape-Treffer unter unverändertem Fingerprint; stale bei geänderter policyVersion/cwd; Reaktivierungs-Frage bei gesenkter Decke; Nutzung im Approval-Log; Widerruf als Ereignis; Legacy: leere `grants.jsonl` ist kein Fehler. `#/setup` zeigt Zahl aktiver Grants.

**Aufwand.** M.

### P7 — skip-if-Vorbedingung (ERW #4 mit Valdierungs-Vertrag)

**Kern aus ERW #4 unverändert:** optionales `condition` am Trigger (`file-exists` mit realpath-Containment via `contain.mjs`, `file-newer-than-last-run` gegen `runs.jsonl`, `command` als argv ohne Shell), Prüfung nach Claim und vor `buildPrompt()`, `skipped: 'condition'` im Run, Claim wird trotzdem gesetzt, `conditionError`-Semantik wie oben begründet.

**Valdierungs-Vertrag (Council):**

- Relative Pfade im Trigger werden gegen das Mission-cwd (bzw. `<dataDir>/workspace` ohne Mission) aufgelöst und **als absoluter Pfad gespeichert**; der Trigger-Editor zeigt die aufgelöste Form an.
- `command`: ausdrücklich eingetragener Nutzer-Wert, argv-Array, keine Env-Expansion, keine `shell`-Option, Timeout hart auf 5 s gekappt, Kill des Prozesses (kein Prozessbaum-Erschießen über ein Shell-Nest, weil es keins gibt), Ausgabe verworfen. Der Subprozess-Wächter bekommt genau einen neuen gepinnten Eintrag (Zweittest wie beim Lock).
- Die Bedingung wird beim Anlegen **einmal probeausgeführt** und das Ergebnis angezeigt — ein Trigger, der von Anfang an nie springen würde, wird nicht gespeichert, ohne dass der Nutzer es gesehen hat.
- `conditionError` wird zusätzlich in den Notify-Kopf geschrieben („Bedingung fehlgeschlagen: … — Lauf fand trotzdem statt").

**DoD.** Tests: alle drei Bedingungsarten je wahr/falsch/Fehler; Containment (Symlink aus dem Jail); Timeout-Kill; Run-Eintrag-Felder; Anlegen mit probeausführung; Legacy-Trigger ohne `condition` unverändert (P0-Fixture).

**Aufwand.** M.

### P8 — Morgen-Digest, Zahlen-Kern (ERW #7 mit Ehrlichkeitsregel)

**Umfang.** `src/missions/digest.mjs`, Zahlen-only, **ohne jede Engine-Anbindung** (der Opt-in-Schalter kommt in Phase 3 und ist hier explizit ausgeschlossen). Fenster: lokale Zeit, Vorgabe gestern 00:00–24:00, je Mission überschreibbar. Inhalt: Trigger-Ergebnisse (gelaufen/übersprungen nach P7/fehlgeschlagen), offene Fragen mit Restlaufzeit, Kosten/Tokens mit `unknown`-Kennzeichnung je Feld und Abdeckungszähler im Kopf („Kosten bekannt für 3 von 5 Läufen"), berührte Dateien. Ablage unter `<dataDir>/missions/<id>/digests/<datum>.md`; Karte in der Mission-Ansicht; optionaler Schedule-Trigger über `notify.json` (der Notify-Kopf nennt das Fenster).

**DoD.** Tests: Fenster-Grenzen über Mitternacht, `unknown` bei fehlender Kostenmeldung, Abdeckungszähler, Mission ohne Runs im Fenster (Digest erscheint leer mit 0-Zeile, nicht gar nicht), Ablage idempotent bei zweimaligem Bau am selben Tag. README-Absatz nennt ausdrücklich: „kein Modellaufruf, keine Zusammenfassung — Zahlen".

**Aufwand.** M.

---

## Reihenfolge und Übergaben

**P0 → P1 → (P2 ∥ P3) → P4 → P5**, dann **P6 → P7 → P8**. P0 blockt P1 und P4 (deren Formatänderungen ein Alt-Fixture mitbringen müssen). P6 setzt die Historie aus P1 voraus (Grant-Nutzung muss sichtbar bleiben). P7 liefert das `skipped`-Feld, das P8 im Digest liest.

Jedes Paket endet mit: grüner Testlauf, README-Absatz, Eintrag im Alt-Fixture-Manifest wenn ein Format sich änderte, und einem Merge-Commit im `u/<name>`-Zweig-Stil der Repo-Historie.
