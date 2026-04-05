const ENTITY_SEQUENCE_RE = /\b(?:[A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*)+)\b/g
const SERVICE_PATTERN_RE = /\bthe\s+([A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*)*\s+(?:service|api|database|worker|pipeline|gateway))\b/gi
const SUFFIX_PATTERN_RE = /\b([A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*)*\s+(?:Service|API|Database|Worker|Pipeline|Gateway))\b/g

function normalizeTag(tag: string): string {
  return tag.replace(/\s+/g, ' ').trim()
}

function addTag(tags: Map<string, string>, rawTag: string) {
  const tag = normalizeTag(rawTag)
  if (tag) tags.set(tag.toLowerCase(), tag)
}

export function extractEntityTags(...texts: Array<string | undefined>): string[] {
  const tags = new Map<string, string>()

  for (const text of texts) {
    if (!text) continue

    for (const match of text.matchAll(ENTITY_SEQUENCE_RE)) {
      const tag = normalizeTag(match[0] ?? '')
      addTag(tags, tag)
      const words = tag.split(' ')
      if (words.length > 2) {
        for (let size = 2; size < words.length; size += 1) {
          for (let start = 0; start + size <= words.length; start += 1) {
            addTag(tags, words.slice(start, start + size).join(' '))
          }
        }
      }
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
  const rightSet = new Set(right.map(tag => tag.toLowerCase()))
  let overlap = 0
  for (const tag of left) {
    if (rightSet.has(tag.toLowerCase())) overlap += 1
  }
  return overlap
}
