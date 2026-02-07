import type { APIRoute } from 'astro';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const GET: APIRoute = async () => {
  const readme = readFileSync(resolve(process.cwd(), '../README.md'), 'utf-8');

  return new Response(readme, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
