import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  AbstractInputSuggest,
  MarkdownRenderer,
  MockEvents,
  Modal,
  Notice,
  TFile,
  createMockProcessorContext,
} from "obsidian";
import { InboxModule } from "../src/modules/InboxModule";
import { TrashModule } from "../src/modules/TrashModule";
import { isInboxSubmitKey } from "../src/ui/InboxComposer";
import { renderLinkOption } from "../src/ui/InboxLinkField";

// ---------------------------------------------------------------------------
// Окружение: jsdom + DOM-хелперы Obsidian (createEl/createDiv/empty/addClass…)
// ---------------------------------------------------------------------------

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.org/", pretendToBeVisual: true });
const { window } = dom;
const document = window.document;
(globalThis as any).window = window;
(globalThis as any).document = document;
(globalThis as any).Node = window.Node;
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).localStorage = window.localStorage;
(globalThis as any).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);

type CreateOpts = { text?: string; cls?: string; attr?: Record<string, string> } | string;

const proto = window.HTMLElement.prototype as any;
proto.createEl = function (tag: string, opts?: CreateOpts) {
  const el = document.createElement(tag);
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
proto.hasClass = function (cls: string) {
  return this.classList.contains(cls);
};
proto.setText = function (text: string) {
  this.textContent = text;
};

/** Мини-markdown: абзацы, переносы строк, [[ссылки]] и ![[картинки]] - как их рисует Obsidian. */
(MarkdownRenderer as any).render = async (_app: unknown, markdown: string, el: HTMLElement) => {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    escape(s)
      .replace(/!\[\[([^\]]+)\]\]/g, '<span class="internal-embed image-embed"><img src="$1"></span>')
      .replace(/\[\[([^\]]+)\]\]/g, '<a class="internal-link" data-href="$1" href="$1">$1</a>');
  el.innerHTML = markdown
    .split(/\n{2,}/)
    .map((para) => `<div class="el-p"><p>${para.split("\n").map(inline).join("<br>")}</p></div>`)
    .join("");
};

// ---------------------------------------------------------------------------
// Плагин и хранилище
// ---------------------------------------------------------------------------

function setup(initial: Record<string, unknown> = {}) {
  Notice.messages.length = 0;
  Modal.opened = [];
  AbstractInputSuggest.instances = [];
  window.localStorage.clear();
  const storage = { data: structuredClone({ inbox: [], inboxMigrated: true, ...initial }) as any, saves: 0 };

  const files = new Map<string, TFile>();
  const contents = new Map<string, string>();
  const vault = new MockEvents() as any;
  vault.getAbstractFileByPath = (path: string) => files.get(path) ?? null;
  vault.cachedRead = async (file: TFile) => contents.get(file.path) ?? "";
  vault.process = async (file: TFile, fn: (content: string) => string) => {
    const next = fn(contents.get(file.path) ?? "");
    contents.set(file.path, next);
    return next;
  };
  const binaries: Array<{ path: string; size: number }> = [];
  vault.createBinary = async (path: string, data: ArrayBuffer) => {
    binaries.push({ path, size: data.byteLength });
    const file = new TFile(path);
    files.set(path, file);
    return file;
  };

  const caches = new Map<string, any>();
  vault.getMarkdownFiles = () => [...files.values()].filter((file) => file.extension === "md");
  const metadataCache = {
    getFileCache: (file: TFile) => caches.get(file.path) ?? null,
    // Как в Obsidian: по пути без .md или по имени заметки
    getFirstLinkpathDest: (link: string) => {
      const target = link.replace(/\.md$/i, "").toLowerCase();
      const name = target.split("/").pop();
      const md = vault.getMarkdownFiles() as TFile[];
      return (
        md.find((file) => file.path.replace(/\.md$/i, "").toLowerCase() === target) ??
        md.find((file) => file.basename.toLowerCase() === name) ??
        null
      );
    },
  };

  const workspace = new MockEvents() as any;
  workspace.getActiveViewOfType = () => null;
  workspace.activeEditor = null;
  // Как в Obsidian: колбэк вызывается, когда хранилище готово (в тестах - вручную, runLayoutReady)
  const layoutReady: Array<() => void> = [];
  workspace.onLayoutReady = (callback: () => void) => layoutReady.push(callback);
  const opened: Array<{ href: string; sourcePath: string; newLeaf: unknown }> = [];
  workspace.openLinkText = async (href: string, sourcePath: string, newLeaf: unknown) => {
    opened.push({ href, sourcePath, newLeaf });
  };

  const app = {
    vault,
    workspace,
    metadataCache,
    fileManager: {
      getAvailablePathForAttachment: async (name: string) => `attachments/${name}`,
      generateMarkdownLink: (file: TFile) => `[[${file.name}]]`,
    },
  };

  const processors: Record<string, (source: string, el: HTMLElement, ctx: any) => void> = {};
  const commands: any[] = [];
  const ribbons: Array<{ icon: string; title: string; cb: () => void; el: HTMLElement }> = [];
  const taskRequests: Array<{ name: string; onSuccess: (file: TFile) => Promise<void>; project?: string }> = [];
  const reminderRequests: string[] = [];
  const plugin: any = {
    settings: {
      enableInbox: true,
      enableReminders: true,
      enableTrash: true,
      enableGamification: false,
      gamificationInboxRewards: { xp: 5, gold: 2 },
    },
    loadData: async () => structuredClone(storage.data),
    saveData: async (data: unknown) => {
      storage.data = structuredClone(data);
      storage.saves++;
    },
    registerEvent: () => undefined,
    registerMarkdownCodeBlockProcessor: (name: string, fn: any) => {
      processors[name] = fn;
    },
    addCommand: (command: any) => commands.push(command),
    addRibbonIcon: (icon: string, title: string, cb: () => void) => {
      const el = document.createElement("div");
      ribbons.push({ icon, title, cb, el });
      return el;
    },
    getGamificationDataPath: () => ".obsidian/plugins/obsidian-project-automation/data.json",
    triggerTrashRefresh: () => undefined,
    refreshGamificationState: async () => undefined,
    openCreateTaskFromInbox: (name: string, onSuccess: (file: TFile) => Promise<void>, project?: string) => {
      taskRequests.push({ name, onSuccess, project });
    },
    projects: [] as string[],
    getProjects: async () => [...plugin.projects].sort(),
    openCreateReminderFromInbox: async (text: string, onSuccess: (r: any) => Promise<void>) => {
      reminderRequests.push(text);
      await onSuccess({ text, date: new Date(2026, 9, 1, 10, 0), recurrence: "" });
    },
  };

  const module = new InboxModule({ app, plugin, taskIndex: null, remindersIndex: null, eventBus: null } as any);
  module.load();
  /** Заметка с frontmatter (задача, проект) или без него (ежедневная). */
  const addNote = (path: string, frontmatter: Record<string, unknown> | null = null, content = "", mtime = Date.now()) => {
    const file = new TFile(path, mtime);
    files.set(path, file);
    contents.set(path, content);
    caches.set(path, frontmatter ? { frontmatter } : {});
    return file;
  };
  return {
    module, plugin, app, storage, processors, commands, ribbons, opened, binaries, files, contents, taskRequests,
    reminderRequests, caches, addNote,
    runLayoutReady: () => layoutReady.splice(0).forEach((callback) => callback()),
  };
}

type Env = ReturnType<typeof setup>;

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function flush(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function mountBlock(env: Env, sourcePath = "Homepage.md"): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  env.processors["opa-inbox-view"]("", el, createMockProcessorContext(sourcePath));
  await waitFor(() => el.querySelector(".inbox-list") != null);
  return el;
}

const composer = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('textarea[data-focus-restore="add-input"]')!;
const rows = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>(".inbox-line"));
const button = (row: HTMLElement, label: string) =>
  Array.from(row.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === label)!;

function key(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function paste(target: HTMLElement, data: { text?: string; files?: unknown[] }): Event {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? data.text ?? "" : ""), files: data.files ?? [], items: [] },
  });
  target.dispatchEvent(event);
  return event;
}

const imageFile = (bytes: number[]) => ({
  type: "image/png",
  arrayBuffer: async () => new Uint8Array(bytes).buffer,
});

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

test("submit key: only Ctrl/Cmd+Enter, never plain Enter and never while composing", () => {
  const base = { key: "Enter", ctrlKey: false, metaKey: false, isComposing: false };
  assert.equal(isInboxSubmitKey(base), false, "Enter is a line break");
  assert.equal(isInboxSubmitKey({ ...base, ctrlKey: true }), true);
  assert.equal(isInboxSubmitKey({ ...base, metaKey: true }), true);
  assert.equal(isInboxSubmitKey({ ...base, ctrlKey: true, isComposing: true }), false);
  assert.equal(isInboxSubmitKey({ ...base, ctrlKey: true, keyCode: 229 }), false);
  assert.equal(isInboxSubmitKey({ ...base, ctrlKey: true, key: "a" }), false);
});

test("block shows entries as markdown with the time they were written; old entries have no time", async () => {
  const env = setup({
    inbox: ["Посмотреть [[Trino ACL]]\nи ответить", "старая запись"],
    inboxCreatedAt: { "Посмотреть [[Trino ACL]]\nи ответить": new Date().toISOString() },
    inboxArchive: [{ text: "см. [[X]]\nвторая строка", completedAt: "2026-09-01T10:00:00.000Z" }],
  });
  const el = await mountBlock(env);
  const [first, second] = rows(el);
  assert.equal(rows(el).length, 2);
  assert.equal(first.querySelector("a.internal-link")?.getAttribute("data-href"), "Trino ACL");
  assert.ok(first.querySelector(".inbox-text br"), "line break is kept");
  assert.match(first.querySelector(".inbox-time")?.textContent ?? "", /^сегодня \d\d:\d\d$/);
  assert.equal(second.querySelector(".inbox-time"), null);
  assert.ok(button(first, "Архив"));
  assert.equal(button(first, "Разобрано"), undefined);
  assert.equal(composer(el).tagName, "TEXTAREA");
  assert.equal(button(el.querySelector<HTMLElement>(".inbox-add-form")!, "Добавить").getAttribute("data-tooltip"), "Ctrl+Enter");
  const archived = el.querySelector(".inbox-archive-list .inbox-text")!;
  assert.equal(archived.querySelector("a.internal-link")?.getAttribute("data-href"), "X", "archive shows markdown too");
  assert.ok(archived.querySelector("br"), "line break is kept in the archive");
  el.remove();
});

test("Enter is a line break, Ctrl+Enter writes a multi-line entry with its time; the field is cleared and keeps focus", async () => {
  const env = setup();
  const el = await mountBlock(env);
  const input = composer(el);
  input.value = "SELECT *\nFROM acl";
  const enter = key(input, { key: "Enter" });
  assert.equal(enter.defaultPrevented, false, "the textarea inserts the line break itself");
  await flush();
  assert.deepEqual(env.storage.data.inbox, []);

  const ctrlEnter = key(input, { key: "Enter", ctrlKey: true });
  assert.equal(ctrlEnter.defaultPrevented, true);
  await waitFor(() => rows(el).length === 1);
  assert.deepEqual(env.storage.data.inbox, ["SELECT *\nFROM acl"]);
  assert.ok(!isNaN(Date.parse(env.storage.data.inboxCreatedAt["SELECT *\nFROM acl"])));
  const fresh = composer(el);
  assert.notEqual(fresh, input, "block was re-rendered");
  assert.equal(fresh.value, "");
  assert.equal(document.activeElement, fresh);
  assert.deepEqual(Notice.messages, [], "no notice for a normal add: the row is visible");
  el.remove();
});

test("a repeat is not added twice: the field is cleared and the notice says it is already there", async () => {
  const env = setup({ inbox: ["позвонить"] });
  const el = await mountBlock(env);
  composer(el).value = "  позвонить ";
  button(el.querySelector<HTMLElement>(".inbox-add-form")!, "Добавить").click();
  await waitFor(() => Notice.messages.includes("Уже есть в блокноте"));
  await waitFor(() => composer(el).value === "");
  assert.deepEqual(env.storage.data.inbox, ["позвонить"]);
  el.remove();
});

test("text typed in the block survives a forced re-render (sync, settings)", async () => {
  const env = setup({ inbox: ["a"] });
  const el = await mountBlock(env);
  const input = composer(el);
  input.value = "черновик";
  input.focus();
  env.module.updateState();
  await waitFor(() => composer(el) !== input);
  assert.equal(composer(el).value, "черновик");
  assert.equal(document.activeElement, composer(el));
  el.remove();
});

test("internal links in entries open like in a note; Ctrl opens a new tab", async () => {
  const env = setup({ inbox: ["см. [[Trino ACL]]"] });
  const el = await mountBlock(env, "Home/Homepage.md");
  const link = el.querySelector<HTMLAnchorElement>("a.internal-link")!;
  link.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  link.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
  assert.deepEqual(env.opened, [
    { href: "Trino ACL", sourcePath: "Home/Homepage.md", newLeaf: false },
    { href: "Trino ACL", sourcePath: "Home/Homepage.md", newLeaf: "tab" },
  ]);
  el.remove();
});

test("«Архив» moves the entry to the archive with both times", async () => {
  const T1 = "2026-09-20T08:00:00.000Z";
  const env = setup({ inbox: ["a", "b"], inboxCreatedAt: { a: T1, b: T1 } });
  const el = await mountBlock(env);
  button(rows(el)[0], "Архив").click();
  await waitFor(() => env.storage.data.inbox.length === 1);
  assert.deepEqual(env.storage.data.inbox, ["b"]);
  assert.deepEqual(env.storage.data.inboxCreatedAt, { b: T1 });
  const archived = env.storage.data.inboxArchive[0];
  assert.equal(archived.text, "a");
  assert.equal(archived.createdAt, T1);
  assert.ok(!isNaN(Date.parse(archived.completedAt)));
  assert.ok(Notice.messages.includes("Запись перемещена в архив"));
  el.remove();
});

test("editing: Enter is a line break, Ctrl+Enter saves and keeps the time, Escape cancels", async () => {
  const T1 = "2026-09-20T08:00:00.000Z";
  const env = setup({ inbox: ["a"], inboxCreatedAt: { a: T1 } });
  const el = await mountBlock(env);
  button(rows(el)[0], "Изменить").click();
  const edit = el.querySelector<HTMLTextAreaElement>("textarea.inbox-edit-input")!;
  assert.equal(edit.value, "a");
  edit.value = "a\nподробности";
  key(edit, { key: "Enter" });
  assert.ok(el.querySelector("textarea.inbox-edit-input"), "Enter keeps editing");
  key(edit, { key: "Enter", ctrlKey: true });
  await waitFor(() => env.storage.data.inbox[0] === "a\nподробности");
  assert.deepEqual(env.storage.data.inboxCreatedAt, { "a\nподробности": T1 });
  await waitFor(() => el.querySelector("textarea.inbox-edit-input") == null && rows(el).length === 1);

  button(rows(el)[0], "Изменить").click();
  const second = el.querySelector<HTMLTextAreaElement>("textarea.inbox-edit-input")!;
  second.value = "zzz";
  key(second, { key: "Escape" });
  await flush();
  assert.equal(el.querySelector("textarea.inbox-edit-input"), null);
  assert.deepEqual(env.storage.data.inbox, ["a\nподробности"]);
  el.remove();
});

test("a re-render waits while an entry is being edited", async () => {
  const env = setup({ inbox: ["a"] });
  const el = await mountBlock(env);
  button(rows(el)[0], "Изменить").click();
  const edit = el.querySelector<HTMLTextAreaElement>("textarea.inbox-edit-input")!;
  edit.value = "a, дописываю";
  env.module.updateState();
  await flush(60);
  assert.equal(el.querySelector("textarea.inbox-edit-input"), edit, "edit field is not wiped");
  key(edit, { key: "Escape" });
  await waitFor(() => el.querySelector("textarea.inbox-edit-input") == null);
  el.remove();
});

test("quick capture: selection is prefilled, «Сохранить» writes it, the window closes", async () => {
  const env = setup();
  const command = env.commands.find((c) => c.id === "inbox-quick-capture");
  assert.equal(command.name, "Запись в блокнот");
  env.app.workspace.activeEditor = { editor: { getSelection: () => "выделенный текст" } };
  assert.equal(command.checkCallback(true), true);
  command.checkCallback(false);
  const modal = Modal.opened[0] as any;
  const textarea = modal.contentEl.querySelector("textarea") as HTMLTextAreaElement;
  assert.equal(textarea.value, "выделенный текст");
  const labels = Array.from(modal.contentEl.querySelectorAll(".opa-quick-capture-buttons button")).map((b: any) => b.textContent);
  assert.equal(modal.titleEl.textContent, "Запись в блокнот");
  assert.deepEqual(labels, ["Отмена", "Сохранить"], "buttons as in the other plugin windows");
  assert.ok(modal.contentEl.querySelector(".opa-quick-capture-buttons"), "buttons sit together on the right (plugin style)");
  assert.equal(modal.contentEl.querySelector(".opa-quick-capture-hint"), null, "no key hint under the field");
  assert.equal(button(modal.contentEl, "Сохранить").getAttribute("data-tooltip"), "Ctrl+Enter", "shortcut in the hover tooltip");
  const hint = modal.contentEl.querySelector(".opa-quick-capture-buttons > .opa-quick-capture-shortcut");
  assert.equal(hint?.textContent, "Ctrl+Enter - сохранить", "visible hint left of the buttons");
  assert.equal(hint?.parentElement?.firstElementChild, hint);
  const enter = key(textarea, { key: "Enter" });
  assert.equal(enter.defaultPrevented, false, "Enter is a line break");
  await flush();
  assert.deepEqual(env.storage.data.inbox, []);
  button(modal.contentEl, "Сохранить").click();
  await waitFor(() => env.storage.data.inbox.length === 1);
  assert.deepEqual(env.storage.data.inbox, ["выделенный текст"]);
  assert.ok(Notice.messages.includes("Записано в блокнот"));
  assert.equal(modal.isOpen, false);
});

test("quick capture: a changed text is kept as a draft, just opening and closing changes nothing", async () => {
  const env = setup();
  const command = env.commands.find((c) => c.id === "inbox-quick-capture");
  const open = () => {
    command.checkCallback(false);
    const modal = Modal.opened[Modal.opened.length - 1] as any;
    return { modal, textarea: modal.contentEl.querySelector("textarea") as HTMLTextAreaElement };
  };

  let { modal, textarea } = open();
  assert.equal(textarea.value, "");
  textarea.value = "мысль";
  modal.close();
  assert.equal(window.localStorage.getItem("opa-inbox-quick-capture-draft"), "мысль");

  ({ modal, textarea } = open());
  assert.equal(textarea.value, "мысль");
  modal.close();
  assert.equal(window.localStorage.getItem("opa-inbox-quick-capture-draft"), "мысль");

  env.app.workspace.activeEditor = { editor: { getSelection: () => "цитата" } };
  ({ modal, textarea } = open());
  assert.equal(textarea.value, "мысль\nцитата");
  modal.close();
  assert.equal(window.localStorage.getItem("opa-inbox-quick-capture-draft"), "мысль", "selection alone is not saved");

  env.app.workspace.activeEditor = null;
  ({ modal, textarea } = open());
  textarea.value = "";
  modal.close();
  assert.equal(window.localStorage.getItem("opa-inbox-quick-capture-draft"), null);
  assert.deepEqual(env.storage.data.inbox, []);
});

test("quick capture: Ctrl+Enter through the window hotkey and the field saves only once", async () => {
  const env = setup();
  env.commands.find((c) => c.id === "inbox-quick-capture").checkCallback(false);
  const modal = Modal.opened[0] as any;
  const textarea = modal.contentEl.querySelector("textarea") as HTMLTextAreaElement;
  textarea.value = "одна запись";
  const handler = modal.scope.handlers.find((h: any) => h.key === "Enter" && h.modifiers?.includes("Mod"));
  assert.ok(handler, "Mod+Enter is registered on the window scope");
  handler.func({ isComposing: false, preventDefault: () => undefined });
  key(textarea, { key: "Enter", ctrlKey: true });
  await waitFor(() => env.storage.data.inbox.length === 1);
  await flush();
  assert.equal(env.storage.saves, 1);
});

test("quick capture is unavailable and the ribbon icon hidden while the notepad is off", () => {
  const env = setup();
  const command = env.commands.find((c) => c.id === "inbox-quick-capture");
  assert.equal(env.ribbons[0].title, "Запись в блокнот");
  env.plugin.settings.enableInbox = false;
  env.module.updateState();
  assert.equal(command.checkCallback(true), false);
  assert.equal(env.ribbons[0].el.style.display, "none");
  env.plugin.settings.enableInbox = true;
  env.module.updateState();
  assert.equal(env.ribbons[0].el.style.display, "");
});

test("a pasted screenshot is saved as an attachment and linked in the field; text paste is left alone", async () => {
  const env = setup();
  const el = await mountBlock(env);
  const input = composer(el);
  input.value = "Ошибка: ";
  input.setSelectionRange(input.value.length, input.value.length);
  const event = paste(input, { files: [imageFile([1, 2, 3])] });
  assert.equal(event.defaultPrevented, true);
  await waitFor(() => input.value.includes("![["));
  assert.match(input.value, /^Ошибка: !\[\[Pasted image \d{14}\.png\]\]$/);
  assert.equal(env.binaries.length, 1);
  assert.match(env.binaries[0].path, /^attachments\/Pasted image \d{14}\.png$/);
  assert.equal(env.binaries[0].size, 3);

  const withText = paste(input, { text: "ячейка из Excel", files: [imageFile([9])] });
  assert.equal(withText.defaultPrevented, false, "text wins: Excel and Word put both text and a picture");
  el.remove();
});

test("task from a multi-line entry: title from the first line, the rest goes to the description", async () => {
  const env = setup({ inbox: ["Разобраться с ACL\nтикет ABC-1\nпозвонить Y"] });
  const el = await mountBlock(env);
  button(rows(el)[0], "Задача").click();
  assert.equal(env.taskRequests.length, 1);
  assert.equal(env.taskRequests[0].name, "Разобраться с ACL");
  assert.equal(env.storage.data.inbox.length, 1, "entry stays until the task exists");

  const file = new TFile("Разобраться с ACL.md");
  env.files.set(file.path, file);
  env.contents.set(file.path, "---\nstatus: В работе\n---\n## Описание задачи\n\n## Критерий выполнения\n");
  await env.taskRequests[0].onSuccess(file);
  assert.equal(
    env.contents.get(file.path),
    "---\nstatus: В работе\n---\n## Описание задачи\nтикет ABC-1\nпозвонить Y\n\n## Критерий выполнения\n"
  );
  assert.deepEqual(env.storage.data.inbox, []);
  el.remove();
});

test("reminder from a multi-line entry gets a single line", async () => {
  const env = setup({ inbox: ["Позвонить Y\nпо поводу доступа"] });
  const el = await mountBlock(env);
  button(rows(el)[0], "Напоминание").click();
  await waitFor(() => env.storage.data.inbox.length === 0);
  assert.deepEqual(env.reminderRequests, ["Позвонить Y по поводу доступа"]);
  assert.equal(env.storage.data.reminders.length, 1);
  assert.match(env.storage.data.reminders[0], /^- \[ \] Позвонить Y по поводу доступа \(@/);
  el.remove();
});

test("task from an entry whose first line is a link: the whole entry goes to the description", async () => {
  const env = setup({ inbox: ["https://jira.example.com/browse/ABC-123\nпочинить логин"] });
  const el = await mountBlock(env);
  button(rows(el)[0], "Задача").click();
  assert.equal(env.taskRequests[0].name, "httpsjira.example.combrowseABC-123");
  const file = new TFile("ABC-123.md");
  env.files.set(file.path, file);
  env.contents.set(file.path, "## Описание задачи\n");
  await env.taskRequests[0].onSuccess(file);
  assert.equal(env.contents.get(file.path), "## Описание задачи\nhttps://jira.example.com/browse/ABC-123\nпочинить логин\n");
  assert.deepEqual(env.storage.data.inbox, []);
  el.remove();
});

function slowAttachments(env: Env, ms = 60): void {
  const original = env.app.vault.createBinary;
  env.app.vault.createBinary = async (path: string, data: ArrayBuffer) => {
    await flush(ms);
    return original(path, data);
  };
}

test("quick capture: Ctrl+Enter right after pasting a screenshot waits for the picture link", async () => {
  const env = setup();
  slowAttachments(env);
  env.commands.find((c) => c.id === "inbox-quick-capture").checkCallback(false);
  const modal = Modal.opened[0] as any;
  const textarea = modal.contentEl.querySelector("textarea") as HTMLTextAreaElement;
  textarea.value = "Ошибка:";
  textarea.setSelectionRange(7, 7);
  paste(textarea, { files: [imageFile([1])] });
  key(textarea, { key: "Enter", ctrlKey: true });
  await waitFor(() => env.storage.data.inbox.length === 1);
  assert.match(env.storage.data.inbox[0], /^Ошибка:!\[\[Pasted image \d{14}\.png\]\]$/);
  assert.equal(modal.isOpen, false);
});

test("quick capture: closing while a screenshot is saved keeps its link in the draft", async () => {
  const env = setup();
  slowAttachments(env);
  env.commands.find((c) => c.id === "inbox-quick-capture").checkCallback(false);
  const modal = Modal.opened[0] as any;
  const textarea = modal.contentEl.querySelector("textarea") as HTMLTextAreaElement;
  paste(textarea, { files: [imageFile([1])] });
  modal.close();
  await waitFor(() => (window.localStorage.getItem("opa-inbox-quick-capture-draft") ?? "").startsWith("![[Pasted image"));
});

test("block: Ctrl+Enter right after pasting a screenshot waits for the picture link", async () => {
  const env = setup();
  slowAttachments(env);
  const el = await mountBlock(env);
  const input = composer(el);
  paste(input, { files: [imageFile([1, 2])] });
  key(input, { key: "Enter", ctrlKey: true });
  await waitFor(() => env.storage.data.inbox.length === 1);
  assert.match(env.storage.data.inbox[0], /^!\[\[Pasted image \d{14}\.png\]\]$/);
  el.remove();
});

test("an edit saved on blur does not wipe the next edit in progress", async () => {
  const env = setup({ inbox: ["a", "b"] });
  const el = await mountBlock(env);
  button(rows(el)[0], "Изменить").click();
  const editA = rows(el)[0].querySelector<HTMLTextAreaElement>("textarea.inbox-edit-input")!;
  editA.value = "a2";
  button(rows(el)[1], "Изменить").click();
  editA.dispatchEvent(new window.Event("blur"));
  const editB = rows(el)[1].querySelector<HTMLTextAreaElement>("textarea.inbox-edit-input")!;
  editB.value = "b, дописываю";
  await waitFor(() => env.storage.data.inbox[0] === "a2");
  await flush(60);
  assert.equal(el.querySelector("textarea.inbox-edit-input"), editB, "B is still being edited");
  assert.equal(editB.value, "b, дописываю");
  key(editB, { key: "Enter", ctrlKey: true });
  await waitFor(() => env.storage.data.inbox[1] === "b, дописываю");
  await waitFor(() => el.querySelector("textarea.inbox-edit-input") == null && rows(el).length === 2);
  assert.equal(rows(el)[0].getAttribute("data-original-text"), "a2");
  el.remove();
});

test("Escape while an IME is composing does not cancel the edit", async () => {
  const env = setup({ inbox: ["a"] });
  const el = await mountBlock(env);
  button(rows(el)[0], "Изменить").click();
  const edit = el.querySelector<HTMLTextAreaElement>("textarea.inbox-edit-input")!;
  key(edit, { key: "Escape", isComposing: true });
  key(edit, { key: "Enter", ctrlKey: true, isComposing: true });
  assert.equal(el.querySelector("textarea.inbox-edit-input"), edit);
  key(edit, { key: "Escape" });
  await flush();
  assert.equal(el.querySelector("textarea.inbox-edit-input"), null);
  el.remove();
});

test("the notepad block inside an entry is not rendered (no endless nesting)", () => {
  const env = setup();
  const entryText = document.createElement("div");
  entryText.className = "inbox-text";
  const el = entryText.appendChild(document.createElement("div"));
  env.processors["opa-inbox-view"]("", el, createMockProcessorContext("Homepage.md"));
  assert.equal(el.textContent, "Блокнот не показывается внутри записи блокнота");
  assert.equal(el.classList.contains("opa-inbox-view"), false);
});

test("quick capture takes the reading-view selection, not a stale selection of the hidden editor", () => {
  const env = setup();
  const command = env.commands.find((c) => c.id === "inbox-quick-capture");
  const openText = () => {
    command.checkCallback(false);
    const modal = Modal.opened[Modal.opened.length - 1] as any;
    const value = (modal.contentEl.querySelector("textarea") as HTMLTextAreaElement).value;
    modal.close();
    return value;
  };
  const selection = window.getSelection()!;
  const select = (node: Node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const para = document.body.appendChild(document.createElement("p"));
  para.textContent = "текст из режима чтения";
  select(para);
  env.app.workspace.activeEditor = { getMode: () => "preview", editor: { getSelection: () => "старое выделение" } };
  assert.equal(openText(), "текст из режима чтения");

  const cm = document.body.appendChild(document.createElement("div"));
  cm.className = "cm-editor";
  const line = cm.appendChild(document.createElement("div"));
  line.textContent = "видимая часть";
  select(line);
  env.app.workspace.activeEditor = { getMode: () => "source", editor: { getSelection: () => "всё выделение редактора" } };
  assert.equal(openText(), "всё выделение редактора");

  selection.removeAllRanges();
  env.app.workspace.activeEditor = { getMode: () => "preview", editor: { getSelection: () => "старое выделение" } };
  assert.equal(openText(), "");
  para.remove();
  cm.remove();
});

test("quick capture draft belongs to the vault", () => {
  const env = setup();
  const command = env.commands.find((c) => c.id === "inbox-quick-capture");
  const vaultStore = new Map<string, unknown>();
  (env.app as any).loadLocalStorage = (k: string) => vaultStore.get(k) ?? null;
  (env.app as any).saveLocalStorage = (k: string, v: unknown) => {
    if (v == null) vaultStore.delete(k);
    else vaultStore.set(k, v);
  };
  command.checkCallback(false);
  let modal = Modal.opened[Modal.opened.length - 1] as any;
  (modal.contentEl.querySelector("textarea") as HTMLTextAreaElement).value = "черновик";
  modal.close();
  assert.equal(vaultStore.get("opa-inbox-quick-capture-draft"), "черновик");
  assert.equal(window.localStorage.getItem("opa-inbox-quick-capture-draft"), null);
  command.checkCallback(false);
  modal = Modal.opened[Modal.opened.length - 1] as any;
  assert.equal((modal.contentEl.querySelector("textarea") as HTMLTextAreaElement).value, "черновик");
  modal.close();

  // Obsidian старше 1.8.7: localStorage с именем хранилища в ключе
  delete (env.app as any).loadLocalStorage;
  delete (env.app as any).saveLocalStorage;
  env.app.vault.getName = () => "Work";
  command.checkCallback(false);
  modal = Modal.opened[Modal.opened.length - 1] as any;
  (modal.contentEl.querySelector("textarea") as HTMLTextAreaElement).value = "рабочий черновик";
  modal.close();
  assert.equal(window.localStorage.getItem("opa-inbox-quick-capture-draft:Work"), "рабочий черновик");
});

test("archive shows pictures; only the latest 20 entries at first, earlier ones on request", async () => {
  const archive = Array.from({ length: 25 }, (_, i) => ({ text: `запись ${i}`, completedAt: `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00.000Z` }));
  archive[24] = { text: "тест\n![[Pasted image 20260929101500.png]]", completedAt: "2026-09-29T10:15:00.000Z" };
  const env = setup({ inbox: [], inboxArchive: archive });
  const el = await mountBlock(env);
  const archiveRows = () => Array.from(el.querySelectorAll<HTMLElement>(".inbox-archive-line"));
  const text = (row: HTMLElement) => row.querySelector(".inbox-text")?.textContent ?? "";
  assert.equal(archiveRows().length, 20);
  assert.equal(text(archiveRows()[0]), "запись 5", "the latest 20, in order");
  const img = archiveRows()[19].querySelector("img");
  assert.equal(img?.getAttribute("src"), "Pasted image 20260929101500.png", "the screenshot is shown, not its link");
  const more = el.querySelector<HTMLButtonElement>(".inbox-archive-more")!;
  assert.equal(more.textContent, "Показать более ранние (5)");
  more.click();
  await waitFor(() => archiveRows().length === 25);
  assert.equal(text(archiveRows()[0]), "запись 0");
  assert.equal(text(archiveRows()[5]), "запись 5");
  assert.equal(el.querySelector(".inbox-archive-more"), null);

  const before = composer(el);
  env.module.updateState();
  await waitFor(() => composer(el) !== before);
  assert.equal(archiveRows().length, 25, "after a re-render the whole archive stays open");
  el.remove();
});

function loadTrash(env: Env): TrashModule {
  const trash = new TrashModule({ app: env.app, plugin: env.plugin, taskIndex: null, remindersIndex: null, eventBus: null } as any);
  trash.load();
  return trash;
}

async function mountTrash(env: Env, sourcePath = "Homepage.md"): Promise<HTMLElement> {
  loadTrash(env);
  const el = document.createElement("div");
  document.body.appendChild(el);
  env.processors["opa-trash-view"]("", el, createMockProcessorContext(sourcePath));
  await waitFor(() => el.querySelector(".trash-toolbar") != null);
  return el;
}

test("trash: notepad entries show pictures and links, deleted reminders stay plain lines", async () => {
  const env = setup({
    trash: [
      "тест\n![[Pasted image 20260929093958.png]]",
      "- [ ] мавмвам (@29-09-2026 10:51)",
      "- [ ] купить **2** [[X]] (@30-09-2026) (every 1 week)",
      "[Выполнено] разобрано: [[Trino ACL]]",
      "- первый пункт\n- второй пункт",
    ],
  });
  const el = await mountTrash(env, "Home/Homepage.md");
  const items = Array.from(el.querySelectorAll<HTMLElement>(".trash-item"));
  const text = (item: HTMLElement) => item.querySelector(".trash-item-text")!;
  assert.equal(items.length, 5);

  assert.equal(items[0].querySelector("img")?.getAttribute("src"), "Pasted image 20260929093958.png", "screenshot, not its link");

  assert.equal(text(items[1]).textContent, "мавмвам (@29-09-2026 10:51)", "reminder looks as before");
  assert.equal(text(items[1]).classList.contains("inbox-text"), false);
  assert.equal(text(items[2]).textContent, "купить **2** [[X]] (@30-09-2026) (every 1 week)", "reminder text is not markdown");
  assert.equal(items[2].querySelector("a"), null);

  assert.equal(items[3].querySelector(".trash-item-badge")?.textContent, "Из архива");
  assert.doesNotMatch(text(items[3]).textContent ?? "", /Выполнено/);
  const link = items[3].querySelector<HTMLAnchorElement>("a.internal-link")!;
  assert.equal(link.getAttribute("data-href"), "Trino ACL");
  link.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.deepEqual(env.opened, [{ href: "Trino ACL", sourcePath: "Home/Homepage.md", newLeaf: false }]);

  assert.match(text(items[4]).textContent ?? "", /^- первый пункт/, "the first list item keeps its marker");
  assert.equal(el.querySelector(".inbox-meta"), null, "entries deleted before this version have no time or link");
  el.remove();
});

test("trash: a deleted entry shows when it was written and what it was linked to; «Очистить» forgets that too", async () => {
  const now = new Date().toISOString();
  const env = setup({
    inbox: ["тест", "без привязки"],
    inboxCreatedAt: { тест: now },
    inboxLinks: { тест: { task: "Trino ACL.md" } },
    inboxArchive: [{ text: "разобрано", completedAt: DAY_T, createdAt: DAY_T, link: { project: "Spark" } }],
  });
  env.addNote("Trino ACL.md", { status: "В работе", project: "Trino" });
  const block = await mountBlock(env);
  button(rows(block)[0], "Удалить").click();
  await waitFor(() => env.storage.data.inbox.length === 1);
  button(rows(block)[0], "Удалить").click();
  await waitFor(() => env.storage.data.inbox.length === 0);
  assert.deepEqual(env.storage.data.trash, ["тест", "без привязки"]);
  assert.deepEqual(env.storage.data.trashMeta, { тест: { createdAt: now, link: { task: "Trino ACL.md" } } });
  assert.deepEqual(env.storage.data.inboxLinks, {});

  // Из архива: «Из архива», время записи и привязка
  await waitFor(() => block.querySelector(".inbox-archive-list .inbox-archive-line") != null);
  block.querySelector<HTMLButtonElement>(".inbox-archive-line button")!.click();
  await waitFor(() => env.storage.data.inboxArchive.length === 0);
  assert.deepEqual(env.storage.data.trashMeta["[Выполнено] разобрано"], { createdAt: DAY_T, link: { project: "Spark" } });
  block.remove();

  const el = await mountTrash(env);
  const items = Array.from(el.querySelectorAll<HTMLElement>(".trash-item"));
  assert.equal(items.length, 3);
  const meta = items[0].querySelector(".trash-item-entry .inbox-meta")!;
  assert.match(meta.querySelector(".inbox-time")?.textContent ?? "", /^сегодня \d\d:\d\d$/);
  assert.equal(meta.querySelector(".inbox-link")?.textContent, "Trino ACL · Trino");
  assert.equal(meta.querySelector<HTMLAnchorElement>("a.inbox-link-task")?.getAttribute("data-href"), "Trino ACL");
  assert.equal(items[1].querySelector(".inbox-meta"), null, "an entry without time and link has no line under it");
  assert.equal(items[2].querySelector(".trash-item-badge")?.textContent, "Из архива");
  assert.match(items[2].querySelector(".inbox-meta")?.textContent ?? "", /^01\.10(\.2026)? 09:30Spark$/);

  el.querySelector<HTMLButtonElement>(".trash-clear-button")!.click();
  await waitFor(() => env.storage.data.trash.length === 0);
  assert.deepEqual(env.storage.data.trashMeta, {});
  el.remove();
});

test("the trash block inside a notepad entry is not rendered (no endless nesting)", () => {
  const env = setup();
  loadTrash(env);
  const entryText = document.createElement("div");
  entryText.className = "inbox-text";
  const el = entryText.appendChild(document.createElement("div"));
  env.processors["opa-trash-view"]("", el, createMockProcessorContext("Homepage.md"));
  assert.equal(el.textContent, "Корзина не показывается внутри записи блокнота");
  assert.equal(el.classList.contains("opa-trash-view"), false);
});

// ---------------------------------------------------------------------------
// «Относится к»: привязка записи к задаче или проекту
// ---------------------------------------------------------------------------

test("list items show the task status and project; a project says «проект»", () => {
  const el = document.createElement("div");
  renderLinkOption(
    { kind: "task", path: "A.md", name: "A", projects: ["Проекты/Trino"], lastActivity: 0, status: "В работе" },
    el
  );
  assert.equal(el.querySelector(".suggestion-title")?.textContent, "A");
  assert.equal(el.querySelector(".suggestion-note")?.textContent, "⚙️ В работе · Trino");
  assert.equal(el.querySelector(".opa-link-status")?.textContent, "⚙️ В работе");
  const done = document.createElement("div");
  renderLinkOption({ kind: "task", path: "B.md", name: "B", projects: [], lastActivity: 0, status: "Готово" }, done);
  assert.equal(done.querySelector(".suggestion-note")?.textContent, "☑️ Готово");
  const project = document.createElement("div");
  renderLinkOption({ kind: "project", project: "Trino", name: "Trino" }, project);
  assert.equal(project.querySelector(".suggestion-note")?.textContent, "проект");
  const bare = document.createElement("div");
  renderLinkOption({ kind: "task", path: "C.md", name: "C", projects: [], lastActivity: 0, status: "" }, bare);
  assert.equal(bare.querySelector(".suggestion-note"), null);
});

/** Открыть окно «Запись в блокнот»: поле текста, строка «Относится к», её поле и подсказки. */
function openCapture(env: Env) {
  env.commands.find((c) => c.id === "inbox-quick-capture").checkCallback(false);
  const modal = Modal.opened[Modal.opened.length - 1] as any;
  const field = modal.contentEl.querySelector(".opa-inbox-link-field") as HTMLElement;
  return {
    modal,
    textarea: modal.contentEl.querySelector("textarea") as HTMLTextAreaElement,
    field,
    input: field?.querySelector("input") as HTMLInputElement,
    suggest: AbstractInputSuggest.instances[AbstractInputSuggest.instances.length - 1] as any,
  };
}

/** Открытая в редакторе заметка с курсором на строке line. */
function editorAt(file: TFile, content: string, line: number, mode = "source") {
  return {
    file,
    getMode: () => mode,
    editor: { getSelection: () => "", getValue: () => content, getCursor: () => ({ line, ch: 0 }) },
  };
}

function input(el: HTMLElement): void {
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

const DAY_T = new Date(2026, 9, 1, 9, 30).toISOString();

test("quick capture: «Относится к» starts with the open task; saving keeps the entry linked to it", async () => {
  const env = setup();
  const task = env.addNote("Trino ACL.md", { status: "В работе", project: "Trino" }, "", 1000);
  env.addNote("Свежая.md", { status: "В работе" }, "", 9000);
  env.app.workspace.activeEditor = editorAt(task, "---\nstatus: В работе\n---\n## Описание задачи\n", 3);
  const { modal, textarea, field, input: linkInput, suggest } = openCapture(env);
  assert.ok(field, "the field is right in the window");
  assert.equal(field.previousElementSibling, textarea, "right under the text: Tab goes there");
  assert.equal(field.querySelector("label")?.textContent, "Относится к");
  const control = field.querySelector(".opa-inbox-link-control")!;
  assert.equal(linkInput.parentElement, control, "the input fills the row up to the right edge");
  assert.equal(field.querySelector(".opa-inbox-link-clear")?.parentElement, control, "the cross sits inside the field");
  assert.equal(linkInput.value, "Trino ACL · Trino");
  assert.ok(field.classList.contains("has-link"));
  // Tab в поле: весь список, привязка первой - Enter её подтверждает, а не меняет на другую
  linkInput.focus();
  assert.deepEqual((await suggest.refresh()).map((o: any) => o.name), ["Trino ACL", "Trino", "Свежая"]);
  linkInput.blur();
  textarea.value = "проверить SA";
  button(modal.contentEl, "Сохранить").click();
  await waitFor(() => env.storage.data.inbox.length === 1);
  assert.deepEqual(env.storage.data.inboxLinks, { "проверить SA": { task: "Trino ACL.md" } });
  assert.ok(Notice.messages.includes("Записано в блокнот: Trino ACL · Trino"));
  assert.equal(modal.isOpen, false);
});

test("quick capture: under ### [[Task]] of a daily note the field takes that task; the choice is not remembered", async () => {
  const env = setup();
  env.addNote("Trino ACL.md", { status: "В работе", project: "Trino" });
  env.addNote("Другая.md", { status: "В работе" });
  const daily = [
    "← [[periodic/daily/30-09-2026.md|30-09-2026]]  |  [[periodic/daily/02-10-2026.md|02-10-2026]] →",
    "### [[Trino ACL]]",
    "#### Образ",
    "собрал образ",
    "### [[Другая]]",
    "текст",
  ].join("\n");
  const dailyFile = env.addNote("periodic/daily/01-10-2026.md", null, daily);

  env.app.workspace.activeEditor = editorAt(dailyFile, daily, 3);
  let capture = openCapture(env);
  assert.equal(capture.input.value, "Trino ACL · Trino", "a sub-heading inside the task section counts");
  capture.modal.close();

  env.app.workspace.activeEditor = editorAt(dailyFile, daily, 5);
  capture = openCapture(env);
  assert.equal(capture.input.value, "Другая");
  // Крестик убирает привязку: запись сохраняется без неё
  (capture.field.querySelector(".opa-inbox-link-clear") as HTMLButtonElement).click();
  assert.equal(capture.input.value, "");
  assert.ok(!capture.field.classList.contains("has-link"));
  capture.textarea.value = "без привязки";
  button(capture.modal.contentEl, "Сохранить").click();
  await waitFor(() => env.storage.data.inbox.length === 1);
  assert.deepEqual(env.storage.data.inboxLinks ?? {}, {});
  assert.ok(Notice.messages.includes("Записано в блокнот"));

  // Стёр подпись и сразу Ctrl+Enter, не выходя из поля - тоже без привязки
  env.app.workspace.activeEditor = editorAt(dailyFile, daily, 3);
  capture = openCapture(env);
  capture.textarea.value = "стёр привязку";
  capture.input.value = "";
  input(capture.input);
  key(capture.input, { key: "Enter", ctrlKey: true });
  await waitFor(() => env.storage.data.inbox.length === 2);
  assert.deepEqual(env.storage.data.inboxLinks ?? {}, {});

  env.app.workspace.activeEditor = editorAt(dailyFile, daily, 0);
  capture = openCapture(env);
  assert.equal(capture.input.value, "", "above the task headings nothing is linked");
  capture.modal.close();
  env.app.workspace.activeEditor = editorAt(dailyFile, daily, 3, "preview");
  capture = openCapture(env);
  assert.equal(capture.input.value, "", "reading view has no cursor: no guess");
  capture.modal.close();
});

test("quick capture: the list has all projects on top, then all tasks by status; a typed text without a pick changes nothing", async () => {
  const env = setup();
  env.addNote("Старая.md", { status: "В работе", project: "Trino" }, "", 1000);
  env.addNote("Свежая.md", { status: "Backlog", project: "Spark" }, "", 5000);
  env.addNote("Сделанная.md", { status: "Готово", project: "Trino" }, "", 9000);
  env.addNote("Trino.md", { project: "Trino" }); // страница проекта - не задача
  env.plugin.projects = ["Проекты/Trino", "Spark"];
  const { modal, textarea, input: linkInput, suggest } = openCapture(env);
  assert.equal(linkInput.value, "");

  linkInput.focus();
  const all = await suggest.refresh();
  assert.deepEqual(
    all.map((o: any) => `${o.kind}:${o.name}:${o.kind === "task" ? o.status : ""}`),
    ["project:Trino:", "project:Spark:", "task:Старая:В работе", "task:Свежая:Backlog", "task:Сделанная:Готово"],
    "projects first (the one with work in progress on top), then every task: in progress first, done last"
  );

  linkInput.value = "трино";
  assert.deepEqual(await suggest.refresh(), [], "no such words");
  linkInput.value = "trino";
  const found = await suggest.refresh();
  assert.deepEqual(found.map((o: any) => o.name), ["Trino", "Старая", "Сделанная"], "the project first, then its tasks by status");

  // Набрал, но не выбрал - привязка прежняя (пустая)
  linkInput.blur();
  assert.equal(linkInput.value, "");

  suggest.selectSuggestion(found[0]);
  assert.equal(linkInput.value, "Trino");
  assert.equal(suggest.isOpen, false);
  textarea.value = "идея по проекту";
  // Ctrl+Enter в поле «Относится к» тоже сохраняет - и при открытом списке (через его область клавиш), только раз
  const listHotkey = suggest.scope.handlers.find((h: any) => h.key === "Enter" && h.modifiers?.includes("Mod"));
  assert.ok(listHotkey, "Mod+Enter is registered on the open list too");
  listHotkey.func({ isComposing: false, preventDefault: () => undefined });
  key(linkInput, { key: "Enter", ctrlKey: true });
  await waitFor(() => env.storage.data.inbox.length === 1);
  await flush();
  assert.equal(env.storage.saves, 1);
  assert.deepEqual(env.storage.data.inboxLinks, { "идея по проекту": { project: "Проекты/Trino" } });
  assert.equal(modal.isOpen, false);
});

test("an entry shows when it was written and what it is linked to; a deleted task is crossed out", async () => {
  const env = setup({
    inbox: ["a", "b", "c"],
    inboxCreatedAt: { a: new Date().toISOString() },
    inboxLinks: { a: { task: "Trino ACL.md" }, b: { task: "Удалённая.md" }, c: { project: "Проекты/Spark" } },
  });
  env.addNote("Trino ACL.md", { status: "В работе", project: ["Trino", "Проекты/Spark"] });
  env.addNote("Trino.md", { project: "Trino" });
  const el = await mountBlock(env);
  const [a, b, c] = rows(el);

  const meta = a.querySelector(".inbox-meta")!;
  assert.match(meta.querySelector(".inbox-time")?.textContent ?? "", /^сегодня \d\d:\d\d$/);
  const links = Array.from(meta.querySelectorAll<HTMLAnchorElement>(".inbox-link a.internal-link"));
  assert.deepEqual(
    links.map((l) => [l.textContent, l.getAttribute("data-href")]),
    [["Trino ACL", "Trino ACL"], ["Trino", "Trino"]],
    "a project without a note is plain text, not a link that would create a note"
  );
  assert.equal(meta.querySelector(".inbox-link")?.textContent, "Trino ACL · Trino · Spark");

  assert.equal(b.querySelector(".inbox-time"), null, "old entry has no time");
  const gone = b.querySelector(".inbox-link.is-unresolved .inbox-link-task")!;
  assert.equal(gone.textContent, "Удалённая");
  assert.equal(gone.getAttribute("title"), "Заметка задачи не найдена");
  assert.equal(b.querySelector(".inbox-link a"), null);

  assert.equal(c.querySelector(".inbox-link")?.textContent, "Spark");

  // Клик по задаче открывает её, как ссылку в заметке
  links[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.deepEqual(env.opened.map((o) => o.href), ["Trino ACL"]);
  el.remove();
});

test("«Задача» from a linked entry opens the form with the project of the link", async () => {
  const env = setup({
    inbox: ["по задаче", "по проекту", "без привязки"],
    inboxLinks: { "по задаче": { task: "Trino ACL.md" }, "по проекту": { project: "[[Проекты/Spark]]" } },
  });
  env.addNote("Trino ACL.md", { status: "В работе", project: ["Trino", "Проекты/Spark"] });
  const el = await mountBlock(env);
  for (const row of rows(el)) button(row, "Задача").click();
  assert.deepEqual(
    env.taskRequests.map((r) => [r.name, r.project]),
    [["по задаче", "Trino, Проекты/Spark"], ["по проекту", "Проекты/Spark"], ["без привязки", undefined]]
  );
  el.remove();
});

test("a renamed task takes its links along; an edit keeps the link", async () => {
  const env = setup({
    inbox: ["a"],
    inboxLinks: { a: { task: "Старое имя.md" } },
    inboxArchive: [{ text: "x", completedAt: DAY_T, link: { task: "Старое имя.md" } }],
  });
  const savesBefore = env.storage.saves;
  env.app.vault.emit("rename", new TFile("Не задача.md"), "Совсем другое.md");
  env.app.vault.emit("rename", new TFile("Папка"), "Старая папка");
  await flush(400);
  assert.equal(env.storage.saves, savesBefore, "renames of unrelated notes do not touch data.json");

  // Переименовали дважды подряд (A→B, B→C): привязка идёт до конца, data.json пишется один раз
  env.addNote("Новое имя.md", { status: "В работе" });
  env.app.vault.emit("rename", new TFile("Промежуточное.md"), "Старое имя.md");
  env.app.vault.emit("rename", env.files.get("Новое имя.md"), "Промежуточное.md");
  await waitFor(() => env.storage.data.inboxLinks.a.task === "Новое имя.md");
  assert.deepEqual(env.storage.data.inboxArchive[0].link, { task: "Новое имя.md" });
  assert.equal(env.storage.saves, savesBefore + 1);

  const el = await mountBlock(env);
  button(rows(el)[0], "Изменить").click();
  const edit = el.querySelector<HTMLTextAreaElement>("textarea.inbox-edit-input")!;
  edit.value = "a и подробности";
  key(edit, { key: "Enter", ctrlKey: true });
  await waitFor(() => env.storage.data.inbox[0] === "a и подробности");
  assert.deepEqual(env.storage.data.inboxLinks, { "a и подробности": { task: "Новое имя.md" } });
  el.remove();
});

test("a repeat captured with a link gives it to the entry that had none, and keeps someone else's", async () => {
  const env = setup({ inbox: ["позвонить", "написать"], inboxLinks: { написать: { project: "Spark" } } });
  env.addNote("Задача.md", { status: "В работе" });
  env.app.workspace.activeEditor = editorAt(env.files.get("Задача.md")!, "", 0);
  for (const text of ["позвонить", "написать"]) {
    const { modal, textarea } = openCapture(env);
    textarea.value = text;
    button(modal.contentEl, "Сохранить").click();
    await waitFor(() => !modal.isOpen);
  }
  assert.deepEqual(env.storage.data.inbox, ["позвонить", "написать"]);
  assert.deepEqual(env.storage.data.inboxLinks, { написать: { project: "Spark" }, позвонить: { task: "Задача.md" } });
  assert.equal(Notice.messages.filter((m) => m === "Уже есть в блокноте").length, 2);
});

// ---------------------------------------------------------------------------
// Группы записей с одной привязкой
// ---------------------------------------------------------------------------

const DAY2_T = new Date(2026, 9, 2, 11, 0).toISOString();

test("entries with one link are grouped under a header; singles keep their own label", async () => {
  const now = new Date().toISOString();
  const env = setup({
    inbox: ["вамавмавм", "одна", "ntncblvdfgdgvfd"],
    inboxCreatedAt: { вамавмавм: now, одна: now, ntncblvdfgdgvfd: now },
    inboxLinks: { вамавмавм: { task: "OPA.md" }, одна: { project: "Spark" }, ntncblvdfgdgvfd: { task: "OPA.md" } },
  });
  env.addNote("OPA.md", { status: "В работе", project: "Obsidian" });
  env.addNote("Obsidian.md", { project: "Obsidian" });
  const el = await mountBlock(env);
  const list = el.querySelector(".inbox-list")!;
  const children = Array.from(list.children);
  assert.deepEqual(children.map((c) => c.className), ["inbox-group", "inbox-line view-list-row"], "the group stands where its first entry was");

  const group = children[0] as HTMLElement;
  const header = group.querySelector(".inbox-group-header")!;
  assert.equal(header.querySelector(".inbox-link")?.textContent, "OPA · Obsidian");
  const count = header.querySelector(".inbox-group-count")!;
  assert.equal(count.textContent, "2");
  assert.equal(count.getAttribute("title"), "2 записи");
  assert.equal(header.querySelector("button"), null, "a group has no buttons of its own");
  const grouped = Array.from(group.querySelectorAll<HTMLElement>(".inbox-group-list .inbox-line"));
  assert.deepEqual(grouped.map((r) => r.getAttribute("data-original-text")), ["вамавмавм", "ntncblvdfgdgvfd"]);
  for (const row of grouped) {
    assert.match(row.querySelector(".inbox-time")?.textContent ?? "", /^сегодня /);
    assert.equal(row.querySelector(".inbox-link"), null, "the label is not repeated under grouped entries");
    assert.deepEqual(
      Array.from(row.querySelectorAll(".inbox-actions button")).map((b) => b.textContent),
      ["Архив", "Задача", "Изменить", "Напоминание", "Удалить"],
      "each entry keeps its own buttons"
    );
  }
  assert.equal((children[1] as HTMLElement).querySelector(".inbox-link")?.textContent, "Spark");
  el.remove();
});

// ---------------------------------------------------------------------------
// Блок «Блокнот» в начале заметки-задачи
// ---------------------------------------------------------------------------

async function mountTaskBlock(env: Env, taskPath: string): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  env.processors["opa-task-inbox"]("", el, createMockProcessorContext(taskPath));
  await waitFor(() => el.querySelector(".inbox-list") != null || el.classList.contains("opa-hidden"));
  return el;
}

/** Считать записи заметок через vault.process. */
function countWrites(env: Env): { count: number } {
  const counter = { count: 0 };
  const process = env.app.vault.process;
  env.app.vault.process = async (file: TFile, fn: (content: string) => string) => {
    counter.count++;
    return process(file, fn);
  };
  return counter;
}

const blockTitle = (el: HTMLElement) => el.querySelector(".opa-section-title")?.textContent;

test("task note block: only this task's entries, with their time and buttons to sort them out right there", async () => {
  const env = setup({
    inbox: ["первая", "чужая", "без привязки", "вторая\nс деталями"],
    inboxCreatedAt: { первая: DAY_T, "вторая\nс деталями": DAY2_T },
    inboxLinks: {
      первая: { task: "OPA.md" },
      чужая: { task: "Другая.md" },
      // Задачу перенесли, а привязка ещё со старым путём: запись находится по имени заметки
      "вторая\nс деталями": { task: "Старая папка/OPA.md" },
    },
  });
  env.plugin.settings.enableGamification = true;
  env.addNote("OPA.md", { status: "В работе", project: "Obsidian" });
  env.addNote("Другая.md", { status: "В работе" });
  const el = await mountTaskBlock(env, "OPA.md");

  assert.equal(blockTitle(el), "Блокнот (2)");
  assert.deepEqual(rows(el).map((r) => r.getAttribute("data-original-text")), ["первая", "вторая\nс деталями"]);
  for (const row of rows(el)) {
    assert.deepEqual(
      Array.from(row.querySelectorAll(".inbox-actions button")).map((b) => b.textContent),
      ["Архив", "Изменить", "Удалить"]
    );
    assert.equal(row.querySelector(".inbox-link"), null, "the task itself is not repeated under its entries");
  }
  assert.match(rows(el)[0].querySelector(".inbox-time")?.textContent ?? "", /^01\.10(\.2026)? 09:30$/);

  // «Архив» - как в блокноте: с привязкой и наградой; блок перерисовывается
  button(rows(el)[0], "Архив").click();
  await waitFor(() => blockTitle(el) === "Блокнот (1)");
  assert.deepEqual(env.storage.data.inbox, ["чужая", "без привязки", "вторая\nс деталями"]);
  assert.deepEqual(env.storage.data.inboxArchive[0].link, { task: "OPA.md" });
  assert.equal(env.storage.data.gamification.xp, 5);

  // «Изменить»: привязка остаётся (с нынешним путём задачи), запись остаётся в задаче
  button(rows(el)[0], "Изменить").click();
  const edit = el.querySelector<HTMLTextAreaElement>("textarea.inbox-edit-input")!;
  assert.equal(el.querySelector<HTMLInputElement>(".inbox-edit .opa-inbox-link-input")?.value, "OPA · Obsidian");
  edit.value = "вторая, уточнённая";
  key(edit, { key: "Enter", ctrlKey: true });
  await waitFor(() => el.querySelector(".inbox-text")?.textContent?.includes("уточнённая") === true);
  assert.deepEqual(env.storage.data.inboxLinks["вторая, уточнённая"], { task: "OPA.md" });
  assert.equal(blockTitle(el), "Блокнот (1)");

  // Последняя запись разобрана - блока не видно
  button(rows(el)[0], "Удалить").click();
  await waitFor(() => el.classList.contains("opa-hidden"));
  assert.equal(el.childElementCount, 0);
  assert.deepEqual(env.storage.data.inbox, ["чужая", "без привязки"]);
  el.remove();
});

test("task note block is hidden when nothing is linked to the task and while the notepad is off", async () => {
  const env = setup({ inbox: ["чужая"], inboxLinks: { чужая: { task: "Другая.md" } } });
  env.addNote("OPA.md", { status: "В работе" });
  env.addNote("Другая.md", { status: "В работе" });
  const empty = await mountTaskBlock(env, "OPA.md");
  assert.ok(empty.classList.contains("opa-hidden"));
  assert.equal(empty.childElementCount, 0);

  const other = await mountTaskBlock(env, "Другая.md");
  assert.equal(rows(other).length, 1);
  env.plugin.settings.enableInbox = false;
  env.module.updateState();
  await waitFor(() => other.classList.contains("opa-hidden"));
  assert.equal(other.childElementCount, 0);
  empty.remove();
  other.remove();
});

test("task note block keeps its entries when the open task is renamed", async () => {
  const env = setup({ inbox: ["мысль"], inboxLinks: { мысль: { task: "Старое имя.md" } } });
  env.addNote("Старое имя.md", { status: "В работе" });
  const el = await mountTaskBlock(env, "Старое имя.md");
  assert.equal(rows(el).length, 1);

  // Заметку переименовали; открытая заметка не перерисовывается, блок остаётся тем же
  env.files.delete("Старое имя.md");
  const renamed = env.addNote("Новое имя.md", { status: "В работе" });
  env.app.vault.emit("rename", renamed, "Старое имя.md");
  await waitFor(() => env.storage.data.inboxLinks.мысль.task === "Новое имя.md");
  await flush(100);
  assert.equal(el.classList.contains("opa-hidden"), false);
  assert.deepEqual(rows(el).map((r) => r.getAttribute("data-original-text")), ["мысль"]);
  el.remove();
});

test("task note block inside a notepad entry is not rendered (an embedded task would show itself again)", async () => {
  const env = setup({ inbox: ["см. ![[OPA]]"], inboxLinks: { "см. ![[OPA]]": { task: "OPA.md" } } });
  env.addNote("OPA.md", { status: "В работе" });
  const entryText = document.createElement("div");
  entryText.className = "inbox-text";
  const el = entryText.appendChild(document.createElement("div"));
  env.processors["opa-task-inbox"]("", el, createMockProcessorContext("OPA.md"));
  assert.equal(el.textContent, "Блокнот не показывается внутри записи блокнота");
  assert.equal(el.classList.contains("opa-task-inbox"), false);

  // Обработчик вызван до того, как блок встал в запись: проверка повторяется после загрузки данных
  const late = document.createElement("div");
  document.body.appendChild(late);
  env.processors["opa-task-inbox"]("", late, createMockProcessorContext("OPA.md"));
  const host = document.createElement("div");
  host.className = "inbox-text";
  document.body.appendChild(host);
  host.appendChild(late);
  await waitFor(() => late.textContent === "Блокнот не показывается внутри записи блокнота");
  assert.equal(late.querySelector(".inbox-line"), null);
  host.remove();
});

test("quick capture linked to a task puts the notepad block before the task view of the task note, once", async () => {
  const env = setup();
  const content = "---\nstatus: В работе\n---\n## Описание задачи\n\n```opa-task-view\n```\n";
  const task = env.addNote("Trino ACL.md", { status: "В работе" }, content);
  env.addNote("Spark.md", { project: "Spark" }, "---\nproject: Spark\n---\n");
  const writes = countWrites(env);
  env.app.workspace.activeEditor = editorAt(task, content, 3);
  for (const text of ["первая мысль", "вторая мысль"]) {
    const { modal, textarea } = openCapture(env);
    textarea.value = text;
    button(modal.contentEl, "Сохранить").click();
    await waitFor(() => !modal.isOpen);
  }
  await waitFor(() => writes.count > 0);
  await flush();
  assert.equal(
    env.contents.get("Trino ACL.md"),
    "---\nstatus: В работе\n---\n## Описание задачи\n\n```opa-task-inbox\n```\n\n```opa-task-view\n```\n"
  );
  assert.equal(writes.count, 1, "the note is written once");

  // Запись без привязки заметок не трогает
  env.app.workspace.activeEditor = null;
  const { modal, textarea } = openCapture(env);
  textarea.value = "просто мысль";
  button(modal.contentEl, "Сохранить").click();
  await waitFor(() => !modal.isOpen);
  await flush();
  assert.equal(env.storage.data.inbox.length, 3);
  assert.equal(writes.count, 1);
});

test("at start-up, tasks linked earlier get the block; other notes are not touched", async () => {
  const fm = "---\nstatus: В работе\n---\n";
  const withBlock = `${fm}## Описание задачи\n\n\`\`\`opa-task-inbox\n\`\`\`\n`;
  const env = setup({
    inbox: ["a", "b", "c", "d"],
    inboxLinks: {
      a: { task: "Trino ACL.md" },
      b: { task: "С блоком.md" },
      c: { project: "Spark" },
      d: { task: "Trino ACL.md" },
      // Привязка записи, которой в блокноте уже нет
      разобрана: { task: "Разобранная.md" },
    },
  });
  env.addNote("Trino ACL.md", { status: "В работе" }, `${fm}текст\n`);
  env.addNote("С блоком.md", { status: "В работе" }, withBlock);
  env.addNote("Разобранная.md", { status: "Готово" }, `${fm}текст\n`);
  const writes = countWrites(env);
  env.runLayoutReady();
  await waitFor(() => writes.count > 0);
  await flush();
  // Блока задачи в заметке нет - «Блокнот» в конце
  assert.equal(env.contents.get("Trino ACL.md"), `${fm}текст\n\n\`\`\`opa-task-inbox\n\`\`\`\n`);
  assert.equal(env.contents.get("С блоком.md"), withBlock);
  assert.equal(env.contents.get("Разобранная.md"), `${fm}текст\n`);
  assert.equal(writes.count, 1);

  // Блокнот выключен - заметки не трогаются
  const off = setup({ inbox: ["a"], inboxLinks: { a: { task: "Trino ACL.md" } } });
  off.addNote("Trino ACL.md", { status: "В работе" }, `${fm}текст\n`);
  off.plugin.settings.enableInbox = false;
  off.runLayoutReady();
  await flush();
  assert.equal(off.contents.get("Trino ACL.md"), `${fm}текст\n`);
});

test("start-up moves the block the previous version put at the start of a task, once", async () => {
  const fm = "---\nstatus: В работе\n---\n";
  const view = "```opa-task-view\n```\n";
  const block = "```opa-task-inbox\n```\n";
  const top = `${fm}${block}\n## Описание задачи\n\n${view}`;
  const moved = `${fm}## Описание задачи\n\n${block}\n${view}`;
  const elsewhere = `${fm}## Описание задачи\n\n${block}\nтекст\n\n${view}`;
  const env = setup({
    inbox: ["a", "b"],
    inboxLinks: { a: { task: "Задача.md" }, b: { task: "Другая.md" } },
    inboxArchive: [{ text: "x", completedAt: DAY_T, link: { task: "Разобранная.md" } }],
  });
  env.addNote("Задача.md", { status: "В работе" }, top);
  env.addNote("Разобранная.md", { status: "Готово" }, top);
  // Блок, который поставили руками не в начало, остаётся на месте
  env.addNote("Другая.md", { status: "В работе" }, elsewhere);
  // Привязок нет, но заметка начинается с блока кода (по кэшу заметок)
  env.addNote("Без привязок.md", { status: "В работе" }, top);
  env.caches.set("Без привязок.md", {
    frontmatter: { status: "В работе" },
    sections: [{ type: "yaml" }, { type: "code" }, { type: "heading" }, { type: "code" }],
  });
  env.runLayoutReady();
  await waitFor(() => env.contents.get("Без привязок.md") === moved);
  await flush();
  assert.equal(env.contents.get("Задача.md"), moved);
  assert.equal(env.contents.get("Разобранная.md"), moved);
  assert.equal(env.contents.get("Другая.md"), elsewhere);

  // Следующий запуск: блок, который потом поставили в начало руками, там и остаётся
  env.contents.set("Задача.md", top);
  const again = new InboxModule({ app: env.app, plugin: env.plugin, taskIndex: null, remindersIndex: null, eventBus: null } as any);
  again.load();
  env.runLayoutReady();
  await flush(100);
  assert.equal(env.contents.get("Задача.md"), top);
});

// ---------------------------------------------------------------------------
// «Относится к» под полем ввода блокнота и при «Изменить»
// ---------------------------------------------------------------------------

/** Поле «Относится к» под полем ввода блока и его список. */
function composerLink(el: HTMLElement) {
  const field = el.querySelector<HTMLElement>(".inbox-add-form .opa-inbox-link-field")!;
  const input = field.querySelector<HTMLInputElement>("input")!;
  const suggest = AbstractInputSuggest.instances.find((s) => s.inputEl === input) as any;
  return { field, input, suggest };
}

/** Поле «Относится к» открытой правки записи и его список. */
function editLink(el: HTMLElement) {
  const wrap = el.querySelector<HTMLElement>(".inbox-edit")!;
  const input = wrap.querySelector<HTMLInputElement>(".opa-inbox-link-field input")!;
  const suggest = AbstractInputSuggest.instances.find((s) => s.inputEl === input) as any;
  return { wrap, text: wrap.querySelector<HTMLTextAreaElement>("textarea")!, input, suggest };
}

test("homepage notepad: «Относится к» under the input binds the new entry, the task gets the block, the field is cleared", async () => {
  const env = setup();
  const content = "---\nstatus: В работе\n---\n## Описание задачи\n\n```opa-task-view\n```\n";
  env.addNote("Trino ACL.md", { status: "В работе", project: "Trino" }, content);
  let projectLoads = 0;
  const getProjects = env.plugin.getProjects;
  env.plugin.getProjects = async () => {
    projectLoads++;
    return getProjects();
  };
  const el = await mountBlock(env);
  const form = el.querySelector<HTMLElement>(".inbox-add-form")!;
  assert.ok(form.classList.contains("has-link-field"));
  const kinds = Array.from(form.children).map((c) =>
    c.tagName === "TEXTAREA" ? "text" : c.classList.contains("opa-inbox-link-field") ? "link" : c.tagName.toLowerCase()
  );
  assert.deepEqual(kinds, ["text", "link", "button"], "Tab from the text goes to the link field");
  const { field, input: linkInput, suggest } = composerLink(el);
  assert.equal(field.querySelector("label")?.textContent, "Относится к");
  assert.equal(linkInput.value, "", "no context on the homepage: the field starts empty");
  await flush();
  assert.equal(projectLoads, 0, "the list is not loaded until the field is used");

  linkInput.focus();
  linkInput.value = "acl";
  const found = await suggest.refresh();
  assert.equal(projectLoads, 1);
  suggest.selectSuggestion(found.find((o: any) => o.name === "Trino ACL"));
  assert.equal(linkInput.value, "Trino ACL · Trino");
  composer(el).value = "проверить SA";
  key(composer(el), { key: "Enter", ctrlKey: true });
  await waitFor(() => env.storage.data.inbox.length === 1);
  assert.deepEqual(env.storage.data.inboxLinks, { "проверить SA": { task: "Trino ACL.md" } });
  await waitFor(() => env.contents.get("Trino ACL.md")!.includes("opa-task-inbox"));
  assert.equal(
    env.contents.get("Trino ACL.md"),
    "---\nstatus: В работе\n---\n## Описание задачи\n\n```opa-task-inbox\n```\n\n```opa-task-view\n```\n"
  );
  await waitFor(() => rows(el).length === 1);
  assert.equal(rows(el)[0].querySelector(".inbox-link")?.textContent, "Trino ACL · Trino");
  assert.equal(composerLink(el).input.value, "", "the link is not kept for the next entry");
  assert.equal(composer(el).value, "");

  // Ctrl+Enter прямо в поле привязки тоже записывает; после записи фокус - снова в поле текста
  composer(el).value = "ещё мысль";
  const next = composerLink(el);
  next.input.focus();
  key(next.input, { key: "Enter", ctrlKey: true });
  await waitFor(() => rows(el).length === 2);
  assert.deepEqual(env.storage.data.inbox, ["проверить SA", "ещё мысль"]);
  assert.equal(document.activeElement, composer(el));
  el.remove();
});

test("homepage notepad: a chosen link survives a re-render of the block", async () => {
  const env = setup({ inbox: ["старая"] });
  env.addNote("Trino ACL.md", { status: "В работе", project: "Trino" });
  const el = await mountBlock(env);
  const first = composerLink(el);
  first.input.focus();
  first.input.value = "acl";
  first.suggest.selectSuggestion((await first.suggest.refresh())[0]);
  first.input.blur();
  composer(el).value = "новая";

  // Блок перерисовался (запись пришла с другого устройства): поле привязки новое, выбор тот же
  env.storage.data.inbox = ["старая", "чужая"];
  env.module.forceRefresh();
  await waitFor(() => rows(el).length === 2);
  const second = composerLink(el);
  assert.notEqual(second.input, first.input);
  assert.equal(second.input.value, "Trino ACL · Trino");
  assert.equal(composer(el).value, "новая");
  button(el.querySelector<HTMLElement>(".inbox-add-form")!, "Добавить").click();
  await waitFor(() => env.storage.data.inbox.length === 3);
  assert.deepEqual(env.storage.data.inboxLinks, { новая: { task: "Trino ACL.md" } });
  el.remove();
});

test("«Изменить»: the link can be set and removed; moving between the text and the link does not save", async () => {
  const env = setup({ inbox: ["мысль"] });
  const content = "---\nstatus: В работе\n---\n```opa-task-view\n```\n";
  env.addNote("Trino ACL.md", { status: "В работе", project: "Trino" }, content);
  const el = await mountBlock(env);

  button(rows(el)[0], "Изменить").click();
  const first = editLink(el);
  assert.equal(first.input.value, "", "an entry without a link: the field is empty");
  assert.equal(document.activeElement, first.text);
  // Из текста в поле привязки (Tab, клик) - правка не сохраняется и не закрывается
  first.input.focus();
  await flush();
  assert.ok(rows(el)[0].classList.contains("is-editing"));
  first.input.value = "acl";
  first.suggest.selectSuggestion((await first.suggest.refresh())[0]);
  first.text.focus();
  await flush();
  assert.ok(rows(el)[0].classList.contains("is-editing"));
  assert.equal(env.storage.data.inboxLinks, undefined);
  key(first.input, { key: "Enter", ctrlKey: true });
  await waitFor(() => env.storage.data.inboxLinks?.["мысль"] != null);
  assert.deepEqual(env.storage.data.inboxLinks, { мысль: { task: "Trino ACL.md" } });
  assert.ok(Notice.messages.includes("Запись обновлена"));
  await waitFor(() => env.contents.get("Trino ACL.md")!.includes("opa-task-inbox"), 1000);
  await waitFor(() => rows(el)[0]?.querySelector(".inbox-link")?.textContent === "Trino ACL · Trino");

  // Снова «Изменить»: в поле - привязка; крестик её убирает, клик вне правки сохраняет
  button(rows(el)[0], "Изменить").click();
  const second = editLink(el);
  assert.equal(second.input.value, "Trino ACL · Trino");
  second.wrap.querySelector<HTMLButtonElement>(".opa-inbox-link-clear")!.click();
  second.text.blur();
  await waitFor(() => env.storage.data.inboxLinks?.["мысль"] == null);
  assert.deepEqual(env.storage.data.inboxLinks, {});
  assert.deepEqual(env.storage.data.inbox, ["мысль"]);
  el.remove();
});

test("«Изменить»: Escape in the link field closes the list first, then cancels the edit", async () => {
  const env = setup({ inbox: ["мысль"], inboxLinks: { мысль: { project: "Spark" } } });
  const el = await mountBlock(env);
  button(rows(el)[0], "Изменить").click();
  const { text, input, suggest } = editLink(el);
  assert.equal(input.value, "Spark");
  text.value = "мысль с правкой";
  input.focus();
  suggest.open();
  key(input, { key: "Escape" });
  assert.ok(rows(el)[0].classList.contains("is-editing"), "the open list takes Escape");
  suggest.close();
  key(input, { key: "Escape" });
  assert.equal(el.querySelector(".inbox-edit"), null);
  await flush();
  assert.deepEqual(env.storage.data.inbox, ["мысль"], "nothing is saved");
  assert.deepEqual(env.storage.data.inboxLinks, { мысль: { project: "Spark" } });
  el.remove();
});

// ---------------------------------------------------------------------------
// Блок «Блокнот» в заметке проекта
// ---------------------------------------------------------------------------

async function mountProjectBlock(env: Env, notePath: string): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  env.processors["opa-project-inbox"]("", el, createMockProcessorContext(notePath));
  await waitFor(() => el.querySelector(".inbox-list") != null || el.classList.contains("opa-hidden"));
  return el;
}

test("project note block: the project's own entries, «Задача» opens the form with this project", async () => {
  const env = setup({
    inbox: ["идея для trino", "про задачу spark", "про spark", "ещё идея"],
    inboxCreatedAt: { "идея для trino": DAY_T },
    inboxLinks: {
      "идея для trino": { project: "Проекты/Trino" },
      "про задачу spark": { task: "Spark SQL.md" },
      "про spark": { project: "Spark" },
      "ещё идея": { project: "trino" },
    },
  });
  env.addNote("Проекты/Trino.md", { project: "Trino" });
  env.addNote("Spark SQL.md", { status: "В работе", project: "Spark" });
  env.addNote("Kafka.md", { project: "Kafka" });
  const el = await mountProjectBlock(env, "Проекты/Trino.md");
  assert.ok(el.classList.contains("opa-note-inbox"));
  assert.equal(blockTitle(el), "Блокнот (2)");
  assert.deepEqual(
    rows(el).map((r) => r.getAttribute("data-original-text")),
    ["идея для trino", "ещё идея"],
    "with and without the folder, in any case; another project and its tasks are not here"
  );
  for (const row of rows(el)) {
    assert.deepEqual(
      Array.from(row.querySelectorAll(".inbox-actions button")).map((b) => b.textContent),
      ["Архив", "Задача", "Изменить", "Удалить"]
    );
    assert.equal(row.querySelector(".inbox-link"), null, "the project itself is not repeated under its entries");
  }

  button(rows(el)[0], "Задача").click();
  assert.deepEqual(env.taskRequests.map((r) => [r.name, r.project]), [["идея для trino", "Проекты/Trino"]]);
  const created = env.addNote("идея для trino.md", { status: "В работе", project: "Trino" });
  await env.taskRequests[0].onSuccess(created);
  await waitFor(() => blockTitle(el) === "Блокнот (1)");
  assert.deepEqual(env.storage.data.inbox, ["про задачу spark", "про spark", "ещё идея"]);
  el.remove();

  const empty = await mountProjectBlock(env, "Kafka.md");
  assert.ok(empty.classList.contains("opa-hidden"), "a project without entries shows nothing");
  empty.remove();
});

test("project note block: entries of the project's tasks too, each with its task; two of one task are a group", async () => {
  const now = new Date().toISOString();
  const env = setup({
    inbox: ["идея", "права на raw", "чужая", "коннектор", "роль etl", "общая", "пропавшая", "без привязки"],
    inboxCreatedAt: { идея: now, "права на raw": now, коннектор: now, "роль etl": now, общая: now },
    inboxLinks: {
      идея: { project: "Trino" },
      "права на raw": { task: "Trino ACL.md" },
      чужая: { task: "Spark SQL.md" },
      коннектор: { task: "Задачи/Trino SA.md" },
      "роль etl": { task: "Trino ACL.md" },
      // Задача двух проектов - видна в обоих
      общая: { task: "Миграция.md" },
      // Заметки задачи нет: проект задачи не узнать, запись видна только в блокноте
      пропавшая: { task: "Удалённая.md" },
    },
  });
  env.addNote("Проекты/Trino.md", { project: "Trino" });
  env.addNote("Trino ACL.md", { status: "В работе", project: "Trino" });
  env.addNote("Задачи/Trino SA.md", { status: "Готово", project: "[[Проекты/Trino]]" });
  env.addNote("Spark SQL.md", { status: "В работе", project: "Spark" });
  env.addNote("Миграция.md", { status: "В работе", project: ["Spark", "Проекты/Trino"] });
  const el = await mountProjectBlock(env, "Проекты/Trino.md");
  assert.equal(blockTitle(el), "Блокнот (5)", "own entries and entries of the project's tasks");

  // По порядку блокнота; две записи Trino ACL - группой на месте первой из них
  const list = el.querySelector(".inbox-list")!;
  const children = Array.from(list.children) as HTMLElement[];
  assert.deepEqual(children.map((c) => c.className), [
    "inbox-line view-list-row",
    "inbox-group",
    "inbox-line view-list-row",
    "inbox-line view-list-row",
  ]);
  const [own, group, single, shared] = children;
  assert.equal(own.getAttribute("data-original-text"), "идея");
  assert.match(own.querySelector(".inbox-time")?.textContent ?? "", /^сегодня /);
  assert.equal(own.querySelector(".inbox-link"), null, "the project's own entry has no label: the project is clear");

  const header = group.querySelector(".inbox-group-header")!;
  assert.equal(header.querySelector(".inbox-link")?.textContent, "Trino ACL", "the task only, without the project");
  assert.equal(header.querySelector("a.internal-link")?.getAttribute("data-href"), "Trino ACL");
  assert.equal(header.querySelector(".inbox-group-count")?.textContent, "2");
  const grouped = Array.from(group.querySelectorAll<HTMLElement>(".inbox-group-list .inbox-line"));
  assert.deepEqual(grouped.map((r) => r.getAttribute("data-original-text")), ["права на raw", "роль etl"]);
  for (const row of grouped) assert.equal(row.querySelector(".inbox-link"), null, "the task is in the group header");

  // Одиночная запись задачи - задача в подписи рядом со временем, ссылкой на её заметку
  assert.equal(single.getAttribute("data-original-text"), "коннектор");
  const meta = single.querySelector(".inbox-meta")!;
  assert.match(meta.querySelector(".inbox-time")?.textContent ?? "", /^сегодня /);
  const taskLink = meta.querySelector<HTMLAnchorElement>(".inbox-link a.internal-link.inbox-link-task")!;
  assert.equal(taskLink.textContent, "Trino SA");
  assert.equal(taskLink.getAttribute("data-href"), "Задачи/Trino SA");
  assert.equal(meta.querySelector(".inbox-link")?.textContent, "Trino SA");
  assert.equal(shared.querySelector(".inbox-link")?.textContent, "Миграция", "a task of two projects shows in both");

  // Кнопки - как у записей проекта; клик по задаче открывает её заметку
  for (const row of rows(el)) {
    assert.deepEqual(
      Array.from(row.querySelectorAll(".inbox-actions button")).map((b) => b.textContent),
      ["Архив", "Задача", "Изменить", "Удалить"]
    );
  }
  taskLink.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.deepEqual(env.opened.map((o) => o.href), ["Задачи/Trino SA"]);
  // «Задача» из записи задачи - с проектом этой задачи, как в блокноте
  button(single, "Задача").click();
  assert.deepEqual(env.taskRequests.map((r) => [r.name, r.project]), [["коннектор", "Проекты/Trino"]]);

  // «Архив» записи из группы: в архиве она остаётся записью задачи; вторая запись задачи - уже одна, с подписью
  button(grouped[1], "Архив").click();
  await waitFor(() => blockTitle(el) === "Блокнот (4)");
  assert.deepEqual(env.storage.data.inboxArchive.map((a: any) => [a.text, a.link]), [["роль etl", { task: "Trino ACL.md" }]]);
  assert.equal(el.querySelector(".inbox-group"), null);
  const left = rows(el).find((r) => r.getAttribute("data-original-text") === "права на raw")!;
  assert.equal(left.querySelector(".inbox-link")?.textContent, "Trino ACL");
  el.remove();

  // В блоке самой задачи - по-прежнему только её записи, без подписи
  const taskBlock = await mountTaskBlock(env, "Trino ACL.md");
  assert.deepEqual(rows(taskBlock).map((r) => r.getAttribute("data-original-text")), ["права на raw"]);
  assert.equal(taskBlock.querySelector(".inbox-link"), null);
  taskBlock.remove();
});

test("project note block follows the task's project: entries go with a task moved to another project", async () => {
  const env = setup({ inbox: ["мысль"], inboxLinks: { мысль: { task: "Trino ACL.md" } } });
  env.addNote("Проекты/Trino.md", { project: "Trino" });
  env.addNote("Trino ACL.md", { status: "В работе", project: "Trino" });
  const el = await mountProjectBlock(env, "Проекты/Trino.md");
  assert.equal(rows(el).length, 1);

  // Проект задачи сменили в её заметке: data.json тот же, блок обновляется при переходе во вкладку проекта
  env.caches.set("Trino ACL.md", { frontmatter: { status: "В работе", project: "Spark" } });
  env.app.workspace.emit("active-leaf-change");
  await waitFor(() => el.classList.contains("opa-hidden"));
  assert.equal(el.childElementCount, 0);

  env.caches.set("Trino ACL.md", { frontmatter: { status: "В работе", project: ["Spark", "trino"] } });
  env.app.workspace.emit("active-leaf-change");
  await waitFor(() => rows(el).length === 1);
  assert.equal(rows(el)[0].querySelector(".inbox-link")?.textContent, "Trino ACL");
  el.remove();
});

test("an entry linked to a task puts the block into the task and into the note of its project, once each", async () => {
  const env = setup();
  const taskContent = "---\nstatus: В работе\nproject: Trino\n---\n## Описание задачи\n\n```opa-task-view\n```\n";
  const task = env.addNote("Trino ACL.md", { status: "В работе", project: ["Trino", "Kafka"] }, taskContent);
  env.addNote("Проекты/Trino.md", { project: "Trino" }, "---\nproject: Trino\n---\n\n```opa-project-view\n```\n");
  const writes = countWrites(env);
  env.app.workspace.activeEditor = editorAt(task, taskContent, 5);
  for (const text of ["первая мысль", "вторая мысль"]) {
    const { modal, textarea } = openCapture(env);
    textarea.value = text;
    button(modal.contentEl, "Сохранить").click();
    await waitFor(() => !modal.isOpen);
  }
  await waitFor(() => writes.count >= 2);
  await flush();
  assert.deepEqual(env.storage.data.inboxLinks, {
    "первая мысль": { task: "Trino ACL.md" },
    "вторая мысль": { task: "Trino ACL.md" },
  });
  assert.equal(
    env.contents.get("Trino ACL.md"),
    "---\nstatus: В работе\nproject: Trino\n---\n## Описание задачи\n\n```opa-task-inbox\n```\n\n```opa-task-view\n```\n"
  );
  assert.equal(
    env.contents.get("Проекты/Trino.md"),
    "---\nproject: Trino\n---\n\n```opa-project-inbox\n```\n\n```opa-project-view\n```\n"
  );
  assert.equal(writes.count, 2, "the task and its project are written once; Kafka has no project note");

  const el = await mountProjectBlock(env, "Проекты/Trino.md");
  assert.equal(blockTitle(el), "Блокнот (2)");
  assert.equal(el.querySelector(".inbox-group-header .inbox-link")?.textContent, "Trino ACL");
  el.remove();
});

test("at start-up, notes of the projects of linked tasks get the block too", async () => {
  const fm = "---\nstatus: В работе\n---\n";
  const env = setup({
    inbox: ["a", "b", "c"],
    inboxLinks: { a: { task: "Trino ACL.md" }, b: { task: "Trino SA.md" }, c: { task: "Без проекта.md" } },
  });
  env.addNote("Trino ACL.md", { status: "В работе", project: "Trino" }, `${fm}текст\n`);
  env.addNote("Trino SA.md", { status: "В работе", project: "[[Проекты/Trino]]" }, `${fm}текст\n`);
  env.addNote("Без проекта.md", { status: "В работе" }, `${fm}текст\n`);
  env.addNote("Проекты/Trino.md", { project: "Trino" }, "---\nproject: Trino\n---\n```opa-project-view\n```\n");
  const writes = countWrites(env);
  env.runLayoutReady();
  await waitFor(() => env.contents.get("Проекты/Trino.md")!.includes("opa-project-inbox"));
  await flush();
  assert.equal(
    env.contents.get("Проекты/Trino.md"),
    "---\nproject: Trino\n---\n\n```opa-project-inbox\n```\n\n```opa-project-view\n```\n"
  );
  assert.equal(writes.count, 4, "three tasks and the project of two of them - each note once");
});

test("binding to a project puts the block before the project's task list; a project without a note gets none", async () => {
  const env = setup();
  const content = "---\nproject: Trino\n---\n\n```opa-project-view\n```\n";
  env.addNote("Проекты/Trino.md", { project: "Trino" }, content);
  env.plugin.projects = ["Проекты/Trino", "Kafka"];
  const writes = countWrites(env);
  const el = await mountBlock(env);
  const capture = async (text: string, name: string): Promise<void> => {
    const { input, suggest } = composerLink(el);
    input.focus();
    input.value = name;
    const found = await suggest.refresh();
    suggest.selectSuggestion(found.find((o: any) => o.kind === "project" && o.name === name));
    composer(el).value = text;
    key(composer(el), { key: "Enter", ctrlKey: true });
    await waitFor(() => env.storage.data.inbox.includes(text));
  };
  await capture("идея", "Trino");
  await waitFor(() => writes.count > 0);
  await flush();
  assert.equal(
    env.contents.get("Проекты/Trino.md"),
    "---\nproject: Trino\n---\n\n```opa-project-inbox\n```\n\n```opa-project-view\n```\n"
  );
  await capture("про kafka", "Kafka");
  await flush();
  assert.deepEqual(env.storage.data.inboxLinks["про kafka"], { project: "Kafka" });
  assert.equal(writes.count, 1, "Kafka has no project note: nothing is written");
  el.remove();
});

test("at start-up, projects linked earlier get the block too", async () => {
  const env = setup({ inbox: ["a", "b"], inboxLinks: { a: { project: "Trino" }, b: { project: "Проекты/Trino" } } });
  env.addNote("Проекты/Trino.md", { project: "Trino" }, "---\nproject: Trino\n---\n```opa-project-view\n```\n");
  const writes = countWrites(env);
  env.runLayoutReady();
  await waitFor(() => writes.count > 0);
  await flush();
  assert.equal(
    env.contents.get("Проекты/Trino.md"),
    "---\nproject: Trino\n---\n\n```opa-project-inbox\n```\n\n```opa-project-view\n```\n"
  );
  assert.equal(writes.count, 1, "two entries of one project - one write");
});
