import path from 'node:path';

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { CollectionRegistry } from '../core/collections.js';
import { collectionsFromWorkspace, isWorkspaceDir } from '../core/discover.js';
import type { EnvironmentFile } from '../core/environments.js';
import { SCRIPT_TYPES } from '../core/requests.js';
import type { RegisteredCollection } from '../types.js';

export interface ToolContext {
  registry: CollectionRegistry;
  verbose: boolean;
}

export const textResult = (obj: unknown, isError = false): CallToolResult => ({
  content: [
    {
      type: 'text',
      text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
    }
  ],
  ...(isError ? { isError: true } : {})
});

export const unknownCollectionMessage = (registry: CollectionRegistry, collectionPath: string) => {
  const target = path.resolve(String(collectionPath || '.'));

  if (isWorkspaceDir(target)) {
    const members = collectionsFromWorkspace(target).map((c) => ({
      name: c.nameInWorkspace || path.basename(c.path),
      path: c.path
    }));
    return {
      error: `That is a Bruno workspace, not a collection: ${collectionPath}`,
      hint: members.length
        ? 'Pass one of the collections below as collectionPath, or call list_collections with "workspacePath" to list this workspace properly.'
        : 'This workspace lists no collections that exist on disk.',
      collectionsInWorkspace: members
    };
  }

  return {
    error: `No Bruno collection at: ${collectionPath}`,
    hint: 'collectionPath is the directory holding bruno.json or opencollection.yml. Any collection on this machine works; the list below is only what this server was configured or discovered to see.',
    availableCollections: registry.list().map((c) => ({ name: c.name, path: c.path }))
  };
};

export const unknownEnvironmentMessage = (
  collection: RegisteredCollection,
  environment: string,
  availableEnvironments: string[],
  hint = 'Environment names are case-sensitive. Omit environment to run without one.'
) => ({
  error: `The environment "${environment}" doesn't exist in the "${collection.name}" collection.`,
  hint,
  availableEnvironments
});

export const collectionPathSchema = () =>
  z
    .string()
    .describe(
      'Absolute path to the collection directory, the one containing bruno.json or opencollection.yml. ' +
        'Get this from list_collections, or use a path the user provides directly.'
    );

// Optional per-run variable overrides, shared by execute_request and run_collection.
export const variablesSchema = () =>
  z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'Override (or add) environment variables for this run, replacing any values from the environment.'
    );

export const errorText = (err: any): string => (err && err.message ? err.message : String(err));

export const requestNotFoundMessage = (registry: CollectionRegistry, collection: RegisteredCollection, requestPath: string) => ({
  error: `Request not found: "${requestPath}" in collection "${collection.name}"`,
  hint: 'Use the exact relative path from list_requests.',
  availableRequests: (registry.listRequests(collection.path) || []).map((r) => r.relativePath)
});

export const findEnvironment = (
  registry: CollectionRegistry,
  collection: RegisteredCollection,
  name: string
): { environment: EnvironmentFile } | { error: CallToolResult } => {
  const environments = registry.environmentFiles(collection.path);
  const environment = environments.find((env) => env.name === name);
  if (environment) return { environment };
  return {
    error: textResult(
      unknownEnvironmentMessage(collection, name, environments.map((env) => env.name), 'Environment names are case-sensitive.'),
      true
    )
  };
};

export const requestPathSchema = (description = 'Relative path of the request inside the collection, as returned by list_requests (e.g. "users/get-user.bru").') =>
  z.string().describe(description);

export const scriptTypeSchema = () =>
  z
    .enum(SCRIPT_TYPES)
    .describe('"pre-request" runs before the request is sent, "post-response" after the response arrives, "tests" holds test() blocks.');
