import type { APIRoute } from 'astro';
import { concepts, layers } from '../../data/research';

export const GET: APIRoute = async () => {
  const lines: string[] = [
    '# deja — Memory Interface Research',
    '',
    '> 20 explorations of how humans and agents might interact with persistent memory.',
    '> From filing cabinets to mycelial networks — charting the future of agent-human interfaces.',
    '> Full list: https://deja.coey.dev/research',
    '',
  ];

  for (const [layerId, layerInfo] of Object.entries(layers)) {
    const layerConcepts = concepts.filter(c => c.layer === layerId);
    lines.push(`## Layer ${layerId.toUpperCase()}: ${layerInfo.title}`, '');
    lines.push(`${layerInfo.subtitle}`, '');

    for (const concept of layerConcepts) {
      lines.push(`### ${String(concept.number).padStart(2, '0')}. ${concept.title}`);
      lines.push(`URL: https://deja.coey.dev/research/${concept.slug}`);
      lines.push(concept.description);
      lines.push('');
    }
  }

  lines.push('## Cross-cutting themes', '');
  lines.push('- Memory is not data — it has time, shape, health, relevance, narrative, causality, hierarchy, flow, contradiction, and topology');
  lines.push('- Push vs pull: most interfaces are pull-based; the most useful ones bring memory to you');
  lines.push('- Human-in-the-loop: the most interesting interfaces occupy the middle ground between fully autonomous and fully manual');
  lines.push('- Scope as design primitive: session/agent/shared appears in every concept differently');
  lines.push('');

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
