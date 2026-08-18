/**
 * @dsh-pi/extensions — pi extensions as dsh plugins, thin on pi2dsh.
 *
 * pi2dsh (upstream) implements pi's public extension ABI on dsh's native
 * services: pi packages mount as dsh plugins and their tools become dsh tools.
 * This package is the thin dsh-side layer around it:
 *
 *   - mounts additional local extension packages (dirs migrated from a pi
 *     installation, e.g. ~/.pi/agent/npm/... or absolute package dirs) that
 *     the profile's pnpm install cannot host;
 *   - exposes `ctx.piExtensions` — the mount registry the TUI (and tooling)
 *     can introspect;
 *   - emits `pi-extensions/*` events that @dsh-pi/tui renders (mount status;
 *     the per-package surface channel is the documented seam for extension
 *     UI, currently rendered text-only by pi2dsh).
 *
 * Everything the engine needs (discovery, tools, commands, providers, model
 * bridge) is owned by pi2dsh; nothing here reimplements it.
 */
import z from "@deepseek-ai/schemastery";
import { applyPiHost } from "pi2dsh";

export const name = "extensions";

export const inject = ["commands", "tools", "systemPrompt"];

export const Config = z.object({
  // Pi packages to mount in addition to what the pi2dsh engine discovers in
  // the profile. npm names (resolved from the profile node_modules) or
  // absolute package dirs are both accepted.
  packages: z.array(z.string()),
  // Local extension package dirs (e.g. migrated from a pi installation).
  localExtensions: z.array(z.string()),
  // Emit TUI-bound extension events (mount status, surface text).
  surfaces: z.boolean().default(true),
});

/** Service key for the mount registry (see apply). */
export const PI_EXTENSIONS_SERVICE = "piExtensions";

export const apply = async (ctx, config) => {
  const requested = [
    ...(config?.packages ?? []),
    ...(config?.localExtensions ?? []),
  ];
  const mounted = new Map(); // name -> { requestedAt, status: "mounted" | "failed", error? }

  const report = (name, status, error) => {
    mounted.set(name, { name, status, error });
    if (config?.surfaces !== false) {
      ctx.emit("pi-extensions/mount", { name, status, error });
    }
  };

  if (requested.length > 0) {
    for (const name of requested) {
      try {
        await applyPiHost(ctx, { packages: [{ name }] });
        report(name, "mounted");
      } catch (err) {
        report(name, "failed", err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Mount registry: what this layer mounted (pi2dsh's own engine-discovered
  // packages are listed separately by the pi2dsh row).
  ctx.provide(PI_EXTENSIONS_SERVICE, {
    list: () => [...mounted.values()],
    get: (name) => mounted.get(name),
  });

  ctx.emit("pi-extensions/ready", {
    mounted: [...mounted.values()],
    surfaces: config?.surfaces !== false,
  });
};
