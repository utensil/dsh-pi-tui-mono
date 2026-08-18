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
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";


const textBlocks = (content) =>
  (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n\n");

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
  try {
    const s = JSON.parse(readFileSync(join(piAgentDir(), "settings.json"), "utf8"));
    return typeof s.theme === "string" && s.theme ? s.theme : undefined;
  } catch {
    return undefined;
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

  let sessionName = "";
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
        if (steeringMessages.length > 0) {
          const text = textBlocks(event.data?.content);
          if (text && steeringMessages.includes(text)) {
            steeringMessages = steeringMessages.filter((m) => m !== text);
            emit({ type: "queue_update" });
          } else if (event.data?.source?.kind === "user") {
            steeringMessages = [];
            emit({ type: "queue_update" });
          }
        }
        // Render only genuine user turns. dsh injects runtime context (system
        // prompt, skill catalog, project files) as user/message events; those
        // have a non-"user" source and would flood the transcript.
        const sourceKind = event.data?.source?.kind;
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
            message: assistantMessage(model, finalContent),
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
        getSessionDir: () => undefined,
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
    isStreaming: false,
    isBashRunning: false,
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
      steeringMessages.push(text);
      emit({ type: "queue_update" });
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
      }
    },
    setAutoCompactionEnabled() {},
    setFollowUpMode() {},
    setSteeringMode() {},
    clearQueue() {},
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

    dispose() {
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
  const session = createPiSessionShim(ctx, agent, sessionId, modelOptions);
  const cwd = session.cwd;

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

  const services = {
    settingsManager: noopService,
    sessionManager: {
      getCwd: () => cwd,
    },
    modelRegistry: noopService,
    authStorage: noopService,
    resourceLoader: noopService,
  };

  return {
    session,
    services,
    setRebindSession() {},
    setBeforeSessionInvalidate() {},
    switchSession() {
      return Promise.reject(new Error("Session switching is not supported in dsh-pi. Start dsh with --resume <session-id> to resume a persisted session."));
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
      session.dispose();
    },
  };
}
