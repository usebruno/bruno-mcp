import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { readEnvironmentVariables } from '../core/environments.js';
import {
  collectionPathSchema,
  errorText,
  findEnvironment,
  textResult,
  unknownCollectionMessage,
  type ToolContext
} from './helpers.js';

export const registerGetEnvironmentTool = (server: McpServer, { registry }: ToolContext): void => {
  server.registerTool(
    'get_environment',
    {
      title: 'Read a Bruno environment',
      description:
        'Gets the variables of one environment in a collection: name, value, and whether each is enabled or secret. ' +
        'Secret variables come back with their value as "<redacted>"; the names stay visible so they can still be referenced as {{name}}. ' +
        'Use this to see what {{variables}} in a request resolve to before running it.',
      inputSchema: {
        collectionPath: collectionPathSchema(),
        name: z.string().describe('Environment name, as returned by list_environments. Case-sensitive.')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ collectionPath, name }) => {
      registry.refresh();
      const collection = registry.resolve(collectionPath);
      if (!collection) {
        return textResult(unknownCollectionMessage(registry, collectionPath), true);
      }

      const found = findEnvironment(registry, collection, name);
      if ('error' in found) return found.error;
      const { environment } = found;

      try {
        return textResult({
          name: environment.name,
          variables: await readEnvironmentVariables(environment)
        });
      } catch (err: any) {
        return textResult(
          {
            error: `Could not parse environment "${name}": ${errorText(err)}`,
            hint: 'The file may be corrupted or invalid.'
          },
          true
        );
      }
    }
  );
};
