import assert from "node:assert/strict";
import test from "node:test";
import { BlockRegistry } from "../src/ui/BlockRegistry";
import { forgetRender, isRenderUnchanged, markRendered, renderSignature } from "../src/ui/RenderCache";
import { createMockProcessorContext } from "obsidian";

const app = { workspace: { getActiveViewOfType: () => null } } as any;

function fakeEl(connected = true): HTMLElement {
  return { isConnected: connected } as HTMLElement;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("BlockRegistry: block registered with a processor context is released by Obsidian's unload, not by isConnected", async () => {
  const pruned: HTMLElement[] = [];
  const registry = new BlockRegistry({ app, isEnabled: () => true, onPrune: (el) => pruned.push(el) });
  const el = fakeEl(true);
  const ctx = createMockProcessorContext("Task.md");
  const calls: boolean[] = [];
  registry.register(el, (force) => { calls.push(force); }, ctx);
  await settle();
  assert.deepEqual(calls, [true]);

  // Секция временно отсоединена от DOM (прокрутка) - блок остаётся в реестре и обновляется
  (el as any).isConnected = false;
  await registry.forceRefreshAsync();
  assert.deepEqual(calls, [true, true]);
  assert.equal(registry.hasBlock(el), true);
  assert.equal(registry.hasConnectedBlocks(), true);
  assert.deepEqual(pruned, []);

  // Obsidian уничтожил секцию - блок снят с учёта и очищен
  ctx.unloadChildren();
  assert.equal(registry.hasBlock(el), false);
  assert.deepEqual(pruned, [el]);
  await registry.forceRefreshAsync();
  assert.deepEqual(calls, [true, true]);
});

test("BlockRegistry: block without a processor context is still pruned by isConnected", async () => {
  const pruned: HTMLElement[] = [];
  const registry = new BlockRegistry({ app, isEnabled: () => true, onPrune: (el) => pruned.push(el) });
  const el = fakeEl(true);
  registry.register(el, () => undefined);
  await settle();
  (el as any).isConnected = false;
  await registry.forceRefreshAsync();
  assert.equal(registry.hasBlock(el), false);
  assert.deepEqual(pruned, [el]);
});

test("BlockRegistry: scheduled (background) refresh passes force=false, explicit refresh passes force=true", async () => {
  const registry = new BlockRegistry({ app, isEnabled: () => true, debounceMs: 1 });
  const el = fakeEl(true);
  const calls: boolean[] = [];
  registry.register(el, (force) => { calls.push(force); });
  await settle();
  registry.scheduleRefresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, [true, false]);
  await registry.forceRefreshAsync();
  assert.deepEqual(calls, [true, false, true]);
  registry.refreshBlock(el);
  await settle();
  assert.deepEqual(calls, [true, false, true, true]);
});

test("BlockRegistry: a forced request during a background cycle makes the rerun forced", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const registry = new BlockRegistry({ app, isEnabled: () => true });
  const el = fakeEl(true);
  const calls: boolean[] = [];
  registry.register(el, async (force) => {
    calls.push(force);
    if (calls.length === 2) await gate;
  });
  await settle();
  const background = registry.runRefreshAsync(false);
  await settle();
  const forced = registry.forceRefreshAsync();
  release();
  await Promise.all([background, forced]);
  assert.deepEqual(calls, [true, false, true]);
});

test("BlockRegistry: shouldRefresh receives the cycle's force flag and a vetoed block is skipped for that cycle only", async () => {
  const asked: Array<{ el: HTMLElement; force: boolean }> = [];
  let veto = false;
  const registry = new BlockRegistry({
    app,
    isEnabled: () => true,
    debounceMs: 1,
    shouldRefresh: (el, force) => {
      asked.push({ el, force });
      return !veto;
    },
  });
  const el = fakeEl(true);
  const calls: boolean[] = [];
  registry.register(el, (force) => { calls.push(force); });
  await settle();
  // Первичная отрисовка не спрашивает shouldRefresh (блок только появился)
  assert.deepEqual(asked, []);

  veto = true;
  await registry.forceRefreshAsync();
  assert.deepEqual(asked, [{ el, force: true }]);
  assert.deepEqual(calls, [true]);

  veto = false;
  registry.scheduleRefresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(asked, [{ el, force: true }, { el, force: false }]);
  assert.deepEqual(calls, [true, false]);
});

test("RenderCache: unchanged signature with rendered content skips, empty or errored container never skips", () => {
  const rendered = { firstElementChild: {}, querySelector: () => null } as unknown as HTMLElement;
  const signature = renderSignature("x", [1, 2, { a: "b" }]);
  assert.equal(isRenderUnchanged(rendered, signature), false);
  markRendered(rendered, signature);
  assert.equal(isRenderUnchanged(rendered, signature), true);
  assert.equal(isRenderUnchanged(rendered, renderSignature("x", [1, 2, { a: "c" }])), false);

  const empty = { firstElementChild: null, querySelector: () => null } as unknown as HTMLElement;
  markRendered(empty, signature);
  assert.equal(isRenderUnchanged(empty, signature), false);

  const errored = { firstElementChild: {}, querySelector: () => ({}) } as unknown as HTMLElement;
  markRendered(errored, signature);
  assert.equal(isRenderUnchanged(errored, signature), false);

  forgetRender(rendered);
  assert.equal(isRenderUnchanged(rendered, signature), false);
});
