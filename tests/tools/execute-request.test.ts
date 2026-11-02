import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { cleanupSessionTmpDir } from '../../src/core/execute.js';
import {
  FIXTURES_DIR,
  callTool,
  connectClient,
  copyCollection,
  makeTempDir,
  removeTempDirs,
  startHttpServer,
  type TestHttpServer
} from '../helpers.js';

const BRU_COLLECTION = path.join(FIXTURES_DIR, 'run-collection', 'bru');

// Each run spawns the real `bru` CLI.
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

describe('execute_request', () => {
  it('runs a request in a collection opened through a symlinked folder', async () => {
    const linked = path.join(makeTempDir(), 'linked');
    fs.symlinkSync(copyCollection(BRU_COLLECTION), linked, 'dir');

    const { isError, body } = await callTool(client, 'execute_request', {
      collectionPath: linked,
      requestPath: 'health.bru',
      variables: { baseUrl: server.baseUrl }
    });

    expect(isError).toBe(false);
    expect(body.response.status).toBe(200);
    expect(server.hits).toEqual(['/health']);
  });
});
