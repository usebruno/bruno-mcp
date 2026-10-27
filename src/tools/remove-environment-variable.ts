import fs from 'node:fs';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { removeEnvironmentVariable } from '../core/environments.js';
import {
  collectionPathSchema,
  errorText,
  findEnvironment,
  textResult,
  unknownCollectionMessage,
  type ToolContext
} from './helpers.js';

export const registerRemoveEnvironmentVariableTool = (server: McpServer, { registry }: ToolContext): void => {
  server.registerTool(
    'remove_environment_variable',
    {
      title: 'Remove a Bruno environment variable',
      description:
        'Delete one variable from an environment file. ' +
        'Removing a variable that isn\'t there is not an error; the result says "removed": false.',
      inputSchema: {
        collectionPath: collectionPathSchema(),
        environment: z.string().describe('Environment name, as returned by list_environments. Case-sensitive.'),
        name: z.string().describe('Variable name, as returned by get_environment. Case-sensitive.')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ collectionPath, environment: environmentName, name }) => {
      registry.refresh();
      const collection = registry.resolve(collectionPath);
      if (!collection) {
        return textResult(unknownCollectionMessage(registry, collectionPath), true);
      }

      const found = findEnvironment(registry, collection, environmentName);
      if ('error' in found) return found.error;
      const { environment } = found;

      try {
        const content = await removeEnvironmentVariable(environment, name);
        if (content !== null) fs.writeFileSync(environment.path, content);
        return textResult({ ok: true, environment: environment.name, name, removed: content !== null });
      } catch (err: any) {
        return textResult(
          {
            error: `Could not update environment "${environment.name}": ${errorText(err)}`,
            hint: 'The environment file may be corrupted or invalid.'
          },
          true
        );
      }
    }
  );
};
