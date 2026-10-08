import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { MarkdownRenderer, Menu, Notice, TFile, createMockProcessorContext } from "obsidian";
import { EventBus } from "../src/core/EventBus";
import {
  TaskViewModule,
  extractSubHeadings,
  headingMatchesContent,
  keepAnchorOnScreen,
  locateEditCaret,
  planSaveScrollAnchor,
  resolveSaveScrollAnchor,
  taskViewSignature,
} from "../src/modules/TaskViewModule";

// ---------------------------------------------------------------------------
// Окружение: jsdom + минимальные DOM-хелперы Obsidian (createEl/createDiv/empty/addClass…)
// ---------------------------------------------------------------------------

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
const document = window.document;
(globalThis as any).window = window;
(globalThis as any).document = document;
(globalThis as any).Node = window.Node;
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);

type CreateOpts = { text?: string; cls?: string; attr?: Record<string, string>; type?: string; href?: string } | string;

function applyOpts(el: HTMLElement, opts?: CreateOpts): void {
  if (opts == null) return;
  if (typeof opts === "string") {
    el.className = opts;
    return;
  }
  if (opts.cls) el.className = opts.cls;
  if (opts.text != null) el.textContent = opts.text;
  if (opts.type) el.setAttribute("type", opts.type);
  if (opts.href) el.setAttribute("href", opts.href);
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
proto.hasClass = function (cls: string) {
  return this.classList.contains(cls);
};

/** Упрощённый рендер markdown в структуру, похожую на вывод Obsidian (el-* обёртки). */
function miniMarkdown(markdown: string): string {
  const out: string[] = [];
  const lines = markdown.split("\n");
  let i = 0;
  const inline = (text: string): string =>
    text
      .replace(/\*\*\[\[([^\]|]+)\|([^\]]+)\]\]\*\*/g, '<strong><a class="internal-link" data-href="$1" href="$1">$2</a></strong>')
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<a class="internal-link" data-href="$1" href="$1">$2</a>')
      .replace(/\[\[([^\]]+)\]\]/g, '<a class="internal-link" data-href="$1" href="$1">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      const lang = fence[1] ? ` class="language-${fence[1]}"` : "";
      out.push(`<div class="el-pre"><pre${lang}><code${lang}>${code.join("\n")}\n</code><button class="copy-code-button">Copy</button></pre></div>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<div class="el-h${level}"><h${level}>${inline(heading[2])}</h${level}></div>`);
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])) {
      para.push(lines[i++]);
    }
    out.push(`<div class="el-p"><p>${inline(para.join("<br>"))}</p></div>`);
  }
  return out.join("");
}

(MarkdownRenderer as any).render = async (_app: unknown, markdown: string, el: HTMLElement) => {
  el.innerHTML = miniMarkdown(markdown);
};

// ---------------------------------------------------------------------------
// Мок хранилища: задача + ежедневные заметки с секциями про задачу
// ---------------------------------------------------------------------------

interface HeadingCache {
  heading: string;
  level: number;
  position: { start: { line: number; col: number; offset: number }; end: { line: number; col: number; offset: number } };
}

function buildCache(content: string): { headings: HeadingCache[]; links: any[] } {
  const headings: HeadingCache[] = [];
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

function createVault(files: Record<string, string>) {
  const tfiles = new Map<string, TFile>();
  const contents = new Map<string, string>();
  const caches = new Map<string, ReturnType<typeof buildCache>>();
  const binaries = new Map<string, ArrayBuffer>();
  for (const [path, content] of Object.entries(files)) {
    tfiles.set(path, new TFile(path));
    contents.set(path, content);
    caches.set(path, buildCache(content));
  }
  const listeners = new Map<string, Function[]>();
  const app = {
    vault: {
      getMarkdownFiles: () => [...tfiles.values()].filter((f) => f.extension === "md"),
      getAbstractFileByPath: (path: string) => tfiles.get(path) ?? null,
      cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
      readBinary: async (file: TFile) => binaries.get(file.path) ?? new TextEncoder().encode(contents.get(file.path) ?? "").buffer,
      process: async (file: TFile, fn: (c: string) => string) => {
        const next = fn(contents.get(file.path) ?? "");
        contents.set(file.path, next);
        return next;
      },
      on: (event: string, cb: Function) => {
        listeners.set(event, [...(listeners.get(event) ?? []), cb]);
        return {};
      },
    },
    metadataCache: {
      getFileCache: (file: TFile) => caches.get(file.path) ?? null,
      getFirstLinkpathDest: (link: string) => {
        const path = [...tfiles.keys()].find(
          (p) => p.replace(/\.md$/, "") === link || p.endsWith(`/${link}.md`) || p === link || p.endsWith(`/${link}`)
        );
        return path ? tfiles.get(path) : null;
      },
    },
    workspace: {
      on: () => ({}),
      getActiveFile: () => null,
      getActiveViewOfType: () => null,
      onLayoutReady: (cb: () => void) => cb(),
      openLinkText: () => undefined,
    },
  };
  return {
    app,
    /** Изменить файл: контент сразу, кэш метаданных - отдельно (как в Obsidian). */
    write(path: string, content: string, updateCache = true) {
      contents.set(path, content);
      if (updateCache) caches.set(path, buildCache(content));
    },
    reindex(path: string) {
      caches.set(path, buildCache(contents.get(path) ?? ""));
    },
    /** Бинарный файл (картинка) в хранилище. */
    addBinary(path: string, bytes: ArrayBuffer) {
      tfiles.set(path, new TFile(path));
      binaries.set(path, bytes);
    },
  };
}

function createModule(app: any) {
  let processor: ((source: string, el: HTMLElement, ctx: any) => void) | undefined;
  const plugin = {
    registerEvent: () => undefined,
    registerDomEvent: () => undefined,
    registerMarkdownCodeBlockProcessor: (_lang: string, cb: typeof processor) => {
      processor = cb;
    },
  };
  const module = new TaskViewModule({ app, plugin, eventBus: new EventBus() } as any);
  module.load();
  return { module, plugin, processor: processor! };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const DAILY_1 = ["# 01-09-2026", "", "### [[Task]]", "Сделал первый шаг", "```bash", "echo hi", "```", "", "### [[Other]]", "не про нас"].join("\n");
const DAILY_2 = ["# 02-09-2026", "", "### [[Task]]", "Второй день", "#### Итог", "Готово"].join("\n");

function mountTaskView(app: any) {
  const { module, processor } = createModule(app);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const ctx = createMockProcessorContext("tasks/Task.md");
  processor("", el, ctx);
  return { module, el, ctx };
}

test("TaskViewModule.getEditorBlocks lists Live Preview blocks of one editor, including ones taken out of the DOM", async () => {
  const vault = createVault({
    "tasks/Task.md": "```opa-task-view\n```\n",
    "periodic/daily/01-09-2026.md": DAILY_1,
  });
  const { module, processor } = createModule(vault.app);
  const scroller = document.body.appendChild(document.createElement("div"));
  scroller.className = "cm-scroller";
  const other = document.body.appendChild(document.createElement("div"));
  other.className = "cm-scroller";
  const el = scroller.appendChild(document.createElement("div"));
  // Live Preview кладёт в контекст процессора область прокрутки редактора и сообщает строку блока
  const ctx = {
    ...createMockProcessorContext("tasks/Task.md"),
    containerEl: scroller,
    getSectionInfo: () => ({ lineStart: 0, lineEnd: 1, text: "" }),
  };
  processor("", el, ctx);
  await flush();
  assert.deepEqual(module.getEditorBlocks(scroller), [{ el, line: 0 }]);
  // Далеко от экрана: Obsidian вынул виджет из DOM, но блок остаётся отрисованным
  el.remove();
  assert.deepEqual(module.getEditorBlocks(scroller), [{ el, line: 0 }]);
  assert.deepEqual(module.getEditorBlocks(other), []);
  // Секция уничтожена
  ctx.unloadChildren();
  assert.deepEqual(module.getEditorBlocks(scroller), []);
  scroller.remove();
  other.remove();
});

test("TaskViewModule renders daily sections about the task and does not rebuild DOM when data is unchanged", async () => {
  const vault = createVault({
    "tasks/Task.md": "---\nstatus: В работе\n---\n```opa-task-view\n```\n",
    "periodic/daily/01-09-2026.md": DAILY_1,
    "periodic/daily/02-09-2026.md": DAILY_2,
  });
  const { module, el, ctx } = mountTaskView(vault.app);
  await waitFor(() => el.querySelectorAll("details.task-view-entry").length === 2);

  const entries = Array.from(el.querySelectorAll("details.task-view-entry"));
  assert.equal(entries[0].querySelector(".task-view-display")?.textContent?.includes("Сделал первый шаг"), true);
  assert.equal(entries[0].querySelector("pre code")?.textContent?.trim(), "echo hi");
  assert.equal(entries[1].querySelector(".task-view-display")?.textContent?.includes("Второй день"), true);
  assert.equal(el.textContent?.includes("не про нас"), false);
  // Оглавление по подзаголовкам
  assert.equal(el.querySelector(".task-toc-list")?.textContent, "Итог (02-09-2026)");

  // Фоновое обновление без изменений: те же самые DOM-узлы остаются на месте
  await (module as any).registry.runRefreshAsync(false);
  const after = Array.from(el.querySelectorAll("details.task-view-entry"));
  assert.equal(after[0], entries[0]);
  assert.equal(after[1], entries[1]);

  // Изменение ежедневной заметки - блок перерисован с новым содержимым
  vault.write("periodic/daily/02-09-2026.md", DAILY_2.replace("Второй день", "Второй день, дополнено"));
  await (module as any).registry.runRefreshAsync(false);
  assert.equal(el.textContent?.includes("Второй день, дополнено"), true);

  // Obsidian уничтожил секцию - состояние блока очищено
  ctx.unloadChildren();
  assert.equal((module as any).blockState.get(el), undefined);
  module.unload();
  el.remove();
});

test("TaskViewModule keeps the current DOM while the metadata cache lags behind the file", async () => {
  const vault = createVault({
    "tasks/Task.md": "```opa-task-view\n```\n",
    "periodic/daily/01-09-2026.md": DAILY_1,
  });
  const { module, el, ctx } = mountTaskView(vault.app);
  await waitFor(() => el.querySelectorAll("details.task-view-entry").length === 1);
  const before = el.querySelector("details.task-view-entry");

  // Файл изменился (секция стала длиннее), кэш ещё старый: позиции заголовков указывают не туда
  vault.write("periodic/daily/01-09-2026.md", DAILY_1.replace("Сделал первый шаг", "Сделал первый шаг\nи ещё строку\nи ещё"), false);
  await (module as any).registry.runRefreshAsync(false);
  assert.equal(el.querySelector("details.task-view-entry"), before, "DOM не пересобран по устаревшему кэшу");
  assert.equal(el.textContent?.includes("и ещё строку"), false);

  // Кэш догнал файл - обновление проходит
  vault.reindex("periodic/daily/01-09-2026.md");
  await (module as any).registry.runRefreshAsync(false);
  assert.equal(el.textContent?.includes("и ещё строку"), true);
  ctx.unloadChildren();
  module.unload();
  el.remove();
});

test("TaskViewModule: Ctrl+C inside the block puts source markdown on the clipboard, plain text elsewhere", async () => {
  const vault = createVault({
    "tasks/Task.md": "```opa-task-view\n```\n",
    "periodic/daily/01-09-2026.md": DAILY_1,
  });
  const { module, el, ctx } = mountTaskView(vault.app);
  await waitFor(() => el.querySelectorAll("details.task-view-entry").length === 1);

  const display = el.querySelector(".task-view-display")!;
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.setStartBefore(display.firstElementChild!);
  range.setEndAfter(display.lastElementChild!);
  selection.removeAllRanges();
  selection.addRange(range);

  const clipboard = new Map<string, string>();
  const event = new window.Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: { setData: (type: string, value: string) => clipboard.set(type, value) } });
  display.querySelector("p")!.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(clipboard.get("text/plain"), "Сделал первый шаг\n```bash\necho hi\n```");

  // Выделение в textarea редактирования - стандартное поведение (не мешаем)
  const textarea = el.querySelector("textarea")!;
  selection.removeAllRanges();
  const inTextarea = document.createRange();
  inTextarea.selectNodeContents(textarea.parentElement!);
  selection.addRange(inTextarea);
  const event2 = new window.Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event2, "clipboardData", { value: { setData: () => undefined } });
  textarea.dispatchEvent(event2);
  assert.equal(event2.defaultPrevented, false);

  selection.removeAllRanges();
  ctx.unloadChildren();
  module.unload();
  el.remove();
});

test("TaskViewModule: background refresh is deferred while text inside the block is selected", async () => {
  const vault = createVault({
    "tasks/Task.md": "```opa-task-view\n```\n",
    "periodic/daily/01-09-2026.md": DAILY_1,
  });
  const { module, el, ctx } = mountTaskView(vault.app);
  await waitFor(() => el.querySelectorAll("details.task-view-entry").length === 1);
  const paragraph = el.querySelector(".task-view-display p")!;
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  selection.removeAllRanges();
  selection.addRange(range);

  vault.write("periodic/daily/01-09-2026.md", DAILY_1.replace("Сделал первый шаг", "Переписал"));
  await (module as any).registry.runRefreshAsync(false);
  assert.equal(el.contains(paragraph), true, "DOM с выделением не тронут");
  assert.equal((module as any).refreshDeferredBySelection, true);

  selection.removeAllRanges();
  (module as any).onSelectionChange();
  await flush();
  await (module as any).registry.runRefreshAsync(false);
  assert.equal(el.textContent?.includes("Переписал"), true);
  ctx.unloadChildren();
  module.unload();
  el.remove();
});

test("TaskViewModule: saving an edited section re-renders from local data and survives the stale cache window", async () => {
  const vault = createVault({
    "tasks/Task.md": "```opa-task-view\n```\n",
    "periodic/daily/01-09-2026.md": DAILY_1,
  });
  const { module, el, ctx } = mountTaskView(vault.app);
  await waitFor(() => el.querySelectorAll("details.task-view-entry").length === 1);

  const details = el.querySelector<HTMLElement>("details.task-view-entry")!;
  (module as any).openEditForEntry(el, details);
  const textarea = el.querySelector<HTMLTextAreaElement>("textarea.task-view-edit")!;
  assert.equal(textarea.value, "Сделал первый шаг\n```bash\necho hi\n```");
  textarea.value = "Переписал секцию\nи добавил строку\n#### Новый итог";
  await (module as any).saveSectionEdit(el, 0, textarea);

  // Файл обновлён через vault.process, DOM показывает новый текст сразу (кэш метаданных ещё старый)
  const fileText = await vault.app.vault.cachedRead(new TFile("periodic/daily/01-09-2026.md"));
  assert.equal(fileText.includes("Переписал секцию\nи добавил строку\n#### Новый итог\n\n### [[Other]]"), true);
  assert.equal(el.textContent?.includes("Переписал секцию"), true);
  assert.equal(el.querySelector(".task-toc-list")?.textContent, "Новый итог (01-09-2026)");
  assert.equal(el.querySelector<HTMLElement>(".task-view-edit-wrap")?.style.display, "none");

  // Фоновое обновление по устаревшему кэшу не откатывает DOM к старому содержимому
  const rendered = el.querySelector("details.task-view-entry");
  await (module as any).registry.runRefreshAsync(false);
  assert.equal(el.querySelector("details.task-view-entry"), rendered);
  assert.equal(el.textContent?.includes("Переписал секцию"), true);

  // Кэш догнал файл - данные совпадают с локальными, DOM не пересобирается
  vault.reindex("periodic/daily/01-09-2026.md");
  await (module as any).registry.runRefreshAsync(false);
  assert.equal(el.querySelector("details.task-view-entry"), rendered);
  ctx.unloadChildren();
  module.unload();
  el.remove();
});

test("TaskViewModule: saving re-renders only the edited entry - other entries keep their DOM", async () => {
  const vault = createVault({
    "tasks/Task.md": "```opa-task-view\n```\n",
    "periodic/daily/01-09-2026.md": DAILY_1,
    "periodic/daily/02-09-2026.md": DAILY_2,
  });
  const { module, el, ctx } = mountTaskView(vault.app);
  await waitFor(() => el.querySelectorAll("details.task-view-entry").length === 2);
  const [first, second] = Array.from(el.querySelectorAll<HTMLElement>("details.task-view-entry"));
  const secondDisplay = second.querySelector(".task-view-display")!;
  const firstDisplay = first.querySelector(".task-view-display")!;
  const toc = el.querySelector(".task-toc-list")!;

  (module as any).openEditForEntry(el, first);
  const textarea = first.querySelector<HTMLTextAreaElement>("textarea.task-view-edit")!;
  textarea.value = "Новый текст первого дня\n#### Итог дня";
  await (module as any).saveSectionEdit(el, 0, textarea);

  // Записи и оглавление - те же элементы; заменено только содержимое превью первой записи
  const after = Array.from(el.querySelectorAll<HTMLElement>("details.task-view-entry"));
  assert.equal(after[0], first);
  assert.equal(after[1], second);
  assert.equal(first.querySelector(".task-view-display"), firstDisplay);
  assert.equal(second.querySelector(".task-view-display"), secondDisplay);
  assert.equal(el.querySelector(".task-toc-list"), toc);
  assert.equal(firstDisplay.textContent?.includes("Новый текст первого дня"), true);
  assert.equal(firstDisplay.textContent?.includes("Сделал первый шаг"), false);
  assert.equal(first.querySelector<HTMLElement>(".task-view-edit-wrap")?.style.display, "none");
  assert.equal(first.querySelector<HTMLElement>(".markdown-embed-content")?.style.display, "block");
  assert.equal(toc.textContent, "Итог дня (01-09-2026)Итог (02-09-2026)");
  // Подзаголовок получил id для оглавления
  assert.equal(firstDisplay.querySelector("h4")?.id, (module as any).blockState.get(el).structuredData[0].subHeadings[0].id);
  // Файл записан; повторное открытие редактора показывает сохранённый текст
  const fileText = await vault.app.vault.cachedRead(new TFile("periodic/daily/01-09-2026.md"));
  assert.equal(fileText.includes("Новый текст первого дня\n#### Итог дня\n\n### [[Other]]"), true);
  (module as any).openEditForEntry(el, first);
  assert.equal(first.querySelector<HTMLTextAreaElement>("textarea.task-view-edit")!.value, "Новый текст первого дня\n#### Итог дня");
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => first.querySelector<HTMLElement>(".task-view-edit-wrap")?.style.display === "none");
  ctx.unloadChildren();
  module.unload();
  el.remove();
});

/** Элемент с заданным прямоугольником на экране (jsdom не считает раскладку). */
function withRect(el: HTMLElement, rect: { top: number; bottom: number }): HTMLElement {
  el.getBoundingClientRect = () =>
    ({ top: rect.top, bottom: rect.bottom, height: rect.bottom - rect.top, left: 0, right: 100, width: 100, x: 0, y: rect.top, toJSON: () => ({}) }) as DOMRect;
  return el;
}

test("save scroll anchor: entry top when the editor is below the viewport top, entry bottom when it is above", () => {
  const scroller = withRect(document.createElement("div"), { top: 100, bottom: 700 });
  const details = withRect(document.createElement("details"), { top: 150, bottom: 900 });
  const textarea = withRect(document.createElement("textarea"), { top: 180, bottom: 880 });
  assert.deepEqual(planSaveScrollAnchor(textarea, details, scroller), { kind: "top", y: 150, detailsTop: 150 });
  assert.deepEqual(planSaveScrollAnchor(null, details, scroller), { kind: "top", y: 150, detailsTop: 150 });

  const detailsAbove = withRect(document.createElement("details"), { top: -900, bottom: 50 });
  const textareaAbove = withRect(document.createElement("textarea"), { top: -850, bottom: 40 });
  assert.deepEqual(planSaveScrollAnchor(textareaAbove, detailsAbove, scroller), { kind: "bottom", y: 50, detailsTop: -900 });
});

test("save scroll anchor: the source line at the viewport top maps to its rendered block, which returns to that height", () => {
  const source = ["Первый абзац", "", "#### Заголовок", "Текст под заголовком", "", "Последний абзац"].join("\n");
  const display = document.createElement("div");
  display.innerHTML = miniMarkdown(source);
  const details = withRect(document.createElement("details"), { top: -400, bottom: 300 });
  const blocks = Array.from(display.children) as HTMLElement[];
  // Верх строк textarea на экране: -65, -45, -25, -5, 15, 35 → у верхнего края области (Y=0) стояла строка 3, «Текст под заголовком»
  const lineScreenTops = [-300, -280, -260, -240, -220, -200].map((y) => y + 235);
  const anchor = { kind: "line" as const, y: 0, line: 3, lineScreenTops, detailsTop: -400 };
  withRect(blocks[2], { top: 40, bottom: 60 }); // абзац «Текст под заголовком» после перерисовки оказался ниже
  const resolved = resolveSaveScrollAnchor(anchor, details, display, source);
  assert.equal(resolved.el, blocks[2]);
  assert.equal(resolved.edge, "top");
  assert.equal(resolved.y, lineScreenTops[3]);

  // Пустая строка между блоками → следующий блок ниже; хвостовые строки → последний блок
  assert.equal(resolveSaveScrollAnchor({ ...anchor, line: 1 }, details, display, source).el, blocks[1]);
  assert.equal(resolveSaveScrollAnchor({ ...anchor, line: 1 }, details, display, source).y, lineScreenTops[2]);
  assert.equal(resolveSaveScrollAnchor({ ...anchor, line: 99 }, details, display, source).el, blocks[3]);
  // Без сопоставления с исходником - верх записи
  const unmapped = resolveSaveScrollAnchor(anchor, details, display, "совсем другой текст");
  assert.deepEqual([unmapped.el, unmapped.y], [details, -400]);

  // Прокрутка сдвигается ровно на разницу между текущим и требуемым положением якоря
  const scroller = { scrollTop: 1000, scrollHeight: 5000, clientHeight: 600 } as HTMLElement;
  keepAnchorOnScreen(scroller, resolved);
  assert.equal(scroller.scrollTop, 1000 + (40 - lineScreenTops[3]));
  const clamped = { scrollTop: 4390, scrollHeight: 5000, clientHeight: 600 } as HTMLElement;
  keepAnchorOnScreen(clamped, { el: withRect(document.createElement("div"), { top: 500, bottom: 520 }), edge: "top", y: 100 });
  assert.equal(clamped.scrollTop, 4400);
});

test("headingMatchesContent detects a metadata cache that no longer matches the file", () => {
  const content = "# Title\n\n### [[Task]]\ntext";
  const heading = { heading: "[[Task]]", level: 3, position: { start: { offset: 9 }, end: { offset: 21 } } };
  assert.equal(headingMatchesContent(content, heading), true);
  assert.equal(headingMatchesContent("# Title\n\nline inserted\n### [[Task]]\ntext", heading), false);
  assert.equal(headingMatchesContent("# Title\n\n### C#\ntext", { heading: "C#", level: 3, position: { start: { offset: 9 }, end: { offset: 15 } } }), true);
  assert.equal(headingMatchesContent("# Title\n\n### Head ###\ntext", { heading: "Head", level: 3, position: { start: { offset: 9 }, end: { offset: 21 } } }), true);
  assert.equal(headingMatchesContent("Setext\n---\ntext", { heading: "Setext", level: 2, position: { start: { offset: 0 }, end: { offset: 10 } } }), true);
  assert.equal(headingMatchesContent("Setext\n---\ntext", { heading: "Other", level: 2, position: { start: { offset: 0 }, end: { offset: 10 } } }), false);
});

test("extractSubHeadings and taskViewSignature", () => {
  assert.deepEqual(extractSubHeadings("text\n#### A\n```\n# not heading\n```\n##### B\n### same level", 3), [
    { text: "A", level: 1 },
    { text: "B", level: 2 },
  ]);
  const entry = { id: "x", dateLink: "l", date: "d", subHeadings: [{ text: "A", level: 1, id: "x-h-0" }], content: "c", sourcePath: "p", headingLine: "### [[Task]]" };
  assert.equal(taskViewSignature([entry]), taskViewSignature([{ ...entry, id: "other" }]));
  assert.notEqual(taskViewSignature([entry]), taskViewSignature([{ ...entry, content: "changed" }]));
});

test("TaskViewModule: saving while a background render is in flight keeps the saved text", async () => {
  const vault = createVault({
    "tasks/Task.md": "```opa-task-view\n```\n",
    "periodic/daily/01-09-2026.md": DAILY_1,
  });
  // Медленное чтение файла имитирует долгий рендер
  const originalRead = vault.app.vault.cachedRead;
  let releaseRead: (() => void) | null = null;
  vault.app.vault.cachedRead = async (file: TFile) => {
    if (releaseRead) await new Promise<void>((resolve) => { const prev = releaseRead; releaseRead = () => { prev?.(); resolve(); }; });
    return originalRead(file);
  };
  const { module, el, ctx } = mountTaskView(vault.app);
  await waitFor(() => el.querySelectorAll("details.task-view-entry").length === 1);

  releaseRead = () => undefined; // следующий рендер зависнет на чтении
  const background = (module as any).registry.runRefreshAsync(false);
  await flush();
  assert.equal((module as any).rendering.has(el), true);

  const textarea = el.querySelector<HTMLTextAreaElement>("textarea.task-view-edit")!;
  textarea.value = "НОВЫЙ ТЕКСТ";
  const saving = (module as any).saveSectionEdit(el, 0, textarea);
  await flush();
  const release = releaseRead;
  releaseRead = null;
  release?.();
  await background;
  await saving;
  assert.equal(el.textContent?.includes("НОВЫЙ ТЕКСТ"), true);
  assert.equal(el.textContent?.includes("Сделал первый шаг"), false);

  // После переиндексации данные с диска совпадают с локальными - DOM не пересобирается
  vault.reindex("periodic/daily/01-09-2026.md");
  const rendered = el.querySelector("details.task-view-entry");
  await (module as any).registry.runRefreshAsync(false);
  assert.equal(el.querySelector("details.task-view-entry"), rendered);
  ctx.unloadChildren();
  module.unload();
  el.remove();
});

test("TaskViewModule: unchanged background refresh keeps the entry objects used by DOM handlers", async () => {
  const vault = createVault({
    "tasks/Task.md": "```opa-task-view\n```\n",
    "periodic/daily/01-09-2026.md": DAILY_1,
  });
  const { module, el, ctx } = mountTaskView(vault.app);
  await waitFor(() => el.querySelectorAll("details.task-view-entry").length === 1);
  const before = (module as any).blockState.get(el).structuredData[0];
  await (module as any).registry.runRefreshAsync(false);
  assert.equal((module as any).blockState.get(el).structuredData[0], before);
  ctx.unloadChildren();
  module.unload();
  el.remove();
});

test("TaskViewModule: selecting only an image copies its embed markdown", async () => {
  const vault = createVault({
    "tasks/Task.md": "```opa-task-view\n```\n",
    "periodic/daily/01-09-2026.md": ["### [[Task]]", "Скрин:", "![[shot.png|300]]"].join("\n"),
  });
  (MarkdownRenderer as any).render = async (_app: unknown, markdown: string, el: HTMLElement) => {
    el.innerHTML = markdown.startsWith("**")
      ? miniMarkdown(markdown)
      : `<div class="el-p"><p>Скрин:<br><span class="internal-embed image-embed" src="shot.png" alt="shot.png|300"><img src="app://x/shot.png" alt="shot.png|300" width="300"></span></p></div>`;
  };
  const { module, el, ctx } = mountTaskView(vault.app);
  await waitFor(() => el.querySelectorAll("details.task-view-entry").length === 1);
  const embed = el.querySelector(".internal-embed")!;
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNode(embed);
  selection.removeAllRanges();
  selection.addRange(range);
  const clipboard = new Map<string, string>();
  const event = new window.Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: { setData: (type: string, value: string) => clipboard.set(type, value) } });
  embed.dispatchEvent(event);
  assert.equal(clipboard.get("text/plain"), "![[shot.png|300]]");
  selection.removeAllRanges();
  ctx.unloadChildren();
  module.unload();
  el.remove();
});

test("TaskViewModule: context menu on an image offers «Копировать изображение» and puts PNG bytes on the clipboard", async () => {
  const vault = createVault({
    "tasks/Task.md": "```opa-task-view\n```\n",
    "periodic/daily/01-09-2026.md": ["### [[Task]]", "Скрин:", "![[shot.png|300]]"].join("\n"),
  });
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).buffer;
  vault.addBinary("attachments/shot.png", pngBytes);
  (MarkdownRenderer as any).render = async (_app: unknown, markdown: string, el: HTMLElement) => {
    el.innerHTML = markdown.startsWith("**")
      ? miniMarkdown(markdown)
      : `<div class="el-p"><p>Скрин:<br><span class="internal-embed image-embed is-loaded" src="shot.png" alt="shot.png|300"><img src="app://x/shot.png" alt="shot.png|300" width="300"></span></p></div>`;
  };
  const { module, el, ctx } = mountTaskView(vault.app);
  await waitFor(() => el.querySelectorAll("details.task-view-entry").length === 1);
  const img = el.querySelector<HTMLImageElement>("img")!;

  // jsdom не считает раскладку: элемент под курсором задаём явно
  const originalFromPoint = (document as any).elementFromPoint;
  (document as any).elementFromPoint = () => img;
  const written: Array<Record<string, Blob>> = [];
  class FakeClipboardItem {
    constructor(public parts: Record<string, Blob>) {
      written.push(parts);
    }
  }
  (window as any).ClipboardItem = FakeClipboardItem;
  const clipboardBackup = (window.navigator as any).clipboard;
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { write: async (items: unknown[]) => { assert.equal(items.length, 1); }, writeText: async () => undefined },
  });
  try {
    Notice.messages.length = 0;
    img.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const menu = Menu.last!;
    assert.deepEqual(menu.items.map((item) => item.title), ["Копировать", "Копировать изображение", "Изменить"]);
    await menu.items[1].click();
    await waitFor(() => written.length === 1);
    assert.equal(written[0]["image/png"].type, "image/png");
    assert.equal(written[0]["image/png"].size, 12);
    assert.deepEqual(Notice.messages, ["Изображение скопировано"]);
  } finally {
    (document as any).elementFromPoint = originalFromPoint;
    delete (window as any).ClipboardItem;
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: clipboardBackup });
    ctx.unloadChildren();
    module.unload();
    el.remove();
  }
});

test("locateEditCaret puts the caret on the block under the mouse, else on the found text, else by click position", () => {
  const md = ["Первая строка", "```bash", "echo hi", "```", "", "Хвост записи"].join("\n");
  // Блок под мышью известен: курсор в начале блока, уточнение по тексту внутри блока
  assert.deepEqual(locateEditCaret(md, { targetText: "echo hi", isImage: false, blockRange: { from: 1, to: 4 } }, 0), { pos: 22, length: 7 });
  assert.deepEqual(locateEditCaret(md, { targetText: "", isImage: false, blockRange: { from: 5, to: 6 } }, 0), { pos: 35, length: 0 });
  // Текст вне блока под мышью в блоке не ищется - курсор остаётся на блоке
  assert.deepEqual(locateEditCaret(md, { targetText: "Хвост записи", isImage: false, blockRange: { from: 0, to: 1 } }, 0), { pos: 0, length: 0 });
  // Блок не сопоставлен - поиск по всей записи
  assert.deepEqual(locateEditCaret(md, { targetText: "Хвост", isImage: false }, 0), { pos: 35, length: 5 });
  // Ничего не найдено - строка по относительному положению клика (никаких прыжков в конец)
  assert.deepEqual(locateEditCaret(md, { targetText: "нет такого", isImage: false }, 0), { pos: 0, length: 0 });
  assert.deepEqual(locateEditCaret(md, { targetText: "нет такого", isImage: false }, 0.5), { pos: 30, length: 0 });
  assert.deepEqual(locateEditCaret(md, undefined, 1), { pos: 35, length: 0 });
  // Картинка: по alt с размером или по имени файла
  const withImage = "Скрин:\n![[shot.png|300]]";
  assert.deepEqual(locateEditCaret(withImage, { targetText: "shot.png|300", isImage: true }, 0), { pos: 10, length: 12 });
  assert.deepEqual(locateEditCaret(withImage, { targetText: "shot.png|400", isImage: true }, 0), { pos: 10, length: 8 });
});

test("TaskViewModule: opening the editor focuses without scrolling and places the caret on the clicked block", async () => {
  const vault = createVault({
    "tasks/Task.md": "```opa-task-view\n```\n",
    "periodic/daily/01-09-2026.md": DAILY_1,
  });
  const { module, el, ctx } = mountTaskView(vault.app);
  await waitFor(() => el.querySelectorAll("details.task-view-entry").length === 1);
  const details = el.querySelector<HTMLElement>("details.task-view-entry")!;
  const textarea = el.querySelector<HTMLTextAreaElement>("textarea.task-view-edit")!;
  const focusCalls: unknown[] = [];
  textarea.focus = ((options?: FocusOptions) => { focusCalls.push(options); }) as typeof textarea.focus;

  (module as any).openEditForEntry(el, details, { targetText: "echo hi", isImage: false, clientY: 120, blockRange: { from: 1, to: 4 } });
  assert.deepEqual(focusCalls, [{ preventScroll: true }]);
  assert.equal(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd), "echo hi");
  assert.equal(el.querySelector<HTMLElement>(".task-view-edit-wrap")?.style.display, "block");
  assert.equal(el.querySelector<HTMLElement>(".markdown-embed-content")?.style.display, "none");

  // Escape сохраняет и закрывает редактор
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => el.querySelector<HTMLElement>(".task-view-edit-wrap")?.style.display === "none");
  assert.equal((module as any).activeEditRef, null);
  ctx.unloadChildren();
  module.unload();
  el.remove();
});
