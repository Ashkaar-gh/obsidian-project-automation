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
import { updateDataFile } from "../core/GamificationState";

const DEFAULT_REMINDER_REWARDS = { xp: 2, gold: 1 };

import { App, TFile, Notice, Modal } from "obsidian";
import {
  REMINDER_DATE_TAG_REGEX,
  formatReminderDateTag,
  replaceReminderDateTag,
  fromNow,
  parseCompletedTaskWithRecurrence,
  parseRecurrenceFromText,
  buildNextRecurrenceLine,
  completedLineWithoutRecurrence,
  isRecurrenceCompletionOnTime,
  type ReminderItem,
  type ReminderData,
} from "../core/ReminderDataUtils";
import { UI_LABELS } from "../ui/Labels";
import { createCollapsibleSection, createToggleSection } from "../ui/CollapsibleSection";
import { BlockRegistry } from "../ui/BlockRegistry";

const STORAGE_KEY_PREFIX = "opa-reminders-collapsed-";
const FALLBACK_CHECK_MS = 60 * 1000;
/** Резервная проверка смены календарного дня (если таймер на полночь пропущен). */
const DAY_CHECK_INTERVAL_MS = 60 * 1000;

function getCalendarDayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function msUntilNextLocalMidnight(from = new Date()): number {
  const next = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1, 0, 0, 0, 0);
  return Math.max(1000, next.getTime() - from.getTime());
}

export type { ReminderItem };

const SECTION_CONFIG: { key: Exclude<keyof ReminderData, "completed">; icon: string }[] = [
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
  private registry: BlockRegistry;
  private nextCheckTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /** true пока открыто окно выбора даты переноса — не показывать новое уведомление */
  private pickerModalOpen = false;
  /** восстановить фокус в поле ввода после добавления напоминания */
  private shouldRestoreFocus = false;
  /** true пока открыто окно уведомления о напоминании — не открывать второе поверх */
  notificationModalOpen = false;
  /** true пока открыто окно настройки/создания напоминания — не показывать уведомление о срабатывании */
  reminderSettingsModalOpen = false;
  /** Идёт inline-правка строки — не перерисовывать список (иначе выкидывает из окна). */
  private inlineEditActive = false;
  /** Нужен рефреш после завершения правки. */
  private pendingRefresh = false;
  /** Поколение рендера: отбрасываем устаревшие async-перерисовки, иначе старые даты затирают новые. */
  private renderEpoch = 0;
  /** Последний известный календарный день — для пересчёта «сегодня/завтра/просрочено». */
  private lastCalendarDayKey = getCalendarDayKey();
  private midnightTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.registry = new BlockRegistry({
      app: ctx.app,
      isEnabled: () => ctx.plugin.settings.enableReminders,
      debounceMs: 250,
      shouldRefresh: () => !this.inlineEditActive,
      domSelector: ".opa-reminders-view",
      createRefresh: (el) => () => this.render(el),
    });
  }

  private isExcludedPath(path: string): boolean {
    const prefix = Paths.TEMPLATES_FOLDER.replace(/\/?$/, "") + "/";
    return path.startsWith(prefix) || path === Paths.TRASH_FILE;
  }

  /** Debounce на каждый файл отдельно: быстрые правки в нескольких файлах не теряются. */
  private recurDebounceByPath = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly RECUR_DEBOUNCE_MS = 2500;

  /** Обработать файл: для выполненных повторяющихся напоминаний создать следующее вхождение (если отмечено в самой заметке, не в блоке). */
  private async processFileRecurringCompletions(filePath: string): Promise<void> {
    if (!this.ctx.plugin.settings.enableReminders) return;
    if (this.isExcludedPath(filePath)) return;
    if (this.suppressRecurForPath.has(filePath)) return;
    const file = this.ctx.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile)) return;
    const content = await this.ctx.app.vault.read(file);
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

      const newLine = buildNextRecurrenceLine(parsed);
      const textClean = (parsed.textPrefix + parsed.textSuffix).replace(REMINDER_DATE_TAG_REGEX, "").trim();

      // Не создаём дубль, если следующее вхождение уже есть на строке ниже
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

  /** Пути, которые мы сами пишем — не запускать recur-обработку по своему modify. */
  private suppressRecurForPath = new Set<string>();

  private withSuppressedRecur<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    this.suppressRecurForPath.add(filePath);
    return fn().finally(() => {
      // Дать vault.modify дойти до слушателей, потом снять подавление
      window.setTimeout(() => this.suppressRecurForPath.delete(filePath), 500);
    });
  }

  private onVaultModifyForRecur = (file: TFile): void => {
    if (!file.path.endsWith(".md")) return;
    if (this.suppressRecurForPath.has(file.path)) return;
    const existing = this.recurDebounceByPath.get(file.path);
    if (existing) clearTimeout(existing);
    this.recurDebounceByPath.set(
      file.path,
      setTimeout(() => {
        this.recurDebounceByPath.delete(file.path);
        this.processFileRecurringCompletions(file.path).then(() => this.scheduleRefresh());
      }, this.RECUR_DEBOUNCE_MS)
    );
  };

  load(): void {
    this.ctx.remindersIndex.ensureSubscribed(() => this.scheduleRefresh());
    this.ctx.plugin.registerEvent(this.ctx.app.workspace.on("active-leaf-change", this.registry.scheduleRefresh));
    const vault = this.ctx.app.vault as unknown as {
      on(e: "modify", cb: (f: TFile) => void): import("obsidian").EventRef;
    };
    this.ctx.plugin.registerEvent(vault.on("modify", this.onVaultModifyForRecur));

    this.lastCalendarDayKey = getCalendarDayKey();
    this.ctx.plugin.registerInterval(window.setInterval(() => this.checkCalendarDayChange(), DAY_CHECK_INTERVAL_MS));
    this.scheduleMidnightDayCheck();
    this.ctx.plugin.registerDomEvent(window, "focus", () => this.checkCalendarDayChange());

    this.ctx.plugin.registerMarkdownCodeBlockProcessor("opa-reminders-view", (_source, el) => {
      el.addClass("opa-reminders-view");
      this.registry.register(el, () => this.render(el));
    });
  }

  /**
   * Смена календарного дня: пересчитать секции (today/tomorrow/overdue) и перепланировать уведомления.
   * Без этого список «застывает» на вчерашних статусах, пока не изменится файл или вкладка.
   */
  private checkCalendarDayChange(): void {
    if (!this.ctx.plugin.settings.enableReminders) return;
    const today = getCalendarDayKey();
    if (today === this.lastCalendarDayKey) return;
    this.lastCalendarDayKey = today;
    void this.forceRefreshAsync();
    void this.startChecker();
  }

  private scheduleMidnightDayCheck(): void {
    this.stopMidnightDayCheck();
    if (!this.ctx.plugin.settings.enableReminders) return;
    this.midnightTimeoutId = setTimeout(() => {
      this.midnightTimeoutId = null;
      this.checkCalendarDayChange();
      this.scheduleMidnightDayCheck();
    }, msUntilNextLocalMidnight());
  }

  private stopMidnightDayCheck(): void {
    if (this.midnightTimeoutId) {
      clearTimeout(this.midnightTimeoutId);
      this.midnightTimeoutId = null;
    }
  }

  private scheduleRefresh = (): void => {
    if (this.inlineEditActive) {
      this.pendingRefresh = true;
      return;
    }
    // Не трогаем renderEpoch здесь: иначе debounce после modify убивает in-flight forceRefresh
    this.registry.scheduleRefresh();
  };

  /** Принудительное обновление блоков без задержки (сразу после добавления/изменения). */
  private forceRefresh(): void {
    void this.forceRefreshAsync();
  }

  /**
   * Обновить UI после мутации. Пока открыто уведомление/пикер — только помечаем:
   * рефреш в этот момент часто не попадает в DOM homepage (блок отсоединён / затирается).
   */
  private async refreshUiAfterMutation(): Promise<void> {
    // Индекс уже актуальный — обновляем сразу; после закрытия modal — ещё раз (flushRefreshAfterModalClose)
    await this.forceRefreshAsync();
    if (this.notificationModalOpen || this.pickerModalOpen || this.reminderSettingsModalOpen) {
      this.pendingRefresh = true;
    }
  }

  /**
   * Контрольная сверка: через пару секунд перечитать файл с диска и перерисовать.
   * Лечит любой поздний перезапис индекса устаревшим кэшем, чем бы он ни был вызван.
   */
  private verifyIndexSoon(file: TFile): void {
    window.setTimeout(() => {
      void this.ctx.remindersIndex.updateFile(file).then(() => this.forceRefreshAsync());
    }, 2300);
  }

  /** То же, что forceRefresh, но с ожиданием отрисовки (после мутаций даты). */
  private async forceRefreshAsync(): Promise<void> {
    if (this.inlineEditActive) {
      this.pendingRefresh = true;
      return;
    }
    this.pendingRefresh = false;
    this.renderEpoch++;
    await this.registry.forceRefreshAsync();
  }

  /**
   * После закрытия notification/picker: дождаться стабилизации DOM и перерисовать homepage.
   * Вызывать, когда флаги modal уже сброшены.
   */
  flushRefreshAfterModalClose(): void {
    this.pendingRefresh = false;
    const run = () => {
      if (this.inlineEditActive) {
        this.pendingRefresh = true;
        return;
      }
      if (this.notificationModalOpen || this.pickerModalOpen) return;
      void this.forceRefreshAsync();
    };
    // Два прохода: сразу после закрытия и ещё раз, если Obsidian пересобрал preview
    window.setTimeout(run, 50);
    window.setTimeout(run, 350);
  }

  /** Завершение inline-правки: снять флаг и при необходимости обновить список. */
  private endInlineEdit(): void {
    this.inlineEditActive = false;
    if (this.pendingRefresh) {
      this.pendingRefresh = false;
      void this.forceRefreshAsync();
    }
  }

  updateState(): void {
    if (this.ctx.plugin.settings.enableReminders) {
      this.lastCalendarDayKey = getCalendarDayKey();
      this.scheduleMidnightDayCheck();
      this.startChecker();
    } else {
      this.stopMidnightDayCheck();
      this.stopChecker();
    }
    this.registry.runRefresh();
  }

  unload(): void {
    this.stopChecker();
    this.stopMidnightDayCheck();
    for (const t of this.recurDebounceByPath.values()) clearTimeout(t);
    this.recurDebounceByPath.clear();
    this.registry.clear();
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
    let ms = this.ctx.remindersIndex.getNextTriggerMs();
    // Пока открыто наше уведомление — не крутить проверку каждую секунду (следующее откроет onClose)
    if (ms != null && ms <= 1000 && this.isReminderUiBlocking()) {
      ms = FALLBACK_CHECK_MS;
    }
    this.nextCheckTimeoutId = setTimeout(
      () => {
        this.nextCheckTimeoutId = null;
        this.startChecker();
      },
      ms != null ? Math.max(1000, ms) : FALLBACK_CHECK_MS
    );
  }

  /** Блокируем новое уведомление, пока открыто наше окно напоминания. */
  private isReminderUiBlocking(): boolean {
    return this.pickerModalOpen || this.notificationModalOpen || this.reminderSettingsModalOpen;
  }

  /** Дождаться снятия нашего modal из DOM (закрытие Obsidian асинхронное). */
  private async waitForReminderModalsGone(maxMs = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const ours = document.querySelector(
        ".opa-reminder-notification-modal, .opa-reminder-picker-modal, .opa-reminder-settings-modal"
      );
      if (!ours && !this.isReminderUiBlocking()) return;
      if (!ours) {
        // DOM уже чист — сбрасываем залипшие флаги
        this.notificationModalOpen = false;
        this.pickerModalOpen = false;
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!document.querySelector(".opa-reminder-notification-modal")) this.notificationModalOpen = false;
    if (!document.querySelector(".opa-reminder-picker-modal")) this.pickerModalOpen = false;
  }

  /**
   * После закрытия уведомления/пикера — сразу проверить следующее due/просроченное.
   * Ждём исчезновения modal из DOM: иначе проверка натыкается на ещё открытый .modal и выходит.
   */
  scheduleCheckAfterNotification(): void {
    if (!this.ctx.plugin.settings.enableReminders) return;
    this.stopChecker();
    this.nextCheckTimeoutId = setTimeout(() => {
      this.nextCheckTimeoutId = null;
      void (async () => {
        await this.waitForReminderModalsGone();
        await this.startChecker();
      })();
    }, 100);
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
    // Только наши окна — не любой .modal.modal-open (часто ещё висит при закрытии / у других плагинов)
    if (this.isReminderUiBlocking()) return;
    if (document.querySelector(".opa-reminder-notification-modal, .opa-reminder-picker-modal")) return;
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
        this.contentEl.createEl("div", { cls: "opa-reminder-notif-title", text: "🔔 Напоминание" });
        this.contentEl.createEl("div", { cls: "opa-reminder-notif-text", text: item.text });
        const timeStr = item.displayTime
          ? `${item.displayDate} в ${item.displayTime}`
          : item.displayDate;
        this.contentEl.createEl("div", { cls: "opa-reminder-notif-due", text: `Срок: ${timeStr}` });
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
          const ok = await this.remindersRef.snoozeReminder(item, 60);
          if (ok) new Notice(snooze.oneHour);
        });
        addBtn(snooze.tomorrowBtn, async () => {
          const ok = await this.remindersRef.snoozeReminder(item, 1440);
          if (ok) new Notice(snooze.tomorrow);
        });
        addBtn(snooze.pickDateBtn, async () => {
          const ref = this.remindersRef;
          const remItem = item;
          // Сначала флаг пикера, потом close — иначе onClose уведомления сразу откроет следующее
          ref.pickerModalOpen = true;
          this.close();
          class PickerModal extends Modal {
            onOpen() {
              this.modalEl.addClass("opa-reminder-picker-modal");
              this.contentEl.empty();
              this.titleEl.setText(snooze.pickerTitle);
              const tomorrow = new Date();
              tomorrow.setDate(tomorrow.getDate() + 1);
              const defaultVal = `${tomorrow.getFullYear()}-${(tomorrow.getMonth() + 1).toString().padStart(2, "0")}-${tomorrow.getDate().toString().padStart(2, "0")}T10:00`;
              const dateInput = this.contentEl.createEl("input", { type: "datetime-local", cls: "view-input opa-reminder-picker-input" });
              dateInput.value = defaultVal;
              const actionsWrap = this.contentEl.createEl("div", { cls: "opa-reminder-picker-actions" });
              const saveBtn = actionsWrap.createEl("button", { text: common.save, cls: "mod-cta mod-cta-primary opa-reminder-picker-save" });
              const doSave = () => {
                const val = dateInput.value;
                if (val) {
                  this.close();
                  void ref.setReminderDate(remItem, val).then((ok) => {
                    if (ok) {
                      new Notice(snooze.rescheduled(new Date(val).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })));
                    }
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
              ref.flushRefreshAfterModalClose();
              ref.scheduleCheckAfterNotification();
            }
          }
          new PickerModal(app).open();
        });
      }
      onClose() {
        this.remindersRef.notificationModalOpen = false;
        // Следующее просроченное/due — сразу после действия с текущим
        if (!this.remindersRef.pickerModalOpen) {
          this.remindersRef.flushRefreshAfterModalClose();
          this.remindersRef.scheduleCheckAfterNotification();
        }
      }
      constructor(app: App, private remindersRef: RemindersModule) {
        super(app);
      }
    }
    new NotificationModal(app, this).open();
  }

  private snoozeReminder(item: ReminderItem, minutes: number): Promise<boolean> {
    return this.rescheduleReminder(item, new Date(Date.now() + minutes * 60 * 1000));
  }

  private setReminderDate(item: ReminderItem, dateIso: string): Promise<boolean> {
    return this.rescheduleReminder(item, new Date(dateIso));
  }

  /** Найти строку напоминания в файле (точный матч, затем includes). */
  private findReminderLineIndex(lines: string[], lineText: string): number {
    let idx = findLineIndexByText(lines, lineText, { exact: true });
    if (idx !== -1) return idx;
    idx = findLineIndexByText(lines, lineText);
    if (idx !== -1) return idx;
    // Fallback: unchecked-строка с тем же тегом даты
    const tag = lineText.match(REMINDER_DATE_TAG_REGEX)?.[0];
    if (!tag) return -1;
    const bare = lineText
      .replace(/^\s*[-*]\s+\[[ xX]\]\s*/i, "")
      .replace(REMINDER_DATE_TAG_REGEX, "")
      .trim();
    return lines.findIndex((line) => {
      const t = line.trim();
      if (!t.startsWith("- [ ]") && !t.startsWith("* [ ]")) return false;
      if (!t.includes(tag)) return false;
      const otherBare = t
        .replace(/^\s*[-*]\s+\[[ xX]\]\s*/i, "")
        .replace(REMINDER_DATE_TAG_REGEX, "")
        .trim();
      return otherBare === bare;
    });
  }

  /** Перенести напоминание на новую дату (в data.json или в заметке). */
  private async rescheduleReminder(item: ReminderItem, newDate: Date): Promise<boolean> {
    const newTag = formatReminderDateTag(newDate);
    if (item.filePath === this.getDataPath()) {
      let updated = false;
      await updateDataFile(this.ctx.plugin, (d) => {
        const reminders = d.reminders ?? [];
        const idx = reminders.findIndex((l) => l.trim() === item.lineText);
        if (idx === -1) return;
        const next = [...reminders];
        const replaced = replaceReminderDateTag(next[idx], newTag);
        if (replaced === next[idx]) return;
        next[idx] = replaced;
        d.reminders = next;
        updated = true;
      });
      if (!updated) {
        new Notice(UI_LABELS.reminders.notices.completeNotFound);
        return false;
      }
      this.ctx.remindersIndex.suppressVaultModify(this.getDataPath());
      await this.ctx.remindersIndex.refreshDataJson();
      await this.refreshUiAfterMutation();
      return true;
    }

    const file = this.ctx.app.vault.getAbstractFileByPath(item.filePath);
    if (!file || !(file instanceof TFile)) {
      new Notice(`Файл не найден: ${item.filePath}`);
      return false;
    }

    const ok = await this.withSuppressedRecur(file.path, async () => {
      const content = await this.ctx.app.vault.read(file);
      const lines = content.split("\n");
      const lineIdx = this.findReminderLineIndex(lines, item.lineText);
      if (lineIdx === -1) return false;
      const oldLine = lines[lineIdx];
      const newLine = replaceReminderDateTag(oldLine, newTag);
      if (newLine === oldLine) return false;
      lines[lineIdx] = newLine;
      const written = lines.join("\n");
      // Глушим modify→updateFile: иначе кэш сразу после modify отдаёт старые даты и затирает индекс
      this.ctx.remindersIndex.suppressVaultModify(file.path);
      await this.ctx.app.vault.modify(file, written);
      await this.ctx.remindersIndex.updateFile(file, written);
      return true;
    });

    if (!ok) {
      new Notice(UI_LABELS.reminders.notices.completeNotFound);
      return false;
    }
    await this.refreshUiAfterMutation();
    this.verifyIndexSoon(file);
    return true;
  }

  private async render(container: HTMLElement): Promise<void> {
    const epoch = this.renderEpoch;

    if (!this.ctx.plugin.settings.enableReminders) {
      if (epoch !== this.renderEpoch) return;
      container.empty();
      container.addClass("opa-hidden");
      return;
    }
    container.removeClass("opa-hidden");

    const L = UI_LABELS.reminders;
    const sec = L.sections;
    const common = UI_LABELS.common;

    try {
      await this.ctx.remindersIndex.waitReady();
      if (epoch !== this.renderEpoch) return;

      // Пока пользователь правит строку — не трогаем DOM (иначе выкидывает из инпута).
      if (this.inlineEditActive) {
        this.pendingRefresh = true;
        return;
      }

      // Данные после await — иначе гонка с более новым render затрёт актуальные даты.
      const data = this.getReminderData();
      if (epoch !== this.renderEpoch) return;

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
          await updateDataFile(this.ctx.plugin, (d) => {
            d.reminders = [...(d.reminders ?? []), line];
          });
          await this.ctx.remindersIndex.refreshDataJson();
          await this.forceRefreshAsync();
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
        const section = listWrapper.createEl("div", { cls: `rv-section rv-${key}` });

        const { list } = createToggleSection(section, {
          icon,
          title: title ?? key,
          count: items.length,
          collapsed: getGroupState(title),
          onToggle: (collapsed) => setGroupState(title, collapsed),
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
          if (item.filePath !== this.getDataPath()) {
            const fileName = item.filePath.split("/").pop()?.replace(/\.md$/i, "") ?? "Reminders";
            const fileLink = content.createEl("a", { cls: "rv-file-link", text: fileName });
            fileLink.addEventListener("click", (e) => {
              e.preventDefault();
              this.ctx.app.workspace.openLinkText(item.filePath, "", false);
            });
          }

          const timeDiv = row.createEl("div", { cls: "rv-time" });
          const timeText = item.displayTime ? `${item.displayDate} ${item.displayTime}` : item.displayDate;
          timeDiv.createEl("span", { cls: "rv-badge rv-badge-date", text: timeText });
          timeDiv.createEl("span", { cls: "rv-rel-time", text: fromNow(item.date) });

          const actions = row.createEl("div", { cls: "rv-actions" });
          const editBtn = actions.createEl("button", { text: L.edit, cls: "inbox-action-btn" });
          editBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.startInlineEdit(row, item);
          });
          const deleteBtn = actions.createEl("button", { text: L.delete, cls: "inbox-action-btn" });
          deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.deleteReminder(item);
          });

          row.appendChild(timeDiv);
          row.appendChild(actions);
        }
      }
      }

      if (data.completed.length > 0) {
        const archiveTitle = sec.archive ?? "Архив";
        const archiveSection = body.createEl("div", { cls: "rv-section rv-completed" });
        const { list: archiveList } = createToggleSection(archiveSection, {
          icon: "📦",
          title: archiveTitle,
          count: data.completed.length,
          collapsed: getGroupState(archiveTitle),
          onToggle: (collapsed) => setGroupState(archiveTitle, collapsed),
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
          if (item.filePath !== this.getDataPath()) {
            const fileName = item.filePath.split("/").pop()?.replace(/\.md$/i, "") ?? "Reminders";
            const fileLink = content.createEl("a", { cls: "rv-file-link", text: fileName });
            fileLink.addEventListener("click", (e) => {
              e.preventDefault();
              this.ctx.app.workspace.openLinkText(item.filePath, "", false);
            });
          }
          const timeDiv = row.createEl("div", { cls: "rv-time" });
          const timeText = item.displayTime ? `${item.displayDate} ${item.displayTime}` : item.displayDate;
          timeDiv.createEl("span", { cls: "rv-badge rv-badge-date", text: timeText });
          const actions = row.createEl("div", { cls: "rv-actions" });
          const deleteBtn = actions.createEl("button", { text: L.delete, cls: "inbox-action-btn" });
          deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.deleteReminder(item);
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
          const { list: subList } = createToggleSection(groupDiv, {
            title: groupName,
            count: items.length,
            collapsed: getArchiveGroupState(groupName),
            onToggle: (collapsed) => setArchiveGroupState(groupName, collapsed),
            headerCls: "rv-archive-group-header",
            listCls: "rv-archive-sublist",
            headerTag: "div",
          });
          for (const item of items) {
            appendArchiveRow(item, subList);
          }
        }
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

  private startInlineEdit(rowEl: HTMLElement, item: ReminderItem): void {
    const contentEl = rowEl.querySelector(".rv-content");
    if (!contentEl) return;
    // Уже идёт правка другой строки — не открываем вторую поверх
    if (this.inlineEditActive) return;

    this.inlineEditActive = true;
    rowEl.addClass("is-editing");

    const taskPrefix = item.lineText.match(/^\s*[-*]\s+\[.\]\s*/i)?.[0] ?? "- [ ] ";
    const displayValue = item.lineText.replace(/^\s*[-*]\s+\[.\]\s*/i, "").trim();
    const editInput = contentEl.createEl("input", { type: "text", cls: "view-input rv-edit-input" });
    editInput.value = displayValue;
    contentEl.insertBefore(editInput, contentEl.children[1]);
    editInput.focus();

    let closed = false;
    const cancel = () => {
      if (closed) return;
      closed = true;
      editInput.remove();
      rowEl.removeClass("is-editing");
      this.endInlineEdit();
    };

    const save = async () => {
      if (closed) return;
      const newValue = editInput.value.trim();
      const fullLine = taskPrefix + newValue;
      let needRefresh = false;
      if (newValue && fullLine !== item.lineText) {
        const ok = await this.editReminder(item, fullLine);
        needRefresh = ok;
      }
      // Сначала закрываем правку, потом рефреш — иначе рендер сотрёт соседний инпут
      closed = true;
      editInput.remove();
      rowEl.removeClass("is-editing");
      this.inlineEditActive = false;
      if (needRefresh || this.pendingRefresh) {
        this.pendingRefresh = false;
        await this.forceRefreshAsync();
      }
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
      if (editInput.parentElement) void save();
    });
  }

  /**
   * Отметить строку выполненной; для повторяющихся — вставить следующее вхождение сразу под ней.
   * Возвращает найденную повторяемость (если была) или null; lines мутируется.
   */
  private completeLineInPlace(
    lines: string[],
    lineIdx: number
  ): { amount: number; unit: string } | null {
    const completedLine = toggleTaskCheckbox(lines[lineIdx], true);
    lines[lineIdx] = completedLine;
    const parsed = parseCompletedTaskWithRecurrence(completedLine);
    if (!parsed) return null;
    lines[lineIdx] = completedLineWithoutRecurrence(completedLine, parsed.recurrenceFull);
    lines.splice(lineIdx + 1, 0, buildNextRecurrenceLine(parsed));
    return { amount: parsed.amount, unit: parsed.unit };
  }

  private async completeReminder(item: ReminderItem): Promise<void> {
    let completed = false;
    let recurrence: { amount: number; unit: string } | null = null;

    if (item.filePath === this.getDataPath()) {
      await updateDataFile(this.ctx.plugin, (d) => {
        const reminders = [...(d.reminders ?? [])];
        const idx = reminders.findIndex((l) => l.trim() === item.lineText);
        if (idx === -1) return;
        completed = true;
        recurrence = this.completeLineInPlace(reminders, idx);
        d.reminders = reminders;
      });
      if (completed) await this.ctx.remindersIndex.refreshDataJson();
    } else {
      const file = this.ctx.app.vault.getAbstractFileByPath(item.filePath);
      if (!file || !(file instanceof TFile)) return;
      let written: string | null = null;
      this.ctx.remindersIndex.suppressVaultModify(file.path);
      await this.withSuppressedRecur(file.path, async () => {
        await processFile(this.ctx.app, file, (content) => {
          const lines = content.split("\n");
          const lineIdx = findLineIndexByText(lines, item.lineText);
          if (lineIdx === -1) return content;
          completed = true;
          recurrence = this.completeLineInPlace(lines, lineIdx);
          written = lines.join("\n");
          return written;
        });
      });
      if (completed) {
        if (written != null) await this.ctx.remindersIndex.updateFile(file, written);
        else await this.ctx.remindersIndex.updateFile(file);
        this.verifyIndexSoon(file);
      }
    }

    if (!completed) {
      new Notice(UI_LABELS.reminders.notices.completeNotFound);
      return;
    }
    if (recurrence) {
      const { amount, unit } = recurrence;
      new Notice(UI_LABELS.reminders.notices.nextCreated(amount, unit));
    }

    if (this.ctx.plugin.settings.enableGamification) {
      const state = await this.ctx.plugin.getGamificationState();
      const r = this.ctx.plugin.settings.gamificationReminderRewards ?? DEFAULT_REMINDER_REWARDS;
      state.xp += r.xp;
      state.gold += r.gold;
      if (item.isRecurring) {
        const streakKey = item.text.trim() || "reminder";
        const rec = recurrence ?? parseRecurrenceFromText(item.lineText);
        const graceMs = (this.ctx.plugin.settings.gamificationStreakGraceDays ?? 0) * 24 * 60 * 60 * 1000;
        const onTime =
          rec != null &&
          isRecurrenceCompletionOnTime(item.date, new Date(), rec.amount, rec.unit, graceMs);
        state.streaks[streakKey] = onTime ? (state.streaks[streakKey] ?? 0) + 1 : 1;
      }
      this.ctx.plugin.scheduleGamificationSave();
      this.ctx.plugin.gamification?.updateState?.();
      new Notice(`${UI_LABELS.reminders.notices.completed} ${UI_LABELS.gamification.rewardLine(r.xp, r.gold)}`);
    } else {
      new Notice(UI_LABELS.reminders.notices.completed);
    }
    await this.refreshUiAfterMutation();
  }

  private async editReminder(item: ReminderItem, newLineText: string): Promise<boolean> {
    if (item.filePath === this.getDataPath()) {
      let updated = false;
      await updateDataFile(this.ctx.plugin, (d) => {
        const reminders = d.reminders ?? [];
        const idx = reminders.findIndex((l) => l.trim() === item.lineText);
        if (idx === -1) return;
        updated = true;
        const next = [...reminders];
        next[idx] = newLineText.trim();
        d.reminders = next;
      });
      if (!updated) return false;
      await this.ctx.remindersIndex.refreshDataJson();
      new Notice(UI_LABELS.reminders.notices.updated);
      return true;
    }
    const file = this.ctx.app.vault.getAbstractFileByPath(item.filePath);
    if (!file || !(file instanceof TFile)) return false;
    const content = await this.ctx.app.vault.read(file);
    if (!content) return false;
    const newContent = replaceLineByText(content, item.lineText, newLineText.trim());
    if (newContent === content) return false;
    this.ctx.remindersIndex.suppressVaultModify(file.path);
    await this.withSuppressedRecur(file.path, async () => {
      await this.ctx.app.vault.modify(file, newContent);
    });
    await this.ctx.remindersIndex.updateFile(file, newContent);
    new Notice(UI_LABELS.reminders.notices.updated);
    return true;
  }

  private async deleteReminder(item: ReminderItem): Promise<void> {
    if (item.filePath === this.getDataPath()) {
      let removed = false;
      await updateDataFile(this.ctx.plugin, (d) => {
        const reminders = d.reminders ?? [];
        const idx = reminders.findIndex((l) => l.trim() === item.lineText);
        if (idx === -1) return;
        removed = true;
        d.trash = [...(d.trash ?? []), reminders[idx]];
        d.reminders = reminders.filter((_, i) => i !== idx);
      });
      if (!removed) {
        new Notice(UI_LABELS.reminders.notices.deleteNotFound);
        return;
      }
      await this.ctx.remindersIndex.refreshDataJson();
    } else {
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
      // Сначала кладём строку в корзину, потом удаляем из заметки — при сбое ничего не теряется
      if (removedLine) {
        await updateDataFile(this.ctx.plugin, (d) => {
          d.trash = [...(d.trash ?? []), removedLine];
        });
      }
      await modify(this.ctx.app, item.filePath, newContent);
      await this.ctx.remindersIndex.updateFile(file, newContent);
    }
    new Notice(UI_LABELS.reminders.notices.movedToTrash);
    this.ctx.plugin.triggerTrashRefresh?.();
    await this.forceRefreshAsync();
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
          const textInput = this.contentEl.createEl("input", { type: "text", cls: "view-input opa-reminder-modal-input" });
          textInput.value = defaultText;
          this.contentEl.createEl("div", { text: mod.dateLabel, cls: "setting-item-description" });
          const dateInput = this.contentEl.createEl("input", { type: "datetime-local", cls: "view-input opa-reminder-modal-input" });
          const defaultDate = new Date();
          defaultDate.setTime(defaultDate.getTime() + 60 * 60 * 1000);
          dateInput.value = `${defaultDate.getFullYear()}-${(defaultDate.getMonth() + 1).toString().padStart(2, "0")}-${defaultDate.getDate().toString().padStart(2, "0")}T${defaultDate.getHours().toString().padStart(2, "0")}:${defaultDate.getMinutes().toString().padStart(2, "0")}`;
          this.contentEl.createEl("div", { text: mod.recurrenceLabel, cls: "setting-item-description" });
          const recurWrap = this.contentEl.createEl("div", { cls: "reminder-modal-recur" });
          const recurAmount = recurWrap.createEl("input", { type: "number", cls: "view-input reminder-modal-recur-amount" });
          recurAmount.value = "1";
          recurAmount.min = "1";
          const recurUnit = recurWrap.createEl("select", { cls: "view-input reminder-modal-recur-unit" });
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
