import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { eventBus } from "./core/EventBus";

const DEFAULT_DIFFICULTY_REWARDS: Record<string, { xp: number; gold: number }> = {
  легкая: { xp: 5, gold: 2 },
  средняя: { xp: 10, gold: 5 },
  сложная: { xp: 20, gold: 10 },
};

export interface PluginSettings {
  enableGamification: boolean;
  enableReminders: boolean;
  enableInbox: boolean;
  enableTasksDashboard: boolean;
  enableTrash: boolean;
  enablePluginRefresh: boolean;
  /** Включить поле «Дедлайн» в задачах и в виде проекта. */
  enableDeadline: boolean;
  /** При создании задачи с дедлайном добавлять напоминание. */
  enableDeadlineReminders: boolean;
  /** За сколько дней до дедлайна срабатывает напоминание (0 = в день дедлайна). */
  deadlineReminderLeadDays: number;
  /** Добавлять комментарий при смене статуса задачи (модальное окно, запись в ## Описание задачи). */
  enableStatusChangeComment: boolean;
  /** Варианты окружения (prod, dev и т.д.) через запятую. */
  environmentOptions: string;
  /** Варианты контекста (личное, работа и т.д.) через запятую. */
  contextOptions: string;
  /** Базовый XP для расчёта уровня (геймификация). */
  gamificationXpLevelBase: number;
  /** Сложность по умолчанию (геймификация). */
  gamificationDefaultDifficulty: string;
  /** Награды XP/золото по сложности задачи (геймификация). */
  gamificationDifficultyRewards: Record<string, { xp: number; gold: number }>;
  /** Грейс-период для стрика (дней): дополнительные дни после срока, в которые выполнение ещё сохраняет стрик. 0 = строго. */
  gamificationStreakGraceDays: number;
  /** Пул активностей. */
  enableActivities: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
  enableGamification: true,
  enableReminders: true,
  enableInbox: true,
  enableTasksDashboard: true,
  enableTrash: true,
  enablePluginRefresh: true,
  enableDeadline: true,
  enableDeadlineReminders: true,
  deadlineReminderLeadDays: 1,
  enableStatusChangeComment: true,
  environmentOptions: "prod, dev",
  contextOptions: "личное, работа",
  gamificationXpLevelBase: 20,
  gamificationDefaultDifficulty: "легкая",
  gamificationDifficultyRewards: { ...DEFAULT_DIFFICULTY_REWARDS },
  gamificationStreakGraceDays: 0,
  enableActivities: true,
};

const REFRESH_DEBOUNCE_MS = 500;
import { TaskIndex } from "./core/TaskIndex";
import { RemindersIndex } from "./core/RemindersIndex";
import { Paths } from "./core/Paths";
import { DEFAULT_HOMEPAGE } from "./core/DefaultTemplates";
import { TasksDashboardModule } from "./modules/TasksDashboardModule";
import {
  DEFAULT_GAMIFICATION_DEFAULTS,
  readDataFile,
  writeDataFile,
  readState,
  writeState,
  type GamificationDefaults,
  type GamificationState,
} from "./core/GamificationState";
import { GamificationModule } from "./modules/GamificationModule";
import { RemindersModule } from "./modules/RemindersModule";
import { InboxModule } from "./modules/InboxModule";
import { TrashModule } from "./modules/TrashModule";
import { TaskViewModule } from "./modules/TaskViewModule";
import { NoteTemplatesModule } from "./modules/NoteTemplatesModule";
import { ActivitiesModule } from "./modules/ActivitiesModule";
import type { PluginModule } from "./modules/types";

const GAMIFICATION_SAVE_DEBOUNCE_MS = 2500;

export class ObsidianProjectAutomationPlugin extends Plugin {
  settings!: PluginSettings;
  taskIndex!: TaskIndex;
  remindersIndex!: RemindersIndex;
  eventBus = eventBus;

  /** Кэш состояния геймификации в памяти. */
  private gamificationState: GamificationState | null = null;
  private gamificationSaveTimeout: ReturnType<typeof setTimeout> | null = null;

  gamification: GamificationModule | null = null;
  /** Дефолтные товары магазина из defaults.json (только defaultShop). */
  private cachedDefaultShop: GamificationDefaults["defaultShop"] = [];
  /** Тестовые/дефолтные проекты из defaults.json (ссылки на заметки). */
  private cachedDefaultProjects: string[] = [];
  reminders: RemindersModule | null = null;
  inbox: InboxModule | null = null;
  tasksDashboard: TasksDashboardModule | null = null;
  taskView: TaskViewModule | null = null;
  trash: TrashModule | null = null;
  noteTemplates: NoteTemplatesModule | null = null;
  activities: ActivitiesModule | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.taskIndex = new TaskIndex(this.app, this.eventBus);
    this.taskIndex.ensureSubscribed();
    this.remindersIndex = new RemindersIndex(this.app, this);

    this.addCommand({
      id: "open-or-create-homepage",
      name: "Открыть или создать домашнюю страницу",
      callback: () => this.openOrCreateHomepage(),
    });

    this.addSettingTab(new ObsidianProjectAutomationSettingTab(this.app, this));
    this.app.vault.on("delete", this.onVaultFileDeleted);
    this.app.vault.on("modify", this.onVaultModify);
    this.loadActiveModules();
  }

  private async openOrCreateHomepage(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(Paths.HOMEPAGE_FILE);
    if (file) {
      await this.app.workspace.getLeaf(true).openFile(file);
      return;
    }
    const created = await this.app.vault.create(Paths.HOMEPAGE_FILE, DEFAULT_HOMEPAGE);
    await this.app.workspace.getLeaf(true).openFile(created);
    new Notice("Создана домашняя страница. Настройте разделы под себя.");
  }

  private async resetHomepageToDefault(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(Paths.HOMEPAGE_FILE);
    if (!file) {
      await this.openOrCreateHomepage();
      return;
    }
    await this.app.vault.modify(file, DEFAULT_HOMEPAGE);
    new Notice("Домашняя страница сброшена к шаблону плагина.");
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  onunload(): void {
    this.app.vault.off("modify", this.onVaultModify);
    this.app.vault.off("delete", this.onVaultFileDeleted);
    if (this.gamificationSaveTimeout) {
      clearTimeout(this.gamificationSaveTimeout);
      this.gamificationSaveTimeout = null;
    }
    this.flushGamificationSave();
    this.unloadAllModules();
    this.remindersIndex?.unsubscribe();
    this.taskIndex.unsubscribe();
  }

  private onVaultModify = (file: import("obsidian").TAbstractFile): void => {
    if (file.path === this.getGamificationDataPath()) this.gamificationState = null;
  };

  private onVaultFileDeleted = (file: import("obsidian").TAbstractFile): void => {
    const path = file.path;
    if (!path.toLowerCase().endsWith(".md")) return;
    const projectName = path.replace(/\.md$/i, "");
    this.removeProjectIfInList(projectName);
  };

  private async removeProjectIfInList(projectName: string): Promise<void> {
    const data = await readDataFile(this);
    const projects = data.projects ?? [];
    const baseName = projectName.split("/").pop() ?? projectName;
    const toRemove = new Set([projectName, baseName]);
    const next = projects.filter((p) => !toRemove.has(p));
    if (next.length === projects.length) return;
    await writeDataFile(this, {
      gamification: data.gamification,
      projects: next,
      reminders: data.reminders ?? [],
      inbox: data.inbox ?? [],
      trash: data.trash ?? [],
    });
    this.tasksDashboard?.scheduleRefresh();
  }

  async loadSettings(): Promise<void> {
    const data = (await this.readDataFromDisk()) ?? (await this.loadData()) as Record<string, unknown> | null;
    const fileDefaults = await this.readDefaultsFromFile();
    const { gamification: _g, projects: _p, ...settingsFromDefaults } = fileDefaults as typeof fileDefaults & { projects?: string[] };
    // Контексты и окружения из defaults.json не подставляем, если уже есть в data.json (при копировании defaults.json при деплое не затирать сохранённые)
    const fileDefaultsForMerge = { ...settingsFromDefaults };
    if (data && typeof data.contextOptions === "string" && data.contextOptions.trim() !== "")
      delete fileDefaultsForMerge.contextOptions;
    if (data && typeof data.environmentOptions === "string" && data.environmentOptions.trim() !== "")
      delete fileDefaultsForMerge.environmentOptions;
    const migrated = { ...DEFAULT_SETTINGS, ...fileDefaultsForMerge, ...data } as PluginSettings & {
      refreshMode?: string;
    };
    if (typeof migrated.refreshMode !== "undefined") {
      migrated.enablePluginRefresh = migrated.refreshMode === "plugin";
      delete migrated.refreshMode;
    }
    if (typeof migrated.gamificationXpLevelBase !== "number" || migrated.gamificationXpLevelBase < 1)
      migrated.gamificationXpLevelBase = DEFAULT_SETTINGS.gamificationXpLevelBase;
    if (typeof migrated.gamificationDefaultDifficulty !== "string")
      migrated.gamificationDefaultDifficulty = DEFAULT_SETTINGS.gamificationDefaultDifficulty;
    if (
      !migrated.gamificationDifficultyRewards ||
      typeof migrated.gamificationDifficultyRewards !== "object"
    )
      migrated.gamificationDifficultyRewards = { ...DEFAULT_DIFFICULTY_REWARDS };
    if (typeof migrated.gamificationStreakGraceDays !== "number" || migrated.gamificationStreakGraceDays < 0)
      migrated.gamificationStreakGraceDays = DEFAULT_SETTINGS.gamificationStreakGraceDays;
    const withSyncedTrash: PluginSettings = {
      ...migrated,
      enableTrash: migrated.enableInbox || migrated.enableReminders || migrated.enableTrash,
    };
    this.settings = withSyncedTrash;
    this.cachedDefaultShop = _g?.defaultShop?.length ? _g.defaultShop : [];
    this.cachedDefaultProjects = _p ?? [];
  }

  /** Читает defaults.json в папке плагина (contextOptions, environmentOptions, gamification.defaultShop, projects). */
  private async readDefaultsFromFile(): Promise<
    Partial<Pick<PluginSettings, "contextOptions" | "environmentOptions">> & {
      gamification?: { defaultShop?: GamificationDefaults["defaultShop"] };
      projects?: string[];
    }
  > {
    const path = `.obsidian/plugins/${this.manifest.id}/defaults.json`;
    try {
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) return {};
      const raw = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Partial<Pick<PluginSettings, "contextOptions" | "environmentOptions">> & {
        gamification?: { defaultShop?: GamificationDefaults["defaultShop"] };
        projects?: string[];
      } = {};
      if (typeof parsed.contextOptions === "string") out.contextOptions = parsed.contextOptions;
      if (typeof parsed.environmentOptions === "string") out.environmentOptions = parsed.environmentOptions;
      if (Array.isArray(parsed.projects))
        out.projects = (parsed.projects as unknown[]).filter((p): p is string => typeof p === "string");
      const g = parsed.gamification;
      if (g && typeof g === "object" && !Array.isArray(g)) {
        const shop = (g as { defaultShop?: { name: string; cost: number; description?: string }[] }).defaultShop;
        if (Array.isArray(shop) && shop.length > 0)
          out.gamification = {
            defaultShop: shop.filter(
              (i) => i && typeof i.name === "string" && typeof i.cost === "number"
            ) as { name: string; cost: number; description?: string }[],
          };
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Дефолты геймификации: из настроек (награды, XP за уровень) + defaultShop из defaults.json. */
  get gamificationDefaults(): GamificationDefaults {
    return {
      xpLevelBase: this.settings.gamificationXpLevelBase ?? DEFAULT_GAMIFICATION_DEFAULTS.xpLevelBase,
      defaultDifficulty:
        this.settings.gamificationDefaultDifficulty ?? DEFAULT_GAMIFICATION_DEFAULTS.defaultDifficulty,
      difficultyRewards:
        this.settings.gamificationDifficultyRewards ?? DEFAULT_GAMIFICATION_DEFAULTS.difficultyRewards,
      defaultShop: this.cachedDefaultShop?.length ? this.cachedDefaultShop : undefined,
    };
  }

  /** Путь к data.json в каталоге плагина (геймификация + проекты). */
  getGamificationDataPath(): string {
    return `.obsidian/plugins/${this.manifest.id}/data.json`;
  }

  /**
   * Читает data.json напрямую с диска (обход кэша Obsidian).
   * Нужно при загрузке/сохранении настроек, чтобы не затирать актуальные contextOptions/environmentOptions устаревшим кэшем.
   */
  private async readDataFromDisk(): Promise<Record<string, unknown> | null> {
    const path = this.getGamificationDataPath();
    try {
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) return null;
      const raw = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Получить состояние геймификации (из кэша или с диска). */
  async getGamificationState(): Promise<GamificationState> {
    if (this.gamificationState) return this.gamificationState;
    this.gamificationState = await readState(this);
    return this.gamificationState;
  }

  /** Отложенная запись состояния геймификации на диск. */
  scheduleGamificationSave(): void {
    if (this.gamificationSaveTimeout) clearTimeout(this.gamificationSaveTimeout);
    this.gamificationSaveTimeout = setTimeout(() => {
      this.gamificationSaveTimeout = null;
      this.flushGamificationSave();
    }, GAMIFICATION_SAVE_DEBOUNCE_MS);
  }

  /** Немедленная запись на диск (например при unload). */
  async flushGamificationSave(): Promise<void> {
    if (!this.gamificationState) return;
    try {
      await writeState(this, this.gamificationState);
    } catch (e) {
      console.error("[OPA] gamification save error:", e);
    }
  }

  /** Список проектов из data.json (при пустом — из defaults.json). Удаление из списка только по событию delete. */
  async getProjects(): Promise<string[]> {
    const data = await readDataFile(this);
    const raw = data.projects?.length ? data.projects : this.cachedDefaultProjects;
    return [...raw].sort();
  }

  /** Проекты, отсортированные по количеству задач (популярные сверху). Если дашборд выключен — как getProjects(). */
  async getProjectsSortedByTaskCount(): Promise<string[]> {
    const projects = await this.getProjects();
    if (!this.tasksDashboard) return projects;
    const counts = await this.tasksDashboard.getTaskCountByProject();
    return [...projects].sort(
      (a, b) => (counts.get(b.toLowerCase().trim()) ?? 0) - (counts.get(a.toLowerCase().trim()) ?? 0)
    );
  }

  /** Добавить проект в список (в data.json). Вызывается после создания проекта по шаблону. */
  async addProject(noteName: string): Promise<void> {
    const data = await readDataFile(this);
    const projects = data.projects ?? [];
    const name = noteName.trim();
    if (!name || projects.includes(name)) return;
    await writeDataFile(this, {
      gamification: data.gamification,
      projects: [...projects, name].sort(),
      reminders: data.reminders ?? [],
      inbox: data.inbox ?? [],
      trash: data.trash ?? [],
    });
    this.triggerDashboardRefresh();
  }

  async saveSettings(): Promise<void> {
    const raw = (await this.readDataFromDisk()) ?? (await this.loadData());
    const currentData = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const {
      enableGamification,
      enableReminders,
      enableInbox,
      enableTasksDashboard,
      enableTrash,
      enablePluginRefresh,
      enableDeadline,
      enableDeadlineReminders,
      deadlineReminderLeadDays,
      enableStatusChangeComment,
      environmentOptions,
      contextOptions,
      gamificationXpLevelBase,
      gamificationDefaultDifficulty,
      gamificationDifficultyRewards,
      enableActivities,
    } = this.settings;
    const newData = {
      ...currentData,
      enableGamification,
      enableReminders,
      enableInbox,
      enableTasksDashboard,
      enableTrash,
      enablePluginRefresh,
      enableDeadline,
      enableDeadlineReminders,
      deadlineReminderLeadDays,
      enableStatusChangeComment,
      environmentOptions,
      contextOptions,
      gamificationXpLevelBase,
      gamificationDefaultDifficulty,
      gamificationDifficultyRewards,
      enableActivities,
    };
    await this.saveData(newData);
  }

  /** Обновить блоки дашборда (страницы проектов/дома). Вызывать после создания задачи. */
  triggerDashboardRefresh(): void {
    this.tasksDashboard?.forceRefresh();
  }

  /** Обновить блоки корзины (после удаления в корзину из напоминаний/инбокса). */
  triggerTrashRefresh(): void {
    this.trash?.forceRefresh();
  }

  /** Обновить блоки инбокса (после добавления записи). */
  triggerInboxRefresh(): void {
    this.inbox?.forceRefresh();
  }

  /** Открыть модалку создания задачи с предзаполненным названием (из блокнота); onSuccess вызывается после успешного создания. */
  openCreateTaskFromInbox(
    defaultName: string,
    onSuccess: () => void | Promise<void>
  ): void {
    this.noteTemplates?.openCreateTask({ defaultName, onSuccess });
  }

  /** Открыть модалку создания напоминания из блокнота; при успехе вызывается onSuccess, затем обновляются блоки напоминаний. */
  async openCreateReminderFromInbox(
    defaultText: string,
    onSuccess: (result: { text: string; date: Date; recurrence: string }) => Promise<void>
  ): Promise<void> {
    if (!this.reminders) return;
    const result = await this.reminders.openReminderModal(defaultText);
    if (result) {
      await onSuccess(result);
      this.reminders.updateState?.();
    }
  }

  getModuleContext() {
    return {
      app: this.app,
      plugin: this,
      taskIndex: this.taskIndex,
      remindersIndex: this.remindersIndex,
      eventBus: this.eventBus,
    };
  }

  loadActiveModules(): void {
    const ctx = this.getModuleContext();

    if (!this.tasksDashboard) {
      this.tasksDashboard = new TasksDashboardModule(ctx, REFRESH_DEBOUNCE_MS);
      this.tasksDashboard.load();
    }
    if (!this.taskView) {
      this.taskView = new TaskViewModule(ctx);
      this.taskView.load();
    }
    if (!this.gamification) {
      this.gamification = new GamificationModule(ctx);
      this.gamification.load();
    }
    if (!this.reminders) {
      this.reminders = new RemindersModule(ctx);
      this.reminders.load();
    }
    if (!this.inbox) {
      this.inbox = new InboxModule(ctx);
      this.inbox.load();
    }
    if (!this.trash) {
      this.trash = new TrashModule(ctx);
      this.trash.load();
    }
    if (!this.noteTemplates) {
      this.noteTemplates = new NoteTemplatesModule(ctx);
      this.noteTemplates.load();
    }
    if (!this.activities) {
      this.activities = new ActivitiesModule(ctx);
      this.activities.load();
    }

    this.gamification?.updateState?.();
    this.reminders?.updateState?.();
    this.inbox?.updateState?.();
    this.trash?.updateState?.();
    this.tasksDashboard?.updateState?.();
    this.activities?.updateState?.();
  }

  private unloadModule(module: PluginModule | null): void {
    if (module) {
      module.unload();
    }
  }

  private unloadAllModules(): void {
    this.unloadModule(this.tasksDashboard);
    this.tasksDashboard = null;
    this.unloadModule(this.taskView);
    this.taskView = null;
    this.unloadModule(this.gamification);
    this.gamification = null;
    this.unloadModule(this.reminders);
    this.reminders = null;
    this.unloadModule(this.inbox);
    this.inbox = null;
    this.unloadModule(this.trash);
    this.trash = null;
    this.unloadModule(this.noteTemplates);
    this.noteTemplates = null;
    this.unloadModule(this.activities);
    this.activities = null;
  }

  /** Вызывается при смене настроек: оповестить модули, перерисовать блоки. */
  applySettings(): void {
    this.gamification?.updateState?.();
    this.reminders?.updateState?.();
    this.inbox?.updateState?.();
    this.trash?.updateState?.();
    this.tasksDashboard?.updateState?.();
    this.activities?.updateState?.();
  }
}

class ObsidianProjectAutomationSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ObsidianProjectAutomationPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsidian Project Automation" });

    new Setting(containerEl).setName("Проекты и задачи");
    const projectsWrap = containerEl.createDiv({ cls: "opa-settings-projects-wrap" });
    projectsWrap.style.marginLeft = "1.2em";
    projectsWrap.style.paddingLeft = "0.8em";

    // Перечитываем data.json при открытии вкладки, чтобы в форме отображались актуальные contextOptions/environmentOptions
    this.plugin.loadSettings().then(() => this.renderSettingsForm(containerEl, projectsWrap));
  }

  private renderSettingsForm(containerEl: HTMLElement, projectsWrap: HTMLElement): void {
    new Setting(projectsWrap)
      .setName("Окружения")
      .setDesc("Варианты окружения через запятую (например: prod, dev)")
      .addText((t) =>
        t
          .setPlaceholder("prod, dev")
          .setValue(this.plugin.settings.environmentOptions ?? "")
          .onChange(async (v) => {
            this.plugin.settings.environmentOptions = v;
            await this.plugin.saveSettings();
          })
      );
    new Setting(projectsWrap)
      .setName("Контексты")
      .setDesc("Варианты контекста через запятую (например: личное, работа)")
      .addText((t) =>
        t
          .setPlaceholder("личное, работа")
          .setValue(this.plugin.settings.contextOptions ?? "")
          .onChange(async (v) => {
            this.plugin.settings.contextOptions = v;
            await this.plugin.saveSettings();
          })
      );
    new Setting(projectsWrap)
      .setName("Пример шаблона задачи")
      .setDesc("Создать файл templates/task-templates/task-example.md с примером шаблона")
      .addButton((btn) =>
        btn.setButtonText("Создать пример").onClick(() => this.plugin.noteTemplates?.createExampleTaskTemplate())
      );
    new Setting(projectsWrap)
      .setName("Дедлайн")
      .setDesc("Показывать поле дедлайн в проектах и доске задач")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableDeadline ?? false).onChange(async (v) => {
          this.plugin.settings.enableDeadline = v;
          await this.plugin.saveSettings();
          this.plugin.tasksDashboard?.scheduleRefresh();
          this.display();
        })
      );
    if (this.plugin.settings.enableDeadline) {
      const deadlineWrap = projectsWrap.createDiv({ cls: "opa-settings-deadline-wrap" });
      deadlineWrap.style.marginLeft = "1.2em";
      deadlineWrap.style.paddingLeft = "0.8em";
      new Setting(deadlineWrap)
        .setName("Напоминание для дедлайна")
        .setDesc("При создании задачи с дедлайном добавлять напоминание")
        .addToggle((t) =>
          t.setValue(this.plugin.settings.enableDeadlineReminders ?? true).onChange(async (v) => {
            this.plugin.settings.enableDeadlineReminders = v;
            await this.plugin.saveSettings();
          })
        );
      const leadDaysSetting = new Setting(deadlineWrap)
        .setName("За сколько дней напоминать")
        .setDesc("За сколько дней до дедлайна срабатывает напоминание (0 — в день дедлайна)")
        .addText((t) =>
          t
            .setPlaceholder("1")
            .setValue(String(this.plugin.settings.deadlineReminderLeadDays ?? 1))
            .onChange(async (v) => {
              const n = parseInt(v, 10);
              if (!Number.isNaN(n) && n >= 0) {
                this.plugin.settings.deadlineReminderLeadDays = n;
                await this.plugin.saveSettings();
              }
            })
        );
      leadDaysSetting.controlEl.addClass("opa-settings-lead-days");
    }

    new Setting(projectsWrap)
      .setName("Комментарий при смене статуса задачи")
      .setDesc("При смене статуса задачи предлагать указать причину (добавляется в раздел \"Описание задачи\")")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableStatusChangeComment ?? false).onChange(async (v) => {
          this.plugin.settings.enableStatusChangeComment = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Доска задач")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableTasksDashboard).onChange(async (v) => {
          this.plugin.settings.enableTasksDashboard = v;
          await this.plugin.saveSettings();
          this.plugin.tasksDashboard?.updateState?.();
        })
      );

    new Setting(containerEl)
      .setName("Напоминания")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableReminders).onChange(async (v) => {
          this.plugin.settings.enableReminders = v;
          this.plugin.settings.enableTrash =
            this.plugin.settings.enableInbox || this.plugin.settings.enableReminders;
          await this.plugin.saveSettings();
          this.plugin.reminders?.updateState?.();
          this.plugin.trash?.updateState?.();
          this.plugin.inbox?.updateState?.();
        })
      );

    new Setting(containerEl)
      .setName("Блокнот")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableInbox).onChange(async (v) => {
          this.plugin.settings.enableInbox = v;
          this.plugin.settings.enableTrash =
            this.plugin.settings.enableInbox || this.plugin.settings.enableReminders;
          await this.plugin.saveSettings();
          this.plugin.inbox?.updateState?.();
          this.plugin.trash?.updateState?.();
        })
      );

    new Setting(containerEl)
      .setName("Активности")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableActivities ?? true).onChange(async (v) => {
          this.plugin.settings.enableActivities = v;
          await this.plugin.saveSettings();
          this.plugin.activities?.updateState?.();
        })
      );

    new Setting(containerEl)
      .setName("Геймификация")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableGamification).onChange(async (v) => {
          this.plugin.settings.enableGamification = v;
          await this.plugin.saveSettings();
          this.plugin.gamification?.updateState?.();
          this.display();
        })
      );

    if (this.plugin.settings.enableGamification) {
      const gamificationWrap = containerEl.createDiv({ cls: "opa-settings-gamification-wrap" });
      gamificationWrap.style.marginLeft = "1.2em";
      gamificationWrap.style.paddingLeft = "0.8em";

      const rewards = this.plugin.settings.gamificationDifficultyRewards ?? DEFAULT_DIFFICULTY_REWARDS;
      const saveRewards = async () => {
        await this.plugin.saveSettings();
        this.plugin.gamification?.updateState?.();
      };
      new Setting(gamificationWrap)
        .setName("Базовый XP за уровень")
        .setDesc(
          "Определяет, как быстро растёт уровень от накопленного XP: уровень = 1 + √(суммарный XP ÷ базовый XP). Чем больше число, тем медленнее рост уровня."
        )
        .addText((t) =>
          t
            .setPlaceholder("20")
            .setValue(String(this.plugin.settings.gamificationXpLevelBase ?? 20))
            .onChange(async (v) => {
              const n = parseInt(v, 10);
              if (!isNaN(n) && n >= 1) this.plugin.settings.gamificationXpLevelBase = n;
              await saveRewards();
            })
        );
      new Setting(gamificationWrap)
        .setName("Грейс-период для стрика (дней)")
        .setDesc(
          "Дополнительные дни после срока повторения, в которые выполнение ещё сохраняет стрик. 0 = в течение суток (до конца следующего дня по шагу повторения)."
        )
        .addText((t) =>
          t
            .setPlaceholder("0")
            .setValue(String(this.plugin.settings.gamificationStreakGraceDays ?? 0))
            .onChange(async (v) => {
              const n = parseInt(v, 10);
              if (!isNaN(n) && n >= 0) {
                this.plugin.settings.gamificationStreakGraceDays = n;
                await saveRewards();
              }
            })
        );
      new Setting(gamificationWrap)
        .setName("Сложность по умолчанию")
        .setDesc("Если у задачи не указана сложность")
        .addDropdown((d) => {
          d.addOption("легкая", "Легкая")
            .addOption("средняя", "Средняя")
            .addOption("сложная", "Сложная")
            .setValue(this.plugin.settings.gamificationDefaultDifficulty ?? "легкая")
            .onChange(async (v) => {
              this.plugin.settings.gamificationDefaultDifficulty = v;
              await saveRewards();
            });
        });
      const xpGoldHint = " Первое поле - XP, второе - Gold.";
      const difficultyDesc: Record<"легкая" | "средняя" | "сложная", string> = {
        легкая: "XP и Gold за выполнение задачи легкой сложности." + xpGoldHint,
        средняя: "XP и Gold за выполнение задачи средней сложности." + xpGoldHint,
        сложная: "XP и Gold за выполнение задачи тяжелой сложности." + xpGoldHint,
      };
      for (const key of ["легкая", "средняя", "сложная"] as const) {
        const r = rewards[key] ?? { xp: 0, gold: 0 };
        new Setting(gamificationWrap)
          .setName(`Награда: ${key}`)
          .setDesc(difficultyDesc[key])
          .addText((t) =>
            t
              .setPlaceholder("XP (опыт)")
              .setValue(String(r.xp))
              .onChange(async (v) => {
                const n = parseInt(v, 10);
                if (!isNaN(n) && n >= 0) {
                  if (!this.plugin.settings.gamificationDifficultyRewards) this.plugin.settings.gamificationDifficultyRewards = { ...DEFAULT_DIFFICULTY_REWARDS };
                  const cur = this.plugin.settings.gamificationDifficultyRewards[key] ?? { xp: 0, gold: 0 };
                  this.plugin.settings.gamificationDifficultyRewards[key] = { ...cur, xp: n };
                  await saveRewards();
                }
              })
          )
          .addText((t) =>
            t
              .setPlaceholder("Gold")
              .setValue(String(r.gold))
              .onChange(async (v) => {
                const n = parseInt(v, 10);
                if (!isNaN(n) && n >= 0) {
                  if (!this.plugin.settings.gamificationDifficultyRewards) this.plugin.settings.gamificationDifficultyRewards = { ...DEFAULT_DIFFICULTY_REWARDS };
                  const cur = this.plugin.settings.gamificationDifficultyRewards[key] ?? { xp: 0, gold: 0 };
                  this.plugin.settings.gamificationDifficultyRewards[key] = { ...cur, gold: n };
                  await saveRewards();
                }
              })
          );
      }
    }

    new Setting(containerEl)
      .setName("Refresh")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enablePluginRefresh).onChange(async (v) => {
          this.plugin.settings.enablePluginRefresh = v;
          await this.plugin.saveSettings();
          this.plugin.tasksDashboard?.updateState?.();
        })
      );
  }
}

export default ObsidianProjectAutomationPlugin;
