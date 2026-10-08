import assert from "node:assert/strict";
import test from "node:test";
import { EventBus } from "../src/core/EventBus";
import { OutlineModule, pluginBlockTitle } from "../src/modules/OutlineModule";
import { OUTLINE_VIEW_TYPE, TaskOutlineView } from "../src/ui/TaskOutlineView";

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createEnv() {
  const storage = new Map<string, unknown>();
  const created: Array<{ parent: unknown; index: number }> = [];
  const states: unknown[] = [];
  const revealed: unknown[] = [];
  const activations: Array<[unknown, unknown]> = [];
  const ourLeaves: any[] = [];
  const rootSplit = { name: "root" };
  const leftSplit = { name: "left", collapsed: false };
  const rightSplit = { name: "right", collapsed: false };
  const noteLeaf = { name: "note", getRoot: () => rootSplit };
  // Связанный Outline в основной области идёт первым (так их перечисляет Obsidian) - туда панель не ставим
  const mainOutline: any = { getRoot: () => rootSplit, parent: { children: [] as unknown[] } };
  mainOutline.parent.children.push(mainOutline);
  const coreOutline: any = { getRoot: () => rightSplit };
  const tabs = { children: [{ name: "files" }, coreOutline, { name: "backlinks" }] };
  coreOutline.parent = tabs;
  let outlines: any[] = [mainOutline, coreOutline];
  const newLeaf = () => {
    const leaf: any = {
      getRoot: () => rightSplit,
      async setViewState(state: unknown) {
        states.push(state);
        ourLeaves.push(leaf);
      },
    };
    return leaf;
  };
  const workspace = {
    rootSplit,
    leftSplit,
    rightSplit,
    onLayoutReady: (callback: () => void) => callback(),
    getLeavesOfType: (type: string) => (type === "outline" ? outlines : type === OUTLINE_VIEW_TYPE ? [...ourLeaves] : []),
    createLeafInParent: (parent: unknown, index: number) => {
      created.push({ parent, index });
      return newLeaf();
    },
    rightLeaves: 0,
    getRightLeaf(_split: boolean) {
      this.rightLeaves++;
      return newLeaf();
    },
    getMostRecentLeaf: () => noteLeaf,
    setActiveLeaf: (leaf: unknown, params: unknown) => activations.push([leaf, params]),
    revealLeaf: async (leaf: unknown) => {
      revealed.push(leaf);
    },
  };
  const app = {
    workspace,
    loadLocalStorage: (key: string) => storage.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => storage.set(key, value),
  };
  const views: string[] = [];
  const commands: Array<{ id: string; callback: () => void }> = [];
  const plugin = {
    registerView: (type: string) => views.push(type),
    addCommand: (command: { id: string; callback: () => void }) => commands.push(command),
    taskView: null,
  };
  return {
    app,
    plugin,
    workspace,
    storage,
    created,
    states,
    revealed,
    activations,
    ourLeaves,
    tabs,
    noteLeaf,
    rightSplit,
    views,
    commands,
    removeCoreOutline: () => {
      outlines = [mainOutline];
    },
    load: () => new OutlineModule({ app, plugin, eventBus: new EventBus() } as any).load(),
  };
}

test("OutlineModule registers the view and command and places the panel next to the sidebar Outline once", async () => {
  const env = createEnv();
  env.load();
  await flush();
  assert.deepEqual(env.views, [OUTLINE_VIEW_TYPE]);
  assert.equal(env.commands[0].id, "open-outline-view");
  assert.deepEqual(env.created, [{ parent: env.tabs, index: 2 }], "вкладка сразу после Outline в сайдбаре");
  assert.deepEqual(env.states, [{ type: OUTLINE_VIEW_TYPE, active: false }]);
  assert.deepEqual(env.activations, [[env.noteLeaf, { focus: false }]], "заметка остаётся активной");
  assert.equal(env.revealed.length, 1);

  // Пользователь закрыл панель - при следующей загрузке она сама не появляется
  env.ourLeaves.length = 0;
  env.load();
  await flush();
  assert.equal(env.created.length, 1);

  // Команда: создаёт панель и показывает её, существующую - только показывает
  env.commands[0].callback();
  await flush();
  assert.equal(env.created.length, 2);
  assert.equal(env.activations.length, 1, "по команде фокус остаётся на панели");
  env.commands[0].callback();
  await flush();
  assert.equal(env.created.length, 2);
  assert.equal(env.revealed.length, 3);
});

test("OutlineModule: without a sidebar Outline uses a new right-sidebar leaf; a collapsed sidebar stays collapsed", async () => {
  const env = createEnv();
  env.removeCoreOutline();
  env.rightSplit.collapsed = true;
  env.load();
  await flush();
  assert.deepEqual(env.created, []);
  assert.equal(env.workspace.rightLeaves, 1);
  assert.deepEqual(env.states, [{ type: OUTLINE_VIEW_TYPE, active: false }]);
  assert.equal(env.revealed.length, 0, "свёрнутый при запуске сайдбар не разворачиваем");
});

test("pluginBlockTitle: titles of plugin blocks follow module settings", () => {
  assert.equal(pluginBlockTitle("opa-reminders-view", { enableReminders: true } as any), "Напоминания");
  assert.equal(pluginBlockTitle("opa-reminders-view", { enableReminders: false } as any), null);
  assert.equal(pluginBlockTitle("opa-home-view", { enableTasksDashboard: true } as any), "Доска задач");
  assert.equal(pluginBlockTitle("opa-projects-view", { enableTasksDashboard: false } as any), null);
  assert.equal(pluginBlockTitle("opa-trash-view", undefined), "Корзина");
  // Блоки без заголовка и посторонние ключи
  assert.equal(pluginBlockTitle("opa-task-view", {} as any), null);
  assert.equal(pluginBlockTitle("opa-daily-nav", {} as any), null);
  assert.equal(pluginBlockTitle("toString", {} as any), null);
});

test("OutlineModule.updateState refreshes open outline panels (settings changed)", () => {
  const env = createEnv();
  const view = Object.create(TaskOutlineView.prototype);
  let refreshed = 0;
  view.refresh = () => refreshed++;
  env.ourLeaves.push({ view }, { view: {} });
  new OutlineModule({ app: env.app, plugin: env.plugin, eventBus: new EventBus() } as any).updateState();
  assert.equal(refreshed, 1);
});
