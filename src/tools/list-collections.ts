import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { filterCollections } from '../core/collections.js';
import { textResult, type ToolContext } from './helpers.js';

export const registerListCollectionsTool = (server: McpServer, { registry }: ToolContext): void => {
  server.registerTool(
    'list_collections',
    {
      title: 'List Bruno collections',
      description:
        'List all available Bruno collections: by default the ones this server was configured or discovered to expose. ' +
        'Returns the name, filesystem path, and available environments for each. ' +
        'Use this first to discover what collections exist and get the path needed for other tools. ' +
        'Optionally filter by a search term (matched against name, path, and workspace name).',
      inputSchema: {
        workspacePath: z
          .string()
          .optional()
          .describe(
            'Absolute path to a Bruno workspace folder (contains workspace.yml) to list collections from that workspace specifically. ' +
              'Any workspace on this machine works, so a path the user names in conversation can be passed straight through, ' +
              'unless the server was started with --collection/--workspace: then only those workspaces. ' +
              'Leave empty to list all collections the server knows about.'
          ),
        search: z
          .string()
          .optional()
          .describe('Filter collections by name (e.g., "payments" to find payment-related collections). Case-insensitive.')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ workspacePath, search }) => {
      registry.refresh();

      let workspace: { name: string; path: string } | null = null;
      let all;
      if (workspacePath) {
        if (registry.scoped && !registry.isConfiguredWorkspace(workspacePath)) {
          return textResult(
            {
              error: `This server is not configured for the workspace: ${workspacePath}`,
              hint: 'It is limited to the collections and workspaces passed with --collection/--workspace. Omit workspacePath to list them, or ask the user to add this workspace to the server config.'
            },
            true
          );
        }
        const listed = registry.listWorkspace(workspacePath);
        if (!listed) {
          return textResult(
            {
              error: `Not a Bruno workspace: ${workspacePath}`,
              hint: 'workspacePath must be the directory containing workspace.yml. Omit it to list the collections this server was configured or discovered to expose.'
            },
            true
          );
        }
        workspace = { name: listed.name, path: path.resolve(workspacePath) };
        all = listed.collections;
      } else {
        all = registry.list();
      }

      const collections = filterCollections(all, { search });
      const noMatch = search && collections.length === 0 && all.length > 0;
      return textResult({
        ...(workspace ? { workspace } : {}),
        total: all.length,
        count: collections.length,
        filter: { search: search || null },
        ...(noMatch
          ? { hint: `No collections matched "${search}". Try calling list_collections without the search filter to see all ${all.length} available collections.` }
          : {}),
        ...(workspace && all.length === 0
          ? { hint: 'This workspace doesn\'t have any collections yet.' }
          : {}),
        collections
      });
    }
  );
};
