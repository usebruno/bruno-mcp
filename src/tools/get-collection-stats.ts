import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { listEnvironmentFiles } from '../core/environments.js';
import { detectFormat, directorySizeBytes, readCollectionIndex, readFolderTree, type FolderNode } from '../core/readCollection.js';
import { HTTP_REQUEST_TYPES } from '../core/requests.js';
import { collectionPathSchema, textResult, unknownCollectionMessage, type ToolContext } from './helpers.js';

const countFolders = (folders: FolderNode[]): number =>
  folders.reduce((total, folder) => total + 1 + countFolders(folder.children), 0);

const tally = (values: (string | null)[]): Record<string, number> =>
  values.reduce<Record<string, number>>((counts, value) => {
    if (value) counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});

export const registerGetCollectionStatsTool = (server: McpServer, { registry }: ToolContext): void => {
  server.registerTool(
    'get_collection_stats',
    {
      title: 'Get Bruno collection stats',
      description:
        'Get aggregate numbers for a collection without listing it: request count by HTTP method and by type, folder count, environment count, and size on disk. ' +
        'Use this to size up a collection (a handful of requests or hundreds) before deciding whether to list it in full or filter.',
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

      const requests = readCollectionIndex(collection.path);
      const methodBearing = requests.filter((r) => r.type !== null && HTTP_REQUEST_TYPES.includes(r.type));
      return textResult({
        collectionPath: collection.path,
        collectionName: collection.name,
        format: detectFormat(collection.path),
        requestCount: requests.length,
        byMethod: tally(methodBearing.map((r) => r.method)),
        byType: tally(requests.map((r) => r.type)),
        folderCount: countFolders(readFolderTree(collection.path)),
        environmentCount: listEnvironmentFiles(collection.path).length,
        sizeBytes: directorySizeBytes(collection.path)
      });
    }
  );
};
