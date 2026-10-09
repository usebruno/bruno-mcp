import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from '../server.js';
import * as log from '../log.js';
import type { DiscoveryConfig } from '../types.js';

// Redirect console.log/info/debug to console.error to avoid corrupting the JSON-RPC stream.
export const redirectConsoleLogToStderr = (): void => {
  console.log = console.info = console.debug = console.error;
};

interface StartStdioServerArgs {
  config: DiscoveryConfig;
}

export const startStdioServer = async ({ config }: StartStdioServerArgs): Promise<void> => {
  const server = createServer({ config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.debug('stdio server ready');
};
