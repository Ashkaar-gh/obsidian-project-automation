import { splitFrontmatterAndBody } from "./TaskTemplateContent";

const HEADING_LINE_REGEX = /^(#+)\s/;
const TASK_DESCRIPTION_HEADING = "## Описание задачи";
/**
 * Запасной вариант заголовка: тот же раздел второго уровня с опечаткой («Описании», «Описания») или в другом регистре.
 * В уже созданных задачах такие заголовки встречаются; без этого рядом появлялся второй раздел «## Описание задачи».
 */
const TASK_DESCRIPTION_HEADING_FALLBACK = /^## описани[еия] задачи$/i;

function normalizeLine(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** Индекс строки заголовка раздела описания: сначала точное совпадение, затем запасной вариант. */
export function findTaskDescriptionHeadingIndex(lines: readonly string[]): number {
  const headingNorm = normalizeLine(TASK_DESCRIPTION_HEADING);
  const exact = lines.findIndex((line) => normalizeLine(line) === headingNorm);
  if (exact !== -1) return exact;
  return lines.findIndex((line) => TASK_DESCRIPTION_HEADING_FALLBACK.test(normalizeLine(line)));
}

/** Добавить строку в текст секции описания задачи. */
export function appendLineToTaskDescriptionContent(data: string, lineText: string): string {
  const insertLine = lineText.trim();
  if (!insertLine) return data;

  const lines = data.split("\n");
  const startIdx = findTaskDescriptionHeadingIndex(lines);

  if (startIdx === -1) {
    // Раздел добавляется сразу после frontmatter (или в начало заметки без него). Горизонтальная линия
    // «---» в тексте заметки без frontmatter за его конец не принимается.
    const { frontmatter, body } = splitFrontmatterAndBody(data);
    const after = body.replace(/^\n+/, "");
    const section = `${TASK_DESCRIPTION_HEADING}\n- ${insertLine}\n${after}`;
    return frontmatter ? `${frontmatter}\n\n${section}` : section;
  }

  const sectionLevel = 2;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const match = lines[i].match(HEADING_LINE_REGEX);
    if (match && match[1].length <= sectionLevel) {
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
}

/**
 * Дописать многострочный текст (например, запись блокнота без первой строки) в конец раздела описания задачи
 * как есть, отделив пустой строкой от уже написанного и от следующего раздела. Раздела нет - он создаётся
 * сразу после frontmatter, как в appendLineToTaskDescriptionContent.
 */
export function appendBlockToTaskDescriptionContent(data: string, blockText: string): string {
  const block = String(blockText ?? "").replace(/\r\n?/g, "\n").trim();
  if (!block) return data;

  const lines = data.split("\n");
  const startIdx = findTaskDescriptionHeadingIndex(lines);

  if (startIdx === -1) {
    const { frontmatter, body } = splitFrontmatterAndBody(data);
    const after = body.replace(/^\n+/, "");
    const section = after ? `${TASK_DESCRIPTION_HEADING}\n${block}\n\n${after}` : `${TASK_DESCRIPTION_HEADING}\n${block}\n`;
    return frontmatter ? `${frontmatter}\n\n${section}` : section;
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const match = lines[i].match(HEADING_LINE_REGEX);
    if (match && match[1].length <= 2) {
      endIdx = i;
      break;
    }
  }

  const contentAfterHeading = lines.slice(startIdx + 1, endIdx).join("\n").replace(/\s+$/, "");
  const newContent = contentAfterHeading.trim() ? `${contentAfterHeading}\n\n${block}` : block;
  const before = lines.slice(0, startIdx + 1).join("\n");
  const after = lines.slice(endIdx).join("\n");
  return after ? `${before}\n${newContent}\n\n${after}` : `${before}\n${newContent}\n`;
}
