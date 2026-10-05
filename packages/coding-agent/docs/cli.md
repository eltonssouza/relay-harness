<a id="cli-and-modes-reference"></a>

# Command Line

This page documents Relay's built-in command-line commands and options. Run `relay --help` or append `--help` to a command for the exact interface in your installed version. The top-level help also includes options registered by loaded extensions.

```sh
relay [options] [--] [@files...] [messages...]
relay install <source> [options]
relay remove <source> [options]
relay uninstall <source> [options]
relay update [target] [options]
relay list
relay config [options]
relay auth <check|print-api-key|print-bearer-token> [options]
relay mcp <list|login|logout> [options]
```

<a id="modes"></a>

## Invocation and output

```sh
relay
relay --print "Summarize this repository"
git diff | relay --print "Review this change"
relay --mode json "Inspect this repository" > events.jsonl
```

With terminal stdin and stdout, Relay opens the terminal UI unless `--print`, `--mode json`, or `--mode rpc` selects another interface. When either stream is redirected and neither JSON nor RPC mode is selected, Relay uses print mode. See [CLI Integration](cli-integration.md) for choosing between interactive, print, JSON, RPC, and SDK integration.

| Input | Behavior |
|---|---|
| `message` | Provide an initial prompt |
| `@path` | Include a text file or image in the first prompt |
| Piped stdin | Prepend its contents to the first prompt |
| `--` | Stop option parsing so a prompt can begin with `-` |

Relay resolves `@path` from the current working directory. The working directory also controls project configuration, resource discovery, and session grouping.

`--print` controls whether Relay runs once and exits. `--mode` selects the output interface. `--mode text` does not force one-shot execution when stdin and stdout are terminals; use `--print` for that behavior.

| Option | Behavior |
|---|---|
| `-p`, `--print` | Run the supplied prompts, write the final assistant text to stdout, then exit |
| `--mode text` | Select text output; still open the terminal UI when stdin and stdout are terminals |
| `--mode json` | Run the supplied prompts, write JSONL events to stdout, then exit |
| `--mode rpc` | Read JSONL commands from stdin and write responses and events to stdout until shutdown |
| `--export <input> [output]` | Export a session file to HTML and exit; derive the destination when `output` is omitted |

RPC mode rejects `@file` arguments. JSON and RPC modes reserve stdout for protocol records. See [JSON Event Stream](json.md) and [RPC Protocol](rpc.md).

<a id="model-options"></a>

## Models

```sh
relay --model sonnet:high
```

See [Choose a Model](models.md) for model selection and [Providers](providers.md) for credentials.

- `--provider <name>`<br>
  Restricts `--model` lookup to one provider. It requires `--model`.
- `--model <pattern>`<br>
  Selects by exact ID or fuzzy ID/name match. It accepts `provider/id` and an optional `:<thinking>` suffix.
- `--api-key <key>`<br>
  Uses a non-persistent API-key override. It requires a model selected through `--model` or `--models`.
- `--thinking <level>`<br>
  Sets `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. It overrides a `--model` suffix and is clamped to the model's capabilities.
- `--models <patterns>`<br>
  Sets a comma-separated scope for startup and cycling. It accepts exact IDs, fuzzy matches, case-insensitive globs, and optional `:<thinking>` suffixes.
- `--list-models [search]`<br>
  Lists available models, optionally filtered by a fuzzy search, then exits.

<a id="session-options"></a>

## Sessions

```sh
relay --continue
```

See [Sessions and Context](sessions.md) for resuming, forking, naming, and storing sessions.

- `-c`, `--continue`<br>
  Continues the most recent session for the current project.
- `-r`, `--resume`<br>
  Opens the session selector.
- `--session <path|id>`<br>
  Opens by file path, exact ID, or partial ID. Relay searches the current project first and offers to fork a cross-project match.
- `--session-id <id>`<br>
  Opens the exact project session ID or creates it if absent. IDs accept letters, numbers, `.`, `_`, and `-`.
- `--fork <path|id>`<br>
  Forks an existing session into a new session for the current project.
- `--session-dir <dir>`<br>
  Overrides storage and lookup. It takes precedence over `RELAY_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting.
- `--no-session`<br>
  Uses an in-memory session that is not persisted.
- `-n`, `--name <name>`<br>
  Sets the session display name.

Constraints:

- Session IDs must start and end with a letter or number.
- `--fork` cannot be combined with `--session`, `--continue`, `--resume`, or `--no-session`.
- `--session-id` cannot be combined with `--session`, `--continue`, or `--resume`. Combine it with `--fork` to choose the new ID.

<a id="tool-options"></a>

## Tools

```sh
relay --tools read,grep,find,ls --print "Review this project"
```

See [Settings](settings.md#tools) for configuring the default tool selection.

- `-t`, `--tools <list>`<br>
  Replaces the default selection with a comma-separated allowlist of built-in, extension, or custom tools.
- `-xt`, `--exclude-tools <list>`<br>
  Disables comma-separated tool names after all other selection options.
- `-nbt`, `--no-builtin-tools`<br>
  Disables default built-in tools while retaining extension and custom tools.
- `-nt`, `--no-tools`<br>
  Starts with all built-in, extension, and custom tools disabled.

Default enabled tools are `read`, `bash`, `edit`, and `write`, unless `defaultTools` changes them. `--tools` replaces the whole selection, so name every tool you want; `defaultTools` also accepts `+name` and `-name` to change the defaults instead.

| Built-in | Purpose |
|---|---|
| `read` | Read text files and supported images |
| `bash` | Run shell commands |
| `powershell` | Run PowerShell commands on Windows |
| `edit` | Apply exact text replacements to an existing file |
| `write` | Create or overwrite a file |
| `grep` | Search file contents |
| `find` | Find paths using glob patterns |
| `ls` | List directory contents |

Built-in extensions add two more tools. They are off by default; the MCP extension turns them on when an MCP server needs them (see [MCP](mcp.md#exposure)). To enable them yourself, name them in `--tools` or `defaultTools`.

| Built-in extension | Purpose |
|---|---|
| `codemode` | Run JavaScript that calls the other tools, for example in parallel with `Promise.allSettled`; only the script's output reaches the model |
| `tool_search` | Search tools that are not declared to the model (`codemode` and `deferred` exposure, such as MCP tools) and declare the matches for the next call |

### Enable codemode

To turn on `codemode` for every session, add it to the default tools in `~/.relay/agent/settings.json` or a project's `.relay/settings.json`:

```json
{
  "defaultTools": ["+codemode"]
}
```

This keeps `read`, `bash`, `edit`, and `write` and adds `codemode`. For one invocation, list every tool, since `--tools` replaces the selection:

```sh
relay --tools read,bash,edit,write,codemode
```

Codemode is useful without MCP: scripts can run several tool calls in parallel, filter large output before it reaches the model, call classifier models such as TypeSafe's Jev through `models.classify()` (see [Classifier models](models.md#use-classifier-models)), and generate images through `models.generateImages()` (see [Image models](models.md#use-image-models)).

### How codemode works

Scripts run in a QuickJS sandbox and reach the other tools through `tools.<name>(args)`. [Codemode](codemode.md) describes the script API, how tools are listed and found, the `store()` and `models` globals, and the limits.

### Tool search

`tool_search` is off by default; enable it with `"defaultTools": ["+tool_search"]` or `--tools`. It uses the same ranking as `searchTools()` over tools that are not declared yet and declares the matches for the next model call. Loaded tools are recorded in the session like other tool changes, so they stay declared on that branch.

<a id="resource-options"></a>

## Resources

```sh
relay --extension ./review.ts
```

See [Configuration](configuration.md) for conventional directories and project trust, [Settings](settings.md#resources) for configured paths, and [Relay Packages](packages.md) for package sources.

- `-e`, `--extension <path>`<br>
  Loads an extension file or directory, or a built-in extension such as `builtin:mcp`, and is repeatable.
- `-ne`, `--no-extensions`<br>
  Disables discovered, configured, and built-in extensions. Explicit `-e` paths still load, so `relay -ne -e builtin:mcp` keeps only the built-in MCP support.
- `--skill <path>`<br>
  Loads a skill file or directory and is repeatable.
- `-ns`, `--no-skills`<br>
  Disables discovered and configured skills. Explicit `--skill` paths still load.
- `--prompt-template <path>`<br>
  Loads a prompt-template file or directory and is repeatable.
- `-np`, `--no-prompt-templates`<br>
  Disables discovered and configured templates. Explicit `--prompt-template` paths still load.
- `--theme <path>`<br>
  Loads a theme file or directory and is repeatable.
- `--use-theme <name[/name]>`<br>
  Selects the initial interactive theme for this run.
- `--no-themes`<br>
  Disables discovered and configured themes. Explicit `--theme` paths still load.
- `-nc`, `--no-context-files`<br>
  Disables `AGENTS.md` and `CLAUDE.md` discovery.

Resource paths apply only to the current process. Relative paths resolve from the current working directory.

<a id="prompt-and-display-options"></a>

## Prompts and process

```sh
relay --append-system-prompt ./instructions.md
```

See [Configuration](configuration.md) for saved configuration, [Security](security.md#understand-project-trust) for project trust, and [Environment Variables](environment-variables.md) for process controls.

- `--system-prompt <text|path>`<br>
  Replaces the default system prompt with text or the contents of an existing file.
- `--append-system-prompt <text|path>`<br>
  Appends text or an existing file to the system prompt and is repeatable.
- `--tui-mode <mode>`<br>
  Uses `fullscreen` (default) or `regular` terminal mode.
- `--verbose`<br>
  Shows verbose interactive startup information, overriding `quietStartup`.
- `-a`, `--approve`<br>
  Trusts project-local configuration and resources for this process.
- `-na`, `--no-approve`<br>
  Ignores trust-gated project-local configuration and resources for this process.
- `--offline`<br>
  Disables automatic network activity, including model catalog refreshes. Equivalent to `RELAY_OFFLINE=1`.
- `-h`, `--help`<br>
  Shows help, including flags registered by loaded extensions, then exits.
- `-v`, `--version`<br>
  Shows the Relay version, then exits.

Extensions may register additional long-form options. Unknown short options are rejected.

## Package commands

```sh
relay install npm:@scope/package
```

See [Relay Packages](packages.md) for source formats, filtering, installation, and project scope.

### Common tasks

| Task | Command |
|---|---|
| Install a package | `relay install <source>` |
| List configured packages | `relay list` |
| Remove a package and its settings entry | `relay remove <source>` |
| Configure which package resources load | `relay config` |

Add `--local` or `-l` to `install`, `remove`, `uninstall`, or `config` to use project settings instead of global settings.

### Update Relay or packages

Running `relay update` without a target updates Relay itself.

| Task | Command |
|---|---|
| Update Relay | `relay update` |
| Update all installed packages | `relay update --extensions` |
| Update one installed package | `relay update <source>` |
| Refresh model catalogs | `relay update --models` |
| Update Relay and all installed packages | `relay update --all` |

Add `--force` to reinstall Relay when the selected update includes Relay.

`relay update` cannot update Relay when another package manager provides it, such as Nix. Update Relay with that package manager, for example `nix profile upgrade relay`. Package and model catalog updates still work.

### Aliases and command options

- `relay uninstall <source>` is an alias for `relay remove <source>`.
- `relay update --self`, `relay update self`, and `relay update relay` are aliases for `relay update`.
- `relay update --extension <source>` is an alias for `relay update <source>`.
- `-a`, `--approve` trusts project-local files for one command. `-na`, `--no-approve` ignores trust-gated project-local files.
- Append `-h` or `--help` to a command for its exact usage and option constraints.

## Credential commands

```sh
relay auth check --provider openai --json
```

Authentication commands require `--provider <provider>` or `--model <model>`. See [Providers](providers.md) for supported methods.

| Command | Description |
|---|---|
| `relay auth check` | Print `ready`, `not_ready`, or `invalid`; exit with status `0`, `1`, or `2`, respectively |
| `relay auth print-api-key` | Print the resolved API key |
| `relay auth print-bearer-token` | Print a resolved OAuth bearer token |

| Option | Applies to | Description |
|---|---|---|
| `--provider <provider>` | All | Resolve credentials for a provider |
| `--model <model>` | All | Resolve credentials from a model; may be combined with `--provider` |
| `--json` | `auth check` | Write the structured result as JSON |
| `--credentials` | `auth check` | Emit the resolved credential when ready |
| `--no-refresh` | `auth check` | Do not refresh expired OAuth credentials; refresh is the default |
| `--min-expiry <duration>` | `print-bearer-token` | Require remaining token lifetime using `ms`, `s`, `m`, or `h`, such as `30m` |

Credential-printing commands write secrets to stdout.

## MCP commands

These commands work outside a session, so agents can run them through `bash`. See [MCP Servers](mcp.md).

| Command | Description |
|---|---|
| `relay mcp add <server> [options] -- <command> [args...]` | Add or replace a stdio server in `mcp.json`; `--env KEY=VALUE` (repeatable) and `--cwd <dir>` set its environment and working directory. Arguments after the command are passed to it |
| `relay mcp add <server> [options] --url <url>` | Add or replace a streamable HTTP server; `--header KEY=VALUE` (repeatable), `--bearer-token-env-var <NAME>` (sends `Authorization: Bearer ${NAME}`), `--oauth-client-id`, `--oauth-client-secret`, `--oauth-callback-port`, and `--oauth-client-name` configure authentication |
| `relay mcp remove <server>` | Remove a server from `mcp.json`; stored OAuth credentials are kept |
| `relay mcp list [--json]` | Connect to every enabled server and print its state, tools, and errors; exit with `1` when a config entry is invalid or an enabled server is not connected |
| `relay mcp login <server> [--timeout <seconds>]` | Sign in to an OAuth server: open the authorization page and wait for the browser (default 300 seconds); a terminal also accepts the pasted redirect URL |
| `relay mcp logout <server>` | Delete the stored OAuth credentials of a server |

`add` and `remove` change `~/.relay/agent/mcp.json`, or `.relay/mcp.json` in the current directory with `--local` (`-l`). `add` also takes `--exposure <mode>` (see [Exposure](mcp.md#exposure)) and `--description <text>` and does not connect; run `relay mcp list` to check the server.

Project `.relay/mcp.json` files are only read for projects that are already trusted.
