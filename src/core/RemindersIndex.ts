/**
 * Индекс напоминаний: из data.json и из .md файлов (любая заметка может содержать напоминания).
 * Чтение data.json - через loadData() плагина, чтобы не обходить кэш Obsidian.
 */

import { TFile, type App, type CachedMetadata, type EventRef, type TAbstractFile } from "obsidian";
import { Paths } from "./Paths";
import {
  REMINDER_DATE_TAG_REGEX,
  lineToReminderItem,
  completedLineToReminderItem,
  type ReminderData,
} from "./ReminderDataUtils";
import { REMINDER_REWARD_MARKER_PREFIX } from "./ReminderRewards";

/** Плагин или объект с loadData и путём к data.json (избегаем циклического импорта). */
export interface IPluginDataStorage {
  loadData(): Promise<unknown>;
  getGamificationDataPath(): string;
}

interface RawEntry {
  lineIndex: number;
  lineText: string;
}

export class RemindersIndex {
  private byFile = new Map<string, RawEntry[]>();
  private completedByFile = new Map<string, RawEntry[]>();
  private eventRefs: EventRef[] = [];
  private subscribed = false;
  /** Отложенная подписка на create/rename не должна сработать после unsubscribe. */
  private subscriptionGeneration = 0;
  private resolvedCb: (() => void) | null = null;
  private builtOnce = false;
  /** Разрешается после первой полной сборки индекса. */
  private buildPromise: Promise<void> | null = null;
  private resolvePendingBuild: (() => void) | null = null;
  private prefixTemplates: string;
  private trashPath: string;
  private dataPath: string;
  /** Свои записи: не перечитывать файл из кэша сразу после modify (иначе затирает новые даты). */
  private suppressModifyUntil = new Map<string, number>();
  private fileRevisions = new Map<string, number>();
  /**
   * Файлы с маркерами незавершённых наград за напоминания (см. ReminderRewards). Индекс и так читает
   * каждый файл, поэтому модулю напоминаний не нужно повторно сканировать хранилище при запуске.
   */
  private rewardMarkerFiles = new Set<string>();

  constructor(
    private app: App,
    private plugin: IPluginDataStorage
  ) {
    this.prefixTemplates = Paths.TEMPLATES_FOLDER.replace(/\/?$/, "") + "/";
    this.trashPath = Paths.TRASH_FILE;
    this.dataPath = plugin.getGamificationDataPath();
  }

  /** Файлы, в которых напоминания не ищутся: шаблоны и корзина. */
  isExcluded(path: string): boolean {
    return path.startsWith(this.prefixTemplates) || path === this.trashPath;
  }

  private removeFile(path: string): void {
    this.fileRevisions.set(path, (this.fileRevisions.get(path) ?? 0) + 1);
    this.byFile.delete(path);
    this.completedByFile.delete(path);
    this.rewardMarkerFiles.delete(path);
    this.suppressModifyUntil.delete(path);
  }

  /** Пути файлов, в которых остались маркеры незавершённых наград за напоминания. */
  getFilesWithRewardMarkers(): string[] {
    return [...this.rewardMarkerFiles];
  }

  private reportError(action: string, path: string, error: unknown): void {
    console.error(`[RemindersIndex] ${action} failed for ${path}:`, error);
  }

  /** Загрузить напоминания из data.json через кэш плагина. */
  private async loadRemindersFromData(): Promise<string[]> {
    try {
      const data = (await this.plugin.loadData()) as { reminders?: string[] } | null;
      return Array.isArray(data?.reminders) ? data.reminders : [];
    } catch {
      return [];
    }
  }

  /** Полная пересборка: data.json + все .md (кроме templates и Trash). */
  async buildFull(): Promise<void> {
    this.byFile.clear();
    this.completedByFile.clear();
    this.rewardMarkerFiles.clear();
    const lines = await this.loadRemindersFromData();
    this.updateFileFromContent(this.dataPath, lines);

    const files = this.app.vault.getMarkdownFiles().filter((f) => !this.isExcluded(f.path));
    for (const file of files) {
      if (file.path === this.dataPath) continue;
      // Файл, в котором по кэшу метаданных точно нет строк-чекбоксов, читать с диска незачем
      // (таких заметок в хранилище большинство).
      if (this.hasNoTaskLinesByCache(this.app.metadataCache.getFileCache(file))) continue;
      try {
        // Стартовая сборка: содержимое только читается, актуальность кэша Obsidian здесь достаточна
        // (после собственных записей индекс обновляется через updateFile с известным содержимым).
        const content = await this.app.vault.cachedRead(file);
        this.updateFileFromContent(file.path, content);
      } catch (error) {
        this.removeFile(file.path);
        this.reportError("initial read", file.path, error);
      }
    }
  }

  /**
   * По кэшу метаданных точно известно, что строк-чекбоксов в файле нет (ни одной задачи списка).
   * Чекбоксы внутри цитат и callout в listItems не попадают, но напоминаниями индекс их и так не считает:
   * строка должна начинаться с «- [ ]». Без кэша - false: файл читается.
   */
  private hasNoTaskLinesByCache(cache: CachedMetadata | null): boolean {
    if (!cache) return false;
    return !(cache.listItems ?? []).some((item) => item.task != null);
  }

  /** Принудительно перечитать напоминания из data.json (вызывать после записи в data.json - adapter.write не всегда триггерит "modify"). */
  async refreshDataJson(): Promise<void> {
    const lines = await this.loadRemindersFromData();
    this.updateFileFromContent(this.dataPath, lines);
  }

  /**
   * Обновить индекс по одному файлу (data.json или .md).
   * @param knownContent - уже известное содержимое после своей записи (обход устаревшего cachedRead).
   */
  async updateFile(file: TFile, knownContent?: string): Promise<void> {
    const revision = (this.fileRevisions.get(file.path) ?? 0) + 1;
    this.fileRevisions.set(file.path, revision);
    if (file.path === this.dataPath) {
      const lines = await this.loadRemindersFromData();
      if (this.fileRevisions.get(file.path) !== revision) return;
      this.updateFileFromContent(this.dataPath, lines);
      return;
    }
    if (!file.path.endsWith(".md")) return;
    if (this.isExcluded(file.path)) {
      this.removeFile(file.path);
      return;
    }
    // vault.read - актуальные данные; cachedRead сразу после process/modify может отставать.
    const content = knownContent ?? (await this.app.vault.read(file));
    if (this.fileRevisions.get(file.path) !== revision) return;
    this.updateFileFromContent(file.path, content);
  }

  private updateFileFromContent(filePath: string, content: string[] | string | null): void {
    if (!content) {
      this.removeFile(filePath);
      return;
    }
    if (typeof content === "string" && content.includes(REMINDER_REWARD_MARKER_PREFIX)) {
      this.rewardMarkerFiles.add(filePath);
    } else {
      this.rewardMarkerFiles.delete(filePath);
    }
    const lines = Array.isArray(content) ? content : content.split("\n");
    const entries: RawEntry[] = [];
    const completedEntries: RawEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = typeof line === "string" ? line.trim() : String(line).trim();
      const isUnchecked = trimmed.startsWith("- [ ]") || trimmed.startsWith("* [ ]");
      const isChecked = trimmed.startsWith("- [x]") || trimmed.startsWith("- [X]") || trimmed.startsWith("* [x]") || trimmed.startsWith("* [X]");
      if (!REMINDER_DATE_TAG_REGEX.test(trimmed)) continue;
      if (isUnchecked) entries.push({ lineIndex: i, lineText: trimmed });
      else if (isChecked) completedEntries.push({ lineIndex: i, lineText: trimmed });
    }
    if (entries.length === 0) this.byFile.delete(filePath);
    else this.byFile.set(filePath, entries);
    if (completedEntries.length === 0) this.completedByFile.delete(filePath);
    else this.completedByFile.set(filePath, completedEntries);
  }

  /** Синхронно вернуть актуальные данные напоминаний (overdue, today, tomorrow, upcoming, completed). */
  getReminderData(): ReminderData {
    const result: ReminderData = { overdue: [], today: [], tomorrow: [], upcoming: [], completed: [] };
    for (const [filePath, entries] of this.byFile) {
      for (const { lineIndex, lineText } of entries) {
        const item = lineToReminderItem(filePath, lineIndex, lineText);
        if (item) result[item.type].push(item);
      }
    }
    for (const [filePath, entries] of this.completedByFile) {
      for (const { lineIndex, lineText } of entries) {
        const item = completedLineToReminderItem(filePath, lineIndex, lineText);
        if (item) result.completed.push(item);
      }
    }
    for (const key of ["overdue", "today", "tomorrow", "upcoming"] as const) {
      result[key].sort((a, b) => a.date.getTime() - b.date.getTime());
    }
    result.completed.sort((a, b) => b.date.getTime() - a.date.getTime());
    return result;
  }

  /** Ближайшее время срабатывания (для умного таймера): мс до следующего напоминания или null. */
  getNextTriggerMs(): number | null {
    const data = this.getReminderData();
    const candidates = [...data.overdue, ...data.today, ...data.tomorrow, ...data.upcoming];
    if (candidates.length === 0) return null;
    const now = Date.now();
    let nextTime = Infinity;
    let hasDueNow = false;
    for (const item of candidates) {
      const trigger = item.displayTime
        ? item.date.getTime()
        : new Date(item.date.getFullYear(), item.date.getMonth(), item.date.getDate(), 10, 0, 0, 0).getTime();
      if (trigger <= now) {
        // Уже пора (просроченные / due сейчас) - проверить снова почти сразу
        hasDueNow = true;
      } else if (trigger < nextTime) {
        nextTime = trigger;
      }
    }
    if (hasDueNow) return 1000;
    if (nextTime === Infinity) return null;
    return nextTime - now;
  }

  /**
   * Не перечитывать path из vault по событию modify в течение ms.
   * Нужно после своей записи с knownContent - иначе cached/гонка возвращает старые даты в индекс.
   */
  suppressVaultModify(path: string, ms = 2000): void {
    this.suppressModifyUntil.set(path, Date.now() + ms);
  }

  private isModifySuppressed(path: string): boolean {
    const until = this.suppressModifyUntil.get(path);
    if (until == null) return false;
    if (Date.now() > until) {
      this.suppressModifyUntil.delete(path);
      return false;
    }
    return true;
  }

  /** Подписаться на изменения data.json и .md файлов. Первая сборка - после загрузки хранилища (resolved). */
  ensureSubscribed(onUpdated?: () => void): void {
    if (this.eventRefs.length === 0) {
      this.subscribed = true;
      const generation = ++this.subscriptionGeneration;
      const update = (file: TAbstractFile, action: "create" | "modify"): void => {
        if (!(file instanceof TFile)) return;
        if (action === "modify" && this.isModifySuppressed(file.path)) return;
        if (file.path !== this.dataPath && !file.path.endsWith(".md")) return;
        void this.updateFile(file)
          .then(() => onUpdated?.())
          .catch((error) => this.reportError(action, file.path, error));
      };
      const remove = (file: TAbstractFile): void => {
        this.removeFile(file.path);
        onUpdated?.();
      };
      const rename = (file: TAbstractFile, oldPath: string): void => {
        this.removeFile(oldPath);
        update(file, "create");
      };
      const register = (ref: EventRef): void => {
        this.eventRefs.push(ref);
        const plugin = this.plugin as IPluginDataStorage & { registerEvent?(ref: unknown): unknown };
        if (typeof plugin.registerEvent === "function") plugin.registerEvent(ref);
      };

      register(this.app.vault.on("modify", (file) => update(file, "modify")));
      register(this.app.vault.on("delete", remove));
      register(this.app.vault.on("rename", rename));
      // create приходит на каждый существующий файл при загрузке хранилища - все они и так попадают
      // в buildFull, а повторное чтение каждого файла здесь удвоило бы стартовую нагрузку. Файл, созданный
      // между снимком buildFull и готовностью layout, попадёт в индекс при первом своём modify.
      const attachCreate = (): void => {
        if (!this.subscribed || generation !== this.subscriptionGeneration) return;
        register(this.app.vault.on("create", (file) => update(file, "create")));
      };
      if (this.app.workspace.layoutReady) attachCreate();
      else this.app.workspace.onLayoutReady(attachCreate);
    }
    if (!this.builtOnce) {
      this.builtOnce = true;
      const runBuild = (): Promise<void> =>
        this.buildFull()
          .then(() => onUpdated?.())
          .catch((error) => this.reportError("initial build", "vault", error));
      // metadataCache.initialized есть в runtime, но не всегда в типах
      const cacheReady = (this.app.metadataCache as { initialized?: boolean }).initialized === true;
      if (cacheReady) {
        this.buildPromise = runBuild();
        // Кэш метаданных может ещё доиндексировать файлы, изменённые пока Obsidian был закрыт, а по кэшу
        // buildFull решает, какие файлы не читать: после первого «resolved» собираем ещё раз (как TaskIndex).
        this.onResolvedOnce(() => void runBuild());
      } else {
        this.buildPromise = new Promise<void>((resolve) => {
          this.resolvePendingBuild = resolve;
          this.onResolvedOnce(() => {
            void runBuild().finally(() => {
              this.resolvePendingBuild = null;
              resolve();
            });
          });
        });
      }
    }
  }

  /** Выполнить fn на ближайшем «resolved» (индексация хранилища завершена); подписка одноразовая. */
  private onResolvedOnce(fn: () => void): void {
    this.detachResolved();
    this.resolvedCb = () => {
      this.detachResolved();
      fn();
    };
    this.app.metadataCache.on("resolved", this.resolvedCb);
  }

  private detachResolved(): void {
    if (!this.resolvedCb) return;
    this.app.metadataCache.off("resolved", this.resolvedCb);
    this.resolvedCb = null;
  }

  /** Дождаться завершения первой сборки индекса (для рендера). */
  waitReady(): Promise<void> {
    return this.buildPromise ?? Promise.resolve();
  }

  unsubscribe(): void {
    this.detachResolved();
    this.resolvePendingBuild?.();
    this.resolvePendingBuild = null;
    for (const ref of this.eventRefs) this.app.vault.offref(ref);
    this.eventRefs = [];
    this.subscribed = false;
    this.subscriptionGeneration++;
    this.builtOnce = false;
    this.buildPromise = null;
  }
}
