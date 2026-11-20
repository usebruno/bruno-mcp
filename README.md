### Bruno MCP - Model Context Protocol server for Bruno

Bruno MCP is an [MCP](https://modelcontextprotocol.io) server that lets AI assistants (Claude, Cursor, and any other MCP-compatible client) work with your [Bruno](https://github.com/usebruno/bruno) API collections.

It exposes your requests, folders, and environments as MCP tools so an agent can discover, inspect, and run them, while your collections stay on your filesystem, right where Bruno keeps them.

> Bruno is an open source, offline-first API client. Collections live as plain text files in a folder, versioned with Git. Bruno MCP brings that same philosophy to AI workflows, your data never leaves your machine.

## Install

Requires Node.js 20.12 or later. The server is published on npm as [`@usebruno/mcp`](https://www.npmjs.com/package/@usebruno/mcp); MCP clients run it with `npx`, so there is nothing to install up front.

### Let your AI assistant set it up

Copy and send this message to your agent (Claude Code, Codex, Cursor, or any other MCP client):

```text
Set up Bruno MCP for me so you can work with my Bruno API collections:

1. Add the Bruno MCP server to your MCP config. It runs with `npx -y @usebruno/mcp`.
2. Let me know when it's ready and whether I need to restart anything.
```

### Set up from your terminal

```bash
npx @usebruno/mcp setup
```

It finds the MCP clients on your machine (Claude Code, Claude Desktop, Cursor, VS Code, Codex), lets you pick some or all of them, and adds Bruno MCP to each. Existing servers are kept, and a client that already has `bruno` is left as is.

To skip the prompt, e.g. in a script: `npx @usebruno/mcp setup --all` or `npx @usebruno/mcp setup --client cursor --client codex`.

### Claude Code

```bash
claude mcp add bruno -- npx -y @usebruno/mcp
# optional: pin a collection
claude mcp add bruno -- npx -y @usebruno/mcp --collection /path/to/collection
```

Verify with `claude mcp list`, then open a new session.

### Cursor

#### One-click install

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=bruno&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB1c2VicnVuby9tY3AiXX0%3D)

#### Manual config

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "bruno": {
      "command": "npx",
      "args": ["-y", "@usebruno/mcp"]
    }
  }
}
```

Reload Cursor, or toggle the server in Settings > MCP.

### VS Code

#### One-click install

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Bruno_MCP-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522bruno%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522%2540usebruno%252Fmcp%2522%255D%257D)

#### Manual config

Add to `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "bruno": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@usebruno/mcp"],
      "tools": ["*"]
    }
  }
}
```

Reload the window (Developer: Reload Window).

### Codex

```bash
codex mcp add bruno -- npx -y @usebruno/mcp
```

Or add to `~/.codex/config.toml`:

```toml
[mcp_servers.bruno]
command = "npx"
args = ["-y", "@usebruno/mcp"]
```

Check it with `codex mcp list`, then start a new session.

### Claude Desktop

Add the same `bruno` entry to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows), then fully quit Claude Desktop (⌘Q) and reopen it.

Collections are discovered automatically; to pin one, append `"--collection", "/path/to/collection"` to `args` (see [Options](#options)).

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector npx -y @usebruno/mcp
```

### Running from source

To work on the server itself, build it and point your client at the compiled entry instead of `npx`:

```bash
npm install
npm run build        # or `npm run watch` while developing
npm test
echo "$(pwd)/dist/index.js"
```

Then use `node /abs/path/to/dist/index.js` as the server command in any of the configs above, e.g. `claude mcp add bruno -- node /abs/path/to/dist/index.js`.

## Tools

| Tool | Purpose |
|---|---|
| `list_collections` | List registered collections with their name, path, and environments. Read-only. |
| `list_requests` | List the requests in a collection, flattened across folders (relative path + type + method + URL); optional `search` and `method` filters. Deliberately shallow, so it stays fast on large collections. Read-only. |
| `get_request` | Read one request's full definition from disk: headers, params, body, auth, scripts, tests, assertions, variables, docs, settings. Reads only, sends nothing. Read-only. |
| `execute_request` | Execute one request via `bru run`; returns status, request and response headers, the response body in full, assertions, and test results. Takes `collectionPath`, `requestPath`, optional `environment` and `variables` overrides. |
| `run_collection` | Run a whole collection, or a subset of requests/folders (`requests`), via `bru run`; supports `iterations`, a CSV/JSON `dataFile`, `parallel`, `bail`, and `timeoutSeconds` (default 600). Returns a pass/fail summary and a per-request roll-up (outcome, status, response time, failed assertions/tests); headers and bodies are left out. |
| `list_environments` | List a collection's environments with their variable count and whether they contain secrets. Read-only. |
| `get_environment` | Read one environment's variables (name, value, enabled, secret). Secret values come back as `<redacted>`. Read-only. |
| `list_folders` | The folder tree of a collection with the number of requests under each folder; optional `depth`. Read-only. |
| `get_collection_stats` | Request counts by method and type, folder count, environment count, and size on disk. Read-only. |
| `set_environment_variable` | Add or change one variable in an environment file (`value`, optional `enabled`, `secret`). A variable already marked secret needs `overwriteSecret: true`. |
| `remove_environment_variable` | Delete one variable from an environment file. |
| `create_collection` | Create an empty collection at `outputPath` (`yml` by default, or `bru`), with an optional `{{baseUrl}}` collection variable and description; `workspacePath` also lists it in a workspace. |
| `write_request` | Create the request at `requestPath` or edit the one already there: `name`, `method`, `url`, `headers`, `body`, `auth`, `assert`. Pass `requests` to write several at once. |
| `delete_request` | Delete the request files in `requestPaths`. Requires `confirm: true`. |
| `move_request` | Move or copy (`copy: true`) a request into another folder or collection, converting between `.bru` and `.yml` when needed. |
| `add_test_script` | Append to (or `replace`) a request's `pre-request`, `post-response`, or `tests` script. 50 KB per block. |
| `remove_script` | Clear one of a request's script blocks. |

A collection is addressed by its **path**, not by an id: pass the `path` from `list_collections` as `collectionPath` to the other tools. If you already know where a collection lives, you can pass it directly without listing first. A request is addressed by its `relativePath` within the collection (e.g. `users/get-user.bru`).

### What ends up in tool output

`execute_request` returns what the Bruno CLI reports, carrying only the CLI's own masking:

- **Request** headers whose name is known to carry credentials (`Authorization`, `Cookie`, `X-Api-Key`, `X-Auth-Token`, …) are masked; a `Bearer`/`Basic` scheme is kept, the value is not.
- Values the run knows to be secrets (`vars:secret` in the selected environment, values from `.env`) are scrubbed everywhere they appear, including URLs and bodies.

Everything else comes back as-is, including **response headers**: a `Set-Cookie` carrying a live session is returned in full. So are response bodies, URL query values, and request headers outside that name list. Treat the result as potentially containing live credentials, and the same for anything `get_request` reads out of a `.bru` file.

`get_environment` replaces the value of every variable marked secret with `<redacted>`. Non-secret values are returned as stored on disk, so a credential kept in a plain variable is returned as-is.

`run_collection` leaves headers and bodies out, but failed assertion/test messages, per-request errors, and the run `error` carry only the CLI masking above, so an assertion on a response value can echo that value back.

Response bodies are not truncated by this server. Every MCP client applies its own ceiling, so a second cap here would only lose bodies the client would have accepted.

### Writing to collections

The authoring tools write straight to your collection files, with no undo, keep collections in Git to review and revert changes.

- Files are written the way the Bruno app writes them. `.bru` files are rewritten unchanged apart from the edit. A `.yml` request is re-serialized on every edit, which drops YAML comments and fills in Bruno's default `settings`, as saving it in the app does.
- `.yml` environments and `workspace.yml` are edited in place, so comments and other entries stay as they were.
- Secret values are never written. Bruno keeps them outside collection files, so `set_environment_variable` writes a secret variable by name only; pass the value in `variables` to `execute_request` or `run_collection` to use it.
- Every write stays inside the collection: paths that leave it (including through symlinks), the `environments` folder, `.git`, and `node_modules` (in any letter case) are refused. A `write_request` or `delete_request` call that includes one bad path writes or deletes nothing.

## Collection discovery

At startup the server resolves which collections to expose. Sources, first non-empty wins:

1. **Explicit flags**: `--collection` / `--workspace` (both repeatable; a workspace expands to its member collections).
2. **CWD walk-up**: looks for `bruno.json` / `opencollection.yml` / `workspace.yml` walking up from the working directory the client spawned the server in.
3. **Bruno desktop preferences** *(on by default; `--no-auto-discovery` to disable)*: `lastOpenedWorkspaces`, `lastOpenedCollections`, and the default workspace from `preferences.json`:
   - macOS: `~/Library/Application Support/bruno/preferences.json`
   - Windows: `%APPDATA%/bruno/preferences.json`
   - Linux: `~/.config/bruno/preferences.json`

## Options

Options are passed as CLI flags when the client spawns the server (see the setup snippets above).

```
Usage: bruno-mcp [--collection <path>] [--workspace <path>]
                 [--no-cwd-discovery] [--no-auto-discovery] [--verbose]
```

| Flag | Description |
|---|---|
| `--collection <path>`, `-c` | Bruno collection directory. Repeatable. |
| `--workspace <path>`, `-w` | Bruno workspace directory. Repeatable; expands to member collections. |
| `--no-cwd-discovery` | Disable the CWD walk-up step. |
| `--no-auto-discovery` | Disable the Bruno desktop preferences fallback. |
| `--verbose` | Log debug info to stderr. |
| `--help`, `-h` | Show help. |

`bruno-mcp setup` is the separate install command described in [Set up from your terminal](#set-up-from-your-terminal); it takes `--client <id>` (`claude-code`, `claude-desktop`, `cursor`, `vscode`, `codex`; repeatable) and `--all`.

## Links

- [Bruno](https://github.com/usebruno/bruno)
- [Bruno docs](https://docs.usebruno.com)
- [Bruno CLI](https://docs.usebruno.com/bru-cli/overview)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Website](https://www.usebruno.com) · [Discord](https://discord.com/invite/KgcZUncpjq) · [X](https://twitter.com/use_bruno)

## License

MIT
