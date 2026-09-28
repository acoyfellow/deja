// Deja shared memory server.
//
// Local development authentication is deliberately small but no longer means
// "any valid token sees the same memory". A configured token maps to one
// memory space; each space is stored in its own Durable Object.
//
// .dev.vars examples:
//   DEJA_SHARED_TOKENS=alice-token:alice,bob-token:bob
//   DEJA_SHARED_TOKENS=personal-token:personal,team-token:project-docs
//
// The old DEJA_SHARED_TOKEN variable still works locally and maps to the
// `local` space. Do not use either token mode for a deployed employee service;
// production identity/session expiry remains a security design task.

interface Env {
  MEMORY: DurableObjectNamespace;
  /** Local proof format: comma-separated `<token>:<space>` entries. */
  DEJA_SHARED_TOKENS?: string;
  /** Backward-compatible local proof token, routed to the `local` space. */
  DEJA_SHARED_TOKEN?: string;
  /**
   * Maximum lifetime (in seconds) for an authenticated SSE stream. A bounded
   * stream lifetime gives token rotation and revocation an enforceable
   * boundary because callers must reconnect with current credentials before
   * exceeding the cap. Defaults to 15 minutes and is capped at one hour.
   */
  DEJA_SHARED_STREAM_TTL_SECONDS?: string;
  DEJA_SHARED_MAX_STREAMS?: string;
}

type EventType = "remember" | "handoff" | "signal" | "delete";

type ChangeRow = {
  revision: number;
  event_id: string;
  type: EventType;
  committed_at: string;
  payload_json: string;
};

type ChangeEvent = {
  revision: number;
  eventId: string;
  type: EventType;
  authority: string;
  committedAt: string;
  payload: unknown;
};

type RememberPayload = { slipId: string; text?: string; tags?: string[]; authoredBy?: string; sessionId?: string; state?: string };
type DeletePayload = { deleteId: string; slipId: string; authoredBy?: string; sessionId?: string };
type AuthenticatedSpace = { space: string; mode: "mapped-token" | "legacy-local-token" };

const ENCODER = new TextEncoder();
const SAFE_SPACE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const DEFAULT_STREAM_TTL_SECONDS = 15 * 60;
const MAX_STREAM_TTL_SECONDS = 60 * 60;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_MEMORY_TEXT_BYTES = 48 * 1024;
const MAX_EVENT_PAGE_SIZE = 200;
const DEFAULT_MAX_ACTIVE_STREAMS = 32;
const MAX_LIST_ITEMS = 32;
const MAX_ID_BYTES = 256;
const MAX_LIST_ITEM_BYTES = 1024;

class BadRequest extends Error {}

function streamTtlSeconds(env: Env): number {
  const raw = (env.DEJA_SHARED_STREAM_TTL_SECONDS ?? "").trim();
  if (raw === "") return DEFAULT_STREAM_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STREAM_TTL_SECONDS;
  return Math.min(Math.floor(parsed), MAX_STREAM_TTL_SECONDS);
}

export function maxActiveStreams(env: Env): number {
  const parsed = Number((env.DEJA_SHARED_MAX_STREAMS ?? "").trim());
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_ACTIVE_STREAMS;
  return Math.min(parsed, DEFAULT_MAX_ACTIVE_STREAMS);
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function readBearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.replace(/^Bearer\s+/i, "");
}

function configuredSpaces(env: Env): Map<string, string> {
  const configured = new Map<string, string>();
  for (const entry of (env.DEJA_SHARED_TOKENS ?? "").split(",")) {
    const value = entry.trim();
    if (!value) continue;
    const colon = value.indexOf(":");
    if (colon < 1) continue;
    const token = value.slice(0, colon).trim();
    const space = value.slice(colon + 1).trim();
    if (token && SAFE_SPACE.test(space)) configured.set(token, space);
  }
  return configured;
}

function authenticate(request: Request, env: Env): AuthenticatedSpace | null {
  const token = readBearerToken(request);
  if (!token) return null;
  const space = configuredSpaces(env).get(token);
  if (space) return { space, mode: "mapped-token" };
  if (env.DEJA_SHARED_TOKEN && token === env.DEJA_SHARED_TOKEN) {
    return { space: "local", mode: "legacy-local-token" };
  }
  return null;
}

function unauthorized(): Response {
  return jsonResponse({ ok: false, error: "unauthorized" }, 401);
}

function notFound(): Response {
  return jsonResponse({ ok: false, error: "not found" }, 404);
}

function requestFailure(error: unknown): Response {
  if (error instanceof BadRequest) return jsonResponse({ ok: false, error: error.message }, 400);
  return jsonResponse({ ok: false, error: "internal server error" }, 500);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequest("JSON body must be an object");
  return value as Record<string, unknown>;
}

function byteLength(value: string): number {
  return ENCODER.encode(value).byteLength;
}

function requiredString(body: Record<string, unknown>, field: string, maxBytes = MAX_ID_BYTES): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) throw new BadRequest(`${field} is required`);
  const normalized = value.trim();
  if (byteLength(normalized) > maxBytes) throw new BadRequest(`${field} exceeds ${maxBytes} bytes`);
  return normalized;
}

function optionalStringList(
  body: Record<string, unknown>,
  field: string,
  itemMaxBytes = MAX_LIST_ITEM_BYTES,
): string[] {
  const value = body[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new BadRequest(`${field} must be an array of at most ${MAX_LIST_ITEMS} strings`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) throw new BadRequest(`${field} must contain non-empty strings`);
    const normalized = item.trim();
    if (byteLength(normalized) > itemMaxBytes) throw new BadRequest(`${field} item exceeds ${itemMaxBytes} bytes`);
    return normalized;
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new BadRequest("content-type must be application/json");
  }
  const advertisedLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_REQUEST_BYTES) {
    throw new BadRequest(`request exceeds ${MAX_REQUEST_BYTES} bytes`);
  }
  const raw = await request.text();
  if (byteLength(raw) > MAX_REQUEST_BYTES) throw new BadRequest(`request exceeds ${MAX_REQUEST_BYTES} bytes`);
  try {
    return asObject(JSON.parse(raw));
  } catch (error) {
    if (error instanceof BadRequest) throw error;
    throw new BadRequest("request body must be valid JSON");
  }
}

function cursor(url: URL): number {
  const raw = url.searchParams.get("since");
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new BadRequest("since must be a non-negative integer");
  return value;
}

function pageLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return MAX_EVENT_PAGE_SIZE;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_EVENT_PAGE_SIZE) {
    throw new BadRequest(`limit must be an integer from 1 to ${MAX_EVENT_PAGE_SIZE}`);
  }
  return value;
}

function rememberPayload(body: Record<string, unknown>) {
  return {
    slipId: requiredString(body, "slipId"),
    text: requiredString(body, "text", MAX_MEMORY_TEXT_BYTES),
    tags: optionalStringList(body, "tags", MAX_LIST_ITEM_BYTES),
    authoredBy: requiredString(body, "authoredBy"),
    sessionId: requiredString(body, "sessionId"),
    state: "kept",
  };
}

function handoffPayload(body: Record<string, unknown>) {
  return {
    handoffId: requiredString(body, "handoffId"),
    summary: requiredString(body, "summary", MAX_MEMORY_TEXT_BYTES),
    next: optionalStringList(body, "next"),
    authoredBy: requiredString(body, "authoredBy"),
    sessionId: requiredString(body, "sessionId"),
    kept: optionalStringList(body, "kept", MAX_ID_BYTES),
  };
}

function signalPayload(body: Record<string, unknown>) {
  const action = requiredString(body, "action", 16);
  if (action !== "used" && action !== "wrong" && action !== "forget") {
    throw new BadRequest("action must be used, wrong, or forget");
  }
  return {
    signalId: requiredString(body, "signalId"),
    slipId: requiredString(body, "slipId"),
    action,
    authoredBy: requiredString(body, "authoredBy"),
    sessionId: requiredString(body, "sessionId"),
  };
}

function deletePayload(body: Record<string, unknown>): DeletePayload {
  return {
    deleteId: requiredString(body, "deleteId"),
    slipId: requiredString(body, "slipId"),
    authoredBy: requiredString(body, "authoredBy"),
    sessionId: requiredString(body, "sessionId"),
  };
}

function sseFrame(event: ChangeEvent): Uint8Array {
  const lines =
    `id: ${event.revision}\n` +
    `event: memory\n` +
    `data: ${JSON.stringify(event)}\n\n`;
  return ENCODER.encode(lines);
}

function helloFrame(space: string, headRevision: number): Uint8Array {
  const payload = JSON.stringify({ ok: true, authority: space, headRevision });
  return ENCODER.encode(`event: hello\ndata: ${payload}\n\n`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const authenticated = authenticate(request, env);
    if (!authenticated) return unauthorized();
    const spaceId = env.MEMORY.idFromName(`space:${authenticated.space}`);
    const forwarded = new Request(request);
    forwarded.headers.set("x-deja-space", authenticated.space);
    const ttl = streamTtlSeconds(env);
    forwarded.headers.set("x-deja-stream-ttl-seconds", String(ttl));
    return env.MEMORY.get(spaceId).fetch(forwarded);
  },
};

export class MemoryServer {
  private readonly sql: SqlStorage;
  private schemaReady = false;
  private readonly streamWriters = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private readonly streamLimit: number;

  constructor(ctx: DurableObjectState, env: Env) {
    this.sql = (ctx.storage as unknown as { sql: SqlStorage }).sql;
    this.streamLimit = maxActiveStreams(env);
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS changes(
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE,
        type TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );`
    );
    this.schemaReady = true;
  }

  private space(request: Request): string {
    const space = request.headers.get("x-deja-space") ?? "";
    if (!SAFE_SPACE.test(space)) throw new Error("missing authenticated memory space");
    return space;
  }

  private headRevision(): number {
    const row = this.sql
      .exec(`SELECT COALESCE(MAX(revision), 0) AS n FROM changes`)
      .one() as { n: number | bigint };
    return Number(row.n);
  }

  private listChangesSince(space: string, since: number, limit = 200): ChangeEvent[] {
    const rows = this.sql
      .exec(
        `SELECT revision, event_id, type, committed_at, payload_json
         FROM changes
         WHERE revision > ?
         ORDER BY revision ASC
         LIMIT ?`,
        since,
        limit
      )
      .toArray() as ChangeRow[];
    return rows.map((row) => ({
      revision: Number(row.revision),
      eventId: row.event_id,
      type: row.type,
      authority: space,
      committedAt: row.committed_at,
      payload: JSON.parse(row.payload_json),
    }));
  }

  private purgeRememberPayload(slipId: string): void {
    const rows = this.sql
      .exec(
        `SELECT revision, payload_json
         FROM changes
         WHERE type = 'remember'
         ORDER BY revision ASC`
      )
      .toArray() as Array<{ revision: number; payload_json: string }>;
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as RememberPayload;
      if (payload.slipId !== slipId) continue;
      // Preserve the revision slot and slip id so event replay remains ordered,
      // but permanently drop the saved text/tags/identity from server history.
      this.sql.exec(
        `UPDATE changes SET payload_json = ? WHERE revision = ?`,
        JSON.stringify({ slipId, purged: true }),
        row.revision,
      );
    }
  }

  private recordChange(space: string, type: EventType, id: string, payload: unknown) {
    const eventId = crypto.randomUUID();
    const committedAt = new Date().toISOString();
    const inserted = this.sql
      .exec(
        `INSERT INTO changes(event_id, type, committed_at, payload_json)
         VALUES(?, ?, ?, ?)
         RETURNING revision`,
        eventId,
        type,
        committedAt,
        JSON.stringify(payload)
      )
      .one() as { revision: number | bigint };
    const event: ChangeEvent = {
      revision: Number(inserted.revision),
      eventId,
      type,
      authority: space,
      committedAt,
      payload,
    };
    this.broadcastChange(event);
    return {
      ok: true,
      id,
      event,
      receipt: {
        authority: space,
        revision: event.revision,
        committedAt,
      },
      recallable: true,
    };
  }

  // Failed/stalled stream sends must never block a committed save.
  private broadcastChange(event: ChangeEvent): void {
    const frame = sseFrame(event);
    for (const writer of [...this.streamWriters]) {
      writer.write(frame).catch(() => this.streamWriters.delete(writer));
    }
  }

  private openStream(space: string, since: number, ttlSeconds: number): Response {
    if (this.streamWriters.size >= this.streamLimit) {
      return jsonResponse({ ok: false, error: "too many active streams" }, 429);
    }
    const channel = new TransformStream<Uint8Array, Uint8Array>();
    const writer = channel.writable.getWriter();
    void writer.write(helloFrame(space, this.headRevision()));
    for (const event of this.listChangesSince(space, since, MAX_EVENT_PAGE_SIZE)) {
      void writer.write(sseFrame(event));
    }
    this.streamWriters.add(writer);
    const closeStream = (): void => {
      this.streamWriters.delete(writer);
      void writer.close().catch(() => {});
    };
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    void writer.write(
      ENCODER.encode(
        `event: expires\ndata: ${JSON.stringify({
          reason: "stream-ttl",
          ttlSeconds,
          expiresAt,
        })}\n\n`
      )
    );
    setTimeout(() => {
      if (!this.streamWriters.has(writer)) return;
      void writer
        .write(
          ENCODER.encode(
            `event: closed\ndata: ${JSON.stringify({ reason: "stream-ttl" })}\n\n`
          )
        )
        .catch(() => {})
        .finally(() => closeStream());
    }, ttlSeconds * 1000);
    const headers: Record<string, string> = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      "x-deja-stream-ttl-seconds": String(ttlSeconds),
    };
    return new Response(channel.readable, { headers });
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    try {
      const space = this.space(request);
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      if (method === "GET" && path === "/v1/shared/status") {
        return jsonResponse({
          ok: true,
          authority: space,
          headRevision: this.headRevision(),
        });
      }

      if (method === "GET" && path === "/v1/shared/events") {
        return jsonResponse({
          ok: true,
          authority: space,
          headRevision: this.headRevision(),
          events: this.listChangesSince(space, cursor(url), pageLimit(url)),
        });
      }

      if (method === "GET" && path === "/v1/shared/stream") {
        const ttl = Number(request.headers.get("x-deja-stream-ttl-seconds"));
        const ttlSeconds = Number.isFinite(ttl) && ttl > 0
          ? Math.min(MAX_STREAM_TTL_SECONDS, Math.max(1, Math.floor(ttl)))
          : DEFAULT_STREAM_TTL_SECONDS;
        return this.openStream(space, cursor(url), ttlSeconds);
      }

      if (method === "POST" && path === "/v1/shared/remember") {
        const payload = rememberPayload(await readJsonBody(request));
        return jsonResponse(this.recordChange(space, "remember", payload.slipId, payload));
      }

      if (method === "POST" && path === "/v1/shared/handoff") {
        const payload = handoffPayload(await readJsonBody(request));
        return jsonResponse(this.recordChange(space, "handoff", payload.handoffId, payload));
      }

      if (method === "POST" && path === "/v1/shared/signal") {
        const payload = signalPayload(await readJsonBody(request));
        return jsonResponse(this.recordChange(space, "signal", payload.signalId, payload));
      }

      if (method === "POST" && path === "/v1/shared/delete") {
        const payload = deletePayload(await readJsonBody(request));
        const receipt = this.recordChange(space, "delete", payload.slipId, payload);
        this.purgeRememberPayload(payload.slipId);
        return jsonResponse(receipt);
      }

      return notFound();
    } catch (error) {
      return requestFailure(error);
    }
  }
}
