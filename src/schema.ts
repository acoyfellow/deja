import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core';

export const learnings = sqliteTable('learnings', {
  id: text('id').primaryKey(),
  trigger: text('trigger').notNull(),
  learning: text('learning').notNull(),
  reason: text('reason'),
  confidence: real('confidence').default(1.0),
  source: text('source'),
  scope: text('scope').notNull(), // Added for scope support
  embedding: text('embedding'), // Vector embedding as JSON string
  createdAt: text('created_at').notNull(),
});

export const secrets = sqliteTable('secrets', {
  name: text('name').primaryKey(),
  value: text('value').notNull(),
  scope: text('scope').notNull(), // Added for scope support
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
