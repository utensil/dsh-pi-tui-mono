import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, MAIN_AGENT_ID, TUI_STARTUP_SERVICE } from "../lib/startup.js";
import { CONFIGURED_AGENT_IDENTITIES_KEY } from "@deepseek-ai/dsh-agent-loop";

function fakeCtx(argv) {
  const provided = new Map();
  const ctx = {
    provided,
    get: (key) => {
      if (key === "cmdlineArgs") return { get: () => argv };
      if (key === "appExit") return (code) => { throw new Error(`appExit(${code})`); };
      return undefined;
    },
    provide: (key, value) => provided.set(key, value),
  };
  return ctx;
}

const RESUME_ID = "main-session-123e4567-e89b-12d3-a456-426614174000";

test("tui-startup: --resume <id> provides the resumed session identity", () => {
  const ctx = fakeCtx(["--resume", RESUME_ID]);
  apply(ctx);
  const identity = ctx.provided.get(CONFIGURED_AGENT_IDENTITIES_KEY);
  assert.ok(identity, "agent identities provided");
  assert.equal(identity[MAIN_AGENT_ID].id, RESUME_ID);
  assert.equal(identity[MAIN_AGENT_ID].resume, true);
  const startup = ctx.provided.get(TUI_STARTUP_SERVICE);
  assert.equal(startup.sessionId, RESUME_ID);
  assert.equal(startup.resume, true);
});

test("tui-startup: no --resume creates a fresh session identity", () => {
  const ctx = fakeCtx([]);
  apply(ctx);
  const identity = ctx.provided.get(CONFIGURED_AGENT_IDENTITIES_KEY)[MAIN_AGENT_ID];
  assert.match(String(identity.id), /^main-session-/, "fresh session id");
  assert.equal(identity.resume, false);
  const startup = ctx.provided.get(TUI_STARTUP_SERVICE);
  assert.equal(startup.resume, false);
  assert.equal(startup.sessionId, String(identity.id), "tui row reads the same identity");
});
