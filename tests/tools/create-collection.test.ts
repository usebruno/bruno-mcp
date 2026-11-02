import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { callTool, connectClient, fileExists, makeTempDir, readFile, removeTempDirs, writeFiles } from '../helpers.js';

const GITIGNORE = '# Secrets\n.env*\n\n# Dependencies\nnode_modules\n\n# OS files\n.DS_Store\nThumbs.db';

let client: Client;

beforeAll(async () => {
  client = await connectClient();
});

afterAll(async () => {
  await client.close();
});

afterEach(removeTempDirs);

const create = (args: Record<string, unknown>) => callTool(client, 'create_collection', { name: 'Payments', ...args });

describe('create_collection', () => {
  it('creates a YAML collection by default, with the files the Bruno app writes', async () => {
    const outputPath = path.join(makeTempDir(), 'payments');

    const { isError, body } = await create({ outputPath });

    expect(isError).toBe(false);
    expect(body).toEqual({ ok: true, collectionPath: outputPath, name: 'Payments', format: 'yml', registered: false });
    expect(fs.readdirSync(outputPath).sort()).toEqual(['.gitignore', 'opencollection.yml']);
    expect(readFile(outputPath, 'opencollection.yml')).toBe(
      'opencollection: 1.0.0\n\ninfo:\n  name: Payments\nbundled: false\nextensions:\n  bruno:\n    ignore:\n      - node_modules\n      - .git\n'
    );
    expect(readFile(outputPath, '.gitignore')).toBe(GITIGNORE);
  });

  it('creates a .bru collection, writing baseUrl and description to collection.bru', async () => {
    const outputPath = path.join(makeTempDir(), 'payments');

    const { body } = await create({ outputPath, format: 'bru', baseUrl: 'https://api.example.com', description: 'Payments API' });

    expect(body).toMatchObject({ ok: true, format: 'bru' });
    expect(JSON.parse(readFile(outputPath, 'bruno.json'))).toEqual({
      version: '1',
      name: 'Payments',
      type: 'collection',
      ignore: ['node_modules', '.git']
    });
    expect(readFile(outputPath, 'collection.bru')).toBe(
      'meta {\n  name: Payments\n}\n\nvars:pre-request {\n  baseUrl: https://api.example.com\n}\n\ndocs {\n  Payments API\n}\n'
    );
  });

  it('writes baseUrl and description into opencollection.yml for YAML collections', async () => {
    const outputPath = path.join(makeTempDir(), 'payments');

    await create({ outputPath, baseUrl: 'https://api.example.com', description: 'Payments API' });

    expect(readFile(outputPath, 'opencollection.yml')).toContain(
      'request:\n  variables:\n    - name: baseUrl\n      value: https://api.example.com\n\ndocs:\n  content: Payments API\n'
    );
  });

  it('creates a collection the other tools can use straight away', async () => {
    const collectionPath = path.join(makeTempDir(), 'payments');
    await create({ outputPath: collectionPath });

    const { isError, body } = await callTool(client, 'get_collection_stats', { collectionPath });

    expect(isError).toBe(false);
    expect(body).toMatchObject({ collectionName: 'Payments', format: 'yml', requestCount: 0 });
  });

  it('uses an existing empty directory', async () => {
    const outputPath = makeTempDir();

    const { isError } = await create({ outputPath });

    expect(isError).toBe(false);
    expect(fileExists(outputPath, 'opencollection.yml')).toBe(true);
  });

  it.each([
    ['a directory with files in it', () => writeFiles(makeTempDir(), { 'notes.txt': 'hi' }), /^Not an empty directory/],
    ['an existing collection', () => writeFiles(makeTempDir(), { 'bruno.json': '{}' }), /^There is already a Bruno collection at/]
  ])('refuses %s', async (_label, outputPath, error) => {
    const dir = outputPath();
    const before = fs.readdirSync(dir);

    const { isError, body } = await create({ outputPath: dir });

    expect(isError).toBe(true);
    expect(body.error).toMatch(error);
    expect(fs.readdirSync(dir)).toEqual(before);
  });

  it('refuses a relative outputPath', async () => {
    const { isError, body } = await create({ outputPath: 'payments' });

    expect(isError).toBe(true);
    expect(body.error).toBe('outputPath must be an absolute path: payments');
  });

  it('rejects an empty name', async () => {
    const { isError, text } = await create({ name: '  ', outputPath: path.join(makeTempDir(), 'x') });

    expect(isError).toBe(true);
    expect(text).toMatch(/Input validation error: .*name/);
  });

  describe('with workspacePath', () => {
    const makeWorkspace = (collections = '') =>
      writeFiles(makeTempDir(), {
        'workspace.yml': `# team workspace\nopencollection: 1.0.0\ninfo:\n  name: Team\n  type: workspace\n\ncollections:${collections}\n`
      });

    it('lists the new collection in the workspace, relative to it, keeping the rest of workspace.yml', async () => {
      const workspacePath = makeWorkspace('\n  - name: Users\n    path: collections/users');
      const outputPath = path.join(workspacePath, 'collections', 'payments');

      const { body } = await create({ outputPath, workspacePath });

      expect(body).toMatchObject({ ok: true, registered: true, workspacePath });
      expect(readFile(workspacePath, 'workspace.yml')).toBe(
        '# team workspace\nopencollection: 1.0.0\ninfo:\n  name: Team\n  type: workspace\n\ncollections:\n' +
          '  - name: Users\n    path: collections/users\n  - name: Payments\n    path: collections/payments\n'
      );
      const listed = await callTool(client, 'list_collections', { workspacePath });
      expect(listed.body.collections.map((c: any) => c.path)).toEqual([outputPath]);
    });

    it('adds the first collection to a workspace with an empty list', async () => {
      const workspacePath = makeWorkspace();
      const outputPath = path.join(workspacePath, 'payments');

      await create({ outputPath, workspacePath });

      expect(readFile(workspacePath, 'workspace.yml')).toContain('collections:\n  - name: Payments\n    path: payments\n');
    });

    it('uses an absolute path for a collection far outside the workspace', async () => {
      const workspacePath = path.join(makeWorkspace(), 'a', 'b', 'c');
      writeFiles(workspacePath, { 'workspace.yml': 'info:\n  name: Deep\ncollections:\n' });
      const outputPath = path.join(makeTempDir(), 'payments');

      await create({ outputPath, workspacePath });

      expect(readFile(workspacePath, 'workspace.yml')).toContain(`path: ${outputPath.split(path.sep).join('/')}\n`);
    });

    it('leaves an existing entry for the same path as it is', async () => {
      const workspacePath = makeWorkspace('\n  - name: Old payments\n    path: payments');
      const before = readFile(workspacePath, 'workspace.yml');

      const { body } = await create({ outputPath: path.join(workspacePath, 'payments'), workspacePath });

      expect(body).toMatchObject({ ok: true, registered: false });
      expect(readFile(workspacePath, 'workspace.yml')).toBe(before);
    });

    it('creates nothing when workspacePath is not a workspace', async () => {
      const outputPath = path.join(makeTempDir(), 'payments');

      const { isError, body } = await create({ outputPath, workspacePath: makeTempDir() });

      expect(isError).toBe(true);
      expect(body.error).toMatch(/^Not a Bruno workspace/);
      expect(fs.existsSync(outputPath)).toBe(false);
    });
  });
});
