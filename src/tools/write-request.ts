import fs from 'node:fs';
import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { CollectionRegistry } from '../core/collections.js';
import { FORMAT_FILES, detectFormat, parseRequestFile, type CollectionFormat } from '../core/readCollection.js';
import {
  HTTP_METHODS,
  applyRequestEdit,
  newRequestItem,
  nextSeq,
  requestEditError,
  sanitizeName,
  serializeRequest,
  type RequestEdit
} from '../core/requests.js';
import type { RegisteredCollection } from '../types.js';
import { collectionPathSchema, errorText, textResult, unknownCollectionMessage, type ToolContext } from './helpers.js';

const keyValueSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  enabled: z.boolean().optional().describe('Defaults to true.')
});

const bodySchema = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('none') }),
    z.object({
      mode: z.literal('json'),
      json: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).describe('JSON text, or a value to serialize.')
    }),
    z.object({ mode: z.literal('text'), text: z.string() }),
    z.object({ mode: z.literal('xml'), xml: z.string() }),
    z.object({ mode: z.literal('sparql'), sparql: z.string() }),
    z.object({ mode: z.literal('formUrlEncoded'), formUrlEncoded: z.array(keyValueSchema) }),
    z.object({ mode: z.literal('multipartForm'), multipartForm: z.array(keyValueSchema).describe('Text fields only.') }),
    z.object({
      mode: z.literal('graphql'),
      graphql: z.object({ query: z.string(), variables: z.string().optional().describe('JSON text.') })
    })
  ])
  .describe('Replaces the body. The field named after the mode holds the content, as get_request returns it, e.g. { "mode": "json", "json": "{...}" }.');

const authSchema = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('none') }),
    z.object({ mode: z.literal('inherit') }),
    z.object({ mode: z.literal('basic'), basic: z.object({ username: z.string(), password: z.string() }) }),
    z.object({ mode: z.literal('bearer'), bearer: z.object({ token: z.string() }) }),
    z.object({
      mode: z.literal('apikey'),
      apikey: z.object({ key: z.string(), value: z.string(), placement: z.enum(['header', 'queryparams']) })
    })
  ])
  .describe('Replaces the auth. "inherit" uses the folder or collection auth. Prefer {{variables}} over literal credentials.');

const requestFields = {
  requestPath: z
    .string()
    .optional()
    .describe(
      'Relative path of the request file in the collection, e.g. "charges/create.bru"; the extension may be left off. ' +
        'An existing request is updated; otherwise one is created there, with any missing folders. ' +
        'Omit to create a new request named after "name" at the collection root.'
    ),
  name: z.string().trim().min(1).optional().describe('Request name, as shown in Bruno. Defaults to the file name for a new request.'),
  method: z
    .string()
    .refine((m) => (HTTP_METHODS as readonly string[]).includes(m.toUpperCase()), { message: `Expected one of ${HTTP_METHODS.join(', ')}` })
    .optional()
    .describe('HTTP method. Defaults to GET for a new request (POST for GraphQL).'),
  url: z.string().optional().describe('Request URL, e.g. "{{baseUrl}}/charges/:id?expand=customer". Query and path params are kept in sync with it.'),
  headers: z.array(keyValueSchema).optional().describe('Replaces all headers.'),
  body: bodySchema.optional(),
  auth: authSchema.optional(),
  assert: z
    .array(keyValueSchema)
    .optional()
    .describe('Replaces all assertions, e.g. [{ "name": "res.status", "value": "eq 200" }].')
};

type RequestInput = { requestPath?: string } & RequestEdit;

interface PlannedWrite {
  relativePath: string;
  path: string;
  content: string;
  created: boolean;
}

const OTHER_FORMAT_EXT = /\.(bru|ya?ml)$/i;

const planWrite = (
  registry: CollectionRegistry,
  collection: RegisteredCollection,
  format: CollectionFormat,
  { requestPath, ...edit }: RequestInput,
  seqByDir: Map<string, number>
): PlannedWrite | { error: string } => {
  const { ext } = FORMAT_FILES[format];
  if (!requestPath && !edit.name) return { error: 'Pass requestPath to edit or create a request, or name to create one at the collection root.' };
  if (requestPath && !requestPath.endsWith(ext) && OTHER_FORMAT_EXT.test(requestPath)) {
    return { error: `This collection stores requests as ${ext} files: "${requestPath}"` };
  }

  const wanted = requestPath ? (requestPath.endsWith(ext) ? requestPath : requestPath + ext) : sanitizeName(edit.name!) + ext;
  const target = registry.resolveRequestTarget(collection.path, wanted);
  if (!target) {
    return { error: `Not a request path in this collection: "${wanted}". Requests go inside the collection, outside its environments folder.` };
  }
  const relativePath = path.relative(collection.path, target.path);

  const exists = fs.existsSync(target.path);
  if (exists && !fs.statSync(target.path).isFile()) return { error: `Not a file: "${relativePath}"` };

  let item: any;
  if (exists) {
    try {
      item = parseRequestFile(target.path, format);
    } catch (err: any) {
      return { error: `Could not parse request "${relativePath}": ${errorText(err)}` };
    }
  } else {
    const dir = path.dirname(target.path);
    const seq = seqByDir.get(dir) ?? nextSeq(dir, collection.path, format);
    seqByDir.set(dir, seq + 1);
    item = newRequestItem(edit.name ?? path.basename(target.path, ext), edit.body?.mode === 'graphql', seq);
  }

  const editError = requestEditError(item.type, edit);
  if (editError) return { error: `${relativePath}: ${editError}` };

  try {
    return { relativePath, path: target.path, content: serializeRequest(applyRequestEdit(item, edit), format), created: !exists };
  } catch (err: any) {
    return { error: `Could not write request "${relativePath}": ${errorText(err)}` };
  }
};

export const registerWriteRequestTool = (server: McpServer, { registry }: ToolContext): void => {
  server.registerTool(
    'write_request',
    {
      title: 'Create or edit Bruno requests',
      description:
        'Create a request, or edit an existing one, and save it to the collection. ' +
        'Only the fields passed change; headers, assert, body and auth replace what was there. ' +
        'Scripts and tests are kept as they are; use add_test_script to change them. ' +
        'To write several requests in one call, pass them in "requests"; every one is checked before any file is written. ' +
        'Edits HTTP and GraphQL requests only.',
      inputSchema: {
        collectionPath: collectionPathSchema(),
        ...requestFields,
        requests: z
          .array(z.object(requestFields))
          .min(1)
          .optional()
          .describe('Several requests to write, each with the same fields as a single one. Don\'t combine with the top-level request fields.')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ collectionPath, requests, ...single }) => {
      registry.refresh();
      const collection = registry.resolve(collectionPath);
      if (!collection) {
        return textResult(unknownCollectionMessage(registry, collectionPath), true);
      }

      const hasSingle = Object.values(single).some((value) => value !== undefined);
      if (requests && hasSingle) {
        return textResult({ error: 'Pass either "requests" or the fields of a single request, not both.' }, true);
      }
      if (!requests && !hasSingle) {
        return textResult({ error: 'Nothing to write: pass requestPath or name, plus the fields to set.' }, true);
      }

      const format = detectFormat(collection.path)!;
      const seqByDir = new Map<string, number>();
      const planned: PlannedWrite[] = [];
      for (const [index, input] of (requests ?? [single]).entries()) {
        const plan = planWrite(registry, collection, format, input, seqByDir);
        const label = requests ? `requests[${index}]: ` : '';
        if ('error' in plan) {
          return textResult({ error: label + plan.error, ...(requests ? { hint: 'Nothing was written.' } : {}) }, true);
        }
        // Case-insensitive, since on macOS and Windows "a/x.bru" and "A/x.bru" are the same file.
        if (planned.some((p) => p.path.toLowerCase() === plan.path.toLowerCase())) {
          return textResult({ error: `${label}"${plan.relativePath}" is written more than once in this call.`, hint: 'Nothing was written.' }, true);
        }
        planned.push(plan);
      }

      const writtenPaths: string[] = [];
      try {
        for (const plan of planned) {
          fs.mkdirSync(path.dirname(plan.path), { recursive: true });
          fs.writeFileSync(plan.path, plan.content);
          writtenPaths.push(plan.relativePath);
        }
      } catch (err: any) {
        return textResult({ error: `Could not write requests: ${errorText(err)}`, writtenPaths }, true);
      }

      return textResult({
        ok: true,
        writtenPaths,
        createdCount: planned.filter((p) => p.created).length,
        updatedCount: planned.filter((p) => !p.created).length
      });
    }
  );
};
