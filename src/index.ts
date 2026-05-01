/**
 * deja — local-first agent memory.
 *
 * Four verbs:
 *   recall(query)              — find relevant slips, plus active handoff
 *   remember(text, opts?)      — jot a draft slip
 *   keep(ids)                  — promote drafts to kept (survives GC)
 *   handoff({summary, next?})  — close the session with a note for the next agent
 *
 * Three signals:
 *   forget(id)                 — expire a slip, regardless of state
 *   used(id)                   — record that a recalled slip was helpful
 *   wrong(id)                  — record that a recalled slip was misleading
 *
 * Agents jot for the next agent.
 */

import { Storage, defaultDbPath, type StorageOptions } from "./storage.ts";
import {
  currentAuthor,
  currentSessionId,
  draftCutoff,
  isChainShaped,
  trustFromScore,
} from "./lifecycle.ts";
import { ulid } from "./ulid.ts";
import type {
  Slip,
  Handoff,
  HandoffInput,
  RecallResult,
  RememberOpts,
  Trust,
  AgentMessage,
  SendInput,
} from "./types.ts";

export type {
  Slip,
  Handoff,
  HandoffInput,
  RecallResult,
  RememberOpts,
  Trust,
  AgentMessage,
  SendInput,
  MessageState,
} from "./types.ts";

export { defaultDbPath } from "./storage.ts";

export interface DejaOptions extends StorageOptions {
  /** Skip auto-GC of expired drafts on init. Default: false. */
  skipGc?: boolean;
  /**
   * Disable auto-rollup of chain-shaped kept slips into a session handoff.
   *
   * Default: false (auto-rollup ENABLED). When a slip is chain-shaped
   * (looks like a decision/preference/wip note) and gets promoted to kept,
   * deja will write a session handoff if one doesn't already exist. This
   * makes the slip discoverable on every `recall()` regardless of query —
   * slips need a matching query, handoffs are surfaced unconditionally.
   *
   * Set to true if you want strict separation between `keep` and `handoff`
   * — useful for tests or for callers managing the handoff lifecycle
   * manually.
   */
  noChainRollup?: boolean;
}

export interface KeepOptions {
  /** Override the auto-rollup decision for this call. */
  noChainRollup?: boolean;
}

export class Deja {
  readonly storage: Storage;
  readonly options: DejaOptions;

  constructor(opts: DejaOptions = {}) {
    this.storage = new Storage(opts);
    this.options = opts;
    if (!opts.skipGc) this.gc();
  }

  close(): void {
    this.storage.close();
  }

  /** Expire drafts older than 24h. Returns count expired. Idempotent. */
  gc(now: number = Date.now()): number {
    return this.storage.gcDrafts(draftCutoff(now), now);
  }

  // ---------- four verbs ----------

  /**
   * Recall slips relevant to `query`. Returns ranked hits + the active
   * handoff for the current session (if any).
   */
  recall(query: string, limit: number = 8): RecallResult {
    const sessionId = currentSessionId();
    const raw = this.storage.searchFts(query, limit);
    const hits = raw.map((r) => ({
      slip: r.slip,
      score: r.score,
      trust: trustFromScore(r.score),
    }));
    // Surface this session's handoff if it exists, otherwise fall back to
    // the most recent handoff from any prior session. Most prompts that
    // ask "what were we working on" come from a fresh session and want
    // the previous agent's signoff.
    const activeHandoff =
      this.storage.getHandoffBySession(sessionId) ??
      this.storage.latestHandoffs(1)[0] ??
      null;
    return { query, hits, activeHandoff };
  }

  /**
   * Jot a new draft slip. Returns the slip.
   * Drafts auto-expire after 24h unless promoted via keep().
   */
  remember(text: string, opts: RememberOpts = {}): Slip {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("deja.remember: text is empty");

    const now = Date.now();
    const slip: Slip = {
      id: ulid(now),
      sessionId: opts.sessionId ?? currentSessionId(),
      authoredBy: opts.authoredBy ?? currentAuthor(),
      text: trimmed,
      tags: opts.tags ?? [],
      state: "draft",
      createdAt: now,
      keptAt: null,
      expiredAt: null,
      usedCount: 0,
      wrongCount: 0,
    };
    this.storage.insertSlip(slip);

    if (opts.links) {
      for (const link of opts.links) {
        this.storage.insertLink({
          fromId: slip.id,
          toId: link.toId,
          kind: link.kind,
          createdAt: now,
        });
      }
    }
    return slip;
  }

  /**
   * Promote draft slips to kept. Returns the slips that were actually
   * promoted (drafts only; already-kept ids are skipped silently).
   *
   * If any of the promoted slips are "chain-shaped" (look like a decision,
   * preference, or wip note) and the current session has no handoff yet,
   * deja will auto-write a handoff that mentions them. This makes the
   * decision discoverable on every recall regardless of query. Disable
   * with `{ noChainRollup: true }` or via the `DejaOptions.noChainRollup`
   * constructor flag.
   */
  keep(ids: string[], opts: KeepOptions = {}): Slip[] {
    const now = Date.now();
    const promoted: Slip[] = [];
    for (const id of ids) {
      const s = this.storage.getSlip(id);
      if (!s) continue;
      if (s.state !== "draft") continue;
      this.storage.setState(id, "kept", now);
      promoted.push({ ...s, state: "kept", keptAt: now });
    }

    const skipRollup = opts.noChainRollup ?? this.options.noChainRollup ?? false;
    if (!skipRollup) this.maybeRollupHandoff(promoted);

    return promoted;
  }

  /**
   * If the slip set contains chain-shaped content and the current session
   * has no handoff, write one that surfaces these slips to the next agent.
   * Silent no-op otherwise. See {@link KeepOptions.noChainRollup} to disable.
   */
  private maybeRollupHandoff(slips: Slip[]): void {
    const chainSlips = slips.filter((s) => isChainShaped(s.text, s.tags));
    if (chainSlips.length === 0) return;

    // Only roll up for slips authored in the current session — don't
    // hijack another session's handoff slot.
    const sessionId = currentSessionId();
    const ours = chainSlips.filter((s) => s.sessionId === sessionId);
    if (ours.length === 0) return;

    if (this.storage.getHandoffBySession(sessionId)) return;

    // Synthesize a summary from the chain-shaped slips. Keep it short;
    // the full text is in the kept slips themselves.
    const summary = ours
      .map((s) => `[${s.id.slice(0, 8)}] ${s.text}`)
      .join("\n\n")
      .slice(0, 1200);

    try {
      this.handoff({ summary });
    } catch {
      // Race or other handoff conflict — drop the rollup. Slips are
      // still kept, so no data loss.
    }
  }

  /**
   * Close the current session with a handoff. One per session, enforced.
   * Any drafts referenced in `kept` are auto-promoted.
   */
  handoff(input: HandoffInput): Handoff {
    const summary = input.summary.trim();
    if (!summary) throw new Error("deja.handoff: summary is empty");

    const sessionId = input.sessionId ?? currentSessionId();
    const authoredBy = input.authoredBy ?? currentAuthor();

    const existing = this.storage.getHandoffBySession(sessionId);
    if (existing) {
      throw new Error(
        `deja.handoff: session ${sessionId} already has a handoff (${existing.id}). One handoff per session.`,
      );
    }

    // Promote everything kept-eligible in this session to kept,
    // collect the ids for the handoff packet.
    const sessionSlips = this.storage.listBySession(sessionId);
    const now = Date.now();
    const keptIds: string[] = [];
    for (const s of sessionSlips) {
      if (s.state === "draft") {
        this.storage.setState(s.id, "kept", now);
        keptIds.push(s.id);
      } else if (s.state === "kept") {
        keptIds.push(s.id);
      }
    }

    const h: Handoff = {
      id: ulid(now),
      sessionId,
      authoredBy,
      summary,
      kept: keptIds,
      next: input.next ?? [],
      createdAt: now,
    };
    this.storage.insertHandoff(h);
    return h;
  }

  // ---------- signals ----------

  /** Expire a slip regardless of state. Returns true if anything changed. */
  forget(id: string): boolean {
    const s = this.storage.getSlip(id);
    if (!s || s.state === "expired") return false;
    return this.storage.setState(id, "expired", Date.now());
  }

  /** Record that a recalled slip was helpful. */
  used(id: string): void {
    this.storage.bumpUsed(id);
  }

  /** Record that a recalled slip was misleading. */
  wrong(id: string): void {
    this.storage.bumpWrong(id);
  }

  // ---------- mailbox ----------

  send(input: SendInput): AgentMessage {
    const to = input.to.trim();
    const body = input.body.trim();
    if (!to) throw new Error("deja.send: to is empty");
    if (!body) throw new Error("deja.send: body is empty");
    const now = Date.now();
    const id = ulid(now);
    const msg: AgentMessage = {
      id,
      threadId: input.threadId ?? id,
      from: input.from ?? currentAuthor(),
      to,
      body,
      state: "pending",
      createdAt: now,
      readAt: null,
    };
    this.storage.insertMessage(msg);
    return msg;
  }

  inbox(to: string = currentAuthor(), opts: { limit?: number; includeRead?: boolean } = {}): AgentMessage[] {
    return this.storage.inbox(to, opts.limit ?? 20, opts.includeRead ?? false);
  }

  read(id: string): boolean {
    return this.storage.markMessage(id, "read", Date.now());
  }

  archive(id: string): boolean {
    return this.storage.markMessage(id, "archived", Date.now());
  }

  reply(id: string, body: string, from: string = currentAuthor()): AgentMessage {
    const row = this.storage.db
      .prepare(`SELECT thread_id, from_author FROM messages WHERE id = ?`)
      .get(id) as { thread_id: string; from_author: string } | null;
    if (!row) throw new Error(`deja.reply: message ${id} not found`);
    this.read(id);
    return this.send({ to: row.from_author, body, threadId: row.thread_id, from });
  }

  thread(threadId: string): AgentMessage[] {
    return this.storage.thread(threadId);
  }

  // ---------- introspection ----------

  get(id: string): Slip | null {
    return this.storage.getSlip(id);
  }

  listSession(sessionId?: string): Slip[] {
    return this.storage.listBySession(sessionId ?? currentSessionId());
  }

  listKept(limit: number = 50): Slip[] {
    return this.storage.listKept(limit);
  }

  latestHandoffs(limit: number = 5): Handoff[] {
    return this.storage.latestHandoffs(limit);
  }

  counts() {
    return this.storage.counts();
  }
}

/** Open a deja instance at the default path (~/.deja/deja.db). */
export function open(opts: DejaOptions = {}): Deja {
  return new Deja(opts);
}

/** Convenience: open a transient in-memory deja. Useful for tests/sandboxes. */
export function memory(): Deja {
  return new Deja({ path: ":memory:", skipGc: true });
}
