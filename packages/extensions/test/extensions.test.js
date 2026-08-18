import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, PI_EXTENSIONS_SERVICE } from "../lib/index.js";

function fakeCtx() {
  const events = [];
  const provided = new Map();
  return {
    events,
    provided,
    emit: (name, data) => { events.push({ name, data }); },
    provide: (key, value) => { provided.set(key, value); },
  };
}

test("extensions: mounts nothing and still exposes an empty registry when no packages configured", async () => {
  const ctx = fakeCtx();
  await apply(ctx, { surfaces: true });
  assert.ok(ctx.provided.has(PI_EXTENSIONS_SERVICE), "registry service provided");
  const registry = ctx.provided.get(PI_EXTENSIONS_SERVICE);
  assert.deepEqual(registry.list(), []);
  const ready = ctx.events.find((e) => e.name === "pi-extensions/ready");
  assert.ok(ready, "ready event emitted");
  assert.equal(ready.data.surfaces, true);
});

test("extensions: reports a failed mount (unresolvable package) with an error", async () => {
  const ctx = fakeCtx();
  await apply(ctx, { packages: ["@dsh-pi/__definitely_not_installed__"] });
  const registry = ctx.provided.get(PI_EXTENSIONS_SERVICE);
  const list = registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "failed");
  assert.ok(list[0].error, "error captured");
  const mount = ctx.events.find((e) => e.name === "pi-extensions/mount");
  assert.ok(mount, "mount event emitted for the failed package");
  assert.equal(mount.data.status, "failed");
});

test("extensions: surfaces=false suppresses mount events but keeps the registry", async () => {
  const ctx = fakeCtx();
  await apply(ctx, { surfaces: false, packages: ["@dsh-pi/__definitely_not_installed__"] });
  assert.ok(!ctx.events.some((e) => e.name === "pi-extensions/mount"), "no mount events");
  assert.ok(ctx.events.some((e) => e.name === "pi-extensions/ready"), "ready still emitted");
  assert.equal(ctx.provided.get(PI_EXTENSIONS_SERVICE).list().length, 1);
});

test("extensions: localExtensions dirs are mounted through the same path", async () => {
  const ctx = fakeCtx();
  await apply(ctx, { localExtensions: ["/tmp/__no_such_pi_extension_dir__"] });
  const registry = ctx.provided.get(PI_EXTENSIONS_SERVICE);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0].status, "failed");
});

test("extension mount E2E: a real pi extension package's tool executes through dsh services", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const { Context } = await import("@deepseek-ai/cordis");
  const SessionStore = (await import("@deepseek-ai/dsh-session")).default;
  const SystemPrompt = (await import("@deepseek-ai/dsh-system-prompt")).default;
  const ToolRuntime = (await import("@deepseek-ai/dsh-tools")).default;
  const CommandRuntime = (await import("@deepseek-ai/dsh-commands")).default;
  const SkillRegistry = (await import("@deepseek-ai/dsh-skill-filesystem"));
  const AgentRegistry = (await import("@deepseek-ai/dsh-agent")).default;
  const { CallId } = await import("@deepseek-ai/dsh-llm");
  const { applyPiHost } = await import("pi2dsh");

  // A real pi extension package (pi.extensions entry + a registered tool),
  // exactly like the fixture the upstream pi2dsh test suite mounts.
  const dir = mkdtempSync(join(tmpdir(), "dsh-pi-e2e-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "pi-e2e-fixture", version: "0.0.1", type: "module",
    pi: { extensions: ["./extension.js"] },
  }));
  writeFileSync(join(dir, "extension.js"), [
    "export default function (pi) {",
    "  pi.registerTool({",
    "    name: 'echo_text',",
    "    description: 'Echoes text back.',",
    "    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },",
    "    execute: async (_id, args) => ({",
    "      content: [{ type: 'text', text: `echoed: ${args.text}` }],",
    "    }),",
    "  });",
    "}",
  ].join("\n"));

  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(CommandRuntime);
  await ctx.plugin(SkillRegistry, {});
  await ctx.plugin(AgentRegistry);

  // Mount through OUR thin layer's own path: applyPiHost with a local dir.
  await applyPiHost(ctx, { packages: [{ name: dir }] });

  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId("e2e-1"),
    name: "echo_text",
    arguments: { text: "hello-e2e" },
    agent: undefined,
  });
  assert.equal(result.isError, false);
  const text = result.content.find((b) => b.type === "text")?.text ?? "";
  assert.equal(text, "echoed: hello-e2e", "extension tool executed through the dsh tool runtime");
});
