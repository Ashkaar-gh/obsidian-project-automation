import { Notice, Plugin, TFile, type TAbstractFile } from "obsidian";
import { EventBus } from "./core/EventBus";
import { TaskIndex } from "./core/TaskIndex";
import { RemindersIndex } from "./core/RemindersIndex";
import { Paths } from "./core/Paths";
import { DEFAULT_HOMEPAGE } from "./core/DefaultTemplates";
import { openOrRevealFile } from "./core/WorkspaceUtils";
import {
  DEFAULT_GAMIFICATION_DEFAULTS,
  ACTIVITY_DIFFICULTY_REWARDS_DEFAULT,
  DIFFICULTY_REWARDS_DEFAULT,
  readDataFile,
  updateDataFile,
  writeDataFile,
  readState,
  normalizeGamificationState,
  type GamificationDefaults,
  type GamificationState,
} from "./core/GamificationState";
import { ObsidianProjectAutomationSettingTab } from "./ui/SettingsTab";
import { TasksDashboardModule } from "./modules/TasksDashboardModule";
import { GamificationModule } from "./modules/GamificationModule";
import { RemindersModule } from "./modules/RemindersModule";
import { InboxModule } from "./modules/InboxModule";
import { TrashModule } from "./modules/TrashModule";
import { TaskViewModule } from "./modules/TaskViewModule";
import { TaskViewSearchModule } from "./modules/TaskViewSearchModule";
import { OutlineModule } from "./modules/OutlineModule";
import { NoteTemplatesModule } from "./modules/NoteTemplatesModule";
import { ActivitiesModule } from "./modules/ActivitiesModule";
import { CalendarCompatModule } from "./modules/CalendarCompatModule";
import { TaskProjectLinkModule } from "./modules/TaskProjectLinkModule";
import type { PluginModule } from "./modules/types";

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
  /** Награды XP/золото по сложности активности (геймификация). */
  gamificationActivityDifficultyRewards: Record<string, { xp: number; gold: number }>;
  /** Сложность по умолчанию для активностей (геймификация). */
  gamificationActivityDefaultDifficulty: string;
  /** Награда за выполнение напоминания (фиксированная, без выбора сложности). */
  gamificationReminderRewards: { xp: number; gold: number };
  /** Награда за разбор записи в блокноте, кнопка «Архив» (фиксированная). */
  gamificationInboxRewards: { xp: number; gold: number };
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
  gamificationDifficultyRewards: { ...DIFFICULTY_REWARDS_DEFAULT },
  gamificationActivityDifficultyRewards: { ...ACTIVITY_DIFFICULTY_REWARDS_DEFAULT },
  gamificationActivityDefaultDifficulty: "легкая",
  gamificationReminderRewards: { xp: 2, gold: 1 },
  gamificationInboxRewards: { xp: 5, gold: 2 },
  gamificationStreakGraceDays: 0,
  enableActivities: true,
};

const REFRESH_DEBOUNCE_MS = 2000;

class InvalidConfigError extends Error {
  constructor(path: string, cause: unknown) {
    super(`Invalid JSON configuration: ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "InvalidConfigError";
  }
}

function finiteNonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeReward(value: unknown, fallback: { xp: number; gold: number }): { xp: number; gold: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const reward = value as Record<string, unknown>;
  return {
    xp: finiteNonNegative(reward.xp, fallback.xp),
    gold: finiteNonNegative(reward.gold, fallback.gold),
  };
}

function normalizeRewardMap(
  value: unknown,
  fallback: Record<string, { xp: number; gold: number }>
): Record<string, { xp: number; gold: number }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const result: Record<string, { xp: number; gold: number }> = {};
  for (const [key, reward] of Object.entries(value)) {
    if (!key || !reward || typeof reward !== "object" || Array.isArray(reward)) continue;
    const raw = reward as Record<string, unknown>;
    if (typeof raw.xp !== "number" || !Number.isFinite(raw.xp) || raw.xp < 0) continue;
    if (typeof raw.gold !== "number" || !Number.isFinite(raw.gold) || raw.gold < 0) continue;
    result[key] = { xp: raw.xp, gold: raw.gold };
  }
  return Object.keys(result).length ? result : { ...fallback };
}

export class ObsidianProjectAutomationPlugin extends Plugin {
  settings!: PluginSettings;
  taskIndex!: TaskIndex;
  remindersIndex!: RemindersIndex;
  /** Своя шина на каждый экземпляр плагина: при перезагрузке плагина слушатели не копятся. */
  eventBus = new EventBus();

  /** Кэш состояния геймификации в памяти. */
  private gamificationState: GamificationState | null = null;

  gamification: GamificationModule | null = null;
  /** Дефолтные товары магазина из defaults.json (только defaultShop). */
  private cachedDefaultShop: GamificationDefaults["defaultShop"] = [];
  /** Тестовые/дефолтные проекты из defaults.json (ссылки на заметки). */
  private cachedDefaultProjects: string[] = [];
  /** Запись запрещена, пока поврежденный data.json не будет исправлен и успешно перечитан. */
  private dataFileError: Error | null = null;
  reminders: RemindersModule | null = null;
  inbox: InboxModule | null = null;
  tasksDashboard: TasksDashboardModule | null = null;
  taskView: TaskViewModule | null = null;
  /** Поиск Ctrl+F в режиме редактирования находит и записи блока задачи. */
  taskViewSearch: TaskViewSearchModule | null = null;
  /** Панель «Структура» (заголовки заметки + записи из ежедневных заметок). */
  outline: OutlineModule | null = null;
  trash: TrashModule | null = null;
  noteTemplates: NoteTemplatesModule | null = null;
  activities: ActivitiesModule | null = null;
  /** Совместимость с плагином Calendar: календарь не дёргается при наборе текста в ежедневной заметке. */
  calendarCompat: CalendarCompatModule | null = null;
  /** Проект в свойствах задачи - ссылка на заметку проекта; команда «Открыть проект задачи». */
  taskProjectLink: TaskProjectLinkModule | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.taskIndex = new TaskIndex(this.app, this.eventBus, undefined, this);
    this.taskIndex.ensureSubscribed();
    this.remindersIndex = new RemindersIndex(this.app, this);

    this.addCommand({
      id: "open-or-create-homepage",
      name: "Открыть или создать домашнюю страницу",
      callback: () => this.openOrCreateHomepage(),
    });

    this.addSettingTab(new ObsidianProjectAutomationSettingTab(this.app, this));
    this.registerEvent(this.app.vault.on("delete", this.onVaultFileDeleted));
    this.registerEvent(this.app.vault.on("modify", this.onVaultModify));
    this.loadActiveModules();
  }

  private async openOrCreateHomepage(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(Paths.HOMEPAGE_FILE);
    if (file instanceof TFile) {
      await openOrRevealFile(this.app, file);
      return;
    }
    const created = await this.app.vault.create(Paths.HOMEPAGE_FILE, DEFAULT_HOMEPAGE);
    await this.app.workspace.getLeaf(true).openFile(created);
    new Notice("Создана домашняя страница. Настройте разделы под себя.");
  }

  onunload(): void {
    this.unloadAllModules();
    // Если onload прервался раньше (например, на чтении настроек), индексы могут быть не созданы
    this.remindersIndex?.unsubscribe();
    this.taskIndex?.unsubscribe();
  }

  private onVaultModify = (file: TAbstractFile): void => {
    if (file.path === this.getGamificationDataPath()) this.gamificationState = null;
  };

  private onVaultFileDeleted = (file: TAbstractFile): void => {
    const path = file.path;
    if (!path.toLowerCase().endsWith(".md")) return;
    const projectName = path.replace(/\.md$/i, "");
    void this.removeProjectIfInList(projectName).catch((error) =>
      console.error("[OPA] Failed to remove deleted project from the list:", error)
    );
  };

  private async removeProjectIfInList(projectName: string): Promise<void> {
    const baseName = projectName.split("/").pop() ?? projectName;
    const toRemove = new Set([projectName, baseName]);
    let removed = false;
    await updateDataFile(this, (d) => {
      const projects = d.projects ?? [];
      const next = projects.filter((p) => !toRemove.has(p));
      if (next.length === projects.length) return;
      removed = true;
      d.projects = next;
    });
    if (removed) this.tasksDashboard?.scheduleRefresh();
  }

  async loadSettings(): Promise<void> {
    const diskData = await this.readDataFromDisk();
    const data = diskData.status === "ok"
      ? diskData.data
      : diskData.status === "missing"
        ? (await this.loadData()) as Record<string, unknown> | null
        : null;
    const fileDefaults = await this.readDefaultsFromFile();
    const { gamification: _g, projects: _p, ...settingsFromDefaults } = fileDefaults;
    // Порядок важен: сохранённые настройки из data.json перекрывают defaults.json, а defaults.json - встроенные
    // значения. Контексты/окружения из defaults.json подставляются только пока их нет в data.json.
    const migrated = { ...DEFAULT_SETTINGS, ...settingsFromDefaults, ...data } as PluginSettings & {
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
      migrated.gamificationDifficultyRewards = { ...DIFFICULTY_REWARDS_DEFAULT };
    if (
      !migrated.gamificationActivityDifficultyRewards ||
      typeof migrated.gamificationActivityDifficultyRewards !== "object"
    )
      migrated.gamificationActivityDifficultyRewards = { ...ACTIVITY_DIFFICULTY_REWARDS_DEFAULT };
    if (typeof migrated.gamificationActivityDefaultDifficulty !== "string")
      migrated.gamificationActivityDefaultDifficulty = DEFAULT_SETTINGS.gamificationActivityDefaultDifficulty;
    if (
      !migrated.gamificationReminderRewards ||
      typeof migrated.gamificationReminderRewards !== "object" ||
      typeof (migrated.gamificationReminderRewards as { xp?: number; gold?: number }).xp !== "number" ||
      typeof (migrated.gamificationReminderRewards as { xp?: number; gold?: number }).gold !== "number"
    )
      migrated.gamificationReminderRewards = { ...DEFAULT_SETTINGS.gamificationReminderRewards };
    if (
      !migrated.gamificationInboxRewards ||
      typeof migrated.gamificationInboxRewards !== "object" ||
      typeof (migrated.gamificationInboxRewards as { xp?: number; gold?: number }).xp !== "number" ||
      typeof (migrated.gamificationInboxRewards as { xp?: number; gold?: number }).gold !== "number"
    )
      migrated.gamificationInboxRewards = { ...DEFAULT_SETTINGS.gamificationInboxRewards };
    if (typeof migrated.gamificationStreakGraceDays !== "number" || migrated.gamificationStreakGraceDays < 0)
      migrated.gamificationStreakGraceDays = DEFAULT_SETTINGS.gamificationStreakGraceDays;
    const bool = (value: unknown, fallback: boolean): boolean => typeof value === "boolean" ? value : fallback;
    const withSyncedTrash: PluginSettings = {
      enableGamification: bool(migrated.enableGamification, DEFAULT_SETTINGS.enableGamification),
      enableReminders: bool(migrated.enableReminders, DEFAULT_SETTINGS.enableReminders),
      enableInbox: bool(migrated.enableInbox, DEFAULT_SETTINGS.enableInbox),
      enableTasksDashboard: bool(migrated.enableTasksDashboard, DEFAULT_SETTINGS.enableTasksDashboard),
      enableTrash: bool(migrated.enableInbox, DEFAULT_SETTINGS.enableInbox) ||
        bool(migrated.enableReminders, DEFAULT_SETTINGS.enableReminders) ||
        bool(migrated.enableTrash, DEFAULT_SETTINGS.enableTrash),
      enablePluginRefresh: bool(migrated.enablePluginRefresh, DEFAULT_SETTINGS.enablePluginRefresh),
      enableDeadline: bool(migrated.enableDeadline, DEFAULT_SETTINGS.enableDeadline),
      enableDeadlineReminders: bool(migrated.enableDeadlineReminders, DEFAULT_SETTINGS.enableDeadlineReminders),
      deadlineReminderLeadDays: Math.floor(finiteNonNegative(migrated.deadlineReminderLeadDays, DEFAULT_SETTINGS.deadlineReminderLeadDays)),
      enableStatusChangeComment: bool(migrated.enableStatusChangeComment, DEFAULT_SETTINGS.enableStatusChangeComment),
      environmentOptions: typeof migrated.environmentOptions === "string" ? migrated.environmentOptions : DEFAULT_SETTINGS.environmentOptions,
      contextOptions: typeof migrated.contextOptions === "string" ? migrated.contextOptions : DEFAULT_SETTINGS.contextOptions,
      gamificationXpLevelBase: finiteNonNegative(migrated.gamificationXpLevelBase, DEFAULT_SETTINGS.gamificationXpLevelBase) || DEFAULT_SETTINGS.gamificationXpLevelBase,
      gamificationDefaultDifficulty: typeof migrated.gamificationDefaultDifficulty === "string" && migrated.gamificationDefaultDifficulty.trim() ? migrated.gamificationDefaultDifficulty : DEFAULT_SETTINGS.gamificationDefaultDifficulty,
      gamificationDifficultyRewards: normalizeRewardMap(migrated.gamificationDifficultyRewards, DEFAULT_SETTINGS.gamificationDifficultyRewards),
      gamificationActivityDifficultyRewards: normalizeRewardMap(migrated.gamificationActivityDifficultyRewards, DEFAULT_SETTINGS.gamificationActivityDifficultyRewards),
      gamificationActivityDefaultDifficulty: typeof migrated.gamificationActivityDefaultDifficulty === "string" && migrated.gamificationActivityDefaultDifficulty.trim() ? migrated.gamificationActivityDefaultDifficulty : DEFAULT_SETTINGS.gamificationActivityDefaultDifficulty,
      gamificationReminderRewards: normalizeReward(migrated.gamificationReminderRewards, DEFAULT_SETTINGS.gamificationReminderRewards),
      gamificationInboxRewards: normalizeReward(migrated.gamificationInboxRewards, DEFAULT_SETTINGS.gamificationInboxRewards),
      gamificationStreakGraceDays: Math.floor(finiteNonNegative(migrated.gamificationStreakGraceDays, DEFAULT_SETTINGS.gamificationStreakGraceDays)),
      enableActivities: bool(migrated.enableActivities, DEFAULT_SETTINGS.enableActivities),
    };
    // Объект настроек не подменяем: на него ссылается открытая вкладка настроек и модули
    this.settings = this.settings ? Object.assign(this.settings, withSyncedTrash) : withSyncedTrash;
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
    const path = `${this.getPluginDir()}/defaults.json`;
    try {
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) return {};
      const raw = await this.app.vault.adapter.read(path);
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new SyntaxError("Expected a JSON object");
      }
      const defaults = parsed as Record<string, unknown>;
      const out: Partial<Pick<PluginSettings, "contextOptions" | "environmentOptions">> & {
        gamification?: { defaultShop?: GamificationDefaults["defaultShop"] };
        projects?: string[];
      } = {};
      if (typeof defaults.contextOptions === "string") out.contextOptions = defaults.contextOptions;
      if (typeof defaults.environmentOptions === "string") out.environmentOptions = defaults.environmentOptions;
      if (Array.isArray(defaults.projects))
        out.projects = (defaults.projects as unknown[]).filter((p): p is string => typeof p === "string");
      const g = defaults.gamification;
      if (g && typeof g === "object" && !Array.isArray(g)) {
        const shop = (g as Record<string, unknown>).defaultShop;
        if (Array.isArray(shop) && shop.length > 0)
          out.gamification = {
            defaultShop: shop.flatMap((value) => {
              if (!value || typeof value !== "object" || Array.isArray(value)) return [];
              const item = value as Record<string, unknown>;
              if (typeof item.name !== "string" || !item.name.trim()) return [];
              if (typeof item.cost !== "number" || !Number.isFinite(item.cost) || item.cost < 0) return [];
              return [{
                name: item.name.trim(),
                cost: item.cost,
                ...(typeof item.description === "string" && { description: item.description }),
              }];
            }),
          };
      }
      return out;
    } catch (error) {
      const diagnostic = error instanceof SyntaxError ? new InvalidConfigError(path, error) : error;
      console.error(`[OPA] Failed to read ${path}:`, diagnostic);
      new Notice(`Не удалось прочитать ${path}. Используются встроенные значения по умолчанию.`);
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

  /** Каталог плагина внутри папки конфигурации хранилища (она не всегда называется .obsidian). */
  private getPluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  /** Путь к data.json в каталоге плагина (настройки, геймификация, проекты, напоминания, блокнот, корзина). */
  getGamificationDataPath(): string {
    return `${this.getPluginDir()}/data.json`;
  }

  /**
   * Читает data.json напрямую с диска (обход кэша Obsidian).
   * Нужно при загрузке/сохранении настроек, чтобы не затирать актуальные contextOptions/environmentOptions устаревшим кэшем.
   */
  private async readDataFromDisk(): Promise<
    { status: "missing" | "invalid" } | { status: "ok"; data: Record<string, unknown> }
  > {
    const path = this.getGamificationDataPath();
    try {
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) {
        this.dataFileError = null;
        return { status: "missing" };
      }
      const raw = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new SyntaxError("Expected a JSON object");
      }
      this.dataFileError = null;
      return { status: "ok", data: parsed as Record<string, unknown> };
    } catch (error) {
      const diagnostic = error instanceof SyntaxError ? new InvalidConfigError(path, error) : error;
      this.dataFileError = diagnostic instanceof Error ? diagnostic : new Error(String(diagnostic));
      console.error(`[OPA] Failed to read ${path}:`, diagnostic);
      new Notice(`Не удалось прочитать ${path}. Плагин работает без сохранения до исправления файла.`);
      return { status: "invalid" };
    }
  }

  get dataFileRecoveryRequired(): boolean {
    return this.dataFileError !== null;
  }

  /** Не позволяем Obsidian или модулям заменить поврежденный data.json fallback-данными. */
  async saveData(data: unknown): Promise<void> {
    if (this.dataFileError) {
      throw new Error(
        `data.json поврежден; запись заблокирована до успешного повторного чтения: ${this.dataFileError.message}`
      );
    }
    await super.saveData(data);
  }

  /** Получить состояние геймификации (из кэша или с диска). */
  async getGamificationState(): Promise<GamificationState> {
    if (this.gamificationState) return this.gamificationState;
    this.gamificationState = await readState(this);
    return this.gamificationState;
  }

  async refreshGamificationState(): Promise<GamificationState> {
    this.gamificationState = await readState(this);
    return this.gamificationState;
  }

  /** Изменить геймификацию от актуального состояния внутри общей очереди data.json. */
  async updateGamificationState(mutator: (state: GamificationState) => void): Promise<GamificationState> {
    let updated = normalizeGamificationState(undefined);
    await updateDataFile(this, (data) => {
      updated = normalizeGamificationState(data.gamification);
      mutator(updated);
      updated = normalizeGamificationState(updated);
      data.gamification = updated;
    });
    this.gamificationState = updated;
    return updated;
  }

  /** Список проектов из data.json (при пустом - из defaults.json). Удаление из списка только по событию delete. */
  async getProjects(): Promise<string[]> {
    const data = await readDataFile(this);
    const raw = data.projects?.length ? data.projects : this.cachedDefaultProjects;
    return [...raw].sort();
  }

  /** Проекты, отсортированные по количеству задач (популярные сверху). Если дашборд выключен - как getProjects(). */
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
    const name = noteName.trim();
    if (!name) return;
    let added = false;
    await updateDataFile(this, (d) => {
      const projects = d.projects ?? [];
      if (projects.includes(name)) return;
      added = true;
      d.projects = [...projects, name].sort();
    });
    if (added) this.triggerDashboardRefresh();
  }

  /** Сохранить все настройки в data.json (через очередь записи, поверх остальных данных). */
  async saveSettings(): Promise<void> {
    await writeDataFile(this, { ...this.settings });
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

  /**
   * Открыть модалку создания задачи с предзаполненным названием (из блокнота) и проектом (из привязки записи).
   * onSuccess получает файл задачи и вызывается, только если задача действительно создана.
   */
  openCreateTaskFromInbox(
    defaultName: string,
    onSuccess: (file: TFile) => void | Promise<void>,
    defaultProject?: string
  ): void {
    this.noteTemplates?.openCreateTask({ defaultName, onSuccess, defaultProject });
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
      // Запись прошла в data.json: событий хранилища на файлы конфига нет, индекс перечитывается явно -
      // иначе новое напоминание не появится в блоке до следующего изменения напоминаний.
      await this.reminders.afterExternalDataChange();
    }
  }

  /**
   * data.json изменён не этим экземпляром плагина (синхронизация, правка руками): Obsidian зовёт этот метод
   * вместо событий хранилища, которых для файлов конфига нет. Перечитываем настройки и все данные.
   */
  async onExternalSettingsChange(): Promise<void> {
    this.gamificationState = null;
    await this.loadSettings();
    await this.remindersIndex.refreshDataJson();
    // updateState каждого модуля перерисовывает его блоки принудительно (напоминания ещё и перепланируют таймер)
    this.applySettings();
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
    if (!this.taskViewSearch) {
      this.taskViewSearch = new TaskViewSearchModule(ctx);
      this.taskViewSearch.load();
    }
    if (!this.outline) {
      this.outline = new OutlineModule(ctx);
      this.outline.load();
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
    if (!this.calendarCompat) {
      this.calendarCompat = new CalendarCompatModule(ctx);
      this.calendarCompat.load();
    }
    if (!this.taskProjectLink) {
      this.taskProjectLink = new TaskProjectLinkModule(ctx);
      this.taskProjectLink.load();
    }

    this.applySettings();
  }

  private unloadModule(module: PluginModule | null): void {
    if (module) {
      module.unload();
    }
  }

  private unloadAllModules(): void {
    this.unloadModule(this.tasksDashboard);
    this.tasksDashboard = null;
    this.unloadModule(this.taskViewSearch);
    this.taskViewSearch = null;
    this.unloadModule(this.taskView);
    this.taskView = null;
    this.unloadModule(this.outline);
    this.outline = null;
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
    this.unloadModule(this.calendarCompat);
    this.calendarCompat = null;
    this.unloadModule(this.taskProjectLink);
    this.taskProjectLink = null;
  }

  /** Вызывается при смене настроек: оповестить модули, перерисовать блоки. */
  applySettings(): void {
    this.gamification?.updateState?.();
    this.reminders?.updateState?.();
    this.inbox?.updateState?.();
    this.trash?.updateState?.();
    this.tasksDashboard?.updateState?.();
    this.activities?.updateState?.();
    this.outline?.updateState?.();
  }
}

export default ObsidianProjectAutomationPlugin;
