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

- Sessions persist via the dsh storage stack; `--resume <session-id>`
  continues the conversation. On resume the prior conversation is REPLAYED
  through the bridge (`replayHistory` — the loaded dsh event log goes through
  the same translation, no model interaction), so the TUI shows the history
  immediately (verified live: a resumed "Greeting session." rendered its prior
  turns).
- **`/resume` picker**: the shim's `sessionManager.getSessionDir()` returns a
  flat bridge dir (`~/.dsh/sessions-bridge/`, configurable) populated with
  pi-format session files generated from dsh's OWN storage (the projection
  cache: id + title + cwd), pruned as sessions leave the cache — so the picker
  lists real DSH sessions (verified live: 64 infra-land sessions with titles)
  and NEVER pi's sessions (`~/.pi/agent/sessions/` is untouched).
- Selecting a session resumes IN PLACE: the TUI stops cleanly and the front
  door re-launches `dsh --profile tui-pi --resume <id>` in the same terminal
  (`detached` + `unref` so the child survives the parent's exit; verified live:
  the picked session's conversation replayed and the TUI stayed interactive).
  The current session is not listed until it has persisted storage (dsh's
  agent-loop refuses storage-less resume ids). Regression-tested:
  `switchSession` parses the bridge file id and invokes `onExit`;
  `sessionIdFromBridgeFile` round-trips.
- The startup wiring — `--resume <id>` → the resumed session identity the
  agent-loop and the tui row read — is regression-tested in
  `test/startup.test.js`; `replayHistory` in `test/bridge.test.js`.
- Resume registers the agent asynchronously; the bundle waits for it instead of
  failing on the synchronous lookup.

## pi 0.84.2 markdown rendering (inherited)

pi updates flow through automatically (the bundle imports pi as a dependency):
- ` ```mermaid ` fences → **Unicode box-drawing diagrams** (grok-mermaid
  transformer, `markdown.mermaid` setting, default `streaming`). The shim
  returns `getMermaidRenderingMode()` (bundle config → pi settings → default
  `"streaming"`), so diagrams render live while the message streams, exactly
  like pi — returning `undefined` would show raw code until the message
  settled. **Width guard (pi's own)**: a diagram whose rendered art is wider
  than the terminal falls back to raw code (`art.width > availableWidth` —
  identical behavior in pi; verified: a 222-col sequence diagram renders at
  240-col terminals and raw at 160). The bundle persona therefore instructs
  agents to keep diagrams narrow (short labels, few participants).
- `$…$` / `$$…$$` LaTeX → **symbol/layout rendering** (pi-tui's LatexParser,
  applied unconditionally in pi-tui's markdown component — no shim surface to
  feed, so it is purely inherited; verified live).
- `![alt](path)` in assistant text shows alt text only — same as pi, by design.
- Real images render via **tool results** (`Image` component) in terminals with
  image protocols (Kitty/iTerm2/Warp); pi disables them under tmux.

## Escape interrupt

Escape during a turn routes to `session.agent.abort()` → dsh `agent.cancel()`,
which clears the inbox and aborts the running phase.

## Steering

Pi's steer flow is bridged 1:1: `steer()` queues the message for the TUI's
queue display (`queue_update`), routes it to the dsh agent (`agent.steer`), and
clears the queue when the steered text is delivered as a user message.
Verified: a steered "now continue" rendered as a user message after the tool
step, with the queue drained.

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

## Render regression without a model (tmux)

`scripts/test-tui-render.sh` boots the tui-pi profile with a **scripted
transcript** — no model interaction at all. The tui plugin's TEST-ONLY
`testTranscript` config replays dsh session events through
`agent.session.append(type, data, {surfaceOp: "append"})` after boot (the same
path the agent-loop uses, so the bridge translates them 1:1), and the TUI
renders them. The script captures the pane and asserts the rendered
artifacts: the mermaid box-drawing diagram (`├───▶`) and latex unicode
(`∫`, `mc²`). Fixture: `test/fixtures/render-transcript.json`. Run:
`scripts/test-tui-render.sh`. The regression suite (`pnpm test`) never calls a
model: every test drives the bridge with crafted dsh events, fake agents, or
local tool execution.

## dsh identity (not pi)

- `PI_OFFLINE=1` suppresses pi's "Update Available / run pi update" popup and
  pi's model-catalog network fetches.
- `getQuietStartup`/`getCollapseChangelog` → true hides the "pi vX" banner,
  startup hints, and the changelog notice. The TUI shell remains pi's (the
  design premise); the terminal title and hardcoded "pi" strings are inherited.
- **Terminal hygiene**: while the front door is up, `console.log`/`warn`/
  `info`/`debug`/`error` are BUFFERED (capped) and restored after. Stray
  terminal writes — even to stderr, which is the raw terminal — land inside
  the InteractiveMode input box wherever the cursor is (and, after a quit,
  inside the NEXT session's TUI), so plugin reports that deliberately use
  `console.log` (pi2dsh's mount messages) and the front door's own status
  lines are captured, never the terminal mid-session. The buffer is flushed
  in `session.dispose()` — pi's quit path calls `runtimeHost.dispose()`
  before `process.exit(0)`, so a `ctx` dispose would never fire — making the
  reports appear cleanly after the TUI closes instead of being lost or
  leaking into the next session.
- **Resume hint**: at exit the front door prints
  `To resume this session: dsh --profile tui-pi --resume <session-id>`
  (synchronously, so pi's `process.exit(0)` cannot drop it). pi's own
  `formatResumeCommand` cannot be used: the shim reports sessions as
  non-persisted, and pi would generate `pi --session …` instead of the dsh
  command.

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
| quiet startup | `getQuietStartup`/`getCollapseChangelog` suppress pi branding |
| /export | `exportToJsonl` writes the dsh session events to a file |
| /name | `setSessionName` appends a `session/title` event; `getSessionName` returns it |
| unsupported operations | `/new`, `/import`, … reject with descriptive messages |
| steering (queue) | `queue_update` emitted; message routed to `agent.steer` |
| steering (delivery) | steered text renders as a user message after the tool step; queue drained |
| theme inheritance | migrated `themesDir` + bundle `theme` override the live pi home |
| AGENTS.md bootstrap | injected via the `system-prompt/assemble` hook |
| AGENTS.md braces | `{{…}}` escaped (dsh interpolate throws on unknown refs) |
| fullscreen settings | `tuiMode`/`fullscreenExitOutput` flow from config (neutral) |
| mermaid mode | `getMermaidRenderingMode` resolves config → pi settings → streaming |
| modelRuntime surfaces | `getAvailableSnapshot` feeds /model; `refresh` returns pi shape; OAuth/sub stubs |
| getExtensions | mounted extension packages surface in pi's extension list |
| node preloads | `loadNodePreloads` honors `--require` (module-cache idempotent, fail-safe) |
| console buffering | plugin `console.*` reports buffered, never the terminal, flushed on restore |
| startup --resume | `--resume <id>` provides the resumed session identity; fresh id otherwise |
| mermaid integration | pi's mermaid transformer renders box-drawing with the shim's mode; "off" passes raw |

### packages/extensions (test/extensions.test.js)

| Test | Guards |
|---|---|
| empty config | registry exposed, ready event emitted |
| unresolvable package | reported `failed` with error, mount event emitted |
| surfaces off | mount events suppressed, registry intact |
| localExtensions | mounted through the same path as packages |
| mount E2E | a real fixture pi package's tool executes through real dsh services (`ctx.tools.execute`) |

### packages/migrate (test/migrate.test.js)

| Test | Guards |
|---|---|
| readPiHome | settings (incl. tuiMode/fullscreenExitOutput/markdown.mermaid), themes, npm + file extensions, preloads read neutrally |
| detectPreloads | generic `*preload*` js files found, name-agnostic |
| planMigration | pi provider → dsh route; TUI settings + preloads carried; notes for install + standalone files |
| renderProfilePatch | id-targeted rows, no hardcoded values, no stale shim wording |
| applyMigration | dry-run writes nothing; apply writes themes + patch; install commands |
| missing profile | refuses with an explicit error |
