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
import { fetchEnvironment, saveCouncil, type EnvironmentReport } from "../lib/api";

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

export default function Setup() {
  const [report, setReport] = useState<EnvironmentReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchEnvironment()
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
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
