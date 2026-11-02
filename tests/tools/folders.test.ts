import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { YML_COLLECTION, callTool, connectClient, makeTempDir, removeTempDirs, writeFiles } from '../helpers.js';

const request = (name: string, method = 'get', seq = 1) =>
  `meta {\n  name: ${name}\n  type: http\n  seq: ${seq}\n}\n\n${method} {\n  url: http://localhost/${name}\n}\n`;

// Folders are ordered by folder.bru seq, then name; "billing" names itself "Billing & Payments".
const makeCollection = () =>
  writeFiles(makeTempDir(), {
    'bruno.json': '{"version":"1","name":"Shop"}',
    'ping.bru': request('ping'),
    'users/list.bru': request('list'),
    'users/admin/create.bru': request('create', 'post'),
    'users/admin/audit/read.bru': request('read'),
    'billing/folder.bru': 'meta {\n  name: Billing & Payments\n  seq: 1\n}\n',
    'billing/charge.bru': request('charge', 'post'),
    'billing/refund.bru': request('refund', 'delete', 2),
    'empty/.keep': '',
    'environments/local.bru': 'vars {\n  a: 1\n}\n',
    '.git/HEAD': 'ref: refs/heads/main\n',
    'node_modules/pkg/index.bru': request('pkg')
  });

let client: Client;

beforeAll(async () => {
  client = await connectClient();
});

afterAll(async () => {
  await client.close();
});

afterEach(removeTempDirs);

describe('list_folders', () => {
  it('returns the folder tree with recursive request counts, skipping environments, .git and node_modules', async () => {
    const collectionPath = makeCollection();

    const { isError, body } = await callTool(client, 'list_folders', { collectionPath });

    expect(isError).toBe(false);
    expect(body).toEqual({
      collectionPath,
      collectionName: 'Shop',
      rootRequestCount: 1,
      folders: [
        { name: 'Billing & Payments', path: 'billing', requestCount: 2, children: [] },
        { name: 'empty', path: 'empty', requestCount: 0, children: [] },
        {
          name: 'users',
          path: 'users',
          requestCount: 3,
          children: [
            {
              name: 'admin',
              path: path.join('users', 'admin'),
              requestCount: 2,
              children: [{ name: 'audit', path: path.join('users', 'admin', 'audit'), requestCount: 1, children: [] }]
            }
          ]
        }
      ]
    });
  });

  it('cuts the tree at depth and marks folders whose children were left out', async () => {
    const { body } = await callTool(client, 'list_folders', { collectionPath: makeCollection(), depth: 1 });

    expect(body.folders).toEqual([
      { name: 'Billing & Payments', path: 'billing', requestCount: 2, children: [] },
      { name: 'empty', path: 'empty', requestCount: 0, children: [] },
      { name: 'users', path: 'users', requestCount: 3, truncated: true }
    ]);
  });

  it('counts only a folder\'s own requests, not those of a sibling sharing its name as a prefix', async () => {
    const collectionPath = writeFiles(makeTempDir(), {
      'bruno.json': '{}',
      'users/a.bru': request('a'),
      'users-legacy/b.bru': request('b'),
      'users-legacy/c.bru': request('c')
    });

    const { body } = await callTool(client, 'list_folders', { collectionPath });

    expect(body.folders.map((f: any) => [f.path, f.requestCount])).toEqual([['users', 1], ['users-legacy', 2]]);
  });

  it('works for .yml collections', async () => {
    const { body } = await callTool(client, 'list_folders', { collectionPath: YML_COLLECTION });

    expect(body).toMatchObject({ rootRequestCount: 0, folders: [{ name: 'users', path: 'users', requestCount: 1, children: [] }] });
  });

  it('adds a hint when the collection has no folders', async () => {
    const collectionPath = writeFiles(makeTempDir(), { 'bruno.json': '{}', 'ping.bru': request('ping') });

    const { body } = await callTool(client, 'list_folders', { collectionPath });

    expect(body).toMatchObject({ rootRequestCount: 1, folders: [], hint: expect.stringMatching(/no folders/) });
  });

  it('rejects depth below one', async () => {
    const { isError, text } = await callTool(client, 'list_folders', { collectionPath: YML_COLLECTION, depth: 0 });

    expect(isError).toBe(true);
    expect(text).toMatch(/Input validation error: .*depth/);
  });

  it('errors for a path that is not a collection', async () => {
    const { isError, body } = await callTool(client, 'list_folders', { collectionPath: makeTempDir() });

    expect(isError).toBe(true);
    expect(body.error).toMatch(/^No Bruno collection at/);
  });
});

describe('get_collection_stats', () => {
  it('counts requests by method and type, folders, environments, and bytes on disk outside .git and node_modules', async () => {
    const collectionPath = makeCollection();
    writeFiles(collectionPath, { 'stream.bru': 'meta {\n  name: Stream\n  type: ws\n  seq: 9\n}\n\nws {\n  url: ws://localhost\n}\n' });
    const counted = ['bruno.json', 'ping.bru', 'stream.bru', 'users/list.bru', 'users/admin/create.bru', 'users/admin/audit/read.bru',
      'billing/folder.bru', 'billing/charge.bru', 'billing/refund.bru', 'empty/.keep', 'environments/local.bru'];
    const sizeBytes = counted.reduce((total, file) => total + fs.statSync(path.join(collectionPath, file)).size, 0);

    const { isError, body } = await callTool(client, 'get_collection_stats', { collectionPath });

    expect(isError).toBe(false);
    expect(body).toEqual({
      collectionPath,
      collectionName: 'Shop',
      format: 'bru',
      requestCount: 7,
      byMethod: { GET: 3, POST: 2, DELETE: 1 },
      byType: { 'http-request': 6, 'ws-request': 1 },
      folderCount: 5,
      environmentCount: 1,
      sizeBytes
    });
  });

  it('works for .yml collections', async () => {
    const { body } = await callTool(client, 'get_collection_stats', { collectionPath: YML_COLLECTION });

    expect(body).toMatchObject({ format: 'yml', requestCount: 1, byMethod: { GET: 1 }, folderCount: 1, environmentCount: 1 });
  });

  it('errors for a path that is not a collection', async () => {
    const { isError, body } = await callTool(client, 'get_collection_stats', { collectionPath: makeTempDir() });

    expect(isError).toBe(true);
    expect(body.error).toMatch(/^No Bruno collection at/);
  });
});
