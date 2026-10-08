import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { MarkdownRenderer, MarkdownView, Menu, MockEvents, TFile, createMockProcessorContext } from "obsidian";
import { EventBus } from "../src/core/EventBus";
import { TaskViewModule } from "../src/modules/TaskViewModule";
import { pluginBlockTitle } from "../src/modules/OutlineModule";
import { TaskOutlineView } from "../src/ui/TaskOutlineView";

// ---------------------------------------------------------------------------
// Окружение: jsdom + DOM-хелперы Obsidian (createEl/createDiv/empty/addClass…)
// ---------------------------------------------------------------------------

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
const document = window.document;
(globalThis as any).window = window;
(globalThis as any).document = document;
(globalThis as any).Node = window.Node;
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);

type CreateOpts = { text?: string; cls?: string; attr?: Record<string, string> } | string;

function applyOpts(el: HTMLElement, opts?: CreateOpts): void {
  if (opts == null) return;
  if (typeof opts === "string") {
    el.className = opts;
    return;
  }
  if (opts.cls) el.className = opts.cls;
  if (opts.text != null) el.textContent = opts.text;
  if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
}

const proto = window.HTMLElement.prototype as any;
proto.createEl = function (tag: string, opts?: CreateOpts) {
  const el = document.createElement(tag);
  applyOpts(el, opts);
  this.appendChild(el);
  return el;
};
proto.createDiv = function (opts?: CreateOpts) {
  return this.createEl("div", opts);
};
proto.empty = function () {
  while (this.firstChild) this.removeChild(this.firstChild);
};
proto.addClass = function (...cls: string[]) {
  this.classList.add(...cls);
};
proto.removeClass = function (...cls: string[]) {
  this.classList.remove(...cls);
};
proto.toggleClass = function (cls: string, on: boolean) {
  this.classList.toggle(cls, on);
};
proto.setText = function (text: string) {
  this.textContent = text;
};
/** Без раскладки в jsdom: элемент «видим», если он в документе и не внутри [hidden]. */
proto.getClientRects = function () {
  return this.isConnected && !this.closest("[hidden]") ? [{ top: 0, left: 0, width: 1, height: 1 }] : [];
};

function miniMarkdown(markdown: string): string {
  const inline = (text: string): string =>
    text
      .replace(/\*\*\[\[([^\]|]+)\|([^\]]+)\]\]\*\*/g, '<strong><a class="internal-link" data-href="$1" href="$1">$2</a></strong>')
      .replace(/\[\[([^\]]+)\]\]/g, '<a class="internal-link" data-href="$1" href="$1">$1</a>');
  return markdown
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) return `<div class="el-h${heading[1].length}"><h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}></div>`;
      return `<div class="el-p"><p>${inline(line)}</p></div>`;
    })
    .join("");
}

(MarkdownRenderer as any).render = async (_app: unknown, markdown: string, el: HTMLElement) => {
  el.innerHTML = miniMarkdown(markdown);
};

// ---------------------------------------------------------------------------
// Мок хранилища и рабочей области
// ---------------------------------------------------------------------------

function buildCache(content: string) {
  const headings: any[] = [];
  const links: any[] = [];
  let offset = 0;
  content.split("\n").forEach((line, lineNo) => {
    const m = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (m) {
      headings.push({
        heading: m[2],
        level: m[1].length,
        position: {
          start: { line: lineNo, col: 0, offset },
          end: { line: lineNo, col: line.length, offset: offset + line.length },
        },
      });
    }
    for (const link of line.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
      links.push({ link: link[1], position: { start: { offset: offset + (link.index ?? 0) } } });
    }
    offset += line.length + 1;
  });
  return { headings, links };
}

function createEnv(files: Record<string, string>) {
  const tfiles = new Map<string, TFile>();
  const contents = new Map<string, string>();
  const caches = new Map<string, ReturnType<typeof buildCache>>();
  /** updateCache=false - файл уже изменён, а кэш метаданных ещё старый (как сразу после записи в Obsidian). */
  const write = (path: string, content: string, updateCache = true): void => {
    if (!tfiles.has(path)) tfiles.set(path, new TFile(path));
    contents.set(path, content);
    if (updateCache) caches.set(path, buildCache(content));
  };
  const reindex = (path: string): void => {
    caches.set(path, buildCache(contents.get(path) ?? ""));
  };
  for (const [path, content] of Object.entries(files)) write(path, content);

  const vault = Object.assign(new MockEvents(), {
    getMarkdownFiles: () => [...tfiles.values()].filter((f) => f.extension === "md"),
    getAbstractFileByPath: (path: string) => tfiles.get(path) ?? null,
    cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
  });
  const reads: string[] = [];
  const cachedRead = vault.cachedRead;
  vault.cachedRead = async (file: TFile) => {
    reads.push(file.path);
    return cachedRead(file);
  };
  const metadataCache = Object.assign(new MockEvents(), {
    getFileCache: (file: TFile) => caches.get(file.path) ?? null,
    getFirstLinkpathDest: (link: string) => {
      const path = [...tfiles.keys()].find((p) => p.replace(/\.md$/, "") === link || p.endsWith(`/${link}.md`));
      return path ? tfiles.get(path) ?? null : null;
    },
  });
  const rootSplit = { name: "root" };
  const leftSplit = { name: "left" };
  const rightSplit = { name: "right" };
  const leaves: any[] = [];
  const opened: Array<{ paneType: unknown; file: TFile; state: unknown }> = [];
  const activations: Array<[unknown, unknown]> = [];
  const workspace = Object.assign(new MockEvents(), {
    rootSplit,
    leftSplit,
    rightSplit,
    layoutReady: true,
    mostRecent: null as any,
    onLayoutReady(callback: () => void) {
      callback();
    },
    getMostRecentLeaf() {
      return this.mostRecent;
    },
    setActiveLeaf(leaf: unknown, params: unknown) {
      activations.push([leaf, params]);
    },
    iterateAllLeaves(callback: (leaf: any) => void) {
      leaves.forEach(callback);
    },
    getLeaf(paneType: unknown) {
      return {
        async openFile(file: TFile, state: unknown) {
          opened.push({ paneType, file, state });
        },
      };
    },
    getActiveFile: () => null,
    getActiveViewOfType: () => null,
    openLinkText: async () => undefined,
  });
  const app = { vault, metadataCache, workspace };
  return {
    app,
    vault,
    metadataCache,
    workspace,
    leaves,
    opened,
    activations,
    reads,
    rootSplit,
    rightSplit,
    write,
    reindex,
    file: (path: string) => tfiles.get(path)!,
  };
}

type Env = ReturnType<typeof createEnv>;

function createMarkdownLeaf(env: Env, path: string, mode: "preview" | "source" = "preview", rawSource = false) {
  const containerEl = document.createElement("div");
  containerEl.className = "workspace-leaf-content";
  document.body.appendChild(containerEl);
  const scroller = containerEl.appendChild(document.createElement("div"));
  scroller.className = "markdown-preview-view";
  const view: any = new MarkdownView(containerEl);
  view.file = env.file(path);
  view.ephemeral = [] as unknown[];
  view.applied = [] as number[];
  view.setEphemeralState = (state: unknown) => view.ephemeral.push(state);
  view.getMode = () => mode;
  view.previewMode = { applyScroll: (line: number) => view.applied.push(line) };
  view.getState = () => ({ file: path, mode, source: rawSource });
  view.scrolledIntoView = [] as Array<[number, boolean]>;
  view.editor = {
    scrollIntoView: (range: { from: { line: number } }, center: boolean) => view.scrolledIntoView.push([range.from.line, center]),
  };
  const leaf: any = { view, getRoot: () => env.rootSplit };
  view.leaf = leaf;
  env.leaves.push(leaf);
  return { leaf, view, scroller, containerEl };
}

function createTaskViewModule(app: any, eventBus: EventBus) {
  let processor: ((source: string, el: HTMLElement, ctx: any) => void) | undefined;
  const plugin = {
    registerEvent: () => undefined,
    registerDomEvent: () => undefined,
    registerMarkdownCodeBlockProcessor: (_lang: string, cb: typeof processor) => {
      processor = cb;
    },
  };
  const module = new TaskViewModule({ app, plugin, eventBus } as any);
  module.load();
  return { module, processor: processor! };
}

async function openOutline(
  env: Env,
  module: TaskViewModule,
  eventBus: EventBus,
  getBlockTitle: (language: string) => string | null = (language) => pluginBlockTitle(language, undefined)
) {
  const leaf: any = { app: env.app, getRoot: () => env.rightSplit };
  const outline = new TaskOutlineView(leaf, {
    getTocItems: (path) => module.getTocItems(path),
    onIndexUpdated: (callback) => eventBus.on("index:updated", callback),
    getBlockTitle,
  });
  leaf.view = outline;
  document.body.appendChild(outline.containerEl);
  outline.load();
  await outline.onOpen();
  return { leaf, outline };
}

function mountBlock(processor: (source: string, el: HTMLElement, ctx: any) => void, parent: HTMLElement) {
  const el = document.createElement("div");
  parent.appendChild(el);
  const ctx = createMockProcessorContext("tasks/Task.md");
  processor("", el, ctx);
  return { el, ctx };
}

function texts(outline: TaskOutlineView): string[] {
  return Array.from(outline.contentEl.querySelectorAll(".tree-item-inner")).map((el) => el.textContent ?? "");
}

function nodeEl(outline: TaskOutlineView, text: string): HTMLElement {
  const inner = Array.from(outline.contentEl.querySelectorAll(".tree-item-inner")).find((el) => el.textContent === text);
  if (!inner) throw new Error(`no outline item "${text}" in ${JSON.stringify(texts(outline))}`);
  return inner.closest(".tree-item-self") as HTMLElement;
}

function tocItem(outline: TaskOutlineView, text: string) {
  const walk = (nodes: any[]): any => {
    for (const node of nodes) {
      if (node.text === text) return node.item;
      const found = walk(node.children);
      if (found) return found;
    }
    return null;
  };
  return walk((outline as any).tree);
}

function click(el: HTMLElement, init: MouseEventInit = {}): void {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function flush(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Заметка-задача: строки 3, 5, 7 - разделы, 10 - блок opa-task-view
const TASK = [
  "---",
  "status: В работе",
  "---",
  "## Описание задачи",
  "",
  "## Критерий выполнения",
  "",
  "## Список подзадач",
  "- [ ] ",
  "",
  "```opa-task-view",
  "```",
  "",
].join("\n");
// Строки подзаголовков: 4 «Образ», 6 «Подготовка нод», 8 «Ресерч»
const DAILY_1 = [
  "# 18-08-2026",
  "",
  "### [[Task]]",
  "По аналогии",
  "#### Образ",
  "собрали образ",
  "#### Подготовка нод",
  "ноды",
  "#### Ресерч",
  "почитал",
  "",
  "### [[Other]]",
  "не про нас",
  "#### Чужой раздел",
].join("\n");
const DAILY_2 = ["# 01-09-2026", "", "### [[Task]]", "Кэш", "#### Временный кэш на системном диске", "готово"].join("\n");
const PLAIN = ["# Заголовок", "текст", "## Раздел", "ещё"].join("\n");

const TASK_OUTLINE = [
  "Описание задачи",
  "Критерий выполнения",
  "Список подзадач",
  "Образ (18-08-2026)",
  "Подготовка нод (18-08-2026)",
  "Ресерч (18-08-2026)",
  "Временный кэш на системном диске (01-09-2026)",
];

function setup() {
  const env = createEnv({
    "tasks/Task.md": TASK,
    "tasks/Other.md": "## Другая задача\n",
    "periodic/daily/18-08-2026.md": DAILY_1,
    "periodic/daily/01-09-2026.md": DAILY_2,
    "notes/Plain.md": PLAIN,
  });
  const eventBus = new EventBus();
  const { module, processor } = createTaskViewModule(env.app, eventBus);
  const md = createMarkdownLeaf(env, "tasks/Task.md");
  env.workspace.mostRecent = md.leaf;
  return { env, eventBus, module, processor, md };
}

async function teardown(outline: TaskOutlineView, module: TaskViewModule): Promise<void> {
  outline.unload();
  await outline.onClose();
  module.unload();
  document.body.innerHTML = "";
}

test("Outline panel lists the note headings and then the task-view TOC items at the top level", async () => {
  const { env, eventBus, module, md } = setup();
  const { outline } = await openOutline(env, module, eventBus);
  await waitFor(() => texts(outline).length === TASK_OUTLINE.length);

  assert.deepEqual(texts(outline), TASK_OUTLINE);
  const topLevel = outline.contentEl.querySelectorAll(".opa-outline-tree > .tree-item");
  assert.equal(topLevel.length, TASK_OUTLINE.length, "пункты записей не вложены в «Список подзадач»");
  assert.equal(nodeEl(outline, "Образ (18-08-2026)").classList.contains("opa-outline-entry"), true);
  assert.equal(nodeEl(outline, "Описание задачи").classList.contains("opa-outline-entry"), false);
  assert.equal(outline.getDisplayText(), "Структура: Task");
  assert.equal(md.view.ephemeral.length, 0);
  // Кнопки шапки - над прокручиваемым содержимым, как у стандартных панелей
  assert.equal(outline.containerEl.firstElementChild?.classList.contains("nav-header"), true);
  await teardown(outline, module);
});

test("Outline panel: clicking a note heading scrolls the note to its line", async () => {
  const { env, eventBus, module, md } = setup();
  const { outline } = await openOutline(env, module, eventBus);
  await waitFor(() => texts(outline).length === TASK_OUTLINE.length);

  click(nodeEl(outline, "Критерий выполнения"));
  await flush();
  assert.deepEqual(md.view.ephemeral, [{ line: 5 }]);
  assert.deepEqual(env.activations, [[md.leaf, { focus: true }]], "как стандартный Outline: вкладка активна и в фокусе");
  await teardown(outline, module);
});

test("Outline panel: clicking a record heading scrolls to it in the task-view block and expands the record", async () => {
  const { env, eventBus, module, processor, md } = setup();
  const { el: block } = mountBlock(processor, md.scroller);
  await waitFor(() => block.querySelectorAll("details.task-view-entry").length === 2);
  const { outline } = await openOutline(env, module, eventBus);
  await waitFor(() => texts(outline).length === TASK_OUTLINE.length);

  const firstEntry = block.querySelector<HTMLElement>("details.task-view-entry")!;
  firstEntry.removeAttribute("open");
  firstEntry.querySelector(".task-view-collapse-button")!.textContent = "◀";
  // Геометрия: область прокрутки начинается на 100px, заголовок записи - на 900px (и едет вместе с прокруткой)
  let scrollTop = 0;
  Object.defineProperty(md.scroller, "scrollTop", { get: () => scrollTop, set: (v: number) => (scrollTop = v), configurable: true });
  Object.defineProperty(md.scroller, "scrollHeight", { value: 5000, configurable: true });
  Object.defineProperty(md.scroller, "clientHeight", { value: 500, configurable: true });
  md.scroller.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
  const heading = Array.from(firstEntry.querySelectorAll<HTMLElement>("h4")).find((h) => h.textContent === "Подготовка нод")!;
  heading.getBoundingClientRect = () => ({ top: 900 - scrollTop }) as DOMRect;

  click(nodeEl(outline, "Подготовка нод (18-08-2026)"));
  await waitFor(() => scrollTop !== 0);
  assert.equal(firstEntry.hasAttribute("open"), true, "свёрнутая запись развёрнута");
  assert.equal(firstEntry.querySelector(".task-view-collapse-button")?.textContent, "▼");
  assert.equal(scrollTop, 900 - 100 - 8, "заголовок встал к верху области прокрутки");
  assert.equal(heading.classList.contains("opa-outline-flash"), true);
  assert.deepEqual(md.view.ephemeral, [], "блок уже отрисован - к строке блока не прокручивали");
  assert.deepEqual(env.activations, [[md.leaf, { focus: true }]], "режим чтения: вкладка активна");
  await teardown(outline, module);
});

test("Outline panel: when the block is not rendered, scrolls to the block line and waits for it", async () => {
  const { env, eventBus, module, processor, md } = setup();
  const { outline } = await openOutline(env, module, eventBus);
  await waitFor(() => texts(outline).length === TASK_OUTLINE.length);

  const pending = (outline as any).goToEntry(tocItem(outline, "Ресерч"));
  await flush();
  assert.deepEqual(md.view.ephemeral, [{ scroll: 10 }], "в режиме чтения - прокрутка к строке блока без подсветки");
  // Obsidian отрисовал секцию с блоком
  const { el: block } = mountBlock(processor, md.scroller);
  await pending;
  const heading = Array.from(block.querySelectorAll<HTMLElement>("h4")).find((h) => h.textContent === "Ресерч")!;
  assert.equal(heading.classList.contains("opa-outline-flash"), true);
  await teardown(outline, module);
});

test("Outline panel: Live Preview scrolls the editor to the block line and waits; source mode stops there", async () => {
  const env = createEnv({
    "tasks/Task.md": TASK,
    "periodic/daily/18-08-2026.md": DAILY_1,
    "periodic/daily/01-09-2026.md": DAILY_2,
  });
  const eventBus = new EventBus();
  const { module, processor } = createTaskViewModule(env.app, eventBus);
  const live = createMarkdownLeaf(env, "tasks/Task.md", "source", false);
  env.workspace.mostRecent = live.leaf;
  const { outline } = await openOutline(env, module, eventBus);
  await waitFor(() => texts(outline).length === TASK_OUTLINE.length);

  const pending = (outline as any).goToEntry(tocItem(outline, "Образ"));
  await flush();
  assert.deepEqual(live.view.scrolledIntoView, [[10, true]]);
  assert.deepEqual(live.view.applied, []);
  const { el: block } = mountBlock(processor, live.scroller);
  await pending;
  const heading = Array.from(block.querySelectorAll<HTMLElement>("h4")).find((h) => h.textContent === "Образ")!;
  assert.equal(heading.classList.contains("opa-outline-flash"), true);
  assert.deepEqual(live.view.ephemeral, []);
  assert.deepEqual(env.activations, [[live.leaf, { focus: false }]], "Live Preview: редактор в фокус не ставится");
  outline.unload();
  await outline.onClose();

  // Режим исходного кода: блок не отрисуется - только прокрутка к нему, без ожидания и запасных переходов
  const raw = createMarkdownLeaf(env, "tasks/Task.md", "source", true);
  env.workspace.mostRecent = raw.leaf;
  env.leaves.splice(env.leaves.indexOf(live.leaf), 1);
  live.containerEl.remove();
  const second = await openOutline(env, module, eventBus);
  await waitFor(() => texts(second.outline).length === TASK_OUTLINE.length);
  const started = Date.now();
  await (second.outline as any).goToEntry(tocItem(second.outline, "Ресерч"));
  assert.ok(Date.now() - started < 1000, "без ожидания отрисовки");
  assert.deepEqual(raw.view.scrolledIntoView, [[10, true]]);
  assert.deepEqual(raw.view.ephemeral, []);
  await teardown(second.outline, module);
});

test("Outline panel: a newer click cancels the pending jump to a record that is not rendered yet", async () => {
  const { env, eventBus, module, processor, md } = setup();
  const { outline } = await openOutline(env, module, eventBus);
  await waitFor(() => texts(outline).length === TASK_OUTLINE.length);

  const pending = (outline as any).goToEntry(tocItem(outline, "Ресерч"));
  await flush();
  click(nodeEl(outline, "Описание задачи"));
  await flush();
  assert.deepEqual(md.view.ephemeral, [{ scroll: 10 }, { line: 3 }]);
  const { el: block } = mountBlock(processor, md.scroller);
  await pending;
  await waitFor(() => block.querySelectorAll("details.task-view-entry").length === 2);
  await flush(100);
  assert.equal(block.querySelector(".opa-outline-flash"), null, "отменённый переход не прокручивает к записи");
  await teardown(outline, module);
});

test("Outline panel follows the active markdown note; sidebar focus keeps it; non-markdown views clear it", async () => {
  const { env, eventBus, module } = setup();
  const { outline, leaf: outlineLeaf } = await openOutline(env, module, eventBus);
  await waitFor(() => texts(outline).length === TASK_OUTLINE.length);

  const plain = createMarkdownLeaf(env, "notes/Plain.md");
  env.workspace.emit("active-leaf-change", plain.leaf);
  await waitFor(() => texts(outline)[0] === "Заголовок");
  assert.deepEqual(texts(outline), ["Заголовок", "Раздел"]);
  assert.ok(nodeEl(outline, "Раздел").closest(".tree-item-children"), "вложенность по уровням");

  env.workspace.emit("active-leaf-change", outlineLeaf);
  await flush();
  assert.deepEqual(texts(outline), ["Заголовок", "Раздел"], "клик по самой панели не меняет заметку");

  const canvasLeaf = { view: { containerEl: document.body }, getRoot: () => env.rootSplit };
  env.workspace.emit("active-leaf-change", canvasLeaf);
  await waitFor(() => (outline.contentEl.textContent ?? "").includes("Нет открытой заметки"));
  await teardown(outline, module);
});

test("Outline panel refreshes on daily-index updates and on changes of the note itself", async () => {
  const { env, eventBus, module } = setup();
  const { outline } = await openOutline(env, module, eventBus);
  await waitFor(() => texts(outline).length === TASK_OUTLINE.length);

  env.write("periodic/daily/01-09-2026.md", DAILY_2 + "\n#### Итог\nвсё");
  await eventBus.emit("index:updated", undefined);
  await waitFor(() => texts(outline).includes("Итог (01-09-2026)"), 3000);

  env.write("tasks/Task.md", TASK.replace("## Список подзадач", "## Новый раздел\n\n## Список подзадач"));
  env.metadataCache.emit("changed", env.file("tasks/Task.md"));
  await waitFor(() => texts(outline).includes("Новый раздел"), 3000);
  assert.deepEqual(texts(outline).slice(0, 4), ["Описание задачи", "Критерий выполнения", "Новый раздел", "Список подзадач"]);

  // Без изменений данных дерево не перерисовывается
  const before = nodeEl(outline, "Новый раздел");
  env.metadataCache.emit("changed", env.file("tasks/Task.md"));
  await flush(400);
  assert.equal(nodeEl(outline, "Новый раздел"), before);
  await teardown(outline, module);
});

test("Outline panel: Ctrl+click and the context menu open the daily note at the heading", async () => {
  const { env, eventBus, module, md } = setup();
  const { outline } = await openOutline(env, module, eventBus);
  await waitFor(() => texts(outline).length === TASK_OUTLINE.length);

  click(nodeEl(outline, "Ресерч (18-08-2026)"), { ctrlKey: true });
  await waitFor(() => env.opened.length === 1);
  assert.equal(env.opened[0].paneType, "tab");
  assert.equal(env.opened[0].file.path, "periodic/daily/18-08-2026.md");
  assert.deepEqual(env.opened[0].state, { active: true, eState: { line: 8 } });
  assert.deepEqual(md.view.ephemeral, [], "в самой задаче ничего не прокручивали");

  nodeEl(outline, "Временный кэш на системном диске (01-09-2026)").dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })
  );
  const menu = Menu.last!;
  assert.deepEqual(menu.items.map((i) => i.title), ["Перейти к записи", "Открыть в ежедневной заметке"]);
  await menu.items[1].click();
  await waitFor(() => env.opened.length === 2);
  assert.equal(env.opened[1].file.path, "periodic/daily/01-09-2026.md");
  assert.deepEqual(env.opened[1].state, { active: true, eState: { line: 4 } });
  await teardown(outline, module);
});

test("Outline panel: search filter and collapsing", async () => {
  const { env, eventBus, module } = setup();
  const { outline } = await openOutline(env, module, eventBus);
  await waitFor(() => texts(outline).length === TASK_OUTLINE.length);

  const searchButton = outline.containerEl.querySelector<HTMLElement>('.nav-action-button[data-icon="search"]')!;
  click(searchButton);
  const input = outline.containerEl.querySelector<HTMLInputElement>(".opa-outline-search input")!;
  assert.notEqual(input.parentElement!.style.display, "none");
  input.value = "кэш";
  input.dispatchEvent(new window.Event("input"));
  assert.deepEqual(texts(outline), ["Временный кэш на системном диске (01-09-2026)"]);
  input.value = "18-08";
  input.dispatchEvent(new window.Event("input"));
  assert.deepEqual(texts(outline), ["Образ (18-08-2026)", "Подготовка нод (18-08-2026)", "Ресерч (18-08-2026)"]);
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  assert.equal(input.parentElement!.style.display, "none");
  assert.deepEqual(texts(outline), TASK_OUTLINE);

  // Свёртывание - на обычной заметке с вложенными заголовками
  const plain = createMarkdownLeaf(env, "notes/Plain.md");
  env.workspace.emit("active-leaf-change", plain.leaf);
  await waitFor(() => texts(outline)[0] === "Заголовок");
  const icon = nodeEl(outline, "Заголовок").querySelector<HTMLElement>(".collapse-icon")!;
  click(icon);
  assert.deepEqual(texts(outline), ["Заголовок"]);
  assert.equal(outline.contentEl.querySelector(".tree-item")?.classList.contains("is-collapsed"), true);
  assert.deepEqual(plain.view.ephemeral, [], "клик по стрелке не переходит к заголовку");
  const collapseAll = outline.containerEl.querySelector<HTMLElement>(".nav-action-button:not([data-icon='search'])")!;
  assert.equal(collapseAll.getAttribute("aria-label"), "Развернуть все");
  click(collapseAll);
  assert.deepEqual(texts(outline), ["Заголовок", "Раздел"]);
  assert.equal(collapseAll.getAttribute("aria-label"), "Свернуть все");
  click(collapseAll);
  assert.deepEqual(texts(outline), ["Заголовок"]);
  await teardown(outline, module);
});

test("Outline panel does not read notes without code blocks and shows an empty state without headings", async () => {
  const { env, eventBus, module } = setup();
  env.write("notes/Empty.md", "просто текст");
  const withSections = env.metadataCache.getFileCache(env.file("notes/Plain.md")) as any;
  withSections.sections = [{ type: "heading" }, { type: "paragraph" }];
  const { outline } = await openOutline(env, module, eventBus);
  await waitFor(() => texts(outline).length === TASK_OUTLINE.length);

  env.reads.length = 0;
  env.workspace.emit("active-leaf-change", createMarkdownLeaf(env, "notes/Plain.md").leaf);
  await waitFor(() => texts(outline)[0] === "Заголовок");
  assert.deepEqual(env.reads, [], "в заметке нет блоков кода - файл не читается");

  env.workspace.emit("active-leaf-change", createMarkdownLeaf(env, "notes/Empty.md").leaf);
  await waitFor(() => (outline.contentEl.textContent ?? "").includes("Заголовков нет"));
  await teardown(outline, module);
});

test("Outline panel: two records of the same task in one daily note are told apart", async () => {
  const daily = [
    "# 05-09-2026",
    "",
    "### [[Task]]",
    "утро",
    "#### Утро",
    "кофе",
    "",
    "### [[Other]]",
    "чужое",
    "",
    "### [[Task]]",
    "вечер",
    "#### Вечер",
    "чай",
  ].join("\n");
  const env = createEnv({ "tasks/Task.md": TASK, "periodic/daily/05-09-2026.md": daily });
  const eventBus = new EventBus();
  const { module, processor } = createTaskViewModule(env.app, eventBus);
  const md = createMarkdownLeaf(env, "tasks/Task.md");
  env.workspace.mostRecent = md.leaf;
  const { el: block } = mountBlock(processor, md.scroller);
  await waitFor(() => block.querySelectorAll("details.task-view-entry").length === 2);
  const { outline } = await openOutline(env, module, eventBus);
  await waitFor(() => texts(outline).includes("Вечер (05-09-2026)"));

  const entries = block.querySelectorAll<HTMLElement>("details.task-view-entry");
  assert.equal(entries[0].getAttribute("data-entry-key"), entries[1].getAttribute("data-entry-key"));
  await (outline as any).goToEntry(tocItem(outline, "Вечер"));
  const evening = entries[1].querySelector<HTMLElement>("h4")!;
  assert.equal(evening.textContent, "Вечер");
  assert.equal(evening.classList.contains("opa-outline-flash"), true);
  assert.equal(entries[0].querySelector(".opa-outline-flash"), null);
  await teardown(outline, module);
});

test("Outline panel keeps the note for deferred tabs and linked panes; file-open follows navigation in the same tab", async () => {
  const { env, eventBus, module, md } = setup();
  const { outline } = await openOutline(env, module, eventBus);
  await waitFor(() => texts(outline).length === TASK_OUTLINE.length);

  // Фоновая вкладка ещё не загружена (DeferredView) - панель не сбрасывается
  env.workspace.emit("active-leaf-change", {
    view: { containerEl: document.body },
    isDeferred: true,
    getRoot: () => env.rootSplit,
  });
  await flush();
  assert.deepEqual(texts(outline), TASK_OUTLINE);
  // Связанная панель в основной области (обратные ссылки, граф): navigation = false
  env.workspace.emit("active-leaf-change", {
    view: { containerEl: document.body, navigation: false },
    getRoot: () => env.rootSplit,
  });
  await flush();
  assert.deepEqual(texts(outline), TASK_OUTLINE);

  // Переход по ссылке в той же вкладке: активная вкладка та же, файл другой
  md.view.file = env.file("notes/Plain.md");
  env.workspace.emit("file-open", env.file("notes/Plain.md"));
  await waitFor(() => texts(outline)[0] === "Заголовок");
  assert.equal(outline.getDisplayText(), "Структура: Plain");
  await teardown(outline, module);
});

test("Outline panel: while searching, collapsing is unavailable and everything matching is shown", async () => {
  const { env, eventBus, module } = setup();
  const plain = createMarkdownLeaf(env, "notes/Plain.md");
  env.workspace.mostRecent = plain.leaf;
  const { outline } = await openOutline(env, module, eventBus);
  await waitFor(() => texts(outline)[0] === "Заголовок");
  click(nodeEl(outline, "Заголовок").querySelector<HTMLElement>(".collapse-icon")!);
  assert.deepEqual(texts(outline), ["Заголовок"]);

  click(outline.containerEl.querySelector<HTMLElement>('.nav-action-button[data-icon="search"]')!);
  const input = outline.containerEl.querySelector<HTMLInputElement>(".opa-outline-search input")!;
  input.value = "раздел";
  input.dispatchEvent(new window.Event("input"));
  assert.deepEqual(texts(outline), ["Заголовок", "Раздел"], "свёрнутый узел раскрыт на время поиска");
  assert.equal(outline.contentEl.querySelector(".collapse-icon"), null);
  const collapseAll = outline.containerEl.querySelector<HTMLElement>(".nav-action-button:not([data-icon='search'])")!;
  assert.equal(collapseAll.style.display, "none");

  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  assert.deepEqual(texts(outline), ["Заголовок"], "после поиска свёрнутость прежняя");
  assert.equal(collapseAll.style.display, "");
  await teardown(outline, module);
});

test("Outline panel retries while the metadata cache lags behind daily notes", async () => {
  const { env, eventBus, module } = setup();
  const { outline } = await openOutline(env, module, eventBus);
  await waitFor(() => texts(outline).length === TASK_OUTLINE.length);

  // Файл уже изменён (строка перед заголовком задачи сдвинула позиции), кэш метаданных ещё старый
  const changed = DAILY_2.replace("# 01-09-2026\n", "# 01-09-2026\nвступление\n") + "\n#### Итог\nвсё";
  env.write("periodic/daily/01-09-2026.md", changed, false);
  await eventBus.emit("index:updated", undefined);
  await flush(450);
  assert.equal(texts(outline).includes("Итог (01-09-2026)"), false);
  // Кэш догнал файл - панель обновляется сама, без новых событий
  env.reindex("periodic/daily/01-09-2026.md");
  await waitFor(() => texts(outline).includes("Итог (01-09-2026)"), 3000);
  await teardown(outline, module);
});

// Домашняя страница: блоки плагина до разделов, блок геймификации - внутри «Прочее».
// Строки блоков: 5 напоминания, 8 проекты, 11 доска задач, 14 блокнот, 17 корзина, 22 геймификация
const HOMEPAGE = [
  "---",
  "obsidianUIMode: preview",
  "---",
  "",
  "",
  "```opa-reminders-view",
  "```",
  "",
  "```opa-projects-view",
  "```",
  "",
  "```opa-home-view",
  "```",
  "",
  "```opa-inbox-view",
  "```",
  "",
  "```opa-trash-view",
  "```",
  "",
  "## Прочее",
  "",
  "```opa-gamification-view",
  "```",
  "",
  "## Шаблоны",
  "- [[templates/task]]",
  "",
  "## Архив",
  "- [[Archive]]",
].join("\n");

function homepageSetup() {
  const env = createEnv({ "Homepage.md": HOMEPAGE, "tasks/Task.md": TASK, "periodic/daily/18-08-2026.md": DAILY_1 });
  const eventBus = new EventBus();
  const { module } = createTaskViewModule(env.app, eventBus);
  const md = createMarkdownLeaf(env, "Homepage.md");
  env.workspace.mostRecent = md.leaf;
  const settings = {
    enableReminders: true,
    enableTasksDashboard: true,
    enableInbox: true,
    enableTrash: true,
    enableActivities: true,
    enableGamification: false,
  } as any;
  return { env, eventBus, module, md, settings };
}

/** Отрисованный блок плагина, как его строят модули: контейнер с классом языка и шапка секции. */
function mountPluginBlock(parent: HTMLElement, language: string, title: string): HTMLElement {
  const el = parent.appendChild(document.createElement("div"));
  el.className = `block-language-${language} ${language}`;
  el.innerHTML = `<div class="opa-section"><div class="opa-section-header"><div class="opa-collapse-indicator"></div><h4 class="opa-section-title">${title}</h4></div><div class="opa-section-body"><p>Пусто</p></div></div>`;
  return el;
}

test("Outline panel shows titles of plugin blocks (Homepage) between the note headings; disabled modules are hidden", async () => {
  const { env, eventBus, module, settings } = homepageSetup();
  const { outline } = await openOutline(env, module, eventBus, (language) => pluginBlockTitle(language, settings));
  await waitFor(() => texts(outline).length > 0);

  assert.deepEqual(texts(outline), ["Напоминания", "Проекты", "Доска задач", "Блокнот", "Корзина", "Прочее", "Шаблоны", "Архив"]);
  const topLevel = Array.from(outline.contentEl.querySelectorAll(".opa-outline-tree > .tree-item > .tree-item-self")).map(
    (el) => el.textContent
  );
  assert.equal(topLevel.length, 8, "блоки до разделов - на верхнем уровне");

  // Включили геймификацию в настройках - её заголовок появился внутри «Прочее»
  settings.enableGamification = true;
  outline.refresh();
  await waitFor(() => texts(outline).includes("Прогресс"));
  assert.ok(nodeEl(outline, "Прогресс").closest(".tree-item-children"));
  assert.deepEqual(texts(outline).slice(5, 7), ["Прочее", "Прогресс"]);
  await teardown(outline, module);
});

test("Outline panel: clicking a block title scrolls to the rendered block header", async () => {
  const { env, eventBus, module, md, settings } = homepageSetup();
  mountPluginBlock(md.scroller, "opa-reminders-view", "Напоминания");
  const trash = mountPluginBlock(md.scroller, "opa-trash-view", "Корзина");
  const { outline } = await openOutline(env, module, eventBus, (language) => pluginBlockTitle(language, settings));
  await waitFor(() => texts(outline).includes("Корзина"));

  let scrollTop = 0;
  Object.defineProperty(md.scroller, "scrollTop", { get: () => scrollTop, set: (v: number) => (scrollTop = v), configurable: true });
  Object.defineProperty(md.scroller, "scrollHeight", { value: 5000, configurable: true });
  Object.defineProperty(md.scroller, "clientHeight", { value: 500, configurable: true });
  md.scroller.getBoundingClientRect = () => ({ top: 50 }) as DOMRect;
  const header = trash.querySelector<HTMLElement>(".opa-section-header")!;
  header.getBoundingClientRect = () => ({ top: 1200 - scrollTop }) as DOMRect;

  click(nodeEl(outline, "Корзина"));
  await waitFor(() => scrollTop !== 0);
  assert.equal(scrollTop, 1200 - 50 - 8);
  assert.equal(header.classList.contains("opa-outline-flash"), true);
  assert.deepEqual(md.view.ephemeral, [], "блок в DOM - к строке не прокручивали");
  assert.deepEqual(env.activations, [[md.leaf, { focus: true }]]);
  await teardown(outline, module);
});

test("Outline panel: a block title whose block is not rendered scrolls to its line first", async () => {
  const { env, eventBus, module, md, settings } = homepageSetup();
  const { outline } = await openOutline(env, module, eventBus, (language) => pluginBlockTitle(language, settings));
  await waitFor(() => texts(outline).includes("Блокнот"));

  click(nodeEl(outline, "Блокнот"));
  await flush();
  assert.deepEqual(md.view.ephemeral, [{ scroll: 14 }]);
  const inbox = mountPluginBlock(md.scroller, "opa-inbox-view", "Блокнот");
  await waitFor(() => inbox.querySelector(".opa-outline-flash") != null);
  await teardown(outline, module);
});
