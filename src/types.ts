/**
 * Core types for deja.
 *
 * A slip is an atomic, immutable note authored by an agent.
 * State machine: draft -> kept -> expired (or draft -> expired via 24h GC).
 * Contradictions never mutate; they become new slips that link to the old.
 */

export type SlipState = "draft" | "kept" | "expired";

export type Trust = "high" | "medium" | "low";

export interface Slip {
  /** ULID — sortable, time-prefixed. */
  id: string;
  /** Session ULID this slip was authored in. */
  sessionId: string;
  /** Free-form agent identity. e.g. "claude-opus-4-7", "opencode/anomalyco". */
  authoredBy: string;
  /** The note itself. Plain text. Markdown allowed but not rendered by deja. */
  text: string;
  /** Tags — agent-chosen, free-form. */
  tags: string[];
  /** Lifecycle state. */
  state: SlipState;
  /** ms since epoch. */
  createdAt: number;
  /** ms since epoch. Set when state -> kept. */
  keptAt: number | null;
  /** ms since epoch. Set when state -> expired (manual forget or GC). */
  expiredAt: number | null;
  /** Free-form provenance trail — usage signals. */
  usedCount: number;
  wrongCount: number;
}

export type LinkKind =
  /** New slip supersedes old. Old is not auto-expired; reader sees both. */
  | "supersedes"
  /** New slip explicitly contradicts old. */
  | "contradicts"
  /** Soft "see also". */
  | "related";

export interface Link {
  fromId: string;
  toId: string;
  kind: LinkKind;
  createdAt: number;
}

export interface Handoff {
  /** ULID. One handoff per session, enforced. */
  id: string;
  sessionId: string;
  authoredBy: string;
  /** What happened, in the agent's voice. */
  summary: string;
  /** Slip ids that were promoted to kept as part of this handoff. */
  kept: string[];
  /** Optional: things the next agent should do or know first. */
  next: string[];
  createdAt: number;
}

export interface RecallHit {
  slip: Slip;
  /** Raw FTS5 BM25 score, lower is better. */
  score: number;
  /** Bucketed for the agent: high / medium / low. */
  trust: Trust;
}

export interface RecallResult {
  query: string;
  hits: RecallHit[];
  /** Active handoff for the current session, if any. */
  activeHandoff: Handoff | null;
}

export interface RememberOpts {
  tags?: string[];
  /** If set, this slip explicitly links to one or more existing slips. */
  links?: Array<{ toId: string; kind: LinkKind }>;
  /** Override session id. Default: derived from env / cwd / process. */
  sessionId?: string;
  /** Override author. Default: env DEJA_AUTHOR or "unknown-agent". */
  authoredBy?: string;
}

export interface HandoffInput {
  summary: string;
  next?: string[];
  /** Override session / author. */
  sessionId?: string;
  authoredBy?: string;
}

export type MessageState = "pending" | "read" | "archived";

export interface AgentMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  body: string;
  state: MessageState;
  createdAt: number;
  readAt: number | null;
}

export interface SendInput {
  to: string;
  body: string;
  threadId?: string;
  from?: string;
}
