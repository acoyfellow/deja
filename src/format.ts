import { originLabel } from "./context.ts";
import type { Handoff, Link, RecallResult, Slip } from "./types.ts";

export interface RecallLinkProvider {
  linksFrom(id: string): Link[];
  linksTo(id: string): Link[];
}

export function formatRecall(
  r: RecallResult,
  links?: RecallLinkProvider,
): string {
  const parts: string[] = [];
  if (r.traceId) parts.push(`# recall receipt ${r.traceId}`);
  if (r.activeHandoff) {
    parts.push(formatHandoff(r.activeHandoff));
  }

  if ((r.readFirst ?? []).length > 0) {
    parts.push(`# read first\n${(r.readFirst ?? []).map((h) => {
      const why = h.nextAgent.reasons.length > 0 ? ` [${h.nextAgent.reasons.join(", ")}]` : "";
      return `- ${h.slip.id}${why}\n  ${h.slip.text.replace(/\n/g, "\n  ")}`;
    }).join("\n")}`);
  }

  if (r.hits.length === 0) {
    parts.push(
      `# recall("${r.query}") — no hits\nTry a broader or differently-phrased query (one or two words, synonyms) before falling back to general knowledge. If still nothing, the user has not recorded this yet — it is safe to ask them or proceed without memory.`,
    );
  } else {
    const hasHigh = r.hits.some((h) => h.trust === "high");
    const heading = hasHigh
      ? `# recall("${r.query}") — repeatedly useful memory found; still verify against live state`
      : `# recall("${r.query}")`;
    parts.push(heading);
    for (const h of r.hits) {
      const tags =
        h.slip.tags.length > 0 ? ` [${h.slip.tags.join(", ")}]` : "";
      const prefix =
        h.trust === "high"
          ? "**[high — repeatedly useful]**"
          : h.trust === "medium"
            ? "**[medium — kept, not yet confirmed]**"
            : "**[low — draft or disputed; verify]**";
      const provenance = formatProvenance(h.slip);
      const safety = formatLinkSafety(h.slip.id, links);
      const next = h.nextAgent && h.nextAgent.read !== "skip" ? ` next-agent:${h.nextAgent.read}/${h.nextAgent.reasons.join("+") || "reason"}` : "";
      parts.push(
        `- ${prefix} ${h.slip.id} · ${h.slip.kind}${tags}${next}\n  ${h.slip.text.replace(/\n/g, "\n  ")}\n  ${provenance}${safety}`,
      );
    }
  }
  return parts.join("\n\n");
}

/**
 * Format the "recents" view returned when recall is called with an
 * empty / whitespace query. No FTS, no scores — just the active handoff
 * (if any) plus the N most recent kept slips, in reverse-chron order.
 *
 * This is the "what was I doing" answer for fresh sessions where the
 * agent doesn't have a query yet.
 */
export function formatRecents(
  activeHandoff: Handoff | null,
  recent: Slip[],
  traceId?: string | null,
): string {
  const parts: string[] = [];
  if (traceId) parts.push(`# recall receipt ${traceId}`);
  if (activeHandoff) {
    parts.push(formatHandoff(activeHandoff));
  }
  if (recent.length === 0) {
    parts.push(
      `# recall(recents) — nothing kept yet\nNo prior memory in this DB. Ask the user, or proceed.`,
    );
  } else {
    parts.push(`# recall(recents) — ${recent.length} most recent kept slip(s)`);
    for (const s of recent) {
      const tags = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : "";
      parts.push(`- ${s.id} · ${s.kind}${tags}\n  ${s.text.replace(/\n/g, "\n  ")}\n  ${formatProvenance(s)}`);
    }
  }
  return parts.join("\n\n");
}

const STALE_HANDOFF_MS = 3 * 24 * 60 * 60 * 1000;
const STALE_HANDOFF_PREVIEW_CHARS = 100;

function formatHandoff(handoff: Handoff): string {
  const age = formatAge(handoff.createdAt);
  if (Date.now() - handoff.createdAt >= STALE_HANDOFF_MS) {
    return `# stale handoff · ${age} old · ${handoff.id} · ${previewLine(handoff.summary)}\nNot expanded. Resolve it with resolve_handoff, or recall its id to read it.`;
  }
  const next = handoff.next.length > 0
    ? `\n\nnext:\n${handoff.next.map((n) => `- ${n}`).join("\n")}`
    : "";
  return `# active handoff · ${age} old\n${handoff.summary}${next}`;
}

function previewLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > STALE_HANDOFF_PREVIEW_CHARS
    ? `${line.slice(0, STALE_HANDOFF_PREVIEW_CHARS)}…`
    : line;
}

function formatAge(createdAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatProvenance(slip: Slip): string {
  const created = new Date(slip.createdAt).toISOString();
  return `from: ${originLabel(slip.scope)} · source: ${slip.authoredBy} · scope: ${slip.scope} · session: ${slip.sessionId} · created: ${created} · used/wrong: ${slip.usedCount}/${slip.wrongCount}`;
}

function formatLinkSafety(id: string, links?: RecallLinkProvider): string {
  if (!links) return "";
  const linkNotes: string[] = [];
  for (const link of links.linksFrom(id)) {
    if (link.kind === "supersedes") linkNotes.push(`supersedes ${link.toId}`);
    if (link.kind === "contradicts") linkNotes.push(`contradicts ${link.toId}`);
  }
  for (const link of links.linksTo(id)) {
    if (link.kind === "supersedes") linkNotes.push(`superseded by ${link.fromId}`);
    if (link.kind === "contradicts") linkNotes.push(`contradicted by ${link.fromId}`);
  }
  return linkNotes.length > 0 ? `\n  links: ${linkNotes.join("; ")}` : "";
}
