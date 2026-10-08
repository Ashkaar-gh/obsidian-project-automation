/**
 * Кэш задач и дат из daily notes. Строится при старте по папке DAILY_FOLDER,
 * обновляется точечно по metadataCache.on("changed") / vault rename/delete.
 */

import { TFile, type App, type EventRef, type TAbstractFile } from "obsidian";
import type { EventBus } from "./EventBus";
import { DAILY_FOLDER } from "./Paths";
import { parseCalendarDate } from "./DateUtils";

/** Минимальный контракт для registerEvent (Plugin). */
export interface EventRegistrar {
  registerEvent(eventRef: EventRef): EventRef | void;
}

export interface TaskDateEntry {
  taskName: string;
  date: Date;
}

/** Единая нормализация имени задачи для ключей индекса. */
export function normalizeTaskKey(name: string): string {
  let n = name.split("/").pop() || name;
  n = n.split("#")[0].replace(/\s+/g, " ").trim().toLowerCase();
  if (n.endsWith(".md")) n = n.slice(0, -3).trim();
  return n;
}

function normalizeTaskPath(path: string): string {
  return path.split("#")[0].replace(/\\/g, "/").replace(/\.md$/i, "").trim().toLowerCase();
}

/** Все цели wikilink из строки (игнорирует алиас после |). */
function extractWikiLinkTargets(text: string): string[] {
  const targets: string[] = [];
  const re = /\[\[([^|\]#\]]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    targets.push(m[1]);
  }
  return targets;
}

function getHeadingPairs(app: App, file: TFile): TaskDateEntry[] {
  const cache = app.metadataCache.getFileCache(file);
  // Дата записи - только из имени ежедневной заметки. Прочие файлы в папке daily (README, шаблон)
  // датами задач не считаются: время их изменения ничего не говорит о работе над задачей.
  const resolvedDate = parseCalendarDate(file.name);
  if (!resolvedDate) return [];

  const pairs: TaskDateEntry[] = [];
  const seenInFile = new Set<string>();
  const addTask = (rawName: string) => {
    const key = normalizeTaskKey(rawName);
    if (!key || seenInFile.has(key)) return;
    seenInFile.add(key);
    pairs.push({ taskName: key, date: new Date(resolvedDate.getTime()) });
  };
  const addLinkTarget = (link: string) => {
    const destination = app.metadataCache.getFirstLinkpathDest(link, file.path);
    if (destination) {
      const pathKey = `path:${normalizeTaskPath(destination.path)}`;
      if (!seenInFile.has(pathKey)) {
        seenInFile.add(pathKey);
        pairs.push({ taskName: pathKey, date: new Date(resolvedDate.getTime()) });
      }
      addTask(destination.basename);
      return;
    }
    addTask(link);
  };

  const headings = cache?.headings ?? [];
  const links = cache?.links ?? [];

  for (const h of headings) {
    const start = h.position.start.offset;
    const end = h.position.end.offset;

    // 1. Ссылки из metadataCache в пределах строки заголовка (надёжнее, чем h.heading)
    for (const l of links) {
      const pos = l.position.start.offset;
      if (pos >= start && pos <= end) {
        addLinkTarget(l.link);
      }
    }

    // 2. Wikilink в тексте заголовка (если Obsidian сохранил [[...]] в h.heading)
    for (const target of extractWikiLinkTargets(h.heading)) {
      addLinkTarget(target);
    }

    // 3. Обычный текст заголовка сопоставляется только как полное имя задачи.
    if (h.heading.trim() && !extractWikiLinkTargets(h.heading).length) {
      addTask(h.heading);
    }
  }

  return pairs;
}

export class TaskIndex {
  private map = new Map<string, Date[]>();
  private byFile = new Map<string, TaskDateEntry[]>();
  private dailyPaths = new Set<string>();
  private dailyFolder: string;
  private eventBus: EventBus;
  private registrar: EventRegistrar | null;
  private changedCallback: ((file: TFile) => void) | null = null;
  private createCallback: ((file: TAbstractFile) => void) | null = null;
  private deleteCallback: ((file: TAbstractFile) => void) | null = null;
  private renameCallback: ((file: TAbstractFile, oldPath: string) => void) | null = null;
  private resolvedCallback: (() => void) | null = null;
  private resolvedRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private vaultEventRefs: EventRef[] = [];
  private subscriptionGeneration = 0;
  private subscribed = false;

  constructor(
    private app: App,
    eventBus: EventBus,
    dailyFolder: string = DAILY_FOLDER,
    registrar: EventRegistrar | null = null
  ) {
    this.eventBus = eventBus;
    this.dailyFolder = dailyFolder;
    this.registrar = registrar;
  }

  private registerVaultEvent(
    name: "create" | "delete" | "rename" | "modify",
    callback: (...args: never[]) => void
  ): void {
    const vault = this.app.vault as unknown as {
      on(e: string, cb: (...args: never[]) => void): EventRef;
    };
    const ref = vault.on(name, callback);
    this.vaultEventRefs.push(ref);
    if (this.registrar) this.registrar.registerEvent(ref);
  }

  private notifyUpdated(): void {
    // Схлопываем пачку событий (create/change на старте) в одно уведомление.
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.eventBus.emit("index:updated", undefined);
    }, 100);
  }

  /** Получить индекс: taskName (lowercase) -> Date[]. */
  getMap(): Map<string, Date[]> {
    return this.map;
  }

  /**
   * Даты по точному нормализованному имени или пути задачи.
   */
  getDatesForTask(taskName: string, taskPath?: string): Date[] {
    if (taskPath) {
      const byPath = this.map.get(`path:${normalizeTaskPath(taskPath)}`);
      if (byPath?.length) return [...byPath];
    }
    const key = normalizeTaskKey(taskName);
    const direct = this.map.get(key);
    return direct?.length ? [...direct] : [];
  }

  private removeFileContribution(filePath: string): void {
    const old = this.byFile.get(filePath) ?? [];
    for (const { taskName, date } of old) {
      const arr = this.map.get(taskName);
      if (arr) {
        const idx = arr.findIndex((d) => d.getTime() === date.getTime());
        if (idx !== -1) arr.splice(idx, 1);
        if (arr.length === 0) this.map.delete(taskName);
      }
    }
    this.byFile.delete(filePath);
    this.dailyPaths.delete(filePath);
  }

  private applyFileContribution(filePath: string, pairs: TaskDateEntry[]): void {
    const old = this.byFile.get(filePath) ?? [];
    for (const { taskName, date } of old) {
      const arr = this.map.get(taskName);
      if (arr) {
        const idx = arr.findIndex((d) => d.getTime() === date.getTime());
        if (idx !== -1) arr.splice(idx, 1);
        if (arr.length === 0) this.map.delete(taskName);
      }
    }
    this.byFile.set(filePath, pairs);
    for (const { taskName, date } of pairs) {
      if (!this.map.has(taskName)) this.map.set(taskName, []);
      this.map.get(taskName)!.push(date);
    }
  }

  /** Полная пересборка по папке daily. */
  buildFull(): void {
    this.map.clear();
    this.byFile.clear();
    this.dailyPaths.clear();

    const dailyFolderPath = this.dailyFolder;
    const prefix = dailyFolderPath.replace(/\/?$/, "") + "/";
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));

    for (const file of files) {
      const filePath = file.path;
      this.dailyPaths.add(filePath);
      const pairs = getHeadingPairs(this.app, file);
      this.applyFileContribution(filePath, pairs);
    }
  }

  private scheduleResolvedRebuild(): void {
    if (this.resolvedRebuildTimer) clearTimeout(this.resolvedRebuildTimer);
    this.resolvedRebuildTimer = setTimeout(() => {
      this.resolvedRebuildTimer = null;
      this.buildFull();
      this.notifyUpdated();
    }, 150);
  }

  /** Подписаться на изменения и при первом вызове выполнить buildFull. */
  ensureSubscribed(): void {
    if (this.subscribed) return;
    if (this.byFile.size === 0 && this.dailyPaths.size === 0) this.buildFull();
    this.subscribed = true;
    const generation = ++this.subscriptionGeneration;

    if (!this.resolvedCallback) {
      // Первая полная сборка могла пройти до окончания индексации хранилища - после первого «resolved»
      // пересобираем ещё раз. Дальше «resolved» приходит после каждой правки любого файла, и полная
      // пересборка там не нужна: точечные изменения ежедневных покрывает обработчик «changed».
      this.resolvedCallback = () => {
        this.detachResolved();
        this.scheduleResolvedRebuild();
      };
      this.app.metadataCache.on("resolved", this.resolvedCallback);
    }

    if (!this.changedCallback) {
      this.changedCallback = (file: TFile) => {
        if (!this.dailyPaths.has(file.path)) return;
        const pairs = getHeadingPairs(this.app, file);
        this.applyFileContribution(file.path, pairs);
        this.notifyUpdated();
      };
      this.app.metadataCache.on("changed", this.changedCallback);
    }

    const prefix = this.dailyFolder.replace(/\/?$/, "") + "/";

    if (!this.createCallback) {
      this.createCallback = (file: TAbstractFile) => {
        if (!file.path.startsWith(prefix) || !(file instanceof TFile)) return;
        this.dailyPaths.add(file.path);
        const pairs = getHeadingPairs(this.app, file);
        this.applyFileContribution(file.path, pairs);
        this.notifyUpdated();
      };
      // create - только после layoutReady (иначе стартовый прогон всех файлов).
      const attachCreate = () => {
        if (!this.createCallback || !this.subscribed || generation !== this.subscriptionGeneration) return;
        this.registerVaultEvent("create", this.createCallback as (...args: never[]) => void);
      };
      if (this.app.workspace.layoutReady) attachCreate();
      else this.app.workspace.onLayoutReady(attachCreate);
    }

    if (!this.deleteCallback) {
      this.deleteCallback = (file: TAbstractFile) => {
        if (!this.dailyPaths.has(file.path)) return;
        this.removeFileContribution(file.path);
        this.notifyUpdated();
      };
      this.registerVaultEvent("delete", this.deleteCallback as (...args: never[]) => void);
    }

    if (!this.renameCallback) {
      this.renameCallback = (file: TAbstractFile, oldPath: string) => {
        if (!this.dailyPaths.has(oldPath) && !file.path.startsWith(prefix)) return;
        this.removeFileContribution(oldPath);
        if (file.path.startsWith(prefix)) {
          this.dailyPaths.add(file.path);
          if (file instanceof TFile) {
            const pairs = getHeadingPairs(this.app, file);
            this.applyFileContribution(file.path, pairs);
          }
        }
        this.notifyUpdated();
      };
      this.registerVaultEvent("rename", this.renameCallback as (...args: never[]) => void);
    }
  }

  private detachResolved(): void {
    if (!this.resolvedCallback) return;
    this.app.metadataCache.off("resolved", this.resolvedCallback);
    this.resolvedCallback = null;
  }

  /** Отписаться от событий (при выгрузке модуля/плагина). */
  unsubscribe(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    if (this.resolvedRebuildTimer) {
      clearTimeout(this.resolvedRebuildTimer);
      this.resolvedRebuildTimer = null;
    }
    this.detachResolved();
    if (this.changedCallback) {
      this.app.metadataCache.off("changed", this.changedCallback as (...data: unknown[]) => unknown);
      this.changedCallback = null;
    }
    for (const ref of this.vaultEventRefs) this.app.vault.offref(ref);
    this.vaultEventRefs = [];
    this.subscriptionGeneration++;
    this.createCallback = null;
    this.deleteCallback = null;
    this.renameCallback = null;
    this.subscribed = false;
  }
}
