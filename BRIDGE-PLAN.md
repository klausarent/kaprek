# Bridge-Plan: WhatsApp an kaprek + KI-CEO-Teams

Stand: 04.09.2026. Arbeitsgrundlage, keine Spezifikation. Zwei Aufträge von Klaus: (1) WhatsApp wie die instinct-Bridge an kaprek hängen, (2) autonome Agent-Teams mit KI-CEOs pro Projekt (Projektverantwortlicher, Social-Media, SEO/GEO, Outreach) — der Mensch steuert CEOs, die CEOs steuern Teams.

Die eine Architektur-Entscheidung vorab: **beides lebt NICHT in kaprek.** kapreks statischer Netz-Wächter (`src/no-network.test.mjs`) bricht den Build bei jedem Netz-Client in `src/`, und das README verspricht „kaprek ships no channels of its own on purpose". Beides ist kein Hindernis, sondern die Bauanweisung: die Bridge ist ein **eigenes, externes Prozess-Asset** wie die instinct-bridge — sie hält die Netz-Seite und spricht kapreks lokale API auf `127.0.0.1:4900` mit dem Instance-Token an. Vertrauensgrenze ist exakt die, die das README ohnehin benennt („you trust the software running under your own user account"). kaprek ändert sich dabei kaum — und genau das ist der Punkt.

---

## Teil W: WhatsApp-Bridge

### W0 — Zugangsentscheidung (Klaus, VOR allem anderen)

WhatsApp hat keine offizielle Bot-API für private Nummern. Drei Wege, mit unterschiedliche Preisen:

| Weg | Was es ist | Risiko |
| --- | --- | --- |
| **Baileys** ( liberties, WebSocket-Protokoll-Nachbau) | QR-Kopplung wie WhatsApp Web, keine Meta-Firma dazwischen | Inoffiziell; **Bann-Risiko für die Nummer** ist real, wenn das Verhalten botartig wird (Massennachrichten, schnelle Antworten um 3 Uhr) |
| **whatsapp-web.js / Puppeteer** | steuert ein echtes WhatsApp-Web im Browser | Gleiches Bann-Risiko, langsamer, aber menschenähnlicher |
| **WhatsApp Business Cloud API** (Meta, offiziell) | Webhooks + senden über Metas Graph API | Kein Bann-Risiko, aber: Business-Setup, 24-h-Fenster für Freitext (Nutzer muss zuletzt geschrieben haben — bei uns gegeben, denn Klaus schreibt zuerst), Kosten pro Conversation, Meta-Konto |

Empfehlung: **eigene Zweitnummer (eSIM/prepaid) + Baileys für den MVP**,Business API als späterer sauberer Weg. Mit einer Wegwerf-Nummer ist das Bann-Risiko kein Verlust. Die Entscheidung ist Klaus', denn es ist seine Nummer und sein Meta-Konto.

### W1 — MVP: 1:1-Chat, Aufgaben rein, Ergebnisse raus (M)

**Fluss.** Klaus schreibt „prüfe die backups, meld dich mit findings" → Bridge mappt auf eine Mission (Standard-Mission, oder `#tag` wählt die Mission) → erstellt einen Chat-Turn über kapreks API → schickt sofort „Verstanden, läuft." → bei Turn-Ende die Zusammenfassung zurück (gekürzt, redigiert — dieselben `SECRET_PATTERNS` wie kapreks Digest, die Bridge importiert sie oder kaprek liefert eine redigierte Zusammenfassung).

**Antworten auf Fragen.** kapreks Phone-Token (QR-Modus) darf heute schon die Inbox lesen und Fragen beantworten — die Bridge nutzt genau diesen engen Token für den Antwort-Weg: Eine offene Frage geht als WhatsApp-Nachricht raus („Bash: rm -rf build/ — 1) erlauben 2) ablehnen 3) immer für diese Form"), die Antwort-Ziffer mappt auf Approve/Deny/Grant. Damit ist der Freigabe-Weg von Anfang an im gleichen Eng- Korsett wie der Handy-Modus, nicht vollmächtig.

**Sicherheit.** Absender- allowlist (nur Klaus' Nummer), Tagess limits für eigenstartene Turns, Nachrichten-Kappung (keine 40-;-Seiten im Chat), kein Gruppen-Support in W1. Die Bridge läuft als Windows-Scheduled-Task/Autostart wie der instinct-Watcher.

**Baustellen an kaprek selbst (klein):** Start eines Chats mit Prompt über die API existiert (die Web-UI macht es), die Bridge braucht nichts Neues — außer vielleicht eine redigierte Turn-Zusammenfassung als API-Feld, falls die Bridge sie nicht selbst aus den Events bauen will. Abwägung im Bau.

### W2 — Komfort (S bis M, nach Bedarf)

Sprachnachrichten → Transkript (Whisper lokal oder CLI-Fähigkeit), Bilder/Dokumente rein (landen als Datei im Mission-cwd, der Prompt nennt den Pfad), Gruppen-Chat mit `@kaprek`-Addressierung ( erst dann wird das Bann-Risiko-Thema schärfer, weil Gruppen von Fremden schreibbar sind — allowlist für Gruppenmitglieder).

---

## Teil T: KI-CEO-Teams

### Was kaprek heute schon hergibt (die Überraschung: fast die Org-Tabelle)

- **Mission = Unternehmen/Projekt.** Ein Mission-cwd, ein Memory-Scope, ein Kostenort, ein Board.
- **Relay-Rezepte = Organigramm als Datei.** Wer in welcher Reihenfolge arbeitet, wo ein Mensch gefragt wird (`requiresHuman`), Budgets (`maxRounds`, `hardMaxTurns`), Eskalation bei Ausfall. Genau die CEO-mit-Team-Struktur, nur als Daten.
- **Standing Grants + Posture = Befugnisse.** Ein Social-Media-Specialist bekommt einen Grant für genau seine Operationen, kein Auto für alles; die Posture-Decke gilt pro Mission.
- **Council = Aufsichtsrat.** Zweitmeinung bei Plänen und Entscheidungen, mit sichtbarem Dissens.
- **Memory-Scope nur aufwärts** = Berechtigungspfeile: die CEO sieht das Projekt, der Specialist sieht seine Mission, niemand sieht seitwärts rein.
- **Morgen-Digest + Approvals-Historie = Reporting** des CEOs an den Menschen.

### Was fehlt (drei Lücken, ehrlich benannt)

1. **Delegation als Primitiv.** Heute sind Relais fest gechoreographiert: Die Rezept-Datei sagt die Schritte vor. Ein CEO, der mitten im Turn merkt, dass er den SEO-Specialist braucht, kann ihn nicht rufen. Zwei Wege:
   - **(a) kaprek als MCP-Server** (passt zur ohnehin geplanten MCP-Brücke): Werkzeuge `ask_specialist(role, question, budget)` und `create_task(title, mission)` — der CEO ruft sie wie jedes Werkzeug, kaprek startet den Specialist-Turn, das Ergebnis kommt als Tool-Ergebnis zurück. Kleiner Diff an kaprek, die Rollenlogik bleibt Daten.
   - (b) Dynamische Relay-Erweiterung (der CEO schreibt das Rezept um) — mächtiger, aber ein neues Zustandsmodell und genau die Tür, die ERW #10 bewusst geschlossen hält. Erst (a).
2. **Agenten-Verzeichnis.** Rollen mit Namen, System-Prompt, erlaubten Werkzeug- Grants, Engine. Heute sind „Agenten" nur Engines + Rezepte. Ein JSON-Verzeichnis unter `<dataDir>/agents/*.json`, Rezept- und MCP-Delegation referenzieren Rollen, nicht CLIs.
3. **Budget in Geld.** Sobald Teams autonom laufen, ist `maxTurns` kein Kosten-Dach. ALM 2.5 (Tagesbudget je Mission, deferred Frage bei Überschreitung) wird von „nice to have" zur **Voraussetzung** — vor T-Phasen bauen.

### Phasen

- **T1 — Agenten-Verzeichnis + kaprek-MCP** `ask_specialist`/`create_task` (M): Ein CEO-Chat kann Spezialisten rufen. Der Mensch steuert den CEO im Chat; der CEO dirigiert. Das ist der Schritt von „ein Mensch steuert KIs" zu „ein Mensch steuert CEOs".
- **T2 — Team-Schablonen** (S, nach T1): Rezept + Rollen als eine Datei je Team-Typ (Social-Media-Team, SEO-Team, Outreach-Team) unter `<dataDir>/teams/`. Ein neues Projekt = Mission anlegen, Team-Schablone wählen, CEO hat sein Team.
- **T3 — CEO-Standups** (M): ein Trigger macht morgens einen CEO-Turn („Was steht an, was hast du vor, was brauchst du von mir?"), Ergebnis in den Digest. Autonomie mit Bericht statt Autonomie im Verborgenen — Almanac-Pattern 2.1 kaprek-überetzt.
- **Nicht gebaut, bewusst:** sich selbst startende Relay-Ketten (ERW #10 bleibt zu, bis ein echter Anwendungsfall die erfasste-Autorität-Maschinerie rechtfertigt), freie Rezept- Mutation durch den CEO (b), geteilte Org-Wikis über Projekte hinweg (Scope-Regel bleibt).

### Reihenfolge über beide Teile

1. **W0** — Klaus entscheidet WhatsApp-Weg (Zweitnummer + Baileys empfohlen).
2. **ALM 2.5 kaprek-Hälfte** — Tagesbudget je Mission (Voraussetzung für alles Autonome).
3. **W1** — WhatsApp-MVP (Bridge-Repo, instinct-Stil).
4. **T1** — Agenten-Verzeichnis + kaprek-MCP-Delegation.
5. **T2/T3** — Schablonen, Standups. W2 nach Lust.

---

## 4. Übernahmen aus der instinct-Befragung (04.09.)

Klaus hat instinct sein eigenes Innenleben ausfragen lassen (Kanäle, Aufgabenliste, Wecker, Eskalationsleiter, Gedächtnis, Betrieb). Die Antworten ändern den Plan an vier Stellen — fast alles bestätigt kapreks vorhandene Muster statt neue zu brauchen:

### I1 — Task-Modell: Inhalt über Struktur, Besitzer, ehrliche Erledigung (M, kaprek-Board)

instincts Einträge: worum es geht, Quell-Referenz (die Nachricht, die den Auftrag gab), nächster Schritt, Besitzer (Klaus / instinct / Dritter wie „Ford"), Stand inklusive Sackgassen. „Mehr Inhalt als Struktur — der Wert liegt im Kontext." Dazu zwei Regeln, die kapreks Board fehlen:

- **Besitzer-Feld** mit drei Werten (du / kaprek / Dritter) — „wartet auf Ford" ist ein Zustand, der null Checks kostet, bis das Ereignis von selbst kommt (ereignisgetrieben, nicht polling).
- **Erledigt ist eine skalierte Aussage:** „erledigt (geprüft)" vs. „gemeldet als erledigt, ungeprüft". instinct prüft nach, wo es geht (URL selbst aufrufen, zweimal mit Zeitabstand), und benennt es, wo Prüfen unmöglich ist. Das ist exakt kapreks Konvergenz-Gedanke („Done is a claim"), nur als Task-Status statt Plan-Gate. Ein Task ist zu, wenn das Ergebnis **bei Klaus angekommen** ist, nicht wenn die Arbeit aufgehört hat.
- **Anlege-Regel als Policy:** listenwürdig ist alles mit offenem Ergebnis + nächstem Schritt, das verloren gehen würde; nicht listenwürdig sind sofort beantwortbare Fragen und Smalltalk; bei sensiblen Themen einmal nachfragen statt festhalten. Die Regel kommt als Text in den System-Prompt der Bridge-Deutung, nicht als Parser.

### I2 — Wecker: getrennt, aber verlinkt; Bedingung als Billig-Blick zuerst (S bis M)

Wecker leben getrennt von der Liste und verweisen auf sie; erledigte Tasks ziehen ihre Wecker nach. Doppler-Schutz: vor dem Anstellen prüfen, ob schon einer denselben Zweck hat (anpassen statt zweite stellen); jeder Wecker trägt seinen Grund, damit klar ist, wann er hinfällig ist. Für kaprek heißt das:

- Neuer Store `<dataDir>/alarms.jsonl` (Grund-Zeile, Zweck-Zeile, Bedingung, Link auf Board-Task/Mission), **nicht** ein Feld am Board-Task.
- Die Bedingung wird **zweistufig** ausgewertet: erst der billigste Check, den kaprek schon kann (skip-if: file-exists, file-newer-than-last-run), und nur wenn der nicht reicht, ein Mini-Turn einer abgespeckten Engine mit Ja/Nein-Antwort. instinct: „der Blick kostet Sekunden, teuer wird erst das Handeln." Das ist die Aussparung, die aus 50–70 Prüfungen am Tag 10–15 macht — und der Mini-Turn ist derselbe Opt-in-Mechanismus wie der Digest (ALM 3.3 Punkt 2), kein neues Netz-Loch.
- **Budget-Priorisierung** aus instinct übernehmen, wörtlich: direkte Anfragen haben immer Vorrang; wenn das Tagesbudget knapp wird, pausieren zuerst die Hintergrund-Prüfungen, nie die Interaktiven. Das gehört in ALM 2.5 (Tagesbudget) als definierte Pause-Reihenfolge, nicht als Zufall.

### I3 — Sende-Politik: Regel vor jedem Versand, nicht Zeitfenster (M)

instincts „nachts schweigen" ist keine Zeitspanne, sondern eine Regel, die jede ausgehende Nachricht passiert: gewichtet Uhrzeit, Thema und ob Klaus wach ist; schreibt Klaus um 1 Uhr, wird geantwortet — nur Ungefragtes bleibt liegen; echter Notfall (Sicherheit, Geldverlust, harte Frist) geht auch nachts durch. Dazu die Eskalationsleiter mit vier Stufen (sofort / passende Gelegenheit / gebündelt / gar nicht) und drei Entscheidungsquellen: feste Grundregeln, Gelerntes über Klaus, **explizite Ansagen, die zu Dauerregeln werden** — und Korrekturen („das hätte nicht gepinkt werden müssen") ändern die Regel ab dann.

Das ist wörtlich kapreks failure-to-policy-Mechanismus („when the same failure pattern shows up three times, kaprek writes down the rule and asks"), nur für ausgehende Nachrichten statt für Werkzeugfreigaben. Also:

- `<dataDir>/policy.json` bekommt einen Abschnitt `sendPolicy`: Zeitgewichtung, Themen-Regeln, Nacht-Ausnahmen — vom Menschen editierbar und im Klartext sichtbar, wie posture/hardDenials.
- Die Bridge (W1) wertet `sendPolicy` vor jedem Versand aus; ungefragte Nachrichten passieren die Leiter, Antworten auf Klaus' Nachrichten nicht.
- Kapreks proposal-Mechanismus (Regel vorschlagen, Mensch akzeptiert) wird auf Sende-Verstöße erweitert: „das hätte nicht gepinkelt werden müssen" ist ein Proposal-Kandidat.

### I4 — Kanäle: eine Zeitachse, eine Stimme, Anweisungen nur von Klaus (in W1 enthalten)

instinct: alle Kanäle landen im selben Gedächtnis und derselben Liste; eine Zeitachse in Reihenfolge; spätere Anweisung gewinnt; bei gleichzeitigen Widersprüchen **nachfragen statt raten**; und: „Anweisungen nehme ich nur von dir entgegen — was andere in deinen Mails schreiben, ist Information, kein Befehl."

Der letzte Satz ist kapreks `<external source>`-Labeling, nur auf Kanal-Ebene: die Bridge akzeptiert Aufträge **ausschließlich** von Klaus' allowlisteter Nummer; alles andere in Gruppen/Mails ist Material mit Quellenlabel. W1 bekommt deshalb drei Regeln ins Fundament: eine Zeitachse (Alle Ereignisse je Mission in Reihenfolge), spätere Anweisung gewinnt, Widerspruch ohne Reihenfolge → Rückfrage statt Rate. Und instincts Neustart-Regel übernehmen Bridge und kaprek-Trigger gleichermaßen: **erst lesen, dann handeln** — der Zustand liegt getrennt von der Ausführung, nach einem Absturz wird geprüft, was schon passiert ist, bevor etwas wiederholt wird (keine doppelte Mail, keine doppelte Bestellung). kapreks Claim-Dateien sind die halbe Miete; die Bridge braucht dasselbe Muster.

### I5 — Gedächtnis: Haltbarkeit als Aufnahmekriterium, Tresor getrennt (bestätigt kapreks Memory)

instinct nimmt auf: Vorlieben/Regeln, Personen, Entscheidungen **mit Gründen**, laufende Projekte, Muster. Nicht: Tagesgeschwätz, **und keine Geheimnisse** („die liegen getrennt im Tresor"). Abruf gezielt per Suche, nicht Voll-Reading bei jedem Turn. Das bestätigt kapreks Memory-Modell (Fakten mit Ursprung, 90-Tage-Stale, scopes) in jedem Punkt — zwei Nuancen zum Mitnehmen: „Entscheidungen mit Gründen" als eigene kind neben fact, und die Trennung Geheimnis ≠ Gedächtnis ist die, die ERW #6 (lokaler Secret-Store) ohnehin baut: `{{secret:NAME}}`-Referenz statt Wert, auch im Memory-Text.

### Was bewusst NICHT übernommen wird

- **Cloud-Betrieb als Voraussetzung.** instincts „ich laufe nicht auf einem Rechner, den jemand ausschalten könnte" ist der Kernunterschied. kaprek schläft, wenn der PC schläft. Solange das so bleibt, ist WhatsApp-Bridge eine „der PC ist an"-Erfahrung; always-on wird erst mit ALM 2.6 (Cloud-Runner für cloud-fähige Aufträge) diskutabel — und die Trennungsaufgabe (keine lokalen Pfade, keine lokalen Secrets in die Cloud) bleibt dort die harte Grenze.
- **Bestellen/Buchen ohne Menschenknopf.** GPT-6-Computer-Use macht Browser-Autonomie technisch machbar; kapreks Verfassung sagt „nichts, was Geld ausgibt, ohne dass ein Mensch den Knopf drückt" (ALMANAC-PLAN §4). Wenn das geändert werden soll, ist es eine Verfassungsänderung mit kaprek-Mitteln: Standing Grants **mit Ausgaben-Deckel** („diese Operation, bis 50 €/Monat, widerrufbar") wären der kaprek-Weg — kein Nachtdienst-Einkauf ohne Mechanismus. Entscheidung bei Klaus, nicht am Weg.

### Angepasste Reihenfolge

1. **W0 erledigt** — Klaus wählt die offizielle WhatsApp Business Platform (Business-Nummer, kein Bann-Risiko; die 24-h-Regel: außerhalb des Fensters nur Meta-genehmigte Standard-Nachrichten — für unsere Antworten unkritisch, weil Klaus zuerst schreibt).
2. **ALM 2.5 + I2-Pause-Reihenfolge** — Tagesbudget mit definierter Priorität (Interaktiv vor Hintergrund).
3. **W1** — WhatsApp-MVP über Business Cloud API, mit I3-Sende-Politik und I4-Zeitachse von Anfang an.
4. **I1** — Board um Besitzer/Erledigt-skaliert/Anlege-Regel erweitern.
5. **T1** — Agenten-Verzeichnis + MCP-Delegation (KI-CEO-Rufe).
6. **I2/I3 vertiefen** — Alarm-Store, Mini-Turn-Bedingungen, Sende-Politik als Policy-Abschnitt.
7. **T2/T3, W2** — Schablonen, Standups, Sprachnachrichten/Bilder/Gruppen.

### Die ehrliche Risikoseite

- **Bann-Risiko** der WhatsApp-Nummer — durch W0-Entscheidung (offizielle Business Platform) entschärft; Restrisiko liegt im Meta-Setup (Verifizierung, Kosten pro Conversation), nicht im Bann.
- **Kosten-Schärfe:** ein CEO mit drei Specialists verbrannt Budget schnell; ohne Geld-Budget (ALM 2.5 + I2-Pause-Reihenfolge) keine Autonomie-Stufen. instincts Praxis als Zielbild: direkte Anfragen immer vor Hintergrund-Checks, erst die billigen Blicke, dann das Handeln.
- **Kontrollverlust-Style:** kapreks Versprechen ist „fragt vorher". Teams ändern das nicht: Der CEO fragt, die Specialists laufen unter seinen Grants, der Mensch sitzt an denselben drei Stellschrauben wie heute (Posture, Grants, Inbox). Wenn das aufge weicht wird, ist es eine bewusste Entscheidung, kein Nebenprodukt.
- **Verfassungsfrage Ausgaben-Autonomie:** Computer-Use kann bestellen und buchen; kapreks Verfassung sagt bislang: kein Geld ohne Menschenknopf. Bleibt sie dabei, läuft Browser-Autonomie als Vorbereitung (Warenkorb steht, Mensch drückt ab). Soll sie fallen, dann nur mit Ausgaben-Grants (Deckel, widerrufbar, im Receipt). Beides ist legitim — stillschweigend passieren darf es nicht.
