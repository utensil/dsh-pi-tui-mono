# dsh-pi-tui-mono

**Use pi's terminal experience inside DeepSeek Harness — the same look, the same
extensions, migrated from your existing pi installation.**

If you use [pi](https://pi.dev/)'s terminal UI and want that exact experience
while running [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) underneath, this monorepo is for you. It is a drop-in: the front door
is pi's **real** `InteractiveMode` (not a reimplementation — the look ships
with pi and updates with it), the agent underneath is dsh, and pi's extensions
run as dsh plugins. A migration kit moves your installed pi settings, themes,
and extensions over.

> **Focus: TUI.** The terminal is where this project lives. The TUI comes from
> pi; the agent, tools, sessions, and credentials are dsh; pi extensions are
> bridged in as dsh plugins. Nothing here replaces dsh's headless or web
> surfaces.

## The drop-in experience

| | pi | this project (dsh + `tui-pi` profile) |
|---|---|---|
| Terminal UI | pi's `InteractiveMode` | pi's `InteractiveMode` (same code) |
| Themes | `~/.pi/agent/themes` + built-ins | inherited, or migrated into the profile |
| Agent | pi | dsh (`agent-loop`, tools, sessions, credentials) |
| Instructions | pi's AGENTS.md | the same AGENTS.md, bootstrapped into the dsh agent |
| Extensions | pi extension packages | the same packages, mounted as dsh plugins via [pi2dsh](https://github.com/weijiafu14/pi2dsh) |
| Slash commands | `/model`, `/export`, `/quit`, … | the same pi surfaces, backed by dsh |

## Packages

This is a pnpm workspace. The three packages are neutral — they never hardcode
a model, a provider, a theme, or an extension list; everything comes from
configuration, with `@dsh-pi/migrate` writing that configuration from your pi
installation.

| Package | What it does |
|---|---|
| [`@dsh-pi/tui`](packages/tui) | The pi-TUI front door: mounts pi's `InteractiveMode` over the dsh agent and translates dsh events to pi session events 1:1. |
| [`@dsh-pi/extensions`](packages/extensions) | Pi extensions as dsh plugins: a thin layer over [pi2dsh](https://github.com/weijiafu14/pi2dsh) that mounts local extension packages, exposes a mount registry, and emits TUI-bound extension events. |
| [`@dsh-pi/migrate`](packages/migrate) | The migration kit: reads an existing pi installation's settings, themes, and extensions, and writes them into a dsh profile as neutral configuration. |

## Install

You can point your agent at this repo to install, set up, and migrate
everything. The agent-facing instructions live in
[`AGENTS.md`](AGENTS.md); the short version:

```sh
# 1. Install the bundle into a profile (the `tui-pi` name is a convention).
dsh plugin --profile tui-pi add github:utensil/dsh-pi-tui-mono
dsh plugin --profile tui-pi add @dsh-pi/tui
dsh plugin --profile tui-pi add @dsh-pi/extensions

# 2. Migrate your existing pi installation (settings, theme, extensions).
npx @dsh-pi/migrate                       # dry run
npx @dsh-pi/migrate --apply               # write the profile configuration
#    then install the printed `dsh plugin add <pi-package>` commands.

# 3. Go.
dsh --profile tui-pi
dsh --profile tui-pi --resume <session-id>
```

Requirements: `dsh` CLI, Node.js `^22.19 || >=24`, pnpm.

## Development

```sh
pnpm install
pnpm test                 # runs every package's test suite
bash scripts/dev-link.sh  # link the workspace into the ~/.dsh/profiles/tui-pi profile
```

See `docs/parity.md` for the verified feature matrix.

## License

[MIT](LICENSE)
