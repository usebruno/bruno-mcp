import fs from 'node:fs';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

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

const MAX_SCRIPT_BYTES = 50 * 1024;

export const registerAddTestScriptTool = (server: McpServer, { registry }: ToolContext): void => {
  server.registerTool(
    'add_test_script',
    {
      title: 'Add a script or tests to a Bruno request',
      description:
        'Add JavaScript to one of a request\'s script blocks: pre-request, post-response, or tests. ' +
        'By default the code is appended after what is already there; scriptMode "replace" overwrites the block. ' +
        'Scripts use Bruno\'s runtime API (req, res, bru, test, expect). A block is capped at 50 KB.',
      inputSchema: {
        collectionPath: collectionPathSchema(),
        requestPath: requestPathSchema(),
        scriptType: scriptTypeSchema(),
        script: z.string().min(1).describe('The JavaScript to add, e.g. test("returns 200", () => expect(res.status).to.equal(200));'),
        scriptMode: z.enum(['append', 'replace']).optional().describe('Defaults to "append".')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ collectionPath, requestPath, scriptType, script, scriptMode = 'append' }) => {
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
        const existing = readScript(item, scriptType).trimEnd();
        const code = scriptMode === 'append' && existing ? `${existing}\n\n${script}` : script;
        const bytes = Buffer.byteLength(code);
        if (bytes > MAX_SCRIPT_BYTES) {
          return textResult(
            { error: `The ${scriptType} script would be ${bytes} bytes, over the ${MAX_SCRIPT_BYTES}-byte limit.`, hint: 'Nothing was written.' },
            true
          );
        }

        fs.writeFileSync(resolved.path, serializeRequest(withScript(item, scriptType, code), resolved.format));
        return textResult({ ok: true, scriptType, scriptMode, wroteBytes: bytes });
      } catch (err: any) {
        return textResult({ error: `Could not update request "${requestPath}": ${errorText(err)}` }, true);
      }
    }
  );
};
