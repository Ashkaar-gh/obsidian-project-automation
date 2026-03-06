/**
 * Кэш задач и дат из daily notes. Строится при старте по папке DAILY_FOLDER,
 * обновляется точечно по metadataCache.on("changed") / vault rename/delete.
 */

import type { App, TAbstractFile } from "obsidian";
import { TFile } from "obsidian";
import type { EventBus } from "./EventBus";
import { DAILY_FOLDER } from "./Paths";

export interface TaskDateEntry {
  taskName: string;
  date: Date;
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

  const pairs: TaskDateEntry[] = [];
  for (const h of cache?.headings ?? []) {
    const linkMatch = /\[\[(.*?)(?:\|.*?)?\]\]/.exec(h.heading);
    if (linkMatch)
      pairs.push({ taskName: linkMatch[1].trim().toLowerCase(), date: new Date(date.getTime()) });
  }
  return pairs;
}

export class TaskIndex {
  private map = new Map<string, Date[]>();
  private byFile = new Map<string, TaskDateEntry[]>();
  private dailyPaths = new Set<string>();
  private dailyFolder: string;
  private eventBus: EventBus;
  private changedCallback: ((file: TFile) => void) | null = null;
  private createCallback: ((file: TAbstractFile) => void) | null = null;
  private deleteCallback: ((file: TAbstractFile) => void) | null = null;
  private renameCallback: ((file: TAbstractFile, oldPath: string) => void) | null = null;
  private resolvedCallback: (() => void) | null = null;

  constructor(
    private app: App,
    eventBus: EventBus,
    dailyFolder: string = DAILY_FOLDER
  ) {
    this.eventBus = eventBus;
    this.dailyFolder = dailyFolder;
  }

  private notifyUpdated(): void {
    this.eventBus.emit("index:updated", undefined);
  }

  /** Получить индекс: taskName (lowercase) -> Date[]. */
  getMap(): Map<string, Date[]> {
    return this.map;
  }

  /** Даты по имени задачи (lowercase). */
  getDatesForTask(taskName: string): Date[] {
    const key = taskName.toLowerCase();
    return this.map.get(key) ?? [];
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

  /** Подписаться на изменения и при первом вызове выполнить buildFull. */
  ensureSubscribed(): void {
    if (this.byFile.size === 0 && this.dailyPaths.size === 0) this.buildFull();

    if (!this.resolvedCallback) {
      let hasBuilt = false;
      this.resolvedCallback = () => {
        if (!hasBuilt) {
          hasBuilt = true;
          this.buildFull();
          this.notifyUpdated();
        }
      };
      this.app.metadataCache.on("resolved", this.resolvedCallback);
    }

    if (!this.createCallback) {
      const prefix = this.dailyFolder.replace(/\/?$/, "") + "/";
      this.createCallback = (file: TAbstractFile) => {
        if (!file.path.startsWith(prefix) || !(file instanceof TFile)) return;
        this.dailyPaths.add(file.path);
        const pairs = getHeadingPairs(this.app, file);
        this.applyFileContribution(file.path, pairs);
        this.notifyUpdated();
      };
      this.app.vault.on("create", this.createCallback);
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

    if (!this.deleteCallback) {
      this.deleteCallback = (file: TAbstractFile) => {
        if (!this.dailyPaths.has(file.path)) return;
        this.removeFileContribution(file.path);
        this.notifyUpdated();
      };
      (this.app.vault as { on(n: "delete", cb: (f: TAbstractFile) => void): void }).on("delete", this.deleteCallback);
    }

    if (!this.renameCallback) {
      this.renameCallback = (file: TAbstractFile, oldPath: string) => {
        if (!this.dailyPaths.has(oldPath)) return;
        this.removeFileContribution(oldPath);
        this.dailyPaths.add(file.path);
        if (file instanceof TFile) {
          const pairs = getHeadingPairs(this.app, file);
          this.applyFileContribution(file.path, pairs);
        }
        this.notifyUpdated();
      };
      this.app.vault.on("rename", this.renameCallback);
    }
  }

  /** Отписаться от событий (при выгрузке модуля/плагина). */
  unsubscribe(): void {
    if (this.resolvedCallback) {
      this.app.metadataCache.off("resolved", this.resolvedCallback);
      this.resolvedCallback = null;
    }
    if (this.createCallback) {
      (this.app.vault as { off(n: "create", cb: (f: TAbstractFile) => void): void }).off("create", this.createCallback);
      this.createCallback = null;
    }
    if (this.changedCallback) {
      this.app.metadataCache.off("changed", this.changedCallback as (...data: unknown[]) => unknown);
      this.changedCallback = null;
    }
    if (this.deleteCallback) {
      (this.app.vault as { off(n: "delete", cb: (f: TAbstractFile) => void): void }).off("delete", this.deleteCallback);
      this.deleteCallback = null;
    }
    if (this.renameCallback) {
      this.app.vault.off("rename", this.renameCallback as (...data: unknown[]) => unknown);
      this.renameCallback = null;
    }
  }
}
