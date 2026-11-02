import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { readEnvironmentVariables } from '../core/environments.js';
import { collectionPathSchema, errorText, textResult, unknownCollectionMessage, type ToolContext } from './helpers.js';

export const registerListEnvironmentsTool = (server: McpServer, { registry }: ToolContext): void => {
  server.registerTool(
    'list_environments',
    {
      title: 'List environments in a Bruno collection',
      description:
        'List every environment in the given collection with its variable count and whether it contains any secrets. ' +
        'Pass a name as "environment" to execute_request or run_collection, or call get_environment to see its variables.',
      inputSchema: {
        collectionPath: collectionPathSchema()
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ collectionPath }) => {
      registry.refresh();
      const collection = registry.resolve(collectionPath);
      if (!collection) {
        return textResult(unknownCollectionMessage(registry, collectionPath), true);
      }

      const environments = await Promise.all(registry.environmentFiles(collectionPath).map(async (env) => {
        try {
          const variables = await readEnvironmentVariables(env);
          return { name: env.name, variableCount: variables.length, hasSecrets: variables.some((v) => v.secret) };
        } catch (err: any) {
          return { name: env.name, error: `Could not parse environment: ${errorText(err)}` };
        }
      }));

      return textResult({
        ...(environments.length === 0
          ? { hint: 'This collection has no environments. Requests run without one.' }
          : {}),
        environments
      });
    }
  );
};
