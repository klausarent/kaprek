// App manifest validator (schema v1) — the data shape an app.json under
// apps/<id>/ or <dataDir>/apps/<id>/ must satisfy. Same posture as
// src/policy/policy.mjs: an unknown field is a hard error, not silently
// ignored, so a typo in a hand-written app.json fails loudly at load time
// instead of quietly doing nothing.
//
// Tool IDs are the canon (see loader.mjs / mcp-server.mjs): `handler` is
// pure metadata, a hint for where the code lives. Every tool call MUST be
// authorized by finding its id inside THIS app's `tools[]` — never by
// trusting a handler path supplied at call time (the MCP wire protocol
// never carries one; see mcp-server.mjs).

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Loose semver: MAJOR.MINOR.PATCH with optional -prerelease and +build.
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
// Canonical tool id: "namespace.action", e.g. "notes.write", "image.generate".
const TOOL_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

export const EXTERNAL_ACTIONS = ['never', 'approval', 'auto'];
export const SENSITIVITIES = ['low', 'medium', 'high'];
export const UI_SLOTS = ['none', 'text', 'gallery'];

const KNOWN_TOP_FIELDS = ['id', 'version', 'name', 'description', 'icon', 'instructions', 'tools', 'policy', 'uiSlot'];
const KNOWN_TOOL_FIELDS = ['id', 'description', 'inputSchema', 'handler'];
const KNOWN_POLICY_FIELDS = ['fsWrite', 'dataEgress', 'externalAction', 'sensitivity'];

export class ManifestValidationError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'ManifestValidationError';
    this.field = field;
  }
}

function fail(field, message) {
  throw new ManifestValidationError(field, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNoUnknownFields(obj, known, fieldPrefix) {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      fail(fieldPrefix ? `${fieldPrefix}.${key}` : key, `unknown field (expected one of ${known.join(', ')})`);
    }
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(field, 'must be a non-empty string');
  }
}

/** Rejects a handler path that isn't a plain relative path within the app dir — defense in depth even though the id, not the handler, is the authorization boundary. */
function assertSafeHandlerPath(value, field) {
  assertNonEmptyString(value, field);
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value)) {
    fail(field, 'must be a relative path (no leading slash, no drive letter)');
  }
  const segments = value.split(/[/\\]/);
  if (segments.some((seg) => seg === '..')) {
    fail(field, "must not contain '..' segments");
  }
}

function validateTool(tool, index) {
  const fieldPrefix = `tools[${index}]`;
  if (!isPlainObject(tool)) fail(fieldPrefix, 'must be an object');
  assertNoUnknownFields(tool, KNOWN_TOOL_FIELDS, fieldPrefix);

  if (typeof tool.id !== 'string' || !TOOL_ID_RE.test(tool.id)) {
    fail(`${fieldPrefix}.id`, 'must be a canonical "namespace.action" tool id (lowercase, dot-separated)');
  }
  assertNonEmptyString(tool.description, `${fieldPrefix}.description`);
  if (!isPlainObject(tool.inputSchema)) {
    fail(`${fieldPrefix}.inputSchema`, 'must be a JSON Schema object');
  }
  assertSafeHandlerPath(tool.handler, `${fieldPrefix}.handler`);
}

function validateTools(tools) {
  if (!Array.isArray(tools)) fail('tools', 'must be an array');
  tools.forEach(validateTool);

  const seen = new Set();
  tools.forEach((tool, index) => {
    if (seen.has(tool.id)) fail(`tools[${index}].id`, `duplicate tool id within this manifest: "${tool.id}"`);
    seen.add(tool.id);
  });
}

function validatePolicy(policy) {
  if (!isPlainObject(policy)) fail('policy', 'must be an object');
  assertNoUnknownFields(policy, KNOWN_POLICY_FIELDS, 'policy');

  if (typeof policy.fsWrite !== 'boolean') fail('policy.fsWrite', 'must be a boolean');
  if (typeof policy.dataEgress !== 'boolean') fail('policy.dataEgress', 'must be a boolean');
  if (!EXTERNAL_ACTIONS.includes(policy.externalAction)) {
    fail('policy.externalAction', `must be one of ${EXTERNAL_ACTIONS.join(', ')}`);
  }
  if (!SENSITIVITIES.includes(policy.sensitivity)) {
    fail('policy.sensitivity', `must be one of ${SENSITIVITIES.join(', ')}`);
  }
}

/**
 * Validates a manifest object in place (no normalization/defaults — see
 * parseManifest() for that). Throws ManifestValidationError with a `.field`
 * naming exactly what was wrong, on the first violation found.
 */
export function validateManifest(obj) {
  if (!isPlainObject(obj)) fail('<root>', 'manifest must be a JSON object');
  assertNoUnknownFields(obj, KNOWN_TOP_FIELDS, '');

  if (typeof obj.id !== 'string' || !ID_RE.test(obj.id)) {
    fail('id', 'must be kebab-case ([a-z0-9-]+, no leading/trailing/double hyphen)');
  }
  if (typeof obj.version !== 'string' || !VERSION_RE.test(obj.version)) {
    fail('version', 'must be a semver-like string, e.g. "1.0.0"');
  }
  assertNonEmptyString(obj.name, 'name');
  assertNonEmptyString(obj.description, 'description');

  if (obj.icon !== undefined && typeof obj.icon !== 'string') {
    fail('icon', 'must be a string');
  }
  if (obj.instructions !== undefined && typeof obj.instructions !== 'string') {
    fail('instructions', 'must be a string');
  }

  validateTools(obj.tools);
  validatePolicy(obj.policy);

  if (obj.uiSlot !== undefined && !UI_SLOTS.includes(obj.uiSlot)) {
    fail('uiSlot', `must be one of ${UI_SLOTS.join(', ')}`);
  }
}

/**
 * Parses and validates a manifest, accepting either a raw JSON string or an
 * already-parsed object. Returns a normalized manifest (optional fields
 * filled with their defaults). Throws ManifestValidationError on invalid
 * JSON or a schema violation — never returns a partially-valid manifest.
 */
export function parseManifest(json) {
  let obj = json;
  if (typeof json === 'string') {
    try {
      obj = JSON.parse(json);
    } catch (err) {
      throw new ManifestValidationError('<root>', `invalid JSON: ${err.message}`);
    }
  }

  validateManifest(obj);

  return {
    id: obj.id,
    version: obj.version,
    name: obj.name,
    description: obj.description,
    icon: obj.icon ?? null,
    instructions: obj.instructions ?? '',
    tools: obj.tools.map((tool) => ({
      id: tool.id,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: tool.handler,
    })),
    policy: {
      fsWrite: obj.policy.fsWrite,
      dataEgress: obj.policy.dataEgress,
      externalAction: obj.policy.externalAction,
      sensitivity: obj.policy.sensitivity,
    },
    uiSlot: obj.uiSlot ?? 'none',
  };
}
