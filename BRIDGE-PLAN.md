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

### Die ehrliche Risikoseite

- **Bann-Risiko** der WhatsApp-Nummer (W0-Wahl).
- **Kosten-Schärfe:** ein CEO mit drei Specialists verbranntBudget schnell; ohne Geld-Budget (Punkt 2) keine Autonomie-Stufen.
- **Kontrollverlust-Style:** kapreks Versprechen ist „fragt vorher". Teams ändern das nicht: Der CEO fragt, die Specialists laufen unter seinen Grants, der Mensch sitzt an denselben drei Stellschrauben wie heute (Posture, Grants, Inbox). Wenn das aufge weicht wird, ist es eine bewusste Entscheidung, kein Nebenprodukt.
