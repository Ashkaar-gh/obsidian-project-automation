/**
 * Модуль «Пул активностей» (Logbook): блок opa-activities-view на домашней странице.
 * Список дел с отметкой «когда делалось в последний раз», модалка со статистикой (сетка месяца).
 */

import type { ModuleContext } from "./types";
import {
  readDataFile,
  writeDataFile,
  getRewardForDifficulty,
  isActivityDifficulty,
  ACTIVITY_DIFFICULTY_REWARDS_DEFAULT,
  DIFFICULTY_DISPLAY_LABELS,
  type ActivitiesData,
  type ActivityItem,
} from "../core/GamificationState";
import { UI_LABELS } from "../ui/Labels";
import { createCollapsibleSection } from "../ui/CollapsibleSection";
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

function getDisplayTextForLastDone(lastDate: string | null, todayKey: string): string {
  const L = UI_LABELS.activities;
  if (!lastDate) return L.never;
  if (lastDate === todayKey) return L.doneToday;

  const today = new Date(todayKey);
  const last = new Date(lastDate);
  const todayStart = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const lastStart = Date.UTC(last.getFullYear(), last.getMonth(), last.getDate());
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

/** Активности, отсортированные по убыванию частоты (самые частые сверху). */
function getItemsSortedByFrequency(data: ActivitiesData): ActivityItem[] {
  return [...data.items].sort(
    (a, b) => getTotalCount(data.history, b.id) - getTotalCount(data.history, a.id)
  );
}

/** Интервал проверки смены дня (мс). При наступлении 00:00 вид перерисуется без перезапуска. */
const DAY_CHECK_INTERVAL_MS = 60 * 1000;

export class ActivitiesModule {
  private ctx: ModuleContext;
  private blocks = new Set<{ el: HTMLElement; refresh: () => void }>();
  private lastTodayKey: string = getTodayKey();
  private dayCheckInterval: ReturnType<typeof setInterval> | null = null;
  /** Выбранная дата для отображения и редактирования активностей (по умолчанию — сегодня). */
  private selectedDateKey: string = getTodayKey();

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
  }

  load(): void {
    this.ctx.app.vault.on("modify", this.onDataChange);
    this.lastTodayKey = getTodayKey();
    this.dayCheckInterval = setInterval(() => this.checkDayChange(), DAY_CHECK_INTERVAL_MS);

    this.ctx.plugin.registerMarkdownCodeBlockProcessor("opa-activities-view", (_source, el) => {
      el.addClass("opa-activities-view");
      this.blocks.forEach((b) => {
        if (b.el === el) this.blocks.delete(b);
      });
      const refresh = () => this.render(el);
      this.blocks.add({ el, refresh });
      this.render(el);
    });
  }

  private onDataChange = (file: { path: string }): void => {
    if (file.path !== this.ctx.plugin.getGamificationDataPath()) return;
    this.runRefresh();
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
    this.blocks.forEach((b) => b.refresh());
  }

  unload(): void {
    this.ctx.app.vault.off("modify", this.onDataChange);
    if (this.dayCheckInterval !== null) {
      clearInterval(this.dayCheckInterval);
      this.dayCheckInterval = null;
    }
    this.blocks.clear();
  }

  updateState(): void {
    setTimeout(() => this.runRefresh(), 50);
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

  /** Установить количество выполнений за день. Награда начисляется за каждое новое выполнение (каждый +1). */
  private async setCount(activityId: string, dateKey: string, count: number): Promise<void> {
    const data = await this.getActivitiesData();
    const byDate = { ...(data.history[activityId] ?? {}) };
    if (count <= 0) {
      delete byDate[dateKey];
    } else {
      byDate[dateKey] = count;
    }
    const history = { ...data.history, [activityId]: byDate };
    let rewardsGiven = { ...(data.rewardsGiven ?? {}) };
    const byDateRewards = { ...(rewardsGiven[activityId] ?? {}) };
    const alreadyGiven = byDateRewards[dateKey] ?? 0;
    const toGive = Math.max(0, count - alreadyGiven);
    if (toGive > 0 && this.ctx.plugin.settings.enableGamification) {
      const activity = data.items.find((i) => i.id === activityId);
      const activityDefault = this.ctx.plugin.settings.gamificationActivityDefaultDifficulty ?? "легкая";
      const difficulty = activity?.difficulty ?? activityDefault;
      const rewardsMap = this.ctx.plugin.settings.gamificationActivityDifficultyRewards ?? ACTIVITY_DIFFICULTY_REWARDS_DEFAULT;
      const reward = getRewardForDifficulty(difficulty, {
        difficultyRewards: rewardsMap,
        defaultDifficulty: activityDefault,
      });
      const state = await this.ctx.plugin.getGamificationState();
      state.xp += reward.xp * toGive;
      state.gold += reward.gold * toGive;
      this.ctx.plugin.scheduleGamificationSave();
      if (toGive === 1) {
        new Notice(UI_LABELS.gamification.rewardLine(reward.xp, reward.gold));
      } else {
        new Notice(UI_LABELS.gamification.rewardLine(reward.xp * toGive, reward.gold * toGive));
      }
    }
    if (count > 0) {
      byDateRewards[dateKey] = Math.max(alreadyGiven, count);
      rewardsGiven[activityId] = byDateRewards;
    }
    /* При count === 0 не трогаем rewardsGiven: если потом снова добавят активность в тот же день, награду не даём повторно */
    await writeDataFile(this.ctx.plugin, { activities: { ...data, history, rewardsGiven } });
    this.runRefresh();
    this.ctx.plugin.gamification?.updateState?.();
  }

  private async toggleCompletion(activityId: string, dateKey: string, isAdding: boolean): Promise<void> {
    await this.setCount(activityId, dateKey, isAdding ? 1 : 0);
  }

  private async render(container: HTMLElement): Promise<void> {
    if (!this.ctx.plugin.settings.enableActivities) {
      container.empty();
      container.style.display = "none";
      return;
    }
    container.style.display = "";

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

          const updateCount = (newCount: number) => {
            this.setCount(item.id, this.selectedDateKey, newCount).then(() => {});
          };
          btnPlus.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            updateCount(count + 1);
          });
          btnMinus.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (count > 1) updateCount(count - 1);
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

  private async removeActivity(activityId: string, current: ActivitiesData): Promise<void> {
    const items = current.items.filter((i) => i.id !== activityId);
    const history = { ...current.history };
    delete history[activityId];
    const rewardsGiven = { ...(current.rewardsGiven ?? {}) };
    delete rewardsGiven[activityId];
    await writeDataFile(this.ctx.plugin, { activities: { ...current, items, history, rewardsGiven } });
    this.runRefresh();
  }

  /** Добавить активность в пул (название); в список без отметки «сделано сегодня». */
  async addActivityToPool(name: string): Promise<boolean> {
    const currentData = await this.getActivitiesData();
    const trimmed = name.trim();
    if (!trimmed) return false;
    if (currentData.items.some((i) => i.name === trimmed)) return false;
    const id = nextActivityId(currentData.items);
    const defaultDiff = (this.ctx.plugin.settings.gamificationActivityDefaultDifficulty ?? "легкая") as ActivityItem["difficulty"];
    const items = [...currentData.items, { id, name: trimmed, difficulty: defaultDiff }];
    await writeDataFile(this.ctx.plugin, { activities: { ...currentData, items } });
    new Notice(`Добавлено: ${trimmed}`);
    this.runRefresh();
    return true;
  }

  /** Установить сложность активности. */
  async setActivityDifficulty(activityId: string, difficulty: string): Promise<void> {
    if (!isActivityDifficulty(difficulty)) return;
    const data = await this.getActivitiesData();
    const item = data.items.find((i) => i.id === activityId);
    if (!item) return;
    const next = data.items.map((i) => (i.id === activityId ? { ...i, difficulty } : i));
    await writeDataFile(this.ctx.plugin, { activities: { ...data, items: next } });
    this.runRefresh();
  }

  /** Переименовать активность в пуле */
  async renameActivity(activityId: string, newName: string): Promise<boolean> {
    const currentData = await this.getActivitiesData();
    const trimmed = newName.trim();
    if (!trimmed) return false;

    // Защита от дубликатов
    if (currentData.items.some((i) => i.id !== activityId && i.name === trimmed)) {
      return false;
    }

    const items = currentData.items.map((i) =>
      i.id === activityId ? { ...i, name: trimmed } : i
    );

    await writeDataFile(this.ctx.plugin, { activities: { ...currentData, items } });
    this.runRefresh();
    return true;
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
      async (activityId) => {
        const current = await this.getActivitiesData();
        await this.removeActivity(activityId, current);
      },
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

    if (e.key === "Enter" && steppers.includes(document.activeElement as HTMLElement)) {
      e.preventDefault();
      const key = dateKeyFromParts(this.year, this.month, this.day);
      this.onSelect(clampToMax(key, this.maxKey));
      this.close();
      return;
    }

    if (e.key === "Tab") {
      const idx = steppers.indexOf(document.activeElement as HTMLElement);
      if (idx >= 0) {
        e.preventDefault();
        const next = e.shiftKey ? (idx - 1 + 3) % 3 : (idx + 1) % 3;
        steppers[next].focus();
      }
      return;
    }

    const focusedIdx = steppers.indexOf(document.activeElement as HTMLElement);
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
    this.modalEl.style.width = "560px";
    this.modalEl.style.maxWidth = "92vw";

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
    this.listWrap.empty();
    const items = getItemsSortedByFrequency(data).filter(
      (item) => !this.searchFilter || item.name.toLowerCase().includes(this.searchFilter)
    );
    for (const item of items) {
      const countOnDate = (data.history[item.id] ?? {})[this.dateKey] ?? 0;
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

        checkWrap.style.display = "none";
        actionsDiv.style.display = "none";

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
          checkWrap.style.display = "";
          actionsDiv.style.display = "";
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
      if (!expanded) chartBody.style.display = "none";
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
        const isExpanded = chartBody.style.display !== "none";
        chartBody.style.display = isExpanded ? "none" : "";
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
        const idx = steppers.indexOf(document.activeElement as HTMLElement);
        if (idx >= 0) {
          e.preventDefault();
          const next = e.shiftKey ? (idx - 1 + 2) % 2 : (idx + 1) % 2;
          steppers[next].focus();
        }
        return;
      }
      const focusedIdx = steppers.indexOf(document.activeElement as HTMLElement);
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
      section.style.display = !query || name.includes(query) ? "" : "none";
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

    const formatShort = (s: string) => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)}` : "");
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

    // 2. Равномерное распределение подписей по оси X
    // Целимся максимум в 6 подписей, чтобы они не наезжали друг на друга при сжатии
    const maxLabels = 6;
    const labelStep = Math.max(1, Math.floor((points.length - 1) / (maxLabels - 1)));

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
        xText.textContent = formatShort(points[i]?.dateKey ?? "");
        svg.appendChild(xText);
      }
    }
  }
}
