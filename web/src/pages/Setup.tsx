// #/setup — what kaprek can see on this machine.
//
// The page that should have existed on day one. kaprek drives CLIs the user
// already has, which means the first question anyone has is "does it know
// about mine?" — and until now the only way to find out was to start a turn
// and read the error.
//
// Everything here is a path or a name. No value from any credentials file,
// .env, or MCP config reaches this page, by construction on the server side
// (src/scan/environment.mjs). It is written to be safe in a screenshot.
import { useEffect, useState } from "react";
import { fetchEnvironment, fetchUsage, type UsageEntry, saveCouncil, type EnvironmentReport } from "../lib/api";

/** How one CLI's state reads. Three states, not two: installed and signed in are different problems. */
export function cliStatusLabel(cli: { installed: boolean; signedIn: boolean }): string {
  if (!cli.installed) return "not installed";
  return cli.signedIn ? "ready" : "installed, not signed in";
}

export function CliRow({ cli }: { cli: EnvironmentReport["environment"]["clis"][number] }) {
  return (
    <div className={cli.installed ? "setup-cli" : "setup-cli setup-cli-missing"}>
      <div className="setup-cli-head">
        <span className="badge">{cli.label}</span>
        <span className={cli.signedIn ? "badge badge-ok" : "badge badge-muted"}>{cliStatusLabel(cli)}</span>
      </div>
      {cli.commandPath && <code className="setup-path">{cli.commandPath}</code>}
      {cli.configDirs.map((dir) => (
        <code className="setup-path setup-path-muted" key={dir}>
          {dir}
        </code>
      ))}
      {cli.mcpServers.length > 0 && <div className="setup-note">MCP servers configured: {cli.mcpServers.join(", ")}</div>}
    </div>
  );
}

/**
 * One line per harness on where its subscription window stands — as of the
 * last turn that reported it, which is said, because kaprek does not poll
 * anyone. "62 % used · resets 14:30 (five_hour) · as of 12:01".
 */
export function usageLine(entry: UsageEntry, now: number = Date.now()): string {
  const { summary } = entry;
  const parts: string[] = [];
  if (summary.usedPercent !== null) parts.push(`${summary.usedPercent} % used`);
  if (summary.status && summary.status !== "allowed") parts.push(summary.status.replace(/_/g, " "));
  if (summary.resetsAt) {
    const at = new Date(summary.resetsAt);
    const past = at.getTime() <= now;
    const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    parts.push(`${past ? "reset at" : "resets"} ${clock}${summary.window ? ` (${summary.window})` : ""}`);
  } else if (summary.window) parts.push(`window ${summary.window}`);
  if (summary.plan) parts.push(`plan ${summary.plan}`);
  if (parts.length === 0) parts.push("a signal without a shape kaprek knows — raw data below");
  const seen = entry.seenAt ? ` · as of ${new Date(entry.seenAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  return `${parts.join(" · ")}${seen}`;
}

export default function Setup() {
  const [report, setReport] = useState<EnvironmentReport | null>(null);
  const [usage, setUsage] = useState<UsageEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchEnvironment()
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    // Best-effort: a usage list that cannot be read is an empty section, not a broken page.
    fetchUsage()
      .then(setUsage)
      .catch(() => setUsage([]));
  }, []);

  if (error) return <div className="error-box">{error}</div>;
  if (!report) return <div className="muted">Looking at this machine…</div>;

  const { environment, nextSteps, suggestedCouncil } = report;
  const canCouncil = (suggestedCouncil.peer ?? []).length > 0;

  return (
    <div className="setup-page">
      <h2>What kaprek can see here</h2>
      <p className="muted">
        Paths and names only — no key, token, or credential value is read or shown, so this page is safe to screenshot.
      </p>

      {nextSteps.length > 0 && (
        <div className="setup-steps">
          {nextSteps.map((step) => (
            <div className="setup-step" key={step.id}>
              {step.text}
            </div>
          ))}
        </div>
      )}

      <h3>Agent CLIs</h3>
      {environment.clis.map((cli) => (
        <CliRow cli={cli} key={cli.id} />
      ))}

      <h3>Subscription windows</h3>
      {usage.length === 0 ? (
        <p className="muted">No signal yet — a CLI reports where its window stands during a turn, and kaprek shows the last one here.</p>
      ) : (
        usage.map((entry) => (
          <div className="setup-envfile" key={entry.harness}>
            <code className="setup-path">{entry.harness}</code>
            <div className="setup-note">{usageLine(entry)}</div>
          </div>
        ))
      )}

      <h3>Environment files</h3>
      {environment.envFiles.length === 0 ? (
        <p className="muted">None found in your home directory or your missions' directories.</p>
      ) : (
        environment.envFiles.map((file) => (
          <div className="setup-envfile" key={file.path}>
            <code className="setup-path">{file.path}</code>
            <div className="setup-note">{file.keys.length > 0 ? `defines ${file.keys.join(", ")}` : "no variables defined"}</div>
          </div>
        ))
      )}

      <h3>Suggested council</h3>
      {canCouncil ? (
        <>
          <div className="setup-note">
            lead {suggestedCouncil.lead} · thinker {suggestedCouncil.thinker} · worker {suggestedCouncil.worker} · second opinion from{" "}
            {(suggestedCouncil.peer ?? []).join(", ")}
          </div>
          <button
            type="button"
            className="btn"
            disabled={saved}
            onClick={() => {
              // 'plans' is the level this suggestion is worth: ask about a
              // plan, stay quiet the rest of the time.
              void saveCouncil("plans", suggestedCouncil)
                .then(() => setSaved(true))
                .catch((err) => setError(err instanceof Error ? err.message : String(err)));
            }}
          >
            {saved ? "Saved" : "Use this setup"}
          </button>
        </>
      ) : (
        <p className="muted">
          Only one engine is ready, so there is no second opinion to be had — a model reviewing its own answer is not one.
        </p>
      )}
    </div>
  );
}
