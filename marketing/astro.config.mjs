import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
export default defineConfig({
  site: 'https://deja.coey.dev',
  outDir: '../public',
  integrations: [mdx(), sitemap()],
  vite: {
    plugins: [tailwindcss()],
    server: {
      proxy: {
        '/learn': 'http://localhost:8787',
        '/inject': 'http://localhost:8787',
        '/query': 'http://localhost:8787',
        '/stats': 'http://localhost:8787',
        '/learnings': 'http://localhost:8787',
        '/mcp': 'http://localhost:8787',
      },
    },
  },
});
