#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);

const steps = [
  { label: 'typecheck', cmd: 'bun', args: ['run', 'typecheck'], cwd: root },
  { label: 'worker tests', cmd: 'bun', args: ['run', 'test:worker'], cwd: root },
  { label: 'client tests', cmd: 'bun', args: ['run', 'test'], cwd: new URL('../packages/deja-client/', import.meta.url) },
  { label: 'marketing build', cmd: 'bun', args: ['run', 'build'], cwd: new URL('../marketing/', import.meta.url) },
];

for (const step of steps) {
  console.log(`\n==> ${step.label}`);
  const result = spawnSync(step.cmd, step.args, {
    cwd: step.cwd,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
