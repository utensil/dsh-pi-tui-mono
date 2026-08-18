# pi TUI parity — verified features

This bundle mounts pi's real `InteractiveMode` (`@earendil-works/pi-coding-agent`)
over the dsh agent runtime. The features below are **verified working** (live in
a real terminal, tmux + herdr `pane.read`) and covered by regression tests in
`test/bridge.test.js` (`npm test` / `node --test test/`).

## Faithful event translation

The bridge translates dsh session events to pi session events 1:1 — it does not
reorder or reconstruct content.

- One pi message per dsh step: dsh `assistant/message` → pi `message_end`
  (each model request renders as its own assistant message).
- Content blocks keep the **natural order** produced by the model:
  dsh `reasoning` → pi `thinking`, `text` → `text`, `tool-call` → `toolCall`,
  `image` → `image` (mime/data preserved). Interleaved
  `text → tool-call → text` renders in that exact order.
- `tool/call` → **`tool_execution_start` only**: the step's message (with the
  toolCall block) has already settled, so the card renders right after it and
  before any post-tool text — matching pi's layout
  (`thinking → card → post-tool reply`).
- `tool/result` → `tool_execution_end` with the nested result content and
  `isError`.
- Completed tools leave the streaming content, so later updates never re-create
  a duplicate card.

Verified layout (matches real pi): `thinking → card X → thinking + text →
card Y → final text`.

## Thinking rendering

dsh streams reasoning as `reasoning-delta` chunks inside `block-start/…/block-end`
blocks; the bridge accumulates them into pi `thinking` content (dim italic,
exactly pi's style), one block per step (no cross-step flooding).

## Tool cards

- Arguments arrive as a JSON string; they are parsed so the card shows the real
  command (`$ echo X`, not `$ …`).
- The tool output (nested in the dsh `tool-result` block) renders in the card,
  plus `isError`.
- Duration is real (`Took 1.0s` for a `sleep 1`), driven by the
  `tool_execution_start` → `tool_execution_end` gap.

## Model switching (neutral configuration)

- Default model comes from the bundle `Config` (`defaultModel`), written by
  `@dsh-pi/migrate` from a pi installation; without it the bridge falls back to
  the dsh agent's own configured model (`agent.options.model`). Nothing is
  hardcoded in the bridge.
- `/model` (pi's dialog) switches across `availableModels` (also config, from
  migration). The switch drives `installModelSelection(agent.ctx, target)` with
  the configured provider (default `deepseek-official`, the dsh provider id —
  using `deepseek` breaks every request), updates the footer state, and applies
  to future steps.

## Session persistence + resume

- Sessions persist via the dsh storage stack (projection cache); `--resume
  <session-id>` continues the conversation (verified: resumed session
  remembered prior turns).
- Resume registers the agent asynchronously; the bundle waits for it instead of
  failing on the synchronous lookup.

## pi 0.84.2 markdown rendering (inherited)

pi updates flow through automatically (the bundle imports pi as a dependency):
- ` ```mermaid ` fences → **Unicode box-drawing diagrams** (grok-mermaid
  transformer, `markdown.mermaid` setting, default `streaming`).
- `$…$` / `$$…$$` LaTeX → **symbol/layout rendering** (pi-tui's LatexParser).
- `![alt](path)` in assistant text shows alt text only — same as pi, by design.
- Real images render via **tool results** (`Image` component) in terminals with
  image protocols (Kitty/iTerm2/Warp); pi disables them under tmux.

## Escape interrupt

Escape during a turn routes to `session.agent.abort()` → dsh `agent.cancel()`,
which clears the inbox and aborts the running phase.

## Slash commands

- Works: `/model` (flash ⇄ pro), `/scoped-models`, `/export` (session → JSONL/HTML
  file), `/name <name>` (persists a `session/title` event), `/hotkeys`, `/quit`.
- `--resume <id>` continues a persisted session (the `/resume` UI picker needs
  pi's file-based session store and is not bridged).
- Not applicable to dsh (reject with a descriptive message): `/new`, `/import`,
  `/login`, `/logout`, `/share`, `/clone`, `/trust`, `/settings`, `/tree`,
  `/fork`, `/session` pickers.

## Images: read vs read_image (dsh design)

dsh deliberately splits file access: the `read` tool is UTF-8 text only and
rejects binary files at the filesystem layer (`dsh-fs-local`, NUL-byte
detection) — unlike pi's `read`, which auto-detects images. Images display
through the dedicated `read_image` tool, which is **gated on the model's image
capability** (`deepseek-v4-flash` has none; a vision-capable model would
return an image block that the TUI renders in the tool card). The bundle adds
system-prompt guidance so agents use `read_image` for image paths instead of
hitting `read`'s binary rejection. The bridge itself renders image blocks
faithfully (unit-tested).

## pi inheritance (same device)

`@dsh-pi/tui` inherits the local pi's configuration as a bootstrap (read at
session start, not tracked):

- **Theme**: `resourceLoader.getThemes()` returns pi's full `Theme` objects —
  the custom themes from `~/.pi/agent/themes/*.json` (e.g. railscasts) plus the
  built-in dark/light — loaded through pi's own `loadThemeFromPath`, and
  `getTheme()` returns the bundle-configured theme (migrated) or pi's selected
  theme from `~/.pi/agent/settings.json`. A migrated `themesDir` (written by
  `@dsh-pi/migrate`) takes precedence.
- **AGENTS.md**: the project's `AGENTS.md`/`CLAUDE.md` (and `~/.pi/agent/`'s)
  are injected into the dsh system prompt via a `system-prompt/assemble` hook,
  so the agent follows the same instructions as pi. Template braces (`{{…}}`)
  are escaped to `{ {…}` because dsh's prompt interpolate throws on unknown or
  malformed references (e.g. `{{justfile_directory()}}`).

## Pi extensions as dsh plugins (@dsh-pi/extensions, thin on pi2dsh)

pi extension packages mount as dsh plugins through
[pi2dsh](https://github.com/weijiafu14/pi2dsh) (the upstream Pi-Host ABI
layer). `@dsh-pi/extensions` adds:

- **Local mounts**: absolute package dirs via `localExtensions` (verified
  end-to-end: a local fixture package's tool was called by the dsh agent and
  its result rendered in the TUI through the normal tool-card path).
- **Registry**: `ctx.piExtensions.list()` — what this layer mounted; the TUI
  surfaces mounted extensions in pi's extension list.
- **Surfaces seam**: `pi-extensions/*` events for TUI-bound extension UI
  (pi2dsh renders components headlessly to text; live widgets are a
  documented follow-up).
- **Migration**: `@dsh-pi/migrate` reads the installed pi extension packages
  and emits the `dsh plugin add <pkg>` commands to install them into the
  profile (pi2dsh resolves packages from the profile's node_modules).
  Standalone extension files (e.g. herdr-managed `.ts`) are not mountable
  as-is — they need a package wrapper (reported by the migration).

## Migrated pi settings (neutral, via @dsh-pi/migrate + inheritance)

The front door inherits the device pi installation's TUI-affecting settings,
verified live in the tui-pi profile:

- **Custom theme (railscasts)**: `resourceLoader.getThemes()` includes the
  custom `~/.pi/agent/themes/*.json` + built-ins; the selected theme (bundle
  `theme` config or pi's settings) renders with pi's own loader. Live-verified:
  railscasts palette (`#b294bb` borders, `#666` status).
- **Fullscreen TUI**: pi's `settings.tuiMode = "fullscreen"` is honored —
  `settingsManager.getTuiMode()` returns it (bundle config wins, pi settings
  fall back), so InteractiveMode runs its `TuiAltScreen` fullscreen layout.
  `fullscreenExitOutput = "resume-hint"` is likewise honored (the transcript
  dump is skipped). The resume command itself is printed when the dsh session
  reports persistence — wired with the `/resume` work.
- **Node preloads (e.g. Lean syntax highlighting)**: a `*-preload.cjs` in the
  pi agent dir is detected by the migration and reported; dsh requires
  bootstrap variables like NODE_OPTIONS from the LAUNCHING environment (its
  `.env` loader rejects them fail-loud), so the migration never writes them.
  When the ambient env sets `NODE_OPTIONS=--require=<preload>`, the preload
  loads at node startup AND the front door's `loadNodePreloads()` re-honors
  `--require` entries at boot (module-cache idempotent, fail-safe). Live
  verified: a ```` ```lean ```` block renders with the preload's grammar
  (keyword/entity/number colors from the railscasts palette).

## dsh identity (not pi)

- `PI_OFFLINE=1` suppresses pi's "Update Available / run pi update" popup and
  pi's model-catalog network fetches.
- `getQuietStartup`/`getCollapseChangelog` → true hides the "pi vX" banner,
  startup hints, and the changelog notice. The TUI shell remains pi's (the
  design premise); the terminal title and hardcoded "pi" strings are inherited.
- **Terminal hygiene**: while the front door is up, `console.log`/`warn`/
  `info`/`debug`/`error` are BUFFERED (capped, flushed on dispose) and
  restored after. Stray terminal writes — even to stderr, which is the raw
  terminal — land inside the InteractiveMode input box wherever the cursor
  is, so plugin reports that deliberately use `console.log` (pi2dsh's mount
  messages) must never reach the terminal mid-session. The information is
  kept in the buffered flush, the extensions registry, and the process log.

This monorepo's packages each run `node --test` (`pnpm test` at the root).
Coverage per package:

### packages/tui (test/bridge.test.js)

| Test | Guards |
|---|---|
| faithful turn lifecycle | agent_start/user/assistant/message_end/agent_end order; content blocks |
| tool turn order | message_end < tool_execution_start < tool_execution_end < next message |
| no duplicate tool cards | completed tools absent from later updates; one card per call |
| natural content order | `text, toolCall, text` preserved in one step |
| image blocks | dsh `image` → pi `ImageContent` (data/mimeType) |
| finish-only reply | a step with no streaming chunks still renders |
| model switch | footer state + closure model updated (regression: shadowing bug) |
| escape interrupt | `session.agent.abort()` → `agent.cancel("interrupted")` |
| prompt resolves | `prompt()` promise settles on `turn/end` |
| theme inheritance | migrated `themesDir` + bundle `theme` override the live pi home |
| neutral model fallback | `agent.options.model` used when no config supplied |

### packages/extensions (test/extensions.test.js)

| Test | Guards |
|---|---|
| empty config | registry exposed, ready event emitted |
| unresolvable package | reported `failed` with error, mount event emitted |
| surfaces off | mount events suppressed, registry intact |
| localExtensions | mounted through the same path as packages |

### packages/migrate (test/migrate.test.js)

| Test | Guards |
|---|---|
| readPiHome | settings, themes, npm + file extensions read neutrally |
| planMigration | pi provider → dsh route, notes for install + standalone files |
| renderProfilePatch | id-targeted rows, no hardcoded values, no stale shim wording |
| applyMigration | dry-run writes nothing; apply writes themes + patch; install commands |
| missing profile | refuses with an explicit error |
