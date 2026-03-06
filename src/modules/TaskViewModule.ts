/**
 * View задачи: оглавление и контент из ежедневных заметок (daily), где в заголовках упоминается эта задача.
 */

import type { ModuleContext } from "./types";
import { Component, MarkdownRenderer, getIcon, Menu, Notice } from "obsidian";
import { read, modify, replaceSectionByHeading } from "../core/FileIO";
import { Paths } from "../core/Paths";
import { UI_LABELS } from "../ui/Labels";

const DAILY_FOLDER = Paths.DAILY_FOLDER;
const DATA_PATH = "data-opa-task-view-path";
const DATA_NAME = "data-opa-task-view-name";
const REFRESH_DEBOUNCE_MS = 500;

interface TaskViewBlock {
  el: HTMLElement;
  refresh: () => void;
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
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private blocks = new Set<TaskViewBlock>();
  private rendering = new Set<HTMLElement>();
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
  }

  load(): void {
    this.unsubscribeIndex = this.ctx.eventBus.on("index:updated", this.scheduleRefresh);
    this.ctx.app.metadataCache.on("changed", this.onFileChanged);
    this.ctx.app.workspace.on("active-leaf-change", this.onLeafChange);

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
      this.blocks.forEach((b) => {
        if (b.el === el) this.blocks.delete(b);
      });
      const refresh = (): void => {
        el.setAttribute(DATA_PATH, sourcePath);
        el.setAttribute(DATA_NAME, taskName);
        this.renderTaskView(el, sourcePath, taskName);
      };
      this.blocks.add({ el, refresh });
      el.setAttribute(DATA_PATH, sourcePath);
      el.setAttribute(DATA_NAME, taskName);
      this.renderTaskView(el, sourcePath, taskName);
    });
  }

  unload(): void {
    if (this.unsubscribeIndex) this.unsubscribeIndex();
    this.unsubscribeIndex = null;
    this.ctx.app.metadataCache.off("changed", this.onFileChanged);
    this.ctx.app.workspace.off("active-leaf-change", this.onLeafChange);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const b of this.blocks) {
      if ((b.el as any)._opaHasInternalLinkListener) {
        b.el.removeEventListener("click", this.handleInternalLinkClick);
        (b.el as any)._opaHasInternalLinkListener = false;
      }
    }
    this.blocks.clear();
    this.rendering.clear();
  }

  private onLeafChange = (): void => {
    this.scheduleRefresh();
  };

  /** Рефреш при изменении индекса daily (create/rename/delete/changed). */
  private scheduleRefresh = (): void => {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.runRefresh();
    }, REFRESH_DEBOUNCE_MS);
  };

  /** Сохранить текст из textarea в секцию ежедневной заметки (vault.process + поиск по заголовку). */
  private saveSectionEdit = async (
    containerEl: HTMLElement,
    entryIndex: number,
    textareaEl: HTMLTextAreaElement
  ): Promise<void> => {
    const structuredData = (containerEl as any)._opaStructuredData as TaskViewEntry[] | undefined;
    if (!structuredData?.[entryIndex]) {
      this.refreshBlock(containerEl);
      return;
    }
    const entry = structuredData[entryIndex];
    const file = this.ctx.app.vault.getAbstractFileByPath(entry.sourcePath);
    if (!file || typeof (file as { extension?: string }).extension !== "string") {
      new Notice(UI_LABELS.errors.fileNotFound(entry.sourcePath));
      this.refreshBlock(containerEl);
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
      (containerEl as any)._opaIgnoreRefreshUntil = Date.now() + 2000;
    }
    this.refreshBlock(containerEl);
  };

  private refreshBlock(containerEl: HTMLElement): void {
    const block = Array.from(this.blocks).find((b) => b.el === containerEl);
    block?.refresh();
  }

  /** Рефреш только если изменился файл, для которого на экране есть блок opa-task-view. */
  private onFileChanged = (file: { path: string }): void => {
    const isCurrentTask = Array.from(this.blocks).some(
      (b) => b.el.getAttribute(DATA_PATH) === file.path
    );
    if (isCurrentTask) this.scheduleRefresh();
  };

  private runRefresh(): void {
    this.blocks.forEach((b) => {
      if (b.el.isConnected) {
        const ignoreUntil = (b.el as any)._opaIgnoreRefreshUntil as number | undefined;
        if (ignoreUntil && Date.now() < ignoreUntil) {
          return;
        }
        b.refresh();
      }
    });

    if (this.blocks.size > 30) {
      const stale = Array.from(this.blocks).filter((b) => !b.el.isConnected);
      for (let i = 0; i < stale.length - 10; i++) {
        const b = stale[i];
        const el = b.el as HTMLElement & { _opaComponent?: Component };
        el._opaComponent?.unload();
        el._opaComponent = undefined;
        this.blocks.delete(b);
      }
    }
  }

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
    if (this.rendering.has(container)) return;
    this.rendering.add(container);

    const scrollableParent = container.closest(".cm-scroller, .markdown-reading-view, .markdown-preview-view");
    const scrollTop = scrollableParent?.scrollTop ?? 0;
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

      (container as any)._opaStructuredData = structuredData;
      if (!(container as any)._opaHasCopyListener) {
        container.addEventListener("copy", this.handleSmartCopy);
        (container as any)._opaHasCopyListener = true;
      }
      if (!(container as any)._opaHasContextMenuListener) {
        container.addEventListener("contextmenu", this.handleTaskViewContextMenu);
        (container as any)._opaHasContextMenuListener = true;
      }
      if (!(container as any)._opaHasInternalLinkListener) {
        container.addEventListener("click", this.handleInternalLinkClick);
        (container as any)._opaHasInternalLinkListener = true;
      }

      const tempContainer = document.createElement("div");

      const containerWithComponent = container as HTMLElement & { _opaComponent?: Component };
      if (containerWithComponent._opaComponent) {
        containerWithComponent._opaComponent.unload();
      }
      const component = new Component();
      component.load();
      containerWithComponent._opaComponent = component;

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
          titleContainer.innerHTML =
            '<div class="callout-title"><div class="callout-icon">✏️</div><div class="callout-title-inner">Оглавление</div></div>';
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

          const previewWrap = detailsEl.createDiv({ cls: "markdown-preview-view" });
          const renderedDiv = previewWrap.createDiv({ cls: "markdown-rendered" });
          const displayDiv = renderedDiv.createDiv({ cls: "task-view-display" });
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
          const allPreInDisplay = Array.from(
            displayDiv.querySelectorAll<HTMLPreElement>("pre")
          ).filter((p) => !p.closest(".internal-embed"));
          allPreInDisplay.forEach((preEl, idx) => {
            if (idx < blankAfterPre.length) {
              preEl.setAttribute("data-after-blank", blankAfterPre[idx] ? "1" : "0");
            } else {
              preEl.setAttribute("data-after-blank", "1");
            }
          });

          displayDiv.querySelectorAll<HTMLPreElement>("pre").forEach((pre) => {
            this.injectCopyButton(pre);
          });

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

        this.setupImageResizer(containerWithComponent, structuredData);
      }

      container.empty();
      container.append(...Array.from(tempContainer.childNodes));

      if (scrollableParent?.isConnected) {
        scrollableParent.scrollTop = scrollTop;
        setTimeout(() => {
          if (scrollableParent.isConnected) scrollableParent.scrollTop = scrollTop;
        }, 0);
      }
    } catch (e) {
      container.empty();
      container.createEl("p", { text: UI_LABELS.errors.renderShort, cls: "view-error" });
      console.error(e);
    } finally {
      this.rendering.delete(container);
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

  /** Добавить кнопку копирования в pre, если её ещё нет. */
  private injectCopyButton(preElement: HTMLPreElement): void {
    if (preElement.querySelector(".task-view-copy-btn")) return;

    const button = document.createElement("button");
    button.className = "task-view-copy-btn";
    button.setAttribute("aria-label", "Copy code");
    button.textContent = "⧉";

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const codeEl = preElement.querySelector("code");
      const raw = codeEl ? codeEl.textContent : preElement.textContent;
      const codeText = (raw || "").replace(/\n+$/, "");
      const cls = `${preElement.className} ${codeEl?.className ?? ""}`;
      const langMatch = cls.match(/\blanguage-(\S+)\b/);
      const lang = langMatch ? langMatch[1] : "";
      const wrapped = `${lang ? "```" + lang + "\n" : "```\n"}${codeText}\n\`\`\``;

      try {
        await navigator.clipboard.writeText(wrapped);
        button.classList.add("copied");
        const originalText = button.textContent;
        button.textContent = "✓";
        setTimeout(() => {
          button.textContent = originalText ?? "⧉";
          button.classList.remove("copied");
        }, 2000);
      } catch (err) {
        console.error(err);
      }
    });

    preElement.appendChild(button);
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
    const sel = window.getSelection();
    const savedRange =
      sel && sel.rangeCount > 0 && container.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    (container as any)._opaLastContextMenu = {
      displayDiv,
      targetText,
      isImage,
      savedRange,
    };

    const menu = new Menu();
    menu.addItem((item) => {
      item.setTitle(UI_LABELS.common.copy)
        .setIcon("copy")
        .onClick(() => {
          const data = (container as any)._opaLastContextMenu as
            | { savedRange: Range | null }
            | undefined;
          (container as any)._opaLastContextMenu = undefined;
          const range = data?.savedRange;
          if (range) {
            const sel = window.getSelection();
            if (sel) {
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
          const text = this.getCopyTextForSelection(container);
          if (text != null) {
            navigator.clipboard.writeText(text).catch((err) => console.error(err));
          }
        });
    });
    menu.addItem((item) => {
      item.setTitle(UI_LABELS.common.edit)
        .setIcon("pencil")
        .onClick(() => {
          const data = (container as any)._opaLastContextMenu as
            | { displayDiv: HTMLElement; targetText: string; isImage: boolean }
            | undefined;
          (container as any)._opaLastContextMenu = undefined;
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
    const previewWrap = detailsEl.querySelector<HTMLElement>(".markdown-preview-view");
    const textarea = detailsEl.querySelector<HTMLTextAreaElement>(".task-view-edit");
    if (!editWrap || !previewWrap || !textarea) return;

    const structuredData = (container as any)._opaStructuredData as TaskViewEntry[] | undefined;
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
      if (!targetText && el instanceof HTMLImageElement) {
        const src = el.getAttribute("src") || "";
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
    if (!sel || !sel.rangeCount || !container.contains(sel.anchorNode)) return null;

    const anchorEl =
      sel.anchorNode?.nodeType === 1
        ? (sel.anchorNode as Element)
        : (sel.anchorNode?.parentElement as Element | null);
    const focusEl =
      sel.focusNode?.nodeType === 1
        ? (sel.focusNode as Element)
        : (sel.focusNode?.parentElement as Element | null);

    const display = anchorEl?.closest(".task-view-display");
    if (!display || !container.contains(display)) return null;
    if (!sel.toString()) return null;

    const pre = anchorEl?.closest("pre");
    const samePre = pre && focusEl && pre.contains(focusEl);
    if (pre && samePre) {
      const selectedText = (sel.toString() || "").trim();
      const codeEl = pre.querySelector("code");
      const fullText = (codeEl ? codeEl.textContent : pre.textContent || "").replace(/\n+$/, "").trim();
      return selectedText && selectedText !== fullText ? selectedText : this.copyPartFromPre(pre);
    }

    const heading = anchorEl?.closest("h1, h2, h3, h4, h5, h6") as HTMLElement | null;
    const sameHeading = heading && focusEl && heading.contains(focusEl);
    if (heading && sameHeading && display.contains(heading)) {
      const level = parseInt(heading.tagName.charAt(1), 10);
      const text = (heading.textContent || "").trim();
      return text ? "#".repeat(level) + " " + text : null;
    }

    const fragment = sel.getRangeAt(0).cloneContents();
    let sourceContent: string | null = null;

    const detailsEl =
      (anchorEl?.closest("details.task-view-entry") as HTMLElement | null) ||
      (focusEl?.closest("details.task-view-entry") as HTMLElement | null);
    if (detailsEl) {
      const structuredData = (container as any)._opaStructuredData as TaskViewEntry[] | undefined;
      if (structuredData) {
        const entryIndex = parseInt(detailsEl.dataset.entryIndex || "0", 10);
        const entry = structuredData[entryIndex];
        if (entry && entry.content) {
          sourceContent = entry.content;
        }
      }
    }

    return this.fragmentToCopyText(fragment, sourceContent);
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

  private fragmentToParts(fragment: DocumentFragment): any[] {
    const parts: any[] = [];

    const walk = (n: Node): void => {
      if (n.nodeType === 3) {
        parts.push({ text: n.textContent ?? "", block: false });
        return;
      }
      if (n.nodeType !== 1) return;

      const el = n as HTMLElement;

      if (el.tagName === "PRE") {
        const blankAfter = el.getAttribute("data-after-blank") === "1";
        parts.push({ text: this.copyPartFromPre(el), block: true, blankAfter, tightAfter: !blankAfter });
        return;
      }

      if (el.tagName === "CODE") {
        parts.push({ text: `\`${el.textContent}\``, block: false });
        return;
      }

      if (el.classList.contains("internal-embed")) {
        const alt = el.getAttribute("alt");
        const src = el.getAttribute("src");
        if (alt) {
          parts.push({ text: `![[${alt}]]`, block: true });
        } else if (src) {
          let cleanSrc = decodeURIComponent(src.split("/").pop() || src).split("?")[0];
          parts.push({ text: `![[${cleanSrc}]]`, block: true });
        }
        return;
      }

      if (el.tagName === "IMG" && !el.closest(".internal-embed")) {
        const alt = el.getAttribute("alt") || "";
        const src = el.getAttribute("src") || "";
        let cleanSrc = src;
        if (cleanSrc.startsWith("app://")) {
          cleanSrc = decodeURIComponent(cleanSrc.split("/").pop() || cleanSrc).split("?")[0];
        }
        parts.push({ text: `![${alt}](${cleanSrc})`, block: true });
        return;
      }

      const headingMatch = el.tagName && el.tagName.match(/^H([1-6])$/);
      if (headingMatch) {
        const level = parseInt(headingMatch[1], 10);
        const text = (el.textContent || "").trim();
        const blankAfter = el.getAttribute("data-after-blank") === "1";
        if (text) parts.push({ text: "#".repeat(level) + " " + text, block: true, blankAfter });
        return;
      }

      if (el.tagName === "A") {
        const href = (el.getAttribute("data-href") || el.getAttribute("href") || "").trim();
        const isInternal = el.classList.contains("internal-link") || (href && !/^[\w+.-]+:/.test(href));

        if (isInternal) {
          const display = (el.textContent || "").trim();
          let cleanHref = href;
          if (cleanHref.startsWith("app://")) {
            cleanHref = decodeURIComponent(cleanHref.split("/").pop() || cleanHref).split("?")[0];
          }
          if (cleanHref) {
            const linkText =
              display && display !== cleanHref ? `[[${cleanHref}|${display}]]` : `[[${cleanHref}]]`;
            parts.push({ text: linkText, block: false });
            return;
          }
        } else if (href) {
          const display = (el.textContent || "").trim();
          parts.push({ text: `[${display}](${href})`, block: false });
          return;
        }
      }

      if (el.tagName === "INPUT" && el.getAttribute("type") === "checkbox") {
        const isChecked = (el as HTMLInputElement).checked;
        parts.push({ text: isChecked ? "- [x] " : "- [ ] ", block: false });
        return;
      }

      if (el.tagName === "LI") {
        if (!el.classList.contains("task-list-item")) {
          parts.push({ text: "- ", block: false });
        }
        el.childNodes.forEach(walk);
        return;
      }

      if (el.tagName === "BLOCKQUOTE") {
        const lines = (el.textContent || "").trim().split("\n");
        const text = lines.map((l) => "> " + l).join("\n");
        parts.push({ text, block: true });
        return;
      }

      if (el.tagName === "STRONG" || el.tagName === "B") {
        parts.push({ text: `**${el.textContent}**`, block: false });
        return;
      }
      if (el.tagName === "EM" || el.tagName === "I") {
        parts.push({ text: `*${el.textContent}*`, block: false });
        return;
      }
      if (el.tagName === "DEL") {
        parts.push({ text: `~~${el.textContent}~~`, block: false });
        return;
      }
      if (el.tagName === "MARK") {
        parts.push({ text: `==${el.textContent}==`, block: false });
        return;
      }

      n.childNodes.forEach(walk);
    };

    fragment.childNodes.forEach(walk);
    return parts;
  }

  private countNewlinesBetweenParts(sourceContent: string, parts: any[]): (number | null)[] {
    if (!sourceContent || !parts || parts.length < 2) return [];
    const result: (number | null)[] = [];
    let searchFrom = 0;

    for (let i = 0; i < parts.length - 1; i++) {
      const a = parts[i].text;
      const b = parts[i + 1].text;

      let posA = sourceContent.indexOf(a, searchFrom);
      if (posA === -1) posA = sourceContent.indexOf(a);

      const endA = posA !== -1 ? posA + a.length : searchFrom;

      let posB = sourceContent.indexOf(b, endA);
      if (posB === -1) posB = sourceContent.indexOf(b);

      if (posA !== -1 && posB !== -1 && posB >= endA) {
        const gap = sourceContent.substring(endA, posB);
        const count = (gap.match(/\n/g) || []).length;
        result.push(count);
        searchFrom = posB;
      } else {
        result.push(null);
        if (posB !== -1) searchFrom = posB;
      }
    }
    return result;
  }

  private joinParts(parts: any[], newlinesAfter: (number | null)[] | null): string {
    const normalize = (s: string) => (s || "").replace(/\n+$/, "").replace(/^\n+/, "");
    const trimmed = parts.map((p) => ({ ...p, text: normalize(p.text) })).filter((p) => p.text.length > 0);

    let out = "";
    for (let i = 0; i < trimmed.length; i++) {
      let sep = "";
      if (i > 0) {
        const prev = trimmed[i - 1];
        const curr = trimmed[i];
        const prevIsBlock = prev.block || /^```/.test(prev.text || "");
        const currIsBlock = curr.block || /^```/.test(curr.text || "");

        const n = newlinesAfter && newlinesAfter[i - 1] !== undefined ? newlinesAfter[i - 1] : null;

        if (n !== null) {
          if (n === 0) {
            sep = !prevIsBlock && !currIsBlock ? "" : "\n";
          } else {
            sep = "\n".repeat(n);
          }
        } else {
          const prevBlank =
            prev.blankAfter === true ? "\n\n" : prev.blankAfter === false ? "\n" : "\n\n";
          if (currIsBlock) {
            sep = prev.block ? (prev.tightAfter ? "\n" : prevBlank) : "\n";
          } else {
            sep = prev.block ? (prev.tightAfter ? "\n" : prevBlank) : " ";
          }
        }
      }
      out += sep + trimmed[i].text;
    }

    return out.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "\n");
  }

  private fragmentToCopyText(fragment: DocumentFragment, sourceContent: string | null): string {
    const parts = this.fragmentToParts(fragment);
    const normalize = (s: string) => (s || "").replace(/\n+$/, "").replace(/^\n+/, "");
    const trimmed = parts.map((p) => ({ ...p, text: normalize(p.text) })).filter((p) => p.text.length > 0);

    const newlinesAfter =
      sourceContent && trimmed.length > 1 ? this.countNewlinesBetweenParts(sourceContent, trimmed) : null;

    return this.joinParts(parts, newlinesAfter);
  }

  // ========================================================================
  // Ресайзинг картинок
  // ========================================================================

  private setupImageResizer(container: HTMLElement & { _opaImageResizeCleanup?: () => void }, structuredData: TaskViewEntry[]): void {
    if (container._opaImageResizeCleanup) {
      container._opaImageResizeCleanup();
      container._opaImageResizeCleanup = undefined;
    }

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
      const originalFileContent = await read(this.ctx.app, entry.sourcePath);
      if (originalFileContent == null) return;

      const sectionContent = originalFileContent.substring(
        entry.contentStartOffset,
        entry.contentEndOffset
      );

      const escaped = imageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const imageRegex = new RegExp(`!\\[\\[${escaped}(\\|\\d+)?\\]\\]`, "g");
      const newSectionContent = sectionContent.replace(imageRegex, (_m, sizeGroup) => {
        const sizePart = `|${newWidth}`;
        if (sizeGroup) return `![[${
          imageName
        }${sizePart}]]`;
        return `![[${
          imageName
        }${sizePart}]]`;
      });

      if (newSectionContent === sectionContent) return;

      const fullContent =
        originalFileContent.slice(0, entry.contentStartOffset) +
        newSectionContent +
        originalFileContent.slice(entry.contentEndOffset);

      (container as any)._opaIgnoreRefreshUntil = Date.now() + 2000;
      await modify(this.ctx.app, entry.sourcePath, fullContent);
      entry.content = newSectionContent.replace(/^\n+/, "").replace(/\n+$/, "");
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
      document.removeEventListener("mousemove", resizeMoveHandler);
      document.removeEventListener("mouseup", resizeUpHandler);
      if (saveImageDebounceTimer) clearTimeout(saveImageDebounceTimer);
      if (entryIndex != null && imageName) {
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

    container._opaImageResizeCleanup = () => {
      if (saveImageDebounceTimer) clearTimeout(saveImageDebounceTimer);
      container.removeEventListener("mousemove", resizeZoneMoveHandler);
      container.removeEventListener("mousedown", resizeZoneDownHandler);
      container.removeEventListener("mouseleave", resizeZoneLeaveHandler);
      document.removeEventListener("mousemove", resizeMoveHandler);
      document.removeEventListener("mouseup", resizeUpHandler);
      removeResizeZoneClass();
    };
  }
}
