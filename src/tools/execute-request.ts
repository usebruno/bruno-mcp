import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { executeRequest } from '../core/execute.js';
import {
  collectionPathSchema,
  errorText,
  requestNotFoundMessage,
  requestPathSchema,
  textResult,
  unknownCollectionMessage,
  unknownEnvironmentMessage,
  variablesSchema,
  type ToolContext
} from './helpers.js';

// Pattern to detect template variables like {{variableName}}
const TEMPLATE_VAR = /\{\{\s*[^}\s]+\s*\}\}/;

const hasUnresolvedVariables = (result: any): boolean => {
  const url = result && result.request ? result.request.url : null;
  return typeof url === 'string' && TEMPLATE_VAR.test(url);
};

export const registerExecuteRequestTool = (server: McpServer, { registry, verbose }: ToolContext): void => {
  server.registerTool(
    'execute_request',
    {
      title: 'Execute a Bruno request',
      description:
        'Execute a named request from a Bruno collection through Bruno\'s runtime, applying the collection\'s environment variables, scripts, assertions, tests, and configured auth. ' +
        'Returns the status, request and response headers, response body in full, and assertion/test results. ' +
        'Returns the HTTP status, headers, response body, and any test results.',
      inputSchema: {
        collectionPath: collectionPathSchema(),
        requestPath: requestPathSchema(),
        environment: z.string().optional().describe('Environment name to run against. Omit to run with no environment.'),
        variables: variablesSchema()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ collectionPath, requestPath, environment, variables }) => {
      registry.refresh();
      const collection = registry.resolve(collectionPath);
      if (!collection) {
        return textResult(unknownCollectionMessage(registry, collectionPath), true);
      }

      if (!registry.resolveRequestPath(collectionPath, requestPath)) {
        return textResult(requestNotFoundMessage(registry, collection, requestPath), true);
      }

      if (environment) {
        const envs = registry.environments(collectionPath);
        if (!envs.includes(environment)) {
          return textResult(unknownEnvironmentMessage(collection, environment, envs), true);
        }
      }

      try {
        const result = await executeRequest({
          collectionPath: collection.path,
          requestPath,
          environment,
          variables,
          verbose
        });
        const needsEnvironment = !result.ok && !environment && hasUnresolvedVariables(result);
        return textResult(
          {
            ...result,
            ...(needsEnvironment
              ? { hint: 'No environment was selected.', availableEnvironments: registry.environments(collectionPath) }
              : {})
          },
          !result.ok
        );
      } catch (err: any) {
        return textResult({ error: `Something went wrong while running the request: ${errorText(err)}` }, true);
      }
    }
  );
};
