import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { MarkdownView, MockEvents, Modal, Notice, SuggestModal, TFile } from "obsidian";
import {
  PROJECT_HOVER_SOURCE,
  PROJECT_LINK_CLASS,
  TaskProjectLinkModule,
  pillProjectValue,
  projectNoteFile,
  projectTargetsOf,
} from "../src/modules/TaskProjectLinkModule";

// ---------------------------------------------------------------------------
// Окружение: jsdom + DOM-хелперы Obsidian (createEl/createDiv/createSpan)
// ---------------------------------------------------------------------------

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.org/", pretendToBeVisual: true });
const { window } = dom;
const document = window.document;
(globalThis as any).window = window;
(globalThis as any).document = document;
(globalThis as any).Node = window.Node;
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).MutationObserver = window.MutationObserver;

type CreateOpts = { text?: string; cls?: string; attr?: Record<string, string> } | string;

/** DOM-хелперы Obsidian в окне (у всплывающего окна - свои). */
function installDomHelpers(win: any): void {
  const proto = win.HTMLElement.prototype as any;
  proto.createEl = function (tag: string, opts?: CreateOpts) {
    const el = this.ownerDocument.createElement(tag);
    if (typeof opts === "string") el.className = opts;
    else if (opts) {
      if (opts.cls) el.className = opts.cls;
      if (opts.text != null) el.textContent = opts.text;
      if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, String(v));
    }
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (opts?: CreateOpts) {
    return this.createEl("div", opts);
  };
  proto.createSpan = function (opts?: CreateOpts) {
    return this.createEl("span", opts);
  };
}
installDomHelpers(window);

// ---------------------------------------------------------------------------
// Хранилище, вкладки и плагин
// ---------------------------------------------------------------------------

function setup() {
  Notice.messages.length = 0;
  Modal.opened = [];
  document.body.innerHTML = "";

  const files = new Map<string, TFile>();
  const caches = new Map<string, any>();
  const vault = new MockEvents() as any;
  vault.getMarkdownFiles = () => [...files.values()].filter((file) => file.extension === "md");
  const metadataCache = new MockEvents() as any;
  metadataCache.getFileCache = (file: TFile) => caches.get(file.path) ?? null;
  // Как в Obsidian: по пути без .md, иначе по имени заметки
  metadataCache.getFirstLinkpathDest = (link: string) => {
    const target = link.replace(/\.md$/i, "").toLowerCase();
    const name = target.split("/").pop();
    const md = vault.getMarkdownFiles() as TFile[];
    return (
      md.find((file) => file.path.replace(/\.md$/i, "").toLowerCase() === target) ??
      md.find((file) => file.basename.toLowerCase() === name) ??
      null
    );
  };

  const leaves: Record<string, Array<{ view: any }>> = {};
  const opened: Array<{ linktext: string; sourcePath: string; newLeaf: unknown }> = [];
  /** Заметки, открытые напрямую (getLeaf().openFile), а не как ссылка. */
  const openedFiles: Array<{ path: string; newLeaf: unknown }> = [];
  const triggered: Array<{ name: string; data: any }> = [];
  const workspace = new MockEvents() as any;
  workspace.activeFile = null as TFile | null;
  workspace.getActiveFile = () => workspace.activeFile;
  workspace.getLeavesOfType = (type: string) => leaves[type] ?? [];
  workspace.onLayoutReady = (callback: () => void) => callback();
  workspace.openLinkText = async (linktext: string, sourcePath: string, newLeaf: unknown) => {
    opened.push({ linktext, sourcePath, newLeaf });
  };
  workspace.trigger = (name: string, data: unknown) => triggered.push({ name, data });
  workspace.getLeaf = (newLeaf: unknown) => ({
    openFile: async (file: TFile) => {
      openedFiles.push({ path: file.path, newLeaf });
    },
  });

  const app = { vault, metadataCache, workspace };

  const commands: any[] = [];
  const hoverSources: Array<{ id: string; info: any }> = [];
  const cleanups: Array<() => void> = [];
  const plugin: any = {
    addCommand: (command: any) => commands.push(command),
    registerEvent: (ref: any) => cleanups.push(() => ref.emitter.offref(ref)),
    registerDomEvent: (el: EventTarget, type: string, callback: any, options?: any) => {
      el.addEventListener(type, callback, options);
      cleanups.push(() => el.removeEventListener(type, callback, options));
    },
    registerHoverLinkSource: (id: string, info: unknown) => hoverSources.push({ id, info }),
  };

  const module = new TaskProjectLinkModule({ app, plugin, taskIndex: null, remindersIndex: null, eventBus: null } as any);

  /** Заметка с frontmatter (задача, проект) или без него. */
  const addNote = (path: string, frontmatter: Record<string, unknown> | null = null) => {
    const file = new TFile(path);
    files.set(path, file);
    caches.set(path, frontmatter ? { frontmatter } : {});
    return file;
  };
  const removeNote = (path: string) => {
    files.delete(path);
    caches.delete(path);
  };
  const setFrontmatter = (file: TFile, frontmatter: Record<string, unknown>) => {
    caches.set(file.path, { frontmatter });
    metadataCache.emit("changed", file, "", { frontmatter });
  };

  /** Вкладка заметки с панелью свойств, как её рисует Obsidian. */
  const openNote = (file: TFile, properties: Record<string, string[]>) => {
    const containerEl = document.body.appendChild(document.createElement("div"));
    containerEl.className = "workspace-leaf-content";
    containerEl.setAttribute("data-type", "markdown");
    const panel = renderProperties(containerEl, properties);
    const view = new MarkdownView(containerEl as any);
    view.file = file;
    (leaves.markdown ??= []).push({ view });
    workspace.activeFile = file;
    return { containerEl, panel, view };
  };

  /** Панель «Свойства файла» в сайдбаре: свойства активной заметки. */
  const openSidebarProperties = (properties: Record<string, string[]>) => {
    const containerEl = document.body.appendChild(document.createElement("div"));
    containerEl.className = "workspace-leaf-content";
    containerEl.setAttribute("data-type", "file-properties");
    renderProperties(containerEl, properties);
    (leaves["file-properties"] ??= []).push({ view: { containerEl } });
    return containerEl;
  };

  const unloadPlugin = () => {
    module.unload();
    for (const cleanup of cleanups.splice(0)) cleanup();
  };

  return {
    app, module, plugin, commands, hoverSources, opened, openedFiles, triggered, workspace, metadataCache, vault,
    leaves, addNote, removeNote, setFrontmatter, openNote, openSidebarProperties, unloadPlugin,
  };
}

/** Панель свойств: строка на свойство, значения списка - плашки с текстом и крестиком. */
function renderProperties(parent: HTMLElement, properties: Record<string, string[]>): HTMLElement {
  const container = (parent as any).createDiv({ cls: "metadata-container" }) as HTMLElement;
  const list = (container as any).createDiv({ cls: "metadata-properties" }) as HTMLElement;
  for (const [key, values] of Object.entries(properties)) {
    const property = (list as any).createDiv({
      cls: "metadata-property",
      attr: { "data-property-key": key, "data-property-type": "multitext" },
    }) as HTMLElement;
    const value = (property as any).createDiv({ cls: "metadata-property-value" }) as HTMLElement;
    const select = (value as any).createDiv({ cls: "multi-select-container" }) as HTMLElement;
    renderPills(select, values);
  }
  return container;
}

function renderPills(select: HTMLElement, values: string[]): void {
  select.innerHTML = "";
  for (const text of values) {
    const pill = (select as any).createDiv({ cls: "multi-select-pill", attr: { tabindex: "0" } }) as HTMLElement;
    (pill as any).createDiv({ cls: "multi-select-pill-content" }).createSpan({ text });
    const remove = (pill as any).createDiv({ cls: "multi-select-pill-remove-button" }) as HTMLElement;
    remove.appendChild(select.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg"));
  }
  (select as any).createDiv({ cls: "multi-select-input", attr: { contenteditable: "true" } });
}

const pills = (root: ParentNode, key = "project") =>
  Array.from(root.querySelectorAll<HTMLElement>(`.metadata-property[data-property-key="${key}"] .multi-select-pill`));
const pillText = (pill: HTMLElement) => pill.querySelector<HTMLElement>(".multi-select-pill-content span")!;
const isLink = (pill: HTMLElement) => pill.classList.contains(PROJECT_LINK_CLASS);

function click(target: Element, init: MouseEventInit = {}, type = "click"): MouseEvent {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  target.dispatchEvent(event);
  return event;
}

async function flush(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Значение плашки и заметка проекта
// ---------------------------------------------------------------------------

test("pill value: the text must be a project value from frontmatter, links [[…]] are left to Obsidian", () => {
  assert.equal(pillProjectValue("Obsidian", ["Obsidian"]), "Obsidian");
  assert.equal(pillProjectValue(" Trino ", ["Trino"]), "Trino");
  assert.equal(pillProjectValue("Trino", "Trino"), "Trino", "scalar value");
  assert.equal(pillProjectValue("Trino, Spark", "Trino, Spark"), "Trino, Spark", "Obsidian shows it as one value");
  assert.equal(pillProjectValue("Trino", "Trino, Spark"), null);
  assert.equal(pillProjectValue("Проекты/Trino", ["Проекты/Trino"]), "Проекты/Trino");
  assert.equal(pillProjectValue("Spark", ["Trino"]), null, "not in frontmatter (stale panel)");
  assert.equal(pillProjectValue("", ["Trino"]), null);
  assert.equal(pillProjectValue("Obsidian", ["[[Obsidian]]"]), null);
  assert.equal(pillProjectValue("[[Obsidian]]", ["[[Obsidian]]"]), null);
  assert.equal(pillProjectValue("Obsidian", undefined), null);
});

test("project note: by path, then by name; none for a missing project and for the note itself", () => {
  const env = setup();
  const task = env.addNote("Задача.md", { project: ["Obsidian"] });
  const obsidian = env.addNote("Obsidian.md", { project: "Obsidian" });
  const trino = env.addNote("Проекты/Trino.md", { project: "Проекты/Trino" });
  const moved = env.addNote("Работа/Spark.md", { project: "Spark" });
  const test = env.addNote("Проекты/Тест.md", { project: "Проекты/Тест" });

  assert.equal(projectNoteFile(env.app, "Obsidian", task.path), obsidian);
  assert.equal(projectNoteFile(env.app, "Проекты/Trino", task.path), trino);
  assert.equal(projectNoteFile(env.app, "Trino", task.path), trino);
  assert.equal(projectNoteFile(env.app, "Проекты/Spark", task.path), moved, "folder changed - found by name");
  assert.equal(projectNoteFile(env.app, "[[Проекты/Тест|Тест]]", task.path), test);
  assert.equal(projectNoteFile(env.app, "Нет такого", task.path), null);
  assert.equal(projectNoteFile(env.app, "Obsidian", obsidian.path), null, "project note links to itself");
});

test("project targets: notes without repeats, names of projects without a note, own name skipped", () => {
  const env = setup();
  const obsidian = env.addNote("Obsidian.md", { project: "Obsidian" });
  const trino = env.addNote("Проекты/Trino.md", { project: "Проекты/Trino" });
  const task = env.addNote("Задача.md", { project: ["Obsidian", "Проекты/Trino", "Trino", "Без заметки"] });
  assert.deepEqual(projectTargetsOf(env.app, task), {
    found: [
      { name: "Obsidian", file: obsidian },
      { name: "Trino", file: trino },
    ],
    missing: ["Без заметки"],
  });
  assert.deepEqual(projectTargetsOf(env.app, obsidian), { found: [], missing: [] });
  const sub = env.addNote("Плагин.md", { project: ["Плагин", "Obsidian"] });
  assert.deepEqual(projectTargetsOf(env.app, sub), { found: [{ name: "Obsidian", file: obsidian }], missing: [] });
});

// ---------------------------------------------------------------------------
// Плашка проекта в свойствах
// ---------------------------------------------------------------------------

test("click on the project in task properties opens the project note in the same tab", async () => {
  const env = setup();
  const project = env.addNote("Obsidian.md", { project: "Obsidian" });
  const task = env.addNote("Obsidian project automation 0.1.4.md", { project: ["Obsidian"], context: "личное" });
  const { containerEl } = env.openNote(task, { project: ["Obsidian"], context: ["личное"] });
  env.module.load();

  const pill = pills(containerEl)[0];
  let pillClicks = 0;
  pill.addEventListener("click", () => pillClicks++);
  const event = click(pillText(pill));

  assert.deepEqual(env.opened, [{ linktext: project.path, sourcePath: task.path, newLeaf: false }]);
  assert.equal(event.defaultPrevented, true);
  assert.equal(pillClicks, 0, "Obsidian's own pill handler does not see the click");

  await flush();
  assert.equal(isLink(pill), true, "the pill looks like a link");
  assert.equal(isLink(pills(containerEl, "context")[0]), false, "other properties stay as they are");
});

test("Ctrl/Cmd+click and the middle button open the project in a new tab", () => {
  const env = setup();
  const project = env.addNote("Проекты/Trino.md", { project: "Проекты/Trino" });
  const task = env.addNote("Trino ACL.md", { project: ["Проекты/Trino"] });
  const { containerEl } = env.openNote(task, { project: ["Проекты/Trino"] });
  env.module.load();

  click(pillText(pills(containerEl)[0]), { ctrlKey: true });
  click(pillText(pills(containerEl)[0]), { metaKey: true });
  click(pillText(pills(containerEl)[0]), { button: 1 }, "auxclick");
  assert.deepEqual(
    env.opened.map((o) => [o.linktext, o.newLeaf]),
    [
      [project.path, "tab"],
      [project.path, "tab"],
      [project.path, "tab"],
    ]
  );
  // Средняя кнопка шлёт и click с button=1 - он не открывает проект второй раз
  click(pillText(pills(containerEl)[0]), { button: 1 });
  assert.equal(env.opened.length, 3);
});

test("the remove cross, projects without a note, link values and other properties keep Obsidian behaviour", async () => {
  const env = setup();
  env.addNote("Obsidian.md", { project: "Obsidian" });
  const task = env.addNote("Задача.md", {
    project: ["Obsidian", "Без заметки", "[[Obsidian]]"],
    context: "Obsidian",
  });
  const { containerEl } = env.openNote(task, { project: ["Obsidian", "Без заметки"], context: ["Obsidian"] });
  // Значение-ссылку Obsidian рисует ссылкой
  const select = containerEl.querySelector<HTMLElement>(".multi-select-container")!;
  const linkPill = (select as any).createDiv({ cls: "multi-select-pill" }) as HTMLElement;
  (linkPill as any).createDiv({ cls: "multi-select-pill-content" }).createEl("a", {
    cls: "internal-link",
    text: "Obsidian",
    attr: { "data-href": "Obsidian" },
  });
  env.module.load();

  const [linked, noNote] = pills(containerEl);
  const removeEvent = click(linked.querySelector(".multi-select-pill-remove-button svg")!);
  const noNoteEvent = click(pillText(noNote));
  const linkEvent = click(linkPill.querySelector("a")!);
  const contextEvent = click(pillText(pills(containerEl, "context")[0]));

  assert.deepEqual(env.opened, []);
  for (const event of [removeEvent, noNoteEvent, linkEvent, contextEvent]) assert.equal(event.defaultPrevented, false);
  await flush();
  assert.deepEqual(
    pills(containerEl).map(isLink),
    [true, false, false],
    "only the project with a note is a link"
  );
});

test("double click: one transition, the second click and dblclick do not reach Obsidian's value editing", () => {
  const env = setup();
  const project = env.addNote("Obsidian.md", { project: "Obsidian" });
  const task = env.addNote("Задача.md", { project: ["Obsidian"] });
  const { containerEl } = env.openNote(task, { project: ["Obsidian"] });
  env.module.load();
  const text = pillText(pills(containerEl)[0]);
  let dblclicks = 0;
  text.addEventListener("dblclick", () => dblclicks++);

  click(text, { detail: 1 });
  const second = click(text, { detail: 2 });
  const dbl = click(text, { detail: 2 }, "dblclick");
  assert.deepEqual(env.opened, [{ linktext: project.path, sourcePath: task.path, newLeaf: false }]);
  assert.equal(second.defaultPrevented, false, "the second click is not a new transition");
  assert.equal(dbl.defaultPrevented, true);
  assert.equal(dblclicks, 0, "value editing does not start");

  // Позже двойной клик - снова обычный (например, по другому свойству)
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 5000;
    const later = click(pillText(pills(containerEl)[0]), { detail: 2 }, "dblclick");
    assert.equal(later.defaultPrevented, false);
    assert.equal(dblclicks, 1);
  } finally {
    Date.now = realNow;
  }
});

test("a value being edited (input or contenteditable inside the pill) is not a link target", () => {
  const env = setup();
  env.addNote("Obsidian.md", { project: "Obsidian" });
  const task = env.addNote("Задача.md", { project: ["Obsidian"] });
  const { containerEl } = env.openNote(task, { project: ["Obsidian"] });
  env.module.load();
  const content = pills(containerEl)[0].querySelector<HTMLElement>(".multi-select-pill-content")!;
  content.setAttribute("contenteditable", "true");
  assert.equal(click(pillText(pills(containerEl)[0])).defaultPrevented, false);
  content.removeAttribute("contenteditable");
  const input = content.appendChild(document.createElement("input"));
  assert.equal(click(input).defaultPrevented, false);
  assert.deepEqual(env.opened, []);
  input.remove();
  // Редактор вокруг панели свойств (contenteditable) не мешает
  containerEl.setAttribute("contenteditable", "true");
  assert.equal(click(pillText(pills(containerEl)[0])).defaultPrevented, true);
  assert.equal(env.opened.length, 1);
});

test("a project note whose path breaks links (#) is opened directly", () => {
  const env = setup();
  const project = env.addNote("Проекты/C#.md", { project: "Проекты/C#" });
  const task = env.addNote("Задача.md", { project: ["Проекты/C#"] });
  const { containerEl } = env.openNote(task, { project: ["Проекты/C#"] });
  env.module.load();
  click(pillText(pills(containerEl)[0]), { ctrlKey: true });
  assert.deepEqual(env.opened, []);
  assert.deepEqual(env.openedFiles, [{ path: project.path, newLeaf: "tab" }]);
});

test("in the project note its own project is not a link, a parent project is", async () => {
  const env = setup();
  const parent = env.addNote("Работа.md", { project: "Работа" });
  const hub = env.addNote("Obsidian.md", { project: ["Obsidian", "Работа"] });
  const { containerEl } = env.openNote(hub, { project: ["Obsidian", "Работа"] });
  env.module.load();

  const [own, up] = pills(containerEl);
  assert.equal(click(pillText(own)).defaultPrevented, false);
  click(pillText(up));
  assert.deepEqual(env.opened, [{ linktext: parent.path, sourcePath: hub.path, newLeaf: false }]);
  await flush();
  assert.deepEqual([isLink(own), isLink(up)], [false, true]);
});

test("the sidebar file properties panel works for the active note", () => {
  const env = setup();
  const project = env.addNote("Obsidian.md", { project: "Obsidian" });
  const task = env.addNote("Задача.md", { project: ["Obsidian"] });
  env.openNote(task, { project: ["Obsidian"] });
  const sidebar = env.openSidebarProperties({ project: ["Obsidian"] });
  env.module.load();

  click(pillText(pills(sidebar)[0]));
  assert.deepEqual(env.opened, [{ linktext: project.path, sourcePath: task.path, newLeaf: false }]);
});

test("properties outside a note tab (no owner) are left alone", () => {
  const env = setup();
  env.addNote("Obsidian.md", { project: "Obsidian" });
  const stray = document.body.appendChild(document.createElement("div"));
  renderProperties(stray, { project: ["Obsidian"] });
  env.module.load();
  assert.equal(click(pillText(pills(stray)[0])).defaultPrevented, false);
  assert.deepEqual(env.opened, []);
});

test("links follow re-rendered pills, new and deleted project notes and edited frontmatter", async () => {
  const env = setup();
  env.addNote("Obsidian.md", { project: "Obsidian" });
  const task = env.addNote("Задача.md", { project: ["Obsidian", "Trino"] });
  const { containerEl } = env.openNote(task, { project: ["Obsidian", "Trino"] });
  env.module.load();
  await flush();
  assert.deepEqual(pills(containerEl).map(isLink), [true, false]);

  // Obsidian перерисовал плашки (правка свойств) - класс возвращается
  renderPills(containerEl.querySelector<HTMLElement>(".multi-select-container")!, ["Obsidian", "Trino"]);
  assert.deepEqual(pills(containerEl).map(isLink), [false, false]);
  await flush();
  assert.deepEqual(pills(containerEl).map(isLink), [true, false]);

  // Появилась заметка проекта Trino
  const trino = env.addNote("Trino.md", { project: "Trino" });
  env.vault.emit("create", trino);
  await flush();
  assert.deepEqual(pills(containerEl).map(isLink), [true, true]);

  // Заметку Obsidian удалили
  env.removeNote("Obsidian.md");
  env.vault.emit("delete", new TFile("Obsidian.md"));
  await flush();
  assert.deepEqual(pills(containerEl).map(isLink), [false, true]);

  // Trino убрали из project, а панель ещё не перерисована: плашка больше не ссылка
  env.setFrontmatter(task, { project: ["Obsidian"] });
  await flush();
  assert.deepEqual(pills(containerEl).map(isLink), [false, false]);
});

test("hover over a project triggers the page preview of the project note (Ctrl/Cmd by default)", async () => {
  const env = setup();
  const project = env.addNote("Obsidian.md", { project: "Obsidian" });
  const task = env.addNote("Задача.md", { project: ["Obsidian", "Без заметки"] });
  const { containerEl, view } = env.openNote(task, { project: ["Obsidian", "Без заметки"] });
  env.module.load();
  assert.deepEqual(env.hoverSources, [
    { id: PROJECT_HOVER_SOURCE, info: { display: "Obsidian Project Automation", defaultMod: true } },
  ]);

  const [linked, noNote] = pills(containerEl);
  click(pillText(linked), {}, "mouseover");
  click(pillText(noNote), {}, "mouseover");
  assert.equal(env.triggered.length, 1);
  const { name, data } = env.triggered[0];
  assert.equal(name, "hover-link");
  assert.equal(data.source, PROJECT_HOVER_SOURCE);
  assert.equal(data.linktext, project.path);
  assert.equal(data.sourcePath, task.path);
  assert.equal(data.targetEl, linked);
  assert.equal(data.hoverParent, view);
  assert.equal(isLink(linked), true, "hover marks the link even before the delayed pass");
});

test("popout windows get the same handlers", async () => {
  const env = setup();
  const project = env.addNote("Obsidian.md", { project: "Obsidian" });
  const task = env.addNote("Задача.md", { project: ["Obsidian"] });
  env.module.load();

  const popoutWindow = new JSDOM("<!doctype html><html><body></body></html>").window;
  installDomHelpers(popoutWindow);
  const popout = popoutWindow.document;
  const containerEl = popout.body.appendChild(popout.createElement("div"));
  renderProperties(containerEl as any, { project: ["Obsidian"] });
  const view = new MarkdownView(containerEl as any);
  view.file = task;
  env.leaves.markdown = [{ view }];
  env.workspace.emit("window-open", { doc: popout }, popout.defaultView);

  const pill = pills(containerEl)[0];
  const event = new popoutWindow.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  pillText(pill).dispatchEvent(event);
  assert.deepEqual(env.opened, [{ linktext: project.path, sourcePath: task.path, newLeaf: false }]);
  await flush();
  assert.equal(isLink(pill), true, "pills in the popout are marked too");
  // Перерисовка плашек во всплывающем окне - тоже
  renderPills(containerEl.querySelector<HTMLElement>(".multi-select-container")!, ["Obsidian"]);
  await flush();
  assert.equal(isLink(pills(containerEl)[0]), true);

  // Окно закрыли: его документ больше не слушается
  env.leaves.markdown = [];
  env.workspace.emit("window-close", { doc: popout }, popout.defaultView);
  const after = new popoutWindow.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  pillText(pills(containerEl)[0]).dispatchEvent(after);
  assert.equal(after.defaultPrevented, false);
  assert.equal(env.opened.length, 1);
});

test("unload removes link classes and stops handling clicks", async () => {
  const env = setup();
  env.addNote("Obsidian.md", { project: "Obsidian" });
  const task = env.addNote("Задача.md", { project: ["Obsidian"] });
  const { containerEl } = env.openNote(task, { project: ["Obsidian"] });
  env.module.load();
  await flush();
  assert.equal(isLink(pills(containerEl)[0]), true);

  env.module.unload();
  assert.equal(isLink(pills(containerEl)[0]), false);
  assert.equal(click(pillText(pills(containerEl)[0])).defaultPrevented, false);
  env.metadataCache.emit("changed", task, "", {});
  await flush();
  assert.equal(isLink(pills(containerEl)[0]), false, "no decoration after unload");
  assert.deepEqual(env.opened, []);
  env.unloadPlugin();
});

// ---------------------------------------------------------------------------
// Команда «Открыть проект задачи»
// ---------------------------------------------------------------------------

function command(env: ReturnType<typeof setup>) {
  const cmd = env.commands.find((c) => c.id === "open-task-project");
  assert.ok(cmd, "command is registered");
  assert.equal(cmd.name, "Открыть проект задачи");
  return cmd;
}

test("command: available in a note with a project, opens the project note in the same tab", () => {
  const env = setup();
  const project = env.addNote("Obsidian.md", { project: "Obsidian" });
  const task = env.addNote("Задача.md", { project: ["Obsidian"] });
  env.module.load();
  const cmd = command(env);

  env.workspace.activeFile = task;
  assert.equal(cmd.checkCallback(true), true);
  assert.deepEqual(env.opened, [], "checking does not open anything");
  cmd.checkCallback(false);
  assert.deepEqual(env.opened, [{ linktext: project.path, sourcePath: task.path, newLeaf: false }]);

  env.workspace.activeFile = env.addNote("Заметка.md", { tags: ["x"] });
  assert.equal(cmd.checkCallback(true), false, "no project");
  env.workspace.activeFile = project;
  assert.equal(cmd.checkCallback(true), false, "project note itself");
  env.workspace.activeFile = env.addNote("templates/task.md", { project: "%%project%%" });
  assert.equal(cmd.checkCallback(true), false, "template");
  env.workspace.activeFile = null;
  assert.equal(cmd.checkCallback(true), false, "nothing open");
});

test("command: a project without a note gives a hint, several projects - a choice", async () => {
  const env = setup();
  const obsidian = env.addNote("Obsidian.md", { project: "Obsidian" });
  const trino = env.addNote("Проекты/Trino.md", { project: "Проекты/Trino" });
  env.module.load();
  const cmd = command(env);

  env.workspace.activeFile = env.addNote("Одна.md", { project: "Без заметки" });
  assert.equal(cmd.checkCallback(true), true);
  cmd.checkCallback(false);
  assert.deepEqual(Notice.messages, ["У проекта «Без заметки» нет заметки. Создать её - команда «Создать проект»."]);
  assert.deepEqual(env.opened, []);

  const task = env.addNote("Две.md", { project: ["Obsidian", "Проекты/Trino", "Без заметки"] });
  env.workspace.activeFile = task;
  cmd.checkCallback(false);
  const modal = Modal.opened[0] as SuggestModal<any>;
  assert.ok(modal, "choice window is open");
  assert.deepEqual((await modal.getSuggestions("")).map((p: any) => p.file), [obsidian, trino]);
  assert.deepEqual((await modal.getSuggestions("трин")).length, 0);
  assert.deepEqual((await modal.getSuggestions("TRI")).map((p: any) => p.file), [trino]);
  const row = document.createElement("div");
  modal.renderSuggestion({ name: "Trino", file: trino }, row);
  assert.equal(row.textContent, "TrinoПроекты/Trino", "name and the note path");
  await (modal as any).choose(1);
  assert.deepEqual(env.opened, [{ linktext: trino.path, sourcePath: task.path, newLeaf: false }]);
});
