import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { createRequire } from "node:module";
import { writeSync } from "node:fs";
import { createRuntimeHost } from "./bridge.js";

/** Honor node `--require=<path>` preloads from NODE_OPTIONS at front-door boot.
 *
 * dsh merges its layered env (~/.dsh/.env + project .env) into process.env
 * before plugins apply, but NODE_OPTIONS from an env file cannot retro-apply to
 * the already-started node process. Loading the referenced preloads here (once;
 * the module cache makes a second load a no-op when node already ran them at
 * startup) makes syntax-highlighting preloads and friends effective no matter
 * where NODE_OPTIONS came from. Fail-safe: a broken preload must never stop the
 * front door from booting. */
export function loadNodePreloads() {
  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  const requires = [
    ...nodeOptions.matchAll(/(?:^|\s)--require=("[^"]*"|'[^']*'|\S+)/g),
    ...nodeOptions.matchAll(/(?:^|\s)--require\s+("[^"]*"|'[^']*'|\S+)/g),
  ].map((m) => m[1].replace(/^["']|["']$/g, ""));
  if (requires.length === 0) return 0;
  const require = createRequire(import.meta.url);
  let loaded = 0;
  for (const spec of requires) {
    try {
      require(spec);
      loaded++;
    } catch (err) {
      process.stderr.write(`[@dsh-pi/tui] preload ${spec} failed: ${err?.message ?? err}\n`);
    }
  }
  return loaded;
}

/**
 * @dsh-pi/tui — pi's real InteractiveMode as the dsh front door.
 *
 * The TUI shell, theme, and rendering are pi's own `InteractiveMode` (imported
 * from @earendil-works/pi-coding-agent), so pi TUI updates arrive with pi
 * releases. The dsh agent (agent-loop), sessions, tools, and credentials stay
 * DeepSeek Harness; this plugin bridges the two through an
 * AgentSessionRuntime-shaped runtime host.
 *
 * Model surfaces (default model, /model picklist, provider) are neutral
 * configuration: the profile layer (written by @dsh-pi/migrate) supplies them
 * via `defaultModel` / `availableModels` / `provider`; without them the bridge
 * falls back to the dsh agent's own current model.
 */
export const name = "tui";

export const inject = ["tuiStartup", "agents", "sessions", "commands", "userQuestions", "tools", "llm", "systemPrompt", "tokenMeter"];

export const Config = z.object({
  sessionId: z.string().default("main"),
  defaultModel: z.string(),
  availableModels: z.array(z.union([z.string(), z.object({ id: z.string(), provider: z.string(), name: z.string() })])),
  provider: z.string(),
  // Migrated pi installation (written by @dsh-pi/migrate): theme selection
  // and a themes dir take precedence over the live ~/.pi/agent home.
  theme: z.string(),
  themesDir: z.string(),
  // Migrated TUI mode (pi settings tuiMode/fullscreenExitOutput).
  tuiMode: z.string(),
  fullscreenExitOutput: z.string(),
});

export const apply = async (ctx, config) => {
  // The TUI owns the terminal exclusively once InteractiveMode takes the
  // screen: any stray write — even to stderr, which is the raw terminal — lands
  // inside the input box wherever the cursor happens to be. Plugin reports that
  // deliberately use console.log/warn (pi2dsh's mount messages) are therefore
  // BUFFERED while the front door is up and flushed to stderr on dispose, so
  // the information is kept without corrupting the TUI. (Node's own crash
  // traces bypass console.* and stay visible.)
  const consoleBuffer = [];
  const consoleRedirects = ["log", "warn", "info", "debug", "error"].map((level) => {
    const original = console[level];
    console[level] = (...args) => {
      consoleBuffer.push(`[console.${level}] ${args.map(String).join(" ")}`);
      if (consoleBuffer.length > 500) consoleBuffer.shift();
    };
    return [level, original];
  });

  const sessionId = SessionId(config?.sessionId ?? "main");
  // Load NODE_OPTIONS --require preloads (e.g. syntax-highlighting grammars)
  // before the TUI renders anything.
  loadNodePreloads();
  // The agent may register asynchronously (resume loads a persisted session
  // through the sessionPersistence service); wait for it instead of failing
  // immediately on the synchronous lookup.
  let agent = ctx.agents.get(sessionId);
  const deadline = Date.now() + 30000;
  while (agent === void 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    agent = ctx.agents.get(sessionId);
  }
  if (agent === void 0) {
    throw new Error(`@dsh-pi/tui: session "${sessionId}" is not running`);
  }

  // We are a dsh front door, not pi: suppress pi's update nag and model
  // catalog network fetches (PI_OFFLINE), and pass quiet startup so the
  // "pi vX" banner and hints do not misrepresent the agent underneath.
  process.env.PI_OFFLINE = "1";
  // Surface @dsh-pi/extensions-mounted packages in pi's extension list
  // (the extensions package is optional — read it without an inject).
  const piExtensions = (ctx?.get?.("piExtensions") ?? undefined)?.list?.() ?? [];
  const mountedExtensions = piExtensions.map((e) => ({
    name: e.name,
    source: "dsh-pi-extensions",
    version: e.version,
    path: e.name,
  }));
  const runtimeHost = createRuntimeHost(ctx, agent, sessionId, {
    defaultModel: config?.defaultModel,
    availableModels: config?.availableModels,
    provider: config?.provider,
    theme: config?.theme,
    themesDir: config?.themesDir,
    tuiMode: config?.tuiMode,
    fullscreenExitOutput: config?.fullscreenExitOutput,
    extensions: mountedExtensions,
  });
  const mode = new InteractiveMode(runtimeHost, {});
  await mode.init();
  process.stderr.write(`[@dsh-pi/tui] InteractiveMode booted, session=${sessionId}\n`);

  let running = true;
  const runPromise = mode.run().finally(() => {
    running = false;
  });

  ctx.on("dispose", () => {
    if (running) mode.stop();
    runtimeHost.dispose();
    for (const [level, original] of consoleRedirects) {
      console[level] = original;
    }
    // Synchronous fd write: pi's quit path calls process.exit(0), which would
    // drop buffered async stderr writes — the mount reports must survive.
    if (consoleBuffer.length > 0) {
      writeSync(2, `${consoleBuffer.join("\n")}\n`);
    }
  });

  await runPromise;
  runtimeHost.dispose();
  process.stderr.write("[@dsh-pi/tui] InteractiveMode exited\n");
};
