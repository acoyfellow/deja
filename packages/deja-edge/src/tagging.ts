const ENTITY_SEQUENCE_RE = /\b(?:[A-Z][A-Za-z0-9-]+(?:\s+[A-Z][A-Za-z0-9-]+)+)\b/g
const SERVICE_PATTERN_RE = /\bthe\s+([A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*)*\s+(?:service|api|database|worker|pipeline|gateway))\b/gi
const SUFFIX_PATTERN_RE = /\b([A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*)*\s+(?:Service|API|Database|Worker|Pipeline|Gateway))\b/g

function normalizeTag(tag: string): string {
  return tag.replace(/\s+/g, ' ').trim()
}

function addTag(tags: Map<string, string>, tag: string) {
  const normalized = normalizeTag(tag)
  if (!normalized) return
  tags.set(normalized.toLowerCase(), normalized)

  const parts = normalized.split(' ')
  if (parts.length >= 3) {
    for (let size = parts.length - 1; size >= 2; size--) {
      for (let start = 0; start <= parts.length - size; start++) {
        const subphrase = normalizeTag(parts.slice(start, start + size).join(' '))
        tags.set(subphrase.toLowerCase(), subphrase)
      }
    }
  }
}

export function extractEntityTags(...texts: Array<string | undefined>): string[] {
  const tags = new Map<string, string>()

  for (const text of texts) {
    if (!text) continue

    for (const match of text.matchAll(ENTITY_SEQUENCE_RE)) {
      addTag(tags, match[0] ?? '')
    }

    for (const match of text.matchAll(SERVICE_PATTERN_RE)) {
      addTag(tags, match[1] ?? '')
    }

    for (const match of text.matchAll(SUFFIX_PATTERN_RE)) {
      addTag(tags, match[1] ?? '')
    }
  }

  return Array.from(tags.values())
}

export function countTagOverlap(left: string[] = [], right: string[] = []): number {
  if (left.length === 0 || right.length === 0) return 0
  const normalizedRight = right.map(tag => tag.toLowerCase())
  let overlap = 0
  for (const tag of left) {
    const normalizedTag = tag.toLowerCase()
    if (normalizedRight.some(other => other === normalizedTag || other.includes(normalizedTag) || normalizedTag.includes(other))) {
      overlap += 1
    }
  }
  return overlap
}
