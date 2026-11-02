import fs from 'node:fs';
import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { FORMAT_FILES, detectFormat, parseRequestFile } from '../core/readCollection.js';
import { nextSeq, serializeRequest } from '../core/requests.js';
import {
  collectionPathSchema,
  errorText,
  requestNotFoundMessage,
  requestPathSchema,
  textResult,
  unknownCollectionMessage,
  type ToolContext
} from './helpers.js';

export const registerMoveRequestTool = (server: McpServer, { registry }: ToolContext): void => {
  server.registerTool(
    'move_request',
    {
      title: 'Move or copy a Bruno request',
      description:
        'Move a request into another folder, or into another collection; pass copy: true to keep the original. ' +
        'The file keeps its name and goes last in the target folder. ' +
        'Moving between a .bru and a .yml collection converts the file. Never overwrites an existing request.',
      inputSchema: {
        collectionPath: collectionPathSchema(),
        requestPath: requestPathSchema('Relative path of the request to move, as returned by list_requests (e.g. "users/get-user.bru").'),
        targetCollectionPath: z
          .string()
          .optional()
          .describe('Absolute path of the collection to move into. Defaults to the same collection.'),
        targetFolder: z
          .string()
          .optional()
          .describe('Relative folder path in the target collection, as returned by list_folders; created if missing. Omit for the collection root.'),
        copy: z.boolean().optional().describe('Copy instead of move, leaving the original in place.')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ collectionPath, requestPath, targetCollectionPath, targetFolder = '', copy = false }) => {
      registry.refresh();
      const collection = registry.resolve(collectionPath);
      if (!collection) {
        return textResult(unknownCollectionMessage(registry, collectionPath), true);
      }
      const source = registry.resolveRequestPath(collection.path, requestPath);
      if (!source) {
        return textResult(requestNotFoundMessage(registry, collection, requestPath), true);
      }

      const target = targetCollectionPath ? registry.resolve(targetCollectionPath) : collection;
      if (!target) {
        return textResult(unknownCollectionMessage(registry, targetCollectionPath!), true);
      }
      const folder = registry.resolveFolderTarget(target.path, targetFolder);
      if (!folder) {
        return textResult(
          {
            error: `Not a folder path in collection "${target.name}": "${targetFolder}"`,
            hint: 'Use a relative folder path from list_folders, or omit targetFolder for the collection root.'
          },
          true
        );
      }

      const format = detectFormat(target.path)!;
      const fileName = path.basename(source.path, FORMAT_FILES[source.format].ext) + FORMAT_FILES[format].ext;
      const destination = registry.resolveRequestTarget(target.path, path.relative(target.path, path.join(folder, fileName)));
      if (!destination) {
        return textResult({ error: `Can't place "${fileName}" in "${targetFolder}" of collection "${target.name}".` }, true);
      }
      const from = path.relative(collection.path, source.path);
      const to = path.relative(target.path, destination.path);
      if (destination.path === source.path) {
        return textResult({ error: `"${from}" is already in that folder.` }, true);
      }
      if (fs.existsSync(destination.path)) {
        return textResult(
          { error: `A request already exists at "${to}" in collection "${target.name}".`, hint: 'Nothing was moved. Rename or delete one of them first.' },
          true
        );
      }

      try {
        const item = parseRequestFile(source.path, source.format);
        const content = serializeRequest({ ...item, seq: nextSeq(folder, target.path, format) }, format);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(destination.path, content);
        if (!copy) fs.unlinkSync(source.path);
      } catch (err: any) {
        return textResult({ error: `Could not ${copy ? 'copy' : 'move'} "${from}": ${errorText(err)}` }, true);
      }

      return textResult({
        ok: true,
        operation: copy ? 'copy' : 'move',
        from,
        to,
        ...(target.path !== collection.path ? { targetCollectionPath: target.path } : {})
      });
    }
  );
};
