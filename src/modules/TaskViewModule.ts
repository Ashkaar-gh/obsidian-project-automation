/**
 * View задачи: оглавление и контент из ежедневных заметок (daily), где в заголовках упоминается эта задача.
 */

import { Component, MarkdownRenderer, Menu, Notice, TFile, type MarkdownPostProcessorContext } from "obsidian";
import type { ModuleContext, PluginModule } from "./types";
import { replaceSectionByHeading, processSectionByHeading } from "../core/FileIO";
import { Paths } from "../core/Paths";
import { UI_LABELS } from "../ui/Labels";
import { BlockRegistry } from "../ui/BlockRegistry";
import { isRenderUnchanged, markRendered, renderSignature } from "../ui/RenderCache";
import { normalizeTaskKey } from "../core/TaskIndex";
import { copyImageToClipboard } from "../core/ImageClipboard";
import { headingMatchKey, type OutlineTocItem } from "../core/OutlineTree";
import {
  alignBlocksToSource,
  buildCopyTextForBlock,
  buildCopyTextForRange,
  clipRangeToElement,
  embedMarkdown,
  findRenderedBlock,
  getRenderedBlocks,
  normalizeText,
  rangeHasEmbed,
  sourceRangeForBlock,
  visibleTextOfRange,
  type LineRange,
} from "../core/TaskViewCopy";

const DAILY_FOLDER = Paths.DAILY_FOLDER;
const DATA_PATH = "data-opa-task-view-path";
const DATA_NAME = "data-opa-task-view-name";
const REFRESH_DEBOUNCE_MS = 1000;
/** Кэш метаданных отстаёт от содержимого файла (сразу после записи) - повторная попытка через это время. */
const STALE_CACHE_RETRY_MS = 1200;
const MAX_STALE_RETRIES = 3;

/** Состояние блока task-view (вместо ad-hoc свойств на DOM-элементах). */
interface TaskViewBlockState {
  structuredData?: TaskViewEntry[];
  flatTocEntries?: TocEntry[];
  /** Подпись данных последней отрисовки: при совпадении DOM не пересобирается. */
  signature?: string;
  /** Стабильный префикс id элементов блока (оглавление ссылается на них). */
  idPrefix?: string;
  /** Идёт ресайз картинки - не перерисовывать. */
  imageResizeActive?: boolean;
  /** Запланирована повторная попытка после устаревшего кэша метаданных. */
  staleRetryTimer?: ReturnType<typeof setTimeout> | null;
  /** Сколько раз подряд данные с диска признаны устаревшими (после лимита рисуем как есть). */
  staleRetries?: number;
  component?: Component;
  imageResizeCleanup?: () => void;
  listenersAttached?: boolean;
  lastContextMenu?: {
    displayDiv: HTMLElement;
    detailsEl: HTMLElement | null;
    targetText: string;
    isImage: boolean;
    /** Текст по выделению, посчитанный в момент открытия меню (выделение может пропасть при клике по меню). */
    selectionText: string | null;
    imgForMarkdownCopy: HTMLImageElement | null;
    blockEl: Element | null;
    /** Экранная координата клика - при переходе в редактирование строка остаётся под курсором. */
    clientY: number;
    /** Строки исходника блока под курсором (если сопоставление удалось). */
    blockRange: LineRange | null;
  } | null;
}

/** Куда ставить курсор и что держать на экране при открытии редактора секции. */
interface EditOpenOptions {
  targetText: string;
  isImage: boolean;
  clientY?: number;
  blockRange?: LineRange | null;
}

interface TocEntry {
  id: string;
  text: string;
  level: number;
  dateText: string;
  isDateOnly: boolean;
  /** Индекс записи в structuredData. */
  entryIndex: number;
  /** Индекс подзаголовка в записи (null - пункт-дата). */
  subIndex: number | null;
}

interface TaskViewEntry {
  id: string;
  dateLink: string;
  date: string;
  /** line - строка подзаголовка в ежедневной заметке (нет после локального обновления из текста). */
  subHeadings: { text: string; level: number; id: string; line?: number }[];
  content: string;
  sourcePath: string;
  /** Строка заголовка в файле (для безопасной замены секции через vault.process). */
  headingLine: string;
  /** Номер строки заголовка секции в ежедневной заметке (0-based). */
  line?: number;
}

interface PreliminaryEntry {
  date: string;
  dateLink: string;
  subHeadings: { text: string; level: number; line?: number }[];
  content: string;
  sourcePath: string;
  headingLine: string;
  line?: number;
}

function parseDailyDate(basename: string): number {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(basename.replace(/\.md$/i, ""));
  if (!m) return 0;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  const year = parseInt(m[3], 10);
  return new Date(year, month, day).getTime();
}

function headingToAnchor(heading: string): string {
  const t = heading.replace(/^#+\s*/, "").trim();
  if (t.startsWith("[[") && t.endsWith("]]")) return t.slice(2, -2).replace(/\|.*$/, "").trim();
  return t;
}

function normalizeTaskPath(path: string): string {
  return path.split("#")[0].replace(/\\/g, "/").replace(/\.md$/i, "").trim().toLowerCase();
}

function extractWikiLinkTargets(text: string): string[] {
  return Array.from(text.matchAll(/\[\[([^|\]#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g), (match) => match[1]);
}

/** Ключ записи: атрибут data-entry-key в DOM блока (по нему же ищет запись панель «Структура»). */
export function entryKeyOf(entry: { sourcePath: string; headingLine: string }): string {
  return `${entry.sourcePath}::${String(entry.headingLine ?? "").trim()}`;
}

/**
 * Соответствует ли заголовок из кэша метаданных содержимому файла.
 * false - кэш устарел (файл только что изменён, Obsidian ещё не переиндексировал).
 */
export function headingMatchesContent(
  content: string,
  heading: { heading: string; level: number; position: { start: { offset: number }; end: { offset: number } } }
): boolean {
  const slice = content.slice(heading.position.start.offset, heading.position.end.offset).replace(/\r$/, "");
  const atx = slice.match(/^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/);
  if (atx) {
    return atx[1].length === heading.level && normalizeText(atx[2]) === normalizeText(heading.heading);
  }
  // Setext-заголовок: текст и строка из === или ---
  const setext = slice.match(/^([^\n]*?)\s*\r?\n\s{0,3}(=+|-+)\s*$/);
  if (setext) {
    const level = setext[2].startsWith("=") ? 1 : 2;
    return level === heading.level && normalizeText(setext[1]) === normalizeText(heading.heading);
  }
  return false;
}

/** Подзаголовки секции по тексту (для локального обновления после сохранения правки). */
export function extractSubHeadings(
  content: string,
  sectionLevel: number
): { text: string; level: number }[] {
  const result: { text: string; level: number }[] = [];
  let inFence = false;
  let fenceMarker = "";
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (inFence) {
      if (fence && fence[1][0] === fenceMarker[0] && fence[1].length >= fenceMarker.length) inFence = false;
      continue;
    }
    if (fence) {
      inFence = true;
      fenceMarker = fence[1];
      continue;
    }
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    const level = m[1].length;
    if (level <= sectionLevel) continue;
    result.push({ text: m[2].replace(/#/g, "").trim(), level: level - sectionLevel });
  }
  return result;
}

/** Подпись данных, от которых зависит отрисовка блока. */
export function taskViewSignature(entries: TaskViewEntry[]): string {
  return renderSignature(
    entries.map((e) => [e.sourcePath, e.headingLine, e.dateLink, e.content, e.subHeadings.map((h) => [h.text, h.level])])
  );
}

let idCounter = 0;

export class TaskViewModule implements PluginModule {
  private ctx: ModuleContext;
  private registry: BlockRegistry;
  private blockState = new WeakMap<HTMLElement, TaskViewBlockState>();
  private taskViewBlocks = new Set<HTMLElement>();
  /** Идущие отрисовки: контейнер → promise завершения (чтобы дождаться перед локальным обновлением). */
  private rendering = new Map<HTMLElement, Promise<void>>();
  /** Запрошенная во время отрисовки повторная отрисовка (значение - нужна ли принудительная). */
  private pendingRender = new Map<HTMLElement, boolean>();
  /** Компонент отрисовки превью каждой записи (выгружается при повторной отрисовке записи). */
  private entryComponents = new WeakMap<HTMLElement, Component>();
  /** Документы (окна), в которых уже слушаем selectionchange. */
  private selectionDocuments = new WeakSet<Document>();
  /**
   * Где отрисован блок: контекст процессора и, в Live Preview, область прокрутки редактора (cm-scroller).
   * Нужно поиску Ctrl+F: блок, ушедший за край экрана, Obsidian убирает из DOM, но не перерисовывает.
   */
  private blockHosts = new WeakMap<HTMLElement, { ctx: MarkdownPostProcessorContext; scroller: HTMLElement | null }>();
  private unsubscribeIndex: (() => void) | null = null;
  /** Обновление отложено из-за выделенного текста в блоке - повторить, когда выделение снимут. */
  private refreshDeferredBySelection = false;
  /** Текущий режим редактирования секции: выход по Escape или клику снаружи. */
  private activeEditRef: {
    editWrap: HTMLElement;
    doSave: () => void;
    closeUI: () => void;
  } | null = null;
  private _removeEditListeners: (() => void) | undefined = undefined;

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.registry = new BlockRegistry({
      app: ctx.app,
      isEnabled: () => true,
      debounceMs: REFRESH_DEBOUNCE_MS,
      shouldRefresh: (el) => {
        const state = this.blockState.get(el);
        if (state?.imageResizeActive) return false;
        // Не перерисовываем блок, пока в нём открыто редактирование - иначе теряются правки
        if (this.activeEditRef && el.contains(this.activeEditRef.editWrap)) return false;
        // Пока в блоке выделен текст - не трогаем DOM (иначе выделение пропадает и Ctrl+C копирует пустоту)
        if (this.hasSelectionInside(el)) {
          this.refreshDeferredBySelection = true;
          return false;
        }
        return true;
      },
      onPrune: (el) => this.cleanupBlock(el),
      domSelector: ".opa-task-view",
      createRefresh: (el) => (force) => this.refreshTaskView(el, force),
    });
  }

  private getState(el: HTMLElement): TaskViewBlockState {
    let state = this.blockState.get(el);
    if (!state) {
      state = {};
      this.blockState.set(el, state);
    }
    return state;
  }

  /** Освободить ресурсы блока: компонент рендера, слушатели, ресайзер. */
  private cleanupBlock(el: HTMLElement): void {
    this.taskViewBlocks.delete(el);
    this.rendering.delete(el);
    this.pendingRender.delete(el);
    const state = this.blockState.get(el);
    if (!state) return;
    if (state.staleRetryTimer) {
      clearTimeout(state.staleRetryTimer);
      state.staleRetryTimer = null;
    }
    state.component?.unload();
    state.component = undefined;
    state.imageResizeCleanup?.();
    state.imageResizeCleanup = undefined;
    if (state.listenersAttached) {
      el.removeEventListener("copy", this.handleSmartCopy);
      el.removeEventListener("cut", this.handleSmartCopy);
      el.removeEventListener("contextmenu", this.handleTaskViewContextMenu);
      el.removeEventListener("click", this.handleInternalLinkClick);
      state.listenersAttached = false;
    }
    if (this.activeEditRef && el.contains(this.activeEditRef.editWrap)) {
      this._removeEditListeners?.();
      this.activeEditRef = null;
    }
    this.blockState.delete(el);
  }

  load(): void {
    this.unsubscribeIndex = this.ctx.eventBus.on("index:updated", this.scheduleRefresh);
    this.ctx.plugin.registerEvent(this.ctx.app.workspace.on("active-leaf-change", this.onLeafChange));
    this.ctx.plugin.registerEvent(this.ctx.app.vault.on("rename", this.onTaskRename));
    this.ctx.plugin.registerMarkdownCodeBlockProcessor("opa-task-view", (_source, el, ctx) => {
      el.addClass("opa-task-view");
      this.watchSelection(el.ownerDocument);
      const sourcePath = ctx.sourcePath ?? this.ctx.app.workspace.getActiveFile()?.path ?? null;
      if (!sourcePath) {
        el.createEl("p", { text: UI_LABELS.tasks.noNotes, cls: "pv-empty-message" });
        return;
      }
      const taskName = this.ctx.app.vault.getAbstractFileByPath(sourcePath)?.name?.replace(/\.md$/i, "") ?? "";
      if (!taskName) {
        el.createEl("p", { text: UI_LABELS.tasks.noNotes, cls: "pv-empty-message" });
        return;
      }
      el.setAttribute(DATA_PATH, sourcePath);
      el.setAttribute(DATA_NAME, taskName);
      this.blockHosts.set(el, { ctx, scroller: editorScrollerOf(ctx) });
      this.taskViewBlocks.add(el);
      this.registry.register(el, (force) => this.refreshTaskView(el, force), ctx);
    });
  }

  unload(): void {
    if (this.unsubscribeIndex) this.unsubscribeIndex();
    this.unsubscribeIndex = null;
    this._removeEditListeners?.();
    this.registry.clear();
    this.taskViewBlocks.clear();
    this.rendering.clear();
    this.pendingRender.clear();
  }

  private onLeafChange = (): void => {
    const activeFile = this.ctx.app.workspace.getActiveFile();
    const dailyPrefix = DAILY_FOLDER.replace(/\/?$/, "") + "/";
    if (activeFile?.path.startsWith(dailyPrefix)) return;
    this.scheduleRefresh();
  };

  /** Слушать selectionchange в документе блока (у всплывающих окон Obsidian свой document). */
  private watchSelection(doc: Document | null | undefined): void {
    if (!doc || this.selectionDocuments.has(doc)) return;
    if (typeof this.ctx.plugin.registerDomEvent !== "function") return;
    this.selectionDocuments.add(doc);
    this.ctx.plugin.registerDomEvent(doc, "selectionchange", this.onSelectionChange);
  }

  /** Выделение снято - можно выполнить отложенное обновление. */
  private onSelectionChange = (): void => {
    if (!this.refreshDeferredBySelection) return;
    for (const el of this.taskViewBlocks) {
      if (this.hasSelectionInside(el)) return;
    }
    this.refreshDeferredBySelection = false;
    this.registry.scheduleRefresh();
  };

  /** Есть ли непустое выделение, пересекающее блок. */
  private hasSelectionInside(el: HTMLElement): boolean {
    const sel = el.ownerDocument?.defaultView?.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      if (el.contains(range.commonAncestorContainer)) return true;
      try {
        if (range.intersectsNode(el)) return true;
      } catch {
        // элемент из другого документа - не пересекается
      }
    }
    return false;
  }

  private refreshTaskView(el: HTMLElement, force = true): Promise<void> | undefined {
    const sourcePath = el.getAttribute(DATA_PATH);
    const taskName = el.getAttribute(DATA_NAME);
    if (sourcePath && taskName) return this.renderTaskView(el, sourcePath, taskName, { force });
  }

  private onTaskRename = (file: unknown, oldPath: string): void => {
    if (!(file instanceof TFile)) return;
    for (const el of this.taskViewBlocks) {
      if (el.getAttribute(DATA_PATH) !== oldPath) continue;
      el.setAttribute(DATA_PATH, file.path);
      el.setAttribute(DATA_NAME, file.basename);
      this.registry.refreshBlock(el);
    }
  };

  /** Рефреш при изменении индекса daily (create/rename/delete/changed). */
  private scheduleRefresh = (): void => {
    this.registry.scheduleRefresh();
  };

  /** Сохранить текст из textarea в секцию ежедневной заметки (vault.process + поиск по заголовку). */
  private saveSectionEdit = async (
    containerEl: HTMLElement,
    entryIndex: number,
    textareaEl: HTMLTextAreaElement
  ): Promise<void> => {
    const state = this.blockState.get(containerEl);
    const structuredData = state?.structuredData;
    if (!state || !structuredData?.[entryIndex]) {
      this.registry.refreshBlock(containerEl);
      return;
    }
    const entry = structuredData[entryIndex];
    const file = this.ctx.app.vault.getAbstractFileByPath(entry.sourcePath);
    if (!file || !(file instanceof TFile)) {
      new Notice(UI_LABELS.errors.fileNotFound(entry.sourcePath));
      this.registry.refreshBlock(containerEl);
      return;
    }
    const newContent = (textareaEl.value ?? "").replace(/\n+$/, "").replace(/^\n+/, "");
    const ok = await replaceSectionByHeading(this.ctx.app, file, entry.headingLine, textareaEl.value);
    if (!ok) {
      new Notice("Не удалось сохранить секцию (заголовок не найден в файле).");
      this.registry.refreshBlock(containerEl);
      return;
    }
    // Дождаться идущих отрисовок: они могли заменить массив записей данными с диска
    while (this.rendering.has(containerEl)) await this.rendering.get(containerEl);
    const current = this.blockState.get(containerEl);
    const target =
      current?.structuredData?.find((e) => e.sourcePath === entry.sourcePath && e.headingLine === entry.headingLine) ??
      null;
    if (!current?.structuredData || !target) {
      this.registry.refreshBlock(containerEl);
      return;
    }
    // Оптимистичное обновление из локальных данных: кэш метаданных Obsidian после записи
    // отстаёт на сотни миллисекунд, и рендер «с диска» показал бы секцию с неверными границами.
    target.content = newContent;
    const sectionLevel = target.headingLine.match(/^(#+)\s/)?.[1].length ?? 3;
    target.subHeadings = extractSubHeadings(target.content, sectionLevel).map((h, i) => ({
      ...h,
      id: `${target.id}-h-${i}`,
    }));
    current.flatTocEntries = buildTocEntries(current.structuredData);
    const path = containerEl.getAttribute(DATA_PATH);
    const name = containerEl.getAttribute(DATA_NAME);
    if (!path || !name) return;

    // Перерисовываем только отредактированную запись (и оглавление), а не весь блок: остальные записи,
    // их картинки и раскрытость не трогаем - иначе страница «уезжала» на подгрузке картинок в других записях.
    const entrySelector = `details.task-view-entry[data-entry-key="${cssEscape(entryKeyOf(target))}"]`;
    const detailsEl = containerEl.querySelector<HTMLElement>(entrySelector);
    const displayDiv = detailsEl?.querySelector<HTMLElement>(".task-view-display") ?? null;
    const previewWrap = detailsEl?.querySelector<HTMLElement>(".markdown-embed-content") ?? null;
    const editWrap = detailsEl?.querySelector<HTMLElement>(".task-view-edit-wrap") ?? null;
    const tocList = containerEl.querySelector<HTMLElement>(".task-toc-list");
    const component = current.component;
    if (!detailsEl || !displayDiv || !previewWrap || !editWrap || !tocList || !component) {
      await this.rerenderBlockKeepingEntryInPlace(containerEl, path, name, entrySelector);
      return;
    }

    // Что держать на экране: textarea и превью разной высоты, а над курсором могли быть картинки и код
    const scroller = findScrollContainer(detailsEl);
    const liveTextarea = detailsEl.contains(textareaEl) ? textareaEl : null;
    const anchor = scroller ? planSaveScrollAnchor(liveTextarea, detailsEl, scroller) : null;

    editWrap.style.display = "none";
    previewWrap.style.display = "block";
    const textareaInDom = detailsEl.querySelector<HTMLTextAreaElement>(".task-view-edit");
    if (textareaInDom) textareaInDom.value = newContent;
    await this.renderEntryDisplay(displayDiv, target, component);
    this.fillTocList(tocList, current.flatTocEntries, containerEl);
    // Данные уже отражают файл: фоновый рефреш с тем же содержимым не будет перерисовывать блок.
    this.commitLocalData(containerEl);

    if (scroller && anchor) {
      const resolved = resolveSaveScrollAnchor(anchor, detailsEl, displayDiv, newContent);
      keepAnchorOnScreen(scroller, resolved);
      holdAnchorWhileSettling(scroller, displayDiv, resolved);
    }
  };

  /**
   * Запасной путь: полная перерисовка блока из локальных данных с удержанием записи на той же высоте экрана
   * (когда DOM записи не найден - например, блок уже перерисован фоновым обновлением).
   */
  private async rerenderBlockKeepingEntryInPlace(
    containerEl: HTMLElement,
    path: string,
    name: string,
    entrySelector: string
  ): Promise<void> {
    const detailsBefore = containerEl.querySelector<HTMLElement>(entrySelector);
    const scroller = detailsBefore ? findScrollContainer(detailsBefore) : null;
    const topBefore = detailsBefore?.getBoundingClientRect().top ?? null;
    await this.renderTaskView(containerEl, path, name, { force: true, useLocalData: true });
    if (!scroller || topBefore == null) return;
    const detailsAfter = containerEl.querySelector<HTMLElement>(entrySelector);
    if (!detailsAfter) return;
    const resolved = { el: detailsAfter, edge: "top" as const, y: topBefore };
    keepAnchorOnScreen(scroller, resolved);
    holdAnchorWhileSettling(scroller, containerEl, resolved);
  }

  private async fetchTaskViewData(taskName: string, taskPath: string): Promise<{
    preliminary: PreliminaryEntry[];
    /** Файлы, у которых кэш метаданных не соответствует содержимому (позиции заголовков устарели). */
    staleFiles: string[];
  }> {
    const { app } = this.ctx;
    const prefix = DAILY_FOLDER.replace(/\/?$/, "") + "/";
    const dailyFiles = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));
    dailyFiles.sort((a, b) => parseDailyDate(a.basename) - parseDailyDate(b.basename));

    const preliminary: PreliminaryEntry[] = [];
    const staleFiles: string[] = [];
    const taskKey = normalizeTaskKey(taskName);
    const normalizedTaskPath = normalizeTaskPath(taskPath);

    for (const file of dailyFiles) {
      const cache = app.metadataCache.getFileCache(file);
      if (!cache?.headings) continue;

      const headingMatchesTask = (heading: (typeof cache.headings)[number]): boolean => {
        const links = cache.links ?? [];
        const start = heading.position.start.offset;
        const end = heading.position.end.offset;
        let hasResolvedLink = false;
        let hasUnresolvedNameMatch = false;
        for (const link of links) {
          const offset = link.position.start.offset;
          if (offset < start || offset > end) continue;
          const destination = app.metadataCache.getFirstLinkpathDest(link.link, file.path);
          if (destination) {
            hasResolvedLink = true;
            if (normalizeTaskPath(destination.path) === normalizedTaskPath) return true;
          }
          if (!destination && normalizeTaskKey(link.link) === taskKey) hasUnresolvedNameMatch = true;
        }
        if (hasResolvedLink) return false;
        if (hasUnresolvedNameMatch) return true;
        const wikiTargets = extractWikiLinkTargets(heading.heading);
        if (
          wikiTargets.some((target) => {
            const destination = app.metadataCache.getFirstLinkpathDest(target, file.path);
            return destination
              ? normalizeTaskPath(destination.path) === normalizedTaskPath
              : normalizeTaskKey(target) === taskKey;
          })
        ) return true;
        return wikiTargets.length === 0 && normalizeTaskKey(heading.heading) === taskKey;
      };

      const hasMention = cache.headings.some(headingMatchesTask);
      if (!hasMention) continue;

      const fileContent = await app.vault.cachedRead(file);
      const headings = cache.headings;
      const lines = fileContent.split("\n");

      let fileIsStale = false;
      for (let i = 0; i < headings.length; i++) {
        const currentHeading = headings[i];
        if (!headingMatchesTask(currentHeading)) continue;

        // Кэш метаданных мог не успеть обновиться после записи файла: по позициям заголовков,
        // ограничивающих секцию, в тексте лежит уже другое. Такие данные не показываем
        // (см. renderTaskView), но собираем - для первой отрисовки лучше приблизительный результат, чем пустой блок.
        const boundary = headings.slice(i + 1).find((h) => h.level <= currentHeading.level);
        if (!headingMatchesContent(fileContent, currentHeading) || (boundary && !headingMatchesContent(fileContent, boundary))) {
          fileIsStale = true;
        }

        const sectionSubHeadings: { text: string; level: number; line: number }[] = [];
        for (let j = i + 1; j < headings.length && headings[j].level > currentHeading.level; j++) {
          const nextHeading = headings[j];
          sectionSubHeadings.push({
            text: nextHeading.heading.replace(/#/g, "").trim(),
            level: nextHeading.level - currentHeading.level,
            line: nextHeading.position.start.line,
          });
        }

        const contentStartOffset = currentHeading.position.end.offset + 1;
        let contentEndOffset = fileContent.length;
        for (let k = i + 1; k < headings.length; k++) {
          if (headings[k].level <= currentHeading.level) {
            contentEndOffset = headings[k].position.start.offset;
            break;
          }
        }

        const content = fileContent
          .substring(contentStartOffset, contentEndOffset)
          .replace(/^\n+/, "")
          .replace(/\n+$/, "");
        const formattedDate = file.basename.replace(/\.md$/i, "");
        const anchor = headingToAnchor(currentHeading.heading);
        const dateLink = `[[${file.path}#${anchor}|${formattedDate}]]`;
        const headingLine =
          lines[currentHeading.position.start.line] ?? `### [[${headingToAnchor(currentHeading.heading)}]]`;

        preliminary.push({
          date: formattedDate,
          dateLink,
          subHeadings: sectionSubHeadings,
          content,
          sourcePath: file.path,
          headingLine,
          line: currentHeading.position.start.line,
        });
      }
      if (fileIsStale) staleFiles.push(file.path);
    }

    return { preliminary, staleFiles };
  }

  /** Присвоить стабильные id записям и подзаголовкам. */
  private buildEntries(preliminary: PreliminaryEntry[], idPrefix: string): TaskViewEntry[] {
    return preliminary.map((item, index) => {
      const id = `${idPrefix}-block-${index}`;
      return {
        id,
        dateLink: item.dateLink,
        date: item.date,
        subHeadings: item.subHeadings.map((subH, subIndex) => ({ ...subH, id: `${id}-h-${subIndex}` })),
        content: item.content,
        sourcePath: item.sourcePath,
        headingLine: item.headingLine,
        line: item.line,
      };
    });
  }

  /**
   * Пункты «Оглавления» записей о задаче - для панели «Структура». Те же данные и правила, что у блока
   * (buildTocEntries), плюс то, что нужно для перехода: ключ записи в DOM блока, номер подзаголовка
   * и строка заголовка в ежедневной заметке. Не зависит от того, отрисован ли блок сейчас.
   */
  async getTocItems(taskPath: string): Promise<{ items: OutlineTocItem[]; stale: boolean }> {
    const file = this.ctx.app.vault.getAbstractFileByPath(taskPath);
    if (!(file instanceof TFile)) return { items: [], stale: false };
    const { preliminary, staleFiles } = await this.fetchTaskViewData(file.basename, file.path);
    const entries = this.buildEntries(preliminary, "toc");
    const keys = entries.map((entry) => entryKeyOf(entry));
    const items = buildTocEntries(entries).map((toc) => {
      const entry = entries[toc.entryIndex];
      const sub = toc.subIndex == null ? null : entry.subHeadings[toc.subIndex];
      const key = sub ? headingMatchKey(sub.text) : "";
      const occurrence =
        sub && toc.subIndex != null
          ? entry.subHeadings.slice(0, toc.subIndex).filter((h) => headingMatchKey(h.text) === key).length
          : 0;
      return {
        text: toc.text,
        level: toc.level,
        dateText: toc.dateText,
        isDateOnly: toc.isDateOnly,
        entryKey: keys[toc.entryIndex],
        entryOrdinal: keys.slice(0, toc.entryIndex).filter((key) => key === keys[toc.entryIndex]).length,
        subIndex: toc.subIndex,
        occurrence,
        sourcePath: entry.sourcePath,
        line: sub?.line ?? entry.line ?? null,
      };
    });
    return { items, stale: staleFiles.length > 0 };
  }

  /**
   * Блоки задачи, отрисованные в редакторе Live Preview с этой областью прокрутки (cm-scroller): видимые и
   * временно убранные из DOM (далеко от экрана - Obsidian держит их отрисованными и вернёт на место).
   * line - строка открывающего ``` блока в заметке, если Obsidian её сообщил. Для поиска Ctrl+F по записям.
   */
  getEditorBlocks(scroller: HTMLElement): { el: HTMLElement; line: number | null }[] {
    const result: { el: HTMLElement; line: number | null }[] = [];
    const seen = new Set<HTMLElement>();
    for (const el of Array.from(scroller.querySelectorAll<HTMLElement>(".opa-task-view"))) {
      seen.add(el);
      result.push({ el, line: this.blockLine(el) });
    }
    for (const el of this.taskViewBlocks) {
      if (seen.has(el) || el.isConnected) continue;
      if (this.blockHosts.get(el)?.scroller !== scroller) continue;
      result.push({ el, line: this.blockLine(el) });
    }
    return result;
  }

  /** Блок уже отрисован хотя бы раз (записи или «Нет заметок» на месте). */
  isBlockRendered(el: HTMLElement): boolean {
    return this.blockState.get(el)?.signature != null;
  }

  /** Строка открывающего ``` блока по контексту процессора; null - неизвестна. */
  private blockLine(el: HTMLElement): number | null {
    try {
      const info = this.blockHosts.get(el)?.ctx.getSectionInfo?.(el);
      return info && Number.isInteger(info.lineStart) ? info.lineStart : null;
    } catch {
      return null;
    }
  }

  private async renderTaskView(
    container: HTMLElement,
    currentFilePath: string,
    taskName: string,
    options: { force?: boolean; useLocalData?: boolean } = {}
  ): Promise<void> {
    const inFlight = this.rendering.get(container);
    if (inFlight) {
      this.pendingRender.set(container, Boolean(options.force) || Boolean(this.pendingRender.get(container)));
      return inFlight;
    }
    let finishRender!: () => void;
    this.rendering.set(container, new Promise<void>((resolve) => { finishRender = resolve; }));
    this.pendingRender.delete(container);

    const state = this.getState(container);
    if (!state.idPrefix) state.idPrefix = `tv-${++idCounter}`;
    if (state.staleRetryTimer) {
      clearTimeout(state.staleRetryTimer);
      state.staleRetryTimer = null;
    }

    try {
      let structuredData: TaskViewEntry[];
      let flatTocEntries: TocEntry[];
      if (options.useLocalData && state.structuredData) {
        structuredData = state.structuredData;
        flatTocEntries = state.flatTocEntries ?? buildTocEntries(structuredData);
      } else {
        const { preliminary, staleFiles } = await this.fetchTaskViewData(taskName, currentFilePath);
        if (staleFiles.length > 0 && state.structuredData && (state.staleRetries ?? 0) < MAX_STALE_RETRIES) {
          // Данные с диска противоречивы - оставляем текущий DOM и пробуем позже
          // (событие metadataCache.changed по этому файлу тоже вызовет обновление).
          state.staleRetries = (state.staleRetries ?? 0) + 1;
          state.staleRetryTimer = setTimeout(() => {
            state.staleRetryTimer = null;
            // Фоновое обновление: учитывает открытое редактирование/выделение и пропускает неизменившиеся блоки
            this.registry.scheduleRefresh();
          }, STALE_CACHE_RETRY_MS);
          return;
        }
        state.staleRetries = 0;
        structuredData = this.buildEntries(preliminary, state.idPrefix);
        flatTocEntries = buildTocEntries(structuredData);
      }

      const signature = taskViewSignature(structuredData);
      if (!options.force && !options.useLocalData && state.structuredData && isRenderUnchanged(container, signature)) {
        // Данные не изменились - DOM (выделение, прокрутка, раскрытые записи) остаётся как есть.
        // Объекты записей обновляем на месте: на них ссылаются обработчики отрисованного DOM.
        if (state.structuredData.length === structuredData.length) {
          structuredData.forEach((fresh, i) => Object.assign(state.structuredData![i], fresh, { id: state.structuredData![i].id }));
        } else {
          state.structuredData = structuredData;
        }
        state.flatTocEntries = flatTocEntries;
        return;
      }

      state.structuredData = structuredData;
      state.flatTocEntries = flatTocEntries;
      if (!state.listenersAttached) {
        container.addEventListener("copy", this.handleSmartCopy);
        container.addEventListener("cut", this.handleSmartCopy);
        container.addEventListener("contextmenu", this.handleTaskViewContextMenu);
        container.addEventListener("click", this.handleInternalLinkClick);
        state.listenersAttached = true;
      }

      const prevDetails = Array.from(container.querySelectorAll<HTMLDetailsElement>("details.task-view-entry"));
      const prevEntryCount = prevDetails.length;
      const openEntryIndices = new Set(
        prevDetails
          .filter((d) => d.hasAttribute("open"))
          .map((d) => d.getAttribute("data-entry-index"))
          .filter((x): x is string => x != null)
      );
      const prevKeys = prevDetails
        .map((d) => d.getAttribute("data-entry-key"))
        .filter((x): x is string => Boolean(x));
      const hasPrevKeys = prevKeys.length > 0;
      const prevKeySet = new Set(prevKeys);
      const openKeySet = new Set(
        prevDetails
          .filter((d) => d.hasAttribute("open"))
          .map((d) => d.getAttribute("data-entry-key"))
          .filter((x): x is string => Boolean(x))
      );
      const buildEntryKey = entryKeyOf;

      const doc = container.ownerDocument;
      const tempContainer = doc.createElement("div");

      state.component?.unload();
      const component = new Component();
      component.load();
      state.component = component;

      if (structuredData.length === 0) {
        tempContainer.createEl("p", { text: UI_LABELS.tasks.noNotes, cls: "pv-empty-message" });
      } else {
        if (flatTocEntries.length > 0) {
          const tocDetails = tempContainer.createEl("details", {
            cls: "callout",
            attr: { "data-callout": "toc", open: "" },
          });
          const summary = tocDetails.createEl("summary", { cls: "task-view-summary" });
          const titleContainer = summary.createDiv();
          const calloutTitle = titleContainer.createDiv({ cls: "callout-title" });
          calloutTitle.createDiv({ cls: "callout-icon", text: "✏️" });
          calloutTitle.createDiv({ cls: "callout-title-inner", text: "Оглавление" });
          const tocCollapseBtn = summary.createEl("button", {
            cls: "task-view-collapse-button",
            text: "▼",
          });
          tocCollapseBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            tocDetails.toggleAttribute("open");
            tocCollapseBtn.textContent = tocDetails.hasAttribute("open") ? "▼" : "◀";
          });
          summary.addEventListener("click", (e) => {
            const t = e.target as HTMLElement;
            if (t.closest("button")) return;
            if (t.closest("a")) return;
            e.preventDefault();
            e.stopPropagation();
          });
          const content = tocDetails.createDiv({ cls: "callout-content" });
          const tocList = content.createEl("ul", { cls: "task-toc-list" });
          this.fillTocList(tocList, flatTocEntries, container);
        }

        for (let index = 0; index < structuredData.length; index++) {
          const entry = structuredData[index];
          const entryKey = buildEntryKey(entry);
          const isNewEntry = hasPrevKeys ? !prevKeySet.has(entryKey) : index >= prevEntryCount;
          const isOpen = hasPrevKeys
            ? openKeySet.has(entryKey) || isNewEntry
            : openEntryIndices.size > 0
              ? openEntryIndices.has(String(index)) || isNewEntry
              : true;
          const detailsEl = tempContainer.createEl("details", {
            cls: "task-view-entry",
            attr: {
              ...(isOpen ? { open: "" } : {}),
              "data-entry-index": String(index),
              "data-entry-key": entryKey,
              "data-source-path": entry.sourcePath,
              "data-task-view-content": "1",
            },
          });
          detailsEl.id = entry.id;

          const summary = detailsEl.createEl("summary", { cls: "task-view-summary" });
          const summaryTitle = summary.createDiv({ cls: "task-view-summary-title" });
          await MarkdownRenderer.render(
            this.ctx.app,
            `**${entry.dateLink}**`,
            summaryTitle,
            currentFilePath,
            component
          );
          const actionsDiv = summary.createDiv({ cls: "task-view-summary-actions" });
          const collapseBtn = actionsDiv.createEl("button", {
            cls: "task-view-summary-button task-view-collapse-button",
            text: isOpen ? "▼" : "◀",
            attr: { type: "button" },
          });
          collapseBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            detailsEl.toggleAttribute("open");
            collapseBtn.textContent = detailsEl.hasAttribute("open") ? "▼" : "◀";
          });
          summary.addEventListener("click", (e) => {
            const t = e.target as HTMLElement;
            if (t.closest(".task-view-summary-button")) return;
            if (t.closest("a")) return;
            e.preventDefault();
            e.stopPropagation();
          });

          const embedContentDiv = detailsEl.createDiv({ cls: "markdown-embed-content" });
          const displayDiv = embedContentDiv.createDiv({ cls: "markdown-preview-view markdown-rendered task-view-display" });
          await this.renderEntryDisplay(displayDiv, entry, component);

          const editWrap = detailsEl.createDiv({ cls: "task-view-edit-wrap" });
          editWrap.style.display = "none";
          const textareaEl = editWrap.createEl("textarea", {
            cls: "task-view-edit",
            attr: { rows: "12", "aria-label": UI_LABELS.common.edit },
          });
          textareaEl.value = entry.content ?? "";
          const saveBtn = editWrap.createEl("button", {
            cls: "task-view-save-button",
            text: UI_LABELS.common.save,
            attr: { type: "button" },
          });
          const doSave = (): void => {
            this._removeEditListeners?.();
            this.saveSectionEdit(container, index, textareaEl).then(() => {});
          };
          saveBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            doSave();
          });
        }

        this.setupImageResizer(container, structuredData);
      }

      container.empty();
      container.append(...Array.from(tempContainer.childNodes));
      markRendered(container, signature);
      state.signature = signature;
    } catch (e) {
      container.empty();
      container.createEl("p", { text: UI_LABELS.errors.renderShort, cls: "view-error" });
      console.error(e);
    } finally {
      this.rendering.delete(container);
      finishRender();
      if (this.pendingRender.has(container)) {
        const force = this.pendingRender.get(container) ?? false;
        this.pendingRender.delete(container);
        const path = container.getAttribute(DATA_PATH);
        const name = container.getAttribute(DATA_NAME);
        if (path && name) void this.renderTaskView(container, path, name, { force });
      }
    }
  }

  /** Пункты оглавления: клик прокручивает к записи/подзаголовку по id. */
  private fillTocList(tocList: HTMLElement, flatTocEntries: TocEntry[], container: HTMLElement): void {
    tocList.empty();
    for (const entry of flatTocEntries) {
      const li = tocList.createEl("li");
      li.style.marginLeft = `${(entry.level - 1) * 1.5}em`;
      const a = li.createEl("a", {
        text: entry.isDateOnly ? entry.text : `${entry.text} (${entry.dateText})`,
        href: "#",
      });
      a.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const target = container.querySelector(`[id="${entry.id}"]`);
        if (target) target.scrollIntoView({ behavior: "auto", block: "start" });
      });
    }
  }

  /**
   * Отрисовать содержимое записи в её превью: markdown → DOM, разметка отступов у заголовков и кода
   * (для копирования и стилей), id подзаголовков для оглавления. Повторный вызов на том же элементе
   * заменяет содержимое (после сохранения правки перерисовывается только эта запись, а не весь блок).
   */
  private async renderEntryDisplay(displayDiv: HTMLElement, entry: TaskViewEntry, parent: Component): Promise<void> {
    const previous = this.entryComponents.get(displayDiv);
    if (previous) parent.removeChild(previous);
    const component = parent.addChild(new Component());
    this.entryComponents.set(displayDiv, component);
    displayDiv.empty();

    const content = entry.content || "";
    const contentToRender = content.replace(/^(=+)/gm, "\u200B$1").replace(/^(\d+)\|/gm, "$1\u200B|");
    await MarkdownRenderer.render(this.ctx.app, contentToRender, displayDiv, entry.sourcePath, component);

    const blankAfterHeadings = this.headingBlankAfterInSource(content);
    const allHeadingsInDisplay = Array.from(
      displayDiv.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
    ).filter((h) => !h.closest(".internal-embed"));
    allHeadingsInDisplay.forEach((hEl, idx) => {
      hEl.setAttribute("data-after-blank", blankAfterHeadings[idx] ? "1" : "0");
    });

    const blankAfterPre = this.getPreBlankAfterInSource(content);
    const blankBeforePre = this.getPreBlankBeforeInSource(content);
    const applyPreLayoutAttrs = (): void => {
      const list = Array.from(displayDiv.querySelectorAll<HTMLPreElement>("pre")).filter(
        (p) => !p.closest(".internal-embed")
      );
      list.forEach((preEl, idx) => {
        const before = idx < blankBeforePre.length ? (blankBeforePre[idx] ? "1" : "0") : "1";
        const after = idx < blankAfterPre.length ? (blankAfterPre[idx] ? "1" : "0") : "1";
        preEl.setAttribute("data-before-blank", before);
        preEl.setAttribute("data-after-blank", after);
        this.mirrorPreLayoutAttrsOnPreWrapper(preEl, before, after);
      });
    };
    applyPreLayoutAttrs();
    const win = displayDiv.ownerDocument.defaultView ?? window;
    win.requestAnimationFrame(() => applyPreLayoutAttrs());
    win.setTimeout(() => applyPreLayoutAttrs(), 120);

    if (entry.subHeadings.length > 0) {
      const renderedHeadings = displayDiv.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6");
      renderedHeadings.forEach((hEl) => {
        const hText = hEl.textContent?.trim() ?? "";
        const matching = entry.subHeadings.find((subH) => subH.text === hText);
        if (matching) hEl.id = matching.id;
      });
    }
  }

  /** Обновить подпись после локального изменения данных (чтобы фоновый рефреш с теми же данными не перерисовывал блок). */
  private commitLocalData(container: HTMLElement): void {
    const state = this.blockState.get(container);
    if (!state?.structuredData) return;
    const signature = taskViewSignature(state.structuredData);
    state.signature = signature;
    markRendered(container, signature);
  }

  /** Массив флагов: после каждого блока кода была ли пустая строка в исходном Markdown. */
  private getPreBlankAfterInSource(rawContent: string): boolean[] {
    if (!rawContent || typeof rawContent !== "string") return [];
    const result: boolean[] = [];
    const lines = rawContent.split("\n");
    let inCodeBlock = false;
    let codeBlockMarker = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!inCodeBlock) {
        const match = line.match(/^([ \t]*)(`{3,}|~{3,})/);
        if (match) {
          inCodeBlock = true;
          codeBlockMarker = match[2];
        }
      } else {
        if (line.trim().startsWith(codeBlockMarker)) {
          inCodeBlock = false;
          const j = i + 1;
          const isBlank = j < lines.length ? lines[j].trim() === "" : true;
          result.push(isBlank);
        }
      }
    }
    return result;
  }

  /** Массив флагов: перед каждым блоком кода (строка с открывающими ```) была ли пустая строка в исходнике. */
  private getPreBlankBeforeInSource(rawContent: string): boolean[] {
    if (!rawContent || typeof rawContent !== "string") return [];
    const result: boolean[] = [];
    const lines = rawContent.split("\n");
    let inCodeBlock = false;
    let codeBlockMarker = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!inCodeBlock) {
        const match = line.match(/^([ \t]*)(`{3,}|~{3,})/);
        if (match) {
          const prev = i > 0 ? lines[i - 1].trim() === "" : false;
          result.push(prev);
          inCodeBlock = true;
          codeBlockMarker = match[2];
        }
      } else if (line.trim().startsWith(codeBlockMarker)) {
        inCodeBlock = false;
      }
    }
    return result;
  }

  /**
   * Prism/Obsidian часто пересоздаёт `pre` и сбрасывает data-*; родительский div (например .el-pre) обычно стабилен.
   */
  private mirrorPreLayoutAttrsOnPreWrapper(
    preEl: HTMLPreElement,
    beforeBlank: string,
    afterBlank: string
  ): void {
    const parent = preEl.parentElement;
    if (!parent || parent.tagName !== "DIV") return;
    if (parent.classList.contains("markdown-preview-section")) return;
    const taskRoot = preEl.closest(".task-view-display");
    if (!taskRoot || parent === taskRoot) return;
    const pres = parent.querySelectorAll(":scope > pre");
    if (pres.length !== 1 || pres[0] !== preEl) return;
    parent.setAttribute("data-before-blank", beforeBlank);
    parent.setAttribute("data-after-blank", afterBlank);
  }

  /** Массив флагов: после каждого заголовка была ли пустая строка в исходном Markdown. */
  private headingBlankAfterInSource(rawContent: string): boolean[] {
    if (!rawContent || typeof rawContent !== "string") return [];
    const result: boolean[] = [];
    const lines = rawContent.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/^#+\s+/.test(lines[i])) {
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") j++;
        result.push(j > i + 1);
      }
    }
    return result;
  }

  /** Обработчик клика по внутренним ссылкам [[...]] в блоке просмотра задачи. */
  private handleInternalLinkClick = (ev: MouseEvent): void => {
    const link = (ev.target as HTMLElement)?.closest?.("a.internal-link") as HTMLAnchorElement | null;
    if (!link || !ev.currentTarget) return;
    const container = ev.currentTarget as HTMLElement;
    if (!container.contains(link)) return;

    let href = (link.getAttribute("data-href") || link.getAttribute("href") || "").trim();
    if (!href) return;
    if (href.startsWith("app://")) {
      href = decodeURIComponent(href.split("/").pop() || href).split("?")[0];
    }
    if (!href || /^[\w+.-]+:/.test(href)) return;

    ev.preventDefault();
    ev.stopPropagation();
    const sourcePath =
      link.closest("[data-source-path]")?.getAttribute("data-source-path") ||
      container.getAttribute(DATA_PATH) ||
      "";
    this.ctx.app.workspace.openLinkText(href, sourcePath, false);
  };

  // ========================================================================
  // КОНТЕКСТНОЕ МЕНЮ: «КОПИРОВАТЬ», «ИЗМЕНИТЬ»
  // ========================================================================

  private handleTaskViewContextMenu = (ev: MouseEvent): void => {
    const displayDiv = (ev.target as HTMLElement)?.closest?.(".task-view-display") as HTMLElement | null;
    if (!displayDiv || !ev.currentTarget) return;
    const container = ev.currentTarget as HTMLElement;
    if (!container.contains(displayDiv)) return;

    ev.preventDefault();
    const doc = container.ownerDocument;
    const detailsEl = displayDiv.closest("details.task-view-entry") as HTMLElement | null;
    const entry = this.entryForDetails(container, detailsEl);
    const { targetText, isImage } = this.getTargetTextAtPoint(displayDiv, ev.clientX, ev.clientY);
    const imgForMarkdownCopy = this.getImageElementAtPoint(displayDiv, ev.clientX, ev.clientY);
    const atPoint = doc.elementFromPoint(ev.clientX, ev.clientY);
    const blockEl = displayDiv.contains(atPoint) ? findRenderedBlock(displayDiv, atPoint) : null;
    // Текст выделения считаем сразу: клик по пункту меню может снять выделение
    let selectionText: string | null = null;
    let blockRange: LineRange | null = null;
    try {
      selectionText = this.getCopyTextForSelection(container);
      if (blockEl && entry) blockRange = sourceRangeForBlock(blockEl, displayDiv, entry.content);
    } catch (error) {
      console.error("[TaskView] copy text failed:", error);
    }
    const state = this.getState(container);
    state.lastContextMenu = {
      displayDiv,
      detailsEl,
      targetText,
      isImage,
      selectionText,
      imgForMarkdownCopy,
      blockEl,
      clientY: ev.clientY,
      blockRange,
    };

    const menu = new Menu();
    menu.addItem((item) => {
      item.setTitle(UI_LABELS.common.copy)
        .setIcon("copy")
        .onClick(() => {
          const data = state.lastContextMenu;
          state.lastContextMenu = null;
          if (!data) return;
          let text: string | null = data.selectionText;
          try {
            if (!text && data.imgForMarkdownCopy) {
              text = this.copyPartFromImg(data.imgForMarkdownCopy);
            }
            if (!text && data.blockEl) {
              text = buildCopyTextForBlock(data.blockEl, data.displayDiv, entry?.content ?? "");
            }
          } catch (error) {
            console.error("[TaskView] copy text failed:", error);
          }
          void this.copyToClipboard(doc, text);
        });
    });
    if (imgForMarkdownCopy) {
      // Сама картинка (PNG) в системный буфер - как «Copy image» в Obsidian: вставляется вне Obsidian
      menu.addItem((item) => {
        item.setTitle(UI_LABELS.common.copyImage)
          .setIcon("image")
          .onClick(() => {
            const data = state.lastContextMenu;
            state.lastContextMenu = null;
            const img = data?.imgForMarkdownCopy;
            if (!img) return;
            const sourcePath = entry?.sourcePath ?? container.getAttribute(DATA_PATH) ?? "";
            void this.copyImageToClipboard(img, sourcePath);
          });
      });
    }
    menu.addItem((item) => {
      item.setTitle(UI_LABELS.common.edit)
        .setIcon("pencil")
        .onClick(() => {
          const data = state.lastContextMenu;
          state.lastContextMenu = null;
          if (!data) return;
          const target = data.detailsEl ?? (data.displayDiv.closest("details.task-view-entry") as HTMLElement | null);
          if (!target) return;
          this.openEditForEntry(container, target, {
            targetText: data.targetText,
            isImage: data.isImage,
            clientY: data.clientY,
            blockRange: data.blockRange,
          });
        });
    });
    menu.showAtMouseEvent(ev);
  };

  /** Запись (данные), к которой относится элемент details. */
  private entryForDetails(container: HTMLElement, detailsEl: HTMLElement | null): TaskViewEntry | null {
    if (!detailsEl) return null;
    const index = parseInt(detailsEl.dataset.entryIndex ?? "-1", 10);
    return this.blockState.get(container)?.structuredData?.[index] ?? null;
  }

  /** Положить картинку превью в буфер обмена как изображение, с уведомлением о результате. */
  private async copyImageToClipboard(img: HTMLImageElement, sourcePath: string): Promise<boolean> {
    let ok = false;
    try {
      ok = await copyImageToClipboard(this.ctx.app, img, sourcePath);
    } catch (error) {
      console.error("[TaskView] copy image failed:", error);
    }
    new Notice(ok ? UI_LABELS.common.imageCopied : UI_LABELS.errors.copyImageFailed);
    return ok;
  }

  /** Записать текст в буфер обмена с уведомлением о результате (никогда не молчим). */
  private async copyToClipboard(doc: Document, text: string | null): Promise<boolean> {
    if (text == null || text === "") {
      new Notice(UI_LABELS.common.nothingToCopy);
      return false;
    }
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (error) {
      console.warn("[TaskView] navigator.clipboard failed, falling back to execCommand:", error);
    }
    if (!ok) {
      try {
        const textarea = doc.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        textarea.style.pointerEvents = "none";
        doc.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        ok = doc.execCommand("copy");
        textarea.remove();
      } catch (error) {
        console.error("[TaskView] clipboard fallback failed:", error);
      }
    }
    new Notice(ok ? UI_LABELS.common.copied : UI_LABELS.errors.copyFailed);
    return ok;
  }

  /**
   * Открыть секцию в режиме редактирования: разворот на полную (details open, textarea по высоте контента).
   * Курсор ставится на блок под мышью, а строка под курсором остаётся на той же высоте экрана -
   * страница не прыгает (раньше `focus()` уводил вид к концу textarea, т.е. к концу записи).
   * Выход: Escape или клик снаружи.
   */
  private openEditForEntry(container: HTMLElement, detailsEl: HTMLElement, scrollData?: EditOpenOptions): void {
    const index = parseInt(detailsEl.dataset.entryIndex ?? "0", 10);
    const editWrap = detailsEl.querySelector<HTMLElement>(".task-view-edit-wrap");
    const previewWrap = detailsEl.querySelector<HTMLElement>(".markdown-embed-content");
    const textarea = detailsEl.querySelector<HTMLTextAreaElement>(".task-view-edit");
    if (!editWrap || !previewWrap || !textarea) return;

    const structuredData = this.blockState.get(container)?.structuredData;
    const entry = structuredData?.[index];
    if (!entry) return;

    if (this.activeEditRef && this.activeEditRef.editWrap !== editWrap) {
      this._removeEditListeners?.();
      this.activeEditRef.closeUI();
      this.activeEditRef = null;
    }

    // Точка на экране, которую держим неподвижной: клик мышью или верх превью
    const scroller = findScrollContainer(detailsEl);
    const previewRect = previewWrap.getBoundingClientRect();
    const anchorY = scrollData?.clientY ?? previewRect.top;
    const ratio =
      previewRect.height > 0 ? Math.min(1, Math.max(0, (anchorY - previewRect.top) / previewRect.height)) : 0;

    detailsEl.setAttribute("open", "");
    const collapseBtn = detailsEl.querySelector<HTMLElement>(".task-view-collapse-button");
    if (collapseBtn) collapseBtn.textContent = "▼";

    previewWrap.style.display = "none";
    editWrap.style.display = "block";
    textarea.value = entry.content ?? "";
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight + 10}px`;

    const doSave = (): void => {
      this._removeEditListeners?.();
      this.saveSectionEdit(container, index, textarea).then(() => {});
    };
    const closeUI = (): void => {
      editWrap.style.display = "none";
      previewWrap.style.display = "block";
    };

    const doc = container.ownerDocument;
    const removeListeners = (): void => {
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("mousedown", onMouse, true);
      this.activeEditRef = null;
      this._removeEditListeners = undefined;
    };
    this._removeEditListeners = removeListeners;
    this.activeEditRef = { editWrap, doSave, closeUI };

    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape" && this.activeEditRef) {
        ev.preventDefault();
        ev.stopPropagation();
        this.activeEditRef.doSave();
      }
    };
    const onMouse = (ev: MouseEvent): void => {
      if (!this.activeEditRef) return;
      const target = ev.target as Node;
      if (this.activeEditRef.editWrap.contains(target)) return;
      const el = ev.target as HTMLElement;
      const rect = el.getBoundingClientRect();
      const clickX = ev.clientX - rect.left;
      const clickY = ev.clientY - rect.top;
      const hitVerticalScrollbar = el.offsetWidth > el.clientWidth && clickX >= el.clientWidth;
      const hitHorizontalScrollbar = el.offsetHeight > el.clientHeight && clickY >= el.clientHeight;
      if (hitVerticalScrollbar || hitHorizontalScrollbar) return;
      const isRightEdge = rect.width - clickX <= 20;
      const win = doc.defaultView ?? window;
      const isWindowScrollbar = win.innerWidth - ev.clientX <= 20;
      if ((el.scrollHeight > el.clientHeight && isRightEdge) || isWindowScrollbar) return;
      this.activeEditRef.doSave();
    };
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("mousedown", onMouse, true);

    const caret = locateEditCaret(textarea.value, scrollData, ratio);
    try {
      textarea.setSelectionRange(caret.pos, caret.pos + caret.length);
    } catch {
      // старые окружения без поддержки - не критично
    }
    focusWithoutScroll(textarea);
    if (scroller) keepCaretAtScreenY(textarea, scroller, caret.pos, anchorY);
  }

  /** Картинка под координатами в превью задачи (для копирования с ПКМ и т.п.). */
  private getImageElementAtPoint(displayDiv: HTMLElement, clientX: number, clientY: number): HTMLImageElement | null {
    const raw = displayDiv.ownerDocument.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (!raw || !displayDiv.contains(raw)) return null;
    if (raw.tagName === "IMG") return raw as HTMLImageElement;
    const embed = raw.closest(".internal-embed");
    if (embed && displayDiv.contains(embed)) {
      const inner = embed.querySelector("img");
      if (inner) return inner;
    }
    const closestImg = raw.closest("img");
    return closestImg && displayDiv.contains(closestImg) ? (closestImg as HTMLImageElement) : null;
  }

  /** Текст под курсором в превью (для скролла к месту при переходе в редактирование). */
  private getTargetTextAtPoint(
    displayDiv: HTMLElement,
    clientX: number,
    clientY: number
  ): { targetText: string; isImage: boolean } {
    let targetText = "";
    let isImage = false;
    const doc = displayDiv.ownerDocument;
    const rawAtPoint = doc.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const atPoint = rawAtPoint && displayDiv.contains(rawAtPoint) ? rawAtPoint : null;
    const embedEl = atPoint?.closest?.(".internal-embed");
    const imgEl = atPoint?.tagName === "IMG" ? (atPoint as HTMLImageElement) : null;

    if (embedEl || imgEl) {
      const el = (embedEl ?? imgEl) as HTMLElement & { src?: string };
      isImage = true;
      const alt = el.getAttribute?.("alt");
      const srcAttr = el.getAttribute?.("src") ?? (el as HTMLImageElement).src ?? "";
      targetText = (alt || srcAttr || "").trim();
      const imgForName = this.getImageElementAtPoint(displayDiv, clientX, clientY);
      if (!targetText && imgForName) {
        const src = imgForName.getAttribute("src") || "";
        targetText = decodeURIComponent((src.split("/").pop() || src).split("?")[0] || "");
      }
    } else if (doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(clientX, clientY);
      if (range?.startContainer && displayDiv.contains(range.startContainer)) {
        targetText =
          range.startContainer.nodeType === 3
            ? (range.startContainer.nodeValue || "")
            : (range.startContainer as Element).textContent || "";
      }
    }
    if (!isImage && !targetText && atPoint) targetText = (atPoint as HTMLElement).textContent || "";
    targetText = normalizeText(targetText);
    return { targetText, isImage };
  }

  // ========================================================================
  // УМНОЕ КОПИРОВАНИЕ (SMART COPY)
  // ========================================================================

  /**
   * Ctrl+C / Ctrl+X внутри блока: подменяем текст в буфере на markdown из исходника.
   * Если посчитать нечего - не мешаем стандартному копированию (буфер никогда не остаётся пустым).
   */
  private handleSmartCopy = (e: ClipboardEvent): void => {
    const container = e.currentTarget as HTMLElement;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("textarea, input")) return;
    // Редактируемая область (не считая contenteditable="false" виджетов Live Preview) - стандартное поведение
    const editable = target?.closest?.("[contenteditable]");
    if (editable && editable !== container && !container.contains(editable) && editable.getAttribute("contenteditable") !== "false") return;
    let text: string | null = null;
    try {
      text = this.getCopyTextForSelection(container);
    } catch (error) {
      console.error("[TaskView] copy text failed:", error);
      return;
    }
    if (!text || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text);
  };

  /**
   * Текст для копирования по текущему выделению в task-view.
   * null - выделение пустое, вне контента записей или в поле редактирования (стандартное поведение).
   */
  private getCopyTextForSelection(container: HTMLElement): string | null {
    const doc = container.ownerDocument;
    const sel = doc.defaultView?.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return null;
    const startEl =
      range.startContainer.nodeType === 1
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    if (startEl?.closest("textarea, input, .task-view-edit-wrap")) return null;
    return this.buildCopyTextForContainerRange(container, range);
  }

  /** Собрать текст по диапазону, проходящему через одну или несколько записей блока. */
  private buildCopyTextForContainerRange(container: HTMLElement, range: Range): string | null {
    const entries = Array.from(container.querySelectorAll<HTMLElement>("details.task-view-entry")).filter((d) =>
      range.intersectsNode(d)
    );
    if (entries.length === 0) return null;
    const parts: string[] = [];
    for (const detailsEl of entries) {
      const entry = this.entryForDetails(container, detailsEl);
      const display = detailsEl.querySelector<HTMLElement>(".task-view-display");
      const title = detailsEl.querySelector<HTMLElement>(".task-view-summary-title");
      let part = "";
      if (display) {
        const clipped = clipRangeToElement(range, display);
        if (clipped && (visibleTextOfRange(clipped) !== "" || rangeHasEmbed(clipped))) {
          part = buildCopyTextForRange(clipped, display, entry?.content ?? "");
          if (!part) part = normalizeText(clipped.toString());
        }
      }
      let titleLine = "";
      if (entry && title) {
        const clippedTitle = clipRangeToElement(range, title);
        if (clippedTitle && visibleTextOfRange(clippedTitle) !== "") titleLine = `**${entry.dateLink}**`;
      }
      if (titleLine) parts.push(part ? `${titleLine}\n\n${part}` : titleLine);
      else if (part) parts.push(part);
    }
    return parts.length ? parts.join("\n\n") : null;
  }

  private copyPartFromImg(img: HTMLImageElement): string {
    const embed = img.closest(".internal-embed");
    if (embed) return embedMarkdown(embed);
    const parent = img.parentElement;
    let path =
      parent && parent.tagName === "A"
        ? (parent.getAttribute("data-href") || parent.getAttribute("href") || "").trim()
        : "";
    if (!path || /^[\w+.-]+:/.test(path)) {
      try {
        const src = (img.getAttribute("src") || "").trim();
        path = src ? decodeURIComponent(src.split("/").pop() || src) : "";
      } catch {
        path = "";
      }
    }
    if (!path && img.getAttribute("alt")) path = img.getAttribute("alt")?.trim() || "";
    if (path) path = path.split("?")[0].split("#")[0].trim();
    return path ? `![[${path}]]` : "";
  }

  // ========================================================================
  // Ресайзинг картинок
  // ========================================================================

  private setupImageResizer(container: HTMLElement, structuredData: TaskViewEntry[]): void {
    const state = this.getState(container);
    state.imageResizeCleanup?.();
    state.imageResizeCleanup = undefined;

    const RESIZE_ZONE_PX = 14;
    const MIN_WIDTH = 50;
    const MAX_WIDTH = 1500;
    const doc = container.ownerDocument;

    const getImageContext = (target: EventTarget | null) => {
      if (!target || !(target instanceof HTMLElement)) return null;
      const imgEl = target.tagName === "IMG" ? target : null;
      const embedEl = target.closest(".internal-embed");
      if (!imgEl && !embedEl) return null;
      const root = (embedEl as HTMLElement) || imgEl!;
      const embed = (embedEl as HTMLElement) || imgEl!.closest(".internal-embed");
      const img = imgEl || (embed && embed.querySelector("img"));
      if (!img) return null;
      const detailsEl = root.closest("details.task-view-entry") as HTMLElement | null;
      if (!detailsEl) return null;
      const entryIndex = detailsEl.dataset.entryIndex;
      if (entryIndex == null) return null;
      const targetEl = (embed as HTMLElement) || img;
      const sizeSource = img;
      return { imgEl: img as HTMLImageElement, embedEl: embed as HTMLElement | null, targetEl, sizeSource, detailsEl, entryIndex };
    };

    const isInResizeZone = (rect: DOMRect, clientX: number) => clientX >= rect.right - RESIZE_ZONE_PX;

    const applyWidth = (el: HTMLElement, w: number) => {
      el.style.width = `${w}px`;
      el.style.setProperty("max-width", "none", "important");
    };

    const saveImageSize = async (entryIndex: number, imageName: string, newWidth: number) => {
      if (!imageName) return;
      // Актуальная запись из состояния блока (массив мог быть заменён фоновым обновлением)
      const entry = this.blockState.get(container)?.structuredData?.[entryIndex] ?? structuredData[entryIndex];
      if (!entry) return;
      const file = this.ctx.app.vault.getAbstractFileByPath(entry.sourcePath);
      if (!file || !(file instanceof TFile)) return;

      const escaped = imageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const imageRegex = new RegExp(`!\\[\\[${escaped}(\\|\\d+)?\\]\\]`, "g");

      await processSectionByHeading(this.ctx.app, file, entry.headingLine, (body) => {
        const newBody = body.replace(imageRegex, () => `![[${imageName}|${newWidth}]]`);
        if (newBody === body) return null;
        entry.content = newBody.replace(/^\n+/, "").replace(/\n+$/, "");
        return newBody;
      });
      // Данные уже отражают файл: фоновый рефреш с тем же содержимым не будет перерисовывать блок.
      this.commitLocalData(container);
    };

    let resizeState: {
      active: boolean;
      targetEl: HTMLElement | null;
      imgEl: HTMLImageElement | null;
      embedEl: HTMLElement | null;
      entryIndex: number | null;
      decodedSrc: string | null;
      startLeft: number;
      lastWidth: number;
    } = {
      active: false,
      targetEl: null,
      imgEl: null,
      embedEl: null,
      entryIndex: null,
      decodedSrc: null,
      startLeft: 0,
      lastWidth: 0,
    };

    let saveImageDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    const resizeMoveHandler = (e: MouseEvent) => {
      if (!resizeState.active || !resizeState.targetEl) return;
      let newWidth = Math.round(e.clientX - resizeState.startLeft);
      if (newWidth < MIN_WIDTH) newWidth = MIN_WIDTH;
      if (newWidth > MAX_WIDTH) newWidth = MAX_WIDTH;
      applyWidth(resizeState.targetEl, newWidth);
      if (resizeState.embedEl && resizeState.imgEl) applyWidth(resizeState.imgEl, newWidth);
      resizeState.lastWidth = newWidth;
    };

    const resizeUpHandler = () => {
      if (!resizeState.active) return;
      const finalWidth = resizeState.lastWidth;
      const entryIndex = resizeState.entryIndex;
      const imageName = resizeState.decodedSrc;
      resizeState.active = false;
      state.imageResizeActive = false;
      doc.removeEventListener("mousemove", resizeMoveHandler);
      doc.removeEventListener("mouseup", resizeUpHandler);
      if (saveImageDebounceTimer) clearTimeout(saveImageDebounceTimer);
      if (entryIndex != null && imageName) {
        saveImageDebounceTimer = setTimeout(() => {
          void saveImageSize(entryIndex, imageName, finalWidth);
        }, 150);
      }
    };

    const removeResizeZoneClass = () => {
      container.querySelectorAll(".task-view-resize-zone").forEach((el) => el.classList.remove("task-view-resize-zone"));
    };

    const resizeZoneMoveHandler = (e: MouseEvent) => {
      if (resizeState.active) return;
      if (!container.contains(e.target as Node)) {
        removeResizeZoneClass();
        return;
      }
      const ctx = getImageContext(e.target);
      if (!ctx) {
        removeResizeZoneClass();
        return;
      }
      const rect = ctx.sizeSource.getBoundingClientRect();
      if (isInResizeZone(rect, e.clientX)) {
        container.querySelectorAll(".task-view-resize-zone").forEach((el) => {
          if (el !== ctx.targetEl) el.classList.remove("task-view-resize-zone");
        });
        ctx.targetEl.classList.add("task-view-resize-zone");
      } else {
        ctx.targetEl.classList.remove("task-view-resize-zone");
      }
    };

    const resizeZoneDownHandler = (e: MouseEvent) => {
      if (!container.contains(e.target as Node)) return;
      const ctx = getImageContext(e.target);
      if (!ctx) return;
      const rect = ctx.sizeSource.getBoundingClientRect();
      if (!isInResizeZone(rect, e.clientX)) return;
      e.preventDefault();
      e.stopPropagation();
      let src = ctx.embedEl ? ctx.embedEl.getAttribute("src") : ctx.imgEl ? ctx.imgEl.getAttribute("src") : null;
      if (!src && ctx.imgEl) src = ctx.imgEl.getAttribute("src");
      const decodedSrc = src ? decodeURIComponent(src.split("?")[0].split("/").pop() || src) : "";
      const startLeft = rect.left;
      const lastWidth = Math.round(rect.width);
      resizeState = {
        active: true,
        targetEl: ctx.targetEl,
        imgEl: ctx.imgEl,
        embedEl: ctx.embedEl,
        entryIndex: Number(ctx.entryIndex),
        decodedSrc,
        startLeft,
        lastWidth,
      };
      state.imageResizeActive = true;
      ctx.targetEl.classList.remove("task-view-resize-zone");
      doc.addEventListener("mousemove", resizeMoveHandler);
      doc.addEventListener("mouseup", resizeUpHandler);
    };

    const resizeZoneLeaveHandler = () => {
      removeResizeZoneClass();
    };

    container.addEventListener("mousemove", resizeZoneMoveHandler);
    container.addEventListener("mousedown", resizeZoneDownHandler);
    container.addEventListener("mouseleave", resizeZoneLeaveHandler);

    state.imageResizeCleanup = () => {
      if (saveImageDebounceTimer) clearTimeout(saveImageDebounceTimer);
      resizeState.active = false;
      state.imageResizeActive = false;
      container.removeEventListener("mousemove", resizeZoneMoveHandler);
      container.removeEventListener("mousedown", resizeZoneDownHandler);
      container.removeEventListener("mouseleave", resizeZoneLeaveHandler);
      doc.removeEventListener("mousemove", resizeMoveHandler);
      doc.removeEventListener("mouseup", resizeUpHandler);
      removeResizeZoneClass();
    };
  }
}

/** Плоское оглавление по записям (подзаголовки, а если их нет ни у кого - даты). */
function buildTocEntries(structuredData: TaskViewEntry[]): TocEntry[] {
  const flatTocEntries: TocEntry[] = [];
  const processedDatesForToc = new Set<string>();
  const hasAnySubheadings = structuredData.some((p) => p.subHeadings.length > 0);
  structuredData.forEach((item, entryIndex) => {
    if (hasAnySubheadings) {
      item.subHeadings.forEach((subH, subIndex) => {
        flatTocEntries.push({
          id: subH.id,
          text: subH.text,
          level: subH.level,
          dateText: item.date,
          isDateOnly: false,
          entryIndex,
          subIndex,
        });
      });
    } else if (!processedDatesForToc.has(item.date)) {
      flatTocEntries.push({
        id: item.id,
        text: item.date,
        level: 1,
        dateText: item.date,
        isDateOnly: true,
        entryIndex,
        subIndex: null,
      });
      processedDatesForToc.add(item.date);
    }
  });
  return flatTocEntries;
}

/**
 * Элемент записи (или её подзаголовка) в отрисованном блоке задачи taskPath внутри root - для перехода
 * из панели «Структура». Берётся видимый блок: во вкладке в DOM могут быть сразу редактор и режим чтения.
 * Свёрнутая запись разворачивается. null - блок сейчас не отрисован (вне экрана или режим исходного кода).
 */
export function findTaskViewTarget(
  root: HTMLElement,
  taskPath: string,
  item: Pick<OutlineTocItem, "entryKey" | "entryOrdinal" | "subIndex" | "text" | "occurrence">
): HTMLElement | null {
  const containers = Array.from(root.querySelectorAll<HTMLElement>(".opa-task-view")).filter(
    (el) => el.getAttribute(DATA_PATH) === taskPath && el.isConnected && el.getClientRects().length > 0
  );
  for (const container of containers) {
    // Сравнение атрибута напрямую: без экранирования в селекторе и с учётом записей с одинаковым ключом
    const details = Array.from(container.querySelectorAll<HTMLElement>("details.task-view-entry")).filter(
      (el) => el.getAttribute("data-entry-key") === item.entryKey
    )[item.entryOrdinal];
    if (!details) continue;
    openTaskViewDetails(details);
    if (item.subIndex == null) return details;
    const display = details.querySelector<HTMLElement>(".task-view-display");
    const headings = display
      ? Array.from(display.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")).filter(
          (h) => !h.closest(".internal-embed")
        )
      : [];
    const key = headingMatchKey(item.text);
    const sameText = headings.filter((h) => headingMatchKey(h.textContent ?? "") === key);
    return sameText[item.occurrence] ?? headings[item.subIndex] ?? details;
  }
  return null;
}

/** Развернуть свёрнутую запись (или «Оглавление») блока задачи; стрелка на кнопке - как при клике по ней. */
export function openTaskViewDetails(details: HTMLElement): void {
  if (details.hasAttribute("open")) return;
  details.setAttribute("open", "");
  const collapseBtn = details.querySelector<HTMLElement>(".task-view-collapse-button");
  if (collapseBtn) collapseBtn.textContent = "▼";
}

/**
 * Область прокрутки редактора, в котором Live Preview отрисовал блок: Obsidian кладёт её в контекст процессора
 * (containerEl, в типах API его нет). В режиме чтения и в старых версиях - null.
 */
function editorScrollerOf(ctx: unknown): HTMLElement | null {
  const container = (ctx as { containerEl?: unknown } | null)?.containerEl as HTMLElement | undefined;
  return container && typeof container.querySelectorAll === "function" && container.classList?.contains("cm-scroller")
    ? container
    : null;
}

/** Экранирование значения для селектора атрибута. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/** Ближайший прокручиваемый контейнер (редактор Live Preview или режим чтения). */
export function findScrollContainer(el: HTMLElement): HTMLElement | null {
  const win = el.ownerDocument.defaultView;
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node.classList.contains("cm-scroller") || node.classList.contains("markdown-preview-view")) return node;
    if (win) {
      const overflowY = win.getComputedStyle(node).overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
    }
  }
  return null;
}

/** Смещения начала строк в тексте. */
function lineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) offsets.push(i + 1);
  }
  return offsets;
}

/** Поиск текста из превью в markdown: сначала целиком (первые 40 символов), потом по самым длинным словам. */
function findTextInMarkdown(haystack: string, targetText: string, isImage: boolean): { pos: number; length: number } | null {
  if (!targetText) return null;
  if (isImage) {
    let pos = haystack.indexOf(targetText);
    if (pos !== -1) return { pos, length: targetText.length };
    const baseName = targetText.split("|")[0]?.trim();
    if (baseName) {
      pos = haystack.indexOf(baseName);
      if (pos !== -1) return { pos, length: baseName.length };
    }
    return null;
  }
  const snippet = targetText.substring(0, 40);
  const direct = haystack.indexOf(snippet);
  if (direct !== -1) return { pos: direct, length: snippet.length };
  const words = targetText.split(" ").filter((w) => w.length > 4).sort((a, b) => b.length - a.length);
  for (const word of words) {
    const pos = haystack.indexOf(word);
    if (pos !== -1) return { pos, length: word.length };
  }
  return null;
}

/**
 * Позиция курсора в textarea при открытии редактора.
 * Приоритет: блок под мышью (по сопоставлению с исходником) и текст в нём → текст по всей записи →
 * строка, соответствующая относительному положению клика в превью.
 */
export function locateEditCaret(
  markdown: string,
  options: EditOpenOptions | undefined,
  ratio: number
): { pos: number; length: number } {
  const lines = markdown.split("\n");
  const offsets = lineStartOffsets(markdown);
  const targetText = options?.targetText ?? "";
  const isImage = options?.isImage ?? false;
  const range = options?.blockRange;
  if (range && range.from >= 0 && range.from < lines.length) {
    const base = offsets[range.from];
    const end = range.to < lines.length ? offsets[range.to] : markdown.length;
    const found = findTextInMarkdown(markdown.slice(base, end), targetText, isImage);
    return found ? { pos: base + found.pos, length: found.length } : { pos: base, length: 0 };
  }
  const found = findTextInMarkdown(markdown, targetText, isImage);
  if (found) return found;
  const line = Math.min(lines.length - 1, Math.max(0, Math.floor(ratio * lines.length)));
  return { pos: offsets[line] ?? 0, length: 0 };
}

/** focus() без прокрутки страницы к элементу (иначе Chromium увозит вид к каретке в конце textarea). */
function focusWithoutScroll(el: HTMLElement): void {
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
}

/**
 * Высота (px) от верха textarea до верха строки с позицией pos, с учётом переносов длинных строк:
 * текст до курсора укладывается в невидимый div той же ширины и шрифта.
 */
function measureCaretTop(textarea: HTMLTextAreaElement, pos: number, lineHeight: number): number {
  const doc = textarea.ownerDocument;
  const win = doc.defaultView;
  const before = textarea.value.slice(0, pos);
  if (!win) return before.split("\n").length * lineHeight - lineHeight;
  try {
    const cs = win.getComputedStyle(textarea);
    const mirror = doc.createElement("div");
    for (const prop of [
      "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "tabSize",
      "paddingTop", "paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth", "boxSizing", "wordBreak",
    ] as const) {
      mirror.style[prop] = cs[prop];
    }
    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.top = "0";
    mirror.style.left = "-10000px";
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.overflowWrap = "break-word";
    mirror.style.height = "auto";
    // Последняя строка курсора должна учитываться даже если она пустая
    mirror.textContent = before + "\u200b";
    doc.body.appendChild(mirror);
    const height = mirror.getBoundingClientRect().height;
    mirror.remove();
    if (height > 0) return Math.max(0, height - lineHeight);
  } catch {
    // измерение не удалось - грубая оценка ниже
  }
  const paddingTop = win ? parseFloat(win.getComputedStyle(textarea).paddingTop) || 0 : 0;
  return paddingTop + (before.split("\n").length - 1) * lineHeight;
}

/**
 * Экранная Y верха каждой строки textarea (с учётом переносов длинных строк и внутренней прокрутки):
 * текст укладывается в невидимое зеркало той же ширины и шрифта, по <div> на строку.
 */
export function measureLineScreenTops(textarea: HTMLTextAreaElement): number[] | null {
  const doc = textarea.ownerDocument;
  const win = doc.defaultView;
  if (!win) return null;
  try {
    const cs = win.getComputedStyle(textarea);
    const mirror = doc.createElement("div");
    for (const prop of [
      "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "tabSize",
      "paddingTop", "paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth", "boxSizing", "wordBreak",
    ] as const) {
      mirror.style[prop] = cs[prop];
    }
    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.top = "0";
    mirror.style.left = "-10000px";
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.overflowWrap = "break-word";
    mirror.style.height = "auto";
    const lineEls = textarea.value.split("\n").map((line) => {
      const el = doc.createElement("div");
      el.textContent = line === "" ? "\u200B" : line;
      mirror.appendChild(el);
      return el;
    });
    doc.body.appendChild(mirror);
    const rect = textarea.getBoundingClientRect();
    const borderTop = parseFloat(cs.borderTopWidth) || 0;
    const tops = lineEls.map((el) => rect.top + borderTop + el.offsetTop - textarea.scrollTop);
    mirror.remove();
    return tops;
  } catch {
    return null;
  }
}

/**
 * Что держать на экране при замене textarea редактора на превью записи после сохранения:
 * - textarea целиком ниже верха области прокрутки → верх записи (контент выше не меняется);
 * - textarea пересекает верх области → строка исходника у верхнего края и её блок в превью;
 * - textarea целиком выше области → низ записи (меняется только высота контента над областью).
 */
export interface SaveScrollAnchor {
  kind: "top" | "bottom" | "line";
  /** Экранная Y верха/низа записи (top/bottom). */
  y: number;
  /** Строка textarea у верхнего края области прокрутки и экранные Y верха всех строк (line). */
  line?: number;
  lineScreenTops?: number[];
  detailsTop: number;
}

export function planSaveScrollAnchor(
  textarea: HTMLTextAreaElement | null,
  detailsEl: HTMLElement,
  scroller: HTMLElement
): SaveScrollAnchor {
  const detailsRect = detailsEl.getBoundingClientRect();
  const viewTop = scroller.getBoundingClientRect().top;
  const top: SaveScrollAnchor = { kind: "top", y: detailsRect.top, detailsTop: detailsRect.top };
  if (!textarea) return top;
  const rect = textarea.getBoundingClientRect();
  if (rect.top >= viewTop - 1) return top;
  if (rect.bottom <= viewTop) return { kind: "bottom", y: detailsRect.bottom, detailsTop: detailsRect.top };
  const lineScreenTops = measureLineScreenTops(textarea);
  if (!lineScreenTops || lineScreenTops.length === 0) return top;
  let line = 0;
  for (let i = 0; i < lineScreenTops.length; i++) {
    if (lineScreenTops[i] <= viewTop) line = i;
    else break;
  }
  return { kind: "line", y: viewTop, line, lineScreenTops, detailsTop: detailsRect.top };
}

/** Элемент перерисованной записи и экранная Y, на которой должен стоять его край. */
export interface ResolvedScrollAnchor {
  el: Element;
  edge: "top" | "bottom";
  y: number;
}

/**
 * Якорь после перерисовки: для строки textarea - блок превью, содержащий эту строку исходника
 * (или ближайший ниже/выше), который должен встать туда, где в textarea начиналась его первая строка.
 */
export function resolveSaveScrollAnchor(
  anchor: SaveScrollAnchor,
  detailsEl: HTMLElement,
  displayDiv: HTMLElement,
  source: string
): ResolvedScrollAnchor {
  if (anchor.kind === "top") return { el: detailsEl, edge: "top", y: anchor.y };
  if (anchor.kind === "bottom") return { el: detailsEl, edge: "bottom", y: anchor.y };
  const fallback: ResolvedScrollAnchor = { el: detailsEl, edge: "top", y: anchor.detailsTop };
  const tops = anchor.lineScreenTops;
  if (!tops || tops.length === 0) return fallback;
  const blocks = getRenderedBlocks(displayDiv);
  if (blocks.length === 0) return fallback;
  const mapping = alignBlocksToSource(blocks, source.split("\n"));
  const line = anchor.line ?? 0;
  let index = mapping.findIndex((r) => r != null && r.from <= line && line < r.to);
  if (index < 0) index = mapping.findIndex((r) => r != null && r.from > line);
  if (index < 0) {
    for (let i = mapping.length - 1; i >= 0; i--) {
      const r = mapping[i];
      if (r && r.to <= line) {
        index = i;
        break;
      }
    }
  }
  const range = index >= 0 ? mapping[index] : null;
  if (!range) return fallback;
  return { el: blocks[index], edge: "top", y: tops[Math.min(range.from, tops.length - 1)] };
}

/** Прокрутить контейнер так, чтобы край якоря оказался на своей экранной Y. */
export function keepAnchorOnScreen(scroller: HTMLElement, anchor: ResolvedScrollAnchor): void {
  const rect = anchor.el.getBoundingClientRect();
  const current = anchor.edge === "top" ? rect.top : rect.bottom;
  const delta = current - anchor.y;
  if (!Number.isFinite(delta) || Math.abs(delta) < 1) return;
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.min(maxTop, Math.max(0, scroller.scrollTop + delta));
}

const SETTLE_HOLD_MS = 3000;

/**
 * Пока перерисованное содержимое «оседает» (догружаются картинки и встраивания, меняя высоту),
 * удерживать якорь на месте. Прекращается, как только пользователь прокрутит сам, и по таймауту.
 * На это время у области прокрутки отключается нативное якорение Chromium, чтобы оно не спорило с нашим.
 */
export function holdAnchorWhileSettling(scroller: HTMLElement, watched: HTMLElement, anchor: ResolvedScrollAnchor): void {
  const win = watched.ownerDocument.defaultView;
  if (!win || typeof win.ResizeObserver !== "function") return;
  const previousOverflowAnchor = scroller.style.overflowAnchor;
  scroller.style.overflowAnchor = "none";
  let expected = scroller.scrollTop;
  let active = true;
  const stop = (): void => {
    if (!active) return;
    active = false;
    observer.disconnect();
    scroller.style.overflowAnchor = previousOverflowAnchor;
  };
  const observer = new win.ResizeObserver(() => {
    if (!active) return;
    if (Math.abs(scroller.scrollTop - expected) > 2) {
      stop();
      return;
    }
    keepAnchorOnScreen(scroller, anchor);
    expected = scroller.scrollTop;
  });
  observer.observe(watched);
  win.setTimeout(stop, SETTLE_HOLD_MS);
}

/** Прокрутить контейнер так, чтобы строка с курсором оказалась на экранной высоте anchorY. */
function keepCaretAtScreenY(textarea: HTMLTextAreaElement, scroller: HTMLElement, pos: number, anchorY: number): void {
  const win = textarea.ownerDocument.defaultView;
  if (!win) return;
  const cs = win.getComputedStyle(textarea);
  let lineHeight = parseFloat(cs.lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) lineHeight = (parseFloat(cs.fontSize) || 14) * 1.4;
  const caretTop = measureCaretTop(textarea, pos, lineHeight);
  const caretScreenY = textarea.getBoundingClientRect().top + caretTop + lineHeight / 2;
  const delta = caretScreenY - anchorY;
  if (!Number.isFinite(delta) || Math.abs(delta) < 2) return;
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.min(maxTop, Math.max(0, scroller.scrollTop + delta));
}
