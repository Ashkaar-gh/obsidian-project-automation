import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { MarkdownView, Notice } from "obsidian";
import {
  SearchableTextCache,
  collectSearchableText,
  findCodeBlockRanges,
  findTextMatches,
  findTextRanges,
} from "../src/core/TaskViewSearch";
import { TASK_SEARCH_HIGHLIGHT, TaskViewSearchModule } from "../src/modules/TaskViewSearchModule";
import { UI_LABELS } from "../src/ui/Labels";

// ---------------------------------------------------------------------------
// Окружение: jsdom, CSS Custom Highlight API и прямоугольники диапазонов (в jsdom нет раскладки)
// ---------------------------------------------------------------------------

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
const document = window.document;
(globalThis as any).window = window;
(globalThis as any).document = document;
(globalThis as any).Node = window.Node;
(globalThis as any).HTMLElement = window.HTMLElement;

const highlightRegistry = new Map<string, { ranges: Range[] }>();
(window as any).CSS = { highlights: highlightRegistry };
(window as any).Highlight = class {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
};

/** Прокрутка редактора текущего теста: экранная позиция текста = позиция в заметке (data-top) - прокрутка. */
const layout = { scrollTop: (): number => 0 };

/** Прямоугольник диапазона: top - из data-top ближайшего элемента; текст свёрнутой записи не отображается. */
function rectOfRange(range: Range): DOMRect | null {
  const start = range.startContainer;
  const el = (start.nodeType === 1 ? start : start.parentElement) as Element | null;
  if (!el?.isConnected) return null;
  const closed = el.closest("details:not([open])");
  const summary = closed ? Array.from(closed.children).find((c) => c.tagName === "SUMMARY") : null;
  if (closed && !summary?.contains(start)) return null;
  const top = Number(el.closest("[data-top]")?.getAttribute("data-top") ?? 100) - layout.scrollTop();
  return { top, bottom: top + 20, height: 20, left: 10, right: 60, width: 50, x: 10, y: top, toJSON: () => ({}) } as DOMRect;
}
const rangeProto = window.Range.prototype as any;
rangeProto.getClientRects = function (this: Range) {
  const rect = rectOfRange(this);
  return rect ? [rect] : [];
};
rangeProto.getBoundingClientRect = function (this: Range) {
  return rectOfRange(this) ?? ({ top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 } as DOMRect);
};

const NATIVE_CLASS = "obsidian-search-match-highlight";

// ---------------------------------------------------------------------------
// Редактор и панель поиска - как в Obsidian 1.13.7 (editor.searchCursor, класс панели поиска редактора)
// ---------------------------------------------------------------------------

interface Pos {
  line: number;
  ch: number;
}

class FakeEditor {
  selection = { from: 0, to: 0 };
  highlights: { ranges: any[]; cls: string }[] = [];
  selectionsSet: { from: Pos; to: Pos }[] = [];
  scrolledTo: { range: any; center?: boolean }[] = [];
  onScrollIntoView: ((range: { from: Pos; to: Pos }) => void) | null = null;

  constructor(public value: string, public cm: any) {}

  getValue(): string {
    return this.value;
  }
  offsetToPos(offset: number): Pos {
    const before = this.value.slice(0, offset).split("\n");
    return { line: before.length - 1, ch: before[before.length - 1].length };
  }
  posToOffset(pos: Pos): number {
    const lines = this.value.split("\n");
    let offset = 0;
    for (let i = 0; i < pos.line; i++) offset += lines[i].length + 1;
    return offset + pos.ch;
  }
  getCursor(which: "from" | "to"): Pos {
    return this.offsetToPos(which === "from" ? this.selection.from : this.selection.to);
  }
  getSelection(): string {
    return this.value.slice(this.selection.from, this.selection.to);
  }
  setSelection(from: Pos, to: Pos): void {
    this.selectionsSet.push({ from, to });
    this.selection = { from: this.posToOffset(from), to: this.posToOffset(to) };
  }
  replaceRange(text: string, from: Pos, to: Pos): void {
    const a = this.posToOffset(from);
    const b = this.posToOffset(to);
    this.value = this.value.slice(0, a) + text + this.value.slice(b);
  }
  transaction(tx: { changes: { from: Pos; to: Pos; text: string }[] }): void {
    const changes = tx.changes
      .map((c) => ({ a: this.posToOffset(c.from), b: this.posToOffset(c.to), text: c.text }))
      .sort((x, y) => y.a - x.a);
    for (const c of changes) this.value = this.value.slice(0, c.a) + c.text + this.value.slice(c.b);
  }
  addHighlights(ranges: any[], cls: string): void {
    this.highlights = [{ ranges, cls }];
  }
  removeHighlights(cls: string): void {
    this.highlights = this.highlights.filter((h) => h.cls !== cls);
  }
  scrollIntoView(range: any, center?: boolean): void {
    this.scrolledTo.push({ range, center });
    this.onScrollIntoView?.(range);
  }
  focus(): void {}

  /** Штатный курсор (упрощённо): без учёта регистра, от выделения, по кругу. */
  searchCursor(query: string): any {
    const editor = this;
    const all = () => findTextMatches(editor.value, query);
    let current: { from: number; to: number } | null = null;
    let last = { ...editor.selection };
    const toRange = (m: { from: number; to: number }) => ({ from: editor.offsetToPos(m.from), to: editor.offsetToPos(m.to) });
    return {
      native: true,
      findNext() {
        const list = all();
        const m = list.find((x) => x.from >= last.to) ?? list[0] ?? null;
        current = m;
        if (m) last = m;
        return m ? toRange(m) : null;
      },
      findPrevious() {
        const list = all();
        const m = [...list].reverse().find((x) => x.to <= last.from) ?? list[list.length - 1] ?? null;
        current = m;
        if (m) last = m;
        return m ? toRange(m) : null;
      },
      findAll: () => all().map(toRange),
      current: () => (current ? toRange(current) : null),
      getIndexAndCount() {
        if (!current) return [0, 0];
        const list = all();
        return [list.filter((x) => x.from <= current!.to).length, list.length];
      },
      replace(text: string) {
        if (current) editor.replaceRange(text, editor.offsetToPos(current.from), editor.offsetToPos(current.to));
      },
      replaceAll(text: string) {
        editor.transaction({ changes: all().map((m) => ({ ...toRange(m), text })) });
      },
    };
  }
}

/** Панель поиска редактора Obsidian: методы на прототипе, обработчики ввода и F3 привязаны при создании. */
class FakeSearch {
  cursor: any = null;
  isActive = false;
  isReplace = false;
  searchInputEl: HTMLInputElement;
  replaceInputEl: HTMLInputElement;
  countEl: HTMLElement;
  /** F3 в Obsidian: this.findNext.bind(this) при создании панели. */
  f3: () => void;

  constructor(public editor: FakeEditor) {
    this.searchInputEl = document.createElement("input");
    this.replaceInputEl = document.createElement("input");
    this.countEl = document.createElement("div");
    document.body.append(this.searchInputEl, this.replaceInputEl, this.countEl);
    this.searchInputEl.addEventListener("input", this.onSearchInput.bind(this));
    this.f3 = this.findNext.bind(this);
  }
  getQuery(): string {
    return this.searchInputEl.value;
  }
  show(replace = false): void {
    this.isActive = true;
    this.isReplace = replace;
    this.searchInputEl.focus();
    this.onSearchInput();
  }
  hide(): void {
    if (!this.isActive) return;
    this.isActive = false;
    const active = document.activeElement;
    if (this.cursor && (active === this.searchInputEl || active === this.replaceInputEl)) {
      const r = this.cursor.current();
      if (r) this.editor.setSelection(r.from, r.to);
    }
    this.searchInputEl.value = "";
    this.cursor = null;
    this.editor.removeHighlights(NATIVE_CLASS);
    this.editor.focus();
  }
  updateCount(): void {
    let t = 0;
    let n = 0;
    const q = this.getQuery();
    if (this.cursor && q) [t, n] = this.cursor.getIndexAndCount();
    this.countEl.textContent = `${t} / ${n}`;
  }
  onSearchInput(): void {
    const q = this.getQuery();
    this.cursor = this.editor.searchCursor(q);
    const t = q ? this.cursor.findNext() : null;
    if (t) this.highlight([t]);
    else this.clear();
    this.searchInputEl.classList.toggle("mod-no-match", Boolean(q) && !t);
    this.updateCount();
  }
  findPrevious(): void {
    if (!this.cursor) return;
    const e = this.cursor.findPrevious();
    if (e) this.highlight([e]);
    else this.clear();
    this.updateCount();
  }
  findNext(): void {
    if (!this.cursor) return;
    const e = this.cursor.findNext();
    if (e) this.highlight([e]);
    else this.clear();
    this.updateCount();
  }
  replaceCurrentMatch(): void {
    if (!this.cursor) return;
    this.cursor.replace(this.replaceInputEl.value, "searchReplace");
    this.findNext();
  }
  replaceAll(): void {
    this.cursor.replaceAll(this.replaceInputEl.value, "searchReplace");
  }
  searchAll(): void {
    this.highlight(this.cursor.findAll());
  }
  highlight(ranges: any[]): void {
    this.editor.addHighlights(ranges, NATIVE_CLASS);
    if (ranges[0]) this.editor.scrollIntoView(ranges[0], true);
  }
  clear(): void {
    this.editor.removeHighlights(NATIVE_CLASS);
  }
}

// ---------------------------------------------------------------------------
// Заметка-задача в Live Preview: текст, блок opa-task-view внутри виджета редактора
// ---------------------------------------------------------------------------

const TASK_NOTE = [
  "---",
  "status: В работе",
  "---",
  "## Описание задачи",
  "Синк конфигов",
  "",
  "```opa-task-view",
  "```",
  "",
  "После блока: синк",
].join("\n");

/** Разметка блока, как её строит TaskViewModule: оглавление, записи (вторая свёрнута), скрытый редактор записи. */
const TASK_BLOCK_HTML = `
<details class="callout" data-callout="toc" open>
  <summary class="task-view-summary"><div><div class="callout-title"><div class="callout-icon">✏️</div><div class="callout-title-inner">Оглавление</div></div></div><button class="task-view-collapse-button">▼</button></summary>
  <div class="callout-content"><ul class="task-toc-list"><li><a href="#">Подготовка (01-09-2026)</a></li></ul></div>
</details>
<details class="task-view-entry" open data-entry-index="0">
  <summary class="task-view-summary"><div class="task-view-summary-title"><p><strong><a class="internal-link">01-09-2026</a></strong></p></div><div class="task-view-summary-actions"><button class="task-view-summary-button task-view-collapse-button">▼</button></div></summary>
  <div class="markdown-embed-content"><div class="markdown-preview-view markdown-rendered task-view-display"><p data-top="1500">Синкаем с репо <a href="https://example.com">https://example.com</a></p><p>Проверяем в vmalert</p></div></div>
  <div class="task-view-edit-wrap" style="display: none;"><textarea>Синкаем с репо</textarea><button>Сохранить синк</button></div>
</details>
<details class="task-view-entry" data-entry-index="1">
  <summary class="task-view-summary"><div class="task-view-summary-title"><p><strong><a class="internal-link">02-09-2026</a></strong></p></div><div class="task-view-summary-actions"><button class="task-view-summary-button task-view-collapse-button">◀</button></div></summary>
  <div class="markdown-embed-content"><div class="markdown-preview-view markdown-rendered task-view-display"><p data-top="2500">Ещё раз синк<strong>аем</strong></p></div></div>
  <div class="task-view-edit-wrap" style="display: none;"><textarea>Ещё раз синкаем</textarea><button>Сохранить</button></div>
</details>`;

function buildTaskBlock(): HTMLElement {
  const root = document.createElement("div");
  root.className = "block-language-opa-task-view opa-task-view";
  root.innerHTML = TASK_BLOCK_HTML;
  return root;
}

function makeView(text: string, options: { withBlock?: boolean } = {}) {
  const scroller = document.createElement("div");
  scroller.className = "cm-scroller";
  const content = scroller.appendChild(document.createElement("div"));
  content.className = "cm-content";
  document.body.appendChild(scroller);
  let scrollTop = 0;
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => (scrollTop = v) });
  layout.scrollTop = () => scrollTop;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 10000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600, left: 0, right: 800, width: 800 }) as DOMRect;

  const widget = content.appendChild(document.createElement("div"));
  widget.className = "cm-preview-code-block cm-embed-block markdown-rendered";
  const root = buildTaskBlock();
  if (options.withBlock !== false) widget.appendChild(root);
  const fence = findCodeBlockRanges(text, "opa-task-view")[0];

  const cm = {
    contentDOM: content,
    scrollDOM: scroller,
    posAtDOM(node: Node) {
      if (!content.contains(node)) throw new RangeError("Trying to find position for a DOM position outside of the document");
      return fence?.from ?? 0;
    },
  };
  const editor = new FakeEditor(text, cm);
  const search = new FakeSearch(editor);
  const containerEl = document.body.appendChild(document.createElement("div"));
  let source = false;
  const view = Object.create(MarkdownView.prototype);
  Object.assign(view, {
    containerEl,
    editor,
    editMode: { search },
    getMode: () => "source",
    getState: () => ({ mode: "source", source }),
  });
  return {
    view: view as MarkdownView,
    editor,
    search,
    root,
    widget,
    scroller,
    get scrollTop() {
      return scrollTop;
    },
    setSourceMode(value: boolean) {
      source = value;
    },
  };
}

function createSearchModule(taskView: unknown = null) {
  const module = new TaskViewSearchModule({ plugin: { taskView } } as any);
  module.load();
  return module;
}

function type(search: FakeSearch, query: string): void {
  search.searchInputEl.value = query;
  search.searchInputEl.dispatchEvent(new window.Event("input"));
}

function highlighted(): string[] {
  return (highlightRegistry.get(TASK_SEARCH_HIGHLIGHT)?.ranges ?? []).map((range) => range.toString());
}

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

test("collectSearchableText skips buttons, fields and the hidden entry editor, keeps collapsed entries", () => {
  const root = buildTaskBlock();
  const { text } = collectSearchableText(root);
  assert.ok(text.includes("Синкаем с репо"));
  assert.ok(text.includes("Ещё раз синкаем"), "collapsed entry text is searchable, inline elements are joined");
  assert.ok(text.includes("Оглавление"));
  assert.ok(!text.includes("Сохранить"), "hidden editor button is not searched");
  assert.ok(!text.includes("▼") && !text.includes("◀"), "collapse buttons are not searched");
  assert.equal((text.match(/Синкаем с репо/g) ?? []).length, 1, "textarea content is not searched");

  // Абзацы не склеиваются в одно слово
  const paragraphs = document.createElement("div");
  paragraphs.innerHTML = "<p>син</p><p>к</p><p>syn<b>c</b>&nbsp;it</p>";
  assert.deepEqual(findTextRanges(paragraphs, "синк"), []);
  assert.deepEqual(
    findTextRanges(paragraphs, "SYNC IT").map((range) => range.toString()),
    ["sync it"]
  );
});

test("findTextRanges returns DOM ranges across inline elements in reading order", () => {
  const root = buildTaskBlock();
  assert.deepEqual(
    findTextRanges(root, "синкаем").map((range) => range.toString()),
    ["Синкаем", "синкаем"]
  );
  assert.deepEqual(findTextRanges(root, "vmalert").length, 1);
  assert.deepEqual(findTextRanges(root, ""), []);
});

test("SearchableTextCache reuses the block text until the block changes", () => {
  const root = buildTaskBlock();
  document.body.appendChild(root);
  const cache = new SearchableTextCache();
  const first = cache.get(root);
  assert.equal(cache.get(root), first, "unchanged block - same text");
  // Изменение ещё не доставлено наблюдателю (он асинхронный), но уже учитывается
  root.querySelector(".task-view-display p")!.appendChild(document.createTextNode(" новый синк"));
  const second = cache.get(root);
  assert.notEqual(second, first);
  assert.ok(second.text.includes("новый синк"));
  // Запись открыта на редактирование: её просмотр скрыт - текст из поиска уходит
  root.querySelector<HTMLElement>('details[data-entry-index="0"] .markdown-embed-content')!.style.display = "none";
  assert.ok(!cache.get(root).text.includes("Синкаем с репо"));
  cache.clear();
  root.remove();
});

test("Ctrl+F in Live Preview walks note text and task entries in note order", () => {
  highlightRegistry.clear();
  const module = createSearchModule();
  const env = makeView(TASK_NOTE);
  const { view, search, editor, root } = env;

  view.showSearch(false);
  search.show();
  type(search, "синк");
  assert.equal(search.countEl.textContent, "1 / 4");
  assert.equal(editor.highlights[0]?.cls, NATIVE_CLASS, "note text is highlighted by the editor");
  assert.deepEqual(editor.highlights[0].ranges[0].from, { line: 4, ch: 0 });
  assert.deepEqual(highlighted(), []);

  search.findNext();
  assert.equal(search.countEl.textContent, "2 / 4");
  assert.deepEqual(editor.highlights, [], "editor highlight is cleared for a match in the block");
  assert.deepEqual(highlighted(), ["Синк"]);
  assert.equal(env.scrollTop, 1500 - 290, "the match is scrolled to the middle of the editor");

  // F3 (обработчик привязан при создании панели) - к совпадению в свёрнутой записи: она разворачивается
  search.f3();
  assert.equal(search.countEl.textContent, "3 / 4");
  const collapsed = root.querySelector<HTMLElement>('details[data-entry-index="1"]')!;
  assert.ok(collapsed.hasAttribute("open"));
  assert.equal(collapsed.querySelector(".task-view-collapse-button")?.textContent, "▼");
  assert.deepEqual(highlighted(), ["синк"]);
  assert.equal(env.scrollTop, 2500 - 290, "the expanded entry is laid out at once and scrolled to");

  search.findNext();
  assert.equal(search.countEl.textContent, "4 / 4");
  assert.deepEqual(editor.highlights[0].ranges[0].from, { line: 9, ch: 13 });
  assert.deepEqual(highlighted(), [], "block highlight is removed for a match in the note text");

  search.findNext();
  assert.equal(search.countEl.textContent, "1 / 4", "wraps around");
  search.findPrevious();
  search.findPrevious();
  assert.equal(search.countEl.textContent, "3 / 4");

  // Escape на совпадении в записи: курсор редактора не переносится, подсветка снимается
  search.searchInputEl.focus();
  search.hide();
  assert.deepEqual(editor.selectionsSet, []);
  assert.deepEqual(highlighted(), []);
  assert.equal(search.cursor, null);

  // Escape на совпадении в тексте заметки - как штатно: выделение на найденном
  search.show();
  type(search, "синк");
  search.searchInputEl.focus();
  search.hide();
  assert.deepEqual(editor.selectionsSet, [{ from: { line: 4, ch: 0 }, to: { line: 4, ch: 4 } }]);
  module.unload();
});

test("find all highlights note text in the editor and entries in the block", () => {
  highlightRegistry.clear();
  const module = createSearchModule();
  const { view, search, editor } = makeView(TASK_NOTE);
  module.attach(view);
  search.show();
  type(search, "синкаем");
  assert.equal(search.countEl.textContent, "1 / 2");
  search.searchAll();
  assert.deepEqual(highlighted(), ["Синкаем", "синкаем"]);
  assert.deepEqual(editor.highlights, []);
  module.unload();
  assert.deepEqual(highlighted(), [], "unload removes the highlight");
});

test("notes without a rendered task block keep the editor's own search cursor", () => {
  const module = createSearchModule();
  const plain = makeView("Просто заметка про синк", { withBlock: false });
  module.attach(plain.view);
  plain.search.show();
  type(plain.search, "синк");
  assert.equal(plain.search.cursor.native, true);
  assert.equal(plain.search.countEl.textContent, "1 / 1");

  // Режим исходного кода: блок не отрисован, ищется его markdown
  const source = makeView(TASK_NOTE);
  source.setSourceMode(true);
  module.attach(source.view);
  source.search.show();
  type(source.search, "синк");
  assert.equal(source.search.cursor.native, true);

  // Курсор внутри блока: Live Preview убрал виджет и показывает markdown блока вместо записей
  const inside = makeView(TASK_NOTE);
  const fence = findCodeBlockRanges(TASK_NOTE, "opa-task-view")[0];
  inside.editor.selection = { from: fence.from + 3, to: fence.from + 3 };
  inside.widget.remove();
  module.attach(inside.view);
  inside.search.show();
  type(inside.search, "синк");
  assert.equal(inside.search.cursor.native, true);
  assert.equal(inside.search.countEl.textContent, "2 / 2");

  // Курсор внутри блока, но виджет на месте (Obsidian не показал markdown) - записи ищутся
  const stillRendered = makeView(TASK_NOTE);
  stillRendered.editor.selection = { from: fence.from + 3, to: fence.from + 3 };
  module.attach(stillRendered.view);
  stillRendered.search.show();
  type(stillRendered.search, "синк");
  assert.notEqual(stillRendered.search.cursor.native, true);
  // Поиск начинается после курсора, как у штатного: записи стоят на месте блока - раньше курсора
  assert.equal(stillRendered.search.countEl.textContent, "4 / 4");
  module.unload();
});

test("a task block that was never rendered is drawn on demand and the counter catches up", async () => {
  highlightRegistry.clear();
  const env = makeView(TASK_NOTE);
  const { view, search, root, widget } = env;
  // Блок далеко от экрана и ни разу не был виден: виджета нет, модуль задачи о нём не знает
  root.remove();
  let known: { el: HTMLElement; line: number | null }[] = [];
  let rendered = false;
  const taskView = {
    getEditorBlocks: () => known,
    isBlockRendered: () => rendered,
  };
  const prints: unknown[] = [];
  (env.editor.cm as any).observer = {
    onPrint(event: unknown) {
      // CodeMirror отрисовывает документ целиком: виджет создан, плагин начал рисовать записи
      prints.push(event);
      known = [{ el: root, line: 6 }];
      setTimeout(() => {
        widget.appendChild(root);
        rendered = true;
      }, 100);
    },
  };
  const module = createSearchModule(taskView);
  module.attach(view);
  search.show();
  type(search, "синк");
  assert.equal(search.countEl.textContent, "1 / 2", "only the note text is known at first");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(prints.length, 1, "the editor was asked to render the whole document once");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(search.countEl.textContent, "1 / 4", "entries are counted once the block is drawn");

  // Совпадение только в записях: сначала «ничего», потом выбирается первое совпадение
  rendered = false;
  known = [];
  root.remove();
  type(search, "синкаем");
  assert.equal(search.countEl.textContent, "0 / 0");
  assert.ok(search.searchInputEl.classList.contains("mod-no-match"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(prints.length, 1, "render requests are throttled");
  known = [{ el: root, line: 6 }];
  widget.appendChild(root);
  rendered = true;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(search.countEl.textContent, "1 / 2");
  assert.ok(!search.searchInputEl.classList.contains("mod-no-match"));
  assert.deepEqual(highlighted(), ["Синкаем"]);
  module.unload();
});

test("replace changes only the note text and explains skipped entries", () => {
  Notice.messages.length = 0;
  const module = createSearchModule();
  const { view, search, editor } = makeView(TASK_NOTE);
  module.attach(view);
  search.show(true);
  type(search, "синк");
  search.replaceInputEl.value = "sync";
  search.replaceCurrentMatch();
  assert.ok(editor.value.includes("sync конфигов"));
  assert.equal(search.countEl.textContent, "1 / 3", "moved to the first entry match");
  search.replaceCurrentMatch();
  assert.deepEqual(Notice.messages, [UI_LABELS.taskSearch.replaceSkipped(1)]);
  assert.equal(search.countEl.textContent, "2 / 3");

  search.replaceAll();
  assert.ok(editor.value.endsWith("После блока: sync"));
  assert.ok(editor.value.includes("```opa-task-view\n```"), "the block itself is untouched");
  assert.equal(Notice.messages[1], UI_LABELS.taskSearch.replaceSkipped(2));
  module.unload();
});

test("a task block scrolled far away is found and brought back when its match is selected", async () => {
  highlightRegistry.clear();
  const env = makeView(TASK_NOTE);
  const { view, search, editor, root, widget } = env;
  // Блок вынут из DOM (далеко от экрана), модуль задачи знает, что он отрисован в этом редакторе
  root.remove();
  const module = createSearchModule({ getEditorBlocks: () => [{ el: root, line: 6 }], isBlockRendered: () => true });
  // Прокрутка редактора к строке блока возвращает виджет в DOM (как CodeMirror)
  editor.onScrollIntoView = (range) => {
    if (range.from.line === 6 && !root.isConnected) widget.appendChild(root);
  };
  module.attach(view);
  search.show();
  type(search, "синк");
  assert.equal(search.countEl.textContent, "1 / 4");
  search.findNext();
  assert.equal(search.countEl.textContent, "2 / 4");
  assert.deepEqual(editor.scrolledTo.at(-1)?.range.from, { line: 6, ch: 0 }, "scrolled to the block first");
  assert.equal(env.scrollTop, 0, "the match is scrolled to in the next frame, after the editor brings the block back");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(root.isConnected);
  assert.equal(env.scrollTop, 1500 - 290);
  module.unload();
});

test("a failing merged cursor falls back to the editor's own search", () => {
  const module = createSearchModule();
  const { view, search, editor } = makeView(TASK_NOTE);
  module.attach(view);
  search.show();
  type(search, "синк");
  assert.equal(search.countEl.textContent, "1 / 4");
  const originalError = console.error;
  console.error = () => undefined;
  try {
    editor.getValue = () => {
      throw new Error("boom");
    };
    search.findNext();
  } finally {
    console.error = originalError;
  }
  assert.match(String(search.countEl.textContent), /^\d+ \/ 2$/, "note text is still searched");
  module.unload();
});

test("unload restores the editor search panel and MarkdownView.showSearch", () => {
  const originalShowSearch = MarkdownView.prototype.showSearch;
  const module = createSearchModule();
  assert.notEqual(MarkdownView.prototype.showSearch, originalShowSearch);
  const { view, search } = makeView(TASK_NOTE);
  view.showSearch(false);
  assert.ok(Object.getOwnPropertyDescriptor(search, "cursor")?.get, "attached on showSearch");
  search.show();
  type(search, "синк");
  module.unload();
  assert.equal(MarkdownView.prototype.showSearch, originalShowSearch);
  const descriptor = Object.getOwnPropertyDescriptor(search, "cursor");
  assert.ok(descriptor && "value" in descriptor && descriptor.writable);
  assert.equal(search.cursor?.native, true, "the editor's own cursor is back");
  assert.ok(!Object.prototype.hasOwnProperty.call(search, "highlight"));
  assert.ok(!Object.prototype.hasOwnProperty.call(search, "clear"));
  assert.equal(module.attach(view), false, "does nothing after unload");
});
