/**
 * Индекс напоминаний: из data.json и из .md файлов (любая заметка может содержать напоминания).
 * Чтение data.json — через loadData() плагина, чтобы не обходить кэш Obsidian.
 */

import type { App, TAbstractFile } from "obsidian";
import { TFile } from "obsidian";
import { Paths } from "./Paths";
import { read } from "./FileIO";
import {
  REMINDER_DATE_TAG_REGEX,
  lineToReminderItem,
  completedLineToReminderItem,
  type ReminderData,
} from "./ReminderDataUtils";

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
  private modifyCb: ((file: TAbstractFile) => void) | null = null;
  private resolvedCb: (() => void) | null = null;
  private builtOnce = false;
  /** Разрешается после первой полной сборки индекса. */
  private buildPromise: Promise<void> | null = null;
  private prefixTemplates: string;
  private trashPath: string;
  private dataPath: string;

  constructor(
    private app: App,
    private plugin: IPluginDataStorage
  ) {
    this.prefixTemplates = Paths.TEMPLATES_FOLDER.replace(/\/?$/, "") + "/";
    this.trashPath = Paths.TRASH_FILE;
    this.dataPath = plugin.getGamificationDataPath();
  }

  private isExcluded(path: string): boolean {
    return path.startsWith(this.prefixTemplates) || path === this.trashPath;
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
    const lines = await this.loadRemindersFromData();
    this.updateFileFromContent(this.dataPath, lines);

    const files = this.app.vault.getMarkdownFiles().filter((f) => !this.isExcluded(f.path));
    for (const file of files) {
      if (file.path === this.dataPath) continue;
      const content = await read(this.app, file.path);
      this.updateFileFromContent(file.path, content);
    }
  }

  /** Принудительно перечитать напоминания из data.json (вызывать после записи в data.json — adapter.write не всегда триггерит "modify"). */
  async refreshDataJson(): Promise<void> {
    const lines = await this.loadRemindersFromData();
    this.updateFileFromContent(this.dataPath, lines);
  }

  /** Обновить индекс по одному файлу (data.json или .md). */
  async updateFile(file: TFile): Promise<void> {
    if (file.path === this.dataPath) {
      const lines = await this.loadRemindersFromData();
      this.updateFileFromContent(this.dataPath, lines);
      return;
    }
    if (!file.path.endsWith(".md")) return;
    if (this.isExcluded(file.path)) {
      this.byFile.delete(file.path);
      return;
    }
    const content = await read(this.app, file.path);
    this.updateFileFromContent(file.path, content);
  }

  private updateFileFromContent(filePath: string, content: string[] | string | null): void {
    if (!content) {
      this.byFile.delete(filePath);
      this.completedByFile.delete(filePath);
      return;
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
    for (const item of candidates) {
      const trigger = item.displayTime
        ? item.date.getTime()
        : new Date(item.date.getFullYear(), item.date.getMonth(), item.date.getDate(), 10, 0, 0, 0).getTime();
      if (trigger >= now && trigger < nextTime) nextTime = trigger;
    }
    if (nextTime === Infinity) return null;
    return nextTime - now;
  }

  /** Подписаться на изменения data.json и .md файлов. Первая сборка — после загрузки хранилища (resolved). */
  ensureSubscribed(onUpdated?: () => void): void {
    if (!this.modifyCb) {
      this.modifyCb = (file: TAbstractFile) => {
        if (file instanceof TFile) {
          if (file.path === this.dataPath || (file.path.endsWith(".md") && !this.isExcluded(file.path))) {
            this.updateFile(file).then(() => onUpdated?.());
          }
        }
      };
      this.app.vault.on("modify", this.modifyCb);
    }
    if (!this.builtOnce) {
      this.builtOnce = true;
      if (this.app.metadataCache.initialized) {
        this.buildPromise = this.buildFull().then(() => onUpdated?.());
      } else {
        this.buildPromise = new Promise<void>((resolve) => {
          this.resolvedCb = () => {
            if (this.resolvedCb) {
              this.app.metadataCache.off("resolved", this.resolvedCb);
              this.resolvedCb = null;
            }
            this.buildFull().then(() => {
              onUpdated?.();
              resolve();
            });
          };
          this.app.metadataCache.on("resolved", this.resolvedCb);
        });
      }
    }
  }

  /** Дождаться завершения первой сборки индекса (для рендера). */
  waitReady(): Promise<void> {
    return this.buildPromise ?? Promise.resolve();
  }

  unsubscribe(): void {
    if (this.resolvedCb) {
      this.app.metadataCache.off("resolved", this.resolvedCb);
      this.resolvedCb = null;
    }
    if (this.modifyCb) {
      this.app.vault.off("modify", this.modifyCb);
      this.modifyCb = null;
    }
  }
}
