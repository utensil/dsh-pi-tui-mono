# AGENTS.md — dsh-pi-tui-mono

A pnpm monorepo: use pi's terminal experience inside DeepSeek Harness. The
front door is pi's **real** `InteractiveMode` (`@dsh-pi/tui`), pi extensions
run as dsh plugins (`@dsh-pi/extensions`, thin on pi2dsh), and an existing pi
installation's settings, themes, and extensions migrate into a dsh profile
(`@dsh-pi/migrate`). The look ships with `@earendil-works/pi-coding-agent`, so
pi TUI updates arrive without edits to this repo.

## Repo standards

- **Public-ready open source.** MIT. No private information anywhere: no
  personal paths (`/Users/<user>`), no tokens, keys, hostnames, or identity
  details. Tests and fixtures use isolated temp dirs. Never commit credentials
  or personal files.
- **Neutral packages.** No package hardcodes a model, a provider, a theme, or
  an extension list — all of that is configuration, written by
  `@dsh-pi/migrate` from a pi installation. The only translation allowed is
  documented (pi provider name → dsh route name).
- **Boundary.** dsh hosts the agent and the extensions; pi's `InteractiveMode`
  is only the terminal view. Data flows dsh → shim → TUI, never the other way.
  pi2dsh owns the pi extension ABI; `@dsh-pi/extensions` only mounts, tracks,
  and bridges.
- **JavaScript-first source** in `packages/*/lib/` (ESM). Keep the dependency
  surface minimal: pi packages plus dsh packages.

## Commit discipline

- Use **git** (not jj).
- **Author and committer** must both be the repository owner's GitHub
  identity (resolve via `gh api user --jq .login`).
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`.
  Short title explaining the *why* + a description of *what* changed.
- One logical change per commit; stage only files belonging to that change.
- **Target every git command explicitly**: before running a git operation,
  verify or ensure in the command's arguments that it targets the INTENDED
  remote (e.g. `origin`), branch (e.g. `main` / the current feature branch),
  and worktree or directory (e.g. run from the repo root or pass the intended
  `-C`/path). Do not rely on defaults, `HEAD`-relative ambiguity, or ambient
  state for destructive or push/publish operations; read `git status`,
  `git branch --show-current`, and `git remote -v` first when unsure. (The
  intended file/path set is already covered by the staging rule above.)
- ALWAYS end the title with `[AGENT]` (e.g.
  `feat: bridge dsh agent events to pi session model [AGENT]`).
- Verify before committing: `git diff --check`, package tests, and the bundle
  boots (`dsh --profile tui-pi`, tmux smoke test).

## Verification

- Parity target: the `tui` profile (`@dsh-tui/dsh-tui`) as the functional
  reference — same turns, tools, reasoning, `/resume`, and credentials work
  through this bundle's front door.
- TUI verification happens in a real terminal: tmux session + `capture-pane`,
  or herdr's `pane.read` socket API for panes outside tmux.
- Regression tests: `pnpm test` (each package runs `node --test`).
  `docs/parity.md` lists the verified pi-TUI parity features and their test
  coverage.
- Extension mounts are verified end-to-end with a local fixture package
  (package with a `pi.extensions` entry + a tool), through the real profile.
