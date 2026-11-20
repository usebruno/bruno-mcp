import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SERVER_NAME = 'bruno';
export const SERVER_COMMAND = 'npx';
export const SERVER_ARGS = ['-y', '@usebruno/mcp'];

export type ClientId = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode' | 'codex';

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface SetupEnv {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  hasCommand: (cmd: string) => boolean;
  run: (cmd: string, args: string[]) => RunResult;
}

export interface InstallResult {
  status: 'added' | 'already' | 'failed';
  detail: string;
}

export interface Client {
  id: ClientId;
  label: string;
  location: (env: SetupEnv) => string;
  detect: (env: SetupEnv) => boolean;
  install: (env: SetupEnv) => InstallResult;
  nextStep: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const exists = (p: string) => fs.existsSync(p);

const appDataDir = ({ home, platform, env }: SetupEnv): string => {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME || path.join(home, '.config');
};

const claudeDesktopConfig = (e: SetupEnv) => path.join(appDataDir(e), 'Claude', 'claude_desktop_config.json');
const cursorConfig = (e: SetupEnv) => path.join(e.home, '.cursor', 'mcp.json');
const copilotHome = (e: SetupEnv) => e.env.COPILOT_HOME || path.join(e.home, '.copilot');
const copilotConfig = (e: SetupEnv) => path.join(copilotHome(e), 'mcp-config.json');
const codexHome = (e: SetupEnv) => e.env.CODEX_HOME || path.join(e.home, '.codex');
const codexConfig = (e: SetupEnv) => path.join(codexHome(e), 'config.toml');

export const upsertJsonServer = (file: string, key: string, entry: Record<string, unknown>): InstallResult => {
  let data: Record<string, unknown> = {};
  if (exists(file)) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { status: 'failed', detail: `${file} is not plain JSON (comments?), so it was left untouched. Add the server by hand.` };
      }
      if (!isPlainObject(parsed)) {
        return { status: 'failed', detail: `${file} does not hold a JSON object, so it was left untouched.` };
      }
      data = parsed;
    }
  }

  const servers = data[key] ?? {};
  if (!isPlainObject(servers)) {
    return { status: 'failed', detail: `"${key}" in ${file} is not an object, so it was left untouched.` };
  }
  if (SERVER_NAME in servers) return { status: 'already', detail: file };

  data[key] = { ...servers, [SERVER_NAME]: entry };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return { status: 'added', detail: file };
};

const CODEX_TABLE = new RegExp(String.raw`^\s*\[\s*mcp_servers\s*\.\s*(?:${SERVER_NAME}|"${SERVER_NAME}"|'${SERVER_NAME}')\s*\]`, 'm');

/** Append a `[mcp_servers.bruno]` table to Codex's config.toml unless one is already there. */
export const upsertCodexServer = (file: string): InstallResult => {
  const text = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  if (CODEX_TABLE.test(text)) return { status: 'already', detail: file };

  const table = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(SERVER_COMMAND)}`,
    `args = [${SERVER_ARGS.map((a) => JSON.stringify(a)).join(', ')}]`,
    ''
  ].join('\n');
  const separator = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text + separator + table);
  return { status: 'added', detail: file };
};

const installClaudeCode = (e: SetupEnv): InstallResult => {
  if (!e.hasCommand('claude')) return { status: 'failed', detail: 'The `claude` command is not on PATH.' };
  if (e.run('claude', ['mcp', 'get', SERVER_NAME]).status === 0) {
    return { status: 'already', detail: '`claude mcp get bruno` already lists it' };
  }
  const res = e.run('claude', ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', SERVER_COMMAND, ...SERVER_ARGS]);
  if (res.status === 0) return { status: 'added', detail: 'user scope, all projects' };
  return { status: 'failed', detail: (res.stderr || res.stdout).trim() || `claude exited with ${res.status}` };
};

export const CLIENTS: Client[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    location: () => 'claude mcp add --scope user',
    detect: (e) => e.hasCommand('claude'),
    install: installClaudeCode,
    nextStep: 'Start a new Claude Code session.'
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    location: claudeDesktopConfig,
    detect: (e) => exists(path.dirname(claudeDesktopConfig(e))),
    install: (e) => upsertJsonServer(claudeDesktopConfig(e), 'mcpServers', { command: SERVER_COMMAND, args: SERVER_ARGS }),
    nextStep: 'Fully quit Claude Desktop and reopen it.'
  },
  {
    id: 'cursor',
    label: 'Cursor',
    location: cursorConfig,
    detect: (e) => exists(path.dirname(cursorConfig(e))) || e.hasCommand('cursor'),
    install: (e) => upsertJsonServer(cursorConfig(e), 'mcpServers', { command: SERVER_COMMAND, args: SERVER_ARGS }),
    nextStep: 'Reload Cursor, or toggle the server in Settings > MCP.'
  },
  {
    id: 'vscode',
    label: 'VS Code (GitHub Copilot)',
    location: copilotConfig,
    detect: (e) => exists(copilotHome(e)) || exists(path.join(appDataDir(e), 'Code')) || e.hasCommand('code'),
    install: (e) =>
      upsertJsonServer(copilotConfig(e), 'mcpServers', {
        type: 'stdio',
        command: SERVER_COMMAND,
        args: SERVER_ARGS,
        tools: ['*']
      }),
    nextStep: 'Reload the VS Code window (Developer: Reload Window).'
  },
  {
    id: 'codex',
    label: 'Codex',
    location: codexConfig,
    detect: (e) => exists(codexHome(e)) || e.hasCommand('codex'),
    install: (e) => upsertCodexServer(codexConfig(e)),
    nextStep: 'Start a new Codex session.'
  }
];

export const CLIENT_IDS = CLIENTS.map((c) => c.id);

const hasCommandOnPath = (cmd: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean => {
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  return dirs.some((dir) =>
    exts.some((ext) => {
      try {
        return fs.statSync(path.join(dir, cmd + ext)).isFile();
      } catch {
        return false;
      }
    })
  );
};

export const defaultSetupEnv = (): SetupEnv => {
  const platform = process.platform;
  const env = process.env;
  return {
    home: os.homedir(),
    platform,
    env,
    hasCommand: (cmd) => hasCommandOnPath(cmd, env, platform),
    run: (cmd, args) => {
      // Windows CLIs are usually .cmd shims, which only resolve through a shell.
      const res = spawnSync(cmd, args, { encoding: 'utf8', shell: platform === 'win32', timeout: 30_000 });
      return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? (res.error ? String(res.error) : '') };
    }
  };
};
