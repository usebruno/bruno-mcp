import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { CLIENTS, type ClientId, type RunResult, type SetupEnv } from '../../src/setup/clients.js';

const client = (id: ClientId) => CLIENTS.find((c) => c.id === id)!;
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

let home: string;
let calls: string[][];
let commands: Set<string>;
let runImpl: (cmd: string, args: string[]) => RunResult;

const makeEnv = (platform: NodeJS.Platform = 'darwin', env: NodeJS.ProcessEnv = {}): SetupEnv => ({
  home,
  platform,
  env,
  hasCommand: (cmd) => commands.has(cmd),
  run: (cmd, args) => {
    calls.push([cmd, ...args]);
    return runImpl(cmd, args);
  }
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-mcp-setup-'));
  calls = [];
  commands = new Set();
  runImpl = () => ({ status: 0, stdout: '', stderr: '' });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('JSON clients', () => {
  const cursorFile = () => path.join(home, '.cursor', 'mcp.json');

  it('creates the config file when missing', () => {
    const res = client('cursor').install(makeEnv());
    expect(res.status).toBe('added');
    expect(readJson(cursorFile())).toEqual({
      mcpServers: { bruno: { command: 'npx', args: ['-y', '@usebruno/mcp'] } }
    });
  });

  it('keeps existing servers and other keys', () => {
    fs.mkdirSync(path.dirname(cursorFile()), { recursive: true });
    fs.writeFileSync(cursorFile(), JSON.stringify({ other: 1, mcpServers: { github: { command: 'gh' } } }));
    expect(client('cursor').install(makeEnv()).status).toBe('added');
    const data = readJson(cursorFile());
    expect(data.other).toBe(1);
    expect(Object.keys(data.mcpServers)).toEqual(['github', 'bruno']);
  });

  it('leaves an existing bruno entry untouched', () => {
    fs.mkdirSync(path.dirname(cursorFile()), { recursive: true });
    const original = JSON.stringify({ mcpServers: { bruno: { command: 'npx', args: ['-y', '@usebruno/mcp', '-c', '/x'] } } });
    fs.writeFileSync(cursorFile(), original);
    expect(client('cursor').install(makeEnv()).status).toBe('already');
    expect(fs.readFileSync(cursorFile(), 'utf8')).toBe(original);
  });

  it('refuses to rewrite a file that is not plain JSON', () => {
    fs.mkdirSync(path.dirname(cursorFile()), { recursive: true });
    const original = '{\n  // my servers\n  "mcpServers": {}\n}\n';
    fs.writeFileSync(cursorFile(), original);
    expect(client('cursor').install(makeEnv()).status).toBe('failed');
    expect(fs.readFileSync(cursorFile(), 'utf8')).toBe(original);
  });

  it('writes the Claude Desktop config under the platform app-data dir', () => {
    client('claude-desktop').install(makeEnv('darwin'));
    expect(fs.existsSync(path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'))).toBe(true);

    const appData = path.join(home, 'Roaming');
    client('claude-desktop').install(makeEnv('win32', { APPDATA: appData }));
    expect(fs.existsSync(path.join(appData, 'Claude', 'claude_desktop_config.json'))).toBe(true);
  });

  it('writes a stdio entry with tools to the Copilot user config for VS Code', () => {
    client('vscode').install(makeEnv());
    expect(readJson(path.join(home, '.copilot', 'mcp-config.json')).mcpServers.bruno).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@usebruno/mcp'],
      tools: ['*']
    });
  });
});

describe('Codex', () => {
  const tomlFile = () => path.join(home, '.codex', 'config.toml');

  it('appends a table and keeps the rest of the file', () => {
    fs.mkdirSync(path.dirname(tomlFile()), { recursive: true });
    fs.writeFileSync(tomlFile(), 'model = "gpt-5"\n# keep me');
    expect(client('codex').install(makeEnv()).status).toBe('added');
    expect(fs.readFileSync(tomlFile(), 'utf8')).toBe(
      'model = "gpt-5"\n# keep me\n\n[mcp_servers.bruno]\ncommand = "npx"\nargs = ["-y", "@usebruno/mcp"]\n'
    );
  });

  it('does nothing when a bruno table is already there', () => {
    fs.mkdirSync(path.dirname(tomlFile()), { recursive: true });
    const original = '[mcp_servers."bruno"]\ncommand = "node"\n';
    fs.writeFileSync(tomlFile(), original);
    expect(client('codex').install(makeEnv()).status).toBe('already');
    expect(fs.readFileSync(tomlFile(), 'utf8')).toBe(original);
  });

  it('honours CODEX_HOME', () => {
    const codexHome = path.join(home, 'custom-codex');
    client('codex').install(makeEnv('linux', { CODEX_HOME: codexHome }));
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(true);
  });
});

describe('Claude Code', () => {
  it('adds the server at user scope through the claude CLI', () => {
    commands.add('claude');
    runImpl = (_cmd, args) => ({ status: args[1] === 'get' ? 1 : 0, stdout: '', stderr: '' });
    expect(client('claude-code').install(makeEnv()).status).toBe('added');
    expect(calls).toEqual([
      ['claude', 'mcp', 'get', 'bruno'],
      ['claude', 'mcp', 'add', '--scope', 'user', 'bruno', '--', 'npx', '-y', '@usebruno/mcp']
    ]);
  });

  it('skips the add when the server is already registered', () => {
    commands.add('claude');
    expect(client('claude-code').install(makeEnv()).status).toBe('already');
    expect(calls).toHaveLength(1);
  });

  it('reports the CLI error when the add fails', () => {
    commands.add('claude');
    runImpl = (_cmd, args) => ({ status: 1, stdout: '', stderr: args[1] === 'add' ? 'boom' : '' });
    expect(client('claude-code').install(makeEnv())).toEqual({ status: 'failed', detail: 'boom' });
  });

  it('fails without running anything when claude is not installed', () => {
    expect(client('claude-code').install(makeEnv()).status).toBe('failed');
    expect(calls).toHaveLength(0);
  });
});

describe('detection', () => {
  it('detects clients from their config dirs and commands', () => {
    fs.mkdirSync(path.join(home, '.cursor'));
    fs.mkdirSync(path.join(home, '.codex'));
    commands.add('claude');
    const detected = CLIENTS.filter((c) => c.detect(makeEnv())).map((c) => c.id);
    expect(detected).toEqual(['claude-code', 'cursor', 'codex']);
  });

  it('detects nothing on a bare machine', () => {
    expect(CLIENTS.filter((c) => c.detect(makeEnv()))).toHaveLength(0);
  });
});
