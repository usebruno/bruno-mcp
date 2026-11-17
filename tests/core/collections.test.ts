import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { CollectionRegistry } from '../../src/core/collections.js';
import { BRU_COLLECTION, ISOLATED_CONFIG, makeTempDir, removeTempDirs, writeFiles } from '../helpers.js';

const registry = new CollectionRegistry(ISOLATED_CONFIG);

const REQUEST = 'meta {\n  name: Ping\n  type: http\n  seq: 1\n}\n\nget {\n  url: http://localhost/ping\n}\n';

afterEach(removeTempDirs);

describe('CollectionRegistry.resolveFolderPath', () => {
  it('resolves a folder that contains requests', () => {
    expect(registry.resolveFolderPath(BRU_COLLECTION, 'users')).toBe(path.join(BRU_COLLECTION, 'users'));
    expect(registry.resolveFolderPath(BRU_COLLECTION, 'users/')).toBe(path.join(BRU_COLLECTION, 'users'));
  });

  it('resolves a nested folder', () => {
    const collection = writeFiles(makeTempDir(), { 'bruno.json': '{}', 'api/v1/ping.bru': REQUEST });

    expect(registry.resolveFolderPath(collection, 'api')).toBe(path.join(collection, 'api'));
    expect(registry.resolveFolderPath(collection, 'api/v1')).toBe(path.join(collection, 'api', 'v1'));
  });

  it.each([
    ['a request file', 'health.bru'],
    ['the collection root', '.'],
    ['the environments folder', 'environments'],
    ['a path outside the collection', '../yml-collection'],
    ['a folder that does not exist', 'nope'],
    ['a folder name in the wrong case', 'Users']
  ])('rejects %s', (_label, relativePath) => {
    expect(registry.resolveFolderPath(BRU_COLLECTION, relativePath)).toBeNull();
  });

  it.each(['empty', 'node_modules', '.git'])('rejects the "%s" folder, which list_requests and bru run skip', (folder) => {
    const collection = writeFiles(makeTempDir(), {
      'bruno.json': '{}',
      'ping.bru': REQUEST,
      'node_modules/dep/ping.bru': REQUEST,
      '.git/ping.bru': REQUEST
    });
    fs.mkdirSync(path.join(collection, 'empty'));

    expect(registry.resolveFolderPath(collection, folder)).toBeNull();
  });

  it('rejects a symlinked folder, even one pointing inside the collection', () => {
    const collection = writeFiles(makeTempDir(), { 'bruno.json': '{}', 'real/ping.bru': REQUEST });
    fs.symlinkSync(path.join(collection, 'real'), path.join(collection, 'linked'), 'dir');

    expect(registry.resolveFolderPath(collection, 'real')).toBe(path.join(collection, 'real'));
    expect(registry.resolveFolderPath(collection, 'linked')).toBeNull();
  });

  it('keeps resolving folders when a folder.bru is malformed', () => {
    const collection = writeFiles(makeTempDir(), {
      'bruno.json': '{}',
      'users/folder.bru': 'meta {\n  name: Users\n',
      'users/ping.bru': REQUEST
    });

    expect(registry.resolveFolderPath(collection, 'users')).toBe(path.join(collection, 'users'));
  });

  it('returns null for a directory that is not a collection', () => {
    expect(registry.resolveFolderPath(makeTempDir(), 'users')).toBeNull();
  });
});

describe('CollectionRegistry.environmentFiles', () => {
  it('lists the collection environments', () => {
    const names = registry.environmentFiles(BRU_COLLECTION).map((env) => env.name).sort();
    expect(names).toEqual(['local', 'staging']);
  });

  it('returns an empty list for an unknown collection', () => {
    expect(registry.environmentFiles(makeTempDir())).toEqual([]);
  });
});

describe('CollectionRegistry.resolveRequestTarget', () => {
  it('resolves request paths that do not exist yet, in new folders too', () => {
    expect(registry.resolveRequestTarget(BRU_COLLECTION, 'new.bru')).toEqual({ path: path.join(BRU_COLLECTION, 'new.bru'), format: 'bru' });
    expect(registry.resolveRequestTarget(BRU_COLLECTION, 'a/b/new.bru')?.path).toBe(path.join(BRU_COLLECTION, 'a', 'b', 'new.bru'));
  });

  it.each([
    ['a path outside the collection', '../elsewhere.bru'],
    ['the environments folder', 'environments/new.bru'],
    ['the environments folder spelled in another case', 'Environments/new.bru'],
    ['a folder file', 'users/folder.bru'],
    ['the collection file', 'collection.bru'],
    ['the wrong extension', 'new.yml'],
    ['.git', '.git/new.bru'],
    ['.git spelled in another case', '.GIT/new.bru'],
    ['node_modules', 'pkg/node_modules/new.bru']
  ])('rejects %s', (_label, relativePath) => {
    expect(registry.resolveRequestTarget(BRU_COLLECTION, relativePath)).toBeNull();
  });

  it('rejects a symlink inside the collection that points at its environments folder', () => {
    const collection = writeFiles(makeTempDir(), { 'bruno.json': '{}', 'environments/local.bru': 'vars {\n}\n' });
    fs.symlinkSync(path.join(collection, 'environments'), path.join(collection, 'envs'));

    expect(registry.resolveRequestTarget(collection, 'envs/new.bru')).toBeNull();
    expect(registry.resolveFolderTarget(collection, 'envs')).toBeNull();
  });

  it('rejects a path that leaves the collection through a symlinked folder', () => {
    const outside = makeTempDir();
    const collection = writeFiles(makeTempDir(), { 'bruno.json': '{}' });
    fs.symlinkSync(outside, path.join(collection, 'linked'));

    expect(registry.resolveRequestTarget(collection, 'linked/new.bru')).toBeNull();
    expect(registry.resolveRequestTarget(collection, 'linked/deeper/new.bru')).toBeNull();
  });

  it('rejects a dangling symlink, which a write would follow out of the collection', () => {
    const collection = writeFiles(makeTempDir(), { 'bruno.json': '{}' });
    fs.symlinkSync(path.join(makeTempDir(), 'target.bru'), path.join(collection, 'dangling.bru'));

    expect(registry.resolveRequestTarget(collection, 'dangling.bru')).toBeNull();
  });
});

describe('CollectionRegistry.resolveFolderTarget', () => {
  it('resolves the root, existing folders, and folders that do not exist yet', () => {
    expect(registry.resolveFolderTarget(BRU_COLLECTION, '')).toBe(BRU_COLLECTION);
    expect(registry.resolveFolderTarget(BRU_COLLECTION, 'users')).toBe(path.join(BRU_COLLECTION, 'users'));
    expect(registry.resolveFolderTarget(BRU_COLLECTION, 'billing/v2')).toBe(path.join(BRU_COLLECTION, 'billing', 'v2'));
  });

  it.each([
    ['a path outside the collection', '../elsewhere'],
    ['the environments folder', 'environments'],
    ['the environments folder spelled in another case', 'Environments'],
    ['a folder inside environments', 'environments/sub'],
    ['a request file', 'health.bru'],
    ['.git', '.git']
  ])('rejects %s', (_label, relativePath) => {
    expect(registry.resolveFolderTarget(BRU_COLLECTION, relativePath)).toBeNull();
  });

  it('rejects a symlinked folder that points outside the collection', () => {
    const collection = writeFiles(makeTempDir(), { 'bruno.json': '{}' });
    fs.symlinkSync(makeTempDir(), path.join(collection, 'linked'));

    expect(registry.resolveFolderTarget(collection, 'linked')).toBeNull();
  });
});
