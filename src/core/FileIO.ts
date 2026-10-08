/**
 * Безопасная работа с файлами через app.vault.process (атомарные изменения) и чистые помощники
 * для строк/секций markdown.
 */

import { TFile, type App } from "obsidian";
import { appendLineToTaskDescriptionContent } from "./TaskDescriptionUtils";

export function pathFrom(pathOrFile: string | TFile | null | undefined): string | null {
  if (pathOrFile == null) return null;
  return typeof pathOrFile === "string" ? pathOrFile : pathOrFile.path;
}

/** Обновить одно поле frontmatter. */
export async function updateFrontmatter(
  app: App,
  filePath: string,
  key: string,
  value: unknown
): Promise<void> {
  const tFile = app.vault.getAbstractFileByPath(filePath);
  if (!tFile || !(tFile instanceof TFile)) {
    return;
  }
  await app.fileManager.processFrontMatter(tFile, (frontmatter) => {
    frontmatter[key] = value;
  });
}

/** Удалить поле из frontmatter. */
export async function removeFrontmatterKey(app: App, filePath: string, key: string): Promise<void> {
  const tFile = app.vault.getAbstractFileByPath(filePath);
  if (!tFile || !(tFile instanceof TFile)) return;
  await app.fileManager.processFrontMatter(tFile, (frontmatter) => {
    delete frontmatter[key];
  });
}

/** Прочитать содержимое файла (null - файла нет). */
export async function read(app: App, filePath: string): Promise<string | null> {
  const path = pathFrom(filePath);
  if (!path) return null;
  const file = app.vault.getAbstractFileByPath(path);
  if (!file || !(file instanceof TFile)) return null;
  return await app.vault.cachedRead(file);
}

/** Атомарная замена части содержимого: process возвращает новое содержимое. */
export async function processFile(
  app: App,
  file: TFile,
  processor: (content: string) => string
): Promise<boolean> {
  try {
    await app.vault.process(file, processor);
    return true;
  } catch {
    return false;
  }
}

const HEADING_LINE_REGEX = /^(#+)\s/;

/**
 * Добавить строку в секцию «## Описание задачи». Если секции нет - добавляет заголовок и строку в конец тела (после frontmatter).
 */
export async function appendLineToTaskDescriptionSection(
  app: App,
  filePath: string,
  lineText: string
): Promise<boolean> {
  const path = pathFrom(filePath);
  if (!path) return false;
  const file = app.vault.getAbstractFileByPath(path);
  if (!file || !(file instanceof TFile)) return false;

  return processFile(app, file, (data) => appendLineToTaskDescriptionContent(data, lineText));
}

/**
 * Границы секции под заголовком headingLine: конец - следующий заголовок
 * того же или более высокого уровня (не подзаголовки). null, если заголовок не найден.
 */
export function findSectionBounds(
  lines: string[],
  headingLine: string
): { startIdx: number; endIdx: number } | null {
  const headingTrimmed = headingLine.trim();
  const sectionLevel = headingTrimmed.match(HEADING_LINE_REGEX)?.[1].length ?? 6;
  const startIdx = lines.findIndex((l) => l.trim() === headingTrimmed);
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(HEADING_LINE_REGEX);
    if (m && m[1].length <= sectionLevel) {
      endIdx = i;
      break;
    }
  }
  return { startIdx, endIdx };
}

/**
 * Атомарное преобразование тела секции под заголовком (vault.process).
 * transform получает текущее тело и возвращает новое (null - не менять).
 * Возвращает true, если заголовок найден.
 */
export async function processSectionByHeading(
  app: App,
  file: TFile,
  headingLine: string,
  transform: (body: string) => string | null
): Promise<boolean> {
  let found = false;
  const processed = await processFile(app, file, (data) => {
    const lines = data.split("\n");
    const bounds = findSectionBounds(lines, headingLine);
    if (!bounds) return data;
    found = true;
    const body = lines.slice(bounds.startIdx + 1, bounds.endIdx).join("\n");
    const newBody = transform(body);
    if (newBody == null || newBody === body) return data;
    const before = lines.slice(0, bounds.startIdx + 1).join("\n");
    const after = lines.slice(bounds.endIdx).join("\n");
    return `${before}\n${newBody}\n${after}`;
  });
  return found && processed;
}

/**
 * Атомарная замена тела секции под заголовком (нормализует пустые строки по краям).
 * Пустые строки, отделявшие секцию от следующего заголовка, сохраняются -
 * иначе каждое сохранение «склеивало» секции в ежедневной заметке.
 */
export function replaceSectionByHeading(
  app: App,
  file: TFile,
  headingLine: string,
  newContent: string
): Promise<boolean> {
  return processSectionByHeading(app, file, headingLine, (body) => {
    const trailingBlankLines = body.match(/\n*$/)?.[0] ?? "";
    const normalized = (newContent ?? "").replace(/\n+$/, "").replace(/^\n+/, "");
    return normalized + (body.trim() === "" ? "" : trailingBlankLines);
  });
}

/** Нормализация пробелов для сравнения строк. */
export function normalizeLine(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Индекс строки по тексту (сравнение после нормализации пробелов, по первой строке text).
 * Точное совпадение предпочтительнее; нечёткое (вхождение) допустимо только при единственном кандидате.
 */
export function findUniqueLineIndexByText(lines: string[], text: string): number {
  const searchNorm = normalizeLine(String(text).split("\n")[0]);
  if (!searchNorm) return -1;
  const normalized = lines.map(normalizeLine);
  const exactIndex = normalized.findIndex((line) => line === searchNorm);
  if (exactIndex !== -1) return exactIndex;

  const candidates: number[] = [];
  normalized.forEach((line, index) => {
    if (line.includes(searchNorm)) candidates.push(index);
  });
  return candidates.length === 1 ? candidates[0] : -1;
}

/** Переключение чекбокса в строке задачи (- [ ] / - [x]). */
export function toggleTaskCheckbox(line: string, isDone: boolean): string {
  const match = line.match(/^(\s*[-*]\s+)\[\s\]\s*(.*)$/);
  if (match) return isDone ? `${match[1]}[x] ${match[2]}` : line;
  const matchDone = line.match(/^(\s*[-*]\s+)\[x\]\s*(.*)$/i);
  if (matchDone) return !isDone ? `${matchDone[1]}[ ] ${matchDone[2]}` : line;
  return line;
}
