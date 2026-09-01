# Design-Spec kaprek — Phase 1 und 2

Stand: 01.09.2026, **Revision 2**. Revision 1 lief nach einem vollständigen Peer-Rundlauf (Codex, Grok per Direktlauf nachgeholt, Opus blind mit Code-Zugriff). Opus' Code-Befunde schlagen mehrere Annahmen von Revision 1; wo sich die Peers widersprechen, ist hier die Entscheidung benannt. Die Konsolidierung folgt im Zweifel dem, wer den Code gelesen hat.

**Gegen Revision 1 geändert:**

1. **Spec-Punkt 8 gekippt: `conditionError` ist fail-closed und laut.** R1 begründete fail-open mit „ein Trigger darf nicht still verschwinden". Opus' Einwand trifft den Kern: still *geschlossen* und *laut* geht gleichzeitig — `skipped: 'condition-error'` + Run-Eintrag + Notify + Zähler am Trigger (nach 5 Fehlern in Folge meldet der Trigger selbst `degraded`) + doctor-Check erfüllen das Gegenargument, ohne den Lauf zu starten, den die Bedingung verhindern sollte. Zusatz: ein kaputter 5-Minuten-Trigger verbrennt unter fail-open dauerhaft Tokens gegen ERW #4s eigenes Kostenargument. Fail-open nur hinter einem ausdrücklichen Per-Trigger-Flag (`onConditionError: 'run' | 'skip'`, Vorgabe `skip`), das beim Anlegen mit Probeausführung bestätigt wird.
2. **Fingerprint schmal statt breit** (Dissens Codex/Grok gegen Opus — gefolgt wird Opus): `{posture, hardDenialsHash, missionId, derivationVersion}`. Der Gesamtpolicy-Hash von Codex/Grok staled über `policyVersion`, das auch `mode` und `rules.requireTaskDoc` hasht — ein irrelevanter Regel-Edit staled sämtliche shape-Grants, die Massen-Rückfrage erzieht zum Durchklicken und wertet die Frage ab.
3. **P0.5 neu** (fail-closed Policy-Loader + Schema-Querschnitt) — ohne ihn stehen P6 und P7 auf Sand: `loadPolicyFailOpen` fällt heute bei jedem unbekannten Feld auf `DEFAULT_POLICY` zurück, also `posture: 'auto'`, `hardDenials: []` — ein Feld einer neueren kaprek-Version hebt still Decke und Hard Denials auf. Unlesbare/unbekannte Policy lädt künftig zu `posture: 'ask'`, nie zu `auto`.
4. **`command`-Bedingung aus der ersten P7-Fassung gestrichen** (Groks radikale Variante): Probeausführung beim Anlegen macht Speichern zur Exec-Oberfläche, Kill ohne Job Object/Prozessgruppe lässt Kindprozesse laufen, geerbte Env/PATH ist ungeprüfte Autorität. `file-exists` und `file-newer-than-last-run` reichen für den Nutzen; `command` kommt später als eigenes Paket mit Job-Object-Semantik zurück, wenn es einen Anwendungsfall gibt, den die beiden Datei-Bedingungen nicht decken.
5. **Grants werden nur aus der gerade beantworteten Frage gemintet** (Nonce, ownedIds) — nicht aus der 7-Tage-Historie. K1/K2/K3 aus Opus' Code-Lektüre sind in P6a eingearbeitet (inputHash, postureAtGrant).
6. **A2-Basis korrigiert:** die Lock-Grußantwort ist `{kaprek, dataDirHash, pid, url}` — weder Version noch Startzeit. P2 erweitert die Grußantwort um `version` und `startedAt`; der Fallback-Satz „vor \<Datum\> gestartet" aus R1 hatte keine Datenquelle.
7. **DoD-Korrekturen aus Opus H4/H5:** `cancelledAt`-Feld (Retention rechnet über `finishedAt()` ab `requestedAt` — ohne eigenes Feld ist die DoD „sweep berührt cancelled nicht vor Ablauf" nicht erfüllbar); P0-Fixtures werden pro Test in ein tmpdir kopiert und das Original auf Byte-Gleichheit geprüft, plus `.gitattributes` (`legacy-datadir/** -text`, `*.db binary`), sonst normalisiert `* text=auto` die `search.db` kaputt.
8. **Reihenfolge parallelisiert, P6/P4 gesplittet** (siehe unten).

**Wo die Peers danebenlagen, im Code geprüft:** „HTTP-API ohne Auth/CSRF/Origin" (Codex und Grok, hoch-konfident) ist falsch — Instance-Token (`src/server/token.mjs`), Host-Allowlist gegen DNS-Rebinding, `x-app-request`-CSRF-Header, eingeschränkter Phone-Token existieren längst; die Peers sahen nur die Spec. Übrig bleibt daraus nur die Autorisierungshälfte für `/api/grants` (Punkt 5). „Kein Store hat Versionen" gilt nur für approvals/Trigger/Memory — `policy.mjs` wirft bei falscher `version`, der Fail-open-Loader fängt den Wurf aber (→ P0.5).

Nicht Bestandteil dieser Spec: Phase 3/4, GUI, Harness. Für Subagenten gilt: **der README-Absatz zum Feature gehört zum Paket**; Konventionen wie in R1 (Vitest, append-only oder schema-versioniert, keine neuen Laufzeit-Abhängigkeiten, Wächter ohne neue Einträge außer wo genannt).

---

## Arbeitspakete

### P0 — Upgrade-Fixtures (unverändert aus R1, mit H5-Korrektur)

Fixtures unter `src/testdata/legacy-datadir/` mit Manifest: `approvals.json` ohne `runId`/`cancelled`, `policy.json` ohne `posture`/`hardDenials`, Ledger ohne `end`, `search.db` alter Schema-Version, kaputtes Preset, verwaiste `context/`-Datei. **H5:** jeder Test kopiert das Fixture in ein tmpdir (`fs.cp`) und prüft danach das Original auf Byte-Gleichheit — `loadFromDisk()` schreibt beim Öffnen zurück, der Index dropt Tabellen beim Anfassen. `.gitattributes`: `legacy-datadir/** -text`, `*.db binary`.

**DoD.** Grün ohne Ergänzung Legacy-Felder; Persistenz-Pakete (P1, P4b) bringen ihr Alt-Fixture im selben PR; README: zwei Sätze unter „Updating"; `.gitattributes` eingetragen.

**Aufwand.** S.

### P0.5 — Fail-closed Policy-Loader + Schema-Querschnitt (NEU)

**Ziel.** Die Autoritätsbasis für P6/P7 darf bei Unbekanntem nicht auf `auto` fallen, und kein RMW-JSON-Store darf von einer neueren Binary still degradiert werden.

**Umfang.**

- `src/policy/policy.mjs`: Load-Pfad zweistufen — strukturell lesbar mit bekannter `version` → normal; unbekanntes Feld oder unbekannte Version → Policy lädt zu `posture: 'ask'` mit sämtlichen erkannten Hard Denials aus dem Feldbestand, wo erkennbar, sonst ohne; Meldung an `policy.log` und doctor-fähiger Status. Ein Wurf bei falscher `version` bleibt bestehen, wird aber nicht mehr vom Fail-open-Loader verschluckt.
- Querschnittsregel „neueres Schema → read-only": jedes RMW-JSON (`approvals.json`, Trigger-Registry, Memory-Events, `grants.jsonl` ab P6) bekommt ein `schemaVersion`-Feld — `approvals.json` schreibt `version: 1` heute bereits und liest es nie (`approval-store.mjs`), die Infrastruktur ist halb da und wird fertig gebaut. Höhere Version beim Lesen → Store öffnet read-only, Schreibpfade melden „wurde von einer neueren kaprek-Version geschrieben", Daten werden nie gelöscht oder überschrieben.
- Downgrade-Fixture im P0-Dir (eine Datei mit `schemaVersion: 99`).

**DoD.** Tests: unbekanntes Policy-Feld → `ask`, nie `auto`; falsche Version → Wurf sichtbar; newer-schema Store → read-only + Meldung + kein Schreiben; Original-Fixture byte-gleich (P0-Mechanik).

**Aufwand.** M.

### P1 — Approval-Lebenslauf (ERW #2, mit H4/M6)

Kern wie R1: `runId`, Status `cancelled` mit Gründen, Aufrufpfade, Historie-Route und -Tab.

- **H4:** eigenes `cancelledAt`-Feld; die Retention-Sweep-Logik rechnet für `cancelled` ab `cancelledAt`, nicht über `finishedAt()`.
- **M6 (cancel vs. sweepLapsed-Race):** der Sweep läuft am Kopf jeder Store-Operation — ein `cancel` nach Deadline trifft bereits `lapsed`. Antwortform ist darum `{ok: false, already: '<status>'}` statt R1s bliehem `ok: true` (das verschwieg, dass nichts cancelled wurde). `decide` auf `cancelled`/`lapsed` → 409 mit `already`.
- **Kaskade ohne Breitensuche:** Mission-Archivierung und Shutdown canceln über die explizite ID-Liste der offenen Pendenzen des Stores, nicht über eine Suche durch alle Chats.
- Race-Regel und Idempotenz wie R1 (atomar im selben Tick, Test für beide Reihenfolgen).

**DoD.** wie R1, zusätzlich: cancel-nach-lapsed antwortet `already: 'lapsed'`; `cancelledAt` vor Ablauf der Retention vorhanden; Kaskaden-Test über ID-Liste; Legacy ohne `runId`/`cancelledAt`.

**Aufwand.** M.

### P2 — Update-Verifikation (A2, korrigierte Annahme)

`instance-lock.mjs`-Grußantwort um `version` und `startedAt` erweitern (abwärtskompatibel: fehlen die Felder bei einer älteren laufenden Instanz → „läuft Version: unbekannt (älter als diese Meldungs-Logik)"). Danach wie R1: Abweichung → Zusatzsatz, Git-Checkout → `git status --porcelain` vor der Meldung. Vier Testvarianten mit gefakten Grußantworten; `instance.lock` bleibt display-only.

**Aufwand.** S.

### P3 — Search-Index gegen neuere Schemata (A4)

Wie R1, jetzt als Anwendungsfall der P0.5-Querschnittsregel: `schemaVersion` höher als erwartet → weder öffnen noch löschen, Meldung mit Hinweis, Reindex-Button zeigt denselben Hinweis statt zu overwrite'n. Ein Test in derselben Datei wie die Drop-Logik.

**Aufwand.** S.

### P4a — Mission-Memory-Ansicht (ERW #3, Abnahmegruppe a)

`GET /api/missions/<id>/memory` via `visibleScopes()`; Memory-Karte (fünf letzte, Zähler je Scope, Link mit Filter); Sortierung `lastVerifiedAt`, veraltete oben; Delete-Warnung über Projekt-Scope-Reichweite **vor** dem Knopf. **DoD:** Scope-Ketten-Test, Warnung sichtbar.

**Aufwand.** S bis M.

### P4b — Memory-Herkunft (ALM 1.2, Abnahmegruppe b)

Felder `sourceKind/chatId/runId/path(+Zeilen)`; `redactSecrets()` vor dem Schreiben; Import startet mit `lastVerifiedAt: null` = „unbestätigt"; Altbestand markiert, nie versteckt; `import.mjs` schreibt die Quelle statt sie zu verwerfen; Herkunft als Link in `Memory.tsx`. **DoD:** rückwärtslesend (P0-Fixture), Redaction-Test auf `path`, Import-Test.

**Aufwand.** M.

### P6a — Grants: Store, exact, Nonce-Ableitung (ERW #1, Hälfte a)

**Store.** `src/policy/grants.mjs`, `<dataDir>/grants.jsonl` append-only, Projektion beim Öffnen, Widerruf als Ereignis, `schemaVersion` nach P0.5. Beschädigte letzte Zeile → `setCorruptFileAside`-Muster wie im approval-store (M4), nie still wegwerfen. **H2:** jede Grant-Nutzung ist ein `use`-Ereignis in `grants.jsonl` — die Sichtbarkeit überlebt nicht vom Approval-Log abhängig, das nach 7 Tagen/500 Einträgen pruned. `#/setup` zeigt aktive Grants, `#/approvals` den Abschnitt „Stehende Freigaben" (Widerruf, Trefferzähler, `lastUsedAt`).

**Ableitung (K1–K3, verbindlich).**

- **Nur aus der gerade beantworteten Frage:** `decide()` erzeugt bei „immer für diese Form" eine einmal konsumierbare Intent-Nonce im Approval-Record; `POST /api/grants` nimmt `{approvalId, nonce, match: 'exact'}` (scope-los — Scope kommt als Schnittmenge serverseitig: ein Mission-Chat kann maximal einen Mission-Grant minten, nie einen breiteren). Quelle muss dieselbe Instanz gestellt haben (`ownedIds`) und gerade entschieden worden sein; die 7-Tage-Historie minted nichts. Replay einer Nonce → 409.
- **K1 — Redaction-Kollision:** Approval-Records tragen redigiertes Input (`redactInputObject`); ein Match gegen den Record würde entweder nie treffen oder Key A für Key B freigeben. Darum schreibt `decide()` vor der Redaction `inputHash = sha256(salt ‖ canonical(rawInput))` in den Grant; das Matchen vergleicht den Hash des einkommenden rohen Inputs. Klartext bleibt von der Platte weg.
- **K2 — Autoritätsbindung auch für exact:** `postureAtGrant` und `hardDenialsHash` am Grant. Verschärfung der Decke oder der Denials **invalidiert** (stale: hebt nicht auf, Frage wird einmal neu gestellt, dann neu bestätigt oder verworfen). Eine Verschärfung unter `auto` wirksam zu machen ist unsichtbar — dort wird ohnehin nicht gefragt; der Grant schläft, bis eine fragende Posture zurückkehrt, und sein erster Treffer dort ist die Reaktivierungsfrage (Grok-Lücke: unter `auto` gibt es keinen stillen Vollzug, weil Grants nur Fragen *ersetzen* und unter `auto` keine gestellt wird).
- **Kein Ablaufdatum.** Doctor (P5) meldet lange ungenutzte Grants als Aufräum-Kandidat.

**DoD.** Tests: Nonce-Einmaligkeit und Replay; Mint aus fremdem/alt-decided/truncated Approval → 409; inputHash-Match bei secret-haltigem Input (Key A ja, Key B nein); posture/hardDenials-Verschärfung → stale + Neufrage; Reaktivierung nach Lockerung; `use`-Ereignis in grants.jsonl überlebt Approval-Log-Prune; korrupte Zeile → beiseitegelegt; leere Datei kein Fehler.

**Aufwand.** M.

### P6b — Grants: shape + Fingerprint (Hälfte b)

Wie R1 (Zweistufen-Match, gerenderter Muster-Satz im Anlege-Dialog), mit den Amendment-Korrekturen:

- Fingerprint `{posture, hardDenialsHash, missionId, derivationVersion}` — Bestandteile und Begründung siehe Änderung 2 oben.
- **H1:** `derivationVersion` an die Ableitungsregel gebunden; die Ableitung (Werte → Muster: Pfad-Präfix unter Mission-cwd, Kommando-Kopf) ist eigener Spec-Abschnitt mit Versionsnummer. Eine geänderte Ableitung staled Alt-Grants über `derivationVersion`, nicht über Policy-Noise.
- **Dialog-Pflicht:** vor dem Speichern zeigt der Dialog den gerenderten Satz „würde auch erlauben: …" mit zwei bis drei konkreten Beispiel-Inputs, die das Muster träfe und nicht träfe. Ein shape-Grant ohne gezeigte Beispiele ist nicht speicherbar.
- Fingerprint-Abweichung beim Treffer → `stale-hit`, Neufrage, Neu- oder Verwerfen (Mechanik aus P6a).

**DoD.** Tests: shape-Treffer unter unverändertem Fingerprint; stale bei jedem der vier Fingerprint-Bestandteile einzeln; Beispiele-Rendering; Ableitungs-Versionsbump staled; `exact` bleibt von `derivationVersion` unberührt.

**Aufwand.** M.

### P5 — `kaprek doctor`, erste Fassung (A1, schmal)

Wie R1, an das verschobene Ende gerückt und deshalb erweitert um: Grants (Zahl aktiv, lange ungenutzt als Aufräum-Kandidat), Policy-Loader-Status aus P0.5 (`warn` bei Fail-closed-Fallback), Trigger-`degraded`-Zähler aus P7. `--fix` bleibt auf verwaiste State-Dateien und Index-Neubau begrenzt. Status `ok`/`warn`/`fail` je Check, Exit 0, `--json`. README-FAQ-Eintrag „doctor planned but not built" wird ersetzt.

**Aufwand.** M.

### P7 — skip-if-Vorbedingung (ERW #4, gekürzt + fail-closed)

- Zwei Bedingungsarten: `file-exists` (realpath-Containment via `contain.mjs`) und `file-newer-than-last-run` (gegen `startedAt` des letzten Runs aus `runs.jsonl`). **`command` gestrichen** (Änderung 4 oben) — Begründung in den README-Absatz, damit die Lücke benannt bleibt statt unauffindbar.
- Relative Pfade werden gegen Mission-cwd (sonst `<dataDir>/workspace`) aufgelöst und absolut gespeichert; Editor zeigt die aufgelöste Form.
- **Fail-closed, laut:** Bedingung falsch → `skipped: 'condition'` (kein Turn, keine Kosten); Prüfungsfehler (Pfad nicht erreichbar, Containment-Verletzung) → `skipped: 'condition-error'` + Run-Eintrag + Notify-Kopf nennt es + Fehlerzähler am Trigger; 5 in Folge → Trigger meldet `degraded` (sichtbar in der Trigger-Liste und im doctor). `onConditionError: 'run' | 'skip'` als Per-Trigger-Ausnahme, Vorgabe `skip`, beim Anlegen mit Probeausführung bestätigt.
- Claim wird in beiden Skip-Fällen gesetzt (kein Re-Check im selben Slot); Probeausführung beim Anlegen zeigt wahr/falsch, bevor gespeichert wird.
- Legacy-Trigger ohne `condition` unverändert (P0-Fixture).

**DoD.** Tests: beide Arten je wahr/falsch/Fehler; Symlink aus dem Jail; Run-Felder; degraded nach 5; Claim gesetzt; `onConditionError: 'run'`-Zweig; Legacy.

**Aufwand.** M.

### P8 — Morgen-Digest, Zahlen-Kern (ERW #7, final)

Wie R1, ohne jede Engine-Anbindung (Opt-in-Schalter bleibt Phase 3), plus:

- **Fensterdefinition DST-fest:** das Fenster ist das Intervall `[lokaler Tagesbeginn, lokaler Tagesbeginn des Folgetags)` als echte Zeitpunkte — an DST-Tagen sind das 23 bzw. 25 Stunden, und der Digest-Kopf schreibt die tatsächliche Spanne dazu („26.10., 23 h"). Kein „00:00–24:00 = 24 h"-Satz.
- **Idempotenz definiert:** zweimaliger Bau am selben Tag überschreibt dieselbe Datei (`digests/<datum>.md`), keine Revisionen — der Digest ist ein Bericht, kein Store; wer Historie will, hat `runs.jsonl`.
- Ehrlichkeitsregel wie R1: `unknown` je Feld, Abdeckungszähler im Kopf, leere Mission → Digest mit 0-Zeile, nicht Abwesenheit.

**Aufwand.** M.

---

## Reihenfolge

```
P0 → P0.5 → { P1 ∥ P2 ∥ P3 ∥ P6a } → { P4a ∥ P4b ∥ P6b ∥ P7 } → P5 → P8
```

- P0 blockt alles (Fixture-Mechanik, byte-gleich-Prüfung, `.gitattributes`).
- P0.5 blockt P6a/P6b und P7 (Autoritätsbasis, schemaVersion-Regel) — der wichtigste Zusatz dieser Revision: ohne ihn stehen Grants und Trigger-Verhalten auf einem Loader, der bei Unbekanntem zu `auto` fällt.
- P6a braucht P1s `decide()`-Einhängpunkt (Nonce) und ist absichtlich vor P6b: exact-only mit inputHash bringt den Großteil des Nutzens bei minimalem Ableitungsrisiko.
- P5 zum Schluss, weil seine Checks erst mit P6/P7 vollständig sind.
- Jedes Paket endet mit: grüner Testlauf, README-Absatz, Alt-Fixture-Eintrag bei Formatänderung, Merge-Commit im `u/<name>`-Stil.
