import { describe, expect, test } from "vitest";
import { render, textOf, findAll } from "../test/tree";
import { RoleRow, PeerPicker } from "./Council";

describe("the role rows", () => {
  test("each role explains what the job is, not which model does it", () => {
    const text = textOf(render(<RoleRow role="thinker" value="codex" available={["claude-code", "codex"]} onChange={() => {}} />));
    expect(text).toContain("Thinker");
    expect(text).toContain("Architecture");
    // Every installed engine is offerable for every role.
    expect(text).toContain("claude-code");
  });

  test("changing a role reports the engine id", () => {
    const picked: string[] = [];
    const tree = render(<RoleRow role="lead" value="claude-code" available={["claude-code", "codex"]} onChange={(id) => picked.push(id)} />);
    const select = findAll(tree, (node) => node.type === "select")[0];
    (select.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "codex" } });
    expect(picked).toEqual(["codex"]);
  });
});

describe("the peer bench", () => {
  test("the lead cannot be its own peer, and the row says why", () => {
    const tree = render(<PeerPicker available={["claude-code", "codex"]} lead="claude-code" peer={["codex"]} onToggle={() => {}} />);
    expect(textOf(tree)).toContain("already the lead");
    const boxes = findAll(tree, (node) => node.props?.type === "checkbox");
    expect(boxes[0].props.disabled).toBe(true);
    expect(boxes[1].props.checked).toBe(true);
  });

  test("several peers are normal, and the text says so", () => {
    expect(textOf(render(<PeerPicker available={["codex", "grok"]} lead="claude-code" peer={[]} onToggle={() => {}} />))).toContain("contradict each other");
  });
});
