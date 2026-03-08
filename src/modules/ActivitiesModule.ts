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

      const todayItems = getItemsSortedByFrequency(data)
        .map((item) => ({ item, count: this.getCount(data, item.id, todayKey) }))
        .filter(({ count }) => count > 0);
      if (!todayItems.length) {
        body.createEl("p", { text: L.emptyToday, cls: "opa-activities-empty" });
      } else {
        const listWrap = body.createEl("div", { cls: "opa-activities-list" });
        for (const { item, count } of todayItems) {
          const row = listWrap.createEl("div", { cls: "opa-activity-row" });
          row.createEl("span", { cls: "opa-activity-name", text: item.name });

          const counterWrap = row.createDiv({ cls: "opa-activity-counter" });
          const btnPlus = counterWrap.createEl("button", { cls: "opa-activity-counter-btn", attr: { type: "button", "aria-label": "Увеличить" } });
          btnPlus.setText("+");
          const countSpan = counterWrap.createEl("span", { cls: "opa-activity-counter-value" });
          countSpan.setText(String(count));
          const btnMinus = counterWrap.createEl("button", { cls: "opa-activity-counter-btn", attr: { type: "button", "aria-label": "Уменьшить" } });
          btnMinus.setText("−");

          const updateCount = (newCount: number) => {
            this.setCount(item.id, todayKey, newCount).then(() => {});
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
            attr: { type: "button", "aria-label": "Убрать из сегодня" },
          });
          uncheckBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await this.setCount(item.id, todayKey, 0);
          });
        }
      }

      const actions = body.createEl("div", { cls: "opa-activities-actions" });
      const btnAll = actions.createEl("button", { text: L.allActivities, cls: "opa-activities-btn view-btn" });
      const btnCharts = actions.createEl("button", { text: L.charts, cls: "opa-activities-btn view-btn" });
      btnAll.addEventListener("click", () => this.openAllActivitiesModal());
      btnCharts.addEventListener("click", () => this.openStatisticsModal());
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
    const todayKey = getTodayKey();
    new AllActivitiesModal(
      this.ctx.app,
      data,
      todayKey,
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

  private async openStatisticsModal(): Promise<void> {
    const data = await this.getActivitiesData();
    new ActivitiesStatisticsModal(this.ctx.app, data).open();
  }
}

/** Модалка «Выбор активностей»: создать список возможных активностей, затем отметить сделанные сегодня. */
class AllActivitiesModal extends Modal {
  private listWrap!: HTMLElement;
  private addInput!: HTMLInputElement;

  constructor(
    app: import("obsidian").App,
    private data: ActivitiesData,
    private todayKey: string,
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

    this.contentEl.createEl("h4", { text: L.selectTodayTitle, cls: "opa-all-activities-subtitle" });
    this.listWrap = this.contentEl.createDiv({ cls: "opa-activities-list opa-all-activities-list" });
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
    for (const item of getItemsSortedByFrequency(data)) {
      const countToday = (data.history[item.id] ?? {})[this.todayKey] ?? 0;
      const doneToday = countToday > 0;

      const row = this.listWrap.createEl("div", { cls: "opa-activity-row" });
      const checkWrap = row.createEl("label", { cls: "opa-activity-check-wrap" });
      const check = checkWrap.createEl("input", { type: "checkbox", cls: "opa-activity-check" });
      check.checked = doneToday;
      const nameSpan = checkWrap.createEl("span", { cls: "opa-activity-name", text: item.name });

      check.addEventListener("change", async () => {
        await this.onToggle(item.id, this.todayKey, check.checked);
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

  constructor(
    app: import("obsidian").App,
    private data: ActivitiesData
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

    for (const item of this.data.items) {
      const section = this.contentEl.createDiv({ cls: "opa-stats-activity-section" });
      const expanded = getStatsChartExpanded(item.id);
      const header = section.createDiv({ cls: "opa-stats-activity-header" });
      const arrow = header.createSpan({ cls: "opa-stats-collapse-arrow" });
      arrow.setText(expanded ? "▼" : "▶");
      header.createEl("span", { text: item.name, cls: "opa-stats-activity-title" });
      const chartBody = section.createDiv({ cls: "opa-stats-chart-body" });
      if (!expanded) chartBody.style.display = "none";
      const chartWrap = chartBody.createDiv({ cls: "opa-stats-chart-wrap" });
      const chartEl = chartWrap.createDiv({ cls: "opa-stats-line-chart" });

      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const w = entry.contentRect.width;
          const h = entry.contentRect.height > 0 ? entry.contentRect.height : 100;
          if (w > 0) {
            chartEl.empty();
            this.renderLineChart(chartEl, item.id, w, h);
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
      this.contentEl.createEl("p", { text: L.empty, cls: "opa-activities-empty" });
    }

    const footer = this.contentEl.createDiv({ cls: "opa-stats-modal-footer" });
    const okBtn = footer.createEl("button", { text: "ОК", cls: "mod-cta" });
    okBtn.addEventListener("click", () => this.close());
  }

  private renderLineChart(container: HTMLElement, activityId: string, width: number, height: number): void {
    const byDate = this.data.history[activityId] ?? {};

    // 1. Динамический диапазон (от первой отметки, но минимум 7 дней и максимум 30)
    let days = 30;
    const dateKeys = Object.keys(byDate).sort();
    if (dateKeys.length > 0) {
      const firstDate = new Date(dateKeys[0]);
      const today = new Date();
      const firstUTC = Date.UTC(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
      const todayUTC = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
      const diffDays = Math.floor((todayUTC - firstUTC) / (24 * 60 * 60 * 1000)) + 1;
      days = Math.max(7, Math.min(30, diffDays));
    } else {
      days = 7;
    }

    const points: { dateKey: string; value: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
