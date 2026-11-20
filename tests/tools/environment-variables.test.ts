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
  makeTempDir,
  readFile,
  removeTempDirs,
  writeFiles
} from '../helpers.js';

const BRU_ENV = 'environments/local.bru';
const YML_ENV = 'environments/dev.yml';

let client: Client;

beforeAll(async () => {
  client = await connectClient();
});

afterAll(async () => {
  await client.close();
});

afterEach(removeTempDirs);

const set = (collectionPath: string, args: Record<string, unknown>) =>
  callTool(client, 'set_environment_variable', { collectionPath, environment: 'local', ...args });

const remove = (collectionPath: string, args: Record<string, unknown>) =>
  callTool(client, 'remove_environment_variable', { collectionPath, environment: 'local', ...args });

const OUTSIDE_ENV = 'vars {\n  a: 1\n}\n';

// environments/linked.bru, a symlink to a file outside the collection; returns that file.
const linkOutsideEnvironment = (collectionPath: string): string => {
  const outside = path.join(writeFiles(makeTempDir(), { 'outside.bru': OUTSIDE_ENV }), 'outside.bru');
  fs.symlinkSync(outside, path.join(collectionPath, 'environments', 'linked.bru'));
  return outside;
};

describe('set_environment_variable', () => {
  it('updates a variable in place and adds new ones at the end', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);

    const updated = await set(collectionPath, { name: 'baseUrl', value: 'https://api.example.com' });
    const added = await set(collectionPath, { name: 'retries', value: 3, enabled: false });

    expect(updated.body).toEqual({ ok: true, environment: 'local', name: 'baseUrl', wrote: true, created: false, enabled: true, secret: false });
    expect(added.body).toMatchObject({ ok: true, created: true, enabled: false, secret: false });
    expect(readFile(collectionPath, BRU_ENV)).toBe(
      'vars {\n  baseUrl: https://api.example.com\n  ~legacyUrl: http://legacy.local\n  userId: 42\n  ~retries: 3\n}\nvars:secret [\n  apiKey\n]\n'
    );
  });

  it('keeps a variable\'s enabled flag when enabled is left out', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);

    const { body } = await set(collectionPath, { name: 'legacyUrl', value: 'http://old.local' });

    expect(body.enabled).toBe(false);
    expect(readFile(collectionPath, BRU_ENV)).toContain('  ~legacyUrl: http://old.local\n');
  });

  it('reports wrote: false and leaves the file alone when nothing changes', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);
    const before = readFile(collectionPath, BRU_ENV);

    const { body } = await set(collectionPath, { name: 'userId', value: '42' });

    expect(body).toMatchObject({ ok: true, wrote: false, created: false });
    expect(readFile(collectionPath, BRU_ENV)).toBe(before);
  });

  it('refuses to change a secret variable without overwriteSecret', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);
    const before = readFile(collectionPath, BRU_ENV);

    const { isError, body } = await set(collectionPath, { name: 'apiKey', value: 'sk-live' });

    expect(isError).toBe(true);
    expect(body.error).toBe('"apiKey" is a secret variable in the "local" environment.');
    expect(readFile(collectionPath, BRU_ENV)).toBe(before);
  });

  it('never writes a secret value to disk, even with overwriteSecret', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);

    const overwritten = await set(collectionPath, { name: 'apiKey', value: 'sk-live', enabled: false, overwriteSecret: true });
    const created = await set(collectionPath, { name: 'token', value: 'tok-123', secret: true });

    expect(overwritten.body).toMatchObject({ ok: true, secret: true, enabled: false, valueWritten: false });
    expect(created.body).toMatchObject({ ok: true, created: true, secret: true, valueWritten: false });
    const content = readFile(collectionPath, BRU_ENV);
    expect(content).toContain('vars:secret [\n  ~apiKey,\n  token\n]');
    expect(content).not.toMatch(/sk-live|tok-123/);
  });

  it('turns a secret variable into a plain one when secret: false is passed with overwriteSecret', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);

    const { body } = await set(collectionPath, { name: 'apiKey', value: 'public', secret: false, overwriteSecret: true });

    expect(body).toMatchObject({ ok: true, secret: false });
    expect(body).not.toHaveProperty('valueWritten');
    expect(readFile(collectionPath, BRU_ENV)).toBe(
      'vars {\n  baseUrl: http://127.0.0.1:1\n  ~legacyUrl: http://legacy.local\n  userId: 42\n  apiKey: public\n}\n'
    );
  });

  it('edits .yml environments in place, keeping comments and other variables\' in-file secret values', async () => {
    const collectionPath = copyCollection(YML_COLLECTION);
    writeFiles(collectionPath, { [YML_ENV]: `# shared dev settings\n${readFile(YML_COLLECTION, YML_ENV)}` });

    await set(collectionPath, { environment: 'dev', name: 'baseUrl', value: 'https://dev.example.com' });
    await set(collectionPath, { environment: 'dev', name: 'debug', value: true, enabled: true });
    await set(collectionPath, { environment: 'dev', name: 'apiKey', value: 'shh', secret: true });

    expect(readFile(collectionPath, YML_ENV)).toBe(
      '# shared dev settings\nname: dev\nvariables:\n' +
        '  - name: baseUrl\n    value: https://dev.example.com\n' +
        '  - name: token\n    value: do-not-leak\n    secret: true\n' +
        '  - name: debug\n    value: "true"\n' +
        '  - name: apiKey\n    secret: true\n'
    );
  });

  it('adds the first variable to a .yml environment that has none', async () => {
    const collectionPath = copyCollection(YML_COLLECTION);
    writeFiles(collectionPath, { 'environments/empty.yml': 'name: empty\n' });

    await set(collectionPath, { environment: 'empty', name: 'baseUrl', value: 'http://localhost' });

    expect(readFile(collectionPath, 'environments/empty.yml')).toBe('name: empty\nvariables:\n  - name: baseUrl\n    value: http://localhost\n');
  });

  it('rejects a variable name Bruno can\'t reference', async () => {
    const { isError, text } = await set(copyCollection(BRU_COLLECTION), { name: 'base url', value: 'x' });

    expect(isError).toBe(true);
    expect(text).toMatch(/Input validation error: .*name/);
  });

  it('rejects an unknown environment', async () => {
    const { isError, body } = await set(copyCollection(BRU_COLLECTION), { environment: 'Local', name: 'a', value: 'b' });

    expect(isError).toBe(true);
    expect(body.error).toBe('The environment "Local" doesn\'t exist in the "Bru Fixture" collection.');
    expect([...body.availableEnvironments].sort()).toEqual(['local', 'staging']);
  });

  it('reports a malformed environment file instead of overwriting it', async () => {
    const collectionPath = writeFiles(makeTempDir(), { 'bruno.json': '{}', 'environments/broken.bru': 'vars {\n  a: 1\n' });

    const { isError, body } = await set(collectionPath, { environment: 'broken', name: 'b', value: '2' });

    expect(isError).toBe(true);
    expect(body.error).toMatch(/^Could not update environment "broken"/);
    expect(readFile(collectionPath, 'environments/broken.bru')).toBe('vars {\n  a: 1\n');
  });

  it('does not write through an environment file symlinked from outside the collection', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);
    const outside = linkOutsideEnvironment(collectionPath);

    const { isError, body } = await set(collectionPath, { environment: 'linked', name: 'b', value: '2' });

    expect(isError).toBe(true);
    expect(body.availableEnvironments).not.toContain('linked');
    expect(fs.readFileSync(outside, 'utf8')).toBe(OUTSIDE_ENV);
  });

  it('keeps every variable when several are set in parallel', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];

    const results = await Promise.all(names.map((name) => set(collectionPath, { name, value: name })));

    expect(results.every((r) => !r.isError)).toBe(true);
    const content = readFile(collectionPath, BRU_ENV);
    for (const name of names) expect(content).toContain(`  ${name}: ${name}\n`);
  });
});

describe('remove_environment_variable', () => {
  it('removes a plain or secret variable', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);

    const plain = await remove(collectionPath, { name: 'userId' });
    const secret = await remove(collectionPath, { name: 'apiKey' });

    expect(plain.body).toEqual({ ok: true, environment: 'local', name: 'userId', removed: true });
    expect(secret.body.removed).toBe(true);
    expect(readFile(collectionPath, BRU_ENV)).toBe('vars {\n  baseUrl: http://127.0.0.1:1\n  ~legacyUrl: http://legacy.local\n}\n');
  });

  it('removes from .yml environments in place', async () => {
    const collectionPath = copyCollection(YML_COLLECTION);

    await remove(collectionPath, { environment: 'dev', name: 'baseUrl' });

    expect(readFile(collectionPath, YML_ENV)).toBe(
      'name: dev\nvariables:\n  - name: token\n    value: do-not-leak\n    secret: true\n  - name: debug\n    value: "true"\n    disabled: true\n'
    );
  });

  it('reports removed: false for a variable that isn\'t there, leaving the file alone', async () => {
    const collectionPath = copyCollection(YML_COLLECTION);
    const before = readFile(collectionPath, YML_ENV);

    const { isError, body } = await remove(collectionPath, { environment: 'dev', name: 'Token' });

    expect(isError).toBe(false);
    expect(body.removed).toBe(false);
    expect(readFile(collectionPath, YML_ENV)).toBe(before);
  });

  it('rejects an unknown environment', async () => {
    const { isError, body } = await remove(copyCollection(YML_COLLECTION), { environment: 'prod', name: 'a' });

    expect(isError).toBe(true);
    expect(body.availableEnvironments).toEqual(['dev']);
  });

  it('does not write through an environment file symlinked from outside the collection', async () => {
    const collectionPath = copyCollection(BRU_COLLECTION);
    const outside = linkOutsideEnvironment(collectionPath);

    const { isError } = await remove(collectionPath, { environment: 'linked', name: 'a' });

    expect(isError).toBe(true);
    expect(fs.readFileSync(outside, 'utf8')).toBe(OUTSIDE_ENV);
  });
});
