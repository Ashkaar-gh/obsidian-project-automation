import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HOMEPAGE, DEFAULT_TASK } from "../src/core/DefaultTemplates";
import { EventBus } from "../src/core/EventBus";
import { getConfig, getIcon, getWeight } from "../src/core/StatusConfig";
import { BlockRegistry } from "../src/ui/BlockRegistry";
import { TaskViewModule } from "../src/modules/TaskViewModule";
import { TFile } from "obsidian";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Homepage template contains every primary plugin module", () => {
  for (const block of [
    "opa-gamification-view",
    "opa-activities-view",
    "opa-reminders-view",
    "opa-projects-view",
    "opa-home-view",
    "opa-inbox-view",
    "opa-trash-view",
  ]) {
    assert.ok(DEFAULT_HOMEPAGE.includes("```" + block));
  }
  assert.match(DEFAULT_HOMEPAGE, /three-column-grid-list/);
  assert.match(DEFAULT_HOMEPAGE, /obsidianUIMode: preview/);
});

test("default task template exposes the description section used by FileIO", () => {
  assert.match(DEFAULT_TASK, /^## Описание задачи$/m);
  assert.match(DEFAULT_TASK, /```opa-task-view/);
});

test("status config does not treat partial words as completed states", () => {
  assert.equal(getConfig("Готово")?.key, "готово");
  assert.equal(getConfig("Не готово"), undefined);
  assert.equal(getConfig("Подготовлено"), undefined);
  assert.equal(getIcon("Неизвестно"), "❓");
  assert.equal(getWeight("Неизвестно"), 50);
});

test("EventBus awaits async listeners and unsubscribe removes handlers", async () => {
  const bus = new EventBus();
  const calls: string[] = [];
  const off = bus.on("task:completed", async ({ path }) => {
    await Promise.resolve();
    calls.push(path);
  });
  await bus.emit("task:completed", { path: "Task.md" });
  off();
  await bus.emit("task:completed", { path: "Ignored.md" });
  assert.deepEqual(calls, ["Task.md"]);
});

test("BlockRegistry isolates a failing block and refreshes remaining blocks", async () => {
  const calls: string[] = [];
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const registry = new BlockRegistry({
      app: { workspace: { getActiveViewOfType: () => null } } as any,
      isEnabled: () => true,
    });
    const first = { isConnected: true } as HTMLElement;
    const second = { isConnected: true } as HTMLElement;
    registry.register(first, () => { throw new Error("render failed"); });
    registry.register(second, () => { calls.push("second"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    calls.length = 0;
    await registry.forceRefreshAsync();
    assert.deepEqual(calls, ["second"]);
    assert.ok(errors.length >= 1);
  } finally {
    console.error = originalError;
  }
});

test("BlockRegistry prunes detached blocks and releases their resources", () => {
  const pruned: HTMLElement[] = [];
  const registry = new BlockRegistry({
    app: { workspace: { getActiveViewOfType: () => null } } as any,
    isEnabled: () => true,
    onPrune: (el) => pruned.push(el),
  });
  const detached = { isConnected: false } as HTMLElement;
  registry.register(detached, () => undefined);
  registry.clear();
  assert.deepEqual(pruned, [detached]);
});

test("BlockRegistry serializes refreshes and reruns after an event during render", async () => {
  const gate = deferred();
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const registry = new BlockRegistry({
    app: { workspace: { getActiveViewOfType: () => null } } as any,
    isEnabled: () => true,
  });
  const element = { isConnected: true } as HTMLElement;
  registry.register(element, async () => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    if (calls === 1) await gate.promise;
    active--;
  });

  await Promise.resolve();
  const second = registry.forceRefreshAsync();
  registry.scheduleRefresh();
  gate.resolve();
  await second;

  assert.equal(maxActive, 1);
  assert.equal(calls, 2);
});

test("BlockRegistry coalesces many concurrent refresh requests into one rerun", async () => {
  const gate = deferred();
  let calls = 0;
  const registry = new BlockRegistry({
    app: { workspace: { getActiveViewOfType: () => null } } as any,
    isEnabled: () => true,
  });
  registry.register({ isConnected: true } as HTMLElement, async () => {
    calls++;
    if (calls === 1) await gate.promise;
  });
  await Promise.resolve();

  const requests = Array.from({ length: 20 }, () => registry.forceRefreshAsync());
  gate.resolve();
  await Promise.all(requests);
  assert.equal(calls, 2);
});

test("BlockRegistry clear prevents pending reruns after an in-flight render", async () => {
  const gate = deferred();
  let calls = 0;
  const registry = new BlockRegistry({
    app: { workspace: { getActiveViewOfType: () => null } } as any,
    isEnabled: () => true,
  });
  registry.register({ isConnected: true } as HTMLElement, async () => {
    calls++;
    await gate.promise;
  });
  await Promise.resolve();
  registry.forceRefresh();
  registry.clear();
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
});

test("TaskViewModule refreshes an open task view with its renamed path", async () => {
  let processor: ((source: string, el: HTMLElement, ctx: { sourcePath: string }) => void) | undefined;
  let rename: ((file: TFile, oldPath: string) => void) | undefined;
  const oldFile = new TFile("tasks/Old name.md");
  const app = {
    workspace: {
      on: () => ({}),
      getActiveFile: () => oldFile,
      getActiveViewOfType: () => null,
    },
    vault: {
      on: (event: string, callback: (file: TFile, oldPath: string) => void) => {
        if (event === "rename") rename = callback;
        return {};
      },
      getAbstractFileByPath: (path: string) => path === oldFile.path ? oldFile : null,
    },
  };
  const plugin = {
    registerEvent: () => undefined,
    registerMarkdownCodeBlockProcessor: (
      _language: string,
      callback: (source: string, el: HTMLElement, ctx: { sourcePath: string }) => void
    ) => { processor = callback; },
  };
  const eventBus = new EventBus();
  const module = new TaskViewModule({ app, plugin, eventBus } as any);
  const renders: Array<[string, string]> = [];
  (module as any).renderTaskView = async (_el: HTMLElement, path: string, name: string) => {
    renders.push([path, name]);
  };
  module.load();

  const attributes = new Map<string, string>();
  const el = {
    isConnected: true,
    addClass: () => undefined,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name) ?? null,
  } as unknown as HTMLElement;
  processor?.("", el, { sourcePath: oldFile.path });
  await new Promise((resolve) => setTimeout(resolve, 0));

  rename?.(new TFile("tasks/New name.md"), oldFile.path);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(renders, [
    ["tasks/Old name.md", "Old name"],
    ["tasks/New name.md", "New name"],
  ]);
  module.unload();
});
