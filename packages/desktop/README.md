# Relay Desktop

A desktop window for Relay. The window is a client of `relay --mode rpc`: it shows the sessions, the conversation, the harness's authorization requests, the harness state (constraints you can forget, the evidence of the last completion, approvals, context savings), the subagents the `agent` tool runs, pickers for the model and the thinking level, a dialog for the harness settings, and an accounts dialog to sign in and out (the sign-in link is shown and copied, since the window does not open a browser). It keeps no agent logic of its own.

- `src/`: the screen, in TypeScript with no framework. Model and tool text is always set as text, never parsed as HTML.
- `src-tauri/`: the Tauri 2 shell. It starts relay in RPC mode on the window's first command, writes the window's commands to its stdin, and sends each line it prints back to the window. The window may only send lines and listen to the output (`capabilities/default.json`); the content security policy allows no remote content.

## Run it

```sh
npm run build                       # in packages/desktop: compiles the screen into dist/
cargo run -p relay-desktop          # from the repository root
```

The shell runs, in this order: `RELAY_DESKTOP_COMMAND` when it is set (such as `node /path/to/relay/packages/coding-agent/dist/cli.js`), the relay binary an installer carries in `<resources>/relay/`, or `relay` from `PATH` (`relay.cmd` on Windows when npm installed it). A local build carries no binary, so it uses one of the others. `RELAY_DESKTOP_CWD` chooses the working directory.

On Linux the shell needs the WebKitGTK development packages: `libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev`.

## Installers

The release workflow's `desktop-installers` job builds an `.msi` on Windows, a `.dmg` on macOS and an AppImage on Linux with the Tauri CLI, and keeps them as artifacts of the release run. Each carries relay's standalone binary for its platform (Windows x64, macOS arm64, Linux x64): the job extracts it from the `binaries` job's archive into `src-tauri/resources/relay/`, which `tauri.conf.json` bundles, so the app needs no separate install. They are not code-signed yet, so Windows SmartScreen and macOS Gatekeeper warn on first launch. To build one locally, extract a binary built by `scripts/build-binaries.sh --platform <platform>` into `src-tauri/resources/relay/` (or leave it empty for an app that runs `relay` from `PATH`), install the CLI (`cargo install tauri-cli --version 2.12.6 --locked`) and run `cargo tauri build --bundles msi` (or `dmg`, `appimage`) in `src-tauri/`; the bundler downloads its packaging tools (WiX on Windows, linuxdeploy on Linux) on first use.

The app's version is the desktop package's (`tauri.conf.json` points at `package.json`), which the release bumps with every other package. `node scripts/make-icons.mjs` draws the icons in every size the bundlers need.

## Tests

`npm test` runs the built screen in the system Chrome through Playwright, against a scripted bridge that plays relay's side of the RPC protocol: the conversation and its tool results, streaming, the authorization dialog (focus on Deny, Escape denies), session switching, text that looks like markup, relay stopping, the harness panel and forgetting a constraint, the subagents view, the model and thinking pickers, the settings dialog (a refused value is marked and not sent), masked secret prompts, choices, and signing in and out. `test/bundle.test.ts` checks what the installers are built from without building them: the version source, the icon files and formats, the bundle targets, the bundled binary folder and the release jobs. `cargo test -p relay-desktop` checks which relay the shell runs.
