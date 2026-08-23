/**
 * @dsh-pi/tui bridge — a pi `AgentSession`-shaped bridge over a dsh agent.
 *
 * Translates the dsh agent event stream (cordis `session/event`) into the pi
 * session events that `InteractiveMode` renders (message_start / message_update
 * / message_end / tool_execution_* / agent_start / agent_end ...), and routes
 * user input back into the dsh agent (followup / steer).
 *
 * The shapes follow `@earendil-works/pi-ai` (AssistantMessage / content blocks)
 * and `@earendil-works/pi-coding-agent` InteractiveMode's handleEvent contract.
 *
 * Model surfaces are deliberately neutral: the default model, the /model
 * picklist, and the provider come from the bundle `Config` (or fall back to the
 * dsh agent's own current model), never hardcoded here. `@dsh-pi/migrate`
 * writes that config from an existing pi installation's settings.
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { zstdDecompressSync } from "node:zlib";


const textBlocks = (content) =>
  (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n\n");

/** The dsh resume command printed at TUI exit (pi's own formatResumeCommand
 * cannot run: our shim reports sessions as non-persisted, and pi's generated
 * command would say `pi --session ...`). */
export function formatResumeHint(sessionId) {
  return `To resume this session: dsh --profile tui-pi --resume ${sessionId}`;
}

/** Build a pi-shaped AssistantMessage with the given content blocks. */
function assistantMessage(model, content, over = {}) {
  return {
    role: "assistant",
    content,
    api: "openai",
    provider: "openai",
    model: typeof model === "string" ? model : (model?.id ?? "unknown"),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
    ...over,
  };
}

/** Translate one dsh assistant content block to pi's shape, preserving order. */
function translateDshContentBlock(block) {
  switch (block?.type) {
    case "text":
      return block.text ? { type: "text", text: block.text } : undefined;
    case "reasoning":
      return block.text ? { type: "thinking", thinking: block.text } : undefined;
    case "tool-call":
      let args = block.arguments ?? {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      return { type: "toolCall", id: block.id ?? "", name: block.name ?? "tool", arguments: args };
    case "image":
      // dsh image blocks carry the payload (data/base64 or url) plus a media
      // type; pi renders {type:"image", data, mimeType} in tool cards.
      return {
        type: "image",
        data: block.data ?? block.base64 ?? block.url ?? "",
        mimeType: block.mimeType ?? block.mediaType ?? "image/png",
      };
    default:
      return undefined;
  }
}

/** Directory of the local pi installation (the agent whose look we inherit). */
const piAgentDir = () => join(homedir(), ".pi", "agent");
/** Flat dir of pi-format session files the /resume picker reads. These are
 * generated from dsh's own session storage so the picker lists DSH sessions
 * (never pi's), and resuming one maps back to `dsh --resume <id>`. */
const dshSessionsBridgeDir = (override) => override ?? join(homedir(), ".dsh", "sessions-bridge");
/** dsh's persisted-session projection cache (id -> {identity, rows}). */
const dshProjcachePath = (override) => override ?? join(homedir(), ".dsh", "storages", "session_projcache.json");

/** Generate pi-format session files for dsh's persisted sessions so the
 * /resume picker lists real dsh sessions (id + title from the projection
 * cache), never pi's session files. Files are pruned when a session leaves
 * the cache. The bridge dir is flat `*.jsonl`, one per session. */
function writeSessionBridgeFiles(dir, sessions, current, messagesRoot) {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  const wanted = new Set();
  const write = (id, cwd, title) => {
    if (!id) return;
    wanted.add(id);
    const lines = [JSON.stringify({ type: "session", id, cwd, timestamp: Date.now() })];
    if (title) lines.push(JSON.stringify({ type: "session_info", name: title }));
    // Real message lines give the picker accurate turn counts, previews, and
    // activity times (without them every session shows "0 now").
    const messages = loadDshSessionMessages(id, messagesRoot);
    for (const m of messages) {
      lines.push(JSON.stringify({
        type: "message",
        id: `${id}-${lines.length}`,
        timestamp: new Date(m.timestamp).toISOString(),
        message: { role: m.role, content: m.content, timestamp: m.timestamp },
      }));
    }
    try {
      writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
    } catch {
      /* best-effort */
    }
  };
  for (const [id, entry] of Object.entries(sessions)) {
    if (typeof id !== "string" || !id.startsWith("main-session-")) continue;
    const identity = entry?.identity ?? {};
    const title = entry?.rows?.title?.val;
    write(id, identity.cwd, typeof title === "string" && title ? title : undefined);
  }
  // The CURRENT session is deliberately NOT written: until it has persisted
  // storage it cannot be resumed (the dsh agent-loop refuses storage-less
  // resume ids), and once it persists it appears here via the projection
  // cache on the next boot.
  if (current && sessions[current.id]) write(current.id, current.cwd, current.title);
  // Prune files for sessions no longer in the cache.
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const id = f.slice(0, -".jsonl".length);
      if (!wanted.has(id)) {
        try {
          rmSync(join(dir, f), { force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    /* best-effort */
  }
}

/** Load dsh's projection cache: session id -> {identity, rows}. Never throws. */
function loadDshSessions(projcachePath) {
  try {
    const cache = JSON.parse(readFileSync(projcachePath, "utf8"));
    return cache?.tables?.sessions ?? {};
  } catch {
    return {};
  }
}

/** Decode a dsh session log (.jsonl.zstd): the persistence appends zstd
 * frames, so each frame is decompressed separately and concatenated. */
function decodeZstdFrames(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const parts = [];
  let o = 0;
  while (o < buf.length) {
    const idx = buf.indexOf(MAGIC, o);
    if (idx === -1) break;
    let end = buf.indexOf(MAGIC, idx + 4);
    if (end === -1) end = buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(idx, end)).toString("utf8"));
    } catch {
      break;
    }
    o = end;
  }
  return parts.join("");
}

/** Extract the user/assistant TEXT messages of a dsh session from its log, so
 * the /resume picker shows real turn counts, previews, and activity times
 * instead of "0 now". Best-effort; never throws. */
function loadDshSessionMessages(id, base = join(homedir(), ".dsh", "sessions")) {
  if (!id || !existsSync(base)) return [];
  const messages = [];
  try {
    for (const cwdDir of readdirSync(base)) {
      const file = join(base, cwdDir, id, "session.jsonl.zstd");
      if (!existsSync(file)) continue;
      const text = decodeZstdFrames(readFileSync(file));
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type === "user/message") {
          const textBlocks = (e.data?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).filter(Boolean);
          if (textBlocks.length > 0) {
            messages.push({ role: "user", content: textBlocks.map((text) => ({ type: "text", text })), timestamp: e.time ?? Date.now() });
          }
        } else if (e.type === "assistant/message") {
          const textBlocks = (e.data?.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).filter(Boolean);
          if (textBlocks.length > 0) {
            messages.push({ role: "assistant", content: textBlocks.map((text) => ({ type: "text", text })), timestamp: e.time ?? Date.now() });
          }
        }
      }
      break; // found this session's log
    }
  } catch {
    /* best-effort */
  }
  return messages;
}

/** The pi-format session id embedded in a bridge file (first line header). */
export function sessionIdFromBridgeFile(path) {
  try {
    const first = readFileSync(path, "utf8").split("\n", 1)[0];
    const header = JSON.parse(first);
    return typeof header?.id === "string" ? header.id : undefined;
  } catch {
    return undefined;
  }
}
const piThemeDir = (() => {
  try {
    // The pi package exports only the import condition; resolve it via ESM.
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    return join(dirname(dirname(entry)), "dist", "modes", "interactive", "theme");
  } catch {
    return "";
  }
})();

/** Scan migrated + pi's custom + built-in themes into full Theme objects (via
 * pi's own loader, so the TUI's theme.fg/etc. work). A migrated themes dir
 * (written by @dsh-pi/migrate) takes precedence over the live pi home. */
function loadPiThemes(extraDir) {
  const themes = [];
  let loadThemeFromPath = null;
  try {
    // require(esm) is stable on Node >=22; theme.js is not an exported
    // package subpath, so resolve it by absolute path under the pi package.
    loadThemeFromPath = createRequire(import.meta.url)(join(piThemeDir, "theme.js")).loadThemeFromPath;
  } catch {
    loadThemeFromPath = null;
  }
  const add = (sourcePath, fallbackName) => {
    try {
      themes.push(loadThemeFromPath ? loadThemeFromPath(sourcePath) : { name: fallbackName, sourcePath });
    } catch {
      themes.push({ name: fallbackName, sourcePath });
    }
  };
  for (const dir of [extraDir, join(piAgentDir(), "themes")]) {
    if (dir && existsSync(dir)) {
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
        add(join(dir, f), basename(f, ".json"));
      }
    }
  }
  for (const n of ["dark", "light"]) {
    const p = join(piThemeDir, `${n}.json`);
    if (existsSync(p)) add(p, n);
  }
  return themes;
}

/** The selected theme: bundle config (migrated) wins, else pi's settings. */
function piSelectedTheme(preferred) {
  if (typeof preferred === "string" && preferred) return preferred;
  return piSettings().theme;
}

/** Read the local pi installation's settings.json (the agent whose look and
 * behavior we inherit). Missing file or field -> undefined; never throws. */
function piSettings() {
  try {
    const s = JSON.parse(readFileSync(join(piAgentDir(), "settings.json"), "utf8"));
    return {
      theme: typeof s.theme === "string" && s.theme ? s.theme : undefined,
      tuiMode: typeof s.tuiMode === "string" && s.tuiMode ? s.tuiMode : undefined,
      fullscreenExitOutput: typeof s.fullscreenExitOutput === "string" && s.fullscreenExitOutput ? s.fullscreenExitOutput : undefined,
      mermaidRenderingMode: typeof s.markdown?.mermaid === "string" && s.markdown.mermaid ? s.markdown.mermaid : undefined,
    };
  } catch {
    return {};
  }
}

/** Bootstrap context files pi would load (global + project AGENTS.md). */
function loadPiContextFiles(cwd) {
  const parts = [];
  for (const dir of [piAgentDir(), cwd]) {
    for (const name of ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"]) {
      const p = join(dir, name);
      if (existsSync(p) && statSync(p).isFile()) {
        parts.push(`# ${name} (from ${dir})\n\n${readFileSync(p, "utf8").replace(/\{\{/g, "{ {")}`);
        break;
      }
    }
  }
  return parts.join("\n\n");
}

export function createPiSessionShim(ctx, agent, sessionId, options = {}) {
  const dshSession = agent.session;
  // Model surfaces are neutral: the bundle config (written by @dsh-pi/migrate)
  // supplies the default model, the /model picklist, and the provider; without
  // it we fall back to the dsh agent's own current model so nothing is
  // hardcoded here.
  const {
    defaultModel,
    availableModels = [],
    provider = "deepseek-official",
    themesDir,
    theme,
    tuiMode,
    fullscreenExitOutput,
    mermaidRenderingMode,
    consoleBuffer,
    resumeHint,
    sessionsDir,
    projcachePath,
    dshSessionsRoot,
  } = options;
  const resolvedDefaultModel = defaultModel ?? agent.session?.model ?? agent.options?.model ?? "unknown";
  const available = availableModels.length > 0
    ? availableModels.map((m) => (typeof m === "string" ? { id: m, provider, name: m } : m))
    : [{ id: resolvedDefaultModel, provider, name: resolvedDefaultModel }];
  // Per-request model override for the dsh agent (mirrors @dsh-tui's
  // /model wiring): mutating target.current changes future steps only.
  const target = { current: { provider, model: resolvedDefaultModel } };
  const disposeModelSelection = installModelSelection(agent.ctx, target);
  const cwd = dshSession?.header?.cwd ?? process.cwd();
  const listeners = new Set();
  const pendingPrompts = [];
  const toolCalls = new Map(); // callId -> { name, arguments }
  // Live agent-state flags pi-tui's escape handling gates on: Esc aborts the
  // running turn only when isStreaming/isBashRunning are true (the previous
  // static false made the escape handler fall through and do nothing).
  let turnActive = false;
  let bashRunning = false;
  let model = resolvedDefaultModel;

  // Bootstrap: inherit pi's AGENTS.md/CLAUDE.md (global + project) into the
  // dsh system prompt so the agent follows the same instructions as pi.
  const agentsMd = loadPiContextFiles(cwd);
  const disposeAgentsMd = agentsMd
    ? agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
        try {
          const assembled = await next();
          return {
            ...assembled,
            sections: [
              ...(assembled.sections ?? []),
              { name: "bootstrap:agents-md", order: 50, text: agentsMd },
            ],
          };
        } catch (err) {
          process.stderr.write(`[dsh-pi] assemble hook failed: ${err?.message ?? err}\n`);
          return _assembly;
        }
      })
    : () => {};

  // The steering queue mirrors pi's session queue: ANY caller of the dsh
  // agent's steer — the shim's own session.steer, pi2dsh's session bridge
  // (extension steers), or a direct agent.steer — must feed the TUI's pending
  // display. Wrapping the agent's steer is the deterministic seam (no event
  // sniffing): every steer queues + emits queue_update, deduped.
  const queueSteer = (text) => {
    if (typeof text === "string" && text.trim() && !steeringMessages.includes(text)) {
      steeringMessages.push(text);
      emit({ type: "queue_update" });
    }
  };
  if (typeof agent.steer === "function") {
    const originalSteer = agent.steer.bind(agent);
    agent.steer = (message) => {
      queueSteer(textBlocks(typeof message === "string" ? [{ type: "text", text: message }] : message?.content));
      return originalSteer(message);
    };
  }
  let sessionName = "";
  // Seed the /resume picker's session list from dsh's own storage (never
  // pi's), including the current session so it can be resumed by id.
  const bridgeDir = dshSessionsBridgeDir(sessionsDir);
  writeSessionBridgeFiles(
    bridgeDir,
    loadDshSessions(dshProjcachePath(projcachePath)),
    sessionId ? { id: sessionId, cwd, title: undefined } : undefined,
    dshSessionsRoot,
  );
  let steeringMessages = []; // pending steers for the TUI's queue display

  // Session state pi reads (footer model/context); model updates with setModel.
  const stateRef = {
    messages: [],
    streaming: false,
    compacting: false,
    model: { ...available[0] },
    thinkingLevel: "high",
  };

  // Streaming state for the current assistant message.
  let streamingText = "";
  let streamingThinking = "";
  let assistantStarted = false;
  let streamingBlockType = "text";

  const emit = (event) => {
    for (const cb of [...listeners]) {
      try {
        void cb(event);
      } catch (err) {
        // a failing listener must not break the event loop
        process.stderr.write(`[dsh-pi] listener error: ${err?.message ?? err}\n`);
      }
    }
  };

  const emitTextUpdate = () => {
    const content = [];
    if (streamingThinking) content.push({ type: "thinking", thinking: streamingThinking });
    if (streamingText) content.push({ type: "text", text: streamingText });
    const partial = assistantMessage(model, content);
    emit({
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: streamingText,
        partial,
      },
    });
  };

  const onSessionEvent = (subject, event) => {
    if (subject !== dshSession) return;
    switch (event.type) {
      case "turn/start": {
        turnActive = true;
        streamingText = "";
        streamingThinking = "";
        assistantStarted = false;
        toolCalls.clear();
        emit({ type: "agent_start" });
        break;
      }
      case "user/message": {
        // A delivered user turn clears pending steering entries (pi splices
        // _steeringMessages when the agent claims the message).
        if (steeringMessages.length > 0 && event.data?.source?.kind === "user") {
          const text = textBlocks(event.data?.content);
          // A steered message stays displayed (Steering: <msg> + the dequeue
          // hint) until the turn processing it ends; only a NEW user message
          // that is not a pending steer takes over and clears the queue.
          if (!(text && steeringMessages.includes(text))) {
            steeringMessages = [];
            emit({ type: "queue_update" });
          }
        }
        const sourceKind = event.data?.source?.kind;
        // A PLUGIN-delivered plain-text message (e.g. an extension steer via
        // pi2dsh's session.steer) is real content, not runtime context — show
        // it in pi's pending display (Steering: <msg> + the dequeue hint) so
        // extension steers present exactly like pi.
        // A plugin-delivered message whose text matches a pending steer is the
        // steer's delivery: pi shows it in the pending display AND as a user
        // turn in the conversation once the agent claims it. Anything else
        // with a non-user source (dsh's runtime-context snapshots, skill
        // catalogs, instructions, notifications) stays filtered.
        if (sourceKind === "plugin") {
          const steeredText = textBlocks(event.data?.content);
          if (steeredText && steeringMessages.includes(steeredText)) {
            emit({
              type: "message_start",
              message: { role: "user", content: [{ type: "text", text: steeredText }], timestamp: Date.now() },
            });
          }
          break;
        }
        // Render only genuine user turns. dsh injects runtime context (system
        // prompt, skill catalog, project files) as user/message events; those
        // have a non-"user" source and would flood the transcript.
        if (sourceKind !== "user" && sourceKind !== undefined) break;
        if (sourceKind === undefined && !event.data?.message?.source?.callId) break;
        const text = textBlocks(event.data?.content);
        if (!text) break;
        emit({
          type: "message_start",
          message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
        });
        break;
      }
      case "assistant/chunk": {
        // dsh streams assistant output as block-start / delta / block-end
        // chunk events. Maintain the natural content order: reasoning, text,
        // and tool-call blocks interleaved exactly as the model produced them.
        const c = event.data?.chunk;
        if (c?.type === "block-start") {
          streamingBlockType = c.blockType ?? "text";
        } else if (c?.type === "text-delta" || c?.type === "reasoning-delta") {
          if (!assistantStarted) {
            assistantStarted = true;
            // pi creates its streaming assistant component on message_start
            // with role assistant (after the user message rendered above).
            emit({
              type: "message_start",
              message: assistantMessage(model, []),
            });
          }
          if (streamingBlockType === "reasoning" || c.type === "reasoning-delta") {
            streamingThinking = streamingThinking + c.text;
          } else {
            streamingText = streamingText + c.text;
          }
          emitTextUpdate();
        } else if (c?.type === "block-end" && c.block) {
          if (c.block.type === "text") streamingText = c.block.text;
          else if (c.block.type === "reasoning") streamingThinking = c.block.thinking ?? c.block.text ?? streamingThinking;
          emitTextUpdate();
        }
        break;
      }
      case "tool/call": {
        const callId = event.data?.callId ?? String(event.seq);
        const name = event.data?.name ?? "tool";
        // dsh serializes tool arguments as a JSON string; pi's tool cards read
        // them as an object (e.g. bash args.command for the `$` title).
        let args = event.data?.arguments ?? {};
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        toolCalls.set(callId, { name, arguments: args, startedAt: Date.now() });
        if (name === "bash" || name === "bash_persistent") bashRunning = true;
        // The step's assistant message (with the toolCall block) already
        // settled via assistant/message. Emit only the execution card so the
        // card renders right after that message, before any post-tool text.
        emit({ type: "tool_execution_start", toolName: name, toolCallId: callId, args });
        break;
      }
      case "tool/result": {
        const callId = event.data?.message?.source?.callId;
        if (callId) {
          const call = toolCalls.get(callId);
          // dsh nests the tool output inside a "tool-result" content block.
          const resultBlocks = (event.data?.message?.content ?? []).find((b) => b.type === "tool-result");
          let resultContentBlocks = resultBlocks?.content ?? event.data?.message?.content ?? [];
          resultContentBlocks = resultContentBlocks.map(translateDshContentBlock).filter(Boolean);
          const isError = resultBlocks?.isError ?? false;
          emit({
            type: "tool_execution_end",
            toolName: call?.name ?? "tool",
            toolCallId: callId,
            result: { content: resultContentBlocks },
            isError,
          });

          toolCalls.delete(callId);
          if (call?.name === "bash" || call?.name === "bash_persistent") bashRunning = false;
        }
        break;
      }
      case "assistant/message": {
        // dsh emits one assistant/message per model step. Translate the
        // step's final content blocks to pi's shapes IN THE NATURAL ORDER
        // (reasoning, text, tool-call interleaved as produced) and settle the
        // step as its own pi message — exactly one message per model request.
        const blocks = event.data?.message?.content ?? [];
        const piContent = blocks.map(translateDshContentBlock).filter(Boolean);
        if (!assistantStarted && piContent.length > 0) {
          // A step can complete without streaming chunks (a finish-only
          // response); open the component so the content still renders.
          assistantStarted = true;
          emit({ type: "message_start", message: assistantMessage(model, []) });
        }
        emit({ type: "message_end", message: assistantMessage(model, piContent) });
        streamingText = "";
        streamingThinking = "";
        assistantStarted = false;
        toolCalls.clear();
        break;
      }
      case "turn/end": {
        turnActive = false;
        bashRunning = false;
        // An Esc abort surfaces as turn/end with reason.kind "aborted"; pi-tui
        // renders "Operation aborted" on a message_end whose stopReason is
        // "aborted" — mirror that.
        const aborted = event.data?.reason?.kind === "aborted";
        // The turn consumed any delivered steers; drop the queue display.
        if (steeringMessages.length > 0) {
          steeringMessages = [];
          emit({ type: "queue_update" });
        }
        if (assistantStarted) {
          // A step was still streaming when the turn ended without its
          // assistant/message boundary; settle the pending content.
          const finalContent = [];
          if (streamingThinking) finalContent.push({ type: "thinking", thinking: streamingThinking });
          if (streamingText) finalContent.push({ type: "text", text: streamingText });
          for (const [callId, call] of toolCalls) {
            finalContent.push({ type: "toolCall", id: callId, name: call.name, arguments: call.arguments });
          }
          emit({
            type: "message_end",
            message: assistantMessage(model, finalContent, aborted ? { stopReason: "aborted" } : {}),
          });
          assistantStarted = false;
        }
        emit({ type: "agent_end" });
        streamingText = "";
        streamingThinking = "";
        assistantStarted = false;
        toolCalls.clear();
        const resolvers = pendingPrompts.splice(0);
        for (const resolve of resolvers) resolve();
        break;
      }
      case "session/title": {
        emit({ type: "session_info_changed" });
        break;
      }
      default:
        break;
    }
  };

  const disposeEvents = ctx.on("session/event", onSessionEvent);

  const noopService = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        return (..._args) => {
          switch (prop) {
            case "getShowTerminalProgress":
              return false;
            case "getShowImages":
              return true;
            case "getQuietStartup":
            case "getCollapseChangelog":
              return true;
            case "getTheme":
              return piSelectedTheme(options?.theme);
            case "getTuiMode":
              return options?.tuiMode ?? piSettings().tuiMode ?? "regular";
            case "getFullscreenExitOutput":
              return options?.fullscreenExitOutput ?? piSettings().fullscreenExitOutput ?? "transcript";
            case "getMermaidRenderingMode":
              // pi renders mermaid live while streaming (default "streaming");
              // returning undefined would show raw code until the message settles.
              return options?.mermaidRenderingMode ?? piSettings().mermaidRenderingMode ?? "streaming";
            case "getImageWidthCells":
              return 40;
            case "getShowHardwareCursor":
            case "getClearOnShrink":
            case "getEnableSkillCommands":
            case "getCollapseChangelog":
            case "getQuietStartup":
              return false;
            case "getEditorPaddingX":
              return 1;
            case "getAutocompleteMaxVisible":
              return 8;
            case "getHideThinkingBlock":
              return false;
            case "getOutputPad":
              return 0;
            case "getWarnings":
              return { anthropicExtraUsage: false };
            default:
              return undefined;
          }
        };
      },
    },
  );

  const shim = {
    sessionId,
    cwd,
    get model() {
      return { id: model, provider, name: model };
    },
    set model(value) {
      if (typeof value === "string") model = value;
      else if (value?.id) model = value.id;
    },
    autoCompactionEnabled: true,
    settingsManager: noopService,
    modelRuntime: {
      isUsingSubscription: () => false,
      isUsingOAuth: () => false,
      getAvailableSnapshot: () => [...available],
      getModel: () => undefined,
      getError: () => undefined,
      getAuth: () => undefined,
      checkAuth: () => undefined,
      refresh: async (opts) => ({ aborted: opts?.signal?.aborted === true, errors: new Map() }),
      getModels: () => [],
    },
    sessionManager: new Proxy(
      {
        getCwd: () => cwd,
        getEntries: () => [],
        buildContextEntries: () => [],
        getTree: () => [],
        getLeafId: () => undefined,
        getSessionDir: () => dshSessionsBridgeDir(sessionsDir),
        getSessionFile: () => undefined,
        getSessionId: () => sessionId,
        getSessionName: () => (sessionName || undefined),
        isPersisted: () => false,
        appendLabelChange: () => undefined,
        buildSessionContext: () => ({ messages: [], cwd, systemPrompt: "" }),
        usesDefaultSessionDir: () => true,
      },
      {
        get(target, prop) {
          if (prop in target) return target[prop];
          return (..._args) => undefined;
        },
      },
    ),
    scopedModels: [],
    modelRegistry: {
      getAvailable: () => [...available],
      getAll: () => [],
      getApiKeyForProvider: () => undefined,
      getError: () => undefined,
      getProviderAuthStatus: () => "authed",
      getProviderDisplayName: () => "DeepSeek",
      isUsingOAuth: () => false,
      isUsingSubscription: () => false,
      refresh: async () => undefined,
      authStorage: undefined,
    },
    resourceLoader: {
      getThemes: () => ({ themes: loadPiThemes(options?.themesDir), diagnostics: [], errors: [] }),
      loadTheme: (name) => loadPiThemes(options?.themesDir).find((t) => t.name === name)?.sourcePath,
      getSkills: () => ({ skills: [], diagnostics: [], errors: [] }),
      getExtensions: () => ({ extensions: options?.extensions ?? [], diagnostics: [], errors: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [], errors: [] }),
      getAgentsFiles: () => ({ agentsFiles: [], diagnostics: [], errors: [] }),
      getSystemPromptSource: () => undefined,
      getAppendSystemPromptSources: () => [],
    },
    state: stateRef,
    get isStreaming() {
      return turnActive;
    },
    get isBashRunning() {
      return bashRunning;
    },
    isCompacting: false,
    steeringMode: "steer",
    thinkingLevel: "high",
    systemPrompt: "",
    promptTemplates: [],

    get messages() {
      return [];
    },


    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    async prompt(text, images) {
      const content = [{ type: "text", text }];
      if (images?.length) {
        for (const img of images) {
          content.push({ type: "image", data: img.data ?? "", mimeType: img.mimeType ?? "image/png" });
        }
      }
      return new Promise((resolve) => {
        pendingPrompts.push(resolve);
        try {
          agent.followup(createUserMessage({ content, source: { kind: "user" } }));
        } catch (err) {
          process.stderr.write(`[dsh-pi] followup failed: ${err?.message ?? err}\n`);
        }
      });
    },

    steer(text) {
      if (typeof text !== "string" || !text.trim()) return;
      // Mirror pi's session.steer: queue the message for the TUI display,
      // emit queue_update, then inject it into the active turn.
      queueSteer(text);
      try {
        agent.steer(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
      } catch (err) {
        process.stderr.write(`[dsh-pi] steer failed: ${err?.message ?? err}\n`);
      }
    },
    getSteeringMessages() {
      return [...steeringMessages];
    },

    getLastAssistantText() {
      const events = dshSession?.events ?? [];
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].type === "assistant/message") {
          return textBlocks(events[i].data?.message?.content) ?? "";
        }
      }
      return "";
    },

    getContextUsage() {
      return { percent: 0, tokens: 0 };
    },

    getSessionStats() {
      return { turns: 0, messages: dshSession?.events?.length ?? 0 };
    },

    getAvailableThinkingLevels() {
      return ["off", "low", "medium", "high"];
    },

    setThinkingLevel(level) {
      if (typeof level === "string") {
        target.current = { ...target.current, reasoningEffort: level };
      }
    },
    setModel(nextModel) {
      const id = typeof nextModel?.id === "string" ? nextModel.id : nextModel?.model ?? resolvedDefaultModel;
      target.current = { provider, model: id };
      model = id;
      stateRef.model = { id, provider, name: id };
      return Promise.resolve();
    },
    cycleModel() {
      const next = available[(available.findIndex((m) => m.id === model) + 1) % available.length];
      target.current = { provider, model: next.id };
      model = next.id;
      stateRef.model = { id: next.id, provider: next.provider, name: next.name };
      return Promise.resolve();
    },
    setScopedModels() {},
    setSessionName(name) {
      if (typeof name === "string" && name.trim()) {
        sessionName = name.trim();
        try {
          dshSession.append("session/title", { title: name.trim() });
        } catch (err) {
          process.stderr.write(`[dsh-pi] setSessionName failed: ${err?.message ?? err}\n`);
        }
        // Keep the /resume picker's entry for the current session fresh.
        writeSessionBridgeFiles(bridgeDir, loadDshSessions(dshProjcachePath(projcachePath)), { id: sessionId, cwd, title: sessionName }, dshSessionsRoot);
      }
    },
    setAutoCompactionEnabled() {},
    setFollowUpMode() {},
    setSteeringMode() {},
    clearQueue() {
      const result = { steering: [...steeringMessages], followUp: [] };
      steeringMessages = [];
      emit({ type: "queue_update" });
      return result;
    },
    compact() {},
    reload() {},
    executeBash() {},
    recordBashResult() {},
    bindExtensions() {},
    abortBash() {},
    abortBranchSummary() {},
    abortCompaction() {},
    abortRetry() {},
    navigateTree() {},
    followUp() {},
    fork() {},
    exportToJsonl(outputPath) {
      const events = dshSession?.events ?? [];
      const filePath = outputPath ?? join(cwd, `session-${Date.now()}.jsonl`);
      writeFileSync(filePath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      return filePath;
    },
    async exportToHtml(outputPath, _opts) {
      const events = dshSession?.events ?? [];
      const filePath = outputPath ?? join(cwd, `session-${Date.now()}.html`);
      const body = events.map((e) => JSON.stringify(e)).join("\n").replace(/&/g, "&amp;").replace(/</g, "&lt;");
      writeFileSync(filePath, `<html><body><pre>${body}</pre></body></html>`);
      return filePath;
    },
    getUserMessagesForForking() {
      return [];
    },
    getToolDefinition() {},

    getFollowUpMessages() {
      return [];
    },
    get entries() {
      return [];
    },
    agent: {
      model: resolvedDefaultModel,
      reasoningEffort: "high",
      // Escape-interrupt calls session.agent.abort(); route it to the dsh
      // agent's cancel (clears the inbox and aborts the running phase).
      abort: () => {
        try { agent.cancel("interrupted"); } catch (err) {
          process.stderr.write(`[dsh-pi] abort failed: ${err?.message ?? err}\n`);
        }
      },
      signal: undefined,
      transport: undefined,
    },
    extensionRunner: {
      getRegisteredCommands: () => [],
      getRegisteredToolDefinitions: () => [],
      getCommandDiagnostics: () => [],
      getShortcutDiagnostics: () => [],
      getMessageRenderer: () => undefined,
      getShortcuts: () => [],
      getCommand: () => undefined,
      emitUserBash: () => undefined,
      getMarkdownTransformers: () => [],
    },

    replayHistory() {
      // A resumed dsh session loads its event log but does not re-emit it;
      // replay it through the same translation so the TUI shows the prior
      // conversation (called by the front door after the TUI is up).
      for (const event of dshSession?.events ?? []) {
        try {
          onSessionEvent(dshSession, event);
        } catch (err) {
          process.stderr.write(`[dsh-pi] replayHistory event ${event.type} failed: ${err?.message ?? err}\n`);
        }
      }
    },
    dispose() {
      // Teardown of THIS session's subscriptions. The console-buffer flush and
      // the resume hint belong to the runtime's FINAL dispose (the quit path),
      // NOT here: a session switch calls this mid-TUI and must not flush
      // buffered reports into the terminal or print a stale resume hint.
      disposeEvents();
      disposeModelSelection();
      disposeAgentsMd();
      listeners.clear();
    },
  };

  return shim;
}

/**
 * Build the `runtimeHost` value InteractiveMode expects (AgentSessionRuntime
 * shape): `session` + `services` + lifecycle hooks. Unknown service surfaces
 * resolve to safe no-op defaults so pi UI features we do not bridge yet do not
 * crash the boot.
 */
export function createRuntimeHost(ctx, agent, sessionId, modelOptions = {}) {
  // The runtime's session can be REPLACED in-process (pi's switchSession
  // contract): /resume creates a new dsh agent on the resumed session id via
  // ctx.agents.resume and rebinds this runtime to it — no process spawn, no
  // terminal handoff, so the terminal's foreground group and the frontend's
  // state never change.
  let currentAgent = agent;
  let currentId = sessionId;
  const makeSession = () => createPiSessionShim(ctx, currentAgent, currentId, modelOptions);
  let session = makeSession();
  const cwd = session.cwd;
  const { consoleBuffer, hintSink } = modelOptions;
  let rebindSession = null;
  const noopService = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        return (..._args) => {
          // settings getters and small queries: return benign defaults
          switch (prop) {
            case "getShowImages":
            case "getShowTerminalProgress":
              return false;
            case "getImageWidthCells":
              return 40;
            default:
              return undefined;
          }
        };
      },
    },
  );

  const rebuildServices = () => ({
    settingsManager: noopService,
    sessionManager: {
      getCwd: () => session.cwd,
    },
    modelRegistry: noopService,
    authStorage: noopService,
    resourceLoader: noopService,
  });
  let services = rebuildServices();

  return {
    get session() {
      return session;
    },
    get services() {
      return services;
    },
    setRebindSession(cb) {
      rebindSession = cb;
    },
    setBeforeSessionInvalidate() {},
    async switchSession(sessionPath) {
      // The picker lists DSH sessions (bridge files generated from dsh's own
      // storage). Resume IN PROCESS — the pi-tui way: create a new dsh agent
      // on the resumed session id (ctx.agents.resume loads its persisted
      // events), swap this runtime's session, and let pi-tui rebind the UI.
      // No process spawn, so the terminal's foreground group and the
      // frontend's emulator state are untouched.
      const id = typeof sessionPath === "string" ? sessionIdFromBridgeFile(sessionPath) : undefined;
      if (!id) {
        return { cancelled: true };
      }
      session.dispose(); // teardown the current session's subscriptions
      const published = await ctx.agents.resume({
        resumeSessionId: id,
        agentOptions: currentAgent.options ?? {},
      });
      currentAgent = published?.agent ?? published;
      currentId = id;
      session = makeSession();
      services = rebuildServices();
      // pi-tui's finishSessionReplacement rebinds the UI to the new session
      // (attaching its event listeners); ONLY THEN replay the history, or the
      // prior-conversation events fire into the old session's listeners and
      // are dropped.
      if (typeof rebindSession === "function") await rebindSession(session);
      session.replayHistory();
      return { cancelled: false };
    },
    newSession() {
      return Promise.reject(new Error("Creating a new session is not supported in dsh-pi. Use /model to switch models in the current session, or restart dsh for a fresh one."));
    },
    fork() {
      return Promise.reject(new Error("Session forking is not supported in dsh-pi."));
    },
    importFromJsonl() {
      return Promise.reject(new Error("Session import is not supported in dsh-pi (it is a dsh-powered front door)."));
    },
    dispose() {
      // Final teardown (pi's quit path calls runtimeHost.dispose() BEFORE
      // process.exit, so this is the reliable point): flush buffered plugin
      // reports (never the terminal mid-TUI) and print the dsh resume hint.
      session.dispose();
      if (consoleBuffer) {
        consoleBuffer.restore();
        consoleBuffer.flush();
      }
      // The ACTIVE session (currentId) — after an in-process /resume switch
      // the original sessionId is stale and pointing at it would be empty.
      (hintSink ?? ((line) => writeSync(1, `${line}\n`)))(formatResumeHint(currentId));
    },
  };
}
