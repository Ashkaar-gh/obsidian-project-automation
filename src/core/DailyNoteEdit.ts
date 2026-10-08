/**
 * Правки ежедневной заметки без Obsidian API (чистые функции, покрыты тестами):
 * название задачи из строки редактора, замена строки заголовком задачи, добавление заголовка в конец,
 * место курсора в секции задачи, заголовки и ссылки в них.
 */

/** Символы, недопустимые в имени файла задачи и в цели wikilink. */
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

/**
 * Название задачи из строки редактора: снимаются цитата, заголовок, маркер списка и чекбокс,
 * `[[ссылка]]` даёт свою цель, `**жирный**` - текст без звёздочек, запрещённые для имени файла символы убираются.
 * Берётся только первая строка.
 */
export function taskNameFromEditorLine(text: string): string {
  let s = (text ?? "").split("\n")[0] ?? "";
  s = s.replace(/^\s*(?:>\s*)+/, "");
  s = s.replace(/^\s*#{1,6}\s+/, "");
  s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
  s = s.replace(/^\s*\[[ xX]\]\s+/, "");
  const link = s.match(/^\s*\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]\s*$/);
  if (link) s = link[1];
  const bold = s.trim().match(/^\*\*(.+)\*\*$/);
  if (bold) s = bold[1];
  s = s.replace(FORBIDDEN_NAME_CHARS, "");
  return s.replace(/\s+/g, " ").trim();
}

/** Заголовок задачи в ежедневной заметке. */
export function dailyTaskHeading(taskName: string): string {
  return `### [[${taskName}]]`;
}

/** Блок заголовка задачи для ежедневной заметки; заканчивается переводом строки. */
export function buildDailyHeadingBlock(taskName: string): string {
  return `${dailyTaskHeading(taskName)}\n`;
}

/**
 * Заменить строку ежедневной заметки блоком заголовка задачи. Строка ищется по индексу (если её текст
 * совпадает с ожидаемым), иначе - первая строка с тем же текстом. null - строка не найдена (файл изменился).
 */
export function replaceLineWithHeadingBlock(
  content: string,
  lineIndex: number,
  originalLine: string,
  headingBlock: string
): string | null {
  const lines = content.split("\n");
  const norm = (s: string): string => s.replace(/\r$/, "").trim();
  const target = norm(originalLine);
  if (!target) return null;
  let idx = lineIndex >= 0 && lineIndex < lines.length && norm(lines[lineIndex]) === target ? lineIndex : -1;
  if (idx === -1) idx = lines.findIndex((l) => norm(l) === target);
  if (idx === -1) return null;
  const block = headingBlock.replace(/\n+$/, "");
  lines.splice(idx, 1, ...block.split("\n"));
  return lines.join("\n");
}

/**
 * Дописать блок заголовка в конец ежедневной заметки, отделив его пустой строкой от текста
 * (после строки навигации «← … | … →» пустая строка не нужна).
 */
export function appendHeadingBlockToDaily(content: string, headingBlock: string): string {
  let prefix = "";
  const trimmed = content.trim();
  if (trimmed.length > 0) {
    const isJustNavBar = trimmed.includes("←") && trimmed.includes("→") && trimmed.split("\n").length === 1;
    if (isJustNavBar) prefix = content.endsWith("\n") ? "" : "\n";
    else if (content.endsWith("\n\n")) prefix = "";
    else if (content.endsWith("\n")) prefix = "\n";
    else prefix = "\n\n";
  }
  return content + prefix + headingBlock;
}

/** Строка навигации ежедневной заметки: «← [[…]]  |  [[…]] →» (см. buildDailyNavLine). */
export function isDailyNavLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("←") && trimmed.endsWith("→");
}

/**
 * Куда поставить курсор в только что созданной ежедневной заметке: на строку сразу под навигацией,
 * чтобы начать писать без лишних движений (иначе курсор стоит в начале первой строки - на самой навигации).
 * Без строки навигации - в начало заметки. insertNewline - под навигацией нет ни одной строки:
 * вызывающий код сначала добавляет перевод строки.
 */
export function newDailyNoteCursor(lines: readonly string[]): { line: number; ch: number; insertNewline: boolean } {
  const navLine = lines.findIndex(isDailyNavLine);
  if (navLine === -1) return { line: 0, ch: 0, insertNewline: false };
  return { line: navLine + 1, ch: 0, insertNewline: navLine + 1 >= lines.length };
}

/**
 * Куда поставить курсор, чтобы продолжить запись в секции задачи (заголовок в строке headingLine):
 * в конец последней непустой строки секции, а в пустой секции - на строку сразу под заголовком.
 * insertNewline - под заголовком нет ни одной строки (конец файла или сразу следующий заголовок):
 * вызывающий код сначала добавляет перевод строки после заголовка.
 */
export function sectionCursorPosition(
  lines: readonly string[],
  headingLine: number
): { line: number; ch: number; insertNewline: boolean } {
  const level = lines[headingLine]?.match(/^\s{0,3}(#{1,6})\s/)?.[1].length ?? 6;
  let end = lines.length;
  for (let i = headingLine + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s{0,3}(#{1,6})\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  for (let i = end - 1; i > headingLine; i--) {
    if (lines[i].trim() !== "") return { line: i, ch: lines[i].length, insertNewline: false };
  }
  return { line: headingLine + 1, ch: 0, insertNewline: end === headingLine + 1 };
}

/** Заголовок markdown: номер строки, уровень (1-6) и текст без решёток. */
export interface MarkdownHeading {
  line: number;
  level: number;
  text: string;
}

const FENCE_LINE_REGEX = /^\s{0,3}(`{3,}|~{3,})/;
const ATX_HEADING_REGEX = /^\s{0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/**
 * Заголовки заметки по строкам. Строки внутри блоков кода (``` и ~~~) и frontmatter заголовками не считаются:
 * «# комментарий» в куске скрипта или в YAML не делит заметку на секции.
 */
export function markdownHeadings(lines: readonly string[]): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end > 0) start = end + 1;
  }
  let fence: string | null = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    const marker = line.match(FENCE_LINE_REGEX)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = line.match(ATX_HEADING_REGEX);
    if (!match) continue;
    const text = (match[2] ?? "").replace(/[ \t]+#+$/, "").trim();
    headings.push({ line: i, level: match[1].length, text });
  }
  return headings;
}

/** Цели [[ссылок]] в тексте: без #заголовка и |алиаса. */
export function wikiLinkTargets(text: string): string[] {
  const targets: string[] = [];
  const re = /\[\[([^|\]#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text ?? "")) !== null) {
    const target = match[1].trim();
    if (target) targets.push(target);
  }
  return targets;
}
