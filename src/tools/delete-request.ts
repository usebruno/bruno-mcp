import fs from 'node:fs';
import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { collectionPathSchema, errorText, textResult, unknownCollectionMessage, type ToolContext } from './helpers.js';

export const registerDeleteRequestTool = (server: McpServer, { registry }: ToolContext): void => {
  server.registerTool(
    'delete_request',
    {
      title: 'Delete Bruno requests',
      description:
        'Permanently delete one or more request files from a collection. Requires confirm: true. ' +
        'Every path is checked before anything is deleted; paths that are already gone are listed in "notFound" rather than failing the call. ' +
        'Folders, environments and collection files can\'t be deleted with this tool.',
      inputSchema: {
        collectionPath: collectionPathSchema(),
        requestPaths: z
          .array(z.string())
          .min(1)
          .describe('Relative paths of the requests to delete, as returned by list_requests (e.g. "users/get-user.bru").'),
        confirm: z.literal(true).describe('Must be true. Confirm with the user before deleting requests they didn\'t ask to remove.')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ collectionPath, requestPaths }) => {
      registry.refresh();
      const collection = registry.resolve(collectionPath);
      if (!collection) {
        return textResult(unknownCollectionMessage(registry, collectionPath), true);
      }

      const targets = new Map<string, string>();
      const invalid: string[] = [];
      for (const requestPath of requestPaths) {
        const target = registry.resolveRequestTarget(collection.path, requestPath);
        if (!target || (fs.existsSync(target.path) && !fs.statSync(target.path).isFile())) invalid.push(requestPath);
        else targets.set(target.path, path.relative(collection.path, target.path));
      }
      if (invalid.length > 0) {
        return textResult(
          {
            error: `Not a request in collection "${collection.name}": ${invalid.join(', ')}`,
            hint: 'Nothing was deleted. Use the exact relative paths from list_requests.'
          },
          true
        );
      }

      const deletedPaths: string[] = [];
      const notFound: string[] = [];
      try {
        for (const [target, relativePath] of targets) {
          if (!fs.existsSync(target)) {
            notFound.push(relativePath);
            continue;
          }
          fs.unlinkSync(target);
          deletedPaths.push(relativePath);
        }
      } catch (err: any) {
        return textResult({ error: `Could not delete requests: ${errorText(err)}`, deletedPaths }, true);
      }

      return textResult({
        ok: true,
        deleted: deletedPaths.length,
        deletedPaths,
        ...(notFound.length > 0 ? { notFound } : {})
      });
    }
  );
};
