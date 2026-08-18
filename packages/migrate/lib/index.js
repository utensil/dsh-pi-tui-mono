/**
 * @dsh-pi/migrate — neutral migration of an existing pi installation into a
 * dsh profile powered by @dsh-pi/tui and @dsh-pi/extensions.
 *
 * Nothing here hardcodes a model, a provider, a theme, or an extension list:
 * every value is read from the source pi installation (`~/.pi/agent` by
 * default) and written into the target dsh profile as configuration. The only
 * translation is pi's provider name to dsh's route name (a documented map),
 * and paths are always parameters, never literals.
 */
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_PI_AGENT_DIR = () => join(homedir(), ".pi", "agent");
export const DEFAULT_DSH_HOME = () => join(homedir(), ".dsh");

/** pi provider names -> dsh llm route names (dsh's deepseek route is
 * "deepseek-official"; unknown providers pass through for dsh's own routes). */
export const PROVIDER_MAP = {
  deepseek: "deepseek-official",
};

export function piAgentDir(piHome) {
  return piHome ?? DEFAULT_PI_AGENT_DIR();
}

/** Read the source pi installation: settings, themes, extensions. */
export function readPiHome(piHome) {
  const dir = piAgentDir(piHome);
  const settingsPath = join(dir, "settings.json");
  const settings = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf8"))
    : {};

  const themesDir = join(dir, "themes");
  const themes = existsSync(themesDir)
    ? readdirSync(themesDir).filter((n) => n.endsWith(".json")).map((n) => ({ name: basename(n, ".json"), path: join(themesDir, n) }))
    : [];

  const npmDir = join(dir, "npm", "node_modules");
  let npmExtensions = [];
  if (existsSync(npmDir)) {
    for (const entry of readdirSync(npmDir)) {
      const pkgPath = join(npmDir, entry, "package.json");
      if (!existsSync(pkgPath)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        const resources = pkg.pi?.extensions ?? pkg.dsh?.extensions;
        if (Array.isArray(resources) && resources.length > 0) {
          npmExtensions.push({ name: pkg.name, version: pkg.version, path: join(npmDir, entry) });
        }
      } catch { /* unreadable package — skip */ }
    }
  }
  npmExtensions.sort((a, b) => a.name.localeCompare(b.name));

  const extDir = join(dir, "extensions");
  const fileExtensions = existsSync(extDir)
    ? readdirSync(extDir).filter((n) => /\.(ts|tsx|js|mjs|cjs)$/.test(n)).map((n) => ({ name: n, path: join(extDir, n) }))
    : [];

  return {
    settings: {
      defaultProvider: typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined,
      defaultModel: typeof settings.defaultModel === "string" ? settings.defaultModel : undefined,
      defaultThinkingLevel: typeof settings.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : undefined,
      theme: typeof settings.theme === "string" ? settings.theme : undefined,
      tuiMode: typeof settings.tuiMode === "string" ? settings.tuiMode : undefined,
      fullscreenExitOutput: typeof settings.fullscreenExitOutput === "string" ? settings.fullscreenExitOutput : undefined,
    },
    themes,
    extensions: { npm: npmExtensions, files: fileExtensions },
    preloads: detectPreloads(dir),
  };
}

/** Node preload files at the pi agent root (CJS by convention, e.g.
 * lean-highlight-preload.cjs). Generic: any *.cjs file whose name contains
 * "preload" — the exact grammar/name is the source device's business. */
export function detectPreloads(piHome) {
  const dir = piAgentDir(piHome);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.toLowerCase().includes("preload") && /\.[cm]?js$/.test(n))
    .map((n) => ({ name: n, path: join(dir, n) }));
}

/**
 * Build the migration plan: what would change in a target profile. Pure —
 * never touches the filesystem outside reads of the source pi home.
 */
export function planMigration(piHome, opts = {}) {
  const src = readPiHome(piHome);
  const plan = {
    settings: {},
    themes: [],
    extensions: { npm: [], files: [] },
    notes: [],
  };

  const provider = PROVIDER_MAP[src.settings.defaultProvider] ?? src.settings.defaultProvider;
  if (src.settings.defaultModel) {
    plan.settings.agentLoop = { provider, model: src.settings.defaultModel };
  }
  if (src.settings.theme) {
    plan.settings.theme = src.settings.theme;
  }
  if (src.settings.tuiMode) {
    plan.settings.tuiMode = src.settings.tuiMode;
  }
  if (src.settings.fullscreenExitOutput) {
    plan.settings.fullscreenExitOutput = src.settings.fullscreenExitOutput;
  }
  if (src.settings.defaultThinkingLevel) {
    plan.settings.thinkingLevel = src.settings.defaultThinkingLevel;
  }

  if (src.themes.length > 0) {
    plan.themes = src.themes.map((t) => ({ name: t.name, source: t.path }));
  }

  if (src.extensions.npm.length > 0) {
    plan.extensions.npm = src.extensions.npm.map((e) => ({ name: e.name, version: e.version }));
    plan.notes.push(
      "npm extensions must be installed into the target profile before mounting " +
      "(run the printed `dsh plugin add` commands), because pi2dsh resolves " +
      "packages from the profile's node_modules.",
    );
  }
  if (src.extensions.files.length > 0) {
    plan.extensions.files = src.extensions.files.map((f) => ({ name: f.name, source: f.path }));
    plan.notes.push(
      "standalone extension files (e.g. herdr-managed .ts) are not mountable as-is; " +
      "wrap each in a package with a pi.extensions entry, or keep using pi for them.",
    );
  }

  // Node preloads (e.g. a syntax-highlighting grammar preload). dsh requires
  // bootstrap variables like NODE_OPTIONS to come from the LAUNCHING
  // environment (its .env loader rejects them fail-loud), so this step only
  // verifies and reports: when the ambient NODE_OPTIONS references the
  // preloads, dsh inherits them and the @dsh-pi/tui front door also loads
  // --require preloads at boot; otherwise the operator must export NODE_OPTIONS
  // (e.g. in the shell profile) before starting dsh.
  if (src.preloads.length > 0) {
    plan.preloads = src.preloads.map((p) => ({ name: p.name, path: p.path }));
    const ambient = process.env.NODE_OPTIONS ?? "";
    const referenced = plan.preloads.filter((p) => ambient.includes(p.path));
    plan.notes.push(
      `preload(s) ${plan.preloads.map((p) => p.name).join(", ")}: ` +
      (referenced.length > 0
        ? "referenced by the ambient NODE_OPTIONS — dsh inherits it and @dsh-pi/tui loads them at boot."
        : "NOT in the ambient NODE_OPTIONS — export NODE_OPTIONS=\"--require=<path>\" in the " +
          "launching environment (dsh rejects bootstrap variables in .env files)."),
    );
  }

  return plan;
}

const patchEntry = (id, body) => `- id: ${id}\n${body}\n`;

/** Serialize the plan into the target profile's cordis.patch.yml content. */
export function renderProfilePatch(plan, profileDir, piHome) {
  const lines = [
    "# Migrated from the pi installation by @dsh-pi/migrate (run dsh-pi-migrate to regenerate).",
    "# Each row is id-targeted; later layers (this file) win over bundle defaults.",
  ];
  const agent = plan.settings.agentLoop;
  if (agent) {
    lines.push(patchEntry("agent-loop", `  config:\n    agents:\n      - id: main\n        provider: ${agent.provider}\n        model: ${agent.model}\n        cwd: !!js process.cwd()`));
  }
  const tui = [];
  if (agent) tui.push(`    defaultModel: ${agent.model}`);
  if (agent) tui.push(`    availableModels:\n      - ${agent.model}`);
  if (plan.settings.thinkingLevel) {
    lines.push(patchEntry("llm-deepseek", `  config:\n    thinking: enabled\n    reasoningEffort: ${plan.settings.thinkingLevel}`));
  }
  if (plan.settings.tuiMode) tui.push(`    tuiMode: ${plan.settings.tuiMode}`);
  if (plan.settings.fullscreenExitOutput) tui.push(`    fullscreenExitOutput: ${plan.settings.fullscreenExitOutput}`);
  const themesDir = join(profileDir, "themes");
  if (plan.themes.length > 0 || plan.settings.theme) {
    if (plan.settings.theme) tui.push(`    theme: ${plan.settings.theme}`);
    tui.push(`    themesDir: ${themesDir}`);
  }
  if (tui.length > 0) {
    lines.push(patchEntry("tui", `  config:\n${tui.join("\n")}`));
  }
  if (plan.extensions.npm.length > 0) {
    const pkgs = plan.extensions.npm.map((e) => `      - ${e.name}`).join("\n");
    lines.push(patchEntry("extensions", `  config:\n    packages:\n${pkgs}`));
  }
  return lines.join("\n") + "\n";
}

/**
 * Apply the migration to a target profile. Returns a report of everything
 * written. In dry-run mode nothing is written.
 */
export function applyMigration({ piHome, profileDir, dryRun = false }) {
  const plan = planMigration(piHome);
  const report = { written: [], skipped: [] };
  if (!existsSync(profileDir)) {
    throw new Error(`profile dir does not exist: ${profileDir}`);
  }
  if (plan.themes.length > 0) {
    const themesDir = join(profileDir, "themes");
    for (const t of plan.themes) {
      const dest = join(themesDir, `${t.name}.json`);
      if (dryRun) { report.written.push(`themes/${t.name}.json`); continue; }
      mkdirSync(themesDir, { recursive: true });
      copyFileSync(t.source, dest);
      report.written.push(`themes/${t.name}.json`);
    }
  }
  const patchPath = join(profileDir, "cordis.patch.yml");
  const patchContent = renderProfilePatch(plan, profileDir, piHome);
  if (dryRun) {
    report.written.push("cordis.patch.yml (migrated entries)");
  } else {
    writeFileSync(patchPath, patchContent);
    report.written.push("cordis.patch.yml");
  }
  // Note: node preloads (plan.preloads) are NEVER written anywhere by this
  // kit — dsh's .env loader rejects bootstrap variables (NODE_OPTIONS) and
  // only the launching environment may set them. The plan reports the
  // requirement; the front door honors ambient NODE_OPTIONS at boot.
  return { plan, report, installCommands: plan.extensions.npm.map((e) => `dsh plugin --profile ${basename(profileDir)} add ${e.name}@${e.version}`) };
}
