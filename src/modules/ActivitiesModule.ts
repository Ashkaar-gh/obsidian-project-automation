/**
 * Модуль «Пул активностей» (Logbook): блок opa-activities-view на домашней странице.
 * Список дел с отметкой «когда делалось в последний раз», модалка со статистикой (сетка месяца).
 */

import type { ModuleContext } from "./types";
import {
  readDataFile,
  updateDataFile,
  getRewardForDifficulty,
  isActivityDifficulty,
  ACTIVITY_DIFFICULTY_REWARDS_DEFAULT,
  DIFFICULTY_DISPLAY_LABELS,
  type ActivitiesData,
  type ActivityItem,
} from "../core/GamificationState";
import { UI_LABELS } from "../ui/Labels";
import { createCollapsibleSection } from "../ui/CollapsibleSection";
import { BlockRegistry } from "../ui/BlockRegistry";
import { Modal, Notice } from "obsidian";

const STORAGE_KEY_ACTIVITIES = "opa-activities-view";

const MONTH_NAMES: string[] = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

function getTodayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getLastDoneDate(dates: string[]): string | null {
  if (!dates || dates.length === 0) return null;
  const sorted = [...dates].sort();
  return sorted[sorted.length - 1];
}

/** Парсинг YYYY-MM-DD по компонентам (new Date(str) дал бы полночь UTC и сдвиг дня в западных таймзонах). */
function parseDateKey(dateKey: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateKey.split("-").map(Number);
  return { year, month, day };
}

function getDisplayTextForLastDone(lastDate: string | null, todayKey: string): string {
  const L = UI_LABELS.activities;
  if (!lastDate) return L.never;
  if (lastDate === todayKey) return L.doneToday;

  const today = parseDateKey(todayKey);
  const last = parseDateKey(lastDate);
  const todayStart = Date.UTC(today.year, today.month - 1, today.day);
  const lastStart = Date.UTC(last.year, last.month - 1, last.day);
  const diffDays = Math.floor((todayStart - lastStart) / (24 * 60 * 60 * 1000));

  if (diffDays === 1) return L.yesterday;
  if (diffDays >= 7) return L.weekAgo;
  return L.daysAgo(diffDays);
}

function nextActivityId(items: ActivityItem[]): string {
  const nums = items
    .map((i) => /^a_(\d+)$/.exec(i.id)?.[1])
    .filter(Boolean)
    .map((n) => parseInt(n!, 10));
  const max = nums.length ? Math.max(...nums) : 0;
  return `a_${max + 1}`;
}

/** Суммарное количество выполнений активности по всей истории (для сортировки по частоте). */
function getTotalCount(history: ActivitiesData["history"], activityId: string): number {
  const byDate = history[activityId] ?? {};
  return Object.values(byDate).reduce((s, n) => s + n, 0);
}

function getCountOnDate(
  history: ActivitiesData["history"],
  activityId: string,
  dateKey: string
): number {
  return (history[activityId] ?? {})[dateKey] ?? 0;
}

/** Суммы выполнений по активностям (считаем один раз, а не в компараторе). */
function getTotalCounts(data: ActivitiesData): Map<string, number> {
  const totals = new Map<string, number>();
  for (const item of data.items) totals.set(item.id, getTotalCount(data.history, item.id));
  return totals;
}

/** Активности, отсортированные по убыванию частоты (самые частые сверху). */
function getItemsSortedByFrequency(data: ActivitiesData): ActivityItem[] {
  const totals = getTotalCounts(data);
  return [...data.items].sort((a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0));
}

/** Модалка «Выбор активностей»: сначала отмеченные за dateKey, внутри групп — по частоте. */
function getItemsSortedForActivityPicker(data: ActivitiesData, dateKey: string): ActivityItem[] {
  const totals = getTotalCounts(data);
  return [...data.items].sort((a, b) => {
    const doneA = getCountOnDate(data.history, a.id, dateKey) > 0;
    const doneB = getCountOnDate(data.history, b.id, dateKey) > 0;
    if (doneA !== doneB) return Number(doneB) - Number(doneA);
    return (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0);
  });
}

/** Интервал проверки смены дня (мс). При наступлении 00:00 вид перерисуется без перезапуска. */
const DAY_CHECK_INTERVAL_MS = 60 * 1000;

export class ActivitiesModule {
  private ctx: ModuleContext;
  private registry: BlockRegistry;
  private lastTodayKey: string = getTodayKey();
  /** Выбранная дата для отображения и редактирования активностей (по умолчанию — сегодня). */
  private selectedDateKey: string = getTodayKey();

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.registry = new BlockRegistry({
      app: ctx.app,
      isEnabled: () => ctx.plugin.settings.enableActivities,
      domSelector: ".opa-activities-view",
      createRefresh: (el) => () => this.render(el),
    });
  }

  load(): void {
    const { plugin, app } = this.ctx;
    plugin.registerEvent(app.vault.on("modify", this.onDataChange));
    this.lastTodayKey = getTodayKey();
    plugin.registerInterval(window.setInterval(() => this.checkDayChange(), DAY_CHECK_INTERVAL_MS));

    plugin.registerMarkdownCodeBlockProcessor("opa-activities-view", (_source, el) => {
      el.addClass("opa-activities-view");
      this.registry.register(el, () => this.render(el));
    });
  }

  private onDataChange = (file: { path: string }): void => {
    if (file.path !== this.ctx.plugin.getGamificationDataPath()) return;
    this.registry.scheduleRefresh();
  };

  private checkDayChange(): void {
    const now = getTodayKey();
    if (now !== this.lastTodayKey) {
      if (this.selectedDateKey === this.lastTodayKey) {
        this.selectedDateKey = now;
      }
      this.lastTodayKey = now;
      this.runRefresh();
    }
  }

  private runRefresh(): void {
    this.registry.runRefresh();
  }

  unload(): void {
    this.registry.clear();
  }

  updateState(): void {
    this.runRefresh();
  }

  forceRefresh(): void {
    this.runRefresh();
  }

  private async getActivitiesData(): Promise<ActivitiesData> {
    const data = await readDataFile(this.ctx.plugin);
    return data.activities ?? { items: [], history: {} };
  }

  private getCount(data: ActivitiesData, activityId: string, dateKey: string): number {
    return (data.history[activityId] ?? {})[dateKey] ?? 0;
  }

  /** Изменить счётчик на delta от актуального значения (замыкания с устаревшим count не теряют клики). */
  private changeCount(activityId: string, dateKey: string, delta: number): Promise<void> {
    return this.applyCount(activityId, dateKey, (current) => Math.max(0, current + delta));
  }

  /** Установить количество выполнений за день. */
  private setCount(activityId: string, dateKey: string, count: number): Promise<void> {
    return this.applyCount(activityId, dateKey, () => Math.max(0, count));
  }

  /**
   * Атомарное изменение счётчика: значение вычисляется от актуального внутри очереди записи.
   * Награда начисляется за каждое новое выполнение (count сверх уже награждённого за день).
   */
  private async applyCount(
    activityId: string,
    dateKey: string,
    compute: (current: number) => number
  ): Promise<void> {
    let rewardToGive: { xp: number; gold: number } | null = null;
    await updateDataFile(this.ctx.plugin, (d) => {
      const activities = d.activities ?? { items: [], history: {} };
      const current = (activities.history[activityId] ?? {})[dateKey] ?? 0;
      const count = compute(current);
      const byDate = { ...(activities.history[activityId] ?? {}) };
      if (count <= 0) {
        delete byDate[dateKey];
      } else {
        byDate[dateKey] = count;
      }
      const history = { ...activities.history, [activityId]: byDate };
      const rewardsGiven = { ...(activities.rewardsGiven ?? {}) };
      const byDateRewards = { ...(rewardsGiven[activityId] ?? {}) };
      const alreadyGiven = byDateRewards[dateKey] ?? 0;
      const toGive = Math.max(0, count - alreadyGiven);
      if (toGive > 0 && this.ctx.plugin.settings.enableGamification) {
        const activity = activities.items.find((i) => i.id === activityId);
        const activityDefault = this.ctx.plugin.settings.gamificationActivityDefaultDifficulty ?? "легкая";
        const difficulty = activity?.difficulty ?? activityDefault;
        const rewardsMap = this.ctx.plugin.settings.gamificationActivityDifficultyRewards ?? ACTIVITY_DIFFICULTY_REWARDS_DEFAULT;
        const reward = getRewardForDifficulty(difficulty, {
          difficultyRewards: rewardsMap,
          defaultDifficulty: activityDefault,
        });
        rewardToGive = { xp: reward.xp * toGive, gold: reward.gold * toGive };
      }
      if (count > 0) {
        byDateRewards[dateKey] = Math.max(alreadyGiven, count);
        rewardsGiven[activityId] = byDateRewards;
      }
      /* При count === 0 не трогаем rewardsGiven: если потом снова добавят активность в тот же день, награду не даём повторно */
      d.activities = { ...activities, history, rewardsGiven };
    });
    if (rewardToGive) {
      const { xp, gold } = rewardToGive;
      const state = await this.ctx.plugin.getGamificationState();
      state.xp += xp;
      state.gold += gold;
      this.ctx.plugin.scheduleGamificationSave();
      new Notice(UI_LABELS.gamification.rewardLine(xp, gold));
      this.ctx.plugin.gamification?.updateState?.();
    }
    this.runRefresh();
  }

  private async toggleCompletion(activityId: string, dateKey: string, isAdding: boolean): Promise<void> {
    await this.setCount(activityId, dateKey, isAdding ? 1 : 0);
  }

  private async render(container: HTMLElement): Promise<void> {
    if (!this.ctx.plugin.settings.enableActivities) {
      container.empty();
      container.addClass("opa-hidden");
      return;
    }
    container.removeClass("opa-hidden");

    const L = UI_LABELS.activities;
    const todayKey = getTodayKey();

    try {
      const data = await this.getActivitiesData();
      container.empty();

      const body = createCollapsibleSection(container, L.title, STORAGE_KEY_ACTIVITIES);

      const dateItems = getItemsSortedByFrequency(data)
        .map((item) => ({ item, count: this.getCount(data, item.id, this.selectedDateKey) }))
        .filter(({ count }) => count > 0);
      if (!dateItems.length) {
        body.createEl("p", { text: L.emptyToday, cls: "opa-activities-empty" });
      } else {
        const listWrap = body.createEl("div", { cls: "opa-activities-list" });
        for (const { item, count } of dateItems) {
          const row = listWrap.createEl("div", { cls: "opa-activity-row" });
          const nameEl = row.createEl("span", { cls: "opa-activity-name opa-activity-name-link", text: item.name });
          nameEl.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.openStatisticsModal(item.id);
          });

          const counterWrap = row.createDiv({ cls: "opa-activity-counter" });
          const btnPlus = counterWrap.createEl("button", { cls: "opa-activity-counter-btn", attr: { type: "button", "aria-label": "Увеличить" } });
          btnPlus.setText("+");
          const countSpan = counterWrap.createEl("span", { cls: "opa-activity-counter-value" });
          countSpan.setText(String(count));
          const btnMinus = counterWrap.createEl("button", { cls: "opa-activity-counter-btn", attr: { type: "button", "aria-label": "Уменьшить" } });
          btnMinus.setText("−");

          btnPlus.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.changeCount(item.id, this.selectedDateKey, 1).catch(console.error);
          });
          btnMinus.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Минус не опускает ниже 1: убрать активность за день можно только кнопкой «Удалить»
            this.applyCount(item.id, this.selectedDateKey, (cur) => (cur > 1 ? cur - 1 : cur)).catch(console.error);
          });

          const uncheckBtn = row.createEl("button", {
            text: UI_LABELS.common.delete,
            cls: "opa-activity-uncheck-btn view-btn",
            attr: { type: "button", "aria-label": "Убрать" },
          });
          uncheckBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await this.setCount(item.id, this.selectedDateKey, 0);
          });
        }
      }

      const actions = body.createEl("div", { cls: "opa-activities-actions" });
      const btnAll = actions.createEl("button", { text: L.allActivities, cls: "opa-activities-btn view-btn" });
      const btnCharts = actions.createEl("button", { text: L.charts, cls: "opa-activities-btn view-btn" });
      const btnDate = actions.createEl("button", { text: L.dateButton, cls: "opa-activities-btn view-btn" });
      btnAll.addEventListener("click", () => this.openAllActivitiesModal());
      btnCharts.addEventListener("click", () => this.openStatisticsModal());
      btnDate.addEventListener("click", () => {
        new ActivitiesDatePickerModal(
          this.ctx.app,
          this.selectedDateKey,
          todayKey,
          (dateKey) => {
            this.selectedDateKey = dateKey;
            this.runRefresh();
          },
        ).open();
      });
    } catch (e) {
      container.empty();
      container.createEl("p", { text: UI_LABELS.errors.renderShort, cls: "view-error" });
      console.error("[OPA] Activities render error:", e);
    }
  }

  private async removeActivity(activityId: string): Promise<void> {
    await updateDataFile(this.ctx.plugin, (d) => {
      const activities = d.activities ?? { items: [], history: {} };
      const items = activities.items.filter((i) => i.id !== activityId);
      const history = { ...activities.history };
      delete history[activityId];
      const rewardsGiven = { ...(activities.rewardsGiven ?? {}) };
      delete rewardsGiven[activityId];
      d.activities = { ...activities, items, history, rewardsGiven };
    });
    this.runRefresh();
  }

  /** Добавить активность в пул (название); в список без отметки «сделано сегодня». */
  async addActivityToPool(name: string): Promise<boolean> {
    const trimmed = name.trim();
    if (!trimmed) return false;
    let added = false;
    await updateDataFile(this.ctx.plugin, (d) => {
      const activities = d.activities ?? { items: [], history: {} };
      if (activities.items.some((i) => i.name === trimmed)) return;
      added = true;
      const id = nextActivityId(activities.items);
      const defaultDiff = (this.ctx.plugin.settings.gamificationActivityDefaultDifficulty ?? "легкая") as ActivityItem["difficulty"];
      d.activities = { ...activities, items: [...activities.items, { id, name: trimmed, difficulty: defaultDiff }] };
    });
    if (!added) return false;
    new Notice(`Добавлено: ${trimmed}`);
    this.runRefresh();
    return true;
  }

  /** Установить сложность активности. */
  async setActivityDifficulty(activityId: string, difficulty: string): Promise<void> {
    if (!isActivityDifficulty(difficulty)) return;
    await updateDataFile(this.ctx.plugin, (d) => {
      const activities = d.activities ?? { items: [], history: {} };
      if (!activities.items.some((i) => i.id === activityId)) return;
      d.activities = {
        ...activities,
        items: activities.items.map((i) => (i.id === activityId ? { ...i, difficulty } : i)),
      };
    });
    this.runRefresh();
  }

  /** Переименовать активность в пуле */
  async renameActivity(activityId: string, newName: string): Promise<boolean> {
    const trimmed = newName.trim();
    if (!trimmed) return false;
    let renamed = false;
    await updateDataFile(this.ctx.plugin, (d) => {
      const activities = d.activities ?? { items: [], history: {} };
      if (activities.items.some((i) => i.id !== activityId && i.name === trimmed)) return;
      renamed = true;
      d.activities = {
        ...activities,
        items: activities.items.map((i) => (i.id === activityId ? { ...i, name: trimmed } : i)),
      };
    });
    if (renamed) this.runRefresh();
    return renamed;
  }

  private async openAllActivitiesModal(): Promise<void> {
    const data = await this.getActivitiesData();
    new AllActivitiesModal(
      this.ctx.app,
      data,
      this.selectedDateKey,
      this.ctx.plugin.settings.gamificationActivityDefaultDifficulty ?? "легкая",
      (activityId, dateKey, isAdding) => this.toggleCompletion(activityId, dateKey, isAdding),
      () => this.getActivitiesData(),
      (name) => this.addActivityToPool(name),
      (activityId) => this.removeActivity(activityId),
      (activityId, newName) => this.renameActivity(activityId, newName),
      (activityId, difficulty) => this.setActivityDifficulty(activityId, difficulty)
    ).open();
  }

  private async openStatisticsModal(selectedActivityId?: string): Promise<void> {
    const data = await this.getActivitiesData();
    new ActivitiesStatisticsModal(this.ctx.app, data, selectedActivityId).open();
  }
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function dateKeyFromParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function clampToMax(dateKey: string, maxKey: string): string {
  if (dateKey <= maxKey) return dateKey;
  return maxKey;
}

/** Окно выбора даты в стиле «Дата ежедневной заметки»: день, месяц, год и кнопки Текущий день / Отмена / OK. */
class ActivitiesDatePickerModal extends Modal {
  private day: number;
  private month: number;
  private year: number;
  private readonly maxKey: string;
  private readonly onSelect: (dateKey: string) => void;
  private dayEl!: HTMLElement;
  private monthEl!: HTMLElement;
  private yearEl!: HTMLElement;
  private readonly yearMin = 2020;

  constructor(
    app: import("obsidian").App,
    initialDateKey: string,
    maxDateKey: string,
    onSelect: (dateKey: string) => void,
  ) {
    super(app);
    this.maxKey = maxDateKey;
    this.onSelect = onSelect;
    const [y, m, d] = initialDateKey.split("-").map(Number);
    this.year = y;
    this.month = m;
    this.day = d;
  }

  onOpen(): void {
    const L = UI_LABELS.activities;
    this.clampDay();
    this.titleEl.setText(L.dateButton);
    this.modalEl.addClass("opa-daily-heading-date-modal");

    const steppersWrap = this.contentEl.createDiv({ cls: "opa-daily-heading-date-steppers-wrap" });
    const monthWrap = steppersWrap.createDiv({ cls: "gamification-completed-month-wrap opa-daily-heading-date-steppers" });

    const dayGroup = monthWrap.createDiv({ cls: "gamification-month-group" });
    const dayStepper = dayGroup.createDiv({ cls: "gamification-stepper-group" });
    dayStepper.tabIndex = 0;
    dayStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "‹" })
      .addEventListener("click", () => this.changeDay(-1));
    this.dayEl = dayStepper.createEl("span", { cls: "gamification-stepper-value" });
    dayStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "›" })
      .addEventListener("click", () => this.changeDay(1));

    const monthGroup = monthWrap.createDiv({ cls: "gamification-month-group" });
    const monthStepper = monthGroup.createDiv({ cls: "gamification-stepper-group" });
    monthStepper.tabIndex = 0;
    monthStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "‹" })
      .addEventListener("click", () => this.changeMonth(-1));
    this.monthEl = monthStepper.createEl("span", { cls: "gamification-stepper-value gamification-stepper-month" });
    monthStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "›" })
      .addEventListener("click", () => this.changeMonth(1));

    const yearGroup = monthWrap.createDiv({ cls: "gamification-month-group" });
    const yearStepper = yearGroup.createDiv({ cls: "gamification-stepper-group" });
    yearStepper.tabIndex = 0;
    yearStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "‹" })
      .addEventListener("click", () => this.changeYear(-1));
    this.yearEl = yearStepper.createEl("span", { cls: "gamification-stepper-value" });
    yearStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "›" })
      .addEventListener("click", () => this.changeYear(1));

    this.refreshLabels();

    const currentDayRow = steppersWrap.createDiv({ cls: "opa-daily-heading-current-day-row" });
    const currentDayBtn = currentDayRow.createEl("button", {
      type: "button",
      cls: "gamification-stepper-current-btn",
      text: "Текущий день",
    });
    currentDayBtn.addEventListener("click", () => {
      const [y, m, d] = this.maxKey.split("-").map(Number);
      this.year = y;
      this.month = m;
      this.day = d;
      this.refreshLabels();
    });

    const btnRow = this.contentEl.createDiv({ cls: "opa-daily-heading-date-buttons" });
    const cancelBtn = btnRow.createEl("button", { text: UI_LABELS.common.cancel, cls: "mod-secondary" });
    const okBtn = btnRow.createEl("button", { text: UI_LABELS.common.ok, cls: "mod-cta" });
    cancelBtn.addEventListener("click", () => this.close());
    okBtn.addEventListener("click", () => {
      const key = dateKeyFromParts(this.year, this.month, this.day);
      this.onSelect(clampToMax(key, this.maxKey));
      this.close();
    });

    this.contentEl.addEventListener("keydown", this.handleKeydown);
    setTimeout(() => dayStepper.focus(), 0);
  }

  onClose(): void {
    this.contentEl.removeEventListener("keydown", this.handleKeydown);
  }

  private handleKeydown = (e: KeyboardEvent): void => {
    const steppers = Array.from(
      this.contentEl.querySelectorAll<HTMLElement>(".opa-daily-heading-date-steppers .gamification-stepper-group")
    );
    if (steppers.length !== 3) return;

    if (e.key === "Enter" && steppers.includes(document.activeElement as typeof steppers[number])) {
      e.preventDefault();
      const key = dateKeyFromParts(this.year, this.month, this.day);
      this.onSelect(clampToMax(key, this.maxKey));
      this.close();
      return;
    }

    if (e.key === "Tab") {
      const idx = steppers.indexOf(document.activeElement as typeof steppers[number]);
      if (idx >= 0) {
        e.preventDefault();
        const next = e.shiftKey ? (idx - 1 + 3) % 3 : (idx + 1) % 3;
        steppers[next].focus();
      }
      return;
    }

    const focusedIdx = steppers.indexOf(document.activeElement as typeof steppers[number]);
    if (focusedIdx < 0) return;

    const delta = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    if (focusedIdx === 0) this.changeDay(delta);
    else if (focusedIdx === 1) this.changeMonth(delta);
    else this.changeYear(delta);
  };

  private refreshLabels(): void {
    this.dayEl.setText(String(this.day));
    this.monthEl.setText(MONTH_NAMES[this.month - 1] ?? "");
    this.yearEl.setText(String(this.year));
  }

  private clampDay(): void {
    const daysInMonth = getDaysInMonth(this.year, this.month);
    if (this.day > daysInMonth) this.day = daysInMonth;
    if (this.day < 1) this.day = 1;
    const key = dateKeyFromParts(this.year, this.month, this.day);
    const clamped = clampToMax(key, this.maxKey);
    const [y, m, d] = clamped.split("-").map(Number);
    this.year = y;
    this.month = m;
    this.day = d;
  }

  private changeDay(delta: number): void {
    this.day += delta;
    if (this.day < 1) {
      this.month--;
      if (this.month < 1) {
        this.month = 12;
        this.year--;
      }
      this.day = getDaysInMonth(this.year, this.month);
    } else {
      const daysInMonth = getDaysInMonth(this.year, this.month);
      if (this.day > daysInMonth) {
        this.day = 1;
        this.month++;
        if (this.month > 12) {
          this.month = 1;
          this.year++;
        }
      }
    }
    this.clampDay();
    this.refreshLabels();
  }

  private changeMonth(delta: number): void {
    this.month += delta;
    if (this.month > 12) {
      this.month = 1;
      this.year++;
    } else if (this.month < 1) {
      this.month = 12;
      this.year--;
    }
    const maxDay = getDaysInMonth(this.year, this.month);
    if (this.day > maxDay) this.day = maxDay;
    this.clampDay();
    this.refreshLabels();
  }

  private changeYear(delta: number): void {
    const [maxY] = this.maxKey.split("-").map(Number);
    this.year += delta;
    if (this.year > maxY) this.year = maxY;
    if (this.year < this.yearMin) this.year = this.yearMin;
    this.clampDay();
    this.refreshLabels();
  }
}

/** Модалка «Выбор активностей»: список активностей с отметкой за дату (дата задаётся в блоке «Активности»). */
class AllActivitiesModal extends Modal {
  private listWrap!: HTMLElement;
  /** Родитель списка с overflow-y: auto — сохраняем scrollTop при полной перерисовке строк. */
  private listScrollEl!: HTMLElement;
  private addInput!: HTMLInputElement;
  private searchInput!: HTMLInputElement;
  private searchFilter = "";

  constructor(
    app: import("obsidian").App,
    private data: ActivitiesData,
    /** Дата, за которую отмечаем активности (YYYY-MM-DD). Передаётся из блока. */
    private dateKey: string,
    private defaultDifficulty: string,
    private onToggle: (activityId: string, dateKey: string, isAdding: boolean) => Promise<void>,
    private getData: () => Promise<ActivitiesData>,
    private onAddActivity: (name: string) => Promise<boolean>,
    private onRemoveFromPool: (activityId: string) => Promise<void>,
    private onRenameActivity: (activityId: string, newName: string) => Promise<boolean>,
    private onDifficultyChange: (activityId: string, difficulty: string) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const L = UI_LABELS.activities;
    const common = UI_LABELS.common;
    this.titleEl.setText(L.allActivitiesTitle);
    this.contentEl.addClass("opa-all-activities-modal");
    this.modalEl.addClass("opa-all-activities-modal-wrap");

    const searchWrap = this.contentEl.createDiv({ cls: "opa-activities-search-wrap" });
    this.searchInput = searchWrap.createEl("input", {
      type: "text",
      cls: "opa-activities-search-input",
      attr: { placeholder: L.searchPlaceholder },
    });
    this.searchInput.addEventListener("input", () => {
      this.searchFilter = this.searchInput.value.trim().toLowerCase();
      this.renderList(this.data);
    });

    const scrollArea = this.contentEl.createDiv({ cls: "opa-all-activities-modal-scroll" });
    this.listScrollEl = scrollArea;
    this.listWrap = scrollArea.createDiv({ cls: "opa-activities-list opa-all-activities-list" });
    this.renderList(this.data);

    const poolSection = this.contentEl.createDiv({ cls: "opa-all-activities-pool-section" });
    poolSection.createEl("h4", { text: L.poolListTitle, cls: "opa-all-activities-subtitle" });
    const formWrap = poolSection.createDiv({ cls: "opa-activities-modal-form" });
    this.addInput = formWrap.createEl("input", {
      type: "text",
      cls: "opa-activities-input",
      attr: { placeholder: L.addPlaceholder },
    });
    const btnAdd = formWrap.createEl("button", { text: L.addActivity, cls: "mod-cta" });
    btnAdd.addEventListener("click", () => this.handleAdd());
    this.addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.handleAdd();
      }
    });

    const footer = this.contentEl.createDiv({ cls: "opa-all-activities-footer" });
    footer.createEl("button", { text: common.ok, cls: "mod-cta" }).addEventListener("click", () => this.close());
  }

  private async handleAdd(): Promise<void> {
    const name = this.addInput.value.trim();
    if (!name) return;
    const added = await this.onAddActivity(name);
    if (added) {
      this.addInput.value = "";
      this.addInput.focus();
      this.data = await this.getData();
      this.renderList(this.data);
    } else {
      new Notice("Такая активность уже есть");
    }
  }

  private renderList(data: ActivitiesData): void {
    const scrollTop = this.listScrollEl.scrollTop;
    this.listWrap.empty();
    const items = getItemsSortedForActivityPicker(data, this.dateKey).filter(
      (item) => !this.searchFilter || item.name.toLowerCase().includes(this.searchFilter)
    );
    for (const item of items) {
      const countOnDate = getCountOnDate(data.history, item.id, this.dateKey);
      const doneOnDate = countOnDate > 0;

      const row = this.listWrap.createEl("div", { cls: "opa-activity-row" });
      const checkWrap = row.createEl("label", { cls: "opa-activity-check-wrap" });
      const check = checkWrap.createEl("input", { type: "checkbox", cls: "opa-activity-check" });
      check.checked = doneOnDate;
      const nameSpan = checkWrap.createEl("span", { cls: "opa-activity-name", text: item.name });

      check.addEventListener("change", async () => {
        await this.onToggle(item.id, this.dateKey, check.checked);
        this.data = await this.getData();
        this.renderList(this.data);
      });

      const difficultyWrap = row.createEl("div", { cls: "opa-activity-difficulty-wrap" });
      const difficultySelect = difficultyWrap.createEl("select", { cls: "opa-activity-difficulty-select" });
      const currentDifficulty = item.difficulty ?? this.defaultDifficulty;
      for (const opt of ["легкая", "средняя", "сложная"] as const) {
        const option = difficultySelect.createEl("option", { value: opt, text: DIFFICULTY_DISPLAY_LABELS[opt] });
        if (opt === currentDifficulty) option.selected = true;
      }
      difficultySelect.addEventListener("change", async () => {
        const value = difficultySelect.value;
        await this.onDifficultyChange(item.id, value);
        this.data = await this.getData();
        this.renderList(this.data);
      });

      const actionsDiv = row.createEl("div", { cls: "opa-activity-row-actions" });

      const editBtn = actionsDiv.createEl("button", {
        text: UI_LABELS.common.edit,
        cls: "gamification-shop-modal-del",
        attr: { type: "button", "aria-label": "Переименовать" },
      });

      const delBtn = actionsDiv.createEl("button", {
        text: UI_LABELS.common.delete,
        cls: "gamification-shop-modal-del",
        attr: { type: "button", "aria-label": "Удалить из списка" },
      });

      // Логика удаления
      delBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await this.onRemoveFromPool(item.id);
        this.data = await this.getData();
        this.renderList(this.data);
      });

      // Логика редактирования (inline)
      editBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();

        row.addClass("is-editing");

        const editInput = row.createEl("input", { type: "text", cls: "view-input opa-activity-edit-input" });
        editInput.value = item.name;
        row.insertBefore(editInput, actionsDiv);

        const save = async () => {
          const newName = editInput.value.trim();
          if (newName && newName !== item.name) {
            const ok = await this.onRenameActivity(item.id, newName);
            if (ok) {
              item.name = newName;
              nameSpan.textContent = newName;
            } else {
              new Notice("Такая активность уже существует");
            }
          }
          cancel();
        };

        const cancel = () => {
          editInput.remove();
          row.removeClass("is-editing");
        };

        editInput.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            save();
          } else if (ev.key === "Escape") {
            ev.preventDefault();
            cancel();
          }
        });

        editInput.addEventListener("blur", () => save());
        editInput.focus();
      });
    }
    if (!data.items.length) {
      this.listWrap.createEl("p", { text: UI_LABELS.activities.empty, cls: "opa-activities-empty" });
    } else if (items.length === 0) {
      this.listWrap.createEl("p", { text: UI_LABELS.activities.searchNoResults, cls: "opa-activities-empty" });
    }
    requestAnimationFrame(() => {
      this.listScrollEl.scrollTop = scrollTop;
    });
  }
}

const STORAGE_PREFIX_STATS_EXPANDED = "opa-stats-expanded-";

function getStatsChartExpanded(activityId: string): boolean {
  try {
    return localStorage.getItem(STORAGE_PREFIX_STATS_EXPANDED + activityId) === "1";
  } catch {
    return false;
  }
}

function setStatsChartExpanded(activityId: string, expanded: boolean): void {
  try {
    if (expanded) localStorage.setItem(STORAGE_PREFIX_STATS_EXPANDED + activityId, "1");
    else localStorage.removeItem(STORAGE_PREFIX_STATS_EXPANDED + activityId);
  } catch {
    // ignore
  }
}

/** Модалка: только графики по активностям (сворачиваемые, по умолчанию свёрнуты). */
class ActivitiesStatisticsModal extends Modal {
  private resizeObservers: ResizeObserver[] = [];
  private statsScrollArea!: HTMLElement;
  private selectedYear!: number;
  private selectedMonth!: string;
  private chartRefs: { chartEl: HTMLElement; activityId: string }[] = [];
  private monthValueEl!: HTMLElement;
  private yearValueEl!: HTMLElement;

  constructor(
    app: import("obsidian").App,
    private data: ActivitiesData,
    private selectedActivityId?: string
  ) {
    super(app);
  }

  onClose(): void {
    this.resizeObservers.forEach((ro) => ro.disconnect());
    this.resizeObservers = [];
  }

  onOpen(): void {
    const L = UI_LABELS.activities;
    this.titleEl.setText(L.statsTitle);
    this.contentEl.addClass("opa-activities-stats-modal");
    this.modalEl.addClass("opa-stats-modal-wrap");

    const now = new Date();
    this.selectedYear = now.getFullYear();
    this.selectedMonth = String(now.getMonth() + 1).padStart(2, "0");
    const yearMin = 2010;
    const yearMax = now.getFullYear() + 5;

    const updateStepperLabels = (): void => {
      this.monthValueEl.setText(MONTH_NAMES[parseInt(this.selectedMonth, 10) - 1] ?? "");
      this.yearValueEl.setText(String(this.selectedYear));
    };

    const doChangeMonth = (delta: number): void => {
      const m = parseInt(this.selectedMonth, 10) + delta;
      if (m > 12) {
        this.selectedMonth = "01";
        if (this.selectedYear < yearMax) this.selectedYear++;
      } else if (m < 1) {
        this.selectedMonth = "12";
        if (this.selectedYear > yearMin) this.selectedYear--;
      } else {
        this.selectedMonth = String(m).padStart(2, "0");
      }
      updateStepperLabels();
      this.refreshCharts();
    };

    const doChangeYear = (delta: number): void => {
      this.selectedYear += delta;
      if (this.selectedYear < yearMin) this.selectedYear = yearMin;
      if (this.selectedYear > yearMax) this.selectedYear = yearMax;
      updateStepperLabels();
      this.refreshCharts();
    };

    const searchWrap = this.contentEl.createDiv({ cls: "opa-activities-search-wrap" });
    const searchInput = searchWrap.createEl("input", {
      type: "text",
      cls: "opa-activities-search-input",
      attr: { placeholder: L.searchPlaceholder },
    });
    searchInput.addEventListener("input", () => this.filterStatsBySearch(searchInput.value.trim().toLowerCase()));

    const scrollArea = this.contentEl.createDiv({ cls: "opa-stats-modal-scroll" });
    this.statsScrollArea = scrollArea;
    for (const item of this.data.items) {
      const section = scrollArea.createDiv({ cls: "opa-stats-activity-section" });
      section.dataset.activityName = item.name;
      section.dataset.activityId = item.id;
      const expanded = this.selectedActivityId === item.id || getStatsChartExpanded(item.id);
      if (this.selectedActivityId === item.id) {
        setStatsChartExpanded(item.id, true);
      }
      const header = section.createDiv({ cls: "opa-stats-activity-header" });
      const arrow = header.createSpan({ cls: "opa-stats-collapse-arrow" });
      arrow.setText(expanded ? "▼" : "▶");
      header.createEl("span", { text: item.name, cls: "opa-stats-activity-title" });
      const chartBody = section.createDiv({ cls: "opa-stats-chart-body" });
      chartBody.toggleClass("opa-hidden", !expanded);
      const chartWrap = chartBody.createDiv({ cls: "opa-stats-chart-wrap" });
      const chartEl = chartWrap.createDiv({ cls: "opa-stats-line-chart" });

      this.chartRefs.push({ chartEl, activityId: item.id });
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const w = entry.contentRect.width;
          const h = entry.contentRect.height > 0 ? entry.contentRect.height : 100;
          if (w > 0) {
            chartEl.empty();
            this.renderLineChart(chartEl, item.id, w, h, this.selectedYear, parseInt(this.selectedMonth, 10));
          }
        }
      });
      ro.observe(chartEl);
      this.resizeObservers.push(ro);

      header.addEventListener("click", () => {
        const isExpanded = !chartBody.hasClass("opa-hidden");
        chartBody.toggleClass("opa-hidden", isExpanded);
        arrow.setText(isExpanded ? "▶" : "▼");
        setStatsChartExpanded(item.id, !isExpanded);
      });
    }

    if (!this.data.items.length) {
      scrollArea.createEl("p", { text: L.empty, cls: "opa-activities-empty" });
    }

    if (this.selectedActivityId) {
      const section = scrollArea.querySelector<HTMLElement>(`.opa-stats-activity-section[data-activity-id="${this.selectedActivityId}"]`);
      section?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    const monthWrap = this.contentEl.createEl("div", { cls: "gamification-completed-month-wrap" });
    const monthGroup = monthWrap.createEl("div", { cls: "gamification-month-group" });
    const monthStepper = monthGroup.createEl("div", { cls: "gamification-stepper-group" });
    monthStepper.tabIndex = 0;
    const monthPrev = monthStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "‹" });
    this.monthValueEl = monthStepper.createEl("span", { cls: "gamification-stepper-value gamification-stepper-month" });
    const monthNext = monthStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "›" });
    const yearGroup = monthWrap.createEl("div", { cls: "gamification-month-group" });
    const yearStepper = yearGroup.createEl("div", { cls: "gamification-stepper-group" });
    yearStepper.tabIndex = 0;
    const yearPrev = yearStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "‹" });
    this.yearValueEl = yearStepper.createEl("span", { cls: "gamification-stepper-value" });
    const yearNext = yearStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "›" });
    monthPrev.addEventListener("click", () => doChangeMonth(-1));
    monthNext.addEventListener("click", () => doChangeMonth(1));
    yearPrev.addEventListener("click", () => doChangeYear(-1));
    yearNext.addEventListener("click", () => doChangeYear(1));
    const currentMonthBtn = monthWrap.createEl("button", {
      type: "button",
      cls: "gamification-stepper-current-btn",
      text: L.currentMonth,
    });
    currentMonthBtn.addEventListener("click", () => {
      this.selectedYear = now.getFullYear();
      this.selectedMonth = String(now.getMonth() + 1).padStart(2, "0");
      updateStepperLabels();
      this.refreshCharts();
    });
    const steppers = [monthStepper, yearStepper];
    const keydownHandler = (e: KeyboardEvent): void => {
      if (e.key === "Tab") {
        const idx = steppers.indexOf(document.activeElement as typeof steppers[number]);
        if (idx >= 0) {
          e.preventDefault();
          const next = e.shiftKey ? (idx - 1 + 2) % 2 : (idx + 1) % 2;
          steppers[next].focus();
        }
        return;
      }
      const focusedIdx = steppers.indexOf(document.activeElement as typeof steppers[number]);
      if (focusedIdx < 0) return;
      const delta = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
      if (delta === 0) return;
      e.preventDefault();
      if (focusedIdx === 0) doChangeMonth(delta);
      else doChangeYear(delta);
    };
    this.contentEl.addEventListener("keydown", keydownHandler);
    updateStepperLabels();

    const footer = this.contentEl.createDiv({ cls: "opa-stats-modal-footer" });
    const okBtn = footer.createEl("button", { text: "ОК", cls: "mod-cta" });
    okBtn.addEventListener("click", () => this.close());
  }

  private filterStatsBySearch(query: string): void {
    const sections = this.statsScrollArea.querySelectorAll<HTMLElement>(".opa-stats-activity-section");
    sections.forEach((section) => {
      const name = section.dataset.activityName?.toLowerCase() ?? "";
      section.toggleClass("opa-hidden", Boolean(query) && !name.includes(query));
    });
  }

  private refreshCharts(): void {
    for (const { chartEl, activityId } of this.chartRefs) {
      const rect = chartEl.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height > 0 ? rect.height : 100;
      if (w > 0) {
        chartEl.empty();
        this.renderLineChart(chartEl, activityId, w, h, this.selectedYear, parseInt(this.selectedMonth, 10));
      }
    }
  }

  private renderLineChart(
    container: HTMLElement,
    activityId: string,
    width: number,
    height: number,
    year: number,
    month: number
  ): void {
    const byDate = this.data.history[activityId] ?? {};
    const daysInMonth = getDaysInMonth(year, month);
    const points: { dateKey: string; value: number }[] = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const dateKey = dateKeyFromParts(year, month, day);
      points.push({ dateKey, value: byDate[dateKey] ?? 0 });
    }
    const maxVal = Math.max(1, ...points.map((p) => p.value));

    const w = Math.round(width);
    const h = Math.round(height);
    const padding = { top: 8, right: 4, bottom: 24, left: 16 };
    const chartWidth = w - padding.left - padding.right;
    const chartHeight = h - padding.top - padding.bottom;

    const xScale = (i: number) => padding.left + (i / (points.length - 1 || 1)) * chartWidth;
    const yScale = (v: number) => padding.top + chartHeight - (v / maxVal) * chartHeight;

    const pathD = points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(p.value)}`)
      .join(" ");

    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "opa-stats-chart-svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("aria-hidden", "true");
    container.appendChild(svg);

    const lineY = document.createElementNS(ns, "line");
    lineY.setAttribute("x1", String(padding.left));
    lineY.setAttribute("y1", String(padding.top));
    lineY.setAttribute("x2", String(padding.left));
    lineY.setAttribute("y2", String(padding.top + chartHeight));
    lineY.setAttribute("class", "opa-chart-axis");
    const lineX = document.createElementNS(ns, "line");
    lineX.setAttribute("x1", String(padding.left));
    lineX.setAttribute("y1", String(padding.top + chartHeight));
    lineX.setAttribute("x2", String(padding.left + chartWidth));
    lineX.setAttribute("y2", String(padding.top + chartHeight));
    lineX.setAttribute("class", "opa-chart-axis");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", pathD);
    path.setAttribute("fill", "none");
    path.setAttribute("class", "opa-chart-line");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke", "currentColor");

    svg.appendChild(lineY);
    svg.appendChild(lineX);
    svg.appendChild(path);

    const today = new Date();
    if (today.getFullYear() === year && today.getMonth() + 1 === month) {
      const todayIdx = today.getDate() - 1;
      if (todayIdx >= 0 && todayIdx < points.length) {
        const tx = Math.round(xScale(todayIdx));
        const todayLine = document.createElementNS(ns, "line");
        todayLine.setAttribute("x1", String(tx));
        todayLine.setAttribute("x2", String(tx));
        todayLine.setAttribute("y1", String(padding.top));
        todayLine.setAttribute("y2", String(padding.top + chartHeight));
        todayLine.setAttribute("class", "opa-chart-today-line");
        svg.appendChild(todayLine);
      }
    }

    const formatDayOnly = (s: string) => (s ? String(parseInt(s.slice(8, 10), 10)) : "");
    const yMax = document.createElementNS(ns, "text");
    yMax.setAttribute("x", String(padding.left - 6));
    yMax.setAttribute("y", String(padding.top + 4));
    yMax.setAttribute("text-anchor", "end");
    yMax.setAttribute("class", "opa-chart-label");
    yMax.textContent = String(maxVal);
    const y0 = document.createElementNS(ns, "text");
    y0.setAttribute("x", String(padding.left - 6));
    y0.setAttribute("y", String(padding.top + chartHeight + 4));
    y0.setAttribute("text-anchor", "end");
    y0.setAttribute("class", "opa-chart-label");
    y0.textContent = "0";

    svg.appendChild(yMax);
    svg.appendChild(y0);

    // Подписи дней по ширине: короткий текст (только число) — можно плотнее, чем DD.MM
    const minPxPerXLabel = 14;
    const maxLabels = Math.min(
      points.length,
      Math.max(8, Math.floor(chartWidth / minPxPerXLabel))
    );
    const labelStep = Math.max(1, Math.ceil((points.length - 1) / Math.max(1, maxLabels - 1)));

    for (let i = 0; i < points.length; i++) {
      const isFirst = i === 0;
      const isLast = i === points.length - 1;
      const isStep = i % labelStep === 0;
      // Не рисуем промежуточную подпись, если она слишком близко к последней дате
      const isTooCloseToEnd = !isLast && (points.length - 1 - i < labelStep * 0.6);

      if (isFirst || isLast || (isStep && !isTooCloseToEnd)) {
        const xPos = Math.round(xScale(i));

        // Засечка на оси
        const tick = document.createElementNS(ns, "line");
        tick.setAttribute("x1", String(xPos));
        tick.setAttribute("y1", String(padding.top + chartHeight));
        tick.setAttribute("x2", String(xPos));
        tick.setAttribute("y2", String(padding.top + chartHeight + 4));
        tick.setAttribute("class", "opa-chart-axis");
        svg.appendChild(tick);

        // Текст даты
        const xText = document.createElementNS(ns, "text");
        xText.setAttribute("x", String(xPos));
        xText.setAttribute("y", String(h - 4));

        if (isFirst) {
          xText.setAttribute("text-anchor", "start");
        } else if (isLast) {
          xText.setAttribute("text-anchor", "end");
        } else {
          xText.setAttribute("text-anchor", "middle");
        }

        xText.setAttribute("class", "opa-chart-label");
        xText.textContent = formatDayOnly(points[i]?.dateKey ?? "");
        svg.appendChild(xText);
      }
    }
  }
}
