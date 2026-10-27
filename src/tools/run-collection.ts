import path from 'node:path';
import fs from 'node:fs';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { COLLECTION_TIMEOUT_MS, runCollection } from '../core/execute.js';
import {
  collectionPathSchema,
  errorText,
  textResult,
  unknownCollectionMessage,
  unknownEnvironmentMessage,
  variablesSchema,
  type ToolContext
} from './helpers.js';

const DATA_FILE_EXTENSIONS = ['.csv', '.json'];

const isDataFile = (filePath: string): boolean => {
  try {
    return DATA_FILE_EXTENSIONS.includes(path.extname(filePath).toLowerCase()) && fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
};

export const registerRunCollectionTool = (server: McpServer, { registry, verbose }: ToolContext): void => {
  server.registerTool(
    'run_collection',
    {
      title: 'Run a Bruno collection',
      description:
        'Run a whole collection, or a subset of its requests and folders, through Bruno\'s runner (same as `bru run`), applying the environment, scripts, assertions, tests, and configured auth. ' +
        'Supports multiple iterations, a CSV/JSON data file, parallel iterations, and stopping at the first failure. ' +
        'Returns a pass/fail summary plus a per-request roll-up (outcome, status, response time, failed assertions and tests). ' +
        'Headers and bodies are left out; use execute_request on a single request to see them.',
      inputSchema: {
        collectionPath: collectionPathSchema(),
        environment: z.string().optional().describe('Environment name to run against. Omit to run with no environment.'),
        requests: z
          .array(z.string())
          .optional()
          .describe(
            'Relative paths of requests (as returned by list_requests) and/or folders (e.g. "users") to run, in order. ' +
              'Folders run recursively. Omit to run the whole collection.'
          ),
        iterations: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Number of times to run the selection. Ignored when dataFile is set: one iteration runs per row.'),
        dataFile: z
          .string()
          .optional()
          .describe(
            'Path to a .csv or .json data file, absolute or relative to the collection directory. Each row becomes the variables for one iteration.'
          ),
        parallel: z.boolean().optional().describe('Run iterations in parallel instead of one after another.'),
        bail: z.boolean().optional().describe('Stop the run at the first failing request, assertion, or test.'),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`Stop the run if it takes longer than this. Defaults to ${COLLECTION_TIMEOUT_MS / 1000}.`),
        variables: variablesSchema()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ collectionPath, environment, requests, iterations, dataFile, parallel, bail, timeoutSeconds, variables }) => {
      registry.refresh();
      const collection = registry.resolve(collectionPath);
      if (!collection) {
        return textResult(unknownCollectionMessage(registry, collectionPath), true);
      }

      const unknownPaths = (requests || []).filter(
        (p) => !registry.resolveRequestPath(collectionPath, p) && !registry.resolveFolderPath(collectionPath, p)
      );
      if (unknownPaths.length > 0) {
        return textResult(
          {
            error: `Not a request or folder in collection "${collection.name}": ${unknownPaths.join(', ')}`,
            hint: 'Use relative paths from list_requests, or a folder that contains requests (e.g. "users"). Omit requests to run the whole collection.',
            availableRequests: (registry.listRequests(collectionPath) || []).map((r) => r.relativePath)
          },
          true
        );
      }

      if (environment) {
        const envs = registry.environments(collectionPath);
        if (!envs.includes(environment)) {
          return textResult(unknownEnvironmentMessage(collection, environment, envs), true);
        }
      }

      const dataFilePath = dataFile ? path.resolve(collection.path, dataFile) : undefined;
      if (dataFilePath && !isDataFile(dataFilePath)) {
        return textResult(
          {
            error: `Data file not found or not a .csv/.json file: ${dataFile}`,
            hint: 'Pass an absolute path, or one relative to the collection directory.'
          },
          true
        );
      }

      try {
        const result = await runCollection({
          collectionPath: collection.path,
          paths: requests,
          environment,
          variables,
          iterations,
          dataFile: dataFilePath,
          parallel,
          bail,
          timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
          verbose
        });
        return textResult(result, !result.ok);
      } catch (err: any) {
        return textResult({ error: `Something went wrong while running the collection: ${errorText(err)}` }, true);
      }
    }
  );
};
