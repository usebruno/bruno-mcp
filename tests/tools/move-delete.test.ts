import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  BRU_COLLECTION,
  YML_COLLECTION,
  callTool,
  connectClient,
  copyCollection,
  fileExists,
  listFiles,
  readFile,
  removeTempDirs
} from '../helpers.js';

let client: Client;

beforeAll(async () => {
  client = await connectClient();
});

afterAll(async () => {
  await client.close();
});

afterEach(removeTempDirs);

const move = (collectionPath: string, args: Record<string, unknown>) => callTool(client, 'move_request', { collectionPath, ...args });

describe('move_request', () => {
  it('moves a request into a new folder, last in that folder', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);
    const original = readFile(collectionPath, 'users/get-user.bru');

    const { isError, body } = await move(collectionPath, { requestPath: 'users/get-user.bru', targetFolder: 'archive' });

    expect(isError).toBe(false);
    expect(body).toEqual({ ok: true, operation: 'move', from: path.join('users', 'get-user.bru'), to: path.join('archive', 'get-user.bru') });
    expect(fileExists(collectionPath, 'users/get-user.bru')).toBe(false);
    expect(readFile(collectionPath, 'archive/get-user.bru')).toBe(original);
  });

  it('moves a request to the collection root by default, numbered after what is there', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);

    const { body } = await move(collectionPath, { requestPath: 'users/missing-user.bru' });

    expect(body.to).toBe('missing-user.bru');
    expect(readFile(collectionPath, 'missing-user.bru')).toContain('seq: 3');
  });

  it('copies a request, leaving the original in place', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);

    const { body } = await move(collectionPath, { requestPath: 'health.bru', targetFolder: 'users', copy: true });

    expect(body).toMatchObject({ ok: true, operation: 'copy', to: path.join('users', 'health.bru') });
    expect(readFile(collectionPath, 'health.bru')).toBe(readFile(BRU_COLLECTION, 'health.bru'));
    expect(readFile(collectionPath, 'users/health.bru')).toBe(readFile(BRU_COLLECTION, 'health.bru').replace('seq: 1', 'seq: 3'));
  });

  it('converts the file when moving between a .bru and a .yml collection', async () => {
    const source = copyCollection(BRU_COLLECTION);
    const target = copyCollection(YML_COLLECTION);
    const before = await callTool(client, 'get_request', { collectionPath: source, requestPath: 'users/get-user.bru' });

    const { body } = await move(source, { requestPath: 'users/get-user.bru', targetCollectionPath: target, targetFolder: 'imported' });

    expect(body).toEqual({
      ok: true,
      operation: 'move',
      from: path.join('users', 'get-user.bru'),
      to: path.join('imported', 'get-user.yml'),
      targetCollectionPath: target
    });
    expect(fileExists(source, 'users/get-user.bru')).toBe(false);
    const after = await callTool(client, 'get_request', { collectionPath: target, requestPath: 'imported/get-user.yml' });
    expect(after.body.request).toMatchObject({
      name: 'Get user',
      request: {
        method: before.body.request.request.method,
        url: before.body.request.request.url,
        assertions: [expect.objectContaining({ name: 'res.status', value: 'eq 200' })],
        tests: before.body.request.request.tests
      }
    });
  });

  it.each([
    ['the environments folder', 'environments'],
    ['the environments folder spelled in another case', 'Environments'],
    ['a folder outside the collection', '../elsewhere'],
    ['a request file as the folder', 'users/get-user.bru']
  ])('refuses %s as the target folder', async (_label, targetFolder) => {
    const collectionPath = copyCollection(BRU_COLLECTION);
    const before = listFiles(collectionPath);

    const { isError, body } = await move(collectionPath, { requestPath: 'health.bru', targetFolder });

    expect(isError).toBe(true);
    expect(body.error).toBe(`Not a folder path in collection "Bru Fixture": "${targetFolder}"`);
    expect(listFiles(collectionPath)).toEqual(before);
  });

  it('refuses to move a request onto itself', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);
    const before = listFiles(collectionPath);

    const { isError, body } = await move(collectionPath, { requestPath: 'users/get-user.bru', targetFolder: 'users', copy: true });

    expect(isError).toBe(true);
    expect(body.error).toBe(`"${path.join('users', 'get-user.bru')}" is already in that folder.`);
    expect(listFiles(collectionPath)).toEqual(before);
  });

  it('never overwrites a request with the same name in the target folder', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);
    fs.copyFileSync(path.join(collectionPath, 'health.bru'), path.join(collectionPath, 'users', 'health.bru'));
    const before = listFiles(collectionPath);

    const { isError, body } = await move(collectionPath, { requestPath: 'health.bru', targetCollectionPath: collectionPath, targetFolder: 'users' });

    expect(isError).toBe(true);
    expect(body.error).toBe(`A request already exists at "${path.join('users', 'health.bru')}" in collection "Bru Fixture".`);
    expect(listFiles(collectionPath)).toEqual(before);
  });

  it('lists the available requests when the source does not exist', async () => {
    const { isError, body } = await move(copyCollection(BRU_COLLECTION), { requestPath: 'nope.bru', targetFolder: 'users' });

    expect(isError).toBe(true);
    expect(body.availableRequests).toEqual([path.join('users', 'get-user.bru'), path.join('users', 'missing-user.bru'), 'health.bru']);
  });
});

describe('delete_request', () => {
  const remove = (collectionPath: string, args: Record<string, unknown>) =>
    callTool(client, 'delete_request', { collectionPath, confirm: true, ...args });

  it('deletes every request passed, listing those already gone', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);

    const { isError, body } = await remove(collectionPath, { requestPaths: ['health.bru', 'users/missing-user.bru', 'users/gone.bru'] });

    expect(isError).toBe(false);
    expect(body).toEqual({ ok: true, deleted: 2, deletedPaths: ['health.bru', path.join('users', 'missing-user.bru')], notFound: [path.join('users', 'gone.bru')] });
    expect(fileExists(collectionPath, 'health.bru')).toBe(false);
    expect(fileExists(collectionPath, 'users/get-user.bru')).toBe(true);
  });

  it('works for .yml collections', async () => {
    const collectionPath = copyCollection(YML_COLLECTION);

    const { body } = await remove(collectionPath, { requestPaths: ['users/get-user.yml'] });

    expect(body).toEqual({ ok: true, deleted: 1, deletedPaths: [path.join('users', 'get-user.yml')] });
  });

  it.each([
    ['a folder', 'users'],
    ['an environment', 'environments/local.bru'],
    ['an environment spelled in another case', 'Environments/local.bru'],
    ['the collection config', 'bruno.json'],
    ['a path outside the collection', '../yml-collection/users/get-user.yml']
  ])('deletes nothing when one path is %s', async (_label, requestPath) => {
    const collectionPath = copyCollection(BRU_COLLECTION);
    const before = listFiles(collectionPath);

    const { isError, body } = await remove(collectionPath, { requestPaths: ['health.bru', requestPath] });

    expect(isError).toBe(true);
    expect(body).toEqual({
      error: `Not a request in collection "Bru Fixture": ${requestPath}`,
      hint: 'Nothing was deleted. Use the exact relative paths from list_requests.'
    });
    expect(listFiles(collectionPath)).toEqual(before);
  });

  it.each([
    [{ confirm: false }, 'confirm'],
    [{ confirm: undefined }, 'confirm'],
    [{ requestPaths: [] }, 'requestPaths']
  ])('requires confirm: true and at least one path (%j)', async (args, field) => {
    const collectionPath = copyCollection(BRU_COLLECTION);

    const { isError, text } = await remove(collectionPath, { requestPaths: ['health.bru'], ...args });

    expect(isError).toBe(true);
    expect(text).toMatch(new RegExp(`Input validation error: .*at ${field}$`));
    expect(fileExists(collectionPath, 'health.bru')).toBe(true);
  });
});
