import { SessionId } from "@deepseek-ai/dsh-session";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
import { CONFIGURED_AGENT_IDENTITIES_KEY } from "@deepseek-ai/dsh-agent-loop";

/** Agent id the agent-loop row names (see cordis.patch.yml). */
export const MAIN_AGENT_ID = "main";

/** Service key the tui row reads as `!!js ctx.tuiStartup.sessionId`. */
export const TUI_STARTUP_SERVICE = "tuiStartup";

export const name = "tui-startup";

/**
 * tui-startup: parse `dsh --profile tui-pi` args and provide the session
 * identity to the agent-loop and the tui front door (mirrors the
 * @dsh-tui/dsh-tui/startup contract).
 */
export const apply = (ctx) => {
  const program = new Command()
    .name("dsh --profile tui-pi")
    .description("pi-TUI front door over the DeepSeek Harness base")
    .helpOption("-h, --help")
    .option("--resume <session>", "resume a persisted session by id")
    .allowUnknownOption(true);

  program.action(() => {
    const options = program.opts();
    const resume = options.resume?.trim();
    const identity = resume === void 0
      ? { id: SessionId(`main-session-${randomUUID()}`), resume: false }
      : { id: SessionId(resume), resume: true };
    ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, { [MAIN_AGENT_ID]: identity });
    ctx.provide(TUI_STARTUP_SERVICE, {
      sessionId: identity.id,
      resume: identity.resume,
    });
  });

  parseCmdline(ctx, program);
};
