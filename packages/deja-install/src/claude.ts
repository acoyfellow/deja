/**
 * Claude Code installer — stub.
 *
 * Claude Code stores MCP servers in `~/.claude.json` (user-global) or in
 * per-project `.mcp.json`. Injection logic is similar in shape to OpenCode
 * but the config schema + env-var interpolation differ: Claude Code uses
 * `env` / `args` on the command-line form and doesn't natively do
 * `{env:NAME}` substitution inside header values the way OpenCode does.
 *
 * Stubbing this out deliberately until someone actually wants it — shipping
 * half-working Claude support is worse than shipping none.
 */
import { log } from './util.js';

export const installClaude = async (): Promise<never> => {
  log.err('Claude Code installer not implemented yet.');
  log.plain('');
  log.plain('Claude Code\'s MCP config lives at:');
  log.plain('  ~/.claude.json                (user-global)');
  log.plain('  <project>/.mcp.json           (per-project)');
  log.plain('');
  log.plain('For now, add the deja block manually. See the README of this package');
  log.plain('for the OpenCode shape, and mirror it under Claude\'s schema.');
  log.plain('');
  log.plain('Track: https://github.com/acoyfellow/deja/issues');
  process.exit(2);
};

export const verifyClaude = installClaude;
export const rotateClaude = installClaude;
