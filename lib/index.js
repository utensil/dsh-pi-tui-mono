import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { createRuntimeHost } from "./session-shim.js";

/**
 * dsh-pi-tui-shim — pi's real InteractiveMode as the dsh front door.
 *
 * The TUI shell, theme, and rendering are pi's own `InteractiveMode` (imported
 * from @earendil-works/pi-coding-agent), so pi TUI updates arrive with pi
 * releases. The dsh agent (agent-loop), sessions, tools, and credentials stay
 * DeepSeek Harness; this plugin bridges the two through an
 * AgentSessionRuntime-shaped shim.
 */
export const name = "tui";

export const inject = ["tuiStartup", "agents", "sessions", "commands", "userQuestions", "tools", "llm", "systemPrompt", "tokenMeter"];

export const Config = z.object({
  sessionId: z.string().default("main"),
});

export const apply = async (ctx, config) => {
  const sessionId = SessionId(config?.sessionId ?? "main");
  const agent = ctx.agents.get(sessionId);
  if (agent === void 0) {
    throw new Error(`dsh-pi-tui-shim: session "${sessionId}" is not running`);
  }

  const runtimeHost = createRuntimeHost(ctx, agent, sessionId);
  const mode = new InteractiveMode(runtimeHost, {});
  await mode.init();
  process.stderr.write(`[dsh-pi] InteractiveMode booted, session=${sessionId}\n`);

  let running = true;
  const runPromise = mode.run().finally(() => {
    running = false;
  });

  ctx.on("dispose", () => {
    if (running) mode.stop();
    runtimeHost.dispose();
  });

  await runPromise;
  runtimeHost.dispose();
  process.stderr.write("[dsh-pi] InteractiveMode exited\n");
};
