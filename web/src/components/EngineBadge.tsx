// A small badge naming the engine a chat runs on. The default engine
// (claude-code) renders NOTHING on purpose — progressive disclosure: the
// default stays unfurnished, only a deliberate choice gets a label.
import type { Engine } from "../lib/api";

export default function EngineBadge({ engine, engines }: { engine?: string; engines?: Engine[] }) {
  if (!engine || engine === "claude-code") return null;
  const label = engines?.find((entry) => entry.id === engine)?.displayName ?? engine;
  return <span className="engine-badge">{label}</span>;
}
