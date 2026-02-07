#!/usr/bin/env bun

/**
 * Scaffold a new MDX content file for the deja encyclopedia.
 *
 * Usage:
 *   bun run marketing/scripts/new-content.ts <collection> <slug>
 *
 * Example:
 *   bun run marketing/scripts/new-content.ts integration windsurf
 *   bun run marketing/scripts/new-content.ts pattern code-review-memory
 */

const templates: Record<string, (slug: string, title: string) => string> = {
  integration: (slug, title) => `---
title: "${title}"
description: "How to connect ${title} to deja for persistent agent memory."
keywords: "${slug}, deja, agent memory"
tags: ["${slug}"]
agentSummary: "${title} can connect to deja via MCP or REST API to give agents persistent memory across sessions."
featured: false
order: 50
category: "agent-framework"
difficulty: "beginner"
relatedIntegrations: []
relatedPatterns: []
---

## Why ${title} + deja?

TODO: Value proposition.

## Prerequisites

- A deployed deja instance
- ${title} installed and configured

## Setup

### Option 1: MCP

TODO: MCP configuration.

### Option 2: REST API

TODO: REST API setup.

### Option 3: deja-client

\`\`\`typescript
import deja from 'deja-client';

const mem = deja(process.env.DEJA_URL!);
\`\`\`

## Example

TODO: Concrete workflow walkthrough.

## What to learn, what to inject

| Trigger | Learning |
|---------|----------|
| TODO | TODO |

## Related

- [Patterns](/patterns)
- [Prompts](/prompts)
`,

  pattern: (slug, title) => `---
title: "${title}"
description: "TODO: Description of this pattern."
keywords: "${slug}, deja, pattern"
tags: ["${slug}"]
agentSummary: "TODO: One paragraph summary."
featured: false
order: 50
category: "recall"
difficulty: "beginner"
relatedPatterns: []
relatedIntegrations: []
---

## Overview

TODO: What this pattern solves.

## When to use

TODO: Conditions.

## Implementation

\`\`\`typescript
import deja from 'deja-client';

const mem = deja(process.env.DEJA_URL!);

// TODO: pattern code
\`\`\`

## Variations

TODO: Alternative approaches.
`,

  prompt: (slug, title) => `---
title: "${title}"
description: "TODO: Description."
tags: ["${slug}"]
agentSummary: "TODO: One paragraph summary."
order: 50
category: "system-prompt"
prompt: |
  TODO: The actual prompt text goes here.
---

## When to use

TODO: Context for this prompt.

## Customization

TODO: How to adapt it.
`,

  guide: (slug, title) => `---
title: "${title}"
description: "TODO: Description."
tags: ["${slug}"]
agentSummary: "TODO: One paragraph summary."
order: 50
category: "getting-started"
difficulty: "beginner"
estimatedReadTime: "5 min"
---

## Overview

TODO: Guide content.
`,

  'use-case': (slug, title) => `---
title: "${title}"
description: "TODO: Description."
tags: ["${slug}"]
agentSummary: "TODO: One paragraph summary."
order: 50
industry: "Engineering"
---

## The problem

TODO: What problem this solves.

## The solution

TODO: How deja helps.

## Walkthrough

TODO: Step by step.
`,
};

const collectionDirs: Record<string, string> = {
  integration: 'integrations',
  pattern: 'patterns',
  prompt: 'prompts',
  guide: 'guides',
  'use-case': 'use-cases',
};

const [collection, slug] = process.argv.slice(2);

if (!collection || !slug) {
  console.error('Usage: bun run marketing/scripts/new-content.ts <collection> <slug>');
  console.error('Collections: integration, pattern, prompt, guide, use-case');
  process.exit(1);
}

if (!templates[collection]) {
  console.error(`Unknown collection: ${collection}`);
  console.error(`Valid: ${Object.keys(templates).join(', ')}`);
  process.exit(1);
}

const title = slug
  .split('-')
  .map(w => w.charAt(0).toUpperCase() + w.slice(1))
  .join(' ');

const dir = collectionDirs[collection];
const filePath = `marketing/src/content/${dir}/${slug}.mdx`;
const content = templates[collection](slug, title);

await Bun.write(filePath, content);
console.log(`Created: ${filePath}`);
