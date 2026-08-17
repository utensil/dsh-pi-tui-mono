import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import z from "@deepseek-ai/schemastery";

/**
 * @dsh-pi/tui — mount pi's real InteractiveMode as the dsh front door.
 *
 * Milestone 0: register the plugin + verify cordis composition. The bridge
 * (AgentSessionRuntime-shaped shim translating dsh agent events into pi's
 * session model) is the next milestone; until then this just verifies the
 * plugin loads with the startup-provided session identity.
 */
export const name = "tui";

export const inject = ["tuiStartup"];

export const Config = z.object({
  sessionId: z.string().default("main"),
});

export const apply = (ctx, config) => {
  const sessionId = config?.sessionId ?? "main";
  // TODO(milestone 1): construct the AgentSessionRuntime-shaped bridge over
  // the dsh agent-loop and boot InteractiveMode with it:
  //   const mode = new InteractiveMode(bridge, { ... });
  //   await mode.init();
  //   await mode.run();
  // pi's InteractiveMode + theme ship with @earendil-works/pi-coding-agent,
  // so TUI look updates arrive with pi releases without code edits here.
  process.stderr.write(`[dsh-pi] tui plugin loaded, sessionId=${sessionId}\n`);
  void InteractiveMode; // imported for milestone 1; keeps the dep resolved
};
