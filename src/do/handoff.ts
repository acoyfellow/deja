import { desc, eq } from 'drizzle-orm';

import * as schema from '../schema';
import type {
  HandoffBlessedRef,
  HandoffOperationsContext,
  HandoffPacket,
  HandoffPacketLink,
} from './types';

// Default page size for GET /handoffs. Matches the "recent list" vibe of
// /learnings and /sessions — callers override via ?limit=.
export const HANDOFF_LIST_DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------
// Inputs come from untyped HTTP bodies. Coerce each field to its typed shape
// and drop junk. The normalized packet is what gets serialized — we never
// echo back unknown fields.

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
    .filter((item) => item.length > 0);
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const arr = asStringArray(value);
  return arr.length > 0 ? arr : undefined;
}

function asBlessedRefs(value: unknown): HandoffBlessedRef[] {
  if (!Array.isArray(value)) return [];
  const out: HandoffBlessedRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const learningId = asTrimmedString((entry as any).learningId ?? (entry as any).learning_id);
    if (!learningId) continue;
    const note = asTrimmedString((entry as any).note);
    const ref: HandoffBlessedRef = { learningId };
    if (note) ref.note = note;
    out.push(ref);
  }
  return out;
}

const LINK_KINDS: ReadonlySet<HandoffPacketLink['kind']> = new Set([
  'commit',
  'pr',
  'url',
  'wiki',
]);

function asLinks(value: unknown): HandoffPacketLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: HandoffPacketLink[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const rawKind = (entry as any).kind;
    if (!LINK_KINDS.has(rawKind)) continue;
    const v = asTrimmedString((entry as any).value);
    if (!v) continue;
    const label = asTrimmedString((entry as any).label);
    const link: HandoffPacketLink = { kind: rawKind, value: v };
    if (label) link.label = label;
    out.push(link);
  }
  return out.length > 0 ? out : undefined;
}

// Normalize a raw body into a complete HandoffPacket. sessionId is taken
// from the URL param (not the body) to avoid "update one, write to another"
// bugs — callers pass it explicitly. createdAt defaults to now if absent.
export function normalizeHandoffPacket(
  sessionId: string,
  raw: any,
  nowIso: string = new Date().toISOString(),
): HandoffPacket {
  const packet: HandoffPacket = {
    sessionId,
    createdAt: asTrimmedString(raw?.createdAt) ?? nowIso,
    summary: asTrimmedString(raw?.summary) ?? '',
    whatShipped: asStringArray(raw?.whatShipped),
    whatBlessed: asBlessedRefs(raw?.whatBlessed),
    whatRemains: asStringArray(raw?.whatRemains),
  };
  const authoredBy = asTrimmedString(raw?.authoredBy);
  if (authoredBy) packet.authoredBy = authoredBy;
  const nextVerify = asOptionalStringArray(raw?.nextVerify);
  if (nextVerify) packet.nextVerify = nextVerify;
  const links = asLinks(raw?.links);
  if (links) packet.links = links;
  return packet;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
// Row ↔ packet mapping. We store the whole typed packet as JSON in a single
// column rather than normalizing. Rationale in schema.ts.

function rowToPacket(row: any): HandoffPacket {
  const parsed = JSON.parse(row.packetJson ?? '{}');
  // Defensive: re-normalize what came out of storage, so even if a malformed
  // row was ever written the caller still gets a well-shaped packet.
  return normalizeHandoffPacket(row.sessionId, parsed, row.createdAt);
}

export async function upsertHandoffPacket(
  ctx: HandoffOperationsContext,
  sessionId: string,
  raw: any,
): Promise<HandoffPacket> {
  const db = await ctx.initDB();
  // Use the incoming createdAt if present (lets callers replay historical
  // packets in order), otherwise stamp now.
  const now = new Date().toISOString();
  const packet = normalizeHandoffPacket(sessionId, raw, now);
  const authoredBy = packet.authoredBy ?? null;

  await db
    .insert(schema.handoffPackets)
    .values({
      sessionId,
      createdAt: packet.createdAt,
      authoredBy,
      packetJson: JSON.stringify(packet),
    })
    .onConflictDoUpdate({
      target: schema.handoffPackets.sessionId,
      set: {
        createdAt: packet.createdAt,
        authoredBy,
        packetJson: JSON.stringify(packet),
      },
    });

  return packet;
}

export async function getHandoffPacket(
  ctx: HandoffOperationsContext,
  sessionId: string,
): Promise<HandoffPacket | null> {
  const db = await ctx.initDB();
  const rows = await db
    .select()
    .from(schema.handoffPackets)
    .where(eq(schema.handoffPackets.sessionId, sessionId))
    .limit(1);
  if (!rows.length) return null;
  return rowToPacket(rows[0]);
}

export async function listHandoffPackets(
  ctx: HandoffOperationsContext,
  limit: number = HANDOFF_LIST_DEFAULT_LIMIT,
): Promise<HandoffPacket[]> {
  const db = await ctx.initDB();
  const capped = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : HANDOFF_LIST_DEFAULT_LIMIT;
  const rows = await db
    .select()
    .from(schema.handoffPackets)
    .orderBy(desc(schema.handoffPackets.createdAt))
    .limit(capped);
  return rows.map(rowToPacket);
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------
// Shape per spec:
//
//   # Session handoff — <sessionId>
//
//   **Created:** <createdAt>  **By:** <authoredBy>
//
//   <summary>
//
//   ## What shipped
//   - item 1
//
//   ## What was blessed
//   - <learningId>: <note>
//
//   ## What remains
//   - thread 1
//
//   ## Next agent should verify
//   - check X
//
//   ## Links
//   - commit abc123 — fix Y
//
// Empty sections are omitted entirely so an incoming agent doesn't have to
// scan through "## What remains\n- (none)" placeholders.

function formatLink(link: HandoffPacketLink): string {
  const labelSuffix = link.label ? ` — ${link.label}` : '';
  switch (link.kind) {
    case 'commit':
      return `commit ${link.value}${labelSuffix}`;
    case 'pr':
      return `pr ${link.value}${labelSuffix}`;
    case 'wiki':
      return `wiki ${link.value}${labelSuffix}`;
    case 'url':
    default:
      return `${link.value}${labelSuffix}`;
  }
}

export function renderHandoffMarkdown(packet: HandoffPacket): string {
  const lines: string[] = [];
  lines.push(`# Session handoff — ${packet.sessionId}`);
  lines.push('');
  const metaParts: string[] = [`**Created:** ${packet.createdAt}`];
  if (packet.authoredBy) metaParts.push(`**By:** ${packet.authoredBy}`);
  // Two-space join renders as a single metadata line in most markdown views.
  lines.push(metaParts.join('  '));
  if (packet.summary) {
    lines.push('');
    lines.push(packet.summary);
  }

  if (packet.whatShipped.length > 0) {
    lines.push('');
    lines.push('## What shipped');
    for (const item of packet.whatShipped) lines.push(`- ${item}`);
  }

  if (packet.whatBlessed.length > 0) {
    lines.push('');
    lines.push('## What was blessed');
    for (const ref of packet.whatBlessed) {
      lines.push(ref.note ? `- ${ref.learningId}: ${ref.note}` : `- ${ref.learningId}`);
    }
  }

  if (packet.whatRemains.length > 0) {
    lines.push('');
    lines.push('## What remains');
    for (const item of packet.whatRemains) lines.push(`- ${item}`);
  }

  if (packet.nextVerify && packet.nextVerify.length > 0) {
    lines.push('');
    lines.push('## Next agent should verify');
    for (const item of packet.nextVerify) lines.push(`- ${item}`);
  }

  if (packet.links && packet.links.length > 0) {
    lines.push('');
    lines.push('## Links');
    for (const link of packet.links) lines.push(`- ${formatLink(link)}`);
  }

  return lines.join('\n');
}
