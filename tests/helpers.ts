import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/server.js';
import type { DiscoveryConfig } from '../src/types.js';

export const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const BRU_COLLECTION = path.join(FIXTURES_DIR, 'bru-collection');
export const YML_COLLECTION = path.join(FIXTURES_DIR, 'yml-collection');

// No discovery, so tests never pick up collections from the machine running them.
export const ISOLATED_CONFIG: DiscoveryConfig = {
  explicitCollections: [],
  explicitWorkspaces: [],
  cwdDiscovery: false,
  autoDiscovery: false
};

export const connectClient = async (): Promise<Client> => {
  const server = createServer({ config: ISOLATED_CONFIG });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bruno-mcp-tests', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

export const callTool = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0].text;
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch (_) {}
  return { isError: Boolean(result.isError), text, body };
};

const tempDirs: string[] = [];

export const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-mcp-test-'));
  tempDirs.push(dir);
  return dir;
};

export const removeTempDirs = (): void => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
};

export const copyCollection = (source: string): string => {
  const dir = path.join(makeTempDir(), path.basename(source));
  fs.cpSync(source, dir, { recursive: true });
  return dir;
};

export const readFile = (root: string, relativePath: string): string => fs.readFileSync(path.join(root, relativePath), 'utf8');

export const fileExists = (root: string, relativePath: string): boolean => fs.existsSync(path.join(root, relativePath));

export const listFiles = (dir: string): string[] => fs.readdirSync(dir, { recursive: true }).map(String).sort();

export const writeFiles = (root: string, files: Record<string, string>): string => {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return root;
};

export interface ReceivedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

export interface TestHttpServer {
  baseUrl: string;
  hits: string[];
  received: ReceivedRequest[];
  maxInFlight: number;
  /** Hold responses until this many requests are in flight at once (or HOLD_TIMEOUT_MS passes). */
  holdUntilInFlight: number;
  reset: () => void;
  close: () => Promise<void>;
}

const HOLD_TIMEOUT_MS = 2000;

// `/missing` answers 404, everything else 200; every request path is recorded in `hits`.
export const startHttpServer = async (): Promise<TestHttpServer> => {
  const held = new Set<() => void>();
  let inFlight = 0;

  const releaseAll = () => {
    for (const release of [...held]) release();
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => handle(req, res, body));
  });

  const handle = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => {
    api.hits.push(req.url || '');
    api.received.push({ method: req.method || '', url: req.url || '', authorization: req.headers.authorization, body });
    inFlight += 1;
    api.maxInFlight = Math.max(api.maxInFlight, inFlight);

    const respond = () => {
      inFlight -= 1;
      res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url }));
    };

    if (inFlight < api.holdUntilInFlight) {
      const release = () => {
        clearTimeout(timer);
        held.delete(release);
        respond();
      };
      const timer = setTimeout(release, HOLD_TIMEOUT_MS);
      held.add(release);
      return;
    }
    releaseAll();
    respond();
  };

  const api: TestHttpServer = {
    baseUrl: '',
    hits: [],
    received: [],
    maxInFlight: 0,
    holdUntilInFlight: 1,
    reset: () => {
      releaseAll();
      inFlight = 0;
      api.hits.length = 0;
      api.received.length = 0;
      api.maxInFlight = 0;
      api.holdUntilInFlight = 1;
    },
    close: () =>
      new Promise<void>((resolve) => {
        releaseAll();
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return api;
};
