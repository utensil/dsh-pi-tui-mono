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
