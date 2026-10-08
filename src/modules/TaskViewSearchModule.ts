/**
 * Поиск Ctrl+F в режиме редактирования находит и записи блока задачи (opa-task-view).
 *
 * Штатный поиск редактора («Поиск в текущем файле» в Live Preview) ищет только по markdown-тексту заметки, а записи
 * из ежедневных заметок в файле задачи не лежат - их рисует блок. Режим чтения ищет по отрисованной странице, поэтому
 * там записи находились, а в режиме редактирования - нет.
 *
 * Модуль не заменяет поиск Obsidian, а подключается к его панели: курсор, который панель берёт у редактора
 * (editor.searchCursor), подменяется объединённым - текст заметки плюс текст отрисованного блока по порядку в заметке
 * (см. core/TaskViewSearch). Поле, счётчик «2 / 5», стрелки, Enter/Shift+Enter, F3, Escape и замена - штатные.
 * Найденное в блоке подсвечивается через CSS Custom Highlight API (DOM блока не меняется) и прокручивается на экран,
 * свёрнутая запись разворачивается.
 *
 * На что модуль опирается во внутренностях Obsidian (проверено на 1.13.7): view.editMode.search - панель поиска
 * редактора (поле cursor, searchInputEl, методы highlight/clear), editor.cm - EditorView CodeMirror 6, его
 * observer.onPrint - чтобы отрисовать блок, который ещё ни разу не был на экране. Если устроено иначе, модуль
 * к панели не подключается (или не дорисовывает блок) и поиск работает как штатный.
 */

import { MarkdownView, Notice, type Editor } from "obsidian";
import type { ModuleContext, PluginModule } from "./types";
import {
  MergedSearchCursor,
  SearchableTextCache,
  TASK_VIEW_LANGUAGE,
  findCodeBlockRanges,
  findTextMatches,
  rangeForMatch,
  type CodeBlockRange,
  type MergedCursorHost,
  type SearchBlockSource,
  type SearchableText,
} from "../core/TaskViewSearch";
import { UI_LABELS } from "../ui/Labels";
import { openTaskViewDetails } from "./TaskViewModule";

/** Имя подсветки найденного в блоке: ::highlight(opa-task-search) в styles/task-view.css. */
export const TASK_SEARCH_HIGHLIGHT = "opa-task-search";
/** Совпадение ближе к краю области прокрутки, чем на столько, прокручивается к середине. */
const SCROLL_MARGIN_PX = 40;
const SCROLL_MARGIN_X_PX = 16;
/** Сколько кадров ждать, пока блок, прокрученный далеко за экран, вернётся в DOM. */
const MAX_REVEAL_FRAMES = 8;
/** Без CSS Custom Highlight API найденное место коротко подсвечивается (анимация панели «Структура»). */
const FLASH_CLASS = "opa-outline-flash";
const FLASH_MS = 1300;
/** Блок ещё не отрисован: как часто и сколько раз проверять, готов ли он, чтобы обновить счётчик. */
const PENDING_POLL_MS = 150;
const PENDING_POLLS = 20;
/** Не просить редактор отрисовать весь документ чаще, чем раз в столько. */
const RENDER_REQUEST_INTERVAL_MS = 2000;
const TASK_VIEW_PATTERN = new RegExp(TASK_VIEW_LANGUAGE, "i");

/** Панель поиска редактора Obsidian (внутренний класс): то, чем пользуется модуль. */
interface NativeEditorSearch {
  cursor: unknown;
  searchInputEl: { value: string };
  getQuery?(): string;
  highlight(ranges: unknown[]): void;
  clear(): void;
}

/** Курсор поиска редактора (editor.searchCursor) - запасной, если объединённый упадёт. */
interface NativeCursorLike {
  [method: string]: unknown;
}

/** EditorView CodeMirror 6 (editor.cm): то, чем пользуется модуль. */
interface EditorViewLike {
  contentDOM: HTMLElement;
  scrollDOM: HTMLElement;
  posAtDOM(node: Node, offset?: number): number;
  /** Внутреннее: обработчик печати - отрисовывает документ целиком (CodeMirror сам так делает перед печатью). */
  observer?: { onPrint?: (event: unknown) => void };
}

/** Блок задачи для поиска и его готовность. */
interface TaskBlockSource extends SearchBlockSource<TaskSearchHit> {
  /** Показан отрисованным, но элемента блока ещё нет (далеко от экрана и ни разу не был виден). */
  missing: boolean;
  /** Показан отрисованным, но записи ещё не отрисованы (нет элемента или идёт первая отрисовка). */
  pending: boolean;
}

/** Курсор для запроса и признак, что блок ещё дорисовывается (совпадения в нём появятся позже). */
export interface TaskSearchCursor {
  cursor: MergedSearchCursor<TaskSearchHit, unknown>;
  pending: boolean;
}

/** Совпадение в отрисованном блоке. */
export interface TaskSearchHit {
  /** Диапазон DOM найденного текста (создаётся при первом обращении: нужен только выбранному совпадению). */
  readonly range: Range | null;
  /** Элемент блока (.opa-task-view). */
  readonly root: HTMLElement;
  /** Позиция блока кода в заметке. */
  readonly blockFrom: number;
}

function lazyHit(root: HTMLElement, source: SearchableText, from: number, to: number, blockFrom: number): TaskSearchHit {
  let range: Range | null | undefined;
  return {
    root,
    blockFrom,
    get range() {
      if (range === undefined) range = rangeForMatch(source, root.ownerDocument, from, to);
      return range;
    },
  };
}

/**
 * Панель поиска получает совпадение в блоке как диапазон редактора (начало блока, нулевой длины) - по нему же
 * штатная подсветка, если бы она его получила, ничего бы не сломала. Сами данные совпадения - здесь.
 */
const blockHits = new WeakMap<object, TaskSearchHit>();

export function taskSearchHitOf(result: unknown): TaskSearchHit | null {
  return result && typeof result === "object" ? blockHits.get(result) ?? null : null;
}

export class TaskViewSearchModule implements PluginModule {
  readonly highlights = new SearchHighlights();
  private hooks = new Set<SearchHook>();
  private hooked = new WeakMap<object, SearchHook>();
  private restoreShowSearch: (() => void) | null = null;
  private renderRequests = new WeakMap<object, number>();
  private active = false;

  constructor(private readonly ctx: ModuleContext) {}

  load(): void {
    this.active = true;
    // Панель поиска открывается через MarkdownView.showSearch (команда «Поиск в текущем файле», Ctrl+F, меню):
    // подключаемся к ней перед открытием
    this.restoreShowSearch = patchShowSearch((view) => {
      this.attach(view);
    });
  }

  unload(): void {
    this.active = false;
    this.restoreShowSearch?.();
    this.restoreShowSearch = null;
    for (const hook of this.hooks) hook.detach();
    this.hooks.clear();
    this.highlights.clearAll();
  }

  /** Подключиться к панели поиска редактора вкладки. false - панель устроена не так, как ожидается. */
  attach(view: MarkdownView): boolean {
    if (!this.active) return false;
    const search = nativeSearchOf(view);
    if (!search) return false;
    if (this.hooked.has(search)) return true;
    this.pruneHooks();
    const hook = new SearchHook(this, view, search);
    if (!hook.install()) return false;
    this.hooked.set(search, hook);
    this.hooks.add(hook);
    return true;
  }

  /**
   * Курсор для запроса: объединённый, если в заметке есть блок задачи, показанный отрисованным; null - штатного
   * достаточно (обычная заметка, режим исходного кода, курсор внутри блока, пустой запрос).
   */
  createCursor(view: MarkdownView, query: string, cache: SearchableTextCache): TaskSearchCursor | null {
    if (!this.active || !query || isSourceMode(view)) return null;
    const editor = view.editor;
    const cm = editorViewOf(editor);
    if (!cm) return null;
    const text = editor.getValue();
    if (!TASK_VIEW_PATTERN.test(text)) return null;
    const blocks = this.blockSources(view, cm, text, cache);
    if (!blocks.some((block) => block.rendered)) return null;
    // Блок далеко от экрана и ещё ни разу не был виден - его DOM нет: просим редактор отрисовать документ целиком
    if (blocks.some((block) => block.missing)) this.requestBlockRender(cm);
    return {
      cursor: new MergedSearchCursor(this.hostFor(view, cm, cache), query),
      pending: blocks.some((block) => block.pending),
    };
  }

  /** Есть ли в заметке блок задачи, записи которого ещё не отрисованы. */
  blocksPending(view: MarkdownView, cache: SearchableTextCache): boolean {
    const cm = editorViewOf(view.editor);
    if (!cm) return false;
    return this.blockSources(view, cm, view.editor.getValue(), cache).some((block) => block.pending);
  }

  /**
   * Попросить CodeMirror один раз отрисовать весь документ - так он делает перед печатью (observer.onPrint).
   * Виджет блока задачи создаётся, плагин рисует записи, дальше Obsidian держит блок отрисованным и вне экрана.
   * Прокрутка при этом не меняется.
   */
  private requestBlockRender(cm: EditorViewLike): void {
    const now = Date.now();
    if (now - (this.renderRequests.get(cm) ?? 0) < RENDER_REQUEST_INTERVAL_MS) return;
    this.renderRequests.set(cm, now);
    const observer = cm.observer;
    if (typeof observer?.onPrint !== "function") return;
    // Не внутри обработчика ввода панели поиска
    setTimeout(() => {
      if (!this.active) return;
      try {
        observer.onPrint?.({ type: "beforeprint" });
      } catch (error) {
        console.warn("[OPA] Task search: rendering the task block failed:", error);
      }
    }, 0);
  }

  /** Вкладки закрыты - их панели больше не нужны. */
  private pruneHooks(): void {
    for (const hook of this.hooks) {
      if (hook.isAlive()) continue;
      hook.detach();
      this.hooks.delete(hook);
    }
  }

  private hostFor(
    view: MarkdownView,
    cm: EditorViewLike,
    cache: SearchableTextCache
  ): MergedCursorHost<TaskSearchHit, unknown> {
    const editor = view.editor;
    return {
      getText: () => editor.getValue(),
      getSelection: () => selectionOffsets(editor),
      getBlocks: (text) => this.blockSources(view, cm, text, cache),
      docResult: (from, to) => ({ from: editor.offsetToPos(from), to: editor.offsetToPos(to) }),
      blockResult: (match) => {
        const result = { from: editor.offsetToPos(match.anchor), to: editor.offsetToPos(match.anchor) };
        blockHits.set(result, match.hit);
        return result;
      },
      replaceRange: (text, from, to, origin) => {
        editor.replaceRange(text, editor.offsetToPos(from), editor.offsetToPos(to), origin);
      },
      replaceRanges: (changes, origin) => {
        editor.transaction(
          {
            changes: changes.map((change) => ({
              from: editor.offsetToPos(change.from),
              to: editor.offsetToPos(change.to),
              text: change.text,
            })),
          },
          origin
        );
      },
      onBlockReplaceSkipped: (count) => {
        new Notice(UI_LABELS.taskSearch.replaceSkipped(count));
      },
    };
  }

  /** Блоки задачи заметки: где стоят в тексте, показаны ли отрисованными и что в них найдено. */
  private blockSources(
    view: MarkdownView,
    cm: EditorViewLike,
    text: string,
    cache: SearchableTextCache
  ): TaskBlockSource[] {
    const fences = findCodeBlockRanges(text, TASK_VIEW_LANGUAGE);
    if (fences.length === 0) return [];
    const selection = selectionOffsets(view.editor);
    const roots = this.renderedRoots(cm, fences);
    const taskView = this.ctx.plugin.taskView;
    return fences.map((fence, index) => {
      const known = roots.get(index) ?? null;
      const shown = known != null && known.isConnected && cm.contentDOM.contains(known);
      // Виджета блока в редакторе нет, а курсор внутри блока - Live Preview показывает markdown блока:
      // он ищется как обычный текст. Иначе блок показан отрисованным (на экране или вынут из DOM вдали от него).
      const cursorInside = selection.from <= fence.to && selection.to >= fence.from;
      const rendered = shown || !cursorInside;
      const root = rendered ? known : null;
      const missing = rendered && root == null;
      return {
        from: fence.from,
        to: fence.to,
        rendered,
        missing,
        pending: missing || (root != null && typeof taskView?.isBlockRendered === "function" && !taskView.isBlockRendered(root)),
        find: (query: string) => {
          if (!root) return [];
          const source = cache.get(root);
          return findTextMatches(source.text, query).map((match) =>
            lazyHit(root, source, match.from, match.to, fence.from)
          );
        },
      };
    });
  }

  /** Отрисованные блоки редактора по номерам блоков кода в заметке. */
  private renderedRoots(cm: EditorViewLike, fences: CodeBlockRange[]): Map<number, HTMLElement> {
    const candidates =
      this.ctx.plugin.taskView?.getEditorBlocks(cm.scrollDOM) ??
      Array.from(cm.scrollDOM.querySelectorAll<HTMLElement>(".opa-task-view")).map((el) => ({ el, line: null }));
    const roots = new Map<number, HTMLElement>();
    for (const { el, line } of candidates) {
      const index = fenceIndexOf(cm, el, line, fences);
      if (index < 0) continue;
      const known = roots.get(index);
      if (!known || (!known.isConnected && el.isConnected)) roots.set(index, el);
    }
    return roots;
  }
}

/** Подключение к одной панели поиска (одна на редактор вкладки). */
class SearchHook {
  /** Курсор, который видит панель: объединённый или штатный. */
  private shownCursor: unknown = null;
  /** Штатный курсор последнего запроса. */
  private nativeCursor: unknown = null;
  private revealToken = 0;
  /** Объединённый курсор текущего запроса (null - штатный). */
  private merged: MergedSearchCursor<TaskSearchHit, unknown> | null = null;
  private pendingToken = 0;
  /** Видимый текст блоков, пока открыт поиск. */
  private readonly textCache = new SearchableTextCache();
  private readonly originalHighlight: (ranges: unknown[]) => void;
  private readonly originalClear: () => void;
  private cursorDescriptor: PropertyDescriptor | undefined;
  private ownHighlight: PropertyDescriptor | undefined;
  private ownClear: PropertyDescriptor | undefined;

  constructor(
    private readonly module: TaskViewSearchModule,
    private readonly view: MarkdownView,
    private readonly search: NativeEditorSearch
  ) {
    this.originalHighlight = search.highlight;
    this.originalClear = search.clear;
  }

  install(): boolean {
    const target = this.search as unknown as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(target, "cursor");
    // Ожидаем обычное поле экземпляра; иначе панель устроена по-другому (или её уже кто-то подменил) - не трогаем
    if (!descriptor || !("value" in descriptor) || !descriptor.writable || !descriptor.configurable) return false;
    this.cursorDescriptor = descriptor;
    this.shownCursor = descriptor.value;
    this.nativeCursor = descriptor.value;
    this.ownHighlight = Object.getOwnPropertyDescriptor(target, "highlight");
    this.ownClear = Object.getOwnPropertyDescriptor(target, "clear");
    // Панель создаёт курсор при каждом изменении запроса (this.cursor = editor.searchCursor(query)) и при закрытии
    // сбрасывает (this.cursor = null) - здесь это и перехватывается
    Object.defineProperty(target, "cursor", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: () => this.shownCursor,
      set: (value: unknown) => this.onCursorSet(value),
    });
    target.highlight = (ranges: unknown[]) => this.highlight(ranges);
    target.clear = () => this.clear();
    return true;
  }

  detach(): void {
    this.revealToken++;
    this.pendingToken++;
    this.merged = null;
    this.module.highlights.clear(this);
    this.textCache.clear();
    const target = this.search as unknown as Record<string, unknown>;
    Object.defineProperty(target, "cursor", {
      configurable: true,
      enumerable: this.cursorDescriptor?.enumerable ?? true,
      writable: true,
      value: this.nativeCursor,
    });
    restoreProperty(target, "highlight", this.ownHighlight);
    restoreProperty(target, "clear", this.ownClear);
  }

  isAlive(): boolean {
    return this.view.containerEl?.isConnected !== false;
  }

  private onCursorSet(value: unknown): void {
    this.revealToken++;
    this.pendingToken++;
    this.nativeCursor = value;
    this.merged = null;
    if (!value) {
      // Поиск закрыт
      this.shownCursor = value;
      this.module.highlights.clear(this);
      this.textCache.clear();
      return;
    }
    let cursor: unknown = value;
    try {
      const created = this.module.createCursor(this.view, this.query(), this.textCache);
      if (created) {
        this.merged = created.cursor;
        cursor = guardedCursor(created.cursor, value as NativeCursorLike);
        if (created.pending) this.refreshWhenBlocksReady(created.cursor);
      }
    } catch (error) {
      console.error("[OPA] Task search: using the editor search as is:", error);
    }
    this.shownCursor = cursor;
  }

  /**
   * Блок ещё дорисовывается (заметку только открыли или блок был далеко от экрана): когда записи появятся,
   * обновить счётчик, а если до этого ничего не нашлось - выбрать первое совпадение, как при вводе запроса.
   */
  private refreshWhenBlocksReady(merged: MergedSearchCursor<TaskSearchHit, unknown>): void {
    const token = this.pendingToken;
    let polls = 0;
    const tick = (): void => {
      if (token !== this.pendingToken || this.merged !== merged) return;
      let pending = false;
      try {
        pending = this.module.blocksPending(this.view, this.textCache);
      } catch {
        return;
      }
      if (pending) {
        if (++polls < PENDING_POLLS) setTimeout(tick, PENDING_POLL_MS);
        return;
      }
      const search = this.search as NativeEditorSearch & { onSearchInput?: () => void; updateCount?: () => void };
      try {
        if (!merged.hasSelection()) search.onSearchInput?.();
        else search.updateCount?.();
      } catch (error) {
        console.warn("[OPA] Task search: refreshing the search panel failed:", error);
      }
    };
    setTimeout(tick, PENDING_POLL_MS);
  }

  private query(): string {
    try {
      if (typeof this.search.getQuery === "function") return String(this.search.getQuery() ?? "");
    } catch {
      // ниже - прямо из поля
    }
    return String(this.search.searchInputEl?.value ?? "");
  }

  private highlight(ranges: unknown[]): void {
    const list = Array.isArray(ranges) ? ranges : [];
    const inBlock: TaskSearchHit[] = [];
    const inNote: unknown[] = [];
    for (const range of list) {
      const hit = taskSearchHitOf(range);
      if (hit) inBlock.push(hit);
      else inNote.push(range);
    }
    if (inBlock.length === 0) {
      this.revealToken++;
      this.module.highlights.clear(this);
      this.originalHighlight.call(this.search, list);
      return;
    }
    // Текст заметки подсвечивает редактор, записи блока - своя подсветка
    if (inNote.length > 0) this.originalHighlight.call(this.search, inNote);
    else this.originalClear.call(this.search);
    this.module.highlights.set(
      this,
      inBlock.map((hit) => hit.range).filter((range): range is Range => range != null)
    );
    const first = taskSearchHitOf(list[0]);
    if (first) this.reveal(first);
    else this.revealToken++;
  }

  private clear(): void {
    this.revealToken++;
    this.module.highlights.clear(this);
    this.originalClear.call(this.search);
  }

  /**
   * Показать совпадение в блоке: развернуть свёрнутую запись и прокрутить к найденному. Раскладка после
   * разворачивания считается сразу (getBoundingClientRect), ждать нужно только блок, вынутый из DOM: прокрутка
   * редактора к блоку возвращает его в следующем цикле раскладки CodeMirror, после него (в том же кадре) - наш.
   */
  private reveal(hit: TaskSearchHit): void {
    const token = ++this.revealToken;
    const editor = this.view.editor;
    const scroller = editorViewOf(editor)?.scrollDOM ?? null;
    const range = hit.range;
    if (!scroller || !range) return;
    openDetailsAround(range.startContainer, hit.root);
    let scrolledToBlock = false;
    const attempt = (frame: number): void => {
      if (token !== this.revealToken) return;
      if (!hit.root.isConnected || !scroller.contains(hit.root)) {
        // Блок далеко от экрана - Obsidian вынул его из DOM
        if (!scrolledToBlock) {
          scrolledToBlock = true;
          scrollEditorTo(editor, hit.blockFrom);
        }
      } else if (scrollRangeIntoView(range, scroller)) {
        if (!this.module.highlights.isSupported(hit.root)) flash(range);
        return;
      }
      if (frame < MAX_REVEAL_FRAMES) nextFrame(scroller, () => attempt(frame + 1));
    };
    attempt(0);
  }
}

/**
 * Подсветка найденного в блоках через CSS Custom Highlight API: одна подсветка на окно, собранная из совпадений
 * всех панелей поиска (у всплывающих окон Obsidian свой CSS.highlights).
 */
export class SearchHighlights {
  private byOwner = new Map<object, Range[]>();
  private windows = new Set<Window>();

  set(owner: object, ranges: Range[]): void {
    if (ranges.length > 0) this.byOwner.set(owner, ranges);
    else this.byOwner.delete(owner);
    this.flush();
  }

  clear(owner: object): void {
    if (this.byOwner.delete(owner)) this.flush();
  }

  clearAll(): void {
    this.byOwner.clear();
    this.flush();
  }

  isSupported(node: Node): boolean {
    return highlightApi(node.ownerDocument?.defaultView) != null;
  }

  private flush(): void {
    const byWindow = new Map<Window, Range[]>();
    for (const ranges of this.byOwner.values()) {
      for (const range of ranges) {
        const win = range.startContainer.ownerDocument?.defaultView;
        if (!win) continue;
        const bucket = byWindow.get(win) ?? [];
        bucket.push(range);
        byWindow.set(win, bucket);
      }
    }
    for (const win of new Set([...this.windows, ...byWindow.keys()])) {
      try {
        const api = highlightApi(win);
        if (!api) continue;
        const ranges = byWindow.get(win);
        if (ranges && ranges.length > 0) {
          api.registry.set(TASK_SEARCH_HIGHLIGHT, new api.Highlight(...ranges));
          this.windows.add(win);
        } else {
          api.registry.delete(TASK_SEARCH_HIGHLIGHT);
          this.windows.delete(win);
        }
      } catch (error) {
        // окно могли закрыть
        this.windows.delete(win);
        console.warn("[OPA] Task search: highlight failed:", error);
      }
    }
  }
}

interface HighlightRegistryLike {
  set(name: string, highlight: unknown): unknown;
  delete(name: string): unknown;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

function highlightApi(win: Window | null | undefined): { registry: HighlightRegistryLike; Highlight: HighlightConstructor } | null {
  const scope = win as unknown as { CSS?: { highlights?: HighlightRegistryLike }; Highlight?: HighlightConstructor } | null;
  const registry = scope?.CSS?.highlights;
  const Highlight = scope?.Highlight;
  if (!registry || typeof registry.set !== "function" || typeof registry.delete !== "function") return null;
  return typeof Highlight === "function" ? { registry, Highlight } : null;
}

/**
 * Объединённый курсор с запасным ходом: если он упадёт на неожиданном устройстве блока или редактора, панель
 * продолжит работать со штатным курсором (поиск по тексту заметки, как раньше).
 */
function guardedCursor(merged: MergedSearchCursor<TaskSearchHit, unknown>, native: NativeCursorLike): unknown {
  let failed = false;
  const call = (method: string, args: unknown[], fallback: unknown): unknown => {
    if (!failed) {
      try {
        return (merged as unknown as Record<string, (...values: unknown[]) => unknown>)[method](...args);
      } catch (error) {
        failed = true;
        console.error("[OPA] Task search failed, using the editor search:", error);
      }
    }
    const fn = native[method];
    return typeof fn === "function" ? fn.apply(native, args) : fallback;
  };
  return {
    findNext: () => call("findNext", [], null),
    findPrevious: () => call("findPrevious", [], null),
    findAll: () => call("findAll", [], []),
    current: () => call("current", [], null),
    getIndexAndCount: () => call("getIndexAndCount", [], [0, 0]),
    replace: (text: string, origin?: string) => call("replace", [text, origin], undefined),
    replaceAll: (text: string, origin?: string) => call("replaceAll", [text, origin], undefined),
  };
}

/** Обернуть MarkdownView.showSearch; вернуть отмену (если поверх нас никто не обернул - вернуть как было). */
function patchShowSearch(onShow: (view: MarkdownView) => void): (() => void) | null {
  const proto = (MarkdownView as unknown as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  const original = proto?.showSearch;
  if (!proto || typeof original !== "function") return null;
  const patched = function (this: MarkdownView, ...args: unknown[]): unknown {
    try {
      onShow(this);
    } catch (error) {
      console.error("[OPA] Task search: attaching to the search panel failed:", error);
    }
    return (original as (...values: unknown[]) => unknown).apply(this, args);
  };
  proto.showSearch = patched;
  return () => {
    if (proto.showSearch === patched) proto.showSearch = original;
  };
}

function restoreProperty(target: Record<string, unknown>, key: string, own: PropertyDescriptor | undefined): void {
  if (own) Object.defineProperty(target, key, own);
  else delete target[key];
}

function nativeSearchOf(view: MarkdownView): NativeEditorSearch | null {
  const search = (view as unknown as { editMode?: { search?: unknown } } | null)?.editMode?.search as
    | Partial<NativeEditorSearch>
    | undefined;
  if (!search || typeof search !== "object") return null;
  if (typeof search.highlight !== "function" || typeof search.clear !== "function") return null;
  if (!search.searchInputEl || typeof search.searchInputEl.value !== "string") return null;
  if (!("cursor" in search)) return null;
  return search as NativeEditorSearch;
}

function editorViewOf(editor: unknown): EditorViewLike | null {
  const cm = (editor as { cm?: Partial<EditorViewLike> } | null)?.cm;
  if (!cm || !cm.contentDOM || !cm.scrollDOM || typeof cm.posAtDOM !== "function") return null;
  return cm as EditorViewLike;
}

/** Режим исходного кода (не Live Preview): блоки не отрисовываются, ищется их markdown. */
function isSourceMode(view: MarkdownView): boolean {
  try {
    return view.getMode() === "source" && (view.getState() as { source?: unknown }).source === true;
  } catch {
    return false;
  }
}

function selectionOffsets(editor: Editor): { from: number; to: number } {
  try {
    return { from: editor.posToOffset(editor.getCursor("from")), to: editor.posToOffset(editor.getCursor("to")) };
  } catch {
    return { from: 0, to: 0 };
  }
}

/** Номер блока кода, который отрисован элементом el; -1 - не нашёлся (например, блок из встроенной заметки). */
function fenceIndexOf(cm: EditorViewLike, el: HTMLElement, line: number | null, fences: CodeBlockRange[]): number {
  if (el.isConnected && cm.contentDOM.contains(el)) {
    try {
      const pos = cm.posAtDOM(el, 0);
      return fences.findIndex((fence) => fence.from <= pos && pos <= fence.to);
    } catch {
      return -1;
    }
  }
  if (line != null) return fences.findIndex((fence) => fence.lineStart === line);
  return fences.length === 1 ? 0 : -1;
}

/** Развернуть свёрнутые записи вокруг найденного текста (заголовок записи виден и у свёрнутой). */
function openDetailsAround(node: Node, root: HTMLElement): boolean {
  let opened = false;
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    if (el.tagName !== "DETAILS" || el.hasAttribute("open")) continue;
    const summary = Array.from(el.children).find((child) => child.tagName === "SUMMARY");
    if (summary?.contains(node)) continue;
    openTaskViewDetails(el);
    opened = true;
  }
  return opened;
}

/** Следующий кадр окна элемента (у всплывающих окон Obsidian свой requestAnimationFrame). */
function nextFrame(el: HTMLElement, fn: () => void): void {
  const win = el.ownerDocument?.defaultView;
  if (win && typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(() => fn());
  else setTimeout(fn, 16);
}

function scrollEditorTo(editor: Editor, offset: number): void {
  try {
    const pos = editor.offsetToPos(offset);
    editor.scrollIntoView({ from: pos, to: pos }, true);
  } catch (error) {
    console.warn("[OPA] Task search: scrolling to the block failed:", error);
  }
}

/**
 * Прокрутить область так, чтобы диапазон был на экране: если он у края или за ним - к середине (как поиск в режиме
 * чтения). false - диапазон сейчас не отображается (нет прямоугольников: свёрнут, не отрисован).
 */
export function scrollRangeIntoView(range: Range, scroller: HTMLElement, margin = SCROLL_MARGIN_PX): boolean {
  const rect = rectOf(range);
  if (!rect) return false;
  const box = scroller.getBoundingClientRect();
  if (rect.top < box.top + margin || rect.bottom > box.bottom - margin) {
    const delta = rect.top - box.top - (box.height - rect.height) / 2;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.min(maxTop, Math.max(0, scroller.scrollTop + delta));
  }
  scrollHorizontally(range, scroller);
  return true;
}

function rectOf(range: Range): DOMRect | null {
  const rects = typeof range.getClientRects === "function" ? range.getClientRects() : null;
  if (!rects || rects.length === 0) return null;
  const rect = range.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
}

/** Длинные строки кода и таблицы прокручиваются вбок сами по себе: показать совпадение и там. */
function scrollHorizontally(range: Range, scroller: HTMLElement): void {
  const start = range.startContainer;
  const win = scroller.ownerDocument?.defaultView;
  if (!win) return;
  for (let el = start.nodeType === 1 ? (start as HTMLElement) : start.parentElement; el && el !== scroller; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const overflowX = win.getComputedStyle(el).overflowX;
    if (overflowX !== "auto" && overflowX !== "scroll") continue;
    const rect = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (rect.left < box.left + SCROLL_MARGIN_X_PX) el.scrollLeft -= box.left + SCROLL_MARGIN_X_PX - rect.left;
    else if (rect.right > box.right - SCROLL_MARGIN_X_PX) el.scrollLeft += rect.right - (box.right - SCROLL_MARGIN_X_PX);
  }
}

function flash(range: Range): void {
  const start = range.startContainer;
  const el = start.nodeType === 1 ? (start as HTMLElement) : start.parentElement;
  if (!el) return;
  el.classList.remove(FLASH_CLASS);
  void el.offsetWidth; // перезапуск анимации
  el.classList.add(FLASH_CLASS);
  setTimeout(() => el.classList.remove(FLASH_CLASS), FLASH_MS);
}
