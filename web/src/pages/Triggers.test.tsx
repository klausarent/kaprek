import { test, expect, vi } from "vitest";
import { ClipboardConsentPanel, DeleteConfirmPanel, TriggerForm, TriggerRow } from "./Triggers";
import { emptyTriggerForm } from "../lib/triggerForm";
import type { TriggerStatus } from "../lib/api";
import { click, findAll, findByType, findOneByText, render, textOf } from "../test/tree";

function triggerStatus(overrides: Partial<TriggerStatus> = {}): TriggerStatus {
  return {
    id: "nightly-sync",
    type: "schedule",
    config: { everyMinutes: 60 },
    promptTemplate: "Check the notes folder.",
    escalation: "notify",
    appScope: [],
    enabled: false,
    approvalRequired: false,
    limits: { maxRunsPerDay: 24, maxCostPerDay: 1 },
    runsToday: 3,
    costToday: 0.12,
    approvalPath: "policy",
    blocked: null,
    supported: true,
    unsupportedReason: null,
    ...overrides,
  };
}

const noop = () => {};

test("a trigger row shows today's usage against both limits", () => {
  const tree = render(
    <TriggerRow
      trigger={triggerStatus()}
      busy={false}
      note={null}
      onToggleRequest={noop}
      onFire={noop}
      onEdit={noop}
      onDelete={noop}
    />,
  );
  const text = textOf(tree);
  expect(text).toContain("3/24 runs");
  expect(text).toContain("$0.12/$1.00");
});

test("a trigger row translates approvalPath into plain words and surfaces a blocked reason", () => {
  const policy = render(
    <TriggerRow trigger={triggerStatus()} busy={false} note={null} onToggleRequest={noop} onFire={noop} onEdit={noop} onDelete={noop} />,
  );
  expect(textOf(policy)).toContain("automatically limited");

  const asks = render(
    <TriggerRow
      trigger={triggerStatus({ escalation: "question", approvalPath: "ui", blocked: "no UI approval handler configured for this escalation level" })}
      busy={false}
      note={null}
      onToggleRequest={noop}
      onFire={noop}
      onEdit={noop}
      onDelete={noop}
    />,
  );
  const text = textOf(asks);
  expect(text).toContain("asks you");
  expect(text).toContain("Cannot run: no UI approval handler configured");
});

test("enabling a clipboard trigger asks for confirmation instead of toggling straight away", () => {
  const onToggleRequest = vi.fn();
  const trigger = triggerStatus({ id: "copy-watch", type: "clipboard", config: { matchPattern: "^TODO:" } });
  const tree = render(
    <TriggerRow trigger={trigger} busy={false} note={null} onToggleRequest={onToggleRequest} onFire={noop} onEdit={noop} onDelete={noop} />,
  );

  const checkbox = findAll(tree, (node) => node.type === "input" && node.props.type === "checkbox")[0];
  (checkbox.props.onChange as (e: unknown) => void)({ target: { checked: true } });
  // The row itself never decides — it hands the request up, and the page routes
  // a clipboard enable through the consent panel (see handleToggleRequest).
  expect(onToggleRequest).toHaveBeenCalledWith(trigger, true);
});

test("the clipboard consent panel names what is read and requires an explicit confirm", () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const trigger = triggerStatus({ id: "copy-watch", type: "clipboard", config: { matchPattern: "^TODO:" } });
  const tree = render(<ClipboardConsentPanel trigger={trigger} onConfirm={onConfirm} onCancel={onCancel} />);

  const text = textOf(tree);
  expect(text).toContain("kaprek will read your clipboard");
  expect(text).toContain("^TODO:");

  click(findOneByText(tree, "button", "I understand, enable it"));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  click(findOneByText(tree, "button", "Cancel"));
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("the delete panel spells out what is lost and offers disabling instead", () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const tree = render(<DeleteConfirmPanel trigger={triggerStatus()} onConfirm={onConfirm} onCancel={onCancel} />);

  const text = textOf(tree);
  expect(text).toContain("Delete trigger “nightly-sync”?");
  expect(text).toContain("cannot be undone");
  expect(text).toContain("disable it instead");

  click(findOneByText(tree, "button", "Cancel"));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();

  click(findOneByText(tree, "button", "Delete it"));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

test("a clipboard trigger without a pattern says so in the consent panel", () => {
  const trigger = triggerStatus({ id: "copy-watch", type: "clipboard", config: {} });
  const tree = render(<ClipboardConsentPanel trigger={trigger} onConfirm={noop} onCancel={noop} />);
  expect(textOf(tree)).toContain("nothing will ever match");
});

test("a clipboard trigger offers no manual run", () => {
  const tree = render(
    <TriggerRow
      trigger={triggerStatus({ type: "clipboard", config: { matchPattern: "x" } })}
      busy={false}
      note={null}
      onToggleRequest={noop}
      onFire={noop}
      onEdit={noop}
      onDelete={noop}
    />,
  );
  expect(findOneByText(tree, "button", "No manual run").props.disabled).toBe(true);
});

test("the row's note is where a 429 from Run now is shown", () => {
  const tree = render(
    <TriggerRow
      trigger={triggerStatus()}
      busy={false}
      note="A trigger run is already in progress — try again in a moment."
      onToggleRequest={noop}
      onFire={noop}
      onEdit={noop}
      onDelete={noop}
    />,
  );
  expect(textOf(tree)).toContain("already in progress");
});

test("a server validation error is rendered at the field it names, not as a form-level message", () => {
  const tree = render(
    <TriggerForm
      value={{ ...emptyTriggerForm(), type: "heartbeat", intervalMinutes: "2" }}
      editing={false}
      saving={false}
      fieldError={{ field: "intervalMinutes", message: "config.intervalMinutes: must be a number between 5 and 1440" }}
      formError={null}
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
    />,
  );

  const errors = findAll(tree, (node) => (node.props.className as string | undefined) === "trigger-field-error");
  expect(errors).toHaveLength(1);
  expect(textOf(errors[0])).toContain("must be a number between 5 and 1440");

  // The field's own wrapper carries it, so it renders next to that input.
  const owner = findAll(
    tree,
    (node) =>
      (node.props.className as string | undefined) === "trigger-form-field" &&
      findAll(node, (child) => child.props.name === "intervalMinutes").length === 1,
  );
  expect(owner).toHaveLength(1);
  expect(textOf(owner[0])).toContain("must be a number between 5 and 1440");
  expect(findAll(tree, (node) => (node.props.className as string | undefined) === "error-box")).toHaveLength(0);
});

test("a 400 that names no form field falls back to a form-level error box", () => {
  const tree = render(
    <TriggerForm
      value={emptyTriggerForm()}
      editing={false}
      saving={false}
      fieldError={null}
      formError="<root>: trigger must be an object"
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
    />,
  );
  const boxes = findAll(tree, (node) => (node.props.className as string | undefined) === "error-box");
  expect(boxes).toHaveLength(1);
  expect(textOf(boxes[0])).toContain("trigger must be an object");
});

test("the form shows only the selected type's fields", () => {
  const clipboard = render(
    <TriggerForm
      value={{ ...emptyTriggerForm(), type: "clipboard" }}
      editing={false}
      saving={false}
      fieldError={null}
      formError={null}
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
    />,
  );
  const names = findByType(clipboard, "input").map((node) => node.props.name);
  expect(names).toContain("matchPattern");
  expect(names).toContain("pollMs");
  expect(names).not.toContain("intervalMinutes");
  expect(names).not.toContain("watchPath");
});

test("each escalation level comes with its own one-sentence explanation", () => {
  const tree = render(
    <TriggerForm
      value={emptyTriggerForm()}
      editing={false}
      saving={false}
      fieldError={null}
      formError={null}
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
    />,
  );
  const text = textOf(tree);
  expect(text).toContain("Reports what it found");
  expect(text).toContain("Asks you before it does anything");
  expect(text).toContain("Prepares the work and hands it to you");
});

test("the id field is locked while editing an existing trigger", () => {
  const tree = render(
    <TriggerForm
      value={{ ...emptyTriggerForm(), id: "nightly-sync" }}
      editing
      saving={false}
      fieldError={null}
      formError={null}
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
    />,
  );
  const idInput = findAll(tree, (node) => node.props.name === "id")[0];
  expect(idInput.props.disabled).toBe(true);
  expect(textOf(tree)).toContain("Edit nightly-sync");
});
