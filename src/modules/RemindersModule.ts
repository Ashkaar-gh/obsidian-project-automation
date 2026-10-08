import { TFile, Notice, Modal, type App, type EventRef } from "obsidian";
import type { ModuleContext, PluginModule } from "./types";
import { findUniqueLineIndexByText, toggleTaskCheckbox } from "../core/FileIO";
import { emptyGamificationState, updateDataFile } from "../core/GamificationState";
import { formatDateDDMMYYYY, formatDateKey } from "../core/DateUtils";
import { inboxEntryAsOneLine } from "../core/InboxEntries";
import {
  applyReminderEdit,
  buildReminderLine,
  formatReminderDateTag,
  formatReminderTime,
  replaceReminderDateTag,
  fromNow,
  insertNextRecurrenceLines,
  parseCompletedTaskWithRecurrence,
  parseReminderDueFromText,
  parseRecurrenceFromText,
  buildNextRecurrenceLine,
  completedLineWithoutRecurrence,
  isRecurrenceCompletionOnTime,
  reminderEditChanges,
  reminderEditFields,
  type ReminderEditChanges,
  type ReminderItem,
  type ReminderData,
  type ReminderRecurrence,
} from "../core/ReminderDataUtils";
import {
  applyReminderRewardIntent,
  createReminderRewardIntent,
  rewardIntentsFromText,
  rewardMarker,
  stripRewardMarkers,
  type ReminderRewardIntent,
} from "../core/ReminderRewards";
import { UI_LABELS } from "../ui/Labels";
import { createCollapsibleSection, createToggleSection } from "../ui/CollapsibleSection";
import { BlockRegistry } from "../ui/BlockRegistry";
import { isRenderUnchanged, markRendered, renderSignature } from "../ui/RenderCache";
import { getSelectedText } from "../ui/SelectedText";

const STORAGE_KEY_PREFIX = "opa-reminders-collapsed-";
const FALLBACK_CHECK_MS = 60 * 1000;
/** Резервная проверка смены календарного дня (если таймер на полночь пропущен). */
const DAY_CHECK_INTERVAL_MS = 60 * 1000;
/** Пауза после правки файла пользователем перед обработкой выполненных повторяющихся напоминаний. */
const FILE_CHANGE_DEBOUNCE_MS = 2500;
/** Сколько хранить id начисленных наград (защита от повторного начисления при восстановлении по маркерам). */
const MAX_REWARD_IDS = 500;
/**
 * Если действие из окна уведомления не удалось (строка в файле уже изменилась), то же напоминание
 * не показывается снова в течение этого времени - иначе окно открывалось бы заново каждую секунду.
 */
const MUTE_AFTER_FAILURE_MS = 60 * 1000;
/**
 * Самая долгая пауза до следующей проверки. setTimeout хранит задержку 32-битным числом: при задержке больше
 * ~24,8 суток он срабатывает раньше срока, обычно сразу, и проверка крутилась бы без пауз, пока ближайшее
 * напоминание так далеко (например, ежемесячное сразу после выполнения). Через час таймер заводится заново.
 */
const MAX_CHECK_DELAY_MS = 60 * 60 * 1000;

function msUntilNextLocalMidnight(from = new Date()): number {
  const next = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1, 0, 0, 0, 0);
  return Math.max(1000, next.getTime() - from.getTime());
}

export type { ReminderItem };

/** Окно напоминания при правке: заголовок, текущие срок и повторение (без них - окно нового напоминания). */
export interface ReminderModalOptions {
  title?: string;
  date?: Date;
  recurrence?: ReminderRecurrence | null;
}

/** Значение поля datetime-local: локальные дата и время с точностью до минуты. */
function toDateTimeLocalValue(date: Date): string {
  return `${formatDateKey(date)}T${formatReminderTime(date)}`;
}

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

export class RemindersModule implements PluginModule {
  private ctx: ModuleContext;
  private registry: BlockRegistry;
  private nextCheckTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /** true пока открыто окно выбора даты переноса - не показывать новое уведомление */
  private pickerModalOpen = false;
  /** восстановить фокус в поле ввода после добавления напоминания */
  private shouldRestoreFocus = false;
  /** true пока открыто окно уведомления о напоминании - не открывать второе поверх */
  notificationModalOpen = false;
  /** true пока открыто окно напоминания (новое или «Изменить») - не показывать уведомление о срабатывании */
  reminderSettingsModalOpen = false;
  /** Поколение рендера: отбрасываем устаревшие async-перерисовки, иначе старые даты затирают новые. */
  private renderEpoch = 0;
  /** Последний известный календарный день - для пересчёта «сегодня/завтра/просрочено». */
  private lastCalendarDayKey = formatDateKey(new Date());
  private midnightTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Debounce на каждый файл отдельно: быстрые правки в нескольких файлах не теряются. */
  private fileChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Пути, которые мы сами пишем - своё событие modify не считается правкой пользователя. */
  private suppressRecurForPath = new Set<string>();
  /** Напоминания, по которым действие из уведомления не удалось: ключ → до какого момента не показывать. */
  private mutedUntil = new Map<string, number>();
  /** Модуль выгружен: начатые до этого проверки не должны заводить таймеры и открывать окна. */
  private disposed = false;

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.registry = new BlockRegistry({
      app: ctx.app,
      isEnabled: () => ctx.plugin.settings.enableReminders,
      debounceMs: 250,
      domSelector: ".opa-reminders-view",
      createRefresh: (el) => (force) => this.render(el, force),
    });
  }

  private withSuppressedRecur<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    this.suppressRecurForPath.add(filePath);
    return fn().finally(() => {
      // Дать vault.modify дойти до слушателей, потом снять подавление
      window.setTimeout(() => this.suppressRecurForPath.delete(filePath), 500);
    });
  }

  /**
   * Своя запись в заметку: индекс напоминаний обновляется из записанного текста сразу (а не по событию
   * modify, которое может принести устаревший кэш), обработка «правки пользователя» для этого файла
   * подавляется. Возвращает записанный текст или null, если transform ничего не изменил.
   */
  private async writeOwnChange(file: TFile, transform: (content: string) => string): Promise<string | null> {
    let written: string | null = null;
    await this.withSuppressedRecur(file.path, () =>
      this.ctx.app.vault.process(file, (current) => {
        const next = transform(current);
        if (next === current) return current;
        // Запись будет: событие modify по ней индекс должен пропустить (данные придут из updateFile ниже)
        this.ctx.remindersIndex.suppressVaultModify(file.path);
        written = next;
        return next;
      })
    );
    if (written != null) await this.ctx.remindersIndex.updateFile(file, written);
    return written;
  }

  private onVaultModify = (file: TFile): void => {
    // Путь фиксируем сейчас: TFile.path меняется при переименовании, а ключ таймера должен остаться тем же
    const path = file.path;
    if (!path.endsWith(".md")) return;
    if (this.suppressRecurForPath.has(path)) return;
    const existing = this.fileChangeTimers.get(path);
    if (existing) clearTimeout(existing);
    this.fileChangeTimers.set(
      path,
      setTimeout(() => {
        this.fileChangeTimers.delete(path);
        void this.handleFileChanged(file).catch((error) =>
          console.error(`[Reminders] processing of ${file.path} failed:`, error)
        );
      }, FILE_CHANGE_DEBOUNCE_MS)
    );
  };

  /**
   * Правка заметки пользователем (после паузы). Файл читается один раз: для выполненных прямо в заметке
   * повторяющихся напоминаний вставляется следующее вхождение, а маркеры незавершённых наград
   * (см. ReminderRewards) доначисляются. Файл пишется только если есть что менять.
   */
  private async handleFileChanged(file: TFile): Promise<void> {
    const { settings } = this.ctx.plugin;
    if (!settings.enableReminders) return;
    if (this.ctx.remindersIndex.isExcluded(file.path) || file.path === this.getDataPath()) return;
    if (this.suppressRecurForPath.has(file.path)) return;
    // Файл могли удалить или переименовать за время паузы
    if (!(this.ctx.app.vault.getAbstractFileByPath(file.path) instanceof TFile)) return;

    let content = await this.ctx.app.vault.read(file);
    if (insertNextRecurrenceLines(content) !== content) {
      const written = await this.writeOwnChange(file, (current) => insertNextRecurrenceLines(current));
      if (written != null) content = written;
      this.scheduleRefresh();
    }
    if (settings.enableGamification && (await this.recoverRewardsInFile(file, content))) {
      await this.refreshGamificationBlocks();
    }
  }

  load(): void {
    this.ctx.remindersIndex.ensureSubscribed(() => this.scheduleRefresh());
    this.ctx.plugin.registerEvent(this.ctx.app.workspace.on("active-leaf-change", this.registry.scheduleRefresh));
    const vault = this.ctx.app.vault as unknown as {
      on(e: "modify", cb: (f: TFile) => void): EventRef;
    };
    this.ctx.plugin.registerEvent(vault.on("modify", this.onVaultModify));

    this.lastCalendarDayKey = formatDateKey(new Date());
    this.ctx.plugin.registerInterval(window.setInterval(() => this.checkCalendarDayChange(), DAY_CHECK_INTERVAL_MS));
    this.scheduleMidnightDayCheck();
    this.ctx.plugin.registerDomEvent(window, "focus", () => this.checkCalendarDayChange());
    void this.recoverPendingRewardsOnStartup().catch((error) =>
      console.error("[Reminders] pending reward recovery failed:", error)
    );

    this.ctx.plugin.registerMarkdownCodeBlockProcessor("opa-reminders-view", (_source, el, ctx) => {
      el.addClass("opa-reminders-view");
      this.registry.register(el, (force) => this.render(el, force), ctx);
    });
    this.registerCommands();
  }

  /** Команда «Новое напоминание» (для горячей клавиши, как «Запись в блокнот»). */
  private registerCommands(): void {
    this.ctx.plugin.addCommand({
      id: "reminders-add",
      name: UI_LABELS.reminders.addCommand,
      checkCallback: (checking: boolean) => {
        if (!this.ctx.plugin.settings.enableReminders) return false;
        if (!checking) void this.addReminderFromCommand();
        return true;
      },
    });
  }

  /**
   * Окно нового напоминания поверх любой заметки: выделенный текст уже в поле текста (одной строкой -
   * строка напоминания не переносится). После сохранения напоминание сразу в блоке, в уведомлении - его срок.
   */
  async addReminderFromCommand(): Promise<void> {
    if (this.reminderSettingsModalOpen) return;
    const L = UI_LABELS.reminders;
    const result = await this.openReminderModal(inboxEntryAsOneLine(getSelectedText(this.ctx.app)));
    if (!result) return;
    try {
      await this.addReminderToData(buildReminderLine(result.text, result.date, result.recurrence));
      new Notice(L.notices.addedAt(`${formatDateDDMMYYYY(result.date)} ${formatReminderTime(result.date)}`));
    } catch (error) {
      console.error("[Reminders] add from command failed:", error);
      new Notice(L.errorNotice);
    }
  }

  /**
   * Смена календарного дня: пересчитать секции (today/tomorrow/overdue) и перепланировать уведомления.
   * Без этого список «застывает» на вчерашних статусах, пока не изменится файл или вкладка.
   */
  private checkCalendarDayChange(): void {
    if (!this.ctx.plugin.settings.enableReminders) return;
    const today = formatDateKey(new Date());
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
    if (this.disposed) return;
    // Не трогаем renderEpoch здесь: иначе debounce после modify убивает in-flight forceRefresh
    this.registry.scheduleRefresh();
  };

  /**
   * Обновить UI после мутации: индекс уже актуальный, обновляем сразу. Пока открыто уведомление/пикер,
   * рефреш часто не попадает в DOM homepage (блок отсоединён / затирается) - после закрытия окна блоки
   * перерисовываются ещё раз (flushRefreshAfterModalClose).
   */
  private async refreshUiAfterMutation(): Promise<void> {
    await this.forceRefreshAsync();
  }

  /**
   * Контрольная сверка: через пару секунд перечитать файл с диска и перерисовать.
   * Лечит любой поздний перезапис индекса устаревшим кэшем, чем бы он ни был вызван.
   */
  private verifyIndexSoon(file: TFile): void {
    window.setTimeout(() => {
      if (this.disposed) return;
      void this.ctx.remindersIndex.updateFile(file).then(() => this.forceRefreshAsync());
    }, 2300);
  }

  /** Принудительное обновление блоков с ожиданием отрисовки (после мутаций даты). */
  private async forceRefreshAsync(): Promise<void> {
    if (this.disposed) return;
    this.renderEpoch++;
    await this.registry.forceRefreshAsync();
  }

  /**
   * После закрытия notification/picker: дождаться стабилизации DOM и перерисовать homepage.
   * Вызывать, когда флаги modal уже сброшены.
   */
  flushRefreshAfterModalClose(): void {
    const run = () => {
      if (this.disposed) return;
      if (this.notificationModalOpen || this.pickerModalOpen) return;
      void this.forceRefreshAsync();
    };
    // Два прохода: сразу после закрытия и ещё раз, если Obsidian пересобрал preview
    window.setTimeout(run, 50);
    window.setTimeout(run, 350);
  }

  updateState(): void {
    if (this.ctx.plugin.settings.enableReminders) {
      this.lastCalendarDayKey = formatDateKey(new Date());
      this.scheduleMidnightDayCheck();
      void this.startChecker();
    } else {
      this.stopMidnightDayCheck();
      this.stopChecker();
    }
    this.registry.runRefresh();
  }

  /**
   * Напоминания в data.json изменились не через этот модуль (блокнот, дедлайн задачи, синхронизация):
   * перечитать индекс, перерисовать блоки и перепланировать ближайшее уведомление.
   */
  async afterExternalDataChange(): Promise<void> {
    await this.ctx.remindersIndex.refreshDataJson();
    await this.forceRefreshAsync();
    if (this.ctx.plugin.settings.enableReminders) await this.startChecker();
  }

  /** Добавить напоминание в data.json (строка из buildReminderLine) и сразу показать его. */
  async addReminderToData(line: string): Promise<void> {
    await updateDataFile(this.ctx.plugin, (d) => {
      d.reminders = [...(d.reminders ?? []), line];
    });
    await this.afterExternalDataChange();
  }

  unload(): void {
    this.disposed = true;
    this.stopChecker();
    this.stopMidnightDayCheck();
    for (const t of this.fileChangeTimers.values()) clearTimeout(t);
    this.fileChangeTimers.clear();
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

  /** Таймер до ближайшего напоминания; при отсутствии - повтор через FALLBACK_CHECK_MS. */
  private async scheduleNextReminderCheck(): Promise<void> {
    if (this.disposed || !this.ctx.plugin.settings.enableReminders) return;
    await this.ctx.remindersIndex.waitReady();
    if (this.disposed) return;
    let ms = this.ctx.remindersIndex.getNextTriggerMs();
    if (ms != null && ms <= 1000) {
      if (this.isReminderUiBlocking()) {
        // Пока открыто наше уведомление - не крутить проверку каждую секунду (следующее откроет onClose)
        ms = FALLBACK_CHECK_MS;
      } else {
        // Все наступившие напоминания замолчали после неудачного действия - ждём конца ближайшего молчания
        // или срока следующего напоминания, что раньше
        const delay = this.delayWhileDueItemsMuted();
        if (delay != null) ms = delay;
      }
    }
    // startChecker могли вызвать параллельно (таймер, смена дня, настройки): держим ровно один таймер
    this.stopChecker();
    this.nextCheckTimeoutId = setTimeout(
      () => {
        this.nextCheckTimeoutId = null;
        void this.startChecker();
      },
      ms != null ? Math.min(MAX_CHECK_DELAY_MS, Math.max(1000, ms)) : FALLBACK_CHECK_MS
    );
  }

  /**
   * Если каждое напоминание, срок которого уже наступил, сейчас замолчало - через сколько мс проверять снова:
   * конец ближайшего молчания или срок ближайшего ещё не наступившего напоминания, что раньше.
   * null - есть наступившее незамолчавшее напоминание (или наступивших нет): проверять как обычно.
   */
  private delayWhileDueItemsMuted(): number | null {
    const data = this.ctx.remindersIndex.getReminderData();
    const now = Date.now();
    let nearestMute: number | null = null;
    let nextTrigger: number | null = null;
    for (const item of [...data.overdue, ...data.today, ...data.tomorrow, ...data.upcoming]) {
      const trigger = this.getTriggerTime(item).getTime();
      if (trigger > now) {
        nextTrigger = nextTrigger == null ? trigger - now : Math.min(nextTrigger, trigger - now);
        continue;
      }
      const until = this.mutedUntil.get(this.itemKey(item));
      if (until == null || until <= now) return null;
      nearestMute = nearestMute == null ? until - now : Math.min(nearestMute, until - now);
    }
    if (nearestMute == null) return null;
    return nextTrigger == null ? nearestMute : Math.min(nearestMute, nextTrigger);
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
        // DOM уже чист - сбрасываем залипшие флаги
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
   * После закрытия уведомления/пикера - сразу проверить следующее due/просроченное.
   * Ждём исчезновения modal из DOM: иначе проверка натыкается на ещё открытый .modal и выходит.
   */
  scheduleCheckAfterNotification(): void {
    if (this.disposed || !this.ctx.plugin.settings.enableReminders) return;
    this.stopChecker();
    this.nextCheckTimeoutId = setTimeout(() => {
      this.nextCheckTimeoutId = null;
      void (async () => {
        await this.waitForReminderModalsGone();
        await this.startChecker();
      })();
    }, 100);
  }

  /** Время срабатывания: если нет времени в задаче - 10:00 в день срока. */
  private getTriggerTime(item: ReminderItem): Date {
    if (item.displayTime) return item.date;
    const d = new Date(item.date);
    d.setHours(10, 0, 0, 0);
    return d;
  }

  private async runReminderCheck(): Promise<void> {
    if (this.disposed || !this.ctx.plugin.settings.enableReminders) return;
    // Только наши окна - не любой .modal.modal-open (часто ещё висит при закрытии / у других плагинов)
    if (this.isReminderUiBlocking()) return;
    if (document.querySelector(".opa-reminder-notification-modal, .opa-reminder-picker-modal")) return;
    try {
      await this.ctx.remindersIndex.waitReady();
      // Плагин могли перезагрузить, пока строился индекс: окно от выгруженного экземпляра не открываем
      if (this.disposed) return;
      const data = this.ctx.remindersIndex.getReminderData();
      const candidates = [...data.overdue, ...data.today].sort(
        (a, b) => a.date.getTime() - b.date.getTime()
      );
      const now = new Date();
      for (const item of candidates) {
        if (this.isMuted(item, now.getTime())) continue;
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

  private itemKey(item: ReminderItem): string {
    return `${item.filePath}\n${item.lineText}`;
  }

  /** Действие из уведомления не удалось: не открывать то же напоминание снова какое-то время. */
  muteItemAfterFailure(item: ReminderItem): void {
    this.mutedUntil.set(this.itemKey(item), Date.now() + MUTE_AFTER_FAILURE_MS);
    // Скорее всего строка в файле изменилась - перечитать её, чтобы следующий показ был с актуальным текстом
    const file = this.ctx.app.vault.getAbstractFileByPath(item.filePath);
    if (file instanceof TFile) this.verifyIndexSoon(file);
  }

  private isMuted(item: ReminderItem, nowMs: number): boolean {
    const key = this.itemKey(item);
    const until = this.mutedUntil.get(key);
    if (until == null) return false;
    if (nowMs >= until) {
      this.mutedUntil.delete(key);
      return false;
    }
    return true;
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

        /**
         * fn возвращает true, если действие с напоминанием удалось. Иначе (строка в файле уже другая)
         * напоминание на время замолкает - окно не должно открываться заново каждую секунду.
         */
        const addBtn = (label: string, fn: () => Promise<boolean>, primary = false) => {
          const btn = btnContainer.createEl("button", { text: label, cls: primary ? "opa-reminder-notif-btn opa-reminder-notif-btn-primary" : "opa-reminder-notif-btn" });
          btn.addEventListener("click", async () => {
            let ok = false;
            try {
              ok = await fn();
            } catch (e) {
              console.error("[Reminders] notification action failed:", e);
              new Notice(e instanceof Error ? e.message : "Ошибка");
            }
            if (!ok) this.remindersRef.muteItemAfterFailure(item);
            this.close();
          });
        };

        addBtn(snooze.doneBtn, async () => {
          const ok = await this.remindersRef.completeReminder(item);
          if (ok) new Notice(snooze.done);
          return ok;
        }, true);
        addBtn(snooze.oneHourBtn, async () => {
          const ok = await this.remindersRef.snoozeReminder(item, 60);
          if (ok) new Notice(snooze.oneHour);
          return ok;
        });
        addBtn(snooze.tomorrowBtn, async () => {
          const ok = await this.remindersRef.snoozeReminder(item, 1440);
          if (ok) new Notice(snooze.tomorrow);
          return ok;
        });
        addBtn(snooze.pickDateBtn, async () => {
          const ref = this.remindersRef;
          const remItem = item;
          // Сначала флаг пикера, потом close - иначе onClose уведомления сразу откроет следующее
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
                    } else {
                      ref.muteItemAfterFailure(remItem);
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
          return true;
        });
      }
      onClose() {
        this.remindersRef.notificationModalOpen = false;
        // Следующее просроченное/due - сразу после действия с текущим
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

  /** Найти строку: точный матч, затем только однозначный нечёткий матч. */
  private findReminderLineIndex(lines: string[], lineText: string): number {
    return findUniqueLineIndexByText(lines, lineText);
  }

  /** Начислить награды по намерениям (id уже начисленных пропускаются) и запомнить их id. */
  private async persistMarkdownRewards(intents: ReminderRewardIntent[]): Promise<void> {
    if (intents.length === 0) return;
    await updateDataFile(this.ctx.plugin, (d) => {
      const ids = new Set(d.reminderRewardIds ?? []);
      const state = d.gamification ?? emptyGamificationState();
      for (const intent of intents) {
        if (ids.has(intent.id)) continue;
        applyReminderRewardIntent(state, intent);
        ids.add(intent.id);
      }
      d.gamification = state;
      // Маркеры убираются из заметок сразу после начисления, поэтому хранить все id навсегда не нужно
      d.reminderRewardIds = [...ids].slice(-MAX_REWARD_IDS);
    });
  }

  /**
   * Доначислить награды по маркерам-намерениям в заметке и убрать маркеры из текста.
   * content - уже прочитанное содержимое (иначе файл читается). true - награды были.
   */
  private async recoverRewardsInFile(file: TFile, content?: string): Promise<boolean> {
    const text = content ?? (await this.ctx.app.vault.read(file));
    const intents = rewardIntentsFromText(text);
    if (intents.length === 0) return false;
    await this.persistMarkdownRewards(intents);
    await this.writeOwnChange(file, stripRewardMarkers);
    return true;
  }

  /** Состояние геймификации изменилось в data.json - перечитать кэш и перерисовать блоки прогресса. */
  private async refreshGamificationBlocks(): Promise<void> {
    await this.ctx.plugin.refreshGamificationState();
    this.ctx.plugin.gamification?.updateState?.();
  }

  /**
   * При запуске: награды, маркеры которых остались в заметках после прерванного выполнения.
   * Файлы с маркерами известны индексу напоминаний - повторный обход хранилища не нужен.
   */
  private async recoverPendingRewardsOnStartup(): Promise<void> {
    // Индекс строится и при выключенных напоминаниях, поэтому маркер после сбоя доначисляется в любом случае
    if (!this.ctx.plugin.settings.enableGamification) return;
    await this.ctx.remindersIndex.waitReady();
    if (this.disposed) return;
    let applied = false;
    for (const path of this.ctx.remindersIndex.getFilesWithRewardMarkers()) {
      if (this.disposed) return;
      const file = this.ctx.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      if (await this.recoverRewardsInFile(file)) applied = true;
    }
    if (applied && !this.disposed) await this.refreshGamificationBlocks();
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
      await this.ctx.remindersIndex.refreshDataJson();
      await this.refreshUiAfterMutation();
      return true;
    }

    const file = this.ctx.app.vault.getAbstractFileByPath(item.filePath);
    if (!(file instanceof TFile)) {
      new Notice(`Файл не найден: ${item.filePath}`);
      return false;
    }

    const written = await this.writeOwnChange(file, (content) => {
      const lines = content.split("\n");
      const lineIdx = this.findReminderLineIndex(lines, item.lineText);
      if (lineIdx === -1) return content;
      lines[lineIdx] = replaceReminderDateTag(lines[lineIdx], newTag);
      return lines.join("\n");
    });
    if (written == null) {
      new Notice(UI_LABELS.reminders.notices.completeNotFound);
      return false;
    }
    await this.refreshUiAfterMutation();
    this.verifyIndexSoon(file);
    return true;
  }

  /** force=false - фоновое обновление: при неизменившихся данных (и той же минуте) DOM не трогаем. */
  private async render(container: HTMLElement, force = true): Promise<void> {
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

      // Данные после await - иначе гонка с более новым render затрёт актуальные даты.
      const data = this.getReminderData();
      if (epoch !== this.renderEpoch) return;

      // От времени зависят секция каждого напоминания (в data: type) и подпись «через N дн.» - они и входят
      // в подпись. Сама текущая минута в подпись не входит: иначе фоновое обновление на границе минуты
      // пересобирало бы DOM и стирало набранный в поле ввода текст.
      const active = [...data.overdue, ...data.today, ...data.tomorrow, ...data.upcoming];
      const signature = renderSignature("reminders", data, active.map((item) => fromNow(item.date)));
      if (!force && isRenderUnchanged(container, signature)) return;

      container.empty();
      markRendered(container, signature);
      const body = createCollapsibleSection(container, UI_LABELS.blockTitles.reminders, "reminders");

      const formWrap = body.createEl("div", { cls: "view-add-form" });
      const input = formWrap.createEl("input", {
        type: "text",
        cls: "view-input",
        attr: { placeholder: L.addPlaceholder, "data-focus-restore": "add-input" },
      });
      const addBtn = formWrap.createEl("button", { text: common.add, cls: "view-btn" });
      addBtn.addEventListener("click", async () => {
        const text = input.value.trim();
        if (!text) return;
        const result = await this.openReminderModal(text);
        if (result) {
          try {
            await this.addReminderToData(buildReminderLine(result.text, result.date, result.recurrence));
            new Notice(L.notices.added);
            input.value = "";
            this.shouldRestoreFocus = true;
          } catch (error) {
            console.error("[Reminders] add failed:", error);
            new Notice(L.errorNotice);
          }
        }
        setTimeout(() => input.focus(), 150);
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
            void this.completeReminder(item).catch((error) => {
              console.error("[Reminders] complete failed:", error);
              new Notice(L.errorNotice);
            });
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
            void this.editReminderFromBlock(item);
          });
          const deleteBtn = actions.createEl("button", { text: L.delete, cls: "inbox-action-btn" });
          deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            void this.deleteReminder(item).catch((error) => {
              console.error("[Reminders] delete failed:", error);
              new Notice(L.errorNotice);
            });
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
            void this.deleteReminder(item).catch((error) => {
              console.error("[Reminders] delete failed:", error);
              new Notice(L.errorNotice);
            });
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
      if (epoch !== this.renderEpoch) return;
      container.empty();
      container.createEl("p", { text: L.errorNotice ?? "Ошибка напоминаний", cls: "view-error" });
      console.error(e);
    }
  }

  /**
   * «Изменить» в блоке: окно напоминания с текущими текстом, сроком и повторением. В строку записывается
   * только изменённое в окне, остальное в строке остаётся как было; «Отмена», Esc и «Сохранить» без изменений
   * ничего не пишут.
   */
  async editReminderFromBlock(item: ReminderItem): Promise<void> {
    if (this.reminderSettingsModalOpen) return;
    const L = UI_LABELS.reminders;
    const initial = reminderEditFields(item.lineText);
    if (!initial) return;
    const result = await this.openReminderModal(initial.text, {
      title: L.modal.editTitle,
      date: initial.date,
      recurrence: initial.recurrence,
    });
    if (!result) return;
    const changes = reminderEditChanges(initial, result);
    if (Object.keys(changes).length === 0) return;
    try {
      new Notice((await this.editReminder(item, changes)) ? L.notices.updated : L.notices.editNotFound);
    } catch (error) {
      console.error("[Reminders] edit failed:", error);
      new Notice(L.errorNotice);
    }
    await this.forceRefreshAsync();
    // Срок мог измениться: таймер уведомлений заводится заново по актуальным данным
    this.scheduleCheckAfterNotification();
  }

  /**
   * Отметить строку выполненной; для повторяющихся - вставить следующее вхождение сразу под ней.
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
    const due = parseReminderDueFromText(completedLine);
    const nextLine = due ? buildNextRecurrenceLine(parsed, due.date) : null;
    if (!nextLine) return null;
    lines[lineIdx] = completedLineWithoutRecurrence(completedLine, parsed.recurrenceFull);
    lines.splice(lineIdx + 1, 0, nextLine);
    return { amount: parsed.amount, unit: parsed.unit };
  }

  /** Награда за выполнение напоминания сейчас: XP/Gold из настроек, для повторяющихся - стрик по тексту. */
  private buildRewardIntent(item: ReminderItem): ReminderRewardIntent {
    const { settings } = this.ctx.plugin;
    const reward = settings.gamificationReminderRewards;
    const recurrence = item.isRecurring ? parseRecurrenceFromText(item.lineText) : null;
    const graceMs = settings.gamificationStreakGraceDays * 24 * 60 * 60 * 1000;
    const streak = recurrence
      ? {
          key: item.text.trim() || "reminder",
          onTime: isRecurrenceCompletionOnTime(item.date, new Date(), recurrence.amount, recurrence.unit, graceMs),
        }
      : undefined;
    return createReminderRewardIntent(reward.xp, reward.gold, streak);
  }

  /**
   * Отметить напоминание выполненным из блока. Для повторяющихся вставляется следующее вхождение.
   * Награда: в data.json начисляется той же записью; в заметке - через маркер-намерение (ReminderRewards).
   * false - строка не найдена (файл изменился с момента отрисовки).
   */
  private async completeReminder(item: ReminderItem): Promise<boolean> {
    const rewardIntent = this.ctx.plugin.settings.enableGamification ? this.buildRewardIntent(item) : null;
    let recurrence: { amount: number; unit: string } | null = null;
    let completed = false;

    if (item.filePath === this.getDataPath()) {
      await updateDataFile(this.ctx.plugin, (d) => {
        const reminders = [...(d.reminders ?? [])];
        const idx = reminders.findIndex((l) => l.trim() === item.lineText);
        if (idx === -1) return;
        completed = true;
        recurrence = this.completeLineInPlace(reminders, idx);
        d.reminders = reminders;
        if (rewardIntent) {
          const state = d.gamification ?? emptyGamificationState();
          applyReminderRewardIntent(state, rewardIntent);
          d.gamification = state;
        }
      });
      if (completed) await this.ctx.remindersIndex.refreshDataJson();
    } else {
      const file = this.ctx.app.vault.getAbstractFileByPath(item.filePath);
      if (!(file instanceof TFile)) {
        new Notice(UI_LABELS.reminders.notices.completeNotFound);
        return false;
      }
      const written = await this.writeOwnChange(file, (content) => {
        const lines = content.split("\n");
        const lineIdx = this.findReminderLineIndex(lines, item.lineText);
        if (lineIdx === -1) return content;
        recurrence = this.completeLineInPlace(lines, lineIdx);
        if (rewardIntent) lines[lineIdx] += ` ${rewardMarker(rewardIntent)}`;
        return lines.join("\n");
      });
      completed = written != null;
      if (completed) {
        this.verifyIndexSoon(file);
        // Маркер уже в файле: начислить награду в data.json и убрать маркер
        if (rewardIntent) await this.recoverRewardsInFile(file, written ?? undefined);
      }
    }

    if (!completed) {
      new Notice(UI_LABELS.reminders.notices.completeNotFound);
      return false;
    }
    if (recurrence) {
      const { amount, unit } = recurrence;
      new Notice(UI_LABELS.reminders.notices.nextCreated(amount, unit));
    }
    if (rewardIntent) {
      await this.refreshGamificationBlocks();
      new Notice(`${UI_LABELS.reminders.notices.completed} ${UI_LABELS.gamification.rewardLine(rewardIntent.xp, rewardIntent.gold)}`);
    } else {
      new Notice(UI_LABELS.reminders.notices.completed);
    }
    await this.refreshUiAfterMutation();
    return true;
  }

  /**
   * Записать правку из окна «Изменить»: в строке меняется только изменённое в окне (applyReminderEdit),
   * отступ вложенного напоминания и остальное в строке остаются. Строка ищется как при выполнении и переносе.
   * false - строка не найдена (её изменили или удалили, пока было открыто окно).
   */
  private async editReminder(item: ReminderItem, changes: ReminderEditChanges): Promise<boolean> {
    if (item.filePath === this.getDataPath()) {
      let updated = false;
      await updateDataFile(this.ctx.plugin, (d) => {
        const reminders = d.reminders ?? [];
        const idx = reminders.findIndex((l) => l.trim() === item.lineText);
        if (idx === -1) return;
        updated = true;
        const next = [...reminders];
        next[idx] = applyReminderEdit(reminders[idx], changes).trim();
        d.reminders = next;
      });
      if (!updated) return false;
      await this.ctx.remindersIndex.refreshDataJson();
      return true;
    }
    const file = this.ctx.app.vault.getAbstractFileByPath(item.filePath);
    if (!(file instanceof TFile)) return false;
    let found = false;
    await this.writeOwnChange(file, (content) => {
      const lines = content.split("\n");
      const idx = this.findReminderLineIndex(lines, item.lineText);
      if (idx === -1) return content;
      found = true;
      lines[idx] = applyReminderEdit(lines[idx], changes);
      return lines.join("\n");
    });
    if (found) this.verifyIndexSoon(file);
    return found;
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
      if (!(file instanceof TFile)) {
        new Notice(UI_LABELS.reminders.notices.deleteNotFound);
        return;
      }
      let removedLine: string | null = null;
      let removedIndex = -1;
      const written = await this.writeOwnChange(file, (content) => {
        const lines = content.split("\n");
        removedIndex = this.findReminderLineIndex(lines, item.lineText);
        if (removedIndex === -1) return content;
        removedLine = lines[removedIndex];
        lines.splice(removedIndex, 1);
        return lines.join("\n");
      });
      if (removedLine == null || written == null) {
        new Notice(UI_LABELS.reminders.notices.deleteNotFound);
        return;
      }
      const lineToTrash: string = removedLine;
      try {
        await updateDataFile(this.ctx.plugin, (d) => {
          d.trash = [...(d.trash ?? []), lineToTrash];
        });
      } catch (error) {
        // Корзина не записалась - вернуть строку в заметку, чтобы напоминание не пропало
        await this.writeOwnChange(file, (content) => {
          const lines = content.split("\n");
          lines.splice(Math.min(removedIndex, lines.length), 0, lineToTrash);
          return lines.join("\n");
        });
        throw error;
      }
    }
    new Notice(UI_LABELS.reminders.notices.movedToTrash);
    this.ctx.plugin.triggerTrashRefresh?.();
    await this.forceRefreshAsync();
  }

  /** Окно напоминания: новое (текст из defaultText, срок через час) или «Изменить» (options - текущие значения). */
  public openReminderModal(
    defaultText: string,
    options: ReminderModalOptions = {}
  ): Promise<{ text: string; date: Date; recurrence: string } | null> {
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
          this.contentEl.createEl("h2", { text: options.title ?? mod.title });
          this.contentEl.createEl("div", { text: mod.textLabel, cls: "setting-item-description" });
          const textInput = this.contentEl.createEl("input", { type: "text", cls: "view-input opa-reminder-modal-input" });
          textInput.value = defaultText;
          this.contentEl.createEl("div", { text: mod.dateLabel, cls: "setting-item-description" });
          const dateInput = this.contentEl.createEl("input", { type: "datetime-local", cls: "view-input opa-reminder-modal-input" });
          // Новое напоминание - через час, при правке - текущий срок
          dateInput.value = toDateTimeLocalValue(options.date ?? new Date(Date.now() + 60 * 60 * 1000));
          this.contentEl.createEl("div", { text: mod.recurrenceLabel, cls: "setting-item-description" });
          const recurWrap = this.contentEl.createEl("div", { cls: "reminder-modal-recur" });
          const recurAmount = recurWrap.createEl("input", { type: "number", cls: "view-input reminder-modal-recur-amount" });
          recurAmount.value = String(options.recurrence?.amount ?? 1);
          recurAmount.min = "1";
          const recurUnit = recurWrap.createEl("select", { cls: "view-input reminder-modal-recur-unit" });
          [
            { value: "", label: mod.noRecurrence },
            { value: "days", label: mod.days },
            { value: "weeks", label: mod.weeks },
            { value: "months", label: mod.months },
            { value: "years", label: mod.years },
          ].forEach((o) => recurUnit.createEl("option", { value: o.value, text: o.label }));
          recurUnit.value = options.recurrence?.unit ?? "";
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
            const amountNumber = Number(amount);
            if (unit && (!Number.isSafeInteger(amountNumber) || amountNumber <= 0)) {
              (recurAmount as HTMLInputElement).setCustomValidity("Введите положительное целое число");
              (recurAmount as HTMLInputElement).reportValidity();
              return;
            }
            (recurAmount as HTMLInputElement).setCustomValidity("");
            const recurrence = unit ? `every ${amountNumber} ${unit}` : "";
            doResolve({
              text: text || defaultText,
              date: new Date(dateVal),
              recurrence,
            });
            this.close();
          });
          this.contentEl.addEventListener("keydown", (e: KeyboardEvent) => {
            // Enter на кнопке - действие самой кнопки: «Отмена» с клавиатуры не должна сохранять
            if (e.key === "Enter" && (e.target as HTMLElement | null)?.tagName !== "BUTTON") {
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
