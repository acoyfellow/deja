import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const GET: APIRoute = async () => {
  const entries = (await getCollection('patterns')).sort((a, b) => a.data.order - b.data.order);

  const lines: string[] = [
    '# deja — Patterns',
    '',
    '> Recipes for solving real problems with persistent agent memory.',
    '> Full list: https://deja.coey.dev/patterns',
    '',
  ];

  const byCategory = entries.reduce((acc, e) => {
    const cat = e.data.category;
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(e);
    return acc;
  }, {} as Record<string, typeof entries>);

  for (const [category, items] of Object.entries(byCategory)) {
    lines.push(`## ${category.replace(/-/g, ' ')}`, '');
    for (const entry of items) {
      lines.push(`### ${entry.data.title}`);
      lines.push(`URL: https://deja.coey.dev/patterns/${entry.id}`);
      lines.push(entry.data.agentSummary);
      lines.push('');
    }
  }

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
