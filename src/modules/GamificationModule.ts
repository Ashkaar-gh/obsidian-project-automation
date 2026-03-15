import type { ModuleContext } from "./types";
import { eventBus } from "../core/EventBus";
import {
  getLevel,
  getXpForLevel,
  getXpInCurrentLevel,
  getXpPerLevel,
  getRank,
  getRewardForDifficulty,
  type GamificationState,
  type PurchaseRecord,
} from "../core/GamificationState";
import { UI_LABELS } from "../ui/Labels";
import { createCollapsibleSection } from "../ui/CollapsibleSection";
import { Modal, Notice, TFile } from "obsidian";

/** Формат даты из frontmatter в DD-MM-YYYY (как на доске задач). */
function formatDeadlineDisplay(raw: string): string {
  const s = raw.trim();
  const yyyyMmDd = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (yyyyMmDd) return `${yyyyMmDd[3]}-${yyyyMmDd[2]}-${yyyyMmDd[1]}`;
  const ddMmYyyy = /^(\d{2})-(\d{2})-(\d{4})/.exec(s);
  if (ddMmYyyy) return `${ddMmYyyy[1]}-${ddMmYyyy[2]}-${ddMmYyyy[3]}`;
  const ddMmYyyyDot = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
  if (ddMmYyyyDot) return `${ddMmYyyyDot[1]}-${ddMmYyyyDot[2]}-${ddMmYyyyDot[3]}`;
  return s;
}

function getDeadlineForTask(
  app: { vault: { getAbstractFileByPath: (p: string) => unknown }; metadataCache: { getFileCache: (f: TFile) => { frontmatter?: { date?: unknown } } | null } },
  path: string,
  savedDeadline: string | undefined
): string {
  if (savedDeadline && savedDeadline.trim()) return formatDeadlineDisplay(savedDeadline);
  const file = app.vault.getAbstractFileByPath(path);
  if (!file || !(file instanceof TFile)) return "—";
  const cache = app.metadataCache.getFileCache(file);
  const d = cache?.frontmatter?.date;
  if (d == null) return "—";
  const str = Array.isArray(d) ? d[0] : d;
  if (typeof str !== "string") return "—";
  return formatDeadlineDisplay(str);
}

export class GamificationModule {
  private ctx: ModuleContext;
  private blocks = new Set<{ el: HTMLElement; refresh: () => void }>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private offCompleted: (() => void) | null = null;
  private offUncompleted: (() => void) | null = null;

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
  }

  private onVaultModify = (file: import("obsidian").TAbstractFile): void => {
    if (file.path === this.ctx.plugin.getGamificationDataPath()) this.scheduleRefresh();
  };

  load(): void {
    this.offCompleted = this.ctx.eventBus.on("task:completed", async (data) => {
      if (!this.ctx.plugin.settings.enableGamification) return;
      const state = await this.ctx.plugin.getGamificationState();
      const L = UI_LABELS.gamification;

      if (state.processedTaskPaths.includes(data.path)) {
        const existingTask = state.processedTasks.find((t) => t.path === data.path);
        if (existingTask) {
          existingTask.rewardMessage = L.rewardsReceived;
          existingTask.completedAt = new Date().toISOString();
          this.ctx.plugin.scheduleGamificationSave();
          setTimeout(() => this.runRefresh(), 50);
        }
        return;
      }

      const reward = getRewardForDifficulty(data.difficulty, this.ctx.plugin.gamificationDefaults);
      state.xp += reward.xp;
      state.gold += reward.gold;
      state.processedTaskPaths.push(data.path);
      const taskName = data.path.split("/").pop()?.replace(/\.md$/i, "") ?? data.path;
      let deadline: string | undefined;
      const file = this.ctx.app.vault.getAbstractFileByPath(data.path);
      if (file && "path" in file) {
        const cache = this.ctx.app.metadataCache.getFileCache(file as import("obsidian").TFile);
        const fm = cache?.frontmatter;
        if (fm?.date != null) {
          const d = Array.isArray(fm.date) ? fm.date[0] : fm.date;
          deadline = typeof d === "string" ? d : undefined;
        }
      }
      const completedAt = new Date().toISOString();
      state.processedTasks.push({
        path: data.path,
        completedAt,
        taskName,
        deadline,
        rewardXp: reward.xp,
        rewardGold: reward.gold,
        rewardMessage: L.rewardsReceived,
      });
      this.ctx.plugin.scheduleGamificationSave();
      new Notice(L.rewardLine(reward.xp, reward.gold));
      setTimeout(() => this.runRefresh(), 50);
    });

    this.offUncompleted = this.ctx.eventBus.on("task:uncompleted", async (data) => {
      if (!this.ctx.plugin.settings.enableGamification) return;
      const state = await this.ctx.plugin.getGamificationState();
      const L = UI_LABELS.gamification;
      if (state.processedTaskPaths.includes(data.path)) {
        const existingTask = state.processedTasks.find((t) => t.path === data.path);
        if (existingTask) {
          existingTask.rewardMessage = L.returnedToWork;
          this.ctx.plugin.scheduleGamificationSave();
          setTimeout(() => this.runRefresh(), 50);
        }
      }
    });

    this.ctx.app.vault.on("modify", this.onVaultModify);
    this.ctx.app.workspace.on("active-leaf-change", this.scheduleRefresh);

    this.ctx.plugin.registerMarkdownCodeBlockProcessor("opa-gamification-view", (_source, el) => {
      el.addClass("opa-gamification-view");
      this.blocks.forEach((b) => { if (b.el === el) this.blocks.delete(b); });
      const refresh = () => this.render(el);
      this.blocks.add({ el, refresh });
      this.render(el);
    });
  }

  /** Есть ли хотя бы один блок геймификации в активной вкладке. */
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
    if (!this.ctx.plugin.settings.enableGamification) return;
    if (!this.isAnyBlockVisible()) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.runRefresh();
    }, 500);
  };

  unload(): void {
    this.offCompleted?.();
    this.offUncompleted?.();
    this.ctx.app.vault.off("modify", this.onVaultModify);
    this.ctx.app.workspace.off("active-leaf-change", this.scheduleRefresh);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.blocks.clear();
  }

  updateState(): void {
    setTimeout(() => this.runRefresh(), 50);
  }

  private async render(container: HTMLElement): Promise<void> {
    if (!this.ctx.plugin.settings.enableGamification) {
      container.empty();
      container.style.display = "none";
      return;
    }
    container.style.display = "";

    const scrollableParent = container.closest(".cm-scroller, .markdown-reading-view, .markdown-preview-view") as HTMLElement | null;
    const scrollTop = scrollableParent?.scrollTop ?? 0;

    const L = (UI_LABELS as { gamification?: { levelLabel?: string; shopTitle?: string } }).gamification;

    try {
      let state: GamificationState;
      try {
        state = await this.ctx.plugin.getGamificationState();
      } catch {
        state = { xp: 0, gold: 0, processedTaskPaths: [], processedTasks: [], streaks: {}, purchaseHistory: [], shop: [] };
      }
      const defaultShop = this.ctx.plugin.gamificationDefaults.defaultShop;
      if ((!state.shop || state.shop.length === 0) && defaultShop?.length) {
        state.shop = [...defaultShop];
        this.ctx.plugin.scheduleGamificationSave();
      }

      container.empty();
      const body = createCollapsibleSection(container, "Прогресс", "gamification");

      const cfg = this.ctx.plugin.gamificationDefaults;
      const level = getLevel(state.xp, cfg.xpLevelBase);
      const rank = getRank(level);
      const xpInLevel = getXpInCurrentLevel(state.xp, cfg.xpLevelBase);
      const xpPerLevel = getXpPerLevel(state.xp, cfg.xpLevelBase);
      const pct = xpPerLevel > 0 ? Math.min(100, (xpInLevel / xpPerLevel) * 100) : 0;

      const wrap = body.createEl("div", { cls: "gamification-dashboard" });

      const levelRow = wrap.createEl("div", { cls: "opa-gamification-header" });
      levelRow.createEl("span", {
        text: `${L.levelLabel} ${rank.icon} ${level} (${rank.name})`,
        cls: "opa-gamification-level",
      });
      const goldRow = wrap.createEl("div", { cls: "gamification-gold" });
      goldRow.createEl("span", { text: `🪙 ${state.gold} ${L.gold}` });

      const xpWrap = wrap.createEl("div", { cls: "gamification-xp-wrap" });
      const xpBar = xpWrap.createEl("div", { cls: "gamification-xp-bar" });
      xpBar.style.width = `${pct}%`;
      const xpLabel = wrap.createEl("div", { cls: "gamification-xp-label" });
      xpLabel.setText(L.xpToLevel(Math.round(xpInLevel), Math.round(xpPerLevel), level + 1));

      const buttonsRow = wrap.createEl("div", { cls: "gamification-buttons-row" });
      const btnCompleted = buttonsRow.createEl("button", { text: L.completed, cls: "view-btn" });
      btnCompleted.addEventListener("click", () => this.openCompletedModal(state));
      const btnStreaks = buttonsRow.createEl("button", { text: L.streaks, cls: "view-btn" });
      btnStreaks.addEventListener("click", () => this.openStreaksModal(state));

      const shopWrap = wrap.createEl("div", { cls: "gamification-shop" });
      const shopBody = createCollapsibleSection(shopWrap, L.shopTitle, "gamification-shop", { useTextArrow: true });
      const shopTabs = shopBody.createEl("div", { cls: "gamification-buttons-row" });
      shopTabs.style.marginTop = "0.5rem";
      const btnManage = shopTabs.createEl("button", { text: L.management, cls: "view-btn" });
      btnManage.addEventListener("click", () => this.openShopManageModal(state));
      const btnPurchased = shopTabs.createEl("button", { text: L.purchased, cls: "view-btn" });
      btnPurchased.addEventListener("click", () => this.openPurchasedModal(state));

      const shopTable = shopBody.createEl("table", { cls: "gamification-shop-table" });
      const thead = shopTable.createEl("thead").createEl("tr");
      thead.createEl("th", { text: L.name, cls: "gamification-shop-th-name" });
      thead.createEl("th", { text: L.price, cls: "gamification-shop-th-cost" });
      thead.createEl("th", { text: " ", cls: "gamification-shop-th-action" });
      const tbody = shopTable.createEl("tbody");
      if (state.shop && state.shop.length > 0) {
        for (const item of state.shop) {
          const tr = tbody.createEl("tr", { cls: "gamification-shop-item" });
          tr.createEl("td", { text: item.name, cls: "gamification-shop-name" });
          tr.createEl("td", { text: `${item.cost} ${L.gold}`, cls: "gamification-shop-cost" });
          const act = tr.createEl("td", { cls: "gamification-shop-action" });
          const buyBtn = act.createEl("button", { text: L.buy, cls: "view-btn gamification-shop-btn" });
          buyBtn.addEventListener("click", () => this.buyShopItem(item, state));
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
      container.createEl("p", { text: "Ошибка геймификации", cls: "view-error" });
      console.error(e);
    }
  }

  private openCompletedModal(state: GamificationState): void {
    const L = UI_LABELS.gamification;
    const app = this.ctx.app;
    const modal = new Modal(app);
    modal.modalEl.addClass("gamification-completed-modal");
    modal.modalEl.addClass("opa-gamification-modal");
    modal.titleEl.setText(L.completed);
    modal.contentEl.addClass("gamification-completed-content");
    const tasks = [...state.processedTasks].sort(
      (a, b) => new Date(b.completedAt ?? 0).getTime() - new Date(a.completedAt ?? 0).getTime()
    );
    const formatDate = (iso: string | null | undefined) => {
      if (!iso) return "—";
      const d = new Date(iso);
      return `${d.getDate().toString().padStart(2, "0")}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d.getFullYear()}`;
    };
    const monthKey = (iso: string | null | undefined): string | null => {
      if (!iso) return null;
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    };
    const monthNames = [
      "январь", "февраль", "март", "апрель", "май", "июнь",
      "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
    ];
    const now = new Date();
    const currentYear = now.getFullYear();
    let selectedYear = currentYear;
    let selectedMonth = String(now.getMonth() + 1).padStart(2, "0");
    const yearMin = 2010;
    const yearMax = currentYear + 5;

    const list = modal.contentEl.createEl("div", { cls: "gamification-completed-tasks gamification-completed-tasks-list" });
    const header = list.createEl("div", { cls: "gamification-completed-task-row gamification-completed-task-header" });
    header.createEl("div", { text: L.task, cls: "gamification-completed-task-link" });
    header.createEl("div", { text: L.deadline, cls: "gamification-completed-task-date" });
    header.createEl("div", { text: L.completedOn, cls: "gamification-completed-task-done" });
    header.createEl("div", { text: L.reward, cls: "gamification-completed-task-reward" });
    const body = list.createEl("div", { cls: "gamification-completed-tasks-body" });

    const renderTasksForMonth = (): void => {
      body.empty();
      const key = `${selectedYear}-${selectedMonth}`;
      const filtered = tasks.filter((t) => monthKey(t.completedAt) === key);
      if (filtered.length === 0) {
        body.createEl("p", {
          text: tasks.length === 0 ? UI_LABELS.common.empty : "В выбранном месяце задач нет.",
          cls: "gamification-completed-empty",
        });
      } else {
        for (const t of filtered) {
          const row = body.createEl("div", { cls: "gamification-completed-task-row" });
          const link = row.createEl("a", { cls: "gamification-completed-task-link", href: t.path });
          link.setText(t.taskName ?? t.path);
          link.addEventListener("click", (e) => {
            e.preventDefault();
            app.workspace.openLinkText(t.path, "", false);
            modal.close();
          });
          row.createEl("div", { text: getDeadlineForTask(app, t.path, t.deadline), cls: "gamification-completed-task-date" });
          row.createEl("div", { text: formatDate(t.completedAt), cls: "gamification-completed-task-done" });
          const rewardEl = row.createEl("div", { cls: "gamification-completed-task-reward" });
          if (t.rewardXp != null && t.rewardGold != null) {
            rewardEl.createEl("span", { cls: "gamification-completed-reward-text", text: L.rewardLine(t.rewardXp, t.rewardGold) });
            if (t.rewardMessage) rewardEl.createEl("div", { cls: "gamification-completed-back-in-work", text: t.rewardMessage });
          } else rewardEl.setText("—");
        }
      }
    };

    const monthWrap = modal.contentEl.createEl("div", { cls: "gamification-completed-month-wrap" });
    const monthGroup = monthWrap.createEl("div", { cls: "gamification-month-group" });
    const monthStepper = monthGroup.createEl("div", { cls: "gamification-stepper-group" });
    monthStepper.tabIndex = 0;
    const monthPrev = monthStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "‹" });
    const monthValue = monthStepper.createEl("span", { cls: "gamification-stepper-value gamification-stepper-month" });
    const monthNext = monthStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "›" });
    const yearGroup = monthWrap.createEl("div", { cls: "gamification-month-group" });
    const yearStepper = yearGroup.createEl("div", { cls: "gamification-stepper-group" });
    yearStepper.tabIndex = 0;
    const yearPrev = yearStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "‹" });
    const yearValue = yearStepper.createEl("span", { cls: "gamification-stepper-value" });
    const yearNext = yearStepper.createEl("button", { type: "button", cls: "gamification-stepper-btn", text: "›" });

    const updateStepperLabels = (): void => {
      monthValue.setText(monthNames[parseInt(selectedMonth, 10) - 1] ?? "");
      yearValue.setText(String(selectedYear));
    };

    const doChangeMonth = (delta: number): void => {
      const m = parseInt(selectedMonth, 10) + delta;
      if (m > 12) {
        selectedMonth = "01";
        if (selectedYear < yearMax) selectedYear++;
      } else if (m < 1) {
        selectedMonth = "12";
        if (selectedYear > yearMin) selectedYear--;
      } else {
        selectedMonth = String(m).padStart(2, "0");
      }
      updateStepperLabels();
      renderTasksForMonth();
    };

    const doChangeYear = (delta: number): void => {
      selectedYear += delta;
      if (selectedYear < yearMin) selectedYear = yearMin;
      if (selectedYear > yearMax) selectedYear = yearMax;
      updateStepperLabels();
      renderTasksForMonth();
    };

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
      selectedMonth = String(now.getMonth() + 1).padStart(2, "0");
      selectedYear = now.getFullYear();
      updateStepperLabels();
      renderTasksForMonth();
    });

    const steppers = [monthStepper, yearStepper];
    const keydownHandler = (e: KeyboardEvent): void => {
      if (e.key === "Enter" && steppers.includes(document.activeElement as HTMLElement)) {
        e.preventDefault();
        modal.close();
        return;
      }
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
    modal.contentEl.addEventListener("keydown", keydownHandler);
    setTimeout(() => monthStepper.focus(), 0);

    updateStepperLabels();
    renderTasksForMonth();

    const footer = modal.contentEl.createEl("div", { cls: "gamification-completed-footer" });
    const okBtn = footer.createEl("button", { text: UI_LABELS.common.ok, cls: "mod-cta" });
    okBtn.addEventListener("click", () => modal.close());
    modal.open();
  }

  private openStreaksModal(state: GamificationState): void {
    const L = UI_LABELS.gamification;
    const modal = new Modal(this.ctx.app);
    modal.modalEl.addClass("gamification-completed-modal");
    modal.modalEl.addClass("opa-gamification-modal");
    modal.titleEl.setText(L.streaks);
    const list = modal.contentEl.createEl("div", { cls: "gamification-completed-tasks-list gamification-completed-streaks" });
    const header = list.createEl("div", { cls: "gamification-completed-task-row gamification-completed-task-header" });
    header.createEl("div", { text: L.streak, cls: "gamification-completed-task-link" });
    header.createEl("div", { text: L.days, cls: "gamification-completed-task-days" });
    const body = list.createEl("div", { cls: "gamification-completed-tasks-body" });
    const entries = Object.entries(state.streaks || {});
    if (entries.length === 0) {
      body.createEl("p", { text: UI_LABELS.common.empty, cls: "gamification-completed-empty" });
    } else {
      for (const [name, days] of entries) {
        const nameStr = typeof name === "string" ? name : String(name ?? "");
        const daysNum = typeof days === "number" && !isNaN(days) ? days : 0;
        const row = body.createEl("div", { cls: "gamification-completed-task-row" });
        row.createEl("span", { text: nameStr, cls: "gamification-completed-task-link" });
        row.createEl("div", { text: L.daysCount(daysNum), cls: "gamification-completed-task-days" });
      }
    }
    const footer = modal.contentEl.createEl("div", { cls: "gamification-completed-footer" });
    const okBtn = footer.createEl("button", { text: UI_LABELS.common.ok, cls: "mod-cta" });
    okBtn.addEventListener("click", () => modal.close());
    modal.open();
  }

  private openPurchasedModal(state: GamificationState): void {
    const L = UI_LABELS.gamification;
    const app = this.ctx.app;
    const modal = new Modal(app);
    modal.modalEl.addClass("opa-gamification-modal");
    modal.titleEl.setText(L.purchased);
    modal.contentEl.addClass("gamification-shop-modal");
    const list = modal.contentEl.createEl("div", { cls: "gamification-purchased-list" });
    const records = (state.purchaseHistory || []).filter((h): h is PurchaseRecord => typeof h === "object" && h && "purchasedAt" in h);
    if (records.length === 0) {
      list.createEl("p", { text: UI_LABELS.common.empty, cls: "gamification-purchased-empty" });
    } else {
      for (const r of records) {
        const item = list.createEl("div", { cls: "gamification-purchased-item" });
        const date = new Date(r.purchasedAt);
        const dateStr = date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
        item.createEl("span", { text: dateStr, cls: "gamification-purchased-date" });
        const what = item.createEl("div", { cls: "gamification-purchased-what" });
        what.setText(r.description ? `${r.name} — ${r.description}` : r.name);
        item.createEl("span", { text: `-${r.cost} ${L.gold}`, cls: "gamification-purchased-cost" });
        const delBtn = item.createEl("button", { text: UI_LABELS.common.delete, cls: "gamification-purchased-del" });
        delBtn.addEventListener("click", async () => {
          const s = await this.ctx.plugin.getGamificationState();
          const pred = (h: unknown): h is PurchaseRecord =>
            typeof h === "object" && h != null && "purchasedAt" in h && "name" in h &&
            (h as PurchaseRecord).purchasedAt === r.purchasedAt && (h as PurchaseRecord).name === r.name;
          s.purchaseHistory = (s.purchaseHistory as PurchaseRecord[]).filter((h) => !pred(h));
          this.ctx.plugin.scheduleGamificationSave();
          this.scheduleRefresh();
          modal.close();
          this.openPurchasedModal(s);
        });
      }
    }
    const footer = modal.contentEl.createEl("div", { cls: "gamification-purchased-footer" });
    const clearBtn = footer.createEl("button", { text: L.clearHistory, cls: "mod-secondary" });
    clearBtn.addEventListener("click", async () => {
      const s = await this.ctx.plugin.getGamificationState();
      s.purchaseHistory = [];
      this.ctx.plugin.scheduleGamificationSave();
      this.scheduleRefresh();
      modal.close();
    });
    const okBtn = footer.createEl("button", { text: UI_LABELS.common.ok, cls: "mod-cta" });
    okBtn.addEventListener("click", () => modal.close());
    modal.open();
  }

  private openShopManageModal(state: GamificationState): void {
    const L = UI_LABELS.gamification;
    const app = this.ctx.app;
    const modal = new Modal(app);
    modal.modalEl.addClass("opa-gamification-modal");
    modal.titleEl.setText(L.management);
    modal.contentEl.addClass("gamification-shop-modal");
    const list = modal.contentEl.createEl("div", { cls: "gamification-shop-modal-list" });

    const addRow = (item: { name: string; cost: number; description?: string }) => {
      const row = list.createEl("div", { cls: "gamification-shop-modal-row" });
      const nameInput = row.createEl("input", { type: "text", cls: "gamification-shop-modal-name", attr: { placeholder: L.name } });
      nameInput.value = item.name;
      const costInput = row.createEl("input", { type: "number", cls: "gamification-shop-modal-cost", attr: { min: "0", placeholder: "0" } });
      costInput.value = String(item.cost);
      const descInput = row.createEl("textarea", { cls: "gamification-shop-modal-desc", attr: { placeholder: L.description, rows: "1" } });
      descInput.value = item.description ?? "";
      const delBtn = row.createEl("button", { type: "button", text: UI_LABELS.common.delete, cls: "gamification-shop-modal-del" });
      delBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        row.remove();
      });
      return row;
    };

    for (const item of state.shop?.length ? state.shop : [{ name: "", cost: 0, description: "" }]) addRow(item);

    const addBtn = modal.contentEl.createEl("button", { type: "button", text: L.addItem, cls: "gamification-shop-modal-add" });
    addBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const row = addRow({ name: "", cost: 0, description: "" });
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });

    const actions = modal.contentEl.createEl("div", { cls: "gamification-shop-modal-actions" });
    const cancelBtn = actions.createEl("button", { text: UI_LABELS.common.cancel, cls: "mod-secondary" });
    cancelBtn.addEventListener("click", () => modal.close());
    const saveBtn = actions.createEl("button", { text: UI_LABELS.common.save, cls: "mod-cta" });
    saveBtn.addEventListener("click", async () => {
      const rows = list.querySelectorAll<HTMLElement>(".gamification-shop-modal-row");
      const shop: { name: string; cost: number; description?: string }[] = [];
      rows.forEach((row) => {
        const name = (row.querySelector(".gamification-shop-modal-name") as HTMLInputElement)?.value?.trim();
        if (!name) return;
        const cost = parseInt((row.querySelector(".gamification-shop-modal-cost") as HTMLInputElement)?.value ?? "0", 10) || 0;
        const description = (row.querySelector(".gamification-shop-modal-desc") as HTMLTextAreaElement)?.value?.trim();
        shop.push({ name, cost, description: description || undefined });
      });
      const s = await this.ctx.plugin.getGamificationState();
      s.shop = shop;
      this.ctx.plugin.scheduleGamificationSave();
      this.scheduleRefresh();
      modal.close();
    });
    modal.open();
  }

  private async buyShopItem(
    item: { name: string; cost: number; description?: string },
    state: GamificationState
  ): Promise<void> {
    const current = await this.ctx.plugin.getGamificationState();
    if (current.gold < item.cost) return;
    current.gold -= item.cost;
    current.purchaseHistory = [
      ...current.purchaseHistory,
      { purchasedAt: new Date().toISOString(), name: item.name, description: item.description, cost: item.cost },
    ];
    this.ctx.plugin.scheduleGamificationSave();
    this.scheduleRefresh();
  }
}
