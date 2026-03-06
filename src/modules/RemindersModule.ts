import type { ModuleContext } from "./types";
import { Paths } from "../core/Paths";
import {
  read,
  modify,
  processFile,
  findLineIndexByText,
  replaceLineByText,
  deleteLineAtIndex,
  toggleTaskCheckbox,
} from "../core/FileIO";
import { readDataFile, writeDataFile, getRewardForDifficulty } from "../core/GamificationState";
import { TFile, Notice, Modal } from "obsidian";
import {
  REMINDER_DATE_TAG_REGEX,
  formatReminderDateTag,
  replaceReminderDateTag,
  fromNow,
  parseCompletedTaskWithRecurrence,
  parseRecurrenceFromText,
  buildRecurrenceTaskLine,
  completedLineWithoutRecurrence,
  isRecurrenceCompletionOnTime,
  type ReminderItem,
  type ReminderData,
} from "../core/ReminderDataUtils";
import { UI_LABELS } from "../ui/Labels";
import { createCollapsibleSection } from "../ui/CollapsibleSection";

const STORAGE_KEY_PREFIX = "opa-reminders-collapsed-";
const FALLBACK_CHECK_MS = 60 * 1000;

export type { ReminderItem };

const SECTION_CONFIG: { key: keyof ReminderData; icon: string }[] = [
  { key: "overdue", icon: "🔥" },
  { key: "today", icon: "📅" },
  { key: "tomorrow", icon: "🌤️" },
  { key: "upcoming", icon: "🔭" },
];

function getGroupState(sectionTitle: string): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_PREFIX + sectionTitle) === "1";
  } catch {
    return false;
  }
}

function setGroupState(sectionTitle: string, collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(STORAGE_KEY_PREFIX + sectionTitle, "1");
    else localStorage.removeItem(STORAGE_KEY_PREFIX + sectionTitle);
  } catch {}
}

const ARCHIVE_GROUP_KEY_PREFIX = STORAGE_KEY_PREFIX + "archive-";

/** Состояние группы архива: по умолчанию свернуто (true). */
function getArchiveGroupState(groupName: string): boolean {
  try {
    return localStorage.getItem(ARCHIVE_GROUP_KEY_PREFIX + groupName) !== "0";
  } catch {
    return true;
  }
}

function setArchiveGroupState(groupName: string, collapsed: boolean): void {
  try {
    localStorage.setItem(ARCHIVE_GROUP_KEY_PREFIX + groupName, collapsed ? "1" : "0");
  } catch {}
}

export class RemindersModule {
  private ctx: ModuleContext;
  private blocks = new Set<{ el: HTMLElement; refresh: () => void }>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private nextCheckTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /** true пока открыто окно выбора даты переноса — не показывать новое уведомление */
  private pickerModalOpen = false;
  /** восстановить фокус в поле ввода после добавления напоминания */
  private shouldRestoreFocus = false;
  /** true пока открыто окно уведомления о напоминании — не открывать второе поверх */
  notificationModalOpen = false;
  /** true пока открыто окно настройки/создания напоминания — не показывать уведомление о срабатывании */
  reminderSettingsModalOpen = false;

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
  }

  private onLeafChange = (): void => this.scheduleRefresh();

  private isExcludedPath(path: string): boolean {
    const prefix = Paths.TEMPLATES_FOLDER.replace(/\/?$/, "") + "/";
    return path.startsWith(prefix) || path === Paths.TRASH_FILE;
  }

  private recurCompletionDebounce: ReturnType<typeof setTimeout> | null = null;
  private readonly RECUR_DEBOUNCE_MS = 600;

  /** Обработать файл: для выполненных повторяющихся напоминаний создать следующее вхождение (если отмечено в самой заметке, не в блоке). */
  private async processFileRecurringCompletions(filePath: string): Promise<void> {
    if (!this.ctx.plugin.settings.enableReminders) return;
    if (this.isExcludedPath(filePath)) return;
    const content = await read(this.ctx.app, filePath);
    if (!content) return;
    const lines = content.split("\n");
    const dataPath = this.ctx.plugin.getGamificationDataPath();
    if (filePath === dataPath) return;

    const indices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseCompletedTaskWithRecurrence(lines[i].trim());
      if (parsed) indices.push(i);
    }
    if (indices.length === 0) return;

    const currentLines = lines.slice();
    for (let k = indices.length - 1; k >= 0; k--) {
      const lineIdx = indices[k];
      const line = currentLines[lineIdx];
      const parsed = parseCompletedTaskWithRecurrence(line.trim());
      if (!parsed) continue;

      const nextDate = new Date();
      const u = parsed.unit.toLowerCase();
      if (u.startsWith("week")) nextDate.setDate(nextDate.getDate() + parsed.amount * 7);
      else if (u.startsWith("month")) nextDate.setMonth(nextDate.getMonth() + parsed.amount);
      else if (u.startsWith("year")) nextDate.setFullYear(nextDate.getFullYear() + parsed.amount);
      else nextDate.setDate(nextDate.getDate() + parsed.amount);
      const recurrenceStr = `every ${parsed.amount} ${parsed.unit}`;
      const dateTag = formatReminderDateTag(nextDate);
      const textClean = (parsed.textPrefix + parsed.textSuffix).replace(REMINDER_DATE_TAG_REGEX, "").trim();
      const newLine = buildRecurrenceTaskLine(parsed.indent, textClean, recurrenceStr, dateTag);

      const nextLine = currentLines[lineIdx + 1]?.trim() ?? "";
      const nextHasRecur = /\(every\s+\d+\s+(day|days|week|weeks|month|months|year|years)\)/i.test(nextLine);
      const nextTextClean = nextLine.replace(REMINDER_DATE_TAG_REGEX, "").replace(/\(every\s+\d+\s+(day|days|week|weeks|month|months|year|years)\)/gi, "").trim();
      if (nextLine && nextHasRecur && nextTextClean === textClean) continue;

      currentLines[lineIdx] = completedLineWithoutRecurrence(line, parsed.recurrenceFull);
      currentLines.splice(lineIdx + 1, 0, newLine);
    }
    const newContent = currentLines.join("\n");
    if (newContent !== content) await modify(this.ctx.app, filePath, newContent);
  }

  private onVaultModifyForRecur = (file: TFile): void => {
    if (!file.path.endsWith(".md")) return;
    if (this.recurCompletionDebounce) clearTimeout(this.recurCompletionDebounce);
    this.recurCompletionDebounce = setTimeout(() => {
      this.recurCompletionDebounce = null;
      this.processFileRecurringCompletions(file.path).then(() => this.scheduleRefresh());
    }, this.RECUR_DEBOUNCE_MS);
  };

  load(): void {
    this.ctx.remindersIndex.ensureSubscribed(() => this.scheduleRefresh());
    this.ctx.app.workspace.on("active-leaf-change", this.onLeafChange);
    this.ctx.app.vault.on("modify", this.onVaultModifyForRecur);

    this.ctx.plugin.registerMarkdownCodeBlockProcessor("opa-reminders-view", (_source, el) => {
      el.addClass("opa-reminders-view");
      this.blocks.forEach((b) => { if (b.el === el) this.blocks.delete(b); });
      const refresh = () => this.render(el);
      this.blocks.add({ el, refresh });
      this.render(el);
    });
  }

  /** Есть ли хотя бы один блок напоминаний в активной вкладке. */
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
    if (!this.ctx.plugin.settings.enableReminders) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.runRefresh();
    }, 250);
  };

  /** Принудительное обновление блоков без задержки (сразу после добавления/изменения). */
  private forceRefresh(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.runRefresh();
  }

  updateState(): void {
    if (this.ctx.plugin.settings.enableReminders) this.startChecker();
    else this.stopChecker();
    this.runRefresh();
  }

  unload(): void {
    this.stopChecker();
    this.ctx.app.workspace.off("active-leaf-change", this.onLeafChange);
    this.ctx.app.vault.off("modify", this.onVaultModifyForRecur);
    if (this.recurCompletionDebounce) clearTimeout(this.recurCompletionDebounce);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.blocks.clear();
  }

  private async startChecker(): Promise<void> {
    this.stopChecker();
    await this.runReminderCheck();
    await this.scheduleNextReminderCheck();
  }

  private stopChecker(): void {
    if (this.nextCheckTimeoutId) {
      clearTimeout(this.nextCheckTimeoutId);
      this.nextCheckTimeoutId = null;
    }
  }

  /** Таймер до ближайшего напоминания; при отсутствии — повтор через FALLBACK_CHECK_MS. */
  private async scheduleNextReminderCheck(): Promise<void> {
    if (!this.ctx.plugin.settings.enableReminders) return;
    await this.ctx.remindersIndex.waitReady();
    const ms = this.ctx.remindersIndex.getNextTriggerMs();
    this.nextCheckTimeoutId = setTimeout(
      () => {
        this.nextCheckTimeoutId = null;
        this.startChecker();
      },
      ms != null ? Math.max(1000, ms) : FALLBACK_CHECK_MS
    );
  }

  /** Время срабатывания: если нет времени в задаче — 10:00 в день срока. */
  private getTriggerTime(item: ReminderItem): Date {
    if (item.displayTime) return item.date;
    const d = new Date(item.date);
    d.setHours(10, 0, 0, 0);
    return d;
  }

  private async runReminderCheck(): Promise<void> {
    if (!this.ctx.plugin.settings.enableReminders) return;
    if (this.pickerModalOpen) return;
    if (this.notificationModalOpen) return;
    if (this.reminderSettingsModalOpen) return;
    if (document.querySelector(".modal.modal-open.opa-reminder-settings-modal")) return;
    if (document.querySelector(".modal.modal-open")) return;
    try {
      await this.ctx.remindersIndex.waitReady();
      const data = this.ctx.remindersIndex.getReminderData();
      const candidates = [...data.overdue, ...data.today].sort(
        (a, b) => a.date.getTime() - b.date.getTime()
      );
      const now = new Date();
      for (const item of candidates) {
        const trigger = this.getTriggerTime(item);
        if (now.getTime() >= trigger.getTime()) {
          this.openNotificationModal(item);
          return;
        }
      }
    } catch (e) {
      console.error("[Reminders] check error:", e);
    }
  }

  private getDataPath(): string {
    return this.ctx.plugin.getGamificationDataPath();
  }

  /** Синхронно получить данные напоминаний из индекса (для рендера). */
  private getReminderData(): ReminderData {
    return this.ctx.remindersIndex.getReminderData();
  }

  private openNotificationModal(item: ReminderItem): void {
    if (this.notificationModalOpen) return;
    this.notificationModalOpen = true;
    const app = this.ctx.app;
    const L = UI_LABELS.reminders;
    const snooze = L.snooze;
    const common = UI_LABELS.common;

    class NotificationModal extends Modal {
      onOpen() {
        this.modalEl.addClass("opa-reminder-notification-modal");
        this.scope.register(null, "Escape", () => false);
        this.contentEl.empty();
        this.contentEl.createEl("div", {
          cls: "opa-reminder-notif-title",
          text: "🔔 Напоминание",
        }).style.cssText = "color: var(--interactive-accent); margin-bottom: 15px; font-weight: bold;";
        this.contentEl.createEl("div", {
          cls: "opa-reminder-notif-text",
          text: item.text,
        }).style.cssText = "font-size: 1.1em; font-weight: bold; margin-bottom: 8px; line-height: 1.4;";
        const timeStr = item.displayTime
          ? `${item.displayDate} в ${item.displayTime}`
          : item.displayDate;
        this.contentEl.createEl("div", {
          text: `Срок: ${timeStr}`,
        }).style.cssText = "color: var(--text-muted); margin-bottom: 25px; font-size: 0.9em;";
        const btnContainer = this.contentEl.createEl("div", { cls: "opa-reminder-notif-btns" });

        const addBtn = (label: string, fn: () => void | Promise<void>, primary = false) => {
          const btn = btnContainer.createEl("button", { text: label, cls: primary ? "opa-reminder-notif-btn opa-reminder-notif-btn-primary" : "opa-reminder-notif-btn" });
          btn.addEventListener("click", async () => {
            try {
              await fn();
              this.close();
            } catch (e) {
              new Notice(e instanceof Error ? e.message : "Ошибка");
            }
          });
        };

        addBtn(snooze.doneBtn, async () => {
          await this.remindersRef.completeReminder(item);
          new Notice(snooze.done);
        }, true);
        addBtn(snooze.oneHourBtn, async () => {
          await this.remindersRef.snoozeReminder(item, 60);
          new Notice(snooze.oneHour);
        });
        addBtn(snooze.tomorrowBtn, async () => {
          await this.remindersRef.snoozeReminder(item, 1440);
          new Notice(snooze.tomorrow);
        });
        addBtn(snooze.pickDateBtn, async () => {
          const ref = this.remindersRef;
          const remItem = item;
          this.close();
          ref.pickerModalOpen = true;
          class PickerModal extends Modal {
            onOpen() {
              this.modalEl.addClass("opa-reminder-picker-modal");
              this.modalEl.style.width = "320px";
              this.modalEl.style.maxWidth = "92vw";
              this.contentEl.empty();
              this.titleEl.setText(snooze.pickerTitle);
              const now = new Date();
              const defaultVal = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${(now.getDate() + 1).toString().padStart(2, "0")}T10:00`;
              const dateInput = this.contentEl.createEl("input", { type: "datetime-local", cls: "view-input opa-reminder-picker-input" });
              (dateInput as HTMLInputElement).value = defaultVal;
              (dateInput as HTMLInputElement).style.marginBottom = "15px";
              (dateInput as HTMLInputElement).style.boxSizing = "border-box";
              const actionsWrap = this.contentEl.createEl("div", { cls: "opa-reminder-picker-actions" });
              const saveBtn = actionsWrap.createEl("button", { text: common.save, cls: "mod-cta mod-cta-primary opa-reminder-picker-save" });
              const doSave = () => {
                const val = (dateInput as HTMLInputElement).value;
                if (val) {
                  this.close();
                  ref.setReminderDate(remItem, val).then(() => {
                    new Notice(snooze.rescheduled(new Date(val).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })));
                  });
                }
              };
              saveBtn.addEventListener("click", doSave);
              this.contentEl.addEventListener("keydown", (e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  doSave();
                }
              });
            }
            onClose() {
              ref.pickerModalOpen = false;
            }
          }
          new PickerModal(app).open();
        });
      }
      onClose() {
        this.remindersRef.notificationModalOpen = false;
      }
      constructor(app: App, private remindersRef: RemindersModule) {
        super(app);
      }
    }
    new NotificationModal(app, this).open();
  }

  private async snoozeReminder(item: ReminderItem, minutes: number): Promise<void> {
    const dataPath = this.getDataPath();
    if (item.filePath === dataPath) {
      const data = await readDataFile(this.ctx.plugin);
      const reminders = data.reminders ?? [];
      const idx = reminders.findIndex((l) => l.trim() === item.lineText);
      if (idx === -1) return;
      const newDate = new Date(Date.now() + minutes * 60 * 1000);
      const newTag = formatReminderDateTag(newDate);
      const next = [...reminders];
      next[idx] = replaceReminderDateTag(next[idx], newTag);
      await writeDataFile(this.ctx.plugin, {
        gamification: data.gamification,
        projects: data.projects ?? [],
        reminders: next,
        inbox: data.inbox ?? [],
        trash: data.trash ?? [],
      });
      await this.ctx.remindersIndex.refreshDataJson();
    } else {
      const file = this.ctx.app.vault.getAbstractFileByPath(item.filePath);
      if (!file || !(file instanceof TFile)) return;
      const content = await read(this.ctx.app, item.filePath);
      if (!content) return;
      const lines = content.split("\n");
      const lineIdx = findLineIndexByText(lines, item.lineText);
      if (lineIdx === -1) return;
      const newDate = new Date(Date.now() + minutes * 60 * 1000);
      const newTag = formatReminderDateTag(newDate);
      const newLine = replaceReminderDateTag(lines[lineIdx], newTag);
      lines[lineIdx] = newLine;
      await modify(this.ctx.app, item.filePath, lines.join("\n"));
    }
    this.scheduleRefresh();
  }

  private async setReminderDate(item: ReminderItem, dateIso: string): Promise<void> {
    const dataPath = this.getDataPath();
    if (item.filePath === dataPath) {
      const data = await readDataFile(this.ctx.plugin);
      const reminders = data.reminders ?? [];
      const idx = reminders.findIndex((l) => l.trim() === item.lineText);
      if (idx === -1) return;
      const newTag = formatReminderDateTag(new Date(dateIso));
      const next = [...reminders];
      next[idx] = replaceReminderDateTag(next[idx], newTag);
      await writeDataFile(this.ctx.plugin, {
        gamification: data.gamification,
        projects: data.projects ?? [],
        reminders: next,
        inbox: data.inbox ?? [],
        trash: data.trash ?? [],
      });
      await this.ctx.remindersIndex.refreshDataJson();
    } else {
      const file = this.ctx.app.vault.getAbstractFileByPath(item.filePath);
      if (!file || !(file instanceof TFile)) return;
      const content = await read(this.ctx.app, item.filePath);
      if (!content) return;
      const lines = content.split("\n");
      const lineIdx = findLineIndexByText(lines, item.lineText);
      if (lineIdx === -1) return;
      const newTag = formatReminderDateTag(new Date(dateIso));
      const newLine = replaceReminderDateTag(lines[lineIdx], newTag);
      lines[lineIdx] = newLine;
      await modify(this.ctx.app, item.filePath, lines.join("\n"));
    }
    this.scheduleRefresh();
  }

  private async render(container: HTMLElement): Promise<void> {
    if (!this.ctx.plugin.settings.enableReminders) {
      container.empty();
      container.style.display = "none";
      return;
    }
    container.style.display = "";

    const scrollableParent = container.closest(".cm-scroller, .markdown-reading-view, .markdown-preview-view") as HTMLElement | null;
    const scrollTop = scrollableParent?.scrollTop ?? 0;

    const L = UI_LABELS.reminders;
    const sec = L.sections;
    const common = UI_LABELS.common;

    try {
      await this.ctx.remindersIndex.waitReady();
      const data = this.getReminderData();

      container.empty();
      const body = createCollapsibleSection(container, "Напоминания", "reminders");

      const formWrap = body.createEl("div", { cls: "view-add-form" });
      const input = formWrap.createEl("input", {
        type: "text",
        cls: "view-input",
        attr: { placeholder: L.addPlaceholder, "data-focus-restore": "add-input" },
      });
      const addBtn = formWrap.createEl("button", { text: common.add, cls: "view-btn" });
      addBtn.addEventListener("click", async () => {
        const text = (input as HTMLInputElement).value.trim();
        if (!text) return;
        const result = await this.openReminderModal(text);
        if (result) {
          const dateStr = `${result.date.getDate().toString().padStart(2, "0")}-${(result.date.getMonth() + 1).toString().padStart(2, "0")}-${result.date.getFullYear()} ${result.date.getHours().toString().padStart(2, "0")}:${result.date.getMinutes().toString().padStart(2, "0")}`;
          const recurTag = result.recurrence ? ` (${result.recurrence})` : "";
          const line = `- [ ] ${result.text}${recurTag} (@${dateStr})`;
          const data = await readDataFile(this.ctx.plugin);
          const reminders = [...(data.reminders ?? []), line];
          await writeDataFile(this.ctx.plugin, {
            gamification: data.gamification,
            projects: data.projects ?? [],
          reminders,
          inbox: data.inbox ?? [],
          trash: data.trash ?? [],
        });
          await this.ctx.remindersIndex.refreshDataJson();
          this.forceRefresh();
          new Notice(L.notices.addedTo("data.json"));
          (input as HTMLInputElement).value = "";
          this.shouldRestoreFocus = true;
        }
        setTimeout(() => (input as HTMLInputElement).focus(), 150);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addBtn.click();
      });

      const total = data.overdue.length + data.today.length + data.tomorrow.length + data.upcoming.length;

      if (total === 0) {
        body.createEl("div", { text: L.empty, cls: "rv-empty" });
      } else {
      const listWrapper = body.createEl("div", { cls: "reminders-list" });

      for (const { key, icon } of SECTION_CONFIG) {
        const items = data[key];
        if (items.length === 0) continue;
        const title = sec[key];
        const isCollapsed = getGroupState(title);
        const section = listWrapper.createEl("div", { cls: `rv-section rv-${key}` });

        const header = section.createEl("h3", { cls: "rv-section-header" });
        header.style.cursor = "pointer";
        header.style.userSelect = "none";
        header.style.display = "flex";
        header.style.alignItems = "center";

        const arrow = header.createEl("span", { cls: "rv-section-arrow", text: isCollapsed ? "▶" : "▼" });
        const titleSpan = header.createEl("span", { cls: "rv-section-title-text" });
        titleSpan.innerHTML = `${icon} ${title ?? key}`;
        header.createEl("span", { cls: "rv-count", text: String(items.length) });

        const list = section.createEl("div", { cls: "rv-list" });
        list.style.display = isCollapsed ? "none" : "block";

        header.addEventListener("click", () => {
          const collapsed = list.style.display === "none";
          list.style.display = collapsed ? "block" : "none";
          arrow.textContent = collapsed ? "▼" : "▶";
          setGroupState(title, !collapsed);
        });

        for (const item of items) {
          const row = list.createEl("div", { cls: `rv-item rv-item-${item.type}` });

          const contentWrap = row.createEl("div", { cls: "rv-item-content-wrap" });
          const checkboxLabel = contentWrap.createEl("label", { cls: "rv-checkbox-label" });
          const checkbox = checkboxLabel.createEl("input", { type: "checkbox", cls: "rv-checkbox" });
          checkbox.checked = false;
          checkbox.addEventListener("click", (e) => {
            e.stopPropagation();
            this.completeReminder(item);
          });

          const content = contentWrap.createEl("div", { cls: "rv-content" });
          let displayText = item.text;
          if (item.isRecurring) displayText = "🔁 " + displayText;
          content.createEl("div", { cls: "rv-text", text: displayText });
          const fileName = item.filePath === this.getDataPath() ? "reminders" : (item.filePath.split("/").pop()?.replace(/\.md$/i, "") ?? "Reminders");
          const fileLink = content.createEl("a", { cls: "rv-file-link", text: fileName });
          fileLink.addEventListener("click", (e) => {
            e.preventDefault();
            this.ctx.app.workspace.openLinkText(item.filePath, "", false);
          });

          const timeDiv = row.createEl("div", { cls: "rv-time" });
          const timeText = item.displayTime ? `${item.displayDate} ${item.displayTime}` : item.displayDate;
          timeDiv.createEl("span", { cls: "rv-badge rv-badge-date", text: timeText });
          timeDiv.createEl("span", { cls: "rv-rel-time", text: fromNow(item.date) });

          const actions = row.createEl("div", { cls: "rv-actions" });
          const editBtn = actions.createEl("button", { text: L.edit, cls: "inbox-action-btn" });
          editBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.startInlineEdit(row, item, () => this.scheduleRefresh());
          });
          const deleteBtn = actions.createEl("button", { text: L.delete, cls: "inbox-action-btn" });
          deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.deleteReminder(item, list, section);
          });

          row.appendChild(timeDiv);
          row.appendChild(actions);
        }
      }
      }

      if (data.completed.length > 0) {
        const archiveTitle = sec.archive ?? "Архив";
        const isArchiveCollapsed = getGroupState(archiveTitle);
        const archiveSection = body.createEl("div", { cls: "rv-section rv-completed" });
        const archiveHeader = archiveSection.createEl("h3", { cls: "rv-section-header" });
        archiveHeader.style.cursor = "pointer";
        archiveHeader.style.userSelect = "none";
        archiveHeader.style.display = "flex";
        archiveHeader.style.alignItems = "center";
        const archiveArrow = archiveHeader.createEl("span", { cls: "rv-section-arrow", text: isArchiveCollapsed ? "▶" : "▼" });
        archiveHeader.createEl("span", { cls: "rv-section-title-text" }).innerHTML = `📦 ${archiveTitle}`;
        archiveHeader.createEl("span", { cls: "rv-count", text: String(data.completed.length) });
        const archiveList = archiveSection.createEl("div", { cls: "rv-list" });
        archiveList.style.display = isArchiveCollapsed ? "none" : "block";
        archiveHeader.addEventListener("click", () => {
          const collapsed = archiveList.style.display === "none";
          archiveList.style.display = collapsed ? "block" : "none";
          archiveArrow.textContent = collapsed ? "▼" : "▶";
          setGroupState(archiveTitle, !collapsed);
        });
        const byName = new Map<string, ReminderItem[]>();
        for (const item of data.completed) {
          const key = item.text.trim();
          if (!byName.has(key)) byName.set(key, []);
          byName.get(key)!.push(item);
        }
        const appendArchiveRow = (item: ReminderItem, parentList: HTMLElement): void => {
          const row = parentList.createEl("div", { cls: "rv-item rv-item-completed" });
          const contentWrap = row.createEl("div", { cls: "rv-item-content-wrap" });
          const content = contentWrap.createEl("div", { cls: "rv-content" });
          const displayText = item.isRecurring ? "🔁 " + item.text : item.text;
          content.createEl("div", { cls: "rv-text", text: displayText });
          const fileName = item.filePath === this.getDataPath() ? "reminders" : (item.filePath.split("/").pop()?.replace(/\.md$/i, "") ?? "Reminders");
          const fileLink = content.createEl("a", { cls: "rv-file-link", text: fileName });
          fileLink.addEventListener("click", (e) => {
            e.preventDefault();
            this.ctx.app.workspace.openLinkText(item.filePath, "", false);
          });
          const timeDiv = row.createEl("div", { cls: "rv-time" });
          const timeText = item.displayTime ? `${item.displayDate} ${item.displayTime}` : item.displayDate;
          timeDiv.createEl("span", { cls: "rv-badge rv-badge-date", text: timeText });
          const actions = row.createEl("div", { cls: "rv-actions" });
          const deleteBtn = actions.createEl("button", { text: L.delete, cls: "inbox-action-btn" });
          deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.deleteReminder(item, parentList, archiveSection);
          });
          row.appendChild(timeDiv);
          row.appendChild(actions);
        };
        for (const [groupName, items] of byName) {
          if (items.length === 1) {
            appendArchiveRow(items[0], archiveList);
            continue;
          }
          const groupDiv = archiveList.createEl("div", { cls: "rv-archive-group" });
          const isGroupCollapsed = getArchiveGroupState(groupName);
          const groupHeader = groupDiv.createEl("div", { cls: "rv-archive-group-header" });
          groupHeader.style.cursor = "pointer";
          groupHeader.style.userSelect = "none";
          groupHeader.style.display = "flex";
          groupHeader.style.alignItems = "center";
          const groupArrow = groupHeader.createEl("span", { cls: "rv-section-arrow", text: isGroupCollapsed ? "▶" : "▼" });
          groupHeader.createEl("span", { cls: "rv-text", text: groupName });
          groupHeader.createEl("span", { cls: "rv-count", text: String(items.length) });
          const subList = groupDiv.createEl("div", { cls: "rv-archive-sublist" });
          subList.style.display = isGroupCollapsed ? "none" : "block";
          groupHeader.addEventListener("click", () => {
            const collapsed = subList.style.display === "none";
            subList.style.display = collapsed ? "block" : "none";
            groupArrow.textContent = collapsed ? "▼" : "▶";
            setArchiveGroupState(groupName, !collapsed);
          });
          for (const item of items) {
            appendArchiveRow(item, subList);
          }
        }
      }

      if (scrollableParent?.isConnected) {
        scrollableParent.scrollTop = scrollTop;
        setTimeout(() => {
          if (scrollableParent.isConnected) scrollableParent.scrollTop = scrollTop;
        }, 0);
      }
      if (this.shouldRestoreFocus) {
        this.shouldRestoreFocus = false;
        setTimeout(() => {
          const el = container.querySelector<HTMLElement>('[data-focus-restore="add-input"]');
          if (el) el.focus();
        }, 150);
      }
    } catch (e) {
      container.empty();
      container.createEl("p", { text: L.errorNotice ?? "Ошибка напоминаний", cls: "view-error" });
      console.error(e);
    }
  }

  private startInlineEdit(rowEl: HTMLElement, item: ReminderItem, onDone: () => void): void {
    const textDiv = rowEl.querySelector(".rv-text");
    const actionsEl = rowEl.querySelector(".rv-actions");
    const contentEl = rowEl.querySelector(".rv-content");
    if (!textDiv || !actionsEl || !contentEl) return;
    (textDiv as HTMLElement).style.display = "none";
    (actionsEl as HTMLElement).style.visibility = "hidden";
    contentEl.classList.add("is-editing");

    const taskPrefix = item.lineText.match(/^\s*[-*]\s+\[.\]\s*/i)?.[0] ?? "- [ ] ";
    const displayValue = item.lineText.replace(/^\s*[-*]\s+\[.\]\s*/i, "").trim();
    const editInput = contentEl.createEl("input", { type: "text", cls: "view-input rv-edit-input" });
    (editInput as HTMLInputElement).value = displayValue;
    (editInput as HTMLInputElement).style.width = "100%";
    (editInput as HTMLInputElement).style.marginBottom = "4px";
    contentEl.insertBefore(editInput, contentEl.children[1]);
    editInput.focus();

    const save = async () => {
      const newValue = (editInput as HTMLInputElement).value.trim();
      const fullLine = taskPrefix + newValue;
      if (newValue && fullLine !== item.lineText) {
        const ok = await this.editReminder(item, fullLine);
        if (ok) onDone();
      }
      cancel();
    };
    const cancel = () => {
      editInput.remove();
      (textDiv as HTMLElement).style.display = "";
      (actionsEl as HTMLElement).style.visibility = "";
      contentEl.classList.remove("is-editing");
    };

    editInput.addEventListener("keydown", async (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        await save();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
    editInput.addEventListener("blur", () => {
      if (editInput.parentElement) save();
    });
  }

  private async completeReminder(item: ReminderItem): Promise<void> {
    const dataPath = this.getDataPath();
    if (item.filePath === dataPath) {
      const data = await readDataFile(this.ctx.plugin);
      const reminders = data.reminders ?? [];
      const idx = reminders.findIndex((l) => l.trim() === item.lineText);
      if (idx === -1) {
        new Notice(UI_LABELS.reminders.notices.completeNotFound);
        return;
      }
      const completedLine = toggleTaskCheckbox(reminders[idx], true);
      const next = [...reminders];
      next[idx] = completedLine;
      const parsed = parseCompletedTaskWithRecurrence(completedLine);
      if (parsed) {
        const nextDate = new Date();
        const u = parsed.unit.toLowerCase();
        if (u.startsWith("week")) nextDate.setDate(nextDate.getDate() + parsed.amount * 7);
        else if (u.startsWith("month")) nextDate.setMonth(nextDate.getMonth() + parsed.amount);
        else if (u.startsWith("year")) nextDate.setFullYear(nextDate.getFullYear() + parsed.amount);
        else nextDate.setDate(nextDate.getDate() + parsed.amount);
        const recurrenceStr = `every ${parsed.amount} ${parsed.unit}`;
        const dateTag = formatReminderDateTag(nextDate);
        const textClean = (parsed.textPrefix + parsed.textSuffix).replace(REMINDER_DATE_TAG_REGEX, "").trim();
        const newLine = buildRecurrenceTaskLine(parsed.indent, textClean, recurrenceStr, dateTag);
        next[idx] = completedLineWithoutRecurrence(completedLine, parsed.recurrenceFull);
        next.splice(idx + 1, 0, newLine);
        new Notice(UI_LABELS.reminders.notices.nextCreated(parsed.amount, parsed.unit));
      }
      let gamificationPayload = data.gamification;
      if (this.ctx.plugin.settings.enableGamification) {
        const state = await this.ctx.plugin.getGamificationState();
        const reward = getRewardForDifficulty(null, this.ctx.plugin.gamificationDefaults);
        state.xp += reward.xp;
        state.gold += reward.gold;
        if (item.isRecurring && parsed) {
          const streakKey = item.text.trim() || "reminder";
          const graceMs = (this.ctx.plugin.settings.gamificationStreakGraceDays ?? 0) * 24 * 60 * 60 * 1000;
          const onTime = isRecurrenceCompletionOnTime(
            item.date,
            new Date(),
            parsed.amount,
            parsed.unit,
            graceMs
          );
          state.streaks[streakKey] = onTime ? (state.streaks[streakKey] ?? 0) + 1 : 1;
        }
        gamificationPayload = state;
      }
      await writeDataFile(this.ctx.plugin, {
        gamification: gamificationPayload,
        projects: data.projects ?? [],
        reminders: next,
        inbox: data.inbox ?? [],
        trash: data.trash ?? [],
      });
      await this.ctx.remindersIndex.refreshDataJson();
    } else {
      const file = this.ctx.app.vault.getAbstractFileByPath(item.filePath);
      if (!file || !(file instanceof TFile)) return;

      const ok = await processFile(this.ctx.app, file, (content) => {
        const lines = content.split("\n");
        const lineIdx = findLineIndexByText(lines, item.lineText);
        if (lineIdx === -1) return content;
        const newLine = toggleTaskCheckbox(lines[lineIdx], true);
        lines[lineIdx] = newLine;
        return lines.join("\n");
      });
      if (!ok) {
        new Notice(UI_LABELS.reminders.notices.completeNotFound);
        return;
      }

      const content = await read(this.ctx.app, item.filePath);
      if (content) {
        const lines = content.split("\n");
        const lineIdx = item.lineIndex;
        if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx]) {
          const parsed = parseCompletedTaskWithRecurrence(lines[lineIdx]);
          if (parsed) {
            const nextDate = new Date();
            const u = parsed.unit.toLowerCase();
            if (u.startsWith("week")) nextDate.setDate(nextDate.getDate() + parsed.amount * 7);
            else if (u.startsWith("month")) nextDate.setMonth(nextDate.getMonth() + parsed.amount);
            else if (u.startsWith("year")) nextDate.setFullYear(nextDate.getFullYear() + parsed.amount);
            else nextDate.setDate(nextDate.getDate() + parsed.amount);
            const recurrenceStr = `every ${parsed.amount} ${parsed.unit}`;
            const dateTag = formatReminderDateTag(nextDate);
            const textClean = (parsed.textPrefix + parsed.textSuffix).replace(REMINDER_DATE_TAG_REGEX, "").trim();
            const newLine = buildRecurrenceTaskLine(parsed.indent, textClean, recurrenceStr, dateTag);
            const newContent = replaceLineByText(content, lines[lineIdx], completedLineWithoutRecurrence(lines[lineIdx], parsed.recurrenceFull));
            const withNewLine = newContent.split("\n");
            withNewLine.splice(lineIdx + 1, 0, newLine);
            await modify(this.ctx.app, item.filePath, withNewLine.join("\n"));
            new Notice(UI_LABELS.reminders.notices.nextCreated(parsed.amount, parsed.unit));
          }
        }
      }
    }

    if (this.ctx.plugin.settings.enableGamification) {
      if (item.filePath !== dataPath) {
        const state = await this.ctx.plugin.getGamificationState();
        const reward = getRewardForDifficulty(null, this.ctx.plugin.gamificationDefaults);
        state.xp += reward.xp;
        state.gold += reward.gold;
        if (item.isRecurring) {
          const streakKey = item.text.trim() || "reminder";
          const recurrence = parseRecurrenceFromText(item.lineText);
          const graceMs = (this.ctx.plugin.settings.gamificationStreakGraceDays ?? 0) * 24 * 60 * 60 * 1000;
          const onTime =
            recurrence &&
            isRecurrenceCompletionOnTime(
              item.date,
              new Date(),
              recurrence.amount,
              recurrence.unit,
              graceMs
            );
          state.streaks[streakKey] = onTime ? (state.streaks[streakKey] ?? 0) + 1 : 1;
        }
        this.ctx.plugin.scheduleGamificationSave();
      }
      const reward = getRewardForDifficulty(null, this.ctx.plugin.gamificationDefaults);
      this.ctx.plugin.gamification?.updateState?.();
      new Notice(`${UI_LABELS.reminders.notices.completed} ${UI_LABELS.gamification.rewardLine(reward.xp, reward.gold)}`);
    } else {
      new Notice(UI_LABELS.reminders.notices.completed);
    }
    this.scheduleRefresh();
  }

  private async editReminder(item: ReminderItem, newLineText: string): Promise<boolean> {
    const dataPath = this.getDataPath();
    if (item.filePath === dataPath) {
      const data = await readDataFile(this.ctx.plugin);
      const reminders = data.reminders ?? [];
      const idx = reminders.findIndex((l) => l.trim() === item.lineText);
      if (idx === -1) return false;
      const next = [...reminders];
      next[idx] = newLineText.trim();
      await writeDataFile(this.ctx.plugin, {
        gamification: data.gamification,
        projects: data.projects ?? [],
        reminders: next,
        inbox: data.inbox ?? [],
        trash: data.trash ?? [],
      });
      await this.ctx.remindersIndex.refreshDataJson();
      new Notice(UI_LABELS.reminders.notices.updated);
    return true;
  }
  const content = await read(this.ctx.app, item.filePath);
    if (!content) return false;
    const newContent = replaceLineByText(content, item.lineText, newLineText.trim());
    if (newContent === content) return false;
    await modify(this.ctx.app, item.filePath, newContent);
    new Notice(UI_LABELS.reminders.notices.updated);
    return true;
  }

  private async deleteReminder(item: ReminderItem, listEl: HTMLElement, sectionEl: HTMLElement): Promise<void> {
    const dataPath = this.getDataPath();
    if (item.filePath === dataPath) {
      const data = await readDataFile(this.ctx.plugin);
      const reminders = data.reminders ?? [];
      const idx = reminders.findIndex((l) => l.trim() === item.lineText);
      if (idx === -1) {
        new Notice(UI_LABELS.reminders.notices.deleteNotFound);
        return;
      }
      const removedLine = reminders[idx];
      const next = reminders.filter((_, i) => i !== idx);
      const trash = [...(data.trash ?? []), removedLine];
      await writeDataFile(this.ctx.plugin, {
        gamification: data.gamification,
        projects: data.projects ?? [],
        reminders: next,
        inbox: data.inbox ?? [],
        trash,
      });
      await this.ctx.remindersIndex.refreshDataJson();
      new Notice(UI_LABELS.reminders.notices.movedToTrash);
      this.ctx.plugin.triggerTrashRefresh?.();
      this.scheduleRefresh();
      return;
    }
    const file = this.ctx.app.vault.getAbstractFileByPath(item.filePath);
    if (!file || !(file instanceof TFile)) return;
    const content = await read(this.ctx.app, item.filePath);
    if (!content) return;
    const lines = content.split("\n");
    const idx = findLineIndexByText(lines, item.lineText);
    if (idx === -1) {
      new Notice(UI_LABELS.reminders.notices.deleteNotFound);
      return;
    }
    const { content: newContent, removedLine } = deleteLineAtIndex(content, idx);
    await modify(this.ctx.app, item.filePath, newContent);
    if (removedLine) {
      const data = await readDataFile(this.ctx.plugin);
      const trash = [...(data.trash ?? []), removedLine];
      await writeDataFile(this.ctx.plugin, {
        gamification: data.gamification,
        projects: data.projects ?? [],
        reminders: data.reminders ?? [],
        inbox: data.inbox ?? [],
        trash,
      });
    }
    new Notice(UI_LABELS.reminders.notices.movedToTrash);
    this.ctx.plugin.triggerTrashRefresh?.();
    this.scheduleRefresh();
  }

  public openReminderModal(defaultText: string): Promise<{ text: string; date: Date; recurrence: string } | null> {
    this.reminderSettingsModalOpen = true;
    return new Promise((resolve) => {
      const app = this.ctx.app;
      const mod = UI_LABELS.reminders.modal;
      const common = UI_LABELS.common;
      const moduleRef = this;
      let resolved = false;
      const doResolve = (value: { text: string; date: Date; recurrence: string } | null) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      class ReminderModal extends Modal {
        saveBtn!: HTMLButtonElement;
        onOpen() {
          this.modalEl.addClass("opa-reminder-settings-modal");
          this.contentEl.empty();
          this.contentEl.createEl("h2", { text: mod.title });
          this.contentEl.createEl("div", { text: mod.textLabel, cls: "setting-item-description" });
          const textInput = this.contentEl.createEl("input", { type: "text", cls: "view-input" });
          textInput.value = defaultText;
          (textInput as HTMLInputElement).style.width = "100%";
          (textInput as HTMLInputElement).style.marginBottom = "15px";
          this.contentEl.createEl("div", { text: mod.dateLabel, cls: "setting-item-description" });
          const dateInput = this.contentEl.createEl("input", { type: "datetime-local", cls: "view-input" });
          const defaultDate = new Date();
          defaultDate.setTime(defaultDate.getTime() + 60 * 60 * 1000);
          (dateInput as HTMLInputElement).value = `${defaultDate.getFullYear()}-${(defaultDate.getMonth() + 1).toString().padStart(2, "0")}-${defaultDate.getDate().toString().padStart(2, "0")}T${defaultDate.getHours().toString().padStart(2, "0")}:${defaultDate.getMinutes().toString().padStart(2, "0")}`;
          (dateInput as HTMLInputElement).style.width = "100%";
          (dateInput as HTMLInputElement).style.marginBottom = "15px";
          this.contentEl.createEl("div", { text: mod.recurrenceLabel, cls: "setting-item-description" });
          const recurWrap = this.contentEl.createEl("div", { cls: "reminder-modal-recur" });
          recurWrap.style.display = "flex";
          recurWrap.style.gap = "10px";
          recurWrap.style.marginBottom = "20px";
          const recurAmount = recurWrap.createEl("input", { type: "number", cls: "view-input" });
          (recurAmount as HTMLInputElement).value = "1";
          (recurAmount as HTMLInputElement).min = "1";
          (recurAmount as HTMLInputElement).style.width = "60px";
          const recurUnit = recurWrap.createEl("select", { cls: "view-input" });
          recurUnit.style.flex = "1";
          [
            { value: "", label: mod.noRecurrence },
            { value: "days", label: mod.days },
            { value: "weeks", label: mod.weeks },
            { value: "months", label: mod.months },
            { value: "years", label: mod.years },
          ].forEach((o) => recurUnit.createEl("option", { value: o.value, text: o.label }));
          const btnWrap = this.contentEl.createEl("div", { cls: "modal-button-container" });
          const cancelBtn = btnWrap.createEl("button", { text: common.cancel, cls: "reminder-modal-cancel" });
          cancelBtn.addEventListener("click", () => {
            this.close();
            doResolve(null);
          });
          this.saveBtn = btnWrap.createEl("button", { text: common.save, cls: "mod-cta mod-cta-primary" }) as HTMLButtonElement;
          this.saveBtn.addEventListener("click", () => {
            const text = (textInput as HTMLInputElement).value.trim();
            const dateVal = (dateInput as HTMLInputElement).value;
            const unit = (recurUnit as HTMLSelectElement).value;
            const amount = (recurAmount as HTMLInputElement).value;
            if (!text || !dateVal) {
              new Notice(mod.fillRequired);
              return;
            }
            const recurrence = unit ? `every ${amount} ${unit}` : "";
            doResolve({
              text: text || defaultText,
              date: new Date(dateVal),
              recurrence,
            });
            this.close();
          });
          this.contentEl.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter") {
              e.preventDefault();
              this.saveBtn.click();
            }
          });
          (textInput as HTMLInputElement).focus();
        }
        onClose() {
          moduleRef.reminderSettingsModalOpen = false;
          doResolve(null);
        }
      }
      new ReminderModal(app).open();
    });
  }
}
