/**
 * Безопасная работа с файлами через app.vault.process (атомарные изменения).
 * Замена io.read / io.modify — защита от race conditions при записи.
 */

import { App, TFile, Notice } from "obsidian";

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

/** Прочитать содержимое файла. */
export async function read(app: App, filePath: string): Promise<string | null> {
  const path = pathFrom(filePath);
  if (!path) return null;
  const file = app.vault.getAbstractFileByPath(path);
  if (!file || !(file instanceof TFile)) return null;
  return await app.vault.cachedRead(file);
}

/** Замена содержимого файла целиком. */
export async function modify(app: App, filePath: string, newContent: string): Promise<boolean> {
  const path = pathFrom(filePath);
  if (!path) return false;
  const file = app.vault.getAbstractFileByPath(path);
  if (!file || !(file instanceof TFile)) return false;
  await app.vault.modify(file, newContent);
  return true;
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
const TASK_DESCRIPTION_HEADING = "## Описание задачи";

/**
 * Добавить строку в секцию «## Описание задачи». Если секции нет — добавляет заголовок и строку в конец тела (после frontmatter).
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

  return processFile(app, file, (data) => {
    const lines = data.split("\n");
    const headingNorm = TASK_DESCRIPTION_HEADING.trim();
    const startIdx = lines.findIndex((l) => normalizeLine(l) === headingNorm || normalizeLine(l).includes("Описание задачи"));
    const insertLine = lineText.trim();
    if (!insertLine) return data;

    if (startIdx === -1) {
      const fmEnd = data.indexOf("\n---", 1);
      const insertAt = fmEnd >= 0 ? fmEnd + 4 : 0;
      const before = data.slice(0, insertAt).replace(/\n+$/, "");
      const after = data.slice(insertAt).replace(/^\n+/, "");
      return `${before}\n\n${TASK_DESCRIPTION_HEADING}\n- ${insertLine}\n${after}`;
    }

    const sectionLevel = 2;
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const m = lines[i].match(HEADING_LINE_REGEX);
      if (m && m[1].length <= sectionLevel) {
        endIdx = i;
        break;
      }
    }

    const contentAfterHeading = lines.slice(startIdx + 1, endIdx).join("\n").replace(/\n+$/, "");
    const newContent = contentAfterHeading
      ? `${contentAfterHeading}\n- ${insertLine}`
      : `- ${insertLine}`;
    const before = lines.slice(0, startIdx + 1).join("\n");
    const after = lines.slice(endIdx).join("\n");
    return `${before}\n${newContent}\n${after}`;
  });
}

/**
 * Границы секции под заголовком headingLine: конец — следующий заголовок
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
 * transform получает текущее тело и возвращает новое (null — не менять).
 * Возвращает true, если заголовок найден.
 */
export async function processSectionByHeading(
  app: App,
  file: TFile,
  headingLine: string,
  transform: (body: string) => string | null
): Promise<boolean> {
  let found = false;
  await processFile(app, file, (data) => {
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
  return found;
}

/**
 * Атомарная замена тела секции под заголовком (нормализует пустые строки по краям).
 */
export function replaceSectionByHeading(
  app: App,
  file: TFile,
  headingLine: string,
  newContent: string
): Promise<boolean> {
  return processSectionByHeading(app, file, headingLine, () =>
    (newContent ?? "").replace(/\n+$/, "").replace(/^\n+/, "")
  );
}

/** Нормализация пробелов для сравнения строк. */
export function normalizeLine(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** Поиск индекса строки по тексту (нормализация). */
export function findLineIndexByText(
  lines: string[],
  text: string,
  options?: { exact?: boolean }
): number {
  const exact = options?.exact === true;
  const searchNorm = normalizeLine(String(text).split("\n")[0]);
  if (!searchNorm) return -1;
  return lines.findIndex((line) => {
    const lineNorm = normalizeLine(line);
    return exact ? lineNorm === searchNorm : lineNorm.includes(searchNorm);
  });
}

/** Замена строки в содержимом по тексту. */
export function replaceLineByText(
  content: string,
  oldText: string,
  newText: string,
  options?: { exact?: boolean }
): string {
  const lines = content.split("\n");
  const idx = findLineIndexByText(lines, oldText, options);
  if (idx === -1) return content;
  lines[idx] = newText;
  return lines.join("\n");
}

/** Удаление строки по индексу. */
export function deleteLineAtIndex(
  content: string,
  index: number
): { content: string; removedLine: string | null } {
  const lines = content.split("\n");
  if (index < 0 || index >= lines.length) return { content, removedLine: null };
  const removedLine = lines[index];
  lines.splice(index, 1);
  return { content: lines.join("\n"), removedLine };
}

/** Переключение чекбокса в строке задачи (- [ ] / - [x]). */
export function toggleTaskCheckbox(line: string, isDone: boolean): string {
  const match = line.match(/^(\s*[-*]\s+)\[\s\]\s*(.*)$/);
  if (match) return isDone ? `${match[1]}[x] ${match[2]}` : line;
  const matchDone = line.match(/^(\s*[-*]\s+)\[x\]\s*(.*)$/i);
  if (matchDone) return !isDone ? `${matchDone[1]}[ ] ${matchDone[2]}` : line;
  return line;
}

/** Заменить чекбокс - [ ] на - [x] в файле (атомарно). */
export async function toggleCheckbox(
  app: App,
  file: TFile,
  taskText: string
): Promise<boolean> {
  const escaped = taskText.replace(/[[\]]/g, "\\$&");
  const regex = new RegExp(`^- \\[ \\] ${escaped}`, "m");
  return processFile(app, file, (content) =>
    content.replace(regex, (match) => match.replace("[ ]", "[x]"))
  );
}

/** Добавить текст в конец файла. */
export async function append(app: App, filePath: string, text: string): Promise<boolean> {
  const path = pathFrom(filePath);
  if (!path) return false;
  const file = app.vault.getAbstractFileByPath(path);
  if (!file || !(file instanceof TFile)) return false;
  await app.vault.append(file, text);
  return true;
}

/** Заменить содержимое; при изменении опционально показать уведомление. */
export async function replaceContent(
  app: App,
  filePath: string,
  newContent: string,
  options: { currentContent?: string; noticeMessage?: string } = {}
): Promise<boolean> {
  const { currentContent, noticeMessage } = options;
  if (currentContent !== undefined && newContent === currentContent) return true;
  const ok = await modify(app, filePath, newContent);
  if (ok && noticeMessage) {
    new Notice(noticeMessage);
  }
  return ok;
}
