import fs from 'node:fs';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { parseRequestFile } from '../core/readCollection.js';
import { readScript, serializeRequest, withScript } from '../core/requests.js';
import {
  collectionPathSchema,
  errorText,
  requestNotFoundMessage,
  requestPathSchema,
  scriptTypeSchema,
  textResult,
  unknownCollectionMessage,
  type ToolContext
} from './helpers.js';

export const registerRemoveScriptTool = (server: McpServer, { registry }: ToolContext): void => {
  server.registerTool(
    'remove_script',
    {
      title: 'Remove a script from a Bruno request',
      description:
        'Clear one of a request\'s script blocks: pre-request, post-response, or tests. ' +
        'Removing a block that is already empty is not an error; the result says "removed": false.',
      inputSchema: {
        collectionPath: collectionPathSchema(),
        requestPath: requestPathSchema(),
        scriptType: scriptTypeSchema()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ collectionPath, requestPath, scriptType }) => {
      registry.refresh();
      const collection = registry.resolve(collectionPath);
      if (!collection) {
        return textResult(unknownCollectionMessage(registry, collectionPath), true);
      }
      const resolved = registry.resolveRequestPath(collection.path, requestPath);
      if (!resolved) {
        return textResult(requestNotFoundMessage(registry, collection, requestPath), true);
      }

      try {
        const item = parseRequestFile(resolved.path, resolved.format);
        const removed = readScript(item, scriptType).trim().length > 0;
        if (removed) fs.writeFileSync(resolved.path, serializeRequest(withScript(item, scriptType, ''), resolved.format));
        return textResult({ ok: true, scriptType, removed });
      } catch (err: any) {
        return textResult({ error: `Could not update request "${requestPath}": ${errorText(err)}` }, true);
      }
    }
  );
};
