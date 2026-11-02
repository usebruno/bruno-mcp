import fs from 'node:fs';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { VARIABLE_NAME_PATTERN, readEnvironmentVariables, setEnvironmentVariable } from '../core/environments.js';
import {
  collectionPathSchema,
  errorText,
  findEnvironment,
  textResult,
  unknownCollectionMessage,
  type ToolContext
} from './helpers.js';

export const registerSetEnvironmentVariableTool = (server: McpServer, { registry }: ToolContext): void => {
  server.registerTool(
    'set_environment_variable',
    {
      title: 'Set a Bruno environment variable',
      description:
        'Add a variable to an environment, or change an existing one, and save it to the environment file. ' +
        'A variable already marked secret is only changed when overwriteSecret is true. ' +
        'Bruno keeps secret values out of collection files, so for a secret variable only its name and enabled flag are written, never the value. ' +
        'To use a value for one run without saving it, pass it in "variables" to execute_request or run_collection instead.',
      inputSchema: {
        collectionPath: collectionPathSchema(),
        environment: z.string().describe('Environment name, as returned by list_environments. Case-sensitive.'),
        name: z
          .string()
          .regex(VARIABLE_NAME_PATTERN)
          .describe('Variable name, referenced in requests as {{name}}. Letters, digits, "_", "-" and "." only.'),
        value: z.union([z.string(), z.number(), z.boolean()]).describe('The value; stored as text, as Bruno stores every variable.'),
        enabled: z.boolean().optional().describe('Defaults to the variable\'s current setting, or true for a new one.'),
        secret: z
          .boolean()
          .optional()
          .describe('Mark the variable secret. Defaults to its current setting, or false for a new one.'),
        overwriteSecret: z.boolean().optional().describe('Must be true to change a variable that is already secret.')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ collectionPath, environment: environmentName, name, value, enabled, secret, overwriteSecret }) => {
      registry.refresh();
      const collection = registry.resolve(collectionPath);
      if (!collection) {
        return textResult(unknownCollectionMessage(registry, collectionPath), true);
      }

      const found = findEnvironment(registry, collection, environmentName);
      if ('error' in found) return found.error;
      const { environment } = found;

      try {
        const current = (await readEnvironmentVariables(environment)).find((v) => v.name === name);
        if (current?.secret && !overwriteSecret) {
          return textResult(
            {
              error: `"${name}" is a secret variable in the "${environment.name}" environment.`,
              hint: 'Pass overwriteSecret: true to change it, or pass the value in "variables" to execute_request or run_collection to use it for one run.'
            },
            true
          );
        }

        const update = {
          name,
          value: String(value),
          enabled: enabled ?? current?.enabled ?? true,
          secret: secret ?? current?.secret ?? false
        };
        const before = fs.readFileSync(environment.path, 'utf8');
        const content = await setEnvironmentVariable(environment, update);
        const wrote = content !== before;
        if (wrote) fs.writeFileSync(environment.path, content);

        return textResult({
          ok: true,
          environment: environment.name,
          name,
          wrote,
          created: !current,
          enabled: update.enabled,
          secret: update.secret,
          ...(update.secret
            ? {
                valueWritten: false,
                hint: 'Bruno keeps secret values out of collection files. Set the value in the Bruno app, or pass it in "variables" when running.'
              }
            : {})
        });
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
