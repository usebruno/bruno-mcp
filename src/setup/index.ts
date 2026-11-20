import yargs from 'yargs/yargs';
import * as p from '@clack/prompts';

import { CLIENTS, CLIENT_IDS, defaultSetupEnv, type Client, type ClientId, type SetupEnv } from './clients.js';

const ALL = 'all' as const;
const MANUAL_SETUP_URL = 'https://github.com/usebruno/bruno-mcp#install';

const tildify = (p: string, home: string) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);

const installInto = (clients: Client[], env: SetupEnv, report: (ok: boolean, line: string) => void) => {
  const added: Client[] = [];
  let failed = 0;
  for (const client of clients) {
    const { status, detail } = client.install(env);
    if (status === 'failed') failed++;
    if (status === 'added') added.push(client);
    const line =
      status === 'added'
        ? `${client.label}: added (${tildify(detail, env.home)})`
        : status === 'already'
          ? `${client.label}: already set up (${tildify(detail, env.home)}), left as is`
          : `${client.label}: not installed. ${detail}`;
    report(status !== 'failed', line);
  }
  return { added, failed };
};

const parseSetupArgs = (argv: string[]) =>
  yargs(argv)
    .scriptName('bruno-mcp setup')
    .usage('Usage: $0 [--client <id>...] [--all]\n\nAdd the Bruno MCP server to your MCP clients. Without flags it asks which ones.')
    .option('client', {
      type: 'array',
      string: true,
      choices: CLIENT_IDS,
      describe: 'Client to set up. Repeatable.',
      default: [] as string[]
    })
    .option('all', { type: 'boolean', describe: 'Set up every client detected on this machine.', default: false })
    .help()
    .alias('h', 'help')
    .strict()
    .parseSync();

export const runSetup = async (argv: string[], env: SetupEnv = defaultSetupEnv()): Promise<number> => {
  const args = parseSetupArgs(argv);
  const detected = CLIENTS.filter((c) => c.detect(env));

  // Non-interactive: `bruno-mcp setup --client cursor --client codex` or `--all`.
  if (args.all || args.client.length > 0) {
    const ids = new Set(args.client as ClientId[]);
    const targets = args.all ? detected : CLIENTS.filter((c) => ids.has(c.id));
    if (targets.length === 0) {
      console.log(`No MCP clients detected. See ${MANUAL_SETUP_URL} to set one up by hand.`);
      return 1;
    }
    const { added, failed } = installInto(targets, env, (ok, line) => (ok ? console.log : console.error)(line));
    for (const c of added) console.log(`Next: ${c.nextStep}`);
    return failed > 0 ? 1 : 0;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('bruno-mcp setup needs an interactive terminal. Pass --client <id> or --all to run it without one.');
    return 1;
  }

  p.intro('Bruno MCP setup');
  p.log.info('MCP clients start this server on their own. This sets it up in the clients you pick.');

  if (detected.length === 0) {
    p.outro(`No MCP clients found on this machine. See ${MANUAL_SETUP_URL} to set one up by hand.`);
    return 1;
  }

  const picked = await p.multiselect<ClientId | typeof ALL>({
    message: 'Where should Bruno MCP be installed?',
    options: [
      { value: ALL, label: 'All of them' },
      ...detected.map((c) => ({ value: c.id, label: c.label, hint: tildify(c.location(env), env.home) }))
    ],
    required: true
  });
  if (p.isCancel(picked)) {
    p.cancel('Setup cancelled. Nothing was changed.');
    return 1;
  }

  const targets = picked.includes(ALL) ? detected : detected.filter((c) => picked.includes(c.id));
  const { added, failed } = installInto(targets, env, (ok, line) => (ok ? p.log.success(line) : p.log.error(line)));

  if (added.length > 0) p.note(added.map((c) => `${c.label}: ${c.nextStep}`).join('\n'), 'Next');
  p.outro(failed > 0 ? `Done, with ${failed} client(s) to finish by hand: ${MANUAL_SETUP_URL}` : 'Bruno MCP is ready.');
  return failed > 0 ? 1 : 0;
};
