import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { cleanupSessionTmpDir } from '../../src/core/execute.js';
import {
  BRU_COLLECTION,
  YML_COLLECTION,
  callTool,
  connectClient,
  copyCollection,
  listFiles,
  makeTempDir,
  readFile,
  removeTempDirs,
  startHttpServer,
  writeFiles,
  type TestHttpServer
} from '../helpers.js';

// The end-to-end tests spawn the real `bru` CLI.
jest.setTimeout(60_000);

let client: Client;
let server: TestHttpServer;

beforeAll(async () => {
  [client, server] = await Promise.all([connectClient(), startHttpServer()]);
});

afterAll(async () => {
  await Promise.all([client.close(), server.close()]);
  cleanupSessionTmpDir();
});

beforeEach(() => {
  server.reset();
});

afterEach(removeTempDirs);

const write = (collectionPath: string, args: Record<string, unknown>) => callTool(client, 'write_request', { collectionPath, ...args });

describe('write_request', () => {
  it('creates a request named after "name" at the collection root, with the app\'s defaults', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);

    const { isError, body } = await write(collectionPath, { name: 'List charges' });

    expect(isError).toBe(false);
    expect(body).toEqual({ ok: true, writtenPaths: ['List charges.bru'], createdCount: 1, updatedCount: 0 });
    // seq follows the users folder and health.bru already at the root.
    expect(readFile(collectionPath, 'List charges.bru')).toBe(
      'meta {\n  name: List charges\n  type: http\n  seq: 3\n}\n\nget {\n  url: \n  body: none\n  auth: inherit\n}\n'
    );
  });

  it('creates missing folders and fills every field passed', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);

    await write(collectionPath, {
      requestPath: 'billing/create-charge',
      name: 'Create charge',
      method: 'post',
      url: '{{baseUrl}}/charges',
      headers: [{ name: 'Idempotency-Key', value: '{{key}}' }, { name: 'X-Debug', value: '1', enabled: false }],
      body: { mode: 'json', json: { amount: 500, currency: 'usd' } },
      auth: { mode: 'bearer', bearer: { token: '{{token}}' } },
      assert: [{ name: 'res.status', value: 'eq 201' }]
    });

    expect(readFile(collectionPath, 'billing/create-charge.bru')).toBe(
      'meta {\n  name: Create charge\n  type: http\n  seq: 1\n}\n\n' +
        'post {\n  url: {{baseUrl}}/charges\n  body: json\n  auth: bearer\n}\n\n' +
        'headers {\n  Idempotency-Key: {{key}}\n  ~X-Debug: 1\n}\n\n' +
        'auth:bearer {\n  token: {{token}}\n}\n\n' +
        'body:json {\n  {\n    "amount": 500,\n    "currency": "usd"\n  }\n}\n\n' +
        'assert {\n  res.status: eq 201\n}\n'
    );
  });

  it('changes only the fields passed, keeping tests, assertions and everything else', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);

    const { body } = await write(collectionPath, { requestPath: 'users/get-user.bru', method: 'PUT', headers: [{ name: 'Accept', value: 'application/json' }] });

    expect(body).toEqual({ ok: true, writtenPaths: [path.join('users', 'get-user.bru')], createdCount: 0, updatedCount: 1 });
    expect(readFile(collectionPath, 'users/get-user.bru')).toBe(
      'meta {\n  name: Get user\n  type: http\n  seq: 1\n}\n\n' +
        'put {\n  url: {{baseUrl}}/users/{{userId}}\n  body: none\n  auth: none\n}\n\n' +
        'headers {\n  Accept: application/json\n}\n\n' +
        'assert {\n  res.status: eq 200\n}\n\n' +
        'tests {\n  test("returns the user", function() {\n    expect(res.status).to.equal(200);\n  });\n}\n'
    );
  });

  it('keeps query and path params in sync with the URL, keeping path param values and disabled query params', async () => {
    const collectionPath = writeFiles(makeTempDir(), {
      'bruno.json': '{}',
      'charge.bru':
        'meta {\n  name: Charge\n  type: http\n  seq: 1\n}\n\nget {\n  url: {{baseUrl}}/charges/:id?expand=customer\n  body: none\n  auth: none\n}\n\n' +
        'params:query {\n  expand: customer\n  ~debug: true\n}\n\nparams:path {\n  id: ch_123\n}\n'
    });

    await write(collectionPath, { requestPath: 'charge.bru', url: '{{baseUrl}}/accounts/:account/charges/:id?limit=10&page=2' });

    expect(readFile(collectionPath, 'charge.bru')).toContain(
      'params:query {\n  limit: 10\n  page: 2\n  ~debug: true\n}\n\nparams:path {\n  account: \n  id: ch_123\n}\n'
    );
  });

  it('creates a GraphQL request when the body is graphql', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);

    await write(collectionPath, { name: 'Me', url: '{{baseUrl}}/graphql', body: { mode: 'graphql', graphql: { query: '{ me { id } }' } } });

    const parsed = await callTool(client, 'get_request', { collectionPath, requestPath: 'Me.bru' });
    expect(parsed.body.request).toMatchObject({
      type: 'graphql-request',
      request: { method: 'POST', body: { mode: 'graphql', graphql: { query: '{ me { id } }' } } }
    });
  });

  it.each([
    ['a graphql body on an HTTP request', 'users/get-user.bru', { body: { mode: 'graphql', graphql: { query: '{ a }' } } }, /needs a GraphQL request/],
    ['a ws request', 'stream.bru', { url: 'ws://other' }, /only edits HTTP and GraphQL requests; this one is a ws-request/]
  ])('refuses %s', async (_label, requestPath, edit, error) => {
    const collectionPath = copyCollection(BRU_COLLECTION);
    writeFiles(collectionPath, { 'stream.bru': 'meta {\n  name: Stream\n  type: ws\n  seq: 9\n}\n\nws {\n  url: ws://localhost\n}\n' });
    const before = readFile(collectionPath, requestPath);

    const { isError, body } = await write(collectionPath, { requestPath, ...edit });

    expect(isError).toBe(true);
    expect(body.error).toMatch(error);
    expect(readFile(collectionPath, requestPath)).toBe(before);
  });

  it('writes .yml collections, round-tripping through get_request', async () => {
    const collectionPath = copyCollection(YML_COLLECTION);

    const { body } = await write(collectionPath, {
      requestPath: 'users/create-user.yml',
      method: 'POST',
      url: '{{baseUrl}}/users',
      body: { mode: 'formUrlEncoded', formUrlEncoded: [{ name: 'email', value: 'a@b.c' }] },
      auth: { mode: 'apikey', apikey: { key: 'X-Api-Key', value: '{{apiKey}}', placement: 'header' } }
    });

    expect(body.writtenPaths).toEqual([path.join('users', 'create-user.yml')]);
    const parsed = await callTool(client, 'get_request', { collectionPath, requestPath: 'users/create-user.yml' });
    expect(parsed.body.request).toMatchObject({
      name: 'create-user',
      seq: 2,
      request: {
        method: 'POST',
        url: '{{baseUrl}}/users',
        body: { mode: 'formUrlEncoded', formUrlEncoded: [{ name: 'email', value: 'a@b.c', enabled: true }] },
        auth: { mode: 'apikey', apikey: { key: 'X-Api-Key', value: '{{apiKey}}', placement: 'header' } }
      }
    });
  });

  describe('with requests', () => {
    it('writes every request in one call, numbering new ones in order', async () => {
      const collectionPath = copyCollection(BRU_COLLECTION);

      const { body } = await write(collectionPath, {
        requests: [
          { requestPath: 'billing/a', url: '/a' },
          { requestPath: 'billing/b', url: '/b' },
          { requestPath: 'health.bru', name: 'Health check' }
        ]
      });

      expect(body).toEqual({ ok: true, writtenPaths: [path.join('billing', 'a.bru'), path.join('billing', 'b.bru'), 'health.bru'], createdCount: 2, updatedCount: 1 });
      expect(readFile(collectionPath, 'billing/a.bru')).toContain('seq: 1');
      expect(readFile(collectionPath, 'billing/b.bru')).toContain('seq: 2');
      expect(readFile(collectionPath, 'health.bru')).toContain('name: Health check');
    });

    it.each([
      ['an invalid item', [{ requestPath: 'ok.bru' }, { requestPath: '../outside.bru' }], /^requests\[1\]: Not a request path in this collection/],
      ['the same file twice', [{ requestPath: 'dup.bru' }, { name: 'dup' }], /^requests\[1\]: "dup.bru" is written more than once/],
      ['the same file twice in different case', [{ requestPath: 'billing/dup.bru' }, { requestPath: 'Billing/DUP.bru' }], /^requests\[1\]: ".*DUP.bru" is written more than once/]
    ])('writes nothing when there is %s', async (_label, requests, error) => {
      const collectionPath = copyCollection(BRU_COLLECTION);
      const before = listFiles(collectionPath);

      const { isError, body } = await write(collectionPath, { requests });

      expect(isError).toBe(true);
      expect(body).toMatchObject({ error: expect.stringMatching(error), hint: 'Nothing was written.' });
      expect(listFiles(collectionPath)).toEqual(before);
    });

    it('rejects requests combined with top-level request fields', async () => {
      const { isError, body } = await write(copyCollection(BRU_COLLECTION), { name: 'a', requests: [{ name: 'b' }] });

      expect(isError).toBe(true);
      expect(body.error).toBe('Pass either "requests" or the fields of a single request, not both.');
    });
  });

  it.each([
    ['nothing to write', {}, /^Nothing to write/],
    ['fields but no requestPath or name', { url: '/x' }, /^Pass requestPath to edit or create a request, or name/],
    ['a path outside the collection', { requestPath: '../escape.bru' }, /^Not a request path in this collection/],
    ['the environments folder', { requestPath: 'environments/prod.bru' }, /^Not a request path in this collection/],
    ['a folder file', { requestPath: 'users/folder.bru' }, /^Not a request path in this collection/],
    ['the other format\'s extension', { requestPath: 'charge.yml' }, /^This collection stores requests as \.bru files/],
    ['a folder', { requestPath: 'users.bru', name: 'x' }, /^Not a file/]
  ])('rejects %s', async (_label, args, error) => {
    const collectionPath = copyCollection(BRU_COLLECTION);
    fs.mkdirSync(path.join(collectionPath, 'users.bru'));
    const before = listFiles(collectionPath);

    const { isError, body } = await write(collectionPath, args);

    expect(isError).toBe(true);
    expect(body.error).toMatch(error);
    expect(listFiles(collectionPath)).toEqual(before);
  });

  it('rejects an unknown HTTP method', async () => {
    const { isError, text } = await write(copyCollection(BRU_COLLECTION), { name: 'x', method: 'FETCH' });

    expect(isError).toBe(true);
    expect(text).toMatch(/Input validation error: .*Expected one of GET, POST/);
  });

  it('reports a request file it can\'t parse without touching it', async () => {
    const collectionPath = writeFiles(makeTempDir(), { 'bruno.json': '{}', 'broken.bru': 'meta {\n  name: x\n' });

    const { isError, body } = await write(collectionPath, { requestPath: 'broken.bru', url: '/x' });

    expect(isError).toBe(true);
    expect(body.error).toMatch(/^Could not parse request "broken.bru"/);
    expect(readFile(collectionPath, 'broken.bru')).toBe('meta {\n  name: x\n');
  });

  it.each([
    ['yml', 'yml'],
    ['bru', 'bru']
  ])('writes a %s request that bru runs as written, against a new collection\'s {{baseUrl}}', async (format, ext) => {
    const collectionPath = path.join(makeTempDir(), 'shop');
    await callTool(client, 'create_collection', { name: 'Shop', outputPath: collectionPath, baseUrl: server.baseUrl, format });
    await write(collectionPath, {
      requestPath: 'orders/create',
      method: 'POST',
      url: '{{baseUrl}}/orders?dry=1',
      body: { mode: 'json', json: { sku: 'abc' } },
      auth: { mode: 'bearer', bearer: { token: 'tok' } },
      assert: [{ name: 'res.status', value: 'eq 200' }]
    });

    const { isError, body } = await callTool(client, 'execute_request', { collectionPath, requestPath: `orders/create.${ext}` });

    expect(isError).toBe(false);
    expect(body.assertionResults).toEqual([expect.objectContaining({ status: 'pass' })]);
    expect(server.received).toEqual([{ method: 'POST', url: '/orders?dry=1', authorization: 'Bearer tok', body: '{\n  "sku": "abc"\n}' }]);
  });
});
