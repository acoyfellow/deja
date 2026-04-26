import type { Link, RecallResult } from "./types.ts";

export interface RecallLinkProvider {
  linksFrom(id: string): Link[];
  linksTo(id: string): Link[];
}

export function formatRecall(
  r: RecallResult,
  links?: RecallLinkProvider,
): string {
  const parts: string[] = [];
  if (r.activeHandoff) {
    parts.push(
      `# previous handoff\n${r.activeHandoff.summary}` +
        (r.activeHandoff.next.length > 0
          ? `\n\nnext:\n${r.activeHandoff.next.map((n) => `- ${n}`).join("\n")}`
          : ""),
    );
  }

  if (r.hits.length === 0) {
    parts.push(
      `# recall("${r.query}") — no hits\nTry a broader or differently-phrased query (one or two words, synonyms) before falling back to general knowledge. If still nothing, the user has not recorded this yet — it is safe to ask them or proceed without memory.`,
    );
  } else {
    const hasHigh = r.hits.some((h) => h.trust === "high");
    const heading = hasHigh
      ? `# recall("${r.query}") — high-trust hit found, treat as authoritative`
      : `# recall("${r.query}")`;
    parts.push(heading);
    for (const h of r.hits) {
      const tags =
        h.slip.tags.length > 0 ? ` [${h.slip.tags.join(", ")}]` : "";
      const prefix =
        h.trust === "high"
          ? "**[high — the user recorded this]**"
          : h.trust === "medium"
            ? "**[medium]**"
            : "**[low — verify before relying on]**";
      const safety = formatLinkSafety(h.slip.id, links);
      parts.push(
        `- ${prefix} ${h.slip.id}${tags}\n  ${h.slip.text.replace(/\n/g, "\n  ")}${safety}`,
      );
    }
  }
  return parts.join("\n\n");
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
