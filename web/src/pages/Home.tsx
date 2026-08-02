// #/home — four things you might want, and three questions each.
//
// Klaus' rule, and everything here follows from it: at most three questions,
// then a result you can point at, and nothing on screen that only means
// something to someone who already knows how this works. No engine picker,
// no permission mode, no token count, no mention of a model.
//
// The screen after the questions is the ordinary chat, because there is only
// one machine here. What this page changes is what was asked and what the
// mission was told to finish with.
import { useEffect, useState } from "react";
import { fetchHomeMissions, startHomeMission, type HomeMission } from "../lib/api";
import { navigateToMissionChat } from "../App";

/** How far through the questions someone is, as a sentence rather than a bar. */
export function progressLine(step: number, total: number): string {
  if (step >= total) return "That is everything — ready when you are.";
  return `Question ${step + 1} of ${total}`;
}

/** Whether this question has been answered well enough to move on. */
export function isAnswered(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

export function MissionCard({ mission, onPick }: { mission: HomeMission; onPick: () => void }) {
  return (
    <button type="button" className="home-card" onClick={onPick}>
      <span className="home-card-title">{mission.title}</span>
      <span className="home-card-blurb">{mission.blurb}</span>
    </button>
  );
}

export function QuestionCard({
  question,
  value,
  onChange,
}: {
  question: HomeMission["questions"][number];
  value: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <div className="home-question">
      <h3>{question.question}</h3>
      {question.options.length > 0 && (
        <div className="home-options">
          {question.options.map((option) => (
            <button type="button" key={option} className={value === option ? "home-option home-option-picked" : "home-option"} onClick={() => onChange(option)}>
              {option}
            </button>
          ))}
        </div>
      )}
      {(question.freeText || question.options.length === 0) && (
        <input className="search-input" type="text" value={value ?? ""} placeholder="Type your answer" onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

export default function Home() {
  const [missions, setMissions] = useState<HomeMission[]>([]);
  const [picked, setPicked] = useState<HomeMission | null>(null);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    fetchHomeMissions()
      .then(setMissions)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) return <div className="error-box">{error}</div>;

  if (!picked) {
    return (
      <div className="home-page">
        <h2>What would you like to make?</h2>
        <div className="home-cards">
          {missions.map((mission) => (
            <MissionCard
              key={mission.id}
              mission={mission}
              onPick={() => {
                setPicked(mission);
                setStep(0);
                setAnswers({});
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  const question = picked.questions[step];
  const answered = isAnswered(answers[question?.id ?? ""]);

  return (
    <div className="home-page">
      <h2>{picked.title}</h2>
      <p className="muted">{progressLine(step, picked.questions.length)}</p>

      {question && <QuestionCard question={question} value={answers[question.id]} onChange={(value) => setAnswers((prev) => ({ ...prev, [question.id]: value }))} />}

      {!question && (
        <div className="home-question">
          <h3>Where should it go?</h3>
          <input className="search-input" type="text" value={folder} placeholder="A folder on this computer" onChange={(e) => setFolder(e.target.value)} />
          <p className="muted">{picked.done}</p>
        </div>
      )}

      <div className="home-actions">
        <button type="button" className="link-button" onClick={() => (step === 0 ? setPicked(null) : setStep(step - 1))}>
          Back
        </button>
        {question ? (
          <button type="button" className="btn" disabled={!answered} onClick={() => setStep(step + 1)}>
            Next
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={starting || folder.trim() === ""}
            onClick={() => {
              setStarting(true);
              startHomeMission(picked.id, folder.trim(), answers)
                .then((started) => {
                  // The prompt is parked the same way a preset's is, and the
                  // ordinary chat picks it up — one machine, one path.
                  try {
                    window.sessionStorage.setItem(`kaprek-first-prompt-${started.mission.id}`, started.firstPrompt);
                  } catch {
                    // Storage blocked: the chat opens empty and the person types.
                  }
                  navigateToMissionChat(started.mission.id);
                })
                .catch((err) => {
                  setError(err instanceof Error ? err.message : String(err));
                  setStarting(false);
                });
            }}
          >
            {starting ? "Starting…" : "Make it"}
          </button>
        )}
      </div>
    </div>
  );
}
