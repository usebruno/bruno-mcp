import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { cleanupSessionTmpDir, setInheritEnv } from '../../src/core/execute.js';
import {
  FIXTURES_DIR,
  callTool,
  connectClient,
  copyCollection,
  makeTempDir,
  removeTempDirs,
  startHttpServer,
  writeFiles,
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

describe('execute_request and the server environment', () => {
  const SHELL_SECRET = 'BRUNO_MCP_TEST_SHELL_SECRET';
  const leakRequest = (url: string) => `meta {\n  name: Leak\n  type: http\n  seq: 9\n}\n\nget {\n  url: ${url}\n  body: none\n  auth: none\n}\n`;

  const runLeak = async (url: string, files: Record<string, string> = {}) => {
    const collectionPath = writeFiles(copyCollection(BRU_COLLECTION), { 'leak.bru': leakRequest(url), ...files });
    const result = await callTool(client, 'execute_request', {
      collectionPath,
      requestPath: 'leak.bru',
      variables: { baseUrl: server.baseUrl }
    });
    expect(result.isError).toBe(false);
    return server.hits[0];
  };

  beforeEach(() => {
    process.env[SHELL_SECRET] = 's3cret-from-shell';
  });

  afterEach(() => {
    delete process.env[SHELL_SECRET];
    setInheritEnv(false);
  });

  it('does not give requests the server environment', async () => {
    const hit = await runLeak(`{{baseUrl}}/leak?value={{process.env.${SHELL_SECRET}}}`);
    expect(hit).not.toContain('s3cret-from-shell');
  });

  it('still reads {{process.env.*}} from the collection .env file', async () => {
    const hit = await runLeak('{{baseUrl}}/leak?value={{process.env.FROM_DOTENV}}', { '.env': 'FROM_DOTENV=dotenv-value\n' });
    expect(hit).toBe('/leak?value=dotenv-value');
  });

  it('gives requests the whole environment with --inherit-env', async () => {
    setInheritEnv(true);
    const hit = await runLeak(`{{baseUrl}}/leak?value={{process.env.${SHELL_SECRET}}}`);
    expect(hit).toBe('/leak?value=s3cret-from-shell');
  });

  // On macOS and Linux bru loads the login shell's variables at startup; Windows has no such step.
  describe('variables exported in shell startup files', () => {
    const itOnPosix = process.platform === 'win32' ? it.skip : it;
    const RC_URL = '{{baseUrl}}/leak?value={{process.env.BRUNO_MCP_TEST_RC_SECRET}}';
    let home: string | undefined;

    beforeEach(() => {
      home = process.env.HOME;
      const fakeHome = writeFiles(makeTempDir(), {});
      for (const rc of ['.zshenv', '.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile']) {
        writeFiles(fakeHome, { [rc]: 'export BRUNO_MCP_TEST_RC_SECRET=from-rc-file\n' });
      }
      process.env.HOME = fakeHome;
    });

    afterEach(() => {
      process.env.HOME = home;
    });

    itOnPosix('are not given to requests', async () => {
      expect(await runLeak(RC_URL)).not.toContain('from-rc-file');
    });

    itOnPosix('are given to requests with --inherit-env', async () => {
      setInheritEnv(true);
      expect(await runLeak(RC_URL)).toBe('/leak?value=from-rc-file');
    });
  });
});
