/**
 * Cursor installer — stub.
 *
 * Cursor's MCP settings live under its app-support JSON (macOS:
 * ~/Library/Application Support/Cursor/User/settings.json; Linux:
 * ~/.config/Cursor/User/settings.json) keyed under `mcp.servers`.
 *
 * Not implemented yet — same reasoning as claude.ts.
 */
import { log } from './util.js';

export const installCursor = async (): Promise<never> => {
  log.err('Cursor installer not implemented yet.');
  log.plain('');
  log.plain('Cursor\'s MCP config lives at:');
  log.plain('  macOS:  ~/Library/Application Support/Cursor/User/settings.json');
  log.plain('  Linux:  ~/.config/Cursor/User/settings.json');
  log.plain('');
  log.plain('For now, add the deja block manually under `mcp.servers`.');
  log.plain('');
  log.plain('Track: https://github.com/acoyfellow/deja/issues');
  process.exit(2);
};

export const verifyCursor = installCursor;
export const rotateCursor = installCursor;
