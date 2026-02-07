import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const GET: APIRoute = async () => {
  const entries = (await getCollection('prompts')).sort((a, b) => a.data.order - b.data.order);

  const lines: string[] = [
    '# deja — Prompts',
    '',
    '> Ready-to-paste prompt templates for deja-enabled agents.',
    '> Full list: https://deja.coey.dev/prompts',
    '',
  ];

  for (const entry of entries) {
    lines.push(`## ${entry.data.title}`);
    lines.push(`URL: https://deja.coey.dev/prompts/${entry.id}`);
    lines.push(`Category: ${entry.data.category}`);
    lines.push(entry.data.agentSummary);
    lines.push('');
    lines.push('```');
    lines.push(entry.data.prompt);
    lines.push('```');
    lines.push('');
  }

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
