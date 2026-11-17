import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { BRU_COLLECTION, YML_COLLECTION, callTool, connectClient, copyCollection, readFile, removeTempDirs } from '../helpers.js';

const GET_USER = 'users/get-user.bru';
const EXISTING_TEST = 'test("returns the user", function() {\n  expect(res.status).to.equal(200);\n});';

let client: Client;

beforeAll(async () => {
  client = await connectClient();
});

afterAll(async () => {
  await client.close();
});

afterEach(removeTempDirs);

const add = (collectionPath: string, args: Record<string, unknown>) =>
  callTool(client, 'add_test_script', { collectionPath, requestPath: GET_USER, ...args });

const scripts = async (collectionPath: string, requestPath = GET_USER) => {
  const { body } = await callTool(client, 'get_request', { collectionPath, requestPath });
  return { script: body.request.request.script, tests: body.request.request.tests };
};

describe('add_test_script', () => {
  it('appends to the existing tests by default', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);
    const script = 'test("has an id", () => expect(res.body.id).to.exist);';

    const { isError, body } = await add(collectionPath, { scriptType: 'tests', script });

    const tests = `${EXISTING_TEST}\n\n${script}`;
    expect(isError).toBe(false);
    expect(body).toEqual({ ok: true, scriptType: 'tests', scriptMode: 'append', wroteBytes: Buffer.byteLength(tests) });
    expect((await scripts(collectionPath)).tests).toBe(tests);
  });

  it('replaces the block with scriptMode "replace"', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);

    await add(collectionPath, { scriptType: 'tests', script: 'test("new", () => {});', scriptMode: 'replace' });

    expect((await scripts(collectionPath)).tests).toBe('test("new", () => {});');
  });

  it('writes pre-request and post-response scripts, leaving the other blocks alone', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);

    await add(collectionPath, { scriptType: 'pre-request', script: 'req.setHeader("X-Trace", "1");' });
    await add(collectionPath, { scriptType: 'post-response', script: 'bru.setVar("id", res.body.id);' });

    expect(await scripts(collectionPath)).toEqual({
      script: { req: 'req.setHeader("X-Trace", "1");', res: 'bru.setVar("id", res.body.id);' },
      tests: EXISTING_TEST
    });
    expect(readFile(collectionPath, GET_USER)).toContain('script:pre-request {\n  req.setHeader("X-Trace", "1");\n}');
  });

  it('works for .yml collections', async () => {
    const collectionPath = copyCollection(YML_COLLECTION);

    await callTool(client, 'add_test_script', {
      collectionPath,
      requestPath: 'users/get-user.yml',
      scriptType: 'post-response',
      script: 'console.log(res.status);'
    });

    expect((await scripts(collectionPath, 'users/get-user.yml')).script.res).toBe('console.log(res.status);');
  });

  it('refuses a block that would grow past 50 KB, leaving the file alone', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);
    const before = readFile(collectionPath, GET_USER);

    const { isError, body } = await add(collectionPath, { scriptType: 'tests', script: `// ${'x'.repeat(50 * 1024)}` });

    expect(isError).toBe(true);
    expect(body.error).toMatch(/^The tests script would be \d+ bytes, over the 51200-byte limit\.$/);
    expect(readFile(collectionPath, GET_USER)).toBe(before);
  });

  it.each([
    ['an empty script', { scriptType: 'tests', script: '' }, 'script'],
    ['an unknown script type', { scriptType: 'post-request', script: 'x' }, 'scriptType']
  ])('rejects %s', async (_label, args, field) => {
    const { isError, text } = await add(copyCollection(BRU_COLLECTION), args);

    expect(isError).toBe(true);
    expect(text).toMatch(new RegExp(`Input validation error: .*at ${field}$`));
  });

  it('lists the available requests when the request does not exist', async () => {
    const { isError, body } = await add(copyCollection(BRU_COLLECTION), { requestPath: 'users/get-user', scriptType: 'tests', script: 'x' });

    expect(isError).toBe(true);
    expect(body.error).toBe('Request not found: "users/get-user" in collection "Bru Fixture"');
    expect(body.availableRequests).toEqual([path.join('users', 'get-user.bru'), path.join('users', 'missing-user.bru'), 'health.bru']);
  });
});

describe('remove_script', () => {
  const remove = (collectionPath: string, scriptType: string) =>
    callTool(client, 'remove_script', { collectionPath, requestPath: GET_USER, scriptType });

  it('clears one block, then reports removed: false once it is empty', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);
    await add(collectionPath, { scriptType: 'pre-request', script: 'bru.setVar("a", 1);' });

    const first = await remove(collectionPath, 'tests');
    const contentAfterFirst = readFile(collectionPath, GET_USER);
    const second = await remove(collectionPath, 'tests');

    expect(first.body).toEqual({ ok: true, scriptType: 'tests', removed: true });
    expect(second.body).toEqual({ ok: true, scriptType: 'tests', removed: false });
    expect(readFile(collectionPath, GET_USER)).toBe(contentAfterFirst);
    expect(contentAfterFirst).not.toContain('tests {');
    expect(await scripts(collectionPath)).toEqual({ script: { req: 'bru.setVar("a", 1);' }, tests: '' });
  });
});
