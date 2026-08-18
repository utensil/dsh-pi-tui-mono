import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPiHome, planMigration, renderProfilePatch, applyMigration, detectPreloads, PROVIDER_MAP } from "../lib/index.js";

function fixturePiHome() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-pi-migrate-src-"));
  mkdirSync(join(dir, "themes"), { recursive: true });
  mkdirSync(join(dir, "extensions"), { recursive: true });
  mkdirSync(join(dir, "npm", "node_modules", "pi-sample-ext", "src"), { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    defaultProvider: "deepseek",
    defaultModel: "deepseek-v4-flash",
    defaultThinkingLevel: "high",
    theme: "railscasts",
    tuiMode: "fullscreen",
    fullscreenExitOutput: "resume-hint",
  }));
  writeFileSync(join(dir, "themes", "railscasts.json"), JSON.stringify({ name: "railscasts", fg: "#e6e1dc" }));
  writeFileSync(join(dir, "extensions", "local-thing.ts"), "export default function (pi) { pi.on('session_start', () => {}); }");
  writeFileSync(join(dir, "lean-highlight-preload.cjs"), "module.exports = 1;");
  writeFileSync(join(dir, "npm", "node_modules", "pi-sample-ext", "package.json"), JSON.stringify({
    name: "pi-sample-ext", version: "1.2.3",
    pi: { extensions: ["./src/index.ts"] },
  }));
  writeFileSync(join(dir, "npm", "node_modules", "pi-sample-ext", "src", "index.ts"), "export default function (pi) {}");
  return dir;
}

test("readPiHome reads settings, themes, both kinds of extensions, and preloads neutrally", () => {
  const dir = fixturePiHome();
  const src = readPiHome(dir);
  assert.equal(src.settings.defaultModel, "deepseek-v4-flash");
  assert.equal(src.settings.defaultProvider, "deepseek");
  assert.equal(src.settings.theme, "railscasts");
  assert.equal(src.settings.tuiMode, "fullscreen");
  assert.equal(src.settings.fullscreenExitOutput, "resume-hint");
  assert.equal(src.themes.length, 1);
  assert.equal(src.themes[0].name, "railscasts");
  assert.deepEqual(src.extensions.npm.map((e) => e.name), ["pi-sample-ext"]);
  assert.deepEqual(src.extensions.files.map((f) => f.name), ["local-thing.ts"]);
  assert.equal(src.preloads.length, 1);
  assert.ok(src.preloads[0].name.includes("preload"));
});

test("detectPreloads is generic: any *preload* js file is found, name-agnostic", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-pi-migrate-pre-"));
  writeFileSync(join(dir, "my-thing-preload.cjs"), "module.exports = 1;");
  writeFileSync(join(dir, "plain-config.json"), "{}");
  const found = detectPreloads(dir);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "my-thing-preload.cjs");
});

test("planMigration maps pi provider, carries TUI settings, and reports preloads", () => {
  const dir = fixturePiHome();
  const plan = planMigration(dir);
  assert.equal(plan.settings.agentLoop.provider, PROVIDER_MAP.deepseek);
  assert.equal(plan.settings.agentLoop.model, "deepseek-v4-flash");
  assert.equal(plan.settings.theme, "railscasts");
  assert.equal(plan.settings.tuiMode, "fullscreen");
  assert.equal(plan.settings.fullscreenExitOutput, "resume-hint");
  assert.equal(plan.extensions.npm.length, 1);
  assert.equal(plan.extensions.files.length, 1);
  assert.equal(plan.preloads.length, 1);
  assert.ok(plan.notes.some((n) => n.includes("dsh plugin add")));
  assert.ok(plan.notes.some((n) => n.includes("standalone extension files")));
  assert.ok(plan.notes.some((n) => n.includes("NODE_OPTIONS")));
});

test("renderProfilePatch emits id-targeted rows without hardcoded values", () => {
  const dir = fixturePiHome();
  const plan = planMigration(dir);
  const patch = renderProfilePatch(plan, "/tmp/profile", dir);
  assert.ok(patch.includes("- id: agent-loop"), "agent-loop row");
  assert.ok(patch.includes("model: deepseek-v4-flash"), "model from the source");
  assert.ok(patch.includes("- id: tui"), "tui row");
  assert.ok(patch.includes("theme: railscasts"), "theme from the source");
  assert.ok(patch.includes("tuiMode: fullscreen"), "tuiMode from the source");
  assert.ok(patch.includes("fullscreenExitOutput: resume-hint"), "fullscreenExitOutput from the source");
  assert.ok(patch.includes("- id: extensions"), "extensions row");
  assert.ok(patch.includes("pi-sample-ext"), "npm extension listed");
  assert.ok(!patch.includes("dsh-pi-tui-shim"), "no stale shim wording");
});

test("applyMigration dry-run writes nothing; apply writes themes + patch", () => {
  const src = fixturePiHome();
  const profile = mkdtempSync(join(tmpdir(), "dsh-pi-migrate-dst-"));
  const dry = applyMigration({ piHome: src, profileDir: profile, dryRun: true });
  assert.ok(dry.report.written.length >= 1, "dry run reports planned writes");
  assert.ok(dry.installCommands.length === 1, "install command for the npm extension");

  const applied = applyMigration({ piHome: src, profileDir: profile, dryRun: false });
  assert.ok(readFileSync(join(profile, "cordis.patch.yml"), "utf8").includes("deepseek-v4-flash"));
  assert.ok(readFileSync(join(profile, "themes", "railscasts.json"), "utf8").includes("railscasts"));
  assert.ok(applied.installCommands[0].includes("pi-sample-ext@1.2.3"));
});

test("applyMigration refuses a missing profile dir", () => {
  assert.throws(() => applyMigration({ piHome: fixturePiHome(), profileDir: "/tmp/__no_profile__" }), /does not exist/);
});
