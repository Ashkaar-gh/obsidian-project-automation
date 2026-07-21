/**
 * Модуль доски задач: блоки opa-home-view и opa-project-view.
 * Группировка по group, сводка по статусам, TOC, сворачиваемые группы, смена статуса в таблице.
 */

import { Modal, type TFile } from "obsidian";
import type { ModuleContext } from "./types";
import { Paths } from "../core/Paths";
import {
  getIcon,
  getWeight,
  getConfig,
  getDropdownOptions,
  STATUS_CONFIG,
  EMPTY_STATUS_ICON,
} from "../core/StatusConfig";
import { UI_LABELS } from "../ui/Labels";
import { createCollapsibleSection } from "../ui/CollapsibleSection";
import { BlockRegistry } from "../ui/BlockRegistry";
import { updateFrontmatter, removeFrontmatterKey, appendLineToTaskDescriptionSection } from "../core/FileIO";

const UNGROUPED_KEY = "Ungrouped";

interface TaskRow {
  path: string;
  name: string;
  status: string;
  context: string;
  environment: string;
  /** Человеко-читаемый интервал для UI. */
  executionTime: string;
  /** Дата начала исполнения (первая дата из daily или fm.date). Используется для сортировки. */
  startDate: Date | null;
  /** Отформатированная дата дедлайна из frontmatter (пустая строка, если нет). */
  deadline: string;
  /** Дедлайн в прошлом и статус не «Готово» — подсветить красным. */
  isDeadlineOverdue: boolean;
  difficulty: string | null;
  project: string | null;
  projects: string[];
  group: string;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\./g, "-");
}

function getExecutionTime(startDate: Date | null, endDate: Date | null): string {
  if (!startDate) return "";
  if (startDate && endDate && startDate.getTime() !== endDate.getTime())
    return `${formatDate(startDate)} - ${formatDate(endDate)}`;
  return formatDate(startDate);
}

/** Парсинг даты из frontmatter (DD-MM-YYYY, YYYY-MM-DD, DD.MM.YYYY). */
function parseDateFromFrontmatter(value: unknown): Date | null {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  if (typeof value !== "string") return null;
  const clean = value.replace(/\.md$/i, "").trim();
  const formats: [RegExp, (m: RegExpMatchArray) => { year: number; month: number; day: number }][] = [
    [/^(\d{4})-(\d{2})-(\d{2})/, (m) => ({ year: parseInt(m[1], 10), month: parseInt(m[2], 10) - 1, day: parseInt(m[3], 10) })],
    [/^(\d{2})-(\d{2})-(\d{4})/, (m) => ({ year: parseInt(m[3], 10), month: parseInt(m[2], 10) - 1, day: parseInt(m[1], 10) })],
    [/^(\d{2})\.(\d{2})\.(\d{4})/, (m) => ({ year: parseInt(m[3], 10), month: parseInt(m[2], 10) - 1, day: parseInt(m[1], 10) })],
  ];
  for (const [re, toParts] of formats) {
    const m = clean.match(re);
    if (!m) continue;
    const { year, month, day } = toParts(m);
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

/** Версия рендера по контейнеру: только последний завершённый рендер обновляет DOM. */
const projectsListRenderVersion = new WeakMap<HTMLElement, number>();
const homeRenderVersion = new WeakMap<HTMLElement, number>();

export class TasksDashboardModule {
  private ctx: ModuleContext;
  private registry: BlockRegistry;
  private unsubscribeIndex: (() => void) | null = null;
  /** Общий кэш строк задач на один цикл refresh — без N полных сканов vault. */
  private rowsCache: TaskRow[] | null = null;

  constructor(ctx: ModuleContext, debounceMs: number) {
    this.ctx = ctx;
    this.registry = new BlockRegistry({
      app: ctx.app,
      isEnabled: () =>
        ctx.plugin.settings.enableTasksDashboard && ctx.plugin.settings.enablePluginRefresh,
      debounceMs,
      beforeRefresh: async () => {
        this.rowsCache = await this.getRawTaskRows();
      },
    });
  }

  load(): void {
    this.unsubscribeIndex = this.ctx.eventBus.on("index:updated", this.onStorageChange);
    this.ctx.plugin.registerEvent(this.ctx.app.metadataCache.on("changed", this.onMetadataChanged));
    this.ctx.plugin.registerEvent(this.ctx.app.workspace.on("active-leaf-change", this.onLeafChange));
    // create/rename/delete — только после layoutReady, иначе при старте vault эмитит create
    // на каждый файл и доска бесконечно рефрешится → зависания.
    this.ctx.app.workspace.onLayoutReady(() => {
      const vault = this.ctx.app.vault as unknown as {
        on(e: string, cb: (...args: unknown[]) => void): import("obsidian").EventRef;
      };
      this.ctx.plugin.registerEvent(vault.on("create", this.onStorageChange));
      this.ctx.plugin.registerEvent(vault.on("rename", this.onStorageChange));
      this.ctx.plugin.registerEvent(vault.on("delete", this.onStorageChange));
    });

    this.ctx.plugin.registerMarkdownCodeBlockProcessor("opa-home-view", (_source, el) => {
      el.addClass("opa-home-view");
      this.registry.register(el, () => this.render(el, null));
    });
    this.ctx.plugin.registerMarkdownCodeBlockProcessor("opa-project-view", (_source, el, ctx) => {
      el.addClass("opa-project-view");
      const projectFilter = ctx.sourcePath
        ? this.ctx.app.vault.getAbstractFileByPath(ctx.sourcePath)?.name?.replace(/\.md$/i, "") ?? null
        : null;
      const excludePath = ctx.sourcePath ?? null;
      this.registry.register(el, () => this.render(el, projectFilter, excludePath));
    });
    this.ctx.plugin.registerMarkdownCodeBlockProcessor("opa-projects-view", (_source, el) => {
      el.addClass("opa-projects-view");
      this.registry.register(el, () => this.renderProjectsList(el));
    });
  }

  private async renderProjectsList(container: HTMLElement): Promise<void> {
    try {
      const version = (projectsListRenderVersion.get(container) ?? 0) + 1;
      projectsListRenderVersion.set(container, version);

      let projects: string[];
      try {
        projects = await this.ctx.plugin.getProjectsSortedByTaskCount();
      } catch {
        if (projectsListRenderVersion.get(container) !== version) return;
        container.empty();
        container.createEl("p", { text: "—", cls: "opa-projects-empty" });
        return;
      }
      if (projectsListRenderVersion.get(container) !== version) return;

      container.empty();
      if (!this.ctx.plugin.settings.enableTasksDashboard) {
        container.addClass("opa-hidden");
        return;
      }
      container.removeClass("opa-hidden");

      const wrap = container.createDiv({ cls: "opa-projects-view-wrap" });
      const body = createCollapsibleSection(wrap, "Проекты", "projects");

      if (!projects || projects.length === 0) {
        body.createEl("p", {
          text: "—",
          cls: "opa-projects-empty",
        });
        return;
      }

      const ul = body.createEl("ul", { cls: "opa-projects-list" });
      for (const name of projects) {
        const li = ul.createEl("li");
        const link = li.createEl("a", { text: name, cls: "internal-link", href: name });
        link.setAttribute("data-href", name);
      }
    } catch (e) {
      console.error(e);
    }
  }

  private onStorageChange = (): void => {
    this.scheduleRefresh();
  };

  /** Рефрешить при changed только если файл влияет на доску задач (задача, daily или templates). */
  private onMetadataChanged = (file: import("obsidian").TFile): void => {
    if (!this.isTaskRelevantFile(file)) return;
    this.scheduleRefresh();
  };

  /** Значения project из frontmatter в плоский список непустых строк. */
  private flattenProjectField(project: unknown): string[] {
    if (project == null) return [];
    if (Array.isArray(project)) return project.flatMap((p) => this.flattenProjectField(p));
    const s = String(project).trim();
    return s ? [s] : [];
  }

  /**
   * Корневая заметка проекта (шаблон project.md): project совпадает с именем файла.
   * Такие файлы не должны попадать в доску как задачи.
   */
  private isProjectHubPage(file: TFile, fm: Record<string, unknown>): boolean {
    const base = file.basename;
    for (const v of this.flattenProjectField(fm.project)) {
      const segment = v.replace(/\.md$/i, "").split("/").pop()?.trim() ?? "";
      if (segment === base) return true;
    }
    return false;
  }

  /**
   * Заметка-задача: во frontmatter есть status, project или group.
   * Корневая страница проекта (project совпадает с именем файла) не считается задачей.
   */
  private isTaskNote(file: TFile, cache: { frontmatter?: Record<string, unknown> } | null): boolean {
    const fm = cache?.frontmatter;
    if (!fm) return false;
    if (this.isProjectHubPage(file, fm)) return false;
    return fm.status != null || fm.project != null || fm.group != null;
  }

  private isTaskRelevantFile(file: import("obsidian").TFile): boolean {
    const cache = this.ctx.app.metadataCache.getFileCache(file);
    if (this.isTaskNote(file, cache)) return true;
    const path = file.path;
    const dailyPrefix = Paths.DAILY_FOLDER.replace(/\/?$/, "") + "/";
    const templatesPrefix = Paths.TEMPLATES_FOLDER.replace(/\/?$/, "") + "/";
    return path.startsWith(dailyPrefix) || path.startsWith(templatesPrefix);
  }

  /** При переключении вкладки — запускаем рефреш. */
  private onLeafChange = (): void => {
    if (!this.ctx.plugin.settings.enablePluginRefresh) return;
    const activeFile = this.ctx.app.workspace.getActiveFile();
    const dailyPrefix = Paths.DAILY_FOLDER.replace(/\/?$/, "") + "/";
    if (activeFile?.path.startsWith(dailyPrefix)) return;
    this.scheduleRefresh();
  };

  unload(): void {
    if (this.unsubscribeIndex) this.unsubscribeIndex();
    this.unsubscribeIndex = null;
    this.registry.clear();
    this.rowsCache = null;
  }

  /** Публичный вызов для отложенного рефреша. Обновляются все открытые блоки, в т.ч. на фоновых вкладках. */
  scheduleRefresh(): void {
    this.rowsCache = null;
    this.registry.scheduleRefresh();
  }

  updateState(): void {
    void this.forceRefresh();
  }

  /** Принудительное обновление (например после создания задачи). Ждёт завершения рендера. */
  async forceRefresh(): Promise<void> {
    this.rowsCache = null;
    await this.registry.forceRefreshAsync();
  }

  /** Сырой список задач по хранилищу (без фильтра по проекту и без группировки). */
  private async getRawTaskRows(): Promise<TaskRow[]> {
    const { app, taskIndex } = this.ctx;
    taskIndex.ensureSubscribed();

    const templatesPrefix = Paths.TEMPLATES_FOLDER.replace(/\/?$/, "") + "/";
    const trash = Paths.TRASH_FILE;
    const archivePrefix = Paths.ARCHIVE_FOLDER.replace(/\/?$/, "") + "/";

    const files = app.vault.getMarkdownFiles().filter((f) => {
      if (f.path.startsWith(templatesPrefix) || f.path === trash || f.path.startsWith(archivePrefix))
        return false;
      const cache = app.metadataCache.getFileCache(f);
      return this.isTaskNote(f, cache);
    });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const rawData: TaskRow[] = [];
    for (const file of files) {
      const cache = app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter ?? {};
      let status = fm.status;
      if (Array.isArray(status)) status = status[0];
      if (status == null || (typeof status === "string" && status.trim() === "")) status = "";
      else status = String(status);

      const taskName = file.basename.replace(/\s+/g, " ").trim().toLowerCase();
      let eventDates = taskIndex.getDatesForTask(taskName);
      if (!eventDates.length && fm.date != null) {
        const d = parseDateFromFrontmatter(fm.date);
        if (d) eventDates = [d];
      }
      const startDate = eventDates.length ? new Date(Math.min(...eventDates.map((d) => d.getTime()))) : null;
      const endDate = eventDates.length ? new Date(Math.max(...eventDates.map((d) => d.getTime()))) : null;
      const executionTime = getExecutionTime(startDate, endDate);

      const deadlineRaw = fm.deadline;
      const deadlineDate = parseDateFromFrontmatter(deadlineRaw);
      const deadline = deadlineDate ? formatDate(deadlineDate) : "";
      const statusLower = String(status).toLowerCase();
      const isDeadlineOverdue =
        deadlineDate != null &&
        deadlineDate.getTime() < todayStart.getTime() &&
        !statusLower.includes("готово");

      let context = fm.context;
      if (Array.isArray(context)) context = context[0];
      let environment = fm.environment;
      if (Array.isArray(environment)) environment = (environment as string[]).join(", ");
      let difficulty = fm.difficulty;
      if (Array.isArray(difficulty)) difficulty = difficulty[0];

      let projectRaw = fm.project;
      const projectsArray: string[] = Array.isArray(projectRaw)
        ? projectRaw.map(String)
        : typeof projectRaw === "string"
          ? projectRaw.split(",").map((s) => s.trim()).filter(Boolean)
          : [];

      let groupRaw = fm.group;
      if (Array.isArray(groupRaw)) groupRaw = groupRaw[0];
      const group = typeof groupRaw === "string" && groupRaw.trim() ? groupRaw.trim() : UNGROUPED_KEY;

      rawData.push({
        path: file.path,
        name: file.basename,
        status: status === "" ? "" : String(status),
        context: String(context ?? ""),
        environment: String(environment ?? ""),
        executionTime,
        startDate,
        deadline,
        isDeadlineOverdue,
        difficulty: difficulty != null ? String(difficulty) : null,
        project: projectsArray.length > 0 ? projectsArray[0] : null,
        projects: projectsArray,
        group,
      });
    }
    return rawData;
  }

  /** Количество задач по проекту (ключ — название проекта в нижнем регистре). Для сортировки списка проектов по популярности. */
  async getTaskCountByProject(): Promise<Map<string, number>> {
    const rows = await this.getRawTaskRows();
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const p of row.projects) {
        const key = p.trim().toLowerCase();
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }

  private async getTableData(
    projectFilter: string | null = null,
    excludePath: string | null = null
  ): Promise<Map<string, TaskRow[]>> {
    const rawData = this.rowsCache ?? (await this.getRawTaskRows());
    let filtered = rawData;
    if (projectFilter != null && projectFilter.trim() !== "") {
      const key = projectFilter.toLowerCase().trim();
      filtered = rawData.filter((r) => r.projects.some((p) => p.toLowerCase() === key));
    }
    if (excludePath) filtered = filtered.filter((r) => r.path !== excludePath);

    const grouped = new Map<string, TaskRow[]>();
    const byStatus = projectFilter == null;
    for (const item of filtered) {
      const key = byStatus ? item.status : item.group;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(item);
    }
    for (const tasks of grouped.values()) {
      tasks.sort((a, b) => {
        const wA = getWeight(a.status);
        const wB = getWeight(b.status);
        if (wA !== wB) return wA - wB;

        const tA = a.startDate ? a.startDate.getTime() : Number.NEGATIVE_INFINITY;
        const tB = b.startDate ? b.startDate.getTime() : Number.NEGATIVE_INFINITY;
        if (tA !== tB) return tB - tA; // более поздняя дата выше

        return a.path.localeCompare(b.path);
      });
    }
    if (!byStatus && grouped.get(UNGROUPED_KEY)?.length === 0) grouped.delete(UNGROUPED_KEY);
    return grouped;
  }

  private getGroupState(viewKey: string, groupName: string): boolean {
    return localStorage.getItem(`${viewKey}-group-collapsed-${groupName}`) === "true";
  }

  private setGroupState(viewKey: string, groupName: string, isCollapsed: boolean): void {
    localStorage.setItem(`${viewKey}-group-collapsed-${groupName}`, String(isCollapsed));
  }

  private openStatusChangeCommentModal(oldStatus: string, newStatus: string): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new StatusChangeCommentModal(this.ctx.app, oldStatus, newStatus, resolve);
      modal.open();
    });
  }

  private fillSummaryByStatus(tasks: TaskRow[], container: HTMLElement): void {
    const counts: Record<string, number> = {};
    for (const t of tasks) {
      const s = (t.status ?? "").toLowerCase();
      const conf = getConfig(s);
      const key = s === "" ? "" : (conf ? conf.key : s);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    if (counts[""] > 0) {
      container.createEl("span", {
        cls: "pv-summary-item",
        text: `${EMPTY_STATUS_ICON} ${counts[""]}`,
      });
    }
    const displayed = new Set<string>();
    for (const conf of STATUS_CONFIG) {
      if (counts[conf.key] && !displayed.has(conf.icon)) {
        const span = container.createEl("span", { cls: "pv-summary-item", text: `${conf.icon} ${counts[conf.key]}` });
        displayed.add(conf.icon);
      }
    }
  }

  private async render(
    container: HTMLElement,
    projectFilter: string | null,
    excludePath: string | null = null
  ): Promise<void> {
    if (!this.ctx.plugin.settings.enableTasksDashboard) {
      container.empty();
      container.addClass("opa-hidden");
      return;
    }
    container.removeClass("opa-hidden");

    const version = (homeRenderVersion.get(container) ?? 0) + 1;
    homeRenderVersion.set(container, version);

    try {
      const groupedData = await this.getTableData(projectFilter, excludePath);
      if (homeRenderVersion.get(container) !== version) return;

      container.empty();
      const body =
        projectFilter == null
          ? createCollapsibleSection(container, "Доска задач", "tasks-dashboard-home")
          : container;

      const labels = UI_LABELS.tasks;
      const emptyMsg = projectFilter != null ? labels.noTasks : labels.noActive;
      if (!groupedData || groupedData.size === 0) {
        body.createEl("p", { text: emptyMsg, cls: "pv-empty-message" });
      } else {

      const viewKey = projectFilter ? `project-${projectFilter}` : "home";
      const isHome = projectFilter == null;
      const groupsArray = Array.from(groupedData.entries()).sort((a, b) => {
        if (isHome) {
          const wA = getWeight(a[0]);
          const wB = getWeight(b[0]);
          if (wA !== wB) return wA - wB;
          return a[0].localeCompare(b[0]);
        }
        if (a[0] === UNGROUPED_KEY) return -1;
        if (b[0] === UNGROUPED_KEY) return 1;
        return a[0].localeCompare(b[0]);
      });
      const allTasks = Array.from(groupedData.values()).flat();

      const tocContainer = body.createEl("div", { cls: "pv-toc-container" });
      for (const [groupName, tasks] of groupsArray) {
        const displayName = isHome
          ? (groupName === "" ? labels.noStatus : groupName)
          : (groupName === UNGROUPED_KEY ? (labels.ungrouped ?? "Задачи без группы") : groupName);
        const displayIcon = isHome ? getIcon(groupName) : "📝";
        const btn = tocContainer.createEl("div", { cls: "pv-toc-btn" });
        btn.setText(`${displayIcon} ${displayName}`);
        btn.createEl("span", { cls: "pv-toc-count", text: ` (${tasks.length})` });
        btn.dataset.group = groupName;
      }

      const totalSummaryContainer = body.createEl("div", {
        cls: "pv-group-header-container pv-total-summary",
      });
      const totalTitleDiv = totalSummaryContainer.createEl("div", { cls: "pv-group-title" });
      totalTitleDiv.createEl("span", { cls: "pv-group-title-text", text: `${labels.total} (${allTasks.length})` });
      const totalStatsDiv = totalSummaryContainer.createEl("div", { cls: "pv-group-summary" });
      this.fillSummaryByStatus(allTasks, totalStatsDiv);

      const enableDeadline = this.ctx.plugin.settings.enableDeadline ?? false;
      let tableClasses =
        projectFilter == null
          ? "dataview table-view-table pv-table"
          : "dataview table-view-table pv-table pv-table-project-view";
      if (enableDeadline) tableClasses += " pv-table-with-deadline";
      const table = body.createEl("table", { cls: tableClasses });
      const theadRow = table.createEl("thead").createEl("tr");
      theadRow.createEl("th", { text: labels.columns.task, cls: "pv-col-auto" });
      theadRow.createEl("th", { text: labels.columns.context, cls: "pv-col-shrink" });
      if (isHome) theadRow.createEl("th", { text: labels.columns.project, cls: "pv-col-shrink" });
      theadRow.createEl("th", { text: labels.columns.environment, cls: "pv-col-shrink" });
      theadRow.createEl("th", { text: labels.columns.status, cls: "pv-col-fixed-status" });
      if (enableDeadline) {
        theadRow.createEl("th", { text: labels.columns.deadline, cls: "pv-col-fixed-date" });
      }
      theadRow.createEl("th", {
        text: labels.columns.time,
        cls: "pv-col-fixed-date-range",
      });
      const totalCols = theadRow.children.length;

      const tocButtons = tocContainer.querySelectorAll<HTMLElement>("[data-group]");

      for (let i = 0; i < groupsArray.length; i++) {
        const [groupName, tasks] = groupsArray[i];
        const collapsed = this.getGroupState(viewKey, groupName);
        const tbody = table.createEl("tbody", { cls: collapsed ? "pv-collapsed" : undefined });
        const displayName = isHome
          ? (groupName === "" ? labels.noStatus : groupName)
          : (groupName === UNGROUPED_KEY ? (labels.ungrouped ?? "Задачи без группы") : groupName);
        const displayIcon = isHome ? getIcon(groupName) : "📝";

        const colSpan = totalCols;
        const groupRow = tbody.createEl("tr", { cls: "pv-group-row" });
        const groupTd = groupRow.createEl("td", { attr: { colSpan }, cls: "pv-group-cell" });
        const groupHeaderInner = groupTd.createEl("div", { cls: "pv-group-header-container" });
        const groupTitleDiv = groupHeaderInner.createEl("div", { cls: "pv-group-title" });
        groupTitleDiv.createEl("span", { cls: "pv-collapse-arrow", text: "▼" });
        groupTitleDiv.createEl("span", { cls: "pv-group-title-text", text: `${displayIcon} ${displayName}` });
        groupTitleDiv.createEl("span", { cls: "pv-group-count", text: ` (${tasks.length})` });
        const gSummary = groupHeaderInner.createEl("div", { cls: "pv-group-summary" });
        this.fillSummaryByStatus(tasks, gSummary);
        groupTd.addEventListener("click", () => {
          tbody.classList.toggle("pv-collapsed");
          this.setGroupState(viewKey, groupName, tbody.classList.contains("pv-collapsed"));
        });

        for (const task of tasks) {
          const tr = tbody.createEl("tr", { cls: "pv-task-row" });
          const linkCell = tr.createEl("td", { cls: "pv-task-cell pv-indent" });
          const link = linkCell.createEl("a", { text: task.name, cls: "internal-link", href: task.path });
          link.setAttribute("data-href", task.path);
          tr.createEl("td", { text: task.context || "-", cls: "pv-task-cell" });
          if (isHome) tr.createEl("td", { text: task.project ?? "-", cls: "pv-task-cell" });
          tr.createEl("td", { text: task.environment || "-", cls: "pv-task-cell" });

          const opts = getDropdownOptions();
          const select = tr.createEl("td", { cls: "pv-task-cell" }).createEl("select", {
            cls: "pv-status-select ui-select",
          });
          for (const opt of opts) {
            select.createEl("option", { value: opt.value, text: opt.label });
          }
          const normalizedStatus = String(task.status ?? "").trim();
          if (!normalizedStatus) select.value = "";
          else {
            const match = opts.find(
              (o) => o.value !== "" && normalizedStatus.toLowerCase().includes(o.value.toLowerCase())
            );
            if (match) select.value = match.value;
            else {
              select.createEl("option", { value: normalizedStatus, text: normalizedStatus });
              select.value = normalizedStatus;
            }
          }
          select.addEventListener("click", (e) => e.stopPropagation());
          select.addEventListener("change", async (e) => {
            const selectEl = e.target as HTMLSelectElement;
            const newStatus = selectEl.value;
            const oldStatus = task.status;
            const displayOld = oldStatus || "-";
            const displayNew = newStatus || "-";

            if (this.ctx.plugin.settings.enableStatusChangeComment) {
              selectEl.value = oldStatus;
              const comment = await this.openStatusChangeCommentModal(displayOld, displayNew);
              if (comment === null) return;
              if (newStatus === "") {
                await removeFrontmatterKey(this.ctx.app, task.path, "status");
              } else {
                await updateFrontmatter(this.ctx.app, task.path, "status", newStatus);
              }
              const dateStr = formatDate(new Date());
              const lineText = comment.trim()
                ? `${dateStr}: ${comment.trim()} (${displayOld} → ${displayNew})`
                : `${dateStr}: ${displayOld} → ${displayNew}`;
              await appendLineToTaskDescriptionSection(this.ctx.app, task.path, lineText);
            } else {
              if (newStatus === "") {
                await removeFrontmatterKey(this.ctx.app, task.path, "status");
              } else {
                await updateFrontmatter(this.ctx.app, task.path, "status", newStatus);
              }
            }
            if (newStatus === "Готово") {
              this.ctx.eventBus.emit("task:completed", { path: task.path, difficulty: task.difficulty ?? null });
            } else if ((oldStatus || "").toLowerCase() === "готово" && newStatus !== "Готово") {
              this.ctx.eventBus.emit("task:uncompleted", { path: task.path });
            }
            setTimeout(() => this.ctx.plugin.tasksDashboard?.scheduleRefresh(), 250);
          });
          if (enableDeadline) {
            const deadlineCls =
              "pv-task-cell pv-col-fixed-date" +
              (task.isDeadlineOverdue ? " pv-deadline-overdue" : "");
            tr.createEl("td", {
              text: task.deadline || "-",
              cls: deadlineCls,
            });
          }
          tr.createEl("td", {
            text: task.executionTime || "-",
            cls: "pv-task-cell pv-col-fixed-date-range",
          });
        }

        const tocBtn = tocButtons[i];
        if (tocBtn) {
          tocBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (tbody.classList.contains("pv-collapsed")) {
              tbody.classList.remove("pv-collapsed");
              this.setGroupState(viewKey, groupName, false);
            }
            groupRow.scrollIntoView({ behavior: "auto", block: "start" });
          });
        }
      }
      }

    } catch (e) {
      container.empty();
      container.createEl("p", { text: UI_LABELS.errors.renderShort, cls: "view-error" });
      console.error(e);
    }
  }
}

class StatusChangeCommentModal extends Modal {
  private answered = false;

  constructor(
    app: import("obsidian").App,
    private oldStatus: string,
    private newStatus: string,
    private onDone: (value: string | null) => void
  ) {
    super(app);
  }

  private finish(value: string | null): void {
    if (this.answered) return;
    this.answered = true;
    this.onDone(value);
  }

  onOpen(): void {
    this.modalEl.addClass("opa-create-task-modal");
    const { contentEl } = this;
    this.titleEl.setText("Комментарий к смене статуса");
    contentEl.createEl("p", {
      text: `Статус: ${this.oldStatus} → ${this.newStatus}.`,
      cls: "opa-status-comment-hint",
    });
    const textarea = contentEl.createEl("textarea", {
      cls: "opa-status-comment-input",
      attr: { rows: "6", placeholder: "Например: задача выполнена, отложена до завтра…" },
    });
    const btnRow = contentEl.createDiv({ cls: "opa-create-task-buttons" });
    btnRow.createEl("button", { text: "Отмена", cls: "mod-secondary" }).addEventListener("click", () => {
      this.finish(null);
      this.close();
    });
    btnRow.createEl("button", { text: "Сохранить", cls: "mod-cta" }).addEventListener("click", () => {
      this.finish(textarea.value ?? "");
      this.close();
    });
    textarea.focus();
  }

  onClose(): void {
    this.finish(null);
    this.contentEl.empty();
  }
}
