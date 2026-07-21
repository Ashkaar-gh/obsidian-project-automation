/**
 * Кэш задач и дат из daily notes. Строится при старте по папке DAILY_FOLDER,
 * обновляется точечно по metadataCache.on("changed") / vault rename/delete.
 */

import type { App, EventRef, TAbstractFile } from "obsidian";
import { TFile } from "obsidian";
import type { EventBus } from "./EventBus";
import { DAILY_FOLDER } from "./Paths";

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

function parseDateFromFileName(name: string): Date | null {
  const clean = name.replace(/\.md$/i, "").trim();
  const formats = [
    /^(\d{4})-(\d{2})-(\d{2})$/,
    /^(\d{2})-(\d{2})-(\d{4})$/,
    /^(\d{2})\.(\d{2})\.(\d{4})$/,
  ];
  for (const re of formats) {
    const m = clean.match(re);
    if (!m) continue;
    let year: number, month: number, day: number;
    if (m[1].length === 4) {
      year = parseInt(m[1], 10);
      month = parseInt(m[2], 10) - 1;
      day = parseInt(m[3], 10);
    } else {
      day = parseInt(m[1], 10);
      month = parseInt(m[2], 10) - 1;
      year = parseInt(m[3], 10);
    }
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function getHeadingPairs(app: App, file: TFile): TaskDateEntry[] {
  const cache = app.metadataCache.getFileCache(file);
  let date = parseDateFromFileName(file.name);
  if (!date && file.stat?.mtime) date = new Date(file.stat.mtime);
  if (!date) return [];
  const resolvedDate = date;

  const pairs: TaskDateEntry[] = [];
  const seenInFile = new Set<string>();
  const addTask = (rawName: string) => {
    const key = normalizeTaskKey(rawName);
    if (!key || seenInFile.has(key)) return;
    seenInFile.add(key);
    pairs.push({ taskName: key, date: new Date(resolvedDate.getTime()) });
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
        addTask(l.link);
      }
    }

    // 2. Wikilink в тексте заголовка (если Obsidian сохранил [[...]] в h.heading)
    for (const target of extractWikiLinkTargets(h.heading)) {
      addTask(target);
    }

    // 3. Текст заголовка — как в TaskView (.includes при чтении индекса)
    if (h.heading.trim()) {
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
   * Даты по имени задачи. Сначала точное совпадение ключа, затем — как в TaskView (includes).
   */
  getDatesForTask(taskName: string): Date[] {
    const key = normalizeTaskKey(taskName);
    const direct = this.map.get(key);
    if (direct?.length) return [...direct];

    const merged: Date[] = [];
    const seen = new Set<number>();
    for (const [indexedName, dates] of this.map) {
      if (!indexedName.includes(key) && !key.includes(indexedName)) continue;
      for (const d of dates) {
        const t = d.getTime();
        if (seen.has(t)) continue;
        seen.add(t);
        merged.push(d);
      }
    }
    return merged;
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
    if (this.byFile.size === 0 && this.dailyPaths.size === 0) this.buildFull();
    if (this.subscribed) return;
    this.subscribed = true;

    if (!this.resolvedCallback) {
      this.resolvedCallback = () => this.scheduleResolvedRebuild();
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
      // create — только после layoutReady (иначе стартовый прогон всех файлов).
      const attachCreate = () => {
        if (!this.createCallback) return;
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
    if (this.resolvedCallback) {
      this.app.metadataCache.off("resolved", this.resolvedCallback);
      this.resolvedCallback = null;
    }
    if (this.changedCallback) {
      this.app.metadataCache.off("changed", this.changedCallback as (...data: unknown[]) => unknown);
      this.changedCallback = null;
    }
    // vault-события через registerEvent снимаются при unload плагина автоматически.
    this.createCallback = null;
    this.deleteCallback = null;
    this.renameCallback = null;
    this.subscribed = false;
  }
}
