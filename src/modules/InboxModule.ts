import type { ModuleContext } from "./types";
import { Paths } from "../core/Paths";
import { read } from "../core/FileIO";
import { readDataFile, updateDataFile, type InboxArchiveItem, INBOX_ARCHIVE_TRASH_PREFIX } from "../core/GamificationState";

const DEFAULT_INBOX_REWARDS = { xp: 5, gold: 2 };
import { UI_LABELS } from "../ui/Labels";
import { createCollapsibleSection } from "../ui/CollapsibleSection";
import { BlockRegistry } from "../ui/BlockRegistry";
import { Notice } from "obsidian";

interface InboxData {
  visibleLines: string[];
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
  private registry: BlockRegistry;
  /** Пропустить следующий refresh после добавления записи из формы. */
  private skipNextInboxRefresh = false;

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.registry = new BlockRegistry({
      app: ctx.app,
      isEnabled: () => ctx.plugin.settings.enableInbox,
      debounceMs: 500,
      domSelector: ".opa-inbox-view",
      createRefresh: (el) => () => this.render(el),
    });
  }

  private getDataPath(): string {
    return this.ctx.plugin.getGamificationDataPath();
  }

  private onChange = (file: { path?: string }): void => {
    if (file?.path && file.path !== this.getDataPath()) return;
    this.scheduleRefresh();
  };

  load(): void {
    const { plugin, app } = this.ctx;
    plugin.registerEvent(app.vault.on("modify", this.onChange));
    plugin.registerEvent(app.workspace.on("active-leaf-change", this.scheduleRefresh));

    plugin.registerMarkdownCodeBlockProcessor("opa-inbox-view", (_source, el) => {
      el.addClass("opa-inbox-view");
      this.registry.register(el, () => this.render(el));
    });
  }

  private scheduleRefresh = (): void => {
    if (this.skipNextInboxRefresh) {
      this.skipNextInboxRefresh = false;
      return;
    }
    this.registry.scheduleRefresh();
  };

  /** Принудительное обновление блоков инбокса (сразу после добавления записи). */
  forceRefresh(): void {
    this.registry.forceRefresh();
  }

  unload(): void {
    this.registry.clear();
  }

  updateState(): void {
    this.registry.runRefresh();
  }

  private async loadInboxData(): Promise<InboxData | null> {
    try {
      const data = await readDataFile(this.ctx.plugin);
      const visibleLines = (data.inbox ?? []).filter((l) => typeof l === "string" && l.trim().length > 0);
      if (visibleLines.length > 0 || (data.inbox ?? []).length > 0) {
        return { visibleLines, inboxArchive: data.inboxArchive ?? [] };
      }
      // data.json пуст — возможно, есть старый Inbox.md для миграции
      const content = await read(this.ctx.app, Paths.INBOX_FILE);
      if (content != null) {
        const migrated = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("- ["));
        if (migrated.length > 0) {
          await updateDataFile(this.ctx.plugin, (d) => {
            if (!d.inbox?.length) d.inbox = migrated;
          });
          return { visibleLines: migrated, inboxArchive: data.inboxArchive ?? [] };
        }
      }
      return { visibleLines: [], inboxArchive: data.inboxArchive ?? [] };
    } catch {
      new Notice(UI_LABELS.inbox.loadDataError);
      return null;
    }
  }

  /** Актуальный текст записи (после редактирования замыкания не устаревают). */
  private rowText(rowEl: HTMLElement, fallback: string): string {
    return rowEl.getAttribute("data-original-text") ?? fallback;
  }

  private async render(container: HTMLElement): Promise<void> {
    if (!this.ctx.plugin.settings.enableInbox) {
      container.empty();
      container.addClass("opa-hidden");
      return;
    }
    container.removeClass("opa-hidden");

    const L = UI_LABELS.inbox;
    const common = UI_LABELS.common;

    try {
      const data = await this.loadInboxData();

      container.empty();
      const body = createCollapsibleSection(container, "Блокнот", "inbox");

      if (!data) {
        body.createEl("p", { text: L.loadDataError, cls: "view-error" });
        return;
      }
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
          this.handleDone(this.rowText(row, line), row);
        });
        const btnTask = actions.createEl("button", { text: L.actions.task, cls: "inbox-action-btn" });
        btnTask.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.handleCreateTask(this.rowText(row, line), row);
        });
        const btnEdit = actions.createEl("button", { text: L.actions.edit, cls: "inbox-action-btn" });
        btnEdit.addEventListener("click", () => this.handleEdit(this.rowText(row, line), row));
        if (this.ctx.plugin.settings.enableReminders) {
          const btnReminder = actions.createEl("button", { text: L.actions.reminder, cls: "inbox-action-btn" });
          btnReminder.addEventListener("click", () => this.handleReminder(this.rowText(row, line), row));
        }
        const btnDel = actions.createEl("button", { text: L.actions.delete, cls: "inbox-action-btn" });
        btnDel.addEventListener("click", () => this.handleDelete(this.rowText(row, line), row));
      };

      addBtn.addEventListener("click", async () => {
        const val = input.value.trim();
        if (!val) return;
        const current = await readDataFile(this.ctx.plugin);
        if ((current.inbox ?? []).some((l) => l.trim() === val)) {
          new Notice(L.notices.duplicate);
          return;
        }
        input.value = "";
        this.skipNextInboxRefresh = true;
        await updateDataFile(this.ctx.plugin, (d) => {
          const inbox = d.inbox ?? [];
          if (!inbox.some((l) => l.trim() === val)) d.inbox = [...inbox, val];
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
        const archiveHeader = archiveSection.createEl("h3", { cls: "rv-section-header opa-collapsible-header" });
        const archiveArrow = archiveHeader.createEl("span", { cls: "rv-section-arrow", text: isArchiveCollapsed ? "▶" : "▼" });
        const titleSpan = archiveHeader.createEl("span", { cls: "rv-section-title-text" });
        titleSpan.setText(`📦 ${archiveTitle}`);
        archiveHeader.createEl("span", { cls: "rv-count", text: String(data.inboxArchive.length) });
        const archiveList = archiveSection.createEl("div", { cls: "rv-list inbox-archive-list" });
        archiveList.toggleClass("opa-hidden", isArchiveCollapsed);
        archiveHeader.addEventListener("click", () => {
          const collapsed = !archiveList.hasClass("opa-hidden");
          archiveList.toggleClass("opa-hidden", collapsed);
          archiveArrow.textContent = collapsed ? "▶" : "▼";
          setInboxArchiveCollapsed(collapsed);
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

    } catch (e) {
      container.empty();
      container.createEl("p", { text: UI_LABELS.errors.renderShort, cls: "view-error" });
      console.error(e);
    }
  }

  private async handleDelete(originalText: string, rowEl: HTMLElement): Promise<void> {
    let removed = false;
    await updateDataFile(this.ctx.plugin, (d) => {
      const inbox = d.inbox ?? [];
      const next = inbox.filter((l) => l.trim() !== originalText);
      if (next.length === inbox.length) return;
      removed = true;
      d.inbox = next;
      d.trash = [...(d.trash ?? []), originalText];
    });
    rowEl.remove();
    if (removed) this.ctx.plugin.triggerTrashRefresh?.();
    this.forceRefresh();
  }

  private async handleDone(originalText: string, rowEl: HTMLElement): Promise<void> {
    let removed = false;
    await updateDataFile(this.ctx.plugin, (d) => {
      const inbox = d.inbox ?? [];
      const next = inbox.filter((l) => l.trim() !== originalText);
      if (next.length === inbox.length) return;
      removed = true;
      d.inbox = next;
      d.inboxArchive = [...(d.inboxArchive ?? []), { text: originalText, completedAt: new Date().toISOString() }];
    });
    if (!removed) return;
    if (this.ctx.plugin.settings.enableGamification) {
      const state = await this.ctx.plugin.getGamificationState();
      const reward = this.ctx.plugin.settings.gamificationInboxRewards ?? DEFAULT_INBOX_REWARDS;
      state.xp += reward.xp;
      state.gold += reward.gold;
      this.ctx.plugin.scheduleGamificationSave();
      new Notice(`${UI_LABELS.inbox.notices.updated} ${UI_LABELS.gamification.rewardLine(reward.xp, reward.gold)}`);
      this.ctx.plugin.gamification?.updateState?.();
    } else {
      new Notice(UI_LABELS.inbox.notices.updated);
    }
    rowEl.remove();
    this.forceRefresh();
  }

  private async handleDeleteFromArchive(entry: InboxArchiveItem, rowEl: HTMLElement): Promise<void> {
    await updateDataFile(this.ctx.plugin, (d) => {
      d.inboxArchive = (d.inboxArchive ?? []).filter((e) => e.text !== entry.text || e.completedAt !== entry.completedAt);
      d.trash = [...(d.trash ?? []), INBOX_ARCHIVE_TRASH_PREFIX + entry.text];
    });
    rowEl.remove();
    new Notice(UI_LABELS.inbox.notices.movedToTrash);
    this.ctx.plugin.triggerTrashRefresh?.();
    this.forceRefresh();
  }

  private async handleEdit(originalText: string, rowEl: HTMLElement): Promise<void> {
    const textSpan = rowEl.querySelector<HTMLElement>(".inbox-text");
    rowEl.addClass("is-editing");

    const editInput = rowEl.createEl("input", { type: "text", cls: "view-input inbox-edit-input" });
    editInput.value = originalText;
    rowEl.insertBefore(editInput, rowEl.firstChild);
    editInput.focus();

    const stopEditing = (): void => {
      editInput.remove();
      rowEl.removeClass("is-editing");
    };

    const save = async () => {
      const newText = editInput.value.trim();
      stopEditing();
      if (newText && newText !== originalText) {
        let updated = false;
        await updateDataFile(this.ctx.plugin, (d) => {
          const inbox = d.inbox ?? [];
          const idx = inbox.findIndex((l) => l.trim() === originalText);
          if (idx === -1) return;
          updated = true;
          const next = [...inbox];
          next[idx] = newText;
          d.inbox = next;
        });
        if (updated) {
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
        stopEditing();
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
      await updateDataFile(this.ctx.plugin, (d) => {
        d.inbox = (d.inbox ?? []).filter((l) => l.trim() !== originalText);
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

      await updateDataFile(this.ctx.plugin, (d) => {
        d.reminders = [...(d.reminders ?? []), reminderLine];
        d.inbox = (d.inbox ?? []).filter((l) => l.trim() !== originalText);
      });

      rowEl.remove();
      new Notice(`В напоминания: ${dateStr}`);
      this.forceRefresh();
    });
  }
}
