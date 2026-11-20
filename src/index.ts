#!/usr/bin/env node
import { hideBin } from 'yargs/helpers';

import { parseArgs, validateConfig } from './config.js';
import { redirectConsoleLogToStderr, startStdioServer } from './transports/stdio.js';
import { discoverCollections } from './core/discover.js';
import * as log from './log.js';

const startServer = (argv: string[]) => {
  redirectConsoleLogToStderr();

  const { config, verbose } = parseArgs(argv);
  log.setVerbose(verbose);

  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const msg of errors) log.error(msg);
    process.exit(1);
  }

  const { collections, source, diagnostics } = discoverCollections(config);

  for (const d of diagnostics) log.debug(d);
  log.debug(`Found ${collections.length} collection${collections.length === 1 ? '' : 's'} (source: ${source ?? 'none'})`);

  if (collections.length === 0) {
    log.warn(
      source
        ? `No collections found. This server is scoped to ${source === 'explicit' ? 'the paths passed to --collection/--workspace' : source}. ` +
          'That scope holds no collections.'
        : 'No collections found. Available options:\n' +
          '  --collection <path>   Pass a collection path\n' +
          '  --workspace <path>    Pass a workspace path\n' +
          '  Or run from inside a Bruno project folder.\n' +
          'Auto-discovery checked recent collections but found none. ' +
          'Use --no-auto-discovery to skip this check.'
    );
  }

  // Started by hand in a terminal rather than by an MCP client: say what is going on instead of sitting silent.
  if (process.stdin.isTTY) {
    process.stderr.write(
      '[bruno-mcp] Waiting for an MCP client on stdin. To add Bruno MCP to your clients, run `npx @usebruno/mcp setup`. Ctrl+C to exit.\n'
    );
  }

  startStdioServer({ config }).catch((err) => {
    log.error(`Something went wrong while starting the server:\n${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
};

const argv = hideBin(process.argv);

if (argv[0] === 'setup') {
  const { runSetup } = await import('./setup/index.js');
  process.exitCode = await runSetup(argv.slice(1));
} else {
  startServer(argv);
}
