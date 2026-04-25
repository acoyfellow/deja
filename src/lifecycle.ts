/**
 * Lifecycle helpers — session derivation, GC, trust bucketing.
 *
 * State machine:
 *   draft  -> kept     (via keep())
 *   draft  -> expired  (via forget() or 24h GC)
 *   kept   -> expired  (via forget() — explicit only)
 *
 * No state transitions back. Slips are append-only.
 */

import { ulid } from "./ulid.ts";
import type { Trust } from "./types.ts";

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Derive a stable session id for the current process.
 *
 * Priority:
 *   1. DEJA_SESSION env var (caller-controlled, e.g. an MCP wrapper)
 *   2. PID + start time (one session per process)
 *
 * Sessions don't need to map 1:1 to "agent conversations". They're a
 * grouping primitive — drafts in the same session can be promoted together.
 */
let _cachedSessionId: string | null = null;
export function currentSessionId(): string {
  if (_cachedSessionId) return _cachedSessionId;
  const fromEnv = process.env.DEJA_SESSION;
  _cachedSessionId = fromEnv && fromEnv.length > 0 ? fromEnv : ulid();
  return _cachedSessionId;
}

/** Test/CLI helper to reset memoized session. */
export function _resetSessionForTesting(): void {
  _cachedSessionId = null;
}

export function currentAuthor(): string {
  return process.env.DEJA_AUTHOR ?? "unknown-agent";
}

/**
 * Bucket a raw FTS5 BM25 score into a coarse trust label.
 * BM25 is "lower is better" — we invert the intuition for the agent.
 *
 * These thresholds are calibrated for the unicode61 tokenizer with
 * default k1/b. They're approximate; the goal is "obviously good /
 * obviously bad / it depends" not numerical precision.
 */
export function trustFromScore(score: number): Trust {
  // Note: bun:sqlite returns NEGATIVE bm25 scores by convention
  // (FTS5 negates so ORDER BY ASC = best first). So a "lower" score
  // is a more negative number = better match.
  if (score <= -2.5) return "high";
  if (score <= -1.0) return "medium";
  return "low";
}

/** ms cutoff for "drafts older than this should be expired". */
export function draftCutoff(now: number = Date.now()): number {
  return now - DRAFT_TTL_MS;
}

/**
 * Heuristic: does this slip text/tag combination look "chain-shaped"?
 *
 * Chain-shaped slips are ones a future agent picking up the work should
 * encounter. Decisions, preferences, work-in-progress, configuration —
 * anything where the *next* session would want to know about it.
 *
 * One-off facts ("the user once said the sky is blue") are not
 * chain-shaped. Project-shaping facts ("we're using bun for the runtime")
 * are.
 *
 * Used by `Deja.keep()` to decide whether to auto-rollup into a session
 * handoff. Conservative: the heuristic must be obvious enough that an
 * agent would not be surprised by the rollup.
 */
const CHAIN_TEXT_PATTERN =
  /\b(decision|decided|chose|prefer|preference|using|use this|setup|setting|configured|wip|in.progress|todo|next|will use|going to use|we picked|we chose)\b/i;
const CHAIN_TAG_PATTERN = /\b(decision|preference|wip|todo|setup|config|chain)\b/i;

export function isChainShaped(text: string, tags: string[]): boolean {
  if (CHAIN_TEXT_PATTERN.test(text)) return true;
  if (CHAIN_TAG_PATTERN.test(tags.join(" "))) return true;
  return false;
}
