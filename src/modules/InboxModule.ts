import type { ModuleContext } from "./types";
import { Paths } from "../core/Paths";
import { read } from "../core/FileIO";
import { readDataFile, writeDataFile, getRewardForDifficulty, type InboxArchiveItem, INBOX_ARCHIVE_TRASH_PREFIX } from "../core/GamificationState";
import { UI_LABELS } from "../ui/Labels";
import { createCollapsibleSection } from "../ui/CollapsibleSection";
import { Notice } from "obsidian";

interface InboxData {
  visibleLines: string[];
  inboxPath: string;
  inboxArchive: InboxArchiveItem[];
}

function formatInboxArchiveDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

const INBOX_ARCHIVE_COLLAPSED_KEY = "opa-inbox-collapsed-archive";

function getInboxArchiveCollapsed(): boolean {
  try {
    return localStorage.getItem(INBOX_ARCHIVE_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function setInboxArchiveCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(INBOX_ARCHIVE_COLLAPSED_KEY, "1");
    else localStorage.removeItem(INBOX_ARCHIVE_COLLAPSED_KEY);
  } catch {}
}

export class InboxModule {
  private ctx: ModuleContext;
  private blocks = new Set<{ el: HTMLElement; refresh: () => void }>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Пропустить следующий refresh после добавления записи из формы. */
  private skipNextInboxRefresh = false;

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
  }

  private getDataPath(): string {
    return this.ctx.plugin.getGamificationDataPath();
  }

  private onChange = (...data: unknown[]): void => {
    const _file = data[0] as { path?: string } | undefined;
    if (_file?.path && _file.path !== this.getDataPath()) return;
    this.scheduleRefresh();
  };

  load(): void {
    this.ctx.app.metadataCache.on("changed", this.onChange);
    this.ctx.app.vault.on("modify", this.onChange);
    this.ctx.app.workspace.on("active-leaf-change", this.scheduleRefresh);

    this.ctx.plugin.registerMarkdownCodeBlockProcessor("opa-inbox-view", (_source, el) => {
      el.addClass("opa-inbox-view");
      this.blocks.forEach((b) => { if (b.el === el) this.blocks.delete(b); });
      const refresh = () => this.render(el);
      this.blocks.add({ el, refresh });
      this.render(el);
    });
  }

  /** Есть ли хотя бы один блок инбокса в активной вкладке. */
  private isAnyBlockVisible(): boolean {
    const container = this.ctx.app.workspace.activeLeaf?.view?.containerEl;
    if (!container) return false;
    for (const b of this.blocks) {
      if (b.el.isConnected && container.contains(b.el)) return true;
    }
    return false;
  }

  /** Обновить все открытые блоки (в т.ч. на фоновых вкладках). */
  private runRefresh(): void {
    this.blocks.forEach((b) => b.refresh());

    if (this.blocks.size > 30) {
      const stale = Array.from(this.blocks).filter((b) => !b.el.isConnected);
      for (let i = 0; i < stale.length - 10; i++) {
        this.blocks.delete(stale[i]);
      }
    }
  }

  private scheduleRefresh = (): void => {
    if (!this.ctx.plugin.settings.enableInbox) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.skipNextInboxRefresh) {
        this.skipNextInboxRefresh = false;
        return;
      }
      this.runRefresh();
    }, 500);
  };

  /** Принудительное обновление блоков инбокса (сразу после добавления записи). */
  forceRefresh(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.runRefresh();
  }

  unload(): void {
    this.ctx.app.metadataCache.off("changed", this.onChange as (...data: unknown[]) => void);
    this.ctx.app.vault.off("modify", this.onChange as (...data: unknown[]) => void);
    this.ctx.app.workspace.off("active-leaf-change", this.scheduleRefresh);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.blocks.clear();
  }

  updateState(): void {
    setTimeout(() => this.runRefresh(), 50);
  }

  private async loadInboxData(): Promise<InboxData | null> {
    try {
      const dataPath = this.ctx.plugin?.getGamificationDataPath?.();
      if (dataPath) {
        const data = await readDataFile(this.ctx.plugin);
        const visibleLines = (data.inbox ?? []).filter((l) => typeof l === "string" && l.trim().length > 0);
        return { visibleLines, inboxPath: "data.json", inboxArchive: data.inboxArchive ?? [] };
      }
    } catch {
      // fallback: data.json недоступен или без inbox
    }
    try {
      const content = await read(this.ctx.app, Paths.INBOX_FILE);
      if (content != null) {
        const visibleLines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("- ["));
        const dataPath = this.ctx.plugin?.getGamificationDataPath?.();
        if (dataPath && visibleLines.length > 0) {
          try {
            const data = await readDataFile(this.ctx.plugin);
            if (!data.inbox?.length) {
              await writeDataFile(this.ctx.plugin, {
                gamification: data.gamification,
                projects: data.projects ?? [],
                reminders: data.reminders ?? [],
                inbox: visibleLines,
                trash: data.trash ?? [],
                inboxArchive: data.inboxArchive ?? [],
              });
            }
            return { visibleLines, inboxPath: "data.json", inboxArchive: data.inboxArchive ?? [] };
          } catch {
            // миграция не удалась — просто показываем из Inbox.md
          }
        }
        return { visibleLines, inboxPath: "data.json", inboxArchive: [] };
      }
    } catch {
      // Inbox.md тоже недоступен
    }
    new Notice("Не удалось загрузить данные Inbox.");
    return null;
  }

  private async render(container: HTMLElement): Promise<void> {
    if (!this.ctx.plugin.settings.enableInbox) {
      container.empty();
      container.style.display = "none";
      return;
    }
    container.style.display = "";

    const scrollableParent = container.closest(".cm-scroller, .markdown-reading-view, .markdown-preview-view") as HTMLElement | null;
    const scrollTop = scrollableParent?.scrollTop ?? 0;

    const L = UI_LABELS.inbox;
    const common = UI_LABELS.common;

    try {
      const data = await this.loadInboxData();

      container.empty();
      const body = createCollapsibleSection(container, "Блокнот", "inbox");

      if (!data) {
        body.createEl("p", { text: L.loadDataError, cls: "view-error" });
      } else {
      const formWrap = body.createEl("div", { cls: "view-add-form" });
      const input = formWrap.createEl("input", { type: "text", cls: "view-input", attr: { placeholder: L.addPlaceholder, "data-focus-restore": "add-input" } });
      const addBtn = formWrap.createEl("button", { text: common.add, cls: "view-btn" });

      const listWrap = body.createEl("div", { cls: "inbox-list" });
      const appendRow = (line: string): void => {
        const emptyEl = listWrap.querySelector(".inbox-empty");
        if (emptyEl) emptyEl.remove();
        const row = listWrap.createEl("div", { cls: "inbox-line view-list-row" });
        row.setAttribute("data-original-text", line);
        row.createEl("span", { text: line, cls: "inbox-text" });
        const actions = row.createEl("div", { cls: "inbox-actions view-list-row-actions" });
        const btnDone = actions.createEl("button", { text: L.actions.done, cls: "inbox-action-btn" });
        btnDone.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.handleDone(line, row);
        });
        const btnTask = actions.createEl("button", { text: L.actions.task, cls: "inbox-action-btn" });
        btnTask.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.handleCreateTask(line, row);
        });
        const btnEdit = actions.createEl("button", { text: L.actions.edit, cls: "inbox-action-btn" });
        btnEdit.addEventListener("click", () => this.handleEdit(line, row));
        if (this.ctx.plugin.settings.enableReminders) {
          const btnReminder = actions.createEl("button", { text: L.actions.reminder, cls: "inbox-action-btn" });
          btnReminder.addEventListener("click", () => this.handleReminder(line, row));
        }
        const btnDel = actions.createEl("button", { text: L.actions.delete, cls: "inbox-action-btn" });
        btnDel.addEventListener("click", () => this.handleDelete(line, row));
      };

      addBtn.addEventListener("click", async () => {
        const val = input.value.trim();
        if (!val) return;
        const dataPath = this.getDataPath();
        const data = await readDataFile(this.ctx.plugin);
        const inbox = data.inbox ?? [];
        if (inbox.some((l) => (l as string).trim() === val)) {
          new Notice(L.notices.duplicate);
          return;
        }
        input.value = "";
        this.skipNextInboxRefresh = true;
        const nextInbox = [...inbox, val];
        await writeDataFile(this.ctx.plugin, {
          gamification: data.gamification,
          projects: data.projects ?? [],
          reminders: data.reminders ?? [],
          inbox: nextInbox,
          trash: data.trash ?? [],
          inboxArchive: data.inboxArchive ?? [],
        });
        new Notice(`Добавлено: "${val}"`);
        appendRow(val);
        setTimeout(() => input.focus(), 150);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addBtn.click();
        }
      });

      if (data.visibleLines.length === 0) {
        listWrap.createEl("div", { text: L.empty, cls: "inbox-empty" });
      } else {
        for (const line of data.visibleLines) appendRow(line);
      }

      if (data.inboxArchive.length > 0) {
        const archiveTitle = L.archiveTitle ?? "Архив";
        const isArchiveCollapsed = getInboxArchiveCollapsed();
        const archiveSection = body.createEl("div", { cls: "inbox-archive rv-section rv-completed" });
        const archiveHeader = archiveSection.createEl("h3", { cls: "rv-section-header" });
        archiveHeader.style.cursor = "pointer";
        archiveHeader.style.userSelect = "none";
        archiveHeader.style.display = "flex";
        archiveHeader.style.alignItems = "center";
        const archiveArrow = archiveHeader.createEl("span", { cls: "rv-section-arrow", text: isArchiveCollapsed ? "▶" : "▼" });
        archiveHeader.createEl("span", { cls: "rv-section-title-text" }).innerHTML = `📦 ${archiveTitle}`;
        archiveHeader.createEl("span", { cls: "rv-count", text: String(data.inboxArchive.length) });
        const archiveList = archiveSection.createEl("div", { cls: "rv-list inbox-archive-list" });
        archiveList.style.display = isArchiveCollapsed ? "none" : "block";
        archiveHeader.addEventListener("click", () => {
          const collapsed = archiveList.style.display === "none";
          archiveList.style.display = collapsed ? "block" : "none";
          archiveArrow.textContent = collapsed ? "▼" : "▶";
          setInboxArchiveCollapsed(!collapsed);
        });
        for (const entry of data.inboxArchive) {
          const completedDate = formatInboxArchiveDate(entry.completedAt);
          const archiveRow = archiveList.createEl("div", { cls: "inbox-archive-line rv-item" });
          const contentWrap = archiveRow.createEl("div", { cls: "rv-item-content-wrap" });
          const content = contentWrap.createEl("div", { cls: "rv-content" });
          content.createEl("div", { cls: "rv-text", text: entry.text });
          const timeDiv = archiveRow.createEl("div", { cls: "rv-time" });
          timeDiv.createEl("span", { cls: "rv-badge rv-badge-date", text: completedDate });
          const archiveActions = archiveRow.createEl("div", { cls: "rv-actions" });
          const btnArchiveDel = archiveActions.createEl("button", { text: L.actions.delete, cls: "inbox-action-btn" });
          btnArchiveDel.addEventListener("click", () => this.handleDeleteFromArchive(entry, archiveRow));
        }
      }
      }

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
    }
  }

  private async handleDelete(originalText: string, rowEl: HTMLElement): Promise<void> {
    const dataPath = this.getDataPath();
    const data = await readDataFile(this.ctx.plugin);
    const inbox = (data.inbox ?? []).filter((l) => (l as string).trim() !== originalText);
    if (inbox.length === (data.inbox ?? []).length) {
      rowEl.remove();
      this.forceRefresh();
      return;
    }
    const trash = [...(data.trash ?? []), originalText];
    await writeDataFile(this.ctx.plugin, {
      gamification: data.gamification,
      projects: data.projects ?? [],
      reminders: data.reminders ?? [],
      inbox,
      trash,
      inboxArchive: data.inboxArchive ?? [],
    });
    rowEl.remove();
    this.ctx.plugin.triggerTrashRefresh?.();
    this.forceRefresh();
  }

  private async handleDone(originalText: string, rowEl: HTMLElement): Promise<void> {
    const data = await readDataFile(this.ctx.plugin);
    const inbox = (data.inbox ?? []).filter((l) => (l as string).trim() !== originalText);
    if (inbox.length === (data.inbox ?? []).length) return;
    const archive = data.inboxArchive ?? [];
    const newEntry: InboxArchiveItem = { text: originalText, completedAt: new Date().toISOString() };
    let gamificationPayload = data.gamification;
    if (this.ctx.plugin.settings.enableGamification) {
      const state = await this.ctx.plugin.getGamificationState();
      const reward = getRewardForDifficulty(null, this.ctx.plugin.gamificationDefaults);
      state.xp += reward.xp;
      state.gold += reward.gold;
      gamificationPayload = state;
      new Notice(`${UI_LABELS.inbox.notices.updated} ${UI_LABELS.gamification.rewardLine(reward.xp, reward.gold)}`);
    } else {
      new Notice(UI_LABELS.inbox.notices.updated);
    }
    await writeDataFile(this.ctx.plugin, {
      gamification: gamificationPayload,
      projects: data.projects ?? [],
      reminders: data.reminders ?? [],
      inbox,
      trash: data.trash ?? [],
      inboxArchive: [...archive, newEntry],
    });
    rowEl.remove();
    if (this.ctx.plugin.settings.enableGamification) {
      this.ctx.plugin.gamification?.updateState?.();
    }
    setTimeout(() => this.forceRefresh(), 0);
  }

  private async handleDeleteFromArchive(entry: InboxArchiveItem, rowEl: HTMLElement): Promise<void> {
    const data = await readDataFile(this.ctx.plugin);
    const archive = (data.inboxArchive ?? []).filter((e) => e.text !== entry.text || e.completedAt !== entry.completedAt);
    const trash = [...(data.trash ?? []), INBOX_ARCHIVE_TRASH_PREFIX + entry.text];
    await writeDataFile(this.ctx.plugin, {
      gamification: data.gamification,
      projects: data.projects ?? [],
      reminders: data.reminders ?? [],
      inbox: data.inbox ?? [],
      trash,
      inboxArchive: archive,
    });
    rowEl.remove();
    new Notice(UI_LABELS.inbox.notices.movedToTrash);
    this.ctx.plugin.triggerTrashRefresh?.();
    this.forceRefresh();
  }

  private async handleEdit(originalText: string, rowEl: HTMLElement): Promise<void> {
    const textSpan = rowEl.querySelector(".inbox-text");
    const actionsDiv = rowEl.querySelector(".inbox-actions");
    if (textSpan) (textSpan as HTMLElement).style.display = "none";
    if (actionsDiv) (actionsDiv as HTMLElement).style.visibility = "hidden";

    const editInput = rowEl.createEl("input", { type: "text", cls: "view-input" });
    (editInput as HTMLInputElement).value = originalText;
    (editInput as HTMLInputElement).style.width = "100%";
    rowEl.insertBefore(editInput, rowEl.firstChild);
    editInput.focus();

    const save = async () => {
      const newText = (editInput as HTMLInputElement).value.trim();
      editInput.remove();
      if (textSpan) (textSpan as HTMLElement).style.display = "";
      if (actionsDiv) (actionsDiv as HTMLElement).style.visibility = "";
      if (newText && newText !== originalText) {
        const dataPath = this.getDataPath();
        const data = await readDataFile(this.ctx.plugin);
        const inbox = data.inbox ?? [];
        const idx = inbox.findIndex((l) => (l as string).trim() === originalText);
        if (idx !== -1) {
          const next = [...inbox];
          next[idx] = newText;
          await writeDataFile(this.ctx.plugin, {
            gamification: data.gamification,
            projects: data.projects ?? [],
            reminders: data.reminders ?? [],
            inbox: next,
            trash: data.trash ?? [],
            inboxArchive: data.inboxArchive ?? [],
          });
          new Notice(UI_LABELS.inbox.notices.updated);
          if (textSpan) textSpan.textContent = newText;
          rowEl.setAttribute("data-original-text", newText);
        }
      }
      this.scheduleRefresh();
    };

    editInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        editInput.remove();
        if (textSpan) (textSpan as HTMLElement).style.display = "";
        if (actionsDiv) (actionsDiv as HTMLElement).style.visibility = "";
      }
    });
    editInput.addEventListener("blur", () => { if (editInput.parentElement) save(); });
  }

  private handleCreateTask(originalText: string, rowEl: HTMLElement): void {
    const name = originalText.replace(/[\\/:*?"<>|]/g, "").trim();
    if (!name) {
      new Notice(UI_LABELS.inbox.notices.emptyName);
      return;
    }
    const onSuccess = async (): Promise<void> => {
      const dataPath = this.getDataPath();
      const data = await readDataFile(this.ctx.plugin);
      const inbox = (data.inbox ?? []).filter((l) => (l as string).trim() !== originalText);
      await writeDataFile(this.ctx.plugin, {
        gamification: data.gamification,
        projects: data.projects ?? [],
        reminders: data.reminders ?? [],
        inbox,
        trash: data.trash ?? [],
        inboxArchive: data.inboxArchive ?? [],
      });
      rowEl.remove();
      this.forceRefresh();
    };
    this.ctx.plugin.openCreateTaskFromInbox?.(name, onSuccess);
  }

  private handleReminder(originalText: string, rowEl: HTMLElement): void {
    this.ctx.plugin.openCreateReminderFromInbox?.(originalText, async (result) => {
      const dateStr = `${result.date.getDate().toString().padStart(2, "0")}-${(result.date.getMonth() + 1).toString().padStart(2, "0")}-${result.date.getFullYear()} ${result.date.getHours().toString().padStart(2, "0")}:${result.date.getMinutes().toString().padStart(2, "0")}`;
      const recurTag = result.recurrence ? ` (${result.recurrence})` : "";
      const reminderLine = `- [ ] ${result.text}${recurTag} (@${dateStr})`;

      const dataPath = this.getDataPath();
      const data = await readDataFile(this.ctx.plugin);
      const reminders = [...(data.reminders ?? []), reminderLine];
      const inbox = (data.inbox ?? []).filter((l) => (l as string).trim() !== originalText);
      await writeDataFile(this.ctx.plugin, {
        gamification: data.gamification,
        projects: data.projects ?? [],
        reminders,
        inbox,
        trash: data.trash ?? [],
        inboxArchive: data.inboxArchive ?? [],
      });

      rowEl.remove();
      new Notice(`В напоминания: ${dateStr}`);
      this.forceRefresh();
    });
  }
}
