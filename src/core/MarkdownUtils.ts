/** Поиск/замена/удаление строк в markdown с нормализацией пробелов. */

function normalizeLine(text: string | null | undefined): string {
  if (text == null) return "";
  return String(text).replace(/\s+/g, " ").trim();
}

function findLineIndexByText(
  lines: string[],
  text: string,
  options: { exact?: boolean } = {}
): number {
  const exact = options.exact === true;
  const searchNorm = normalizeLine(String(text).split("\n")[0]);
  if (!searchNorm) return -1;
  return lines.findIndex((line) => {
    const lineNorm = normalizeLine(line);
    return exact ? lineNorm === searchNorm : lineNorm.includes(searchNorm);
  });
}

export function replaceLineByText(
  content: string,
  oldText: string,
  newText: string,
  options: { exact?: boolean } = {}
): string {
  const lines = content.split("\n");
  const idx = findLineIndexByText(lines, oldText, options);
  if (idx === -1) return content;
  lines[idx] = newText;
  return lines.join("\n");
}

export function deleteLineByText(
  content: string,
  text: string,
  options: { exact?: boolean } = {}
): { content: string; removedLine: string | null } {
  const lines = content.split("\n");
  const idx = findLineIndexByText(lines, text, options);
  if (idx === -1) return { content, removedLine: null };
  const removed = lines[idx];
  lines.splice(idx, 1);
  return { content: lines.join("\n"), removedLine: removed };
}
