import path from 'node:path';
import yargs from 'yargs/yargs';

import { isCollectionDir, isWorkspaceDir } from './core/discover.js';
import type { DiscoveryConfig } from './types.js';

export interface ParsedArgs {
  config: DiscoveryConfig;
  verbose: boolean;
  inheritEnv: boolean;
}

export const parseArgs = (argv: string[]): ParsedArgs => {
  const parsed = yargs(argv)
    .scriptName('bruno-mcp')
    .usage('Usage: $0 [--collection <path>] [--workspace <path>] [--no-cwd-discovery] [--no-auto-discovery] [--inherit-env]')
    .option('collection', {
      alias: 'c',
      type: 'array',
      describe: 'Path to a Bruno collection directory (contains bruno.json or opencollection.yml). Repeatable.',
      default: []
    })
    .option('workspace', {
      alias: 'w',
      type: 'array',
      describe: 'Path to a Bruno workspace directory (contains workspace.yml). Repeatable. Expands to all member collections.',
      default: []
    })
    .option('cwd-discovery', {
      type: 'boolean',
      describe: 'Walk up from the CWD looking for a Bruno collection or workspace. Pass --no-cwd-discovery to disable.',
      default: true
    })
    .option('auto-discovery', {
      type: 'boolean',
      describe:
        'Fall back on Bruno desktop preferences when nothing else is scoped (exposes every collection/workspace you last had open). On by default; pass --no-auto-discovery to disable and expose only what you explicitly scope.',
      default: true
    })
    .option('inherit-env', {
      type: 'boolean',
      describe:
        'Give requests this server\'s whole environment as {{process.env.*}}. Off by default, so a request can\'t read your shell secrets; the collection\'s .env file is always available.',
      default: false
    })
    .option('verbose', {
      type: 'boolean',
      describe: 'Log debug info to stderr',
      default: false
    })
    .epilogue('To add this server to Claude Code, Cursor, VS Code, Codex or Claude Desktop, run `npx @usebruno/mcp setup`.')
    .help()
    .alias('h', 'help')
    .parseSync();

  return {
    config: {
      explicitCollections: (parsed.collection || []).map((p) => path.resolve(String(p))),
      explicitWorkspaces: (parsed.workspace || []).map((p) => path.resolve(String(p))),
      cwdDiscovery: !!parsed['cwd-discovery'],
      autoDiscovery: !!parsed['auto-discovery']
    },
    verbose: !!parsed.verbose,
    inheritEnv: !!parsed['inherit-env']
  };
};

export const validateConfig = (config: DiscoveryConfig): string[] => {
  const errors: string[] = [];

  for (const p of config.explicitCollections) {
    if (!isCollectionDir(p)) {
      errors.push(`--collection path is not a Bruno collection (no bruno.json or opencollection.yml): ${p}`);
    }
  }
  for (const p of config.explicitWorkspaces) {
    if (!isWorkspaceDir(p)) {
      errors.push(`--workspace path is not a Bruno workspace (no workspace.yml): ${p}`);
    }
  }

  return errors;
};
