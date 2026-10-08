/**
 * Признак заметки-задачи по frontmatter. Общий для доски задач и команд, которым нужен контекст «открыта задача».
 * Без Obsidian API: файл описывается только именем и путём.
 */

import { Paths } from "./Paths";
import { TASK_VIEW_LANGUAGE, findCodeBlockRanges } from "./TaskViewSearch";

export interface TaskNoteFileLike {
  path: string;
  basename: string;
}

/** Значения project из frontmatter в плоский список непустых строк. */
export function flattenProjectField(project: unknown): string[] {
  if (project == null) return [];
  if (Array.isArray(project)) return project.flatMap((p) => flattenProjectField(p));
  const s = String(project).trim();
  return s ? [s] : [];
}

/**
 * Корневая заметка проекта (шаблон project.md): project совпадает с именем файла.
 * Такие файлы не должны попадать в доску как задачи.
 */
export function isProjectHubPage(file: TaskNoteFileLike, fm: Record<string, unknown>): boolean {
  const base = file.basename;
  for (const v of flattenProjectField(fm.project)) {
    const segment = v.replace(/\.md$/i, "").split("/").pop()?.trim() ?? "";
    if (segment === base) return true;
  }
  return false;
}

/**
 * Заметка-задача: во frontmatter есть status, project или group.
 * Корневая страница проекта (project совпадает с именем файла) не считается задачей.
 */
export function isTaskNote(
  file: TaskNoteFileLike,
  cache: { frontmatter?: Record<string, unknown> } | null | undefined
): boolean {
  const fm = cache?.frontmatter;
  if (!fm) return false;
  if (isProjectHubPage(file, fm)) return false;
  return fm.status != null || fm.project != null || fm.group != null;
}

/** Файл лежит в папке шаблонов (у шаблонов задач тот же frontmatter, но это не задачи). */
export function isTemplateFile(file: TaskNoteFileLike): boolean {
  return file.path.startsWith(Paths.TEMPLATES_FOLDER.replace(/\/?$/, "") + "/");
}

/** Блок записей блокнота в заметке-задаче: записи, привязанные к этой задаче. */
export const TASK_INBOX_BLOCK = "opa-task-inbox";
/** Блок записей блокнота в заметке проекта: записи, привязанные к проекту и к его задачам. */
export const PROJECT_INBOX_BLOCK = "opa-project-inbox";
/** Блок задач проекта в его заметке (перед ним встаёт «Блокнот» проекта). */
const PROJECT_VIEW_LANGUAGE = "opa-project-view";

const blockLineRegex = (language: string): RegExp =>
  new RegExp("^\\s{0,3}(`{3,}|~{3,})\\s*" + language + "\\s*$", "m");
const TASK_INBOX_BLOCK_LINE = blockLineRegex(TASK_INBOX_BLOCK);
const PROJECT_INBOX_BLOCK_LINE = blockLineRegex(PROJECT_INBOX_BLOCK);

/** Есть ли в заметке блок записей блокнота. */
export function hasTaskInboxBlock(content: string): boolean {
  return TASK_INBOX_BLOCK_LINE.test(String(content ?? ""));
}

/** Есть ли в заметке проекта блок записей блокнота. */
export function hasProjectInboxBlock(content: string): boolean {
  return PROJECT_INBOX_BLOCK_LINE.test(String(content ?? ""));
}

const FRONTMATTER_REGEX = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

const isBlank = (line: string): boolean => line.trim() === "";

/** Строки без пустых в конце. */
function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && isBlank(lines[end - 1])) end--;
  return lines.slice(0, end);
}

/**
 * Пустой блок кода language - перед первым блоком anchor, а без него - в конец заметки. От текста выше и от блока
 * anchor он отделён пустой строкой.
 */
function insertBlockBefore(text: string, language: string, anchor: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const block = ["```" + language, "```"];
  const view = findCodeBlockRanges(text, anchor)[0];
  if (view) {
    const head = trimTrailingBlank(lines.slice(0, view.lineStart));
    return [...head, ...(head.length > 0 ? [""] : []), ...block, "", ...lines.slice(view.lineStart)].join(eol);
  }
  const head = trimTrailingBlank(lines);
  return [...head, ...(head.length > 0 ? [""] : []), ...block, ""].join(eol);
}

/**
 * Заметка с блоком записей блокнота: перед блоком задачи (```opa-task-view, его «Оглавление» и записи), а в заметке
 * без него - в конце. От текста выше и от блока задачи блок отделён пустой строкой. null - блок уже есть.
 */
export function addTaskInboxBlock(content: string): string | null {
  const text = String(content ?? "");
  if (hasTaskInboxBlock(text)) return null;
  return insertBlockBefore(text, TASK_INBOX_BLOCK, TASK_VIEW_LANGUAGE);
}

/**
 * Заметка проекта с блоком записей блокнота: перед списком задач проекта (```opa-project-view), а без него -
 * в конце. null - блок уже есть.
 */
export function addProjectInboxBlock(content: string): string | null {
  const text = String(content ?? "");
  if (hasProjectInboxBlock(text)) return null;
  return insertBlockBefore(text, PROJECT_INBOX_BLOCK, PROJECT_VIEW_LANGUAGE);
}

/**
 * Блок записей блокнота, который прошлая версия плагина ставила в начало задачи (сразу после frontmatter), -
 * на новое место, перед блоком задачи. null - переносить нечего: блок не в начале, не пустой или блока задачи нет.
 */
export function moveTaskInboxBlockToTaskView(content: string): string | null {
  const text = String(content ?? "");
  const inbox = findCodeBlockRanges(text, TASK_INBOX_BLOCK)[0];
  const view = findCodeBlockRanges(text, TASK_VIEW_LANGUAGE)[0];
  if (!inbox || !view || inbox.lineEnd !== inbox.lineStart + 1 || view.lineStart < inbox.lineEnd) return null;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const frontmatter = text.match(FRONTMATTER_REGEX);
  const bodyStart = frontmatter ? frontmatter[0].split(/\r?\n/).length - (/\n$/.test(frontmatter[0]) ? 1 : 0) : 0;
  if (!lines.slice(bodyStart, inbox.lineStart).every(isBlank)) return null;
  // Уже стоит прямо перед блоком задачи (между ними только пустые строки) - так и оставить.
  if (lines.slice(inbox.lineEnd + 1, view.lineStart).every(isBlank)) return null;
  let after = inbox.lineEnd + 1;
  while (after < lines.length && isBlank(lines[after])) after++;
  const without = [...lines.slice(0, inbox.lineStart), ...lines.slice(after)].join(eol);
  return addTaskInboxBlock(without);
}
