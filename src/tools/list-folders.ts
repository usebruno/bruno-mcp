import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { readCollectionIndex, readFolderTree, type FolderNode } from '../core/readCollection.js';
import { collectionPathSchema, textResult, unknownCollectionMessage, type ToolContext } from './helpers.js';

type ListedFolder = Omit<FolderNode, 'children'> & { children?: ListedFolder[]; truncated?: true };

const limitDepth = (folders: FolderNode[], depth: number): ListedFolder[] =>
  folders.map(({ children, ...folder }) => {
    if (depth > 1) return { ...folder, children: limitDepth(children, depth - 1) };
    return children.length > 0 ? { ...folder, truncated: true } : { ...folder, children: [] };
  });

export const registerListFoldersTool = (server: McpServer, { registry }: ToolContext): void => {
  server.registerTool(
    'list_folders',
    {
      title: 'List folders in a Bruno collection',
      description:
        'List the folder tree of a collection, with the number of requests under each folder (subfolders included). ' +
        'A folder path can be passed in run_collection "requests" to run everything under it. ' +
        'Pass depth to keep the response small on deep collections; folders cut off there have "truncated": true instead of children.',
      inputSchema: {
        collectionPath: collectionPathSchema(),
        depth: z.number().int().min(1).optional().describe('How many folder levels to return; 1 lists only top-level folders. Omit for the whole tree.')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ collectionPath, depth }) => {
      registry.refresh();
      const collection = registry.resolve(collectionPath);
      if (!collection) {
        return textResult(unknownCollectionMessage(registry, collectionPath), true);
      }

      const folders = readFolderTree(collection.path);
      const rootRequestCount = readCollectionIndex(collection.path).filter((r) => !r.relativePath.includes(path.sep)).length;
      return textResult({
        collectionPath: collection.path,
        collectionName: collection.name,
        rootRequestCount,
        ...(folders.length === 0 ? { hint: 'This collection has no folders; every request sits at its root.' } : {}),
        folders: depth ? limitDepth(folders, depth) : folders
      });
    }
  );
};
