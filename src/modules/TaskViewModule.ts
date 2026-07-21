/**
 * View задачи: оглавление и контент из ежедневных заметок (daily), где в заголовках упоминается эта задача.
 */

import type { ModuleContext } from "./types";
import { Component, MarkdownRenderer, Menu, Notice, TFile, htmlToMarkdown } from "obsidian";
import { replaceSectionByHeading, processSectionByHeading } from "../core/FileIO";
import { Paths } from "../core/Paths";
import { UI_LABELS } from "../ui/Labels";
import { BlockRegistry } from "../ui/BlockRegistry";

const DAILY_FOLDER = Paths.DAILY_FOLDER;
const DATA_PATH = "data-opa-task-view-path";
const DATA_NAME = "data-opa-task-view-name";
const REFRESH_DEBOUNCE_MS = 2000;

/** Состояние блока task-view (вместо ad-hoc свойств на DOM-элементах). */
interface TaskViewBlockState {
  structuredData?: TaskViewEntry[];
  /** Не перерисовывать до этого времени (после собственного сохранения). */
  ignoreRefreshUntil?: number;
  /** Идёт ресайз картинки — не перерисовывать. */
  imageResizeActive?: boolean;
  component?: Component;
  imageResizeCleanup?: () => void;
  listenersAttached?: boolean;
  lastContextMenu?: {
    displayDiv: HTMLElement;
    targetText: string;
    isImage: boolean;
    savedRange: Range | null;
    imgForMarkdownCopy: HTMLImageElement | null;
  } | null;
}

interface TocEntry {
  id: string;
  text: string;
  level: number;
  dateText: string;
  isDateOnly: boolean;
}

interface TaskViewEntry {
  id: string;
  dateLink: string;
  date: string;
  subHeadings: { text: string; level: number; id: string }[];
  content: string;
  sourcePath: string;
  contentStartOffset: number;
  contentEndOffset: number;
  /** Строка заголовка в файле (для безопасной замены секции через vault.process). */
  headingLine: string;
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

export class TaskViewModule {
  private ctx: ModuleContext;
  private registry: BlockRegistry;
  private blockState = new WeakMap<HTMLElement, TaskViewBlockState>();
  private rendering = new Set<HTMLElement>();
  private pendingRender = new Set<HTMLElement>();
  private unsubscribeIndex: (() => void) | null = null;
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
        if (state?.ignoreRefreshUntil && Date.now() < state.ignoreRefreshUntil) return false;
        if (state?.imageResizeActive) return false;
        // Не перерисовываем блок, пока в нём открыто редактирование — иначе теряются правки
        if (this.activeEditRef && el.contains(this.activeEditRef.editWrap)) return false;
        return true;
      },
      onPrune: (el) => this.cleanupBlock(el),
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
    const state = this.blockState.get(el);
    if (!state) return;
    state.component?.unload();
    state.component = undefined;
    state.imageResizeCleanup?.();
    state.imageResizeCleanup = undefined;
    if (state.listenersAttached) {
      el.removeEventListener("copy", this.handleSmartCopy);
      el.removeEventListener("contextmenu", this.handleTaskViewContextMenu);
      el.removeEventListener("click", this.handleInternalLinkClick);
      state.listenersAttached = false;
    }
    this.blockState.delete(el);
  }

  load(): void {
    this.unsubscribeIndex = this.ctx.eventBus.on("index:updated", this.scheduleRefresh);
    this.ctx.plugin.registerEvent(this.ctx.app.workspace.on("active-leaf-change", this.onLeafChange));

    this.ctx.plugin.registerMarkdownCodeBlockProcessor("opa-task-view", (_source, el, ctx) => {
      el.addClass("opa-task-view");
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
      this.registry.register(el, () => {
        el.setAttribute(DATA_PATH, sourcePath);
        el.setAttribute(DATA_NAME, taskName);
        this.renderTaskView(el, sourcePath, taskName);
      });
    });
  }

  unload(): void {
    if (this.unsubscribeIndex) this.unsubscribeIndex();
    this.unsubscribeIndex = null;
    this._removeEditListeners?.();
    this.registry.clear();
    this.rendering.clear();
    this.pendingRender.clear();
  }

  private onLeafChange = (): void => {
    const activeFile = this.ctx.app.workspace.getActiveFile();
    const dailyPrefix = DAILY_FOLDER.replace(/\/?$/, "") + "/";
    if (activeFile?.path.startsWith(dailyPrefix)) return;
    this.scheduleRefresh();
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
    const structuredData = this.blockState.get(containerEl)?.structuredData;
    if (!structuredData?.[entryIndex]) {
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
    const ok = await replaceSectionByHeading(
      this.ctx.app,
      file,
      entry.headingLine,
      textareaEl.value
    );
    if (!ok) {
      new Notice("Не удалось сохранить секцию (заголовок не найден в файле).");
    }
    if (ok) {
      this.getState(containerEl).ignoreRefreshUntil = Date.now() + 2000;
    }
    this.registry.refreshBlock(containerEl);
  };

  private async fetchTaskViewData(taskName: string): Promise<{
    structuredData: TaskViewEntry[];
    flatTocEntries: TocEntry[];
  }> {
    const { app } = this.ctx;
    const prefix = DAILY_FOLDER.replace(/\/?$/, "") + "/";
    const dailyFiles = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));
    dailyFiles.sort((a, b) => parseDailyDate(a.basename) - parseDailyDate(b.basename));

    const preliminaryData: {
      date: string;
      dateLink: string;
      subHeadings: { text: string; level: number }[];
      content: string;
      sourcePath: string;
      contentStartOffset: number;
      contentEndOffset: number;
      headingLine: string;
    }[] = [];

    for (const file of dailyFiles) {
      const cache = app.metadataCache.getFileCache(file);
      if (!cache?.headings) continue;

      const hasMention = cache.headings.some((h) =>
        h.heading.toLowerCase().includes(taskName.toLowerCase())
      );
      if (!hasMention) continue;

      const fileContent = await app.vault.cachedRead(file);
      const headings = cache.headings;

      for (let i = 0; i < headings.length; i++) {
        const currentHeading = headings[i];
        if (!currentHeading.heading.toLowerCase().includes(taskName.toLowerCase())) continue;

        const sectionSubHeadings: { text: string; level: number }[] = [];
        for (let j = i + 1; j < headings.length && headings[j].level > currentHeading.level; j++) {
          const nextHeading = headings[j];
          sectionSubHeadings.push({
            text: nextHeading.heading.replace(/#/g, "").trim(),
            level: nextHeading.level - currentHeading.level,
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
        const lines = fileContent.split("\n");
        const headingLine =
          lines[currentHeading.position.start.line] ?? `### [[${headingToAnchor(currentHeading.heading)}]]`;

        preliminaryData.push({
          date: formattedDate,
          dateLink,
          subHeadings: sectionSubHeadings,
          content,
          sourcePath: file.path,
          contentStartOffset,
          contentEndOffset,
          headingLine,
        });
      }
    }

    const structuredData: TaskViewEntry[] = [];
    const flatTocEntries: TocEntry[] = [];
    const processedDatesForToc = new Set<string>();
    const hasAnySubheadings = preliminaryData.some((p) => p.subHeadings.length > 0);
    const uniquePrefix = `tv-${Math.floor(Math.random() * 100000)}`;

    preliminaryData.forEach((item, index) => {
      const currentBlockId = `${uniquePrefix}-block-${index}`;
      const finalSubHeadings = item.subHeadings.map((subH, subIndex) => ({
        ...subH,
        id: `${currentBlockId}-h-${subIndex}`,
      }));

      structuredData.push({
        id: currentBlockId,
        dateLink: item.dateLink,
        date: item.date,
        subHeadings: finalSubHeadings,
        content: item.content,
        sourcePath: item.sourcePath,
        contentStartOffset: item.contentStartOffset,
        contentEndOffset: item.contentEndOffset,
        headingLine: item.headingLine,
      });

      if (hasAnySubheadings) {
        finalSubHeadings.forEach((subH) => {
          flatTocEntries.push({
            id: subH.id,
            text: subH.text,
            level: subH.level,
            dateText: item.date,
            isDateOnly: false,
          });
        });
      } else {
        if (!processedDatesForToc.has(item.date)) {
          flatTocEntries.push({
            id: currentBlockId,
            text: item.date,
            level: 1,
            dateText: item.date,
            isDateOnly: true,
          });
          processedDatesForToc.add(item.date);
        }
      }
    });

    return { structuredData, flatTocEntries };
  }

  private async renderTaskView(
    container: HTMLElement,
    currentFilePath: string,
    taskName: string
  ): Promise<void> {
    if (this.rendering.has(container)) {
      this.pendingRender.add(container);
      return;
    }
    this.rendering.add(container);
    this.pendingRender.delete(container);

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

    const buildEntryKey = (entry: TaskViewEntry): string =>
      `${entry.sourcePath}::${String(entry.headingLine ?? "").trim()}`;

    try {
      const { structuredData, flatTocEntries } = await this.fetchTaskViewData(taskName);

      const state = this.getState(container);
      state.structuredData = structuredData;
      if (!state.listenersAttached) {
        container.addEventListener("copy", this.handleSmartCopy);
        container.addEventListener("contextmenu", this.handleTaskViewContextMenu);
        container.addEventListener("click", this.handleInternalLinkClick);
        state.listenersAttached = true;
      }

      const tempContainer = document.createElement("div");

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
              const target = document.getElementById(entry.id);
              if (target) target.scrollIntoView({ behavior: "auto", block: "start" });
            });
          }
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
          const contentToRender = (entry.content || "").replace(/^(=+)/gm, "\u200B$1").replace(/^(\d+)\|/gm, "$1\u200B|");
          await MarkdownRenderer.render(
            this.ctx.app,
            contentToRender,
            displayDiv,
            entry.sourcePath,
            component
          );

          const blankAfterHeadings = this.headingBlankAfterInSource(entry.content || "");
          const allHeadingsInDisplay = Array.from(
            displayDiv.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
          ).filter((h) => !h.closest(".internal-embed"));
          allHeadingsInDisplay.forEach((hEl, idx) => {
            hEl.setAttribute("data-after-blank", blankAfterHeadings[idx] ? "1" : "0");
          });

          const blankAfterPre = this.getPreBlankAfterInSource(entry.content || "");
          const blankBeforePre = this.getPreBlankBeforeInSource(entry.content || "");

          const applyPreLayoutAttrs = (): void => {
            const list = Array.from(displayDiv.querySelectorAll<HTMLPreElement>("pre")).filter(
              (p) => !p.closest(".internal-embed")
            );
            list.forEach((preEl, idx) => {
              const before =
                idx < blankBeforePre.length ? (blankBeforePre[idx] ? "1" : "0") : "1";
              const after = idx < blankAfterPre.length ? (blankAfterPre[idx] ? "1" : "0") : "1";
              preEl.setAttribute("data-before-blank", before);
              preEl.setAttribute("data-after-blank", after);
              this.mirrorPreLayoutAttrsOnPreWrapper(preEl, before, after);
            });
          };

          applyPreLayoutAttrs();
          requestAnimationFrame(() => applyPreLayoutAttrs());
          window.setTimeout(() => applyPreLayoutAttrs(), 120);

          if (entry.subHeadings.length > 0) {
            const renderedHeadings = displayDiv.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6");
            renderedHeadings.forEach((hEl) => {
              const hText = hEl.textContent?.trim() ?? "";
              const matching = entry.subHeadings.find((subH) => subH.text === hText);
              if (matching) hEl.id = matching.id;
            });
          }

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
    } catch (e) {
      container.empty();
      container.createEl("p", { text: UI_LABELS.errors.renderShort, cls: "view-error" });
      console.error(e);
    } finally {
      this.rendering.delete(container);
      if (this.pendingRender.has(container)) {
        this.pendingRender.delete(container);
        const path = container.getAttribute(DATA_PATH);
        const name = container.getAttribute(DATA_NAME);
        if (path && name) void this.renderTaskView(container, path, name);
      }
    }
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
  // КОНТЕКСТНОЕ МЕНЮ: «РЕДАКТИРОВАТЬ» + ОТКРЫТИЕ НА ПОЛНУЮ СО СКРОЛЛОМ К МЕСТУ
  // ========================================================================

  private handleTaskViewContextMenu = (ev: MouseEvent): void => {
    const displayDiv = (ev.target as HTMLElement)?.closest?.(".task-view-display") as HTMLElement | null;
    if (!displayDiv || !ev.currentTarget) return;
    const container = ev.currentTarget as HTMLElement;
    if (!container.contains(displayDiv)) return;

    ev.preventDefault();
    const { targetText, isImage } = this.getTargetTextAtPoint(displayDiv, ev.clientX, ev.clientY);
    const imgForMarkdownCopy = this.getImageElementAtPoint(displayDiv, ev.clientX, ev.clientY);
    const sel = window.getSelection();
    const savedRange =
      sel && sel.rangeCount > 0 && container.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    const state = this.getState(container);
    state.lastContextMenu = {
      displayDiv,
      targetText,
      isImage,
      savedRange,
      imgForMarkdownCopy,
    };

    const menu = new Menu();
    menu.addItem((item) => {
      item.setTitle(UI_LABELS.common.copy)
        .setIcon("copy")
        .onClick(() => {
          const data = state.lastContextMenu;
          const imgFallback = data?.imgForMarkdownCopy ?? null;
          state.lastContextMenu = null;
          const range = data?.savedRange;
          if (range) {
            const sel = window.getSelection();
            if (sel) {
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
          let text = this.getCopyTextForSelection(container);
          if (text == null && imgFallback) {
            text = this.copyPartFromImg(imgFallback);
          }
          if (text != null) {
            navigator.clipboard.writeText(text).catch((err) => console.error(err));
          }
        });
    });
    menu.addItem((item) => {
      item.setTitle(UI_LABELS.common.edit)
        .setIcon("pencil")
        .onClick(() => {
          const data = state.lastContextMenu;
          state.lastContextMenu = null;
          if (!data) return;
          const detailsEl = data.displayDiv.closest("details.task-view-entry") as HTMLElement | null;
          if (!detailsEl) return;
          this.openEditForEntry(container, detailsEl, {
            targetText: data.targetText,
            isImage: data.isImage,
          });
        });
    });
    menu.showAtMouseEvent(ev);
  };

  /**
   * Открыть секцию в режиме редактирования: разворот на полную (details open, textarea по высоте контента),
   * скролл к месту под курсором. Выход: Escape или клик снаружи.
   */
  private openEditForEntry(
    container: HTMLElement,
    detailsEl: HTMLElement,
    scrollData?: { targetText: string; isImage: boolean }
  ): void {
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

    const removeListeners = (): void => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onMouse, true);
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
      const isWindowScrollbar = window.innerWidth - ev.clientX <= 20;
      if ((el.scrollHeight > el.clientHeight && isRightEdge) || isWindowScrollbar) return;
      this.activeEditRef.doSave();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onMouse, true);

    textarea.focus();

    if (scrollData?.targetText != null && scrollData.targetText !== "") {
      this.ctx.app.workspace.onLayoutReady(() => {
        this.scrollToPointInTextarea(textarea, scrollData.targetText, scrollData.isImage);
      });
    }
  }

  /** Картинка под координатами в превью задачи (для копирования с ПКМ и т.п.). */
  private getImageElementAtPoint(displayDiv: HTMLElement, clientX: number, clientY: number): HTMLImageElement | null {
    const raw = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
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
    const atPoint = displayDiv.contains(document.elementFromPoint(clientX, clientY) as Node)
      ? (document.elementFromPoint(clientX, clientY) as HTMLElement)
      : null;
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
    } else if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(clientX, clientY);
      if (range?.startContainer && displayDiv.contains(range.startContainer)) {
        targetText =
          range.startContainer.nodeType === 3
            ? (range.startContainer.nodeValue || "")
            : (range.startContainer as Element).textContent || "";
      }
    }
    if (!isImage && !targetText && atPoint) targetText = (atPoint as HTMLElement).textContent || "";
    targetText = targetText.trim().replace(/\s+/g, " ");
    return { targetText, isImage };
  }

  /**
   * Скролл к месту под курсором в textarea.
   * Ищет targetText в тексте и прокручивает к нему.
   */
  private scrollToPointInTextarea(
    textarea: HTMLTextAreaElement,
    targetText: string,
    isImage: boolean
  ): void {

    const mdText = textarea.value;
    if (!targetText) {
      textarea.focus();
      return;
    }

    let pos = -1;
    let matchLen = 0;

    if (isImage) {
      pos = mdText.indexOf(targetText);
      matchLen = targetText.length;
      if (pos === -1 && targetText.includes("|")) {
        const baseName = targetText.split("|")[0]?.trim() || targetText;
        pos = mdText.indexOf(baseName);
        matchLen = baseName.length;
      }
    } else {
      const snippet = targetText.substring(0, 40);
      pos = mdText.indexOf(snippet);
      matchLen = snippet.length;
      if (pos === -1) {
        const words = targetText.split(" ").filter((w) => w.length > 4);
        words.sort((a, b) => b.length - a.length);
        for (const word of words) {
          const tempPos = mdText.indexOf(word);
          if (tempPos !== -1) {
            pos = tempPos;
            matchLen = word.length;
            break;
          }
        }
      }
    }

    if (pos !== -1) {
      textarea.setSelectionRange(pos, pos + matchLen);
      const linesBefore = mdText.substring(0, pos).split("\n").length;
      const totalLines = mdText.split("\n").length;
      const lineHeight = totalLines > 0 ? textarea.scrollHeight / totalLines : 20;
      const yOffsetWithinTextarea = linesBefore * lineHeight;
      const scroller = textarea.closest(".cm-scroller, .markdown-reading-view, .markdown-preview-view");
      if (scroller) {
        const scrollerRect = scroller.getBoundingClientRect();
        const editAreaRect = textarea.getBoundingClientRect();
        const textareaTopInScroller = editAreaRect.top - scrollerRect.top + (scroller as HTMLElement).scrollTop;
        const targetScroll =
          textareaTopInScroller + yOffsetWithinTextarea - scroller.clientHeight / 2 + lineHeight / 2;
        (scroller as HTMLElement).scrollTo({ top: Math.max(0, targetScroll), behavior: "smooth" });
      }
    }
    textarea.focus();
  }

  // ========================================================================
  // УМНОЕ КОПИРОВАНИЕ (SMART COPY)
  // ========================================================================

  /** true, если во фрагменте есть img или встроенный превью-embed с картинкой (выделение без текста). */
  private fragmentContainsCopyableImage(fragment: DocumentFragment): boolean {
    const walk = (n: Node): boolean => {
      if (n.nodeType !== 1) return false;
      const el = n as HTMLElement;
      if (el.tagName === "IMG") return true;
      if (el.classList.contains("internal-embed") && el.querySelector("img")) return true;
      for (const child of el.childNodes) {
        if (walk(child)) return true;
      }
      return false;
    };
    for (const child of fragment.childNodes) {
      if (walk(child)) return true;
    }
    return false;
  }

  private handleSmartCopy = (e: ClipboardEvent): void => {
    const container = e.currentTarget as HTMLElement;
    const text = this.getCopyTextForSelection(container);
    if (text != null) {
      e.preventDefault();
      e.clipboardData?.setData("text/plain", text);
    }
  };

  /**
   * Возвращает текст для копирования по текущему выделению в task-view (те же правила, что и Ctrl+C).
   * Возвращает null, если выделение вне контента задачи или пустое.
   */
  private getCopyTextForSelection(container: HTMLElement): string | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;

    const range0 = sel.getRangeAt(0);
    // Проверяем по общему предку диапазона — работает и при выделении снизу вверх.
    if (!container.contains(range0.commonAncestorContainer)) return null;

    const toElement = (n: Node | null): Element | null =>
      n?.nodeType === 1 ? (n as Element) : (n?.parentElement ?? null);
    const anchorEl = toElement(range0.startContainer);
    const focusEl = toElement(range0.endContainer);

    const display =
      anchorEl?.closest(".task-view-display") ?? focusEl?.closest(".task-view-display");
    if (!display || !container.contains(display)) return null;
    const fragmentForMediaCheck = range0.cloneContents();
    const hasText = (sel.toString() || "").trim().length > 0;
    const hasCopyableImage = this.fragmentContainsCopyableImage(fragmentForMediaCheck);
    if (!hasText && !hasCopyableImage) return null;

    // Выделение целиком внутри одного <pre> — специальная обработка
    const anchorPre = anchorEl?.closest("pre");
    const focusPre = focusEl?.closest("pre");
    const samePre = Boolean(anchorPre && focusPre && anchorPre === focusPre);
    if (samePre && anchorPre) {
      const selectedText = (sel?.toString() || "").trim();
      const codeEl = anchorPre.querySelector("code");
      const fullText = (codeEl?.textContent ?? anchorPre.textContent ?? "").replace(/\n+$/, "").trim();
      return selectedText && selectedText !== fullText ? selectedText : this.copyPartFromPre(anchorPre);
    }

    // Выделение частично захватывает <pre>: определяем откуда и куда
    const partialPre: "none" | "end" | "start" | "both" =
      anchorPre && focusPre && anchorPre !== focusPre ? "both" :
      !anchorPre && focusPre ? "end" :
      anchorPre && !focusPre ? "start" : "none";

    // Выделение целиком внутри одного заголовка
    const heading = anchorEl?.closest("h1, h2, h3, h4, h5, h6") as HTMLElement | null;
    const sameHeading = heading && focusEl && heading.contains(focusEl);
    if (heading && sameHeading && display.contains(heading)) {
      const level = parseInt(heading.tagName.charAt(1), 10);
      const text = (heading.textContent || "").trim();
      return text ? "#".repeat(level) + " " + text : null;
    }

    // Выделение через несколько записей (разные daily) — только DOM→markdown,
    // иначе source-match путает границы между секциями.
    const touchedEntries: HTMLElement[] = [];
    container.querySelectorAll("details.task-view-entry").forEach((el) => {
      if (range0.intersectsNode(el)) touchedEntries.push(el as HTMLElement);
    });
    if (touchedEntries.length > 1) {
      return this.fragmentToMarkdown(fragmentForMediaCheck, partialPre);
    }

    // Одна запись: пробуем вырезать из исходного markdown (сохраняет wikilinks, fences).
    const detailsEl = touchedEntries[0]
      ?? (anchorEl?.closest("details.task-view-entry") as HTMLElement | null)
      ?? (focusEl?.closest("details.task-view-entry") as HTMLElement | null);
    if (detailsEl) {
      const structuredData = this.blockState.get(container)?.structuredData;
      if (structuredData) {
        const entryIndex = parseInt(detailsEl.dataset.entryIndex || "0", 10);
        const entry = structuredData[entryIndex];
        if (entry?.content) {
          const fragText = this.getFragmentTextForSearch(fragmentForMediaCheck);
          const snippet = this.extractSnippetFromSource(entry.content, fragText);
          if (snippet != null) return snippet;
        }
      }
    }

    // Фолбэк: htmlToMarkdown (с учётом частичного выделения <pre>)
    return this.fragmentToMarkdown(fragmentForMediaCheck, partialPre);
  }

  /**
   * Извлекает текст из DocumentFragment для поиска в source markdown.
   * В отличие от sel.toString(), берёт из <pre> только реально присутствующий
   * текст (не весь code block), что позволяет корректно определить границы.
   * Текст внутри block-level элементов (p, h1-h6, li) собирается в одну строку.
   */
  private getFragmentTextForSearch(fragment: DocumentFragment): string {
    const lines: string[] = [];
    const BLOCK_TAGS = /^(P|H[1-6]|LI|BLOCKQUOTE|DIV|PRE|UL|OL|TABLE|HR)$/;

    const getBlockText = (el: HTMLElement): void => {
      if (el.tagName === "PRE") {
        const codeEl = el.querySelector("code");
        const codeText = (codeEl?.textContent ?? el.textContent ?? "").replace(/\n+$/, "");
        if (codeText.trim()) lines.push(...codeText.split("\n").filter((l) => l.trim()));
        return;
      }
      if (/^(P|H[1-6]|LI|BLOCKQUOTE)$/.test(el.tagName)) {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (text) lines.push(text);
        return;
      }
      // DIV и прочие контейнеры — рекурсия
      for (const child of el.childNodes) {
        if (child.nodeType === 1) getBlockText(child as HTMLElement);
        else if (child.nodeType === 3) {
          const t = (child.textContent || "").trim();
          if (t) lines.push(t);
        }
      }
    };

    // Фрагмент может содержать как block-level элементы (<p>, <pre>),
    // так и inline-содержимое (text nodes, <a>, <strong>) без обёртки.
    // Собираем последовательные inline-узлы в одну строку.
    let inlineBuf = "";
    const flushInline = (): void => {
      const trimmed = inlineBuf.replace(/\s+/g, " ").trim();
      if (trimmed) lines.push(trimmed);
      inlineBuf = "";
    };

    for (const child of fragment.childNodes) {
      if (child.nodeType === 1) {
        const el = child as HTMLElement;
        if (BLOCK_TAGS.test(el.tagName)) {
          flushInline();
          getBlockText(el);
        } else {
          // Inline element (<a>, <strong>, <em>, <code>, <span>...)
          inlineBuf += el.textContent || "";
        }
      } else if (child.nodeType === 3) {
        inlineBuf += child.textContent || "";
      }
    }
    flushInline();

    return lines.join("\n");
  }

  /**
   * Ищет фрагмент plain-text выделения в исходном markdown и возвращает
   * соответствующий кусок исходника (с ```-разметкой, ссылками и т.д.).
   *
   * Стратегия: берём первую и последнюю непустую строку из выделения,
   * ищем их позиции в sourceContent, вырезаем кусок между ними.
   * Если между первой строкой и результатом поиска есть markdown-разметка
   * (```, заголовки), она включается.
   */
  private extractSnippetFromSource(sourceContent: string, selectionText: string): string | null {
    const plainText = selectionText.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    if (!plainText) return null;

    const selLines = plainText.split("\n").filter((l) => l.trim().length > 0);
    if (selLines.length === 0) return null;

    const firstLine = selLines[0].trim();
    const lastLine = selLines[selLines.length - 1].trim();
    const srcLines = sourceContent.split("\n");

    /** Убирает markdown-разметку из строки для нечёткого сравнения с plain text выделения. */
    const strip = (s: string): string =>
      s.replace(/^#+\s+/, "")          // заголовки
       .replace(/`([^`]*)`/g, "$1")     // inline code
       .replace(/\*\*([^*]*)\*\*/g, "$1") // bold
       .replace(/\*([^*]*)\*/g, "$1")     // italic
       .replace(/~~([^~]*)~~/g, "$1")     // strikethrough
       .replace(/==([^=]*)==/g, "$1")     // highlight
       .replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_m, href, display) => display || href) // wikilinks
       .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // markdown links
       .trim();

    /** Проверяет, совпадает ли source-строка с plain-text строкой из выделения. */
    const matchLine = (srcLine: string, selLine: string): boolean => {
      const trimmedSrc = srcLine.trim();
      if (!trimmedSrc || !selLine) return false;
      if (trimmedSrc.includes(selLine) || selLine.includes(trimmedSrc)) return true;
      const stripped = strip(srcLine);
      if (stripped === selLine) return true;
      if (stripped.includes(selLine) || selLine.includes(stripped)) return true;
      // Префиксное совпадение для частично выделенной строки (не короче 8 символов)
      if (selLine.length >= 8 && (stripped.startsWith(selLine) || selLine.startsWith(stripped.slice(0, selLine.length)))) {
        return true;
      }
      return false;
    };

    // Ищем первую строку в исходнике
    let startIdx = -1;
    for (let i = 0; i < srcLines.length; i++) {
      if (matchLine(srcLines[i], firstLine)) {
        startIdx = i;
        break;
      }
    }
    if (startIdx === -1) return null;

    // Ищем последнюю строку в исходнике (от startIdx, первое совпадение)
    let endIdx = startIdx;
    if (firstLine !== lastLine) {
      for (let i = startIdx + 1; i < srcLines.length; i++) {
        if (matchLine(srcLines[i], lastLine)) {
          endIdx = i;
          break;
        }
      }
    }

    // Если endIdx не сдвинулся при нескольких строках в выделении — поиск не удался
    if (endIdx === startIdx && selLines.length > 1) return null;

    // Проверяем, заканчивается ли вырезка внутри fenced code block.
    // Если да — расширяем до закрывающего fence ТОЛЬКО если он идёт
    // сразу за endIdx (возможно через пустые строки). Если между endIdx
    // и fence есть ещё строки кода — значит пользователь выделил часть кода,
    // и дописывать остаток не нужно.
    let inCode = false;
    let codeFence = "";
    for (let i = startIdx; i <= endIdx; i++) {
      const fenceMatch = srcLines[i].match(/^(`{3,}|~{3,})/);
      if (!inCode && fenceMatch) {
        inCode = true;
        codeFence = fenceMatch[1];
      } else if (inCode && srcLines[i].trim() === codeFence) {
        inCode = false;
        codeFence = "";
      }
    }
    if (inCode && codeFence) {
      for (let i = endIdx + 1; i < srcLines.length; i++) {
        const trimmed = srcLines[i].trim();
        if (trimmed === codeFence) {
          endIdx = i;
          break;
        }
        if (trimmed.length > 0) {
          break;
        }
      }
    }

    // Собираем результат: целые строки от startIdx до endIdx.
    // Последняя (и первая) строка может быть длиннее выделения — обрезаем.
    const resultLines = srcLines.slice(startIdx, endIdx + 1);

    // Обрезка последней строки: если source-строка значительно длиннее lastLine
    if (resultLines.length >= 1 && endIdx >= startIdx) {
      const idx = resultLines.length - 1;
      const lastSrcLine = resultLines[idx];
      const strippedLast = strip(lastSrcLine);
      if (strippedLast.length > lastLine.length + 5) {
        // Source-строка длиннее выделения — обрезаем по последним символам lastLine
        const anchor = lastLine.slice(-Math.min(lastLine.length, 30));
        const anchorPos = lastSrcLine.indexOf(anchor);
        if (anchorPos >= 0) {
          resultLines[idx] = lastSrcLine.substring(0, anchorPos + anchor.length);
        }
      }
    }

    // Обрезка первой строки: если source-строка начинается раньше выделения
    if (resultLines.length >= 1) {
      const firstSrcLine = resultLines[0];
      const strippedFirst = strip(firstSrcLine);
      if (strippedFirst.length > firstLine.length + 5) {
        const anchor = firstLine.slice(0, Math.min(firstLine.length, 30));
        // Ищем начало firstLine в stripped
        const posInStripped = strippedFirst.indexOf(anchor);
        if (posInStripped > 3) {
          // firstLine начинается не с начала строки — ищем якорь в оригинале
          const posInOriginal = firstSrcLine.indexOf(anchor);
          if (posInOriginal > 0) {
            resultLines[0] = firstSrcLine.substring(posInOriginal);
          }
        }
      }
    }

    const snippet = resultLines.join("\n").replace(/\n+$/, "");
    return snippet || null;
  }

  private copyPartFromPre(pre: HTMLElement): string {
    const codeEl = pre.querySelector("code");
    const raw = codeEl ? codeEl.textContent : pre.textContent;
    const codeText = (raw || "").replace(/\n+$/, "");
    const cls = (pre.className || "") + " " + (codeEl?.className || "");
    const langMatch = cls.match(/\blanguage-(\S+)\b/);
    const lang = langMatch ? langMatch[1] : "";
    return (lang ? "```" + lang + "\n" : "```\n") + codeText + "\n```";
  }

  private copyPartFromImg(img: HTMLImageElement): string {
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
    return path ? `![[${path}]]` : "![image]";
  }

  /**
   * Преобразует DocumentFragment в Markdown, используя Obsidian htmlToMarkdown
   * с дополнительной пост-обработкой для wikilink'ов и внутренних эмбедов.
   *
   * @param partialPre — "end" если выделение заканчивается внутри pre (не включать
   *   закрывающие ```), "start" если начинается внутри pre (не включать открывающие),
   *   "both" если оба конца в разных pre, "none" если pre не затронут.
   */
  private fragmentToMarkdown(
    fragment: DocumentFragment,
    partialPre: "none" | "end" | "start" | "both" = "none"
  ): string {
    const wrapper = document.createElement("div");
    wrapper.appendChild(fragment.cloneNode(true));

    // Обработка <pre> элементов: заменяем на placeholder'ы чтобы htmlToMarkdown
    // не генерировал fenced code blocks (мы формируем их сами с учётом обрезки).
    const codeReplacements: { placeholder: string; markdown: string }[] = [];
    const pres = Array.from(wrapper.querySelectorAll<HTMLPreElement>("pre"));
    pres.forEach((pre, idx) => {
      const codeEl = pre.querySelector("code");
      const codeText = (codeEl?.textContent ?? pre.textContent ?? "").replace(/\n+$/, "");
      const cls = (pre.className || "") + " " + (codeEl?.className || "");
      const langMatch = cls.match(/\blanguage-(\S+)\b/);
      const lang = langMatch ? langMatch[1] : "";

      const isFirst = idx === 0;
      const isLast = idx === pres.length - 1;

      // Определяем нужны ли открывающие/закрывающие ```
      const needOpen = !(partialPre === "start" && isFirst) && !(partialPre === "both" && isFirst);
      const needClose = !(partialPre === "end" && isLast) && !(partialPre === "both" && isLast);

      let markdown: string;
      const openFence = needOpen ? (lang ? "```" + lang + "\n" : "```\n") : "";
      const closeFence = needClose ? "\n```" : "";
      markdown = openFence + codeText + closeFence;

      const placeholder = `\nOPA_CODE_${idx}_${Date.now()}\n`;
      codeReplacements.push({ placeholder: placeholder.trim(), markdown });

      const markerEl = document.createElement("p");
      markerEl.textContent = placeholder.trim();
      pre.replaceWith(markerEl);
    });

    // Заменяем .internal-embed на текст ![[...]]
    wrapper.querySelectorAll<HTMLElement>(".internal-embed").forEach((embed) => {
      const alt = embed.getAttribute("alt");
      const src = embed.getAttribute("src");
      let text = "";
      if (alt) {
        text = `![[${alt}]]`;
      } else if (src) {
        const cleanSrc = decodeURIComponent(src.split("/").pop() || src).split("?")[0];
        text = `![[${cleanSrc}]]`;
      }
      if (text) {
        embed.replaceWith(document.createTextNode(text));
      }
    });

    // Заменяем a.internal-link на [[...]] маркеры
    wrapper.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((link) => {
      const href = (link.getAttribute("data-href") || link.getAttribute("href") || "").trim();
      const display = (link.textContent || "").trim();
      let cleanHref = href;
      if (cleanHref.startsWith("app://")) {
        cleanHref = decodeURIComponent(cleanHref.split("/").pop() || cleanHref).split("?")[0];
      }
      if (cleanHref) {
        const text = display && display !== cleanHref ? `[[${cleanHref}|${display}]]` : `[[${cleanHref}]]`;
        link.replaceWith(document.createTextNode(text));
      }
    });

    // Заменяем <mark> на ==...== (htmlToMarkdown не поддерживает highlight)
    wrapper.querySelectorAll<HTMLElement>("mark").forEach((mark) => {
      const text = mark.textContent || "";
      mark.replaceWith(document.createTextNode(`==${text}==`));
    });

    const html = wrapper.innerHTML;
    let md = htmlToMarkdown(html);

    // Подставляем обратно код вместо placeholder'ов
    for (const { placeholder, markdown } of codeReplacements) {
      md = md.replace(placeholder, markdown);
    }

    // Нормализация: убираем тройные+ переносы
    md = md.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "");

    return md;
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
      const entry = structuredData[entryIndex];
      if (!entry) return;
      const file = this.ctx.app.vault.getAbstractFileByPath(entry.sourcePath);
      if (!file || !(file instanceof TFile)) return;

      const escaped = imageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const imageRegex = new RegExp(`!\\[\\[${escaped}(\\|\\d+)?\\]\\]`, "g");

      state.ignoreRefreshUntil = Date.now() + REFRESH_DEBOUNCE_MS + 1500;
      await processSectionByHeading(this.ctx.app, file, entry.headingLine, (body) => {
        const newBody = body.replace(imageRegex, () => `![[${imageName}|${newWidth}]]`);
        if (newBody === body) return null;
        entry.content = newBody.replace(/^\n+/, "").replace(/\n+$/, "");
        return newBody;
      });
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
      document.removeEventListener("mousemove", resizeMoveHandler);
      document.removeEventListener("mouseup", resizeUpHandler);
      if (saveImageDebounceTimer) clearTimeout(saveImageDebounceTimer);
      if (entryIndex != null && imageName) {
        state.ignoreRefreshUntil = Date.now() + REFRESH_DEBOUNCE_MS + 1500;
        saveImageDebounceTimer = setTimeout(() => {
          saveImageSize(entryIndex, imageName, finalWidth);
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
      document.addEventListener("mousemove", resizeMoveHandler);
      document.addEventListener("mouseup", resizeUpHandler);
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
      document.removeEventListener("mousemove", resizeMoveHandler);
      document.removeEventListener("mouseup", resizeUpHandler);
      removeResizeZoneClass();
    };
  }
}
