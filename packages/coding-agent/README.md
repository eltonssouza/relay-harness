<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@relay-harness/coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@relay-harness/coding-agent?style=flat-square&logo=npm&logoColor=white" /></a>
</p>

> New issues and PRs from new contributors are closed automatically. Maintainers review closed submissions daily. See [CONTRIBUTING.md](https://github.com/eltonssouza/relay-harness/blob/main/CONTRIBUTING.md).

# Relay

Relay is a minimal, extensible agent harness that you can make your own.

Adapt Relay to your workflows, not the other way around. Customize Relay with [extensions](docs/extensions.md), [skills](docs/skills.md), [prompt templates](docs/prompt-templates.md), and [themes](docs/themes.md). Bundle them as [Relay packages](docs/packages.md) and share via npm or git.

Relay ships with powerful defaults but skips features like sub-agents and plan mode. Ask Relay to build what you want, or install a package that does it your way.

Use Relay [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Relay TypeScript SDK](docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Relay requires Node.js 22.19 or newer. Install it from npm:

```bash
npm install -g --ignore-scripts @relay-harness/coding-agent
```

Relay does not require dependency lifecycle scripts, so `--ignore-scripts` is safe. To update Relay, run the same command again. `relay update` updates installed packages and model catalogs, not Relay itself.

On macOS and Linux, Nix users can install the latest release with `nix profile add github:eltonssouza/relay-harness/stable`. See the [quickstart](docs/quickstart.md#1-install-relay) for updating and pinning releases.

Start Relay in the directory where you want it to work:

```bash
cd /path/to/project
relay
```

For a built-in AI provider, run `/login` inside Relay to connect a subscription or API key. Then give Relay a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Share your OSS coding agent sessions

If you use Relay for open source work, please share your coding agent sessions.

Public OSS session data helps improve models, prompts, tools, and evaluations using real development workflows.

For the full explanation, see [this post on X by pi's author](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf), written for pi, with a Hugging Face account and the Hugging Face CLI.

- [Demo video](https://x.com/badlogicgames/status/2041151967695634619) on how to publish pi sessions
- Published pi development sessions: [`badlogicgames/pi-mono` on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono).

## Development

To work on Relay itself, clone the repository, install its dependencies, and run Relay from source:

```bash
git clone https://github.com/eltonssouza/relay-harness
cd relay
npm install --ignore-scripts
./relay-test.sh
```

`relay-test.sh` can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

Read [CONTRIBUTING.md](https://github.com/eltonssouza/relay-harness/blob/main/CONTRIBUTING.md) before opening an issue or pull request. It defines the contribution gate, issue quality bar, and required checks. Read [AGENTS.md](https://github.com/eltonssouza/relay-harness/blob/main/AGENTS.md) for repository-specific implementation, testing, dependency, and release rules.

## Credits and license

Relay is a fork of [pi](https://github.com/earendil-works/pi), the coding agent by Mario Zechner and Earendil Works, released under the MIT license. Relay adds the model-independent harness core, the `laya/auto` adaptive router, and its own release line on npm.

MIT. The license text ships in the package as `LICENSE`.
