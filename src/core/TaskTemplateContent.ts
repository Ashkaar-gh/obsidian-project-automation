/**
 * Разбор текста шаблона задачи без Obsidian API (чистые функции, покрыты тестами):
 * frontmatter/тело, плейсхолдеры %%key%%, разделение на часть задачи и часть ежедневной заметки.
 */

export type TaskContentTarget = "task" | "daily" | "both";
export type SplitTemplateContent = { taskBody: string; dailyBody: string };

export function splitFrontmatterAndBody(content: string): { frontmatter: string; body: string } {
  const fmMatch = content.match(/^(---\r?\n[\s\S]*?\r?\n---)(\r?\n?[\s\S]*)$/);
  if (!fmMatch) return { frontmatter: "", body: content };
  return { frontmatter: fmMatch[1], body: fmMatch[2].replace(/^\r?\n/, "") };
}

export function replacePlaceholders(content: string, values: Record<string, string>): string {
  return content.replace(/%%([^%]+)%%/g, (placeholder, rawKey: string) => {
    const key = rawKey.trim();
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : placeholder;
  });
}

/** Удаляет строки, в которых остались неподставленные плейсхолдеры %%...%%. */
export function removeLinesWithUnfilledPlaceholders(content: string): string {
  return content
    .split("\n")
    .filter((line) => !/%%[^%]+%%/.test(line))
    .join("\n");
}

/**
 * Разложить тело шаблона на часть задачи и часть ежедневной заметки по маркерам
 * `<!-- opa:task -->`, `<!-- opa:daily -->`, `<!-- opa:both -->`, `<!-- opa:default -->`
 * (устаревшая запись `%%opa:task%%` тоже понимается). До первого маркера действует defaultTarget.
 */
export function splitTemplateBodyByTarget(body: string, defaultTarget: TaskContentTarget): SplitTemplateContent {
  const lines = body.split("\n");
  let currentTarget: TaskContentTarget = defaultTarget;
  const taskLines: string[] = [];
  const dailyLines: string[] = [];

  const legacyTargetByMarker: Record<string, TaskContentTarget | "default"> = {
    "%%opa:task%%": "task",
    "%%opa:daily%%": "daily",
    "%%opa:both%%": "both",
    "%%opa:default%%": "default",
  };

  const parseMarker = (line: string): TaskContentTarget | "default" | null => {
    const normalized = line.trim().toLowerCase();
    if (legacyTargetByMarker[normalized]) return legacyTargetByMarker[normalized];
    const htmlMarker = normalized.match(/^<!--\s*opa:(task|daily|both|default)\s*-->$/);
    if (!htmlMarker) return null;
    const mode = htmlMarker[1];
    if (mode === "task" || mode === "daily" || mode === "both" || mode === "default") return mode;
    return null;
  };

  for (const line of lines) {
    const markerTarget = parseMarker(line);
    if (markerTarget) {
      currentTarget = markerTarget === "default" ? defaultTarget : markerTarget;
      continue;
    }

    if (currentTarget === "task" || currentTarget === "both") taskLines.push(line);
    if (currentTarget === "daily" || currentTarget === "both") dailyLines.push(line);
  }

  const normalize = (value: string): string => value.replace(/\n{3,}/g, "\n\n").trim();
  return {
    taskBody: normalize(taskLines.join("\n")),
    dailyBody: normalize(dailyLines.join("\n")),
  };
}

/** Куда идёт текст шаблона до первого маркера: `opa_content_target` во frontmatter, по умолчанию - в задачу. */
export function parseTaskContentTargetFromTemplate(content: string): TaskContentTarget {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return "task";
  const line = fmMatch[1].match(/^opa_content_target\s*:\s*["']?([A-Za-z]+)["']?\s*(?:#.*)?$/m);
  const value = line ? line[1].trim().toLowerCase() : "";
  if (value === "task" || value === "daily" || value === "both") return value;
  return "task";
}
