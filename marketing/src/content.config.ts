import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const baseSchema = z.object({
  title: z.string(),
  description: z.string(),
  keywords: z.string().optional(),
  tags: z.array(z.string()).default([]),
  publishedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  agentSummary: z.string(),
  featured: z.boolean().default(false),
  order: z.number().default(50),
});

const integrations = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/integrations' }),
  schema: baseSchema.extend({
    category: z.enum([
      'agent-framework',
      'code-assistant',
      'llm-provider',
      'orchestration',
      'ci-cd',
      'communication',
      'mcp-server',
      'protocol',
    ]),
    logo: z.string().optional(),
    difficulty: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner'),
    relatedIntegrations: z.array(z.string()).default([]),
    relatedPatterns: z.array(z.string()).default([]),
  }),
});

const patterns = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/patterns' }),
  schema: baseSchema.extend({
    category: z.enum([
      'recall',
      'learning',
      'multi-agent',
      'human-in-loop',
      'steering',
      'maintenance',
      'organization',
      'debugging',
    ]),
    difficulty: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner'),
    relatedPatterns: z.array(z.string()).default([]),
    relatedIntegrations: z.array(z.string()).default([]),
  }),
});

const prompts = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/prompts' }),
  schema: baseSchema.extend({
    category: z.enum([
      'system-prompt',
      'mcp-config',
      'agent-instruction',
      'loop-template',
      'steering',
    ]),
    prompt: z.string(),
  }),
});

const guides = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/guides' }),
  schema: baseSchema.extend({
    category: z.enum([
      'getting-started',
      'architecture',
      'security',
      'performance',
      'scaling',
    ]),
    difficulty: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner'),
    estimatedReadTime: z.string().optional(),
  }),
});

const useCases = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/use-cases' }),
  schema: baseSchema.extend({
    industry: z.string().optional(),
  }),
});

export const collections = { integrations, patterns, prompts, guides, 'use-cases': useCases };
