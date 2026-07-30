// api.ts is imported dynamically in every case below: it reads the instance
// token from the DOM ONCE at module load, so the fake `document` has to be in
// place before the import, and each case needs a fresh module registry.
import { test, expect, vi, beforeEach, afterEach } from "vitest";

const TOKEN = "a".repeat(64);
const TOKEN_HEADER = "x-kaprek-token";
const CHAT_ID = "11111111-1111-4111-8111-111111111111";

type FetchCall = { url: string; init: RequestInit };

let calls: FetchCall[];

function stubDocument(token: string | null): void {
  if (token === null) {
    vi.stubGlobal("document", undefined);
    return;
  }
  vi.stubGlobal("document", {
    querySelector: (selector: string) =>
      selector === 'meta[name="kaprek-token"]' ? { getAttribute: () => token } : null,
  });
}

/** A minimal Response stand-in — api.ts only ever touches status/ok/json/body. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    body: null,
  } as unknown as Response;
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: true, status: 200, json: async () => ({}), body: stream } as unknown as Response;
}

function stubFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return Promise.resolve(responder(url, init));
  });
}

function headerOf(call: FetchCall, name: string): string | undefined {
  return (call.init.headers as Record<string, string> | undefined)?.[name];
}

/** Loads a fresh api.ts against the currently stubbed document/fetch. */
async function loadApi() {
  vi.resetModules();
  return import("./api");
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("every request carries the x-kaprek-token header read from the meta tag — GET included", async () => {
  stubDocument(TOKEN);
  stubFetch(() => jsonResponse(200, { triggers: [] }));
  const api = await loadApi();

  await api.fetchTriggers();
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("/api/triggers");
  expect(headerOf(calls[0], TOKEN_HEADER)).toBe(TOKEN);
});

test("a write request carries both the token and the x-app-request CSRF header", async () => {
  stubDocument(TOKEN);
  stubFetch(() => jsonResponse(200, { ok: true }));
  const api = await loadApi();

  await api.toggleTrigger("nightly-sync", true);
  expect(headerOf(calls[0], TOKEN_HEADER)).toBe(TOKEN);
  expect(headerOf(calls[0], "x-app-request")).toBe("1");
  expect(calls[0].init.method).toBe("POST");
});

test("the SSE turn fetch carries the token too", async () => {
  stubDocument(TOKEN);
  stubFetch(() => sseResponse([`data: ${JSON.stringify({ type: "turn-complete", chatId: CHAT_ID })}\n\n`]));
  const api = await loadApi();

  const seen: unknown[] = [];
  await api.streamChatTurn({ text: "hello", onEvent: (event) => seen.push(event) });
  expect(calls[0].url).toBe("/api/chat/turn");
  expect(headerOf(calls[0], TOKEN_HEADER)).toBe(TOKEN);
  expect(seen).toHaveLength(1);
});

test("without a token meta tag hasInstanceToken() is false and every request throws MissingTokenError instead of firing", async () => {
  stubDocument(null);
  stubFetch(() => jsonResponse(200, {}));
  const api = await loadApi();

  expect(api.hasInstanceToken()).toBe(false);
  await expect(api.fetchTriggers()).rejects.toBeInstanceOf(api.MissingTokenError);
  expect(calls).toHaveLength(0);
});

test("an empty token meta tag counts as missing", async () => {
  vi.stubGlobal("document", { querySelector: () => ({ getAttribute: () => "   " }) });
  stubFetch(() => jsonResponse(200, {}));
  const api = await loadApi();
  expect(api.hasInstanceToken()).toBe(false);
});

test("answerApproval posts chatId and behavior, and a deny carries the message", async () => {
  stubDocument(TOKEN);
  stubFetch(() => jsonResponse(200, { ok: true }));
  const api = await loadApi();

  await api.answerApproval("req-7", { chatId: CHAT_ID, behavior: "allow" });
  expect(calls[0].url).toBe("/api/approvals/req-7");
  expect(JSON.parse(calls[0].init.body as string)).toEqual({ chatId: CHAT_ID, behavior: "allow" });

  await api.answerApproval("req-8", { chatId: CHAT_ID, behavior: "deny", message: "denied by user" });
  expect(JSON.parse(calls[1].init.body as string)).toEqual({
    chatId: CHAT_ID,
    behavior: "deny",
    message: "denied by user",
  });
});

test("answerApproval reports 404 and 409 as 'gone' rather than throwing", async () => {
  stubDocument(TOKEN);
  let status = 404;
  stubFetch(() => jsonResponse(status, { error: "unknown or expired approval" }));
  const api = await loadApi();

  expect(await api.answerApproval("req-1", { chatId: CHAT_ID, behavior: "allow" })).toBe("gone");
  status = 409;
  expect(await api.answerApproval("req-1", { chatId: CHAT_ID, behavior: "allow" })).toBe("gone");
  status = 500;
  await expect(api.answerApproval("req-1", { chatId: CHAT_ID, behavior: "allow" })).rejects.toThrow(/HTTP 500/);
});

test("upsertTrigger turns a 400 into a TriggerValidationError carrying the field", async () => {
  stubDocument(TOKEN);
  stubFetch(() => jsonResponse(400, { error: "config.intervalMinutes: must be a number between 5 and 1440", field: "config.intervalMinutes" }));
  const api = await loadApi();

  const error = await api.upsertTrigger({ id: "x" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(api.TriggerValidationError);
  expect((error as InstanceType<typeof api.TriggerValidationError>).field).toBe("config.intervalMinutes");
  expect((error as Error).message).toMatch(/between 5 and 1440/);
});

test("fireTrigger turns a 429 into TriggerBusyError and otherwise returns the final frame", async () => {
  stubDocument(TOKEN);
  stubFetch(() => jsonResponse(429, { reason: "trigger turn in progress" }));
  let api = await loadApi();
  await expect(api.fireTrigger("nightly-sync")).rejects.toBeInstanceOf(api.TriggerBusyError);

  calls = [];
  stubFetch(() =>
    sseResponse([
      `data: ${JSON.stringify({ type: "chat-id", chatId: CHAT_ID })}\n\n`,
      `data: ${JSON.stringify({ type: "trigger-complete", fired: true, chatId: CHAT_ID })}\n\n`,
    ]),
  );
  api = await loadApi();
  const frames: unknown[] = [];
  const result = await api.fireTrigger("nightly-sync", { onEvent: (event) => frames.push(event) });
  expect(frames).toHaveLength(2);
  expect(result).toMatchObject({ type: "trigger-complete", fired: true });
});

test("fetchChatList builds the triggerId and includeSilent query independently", async () => {
  stubDocument(TOKEN);
  stubFetch(() => jsonResponse(200, { chats: [] }));
  const api = await loadApi();

  await api.fetchChatList();
  await api.fetchChatList({ triggerId: "nightly-sync" });
  await api.fetchChatList({ triggerId: "nightly-sync", includeSilent: true });
  expect(calls.map((call) => call.url)).toEqual([
    "/api/chat/list",
    "/api/chat/list?triggerId=nightly-sync",
    "/api/chat/list?triggerId=nightly-sync&includeSilent=1",
  ]);
});

test("toDigestEvent passes a persisted approval event through as its own kind", async () => {
  stubDocument(TOKEN);
  const api = await loadApi();

  const requested = api.toDigestEvent({
    kind: "approval",
    ts: "2026-07-30T10:00:00.000Z",
    phase: "requested",
    requestId: "req-1",
    toolName: "Bash",
  });
  expect(requested).toMatchObject({ kind: "approval", phase: "requested", toolName: "Bash" });

  const resolved = api.toDigestEvent({
    kind: "approval",
    ts: "2026-07-30T10:00:05.000Z",
    phase: "resolved",
    requestId: "req-1",
    toolName: "Bash",
    behavior: "deny",
    message: "denied by user",
  });
  expect(resolved).toMatchObject({ kind: "approval", phase: "resolved", behavior: "deny" });
});

test("a rejected fetch marks the server unreachable, a 500 does not", async () => {
  stubDocument(TOKEN);
  stubFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  const api = await loadApi();
  const status = await import("./status");
  status.resetStatus();

  await expect(api.fetchTriggers()).rejects.toThrow();
  expect(status.getStatus().serverReachable).toBe(false);

  stubFetch(() => jsonResponse(500, { error: "internal error" }));
  await expect(api.fetchTriggers()).rejects.toThrow(/HTTP 500/);
  expect(status.getStatus().serverReachable).toBe(true);
});
