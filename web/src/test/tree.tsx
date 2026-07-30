// A ~70-line React element-tree walker, used instead of a DOM testing library.
//
// WHY: this repo has zero web test dependencies and the task forbids adding
// any, so there is no jsdom/happy-dom to mount into and no
// @testing-library/react to query with. What there IS: every component under
// test is deliberately hook-free and presentational (see ApprovalDialog.tsx,
// AgentPanel.tsx, TriggerForm/TriggerRow in Triggers.tsx), which means a
// function component can simply be CALLED and its returned element tree
// inspected — including invoking an onClick prop, which is what "the Allow
// button fires the decision" actually needs.
//
// The limits are real and deliberate: no layout, no CSS, no event bubbling, no
// effects, no state updates. Anything stateful is tested through its own pure
// module (lib/approvals.ts, lib/agents.ts, lib/triggerForm.ts) or through
// lib/api.ts with a mocked fetch.
import { isValidElement, type ReactElement, type ReactNode } from "react";

export type TestNode = {
  /** The host element's tag name ('div', 'button', …). */
  type: string;
  props: Record<string, unknown>;
  children: (TestNode | string)[];
};

type AnyElement = ReactElement<Record<string, unknown>>;

function expandChildren(node: ReactNode): (TestNode | string)[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string") return [node];
  if (typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(expandChildren);
  if (!isValidElement(node)) return [];

  const element = node as AnyElement;
  const props = element.props ?? {};

  // A function component is transparent here: call it and keep walking. This
  // is exactly why the components under test carry no hooks — React's hook
  // dispatcher is not installed outside a real renderer.
  if (typeof element.type === "function") {
    const render = element.type as (p: Record<string, unknown>) => ReactNode;
    return expandChildren(render(props));
  }
  if (typeof element.type === "string") {
    return [{ type: element.type, props, children: expandChildren(props.children as ReactNode) }];
  }
  // Fragment (and any other symbol-typed element): no host node of its own.
  return expandChildren(props.children as ReactNode);
}

/** Renders an element to a inspectable host-element tree. Returns a synthetic root so a component returning a fragment still has one node to query. */
export function render(element: ReactNode): TestNode {
  return { type: "#root", props: {}, children: expandChildren(element) };
}

/** All text under a node, concatenated in document order. */
export function textOf(node: TestNode | string): string {
  if (typeof node === "string") return node;
  return node.children.map(textOf).join("");
}

/** Every node (excluding the root) matching `predicate`, in document order. */
export function findAll(root: TestNode, predicate: (node: TestNode) => boolean): TestNode[] {
  const found: TestNode[] = [];
  const visit = (node: TestNode) => {
    for (const child of node.children) {
      if (typeof child === "string") continue;
      if (predicate(child)) found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

export function findByType(root: TestNode, type: string): TestNode[] {
  return findAll(root, (node) => node.type === type);
}

/** The one node of `type` whose own text equals `label` (trimmed). Throws when there is not exactly one — a silent null is a test that passes for the wrong reason. */
export function findOneByText(root: TestNode, type: string, label: string): TestNode {
  const matches = findAll(root, (node) => node.type === type && textOf(node).trim() === label);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one <${type}> with text "${label}", found ${matches.length}`);
  }
  return matches[0];
}

/**
 * Clicks a node by invoking its onClick prop. No bubbling — the handler under
 * test must sit on the node itself.
 *
 * A disabled node throws instead of firing: a real browser never delivers the
 * click, so calling the handler anyway would let a test like "busy blocks the
 * second click" pass against a component that had lost its `disabled`.
 */
export function click(node: TestNode): void {
  if (node.props.disabled === true) {
    throw new Error(`<${node.type}> is disabled — a real click would not reach its handler`);
  }
  const onClick = node.props.onClick;
  if (typeof onClick !== "function") throw new Error(`<${node.type}> has no onClick prop`);
  (onClick as (event: unknown) => void)({ preventDefault() {}, stopPropagation() {} });
}
