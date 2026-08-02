// Who a memory belongs to, and who may see it.
//
// The question M3 exists to answer: what one agent learned should be there
// for the next one, without copy-paste — and a child's scope must never see
// the company's. Both halves of that are the same mechanism, which is why
// visibility is a property of the tree rather than a permission list.
//
// VISIBILITY RUNS UPWARDS, NEVER DOWN. A mission sees its project sees its
// person. A person does not see into their missions, and two trees that do
// not share a parent see nothing of each other. That single rule is what
// makes "Luca's scope cannot read the company memory" a fact about the data
// structure instead of a promise in a doc.
//
// FAIL-CLOSED. A scope whose parent chain does not resolve sees NOTHING, not
// everything. The failure mode of a lookup bug has to be an empty answer; the
// other direction hands somebody else's memory to whoever asked.

/** person: a human. project: a body of work. mission: one goal inside it. agent: an engine's own notes. */
export const SCOPE_KINDS = ['person', 'project', 'mission', 'agent'];

/** Thrown when a scope cannot exist as described. Carries the field so a UI can point at it. */
export class InvalidScopeError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'InvalidScopeError';
    this.field = field;
  }
}

/**
 * Splits `kind:label` into its parts.
 *
 * The id carries the kind on purpose: every place that reads a scope id can
 * tell what it is looking at without a lookup, and a typo like `projekt:x`
 * is caught at parse time rather than becoming a silently empty tree.
 */
export function parseScopeId(id) {
  if (typeof id !== 'string' || id.trim() === '') throw new InvalidScopeError('id', 'a scope id must be a non-empty string');
  const separator = id.indexOf(':');
  if (separator <= 0 || separator === id.length - 1) throw new InvalidScopeError('id', `a scope id looks like "kind:label" (got ${JSON.stringify(id)})`);
  const kind = id.slice(0, separator);
  const label = id.slice(separator + 1);
  if (!SCOPE_KINDS.includes(kind)) throw new InvalidScopeError('id', `unknown scope kind "${kind}" — expected one of ${SCOPE_KINDS.join(', ')}`);
  return { id, kind, label };
}

/**
 * Checks one scope against the tree it is joining.
 *
 * @param {{id: string, parent?: string|null}} scope
 * @param {Map<string, object>} existing - id -> scope, the tree as it stands
 * @returns {{id: string, kind: string, label: string, parent: string|null}}
 * @throws {InvalidScopeError}
 */
export function validateScope(scope, existing = new Map()) {
  const parsed = parseScopeId(scope?.id);
  const parent = scope?.parent ?? null;
  if (parent !== null) {
    parseScopeId(parent);
    if (parent === parsed.id) throw new InvalidScopeError('parent', `scope "${parsed.id}" cannot be its own parent`);
    if (!existing.has(parent)) throw new InvalidScopeError('parent', `scope "${parsed.id}" names a parent that does not exist: ${parent}`);
    // A cycle would make visibleScopes() loop forever, or — worse — make it
    // return a set that depends on where the walk started.
    for (let cursor = existing.get(parent); cursor; cursor = cursor.parent ? existing.get(cursor.parent) : null) {
      if (cursor.id === parsed.id) throw new InvalidScopeError('parent', `scope "${parsed.id}" would close a cycle through ${parent}`);
    }
  }
  return { id: parsed.id, kind: parsed.kind, label: parsed.label, parent };
}

/**
 * Every scope `scopeId` can read, nearest first: itself, its parent, its
 * parent's parent, up to the root.
 *
 * An unknown scope, or one whose chain breaks partway, returns what it could
 * resolve — and an unknown STARTING scope returns nothing at all. Fail-closed
 * in the direction that matters: the cost of a missing memory is a question
 * asked twice, the cost of an extra one is someone reading what was not
 * theirs.
 *
 * @param {string} scopeId
 * @param {Map<string, object>|object[]} allScopes
 * @returns {string[]}
 */
export function visibleScopes(scopeId, allScopes) {
  const byId = allScopes instanceof Map ? allScopes : new Map((allScopes ?? []).map((scope) => [scope.id, scope]));
  if (!byId.has(scopeId)) return [];

  const seen = [];
  const guard = new Set();
  for (let cursor = byId.get(scopeId); cursor && !guard.has(cursor.id); cursor = cursor.parent ? byId.get(cursor.parent) : null) {
    guard.add(cursor.id);
    seen.push(cursor.id);
  }
  return seen;
}

/**
 * Whether `readerScopeId` may read something written in `ownerScopeId`.
 *
 * Stated as its own function because this is the sentence the M3 acceptance
 * is written in, and a caller doing the array check itself would eventually
 * do it the other way round.
 */
export function canRead(readerScopeId, ownerScopeId, allScopes) {
  return visibleScopes(readerScopeId, allScopes).includes(ownerScopeId);
}
