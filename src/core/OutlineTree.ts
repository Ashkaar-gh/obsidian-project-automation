/**
 * Панель «Структура»: дерево заголовков заметки вместе с пунктами «Оглавления» записей задачи
 * (их собирает блок opa-task-view из ежедневных заметок) и заголовками блоков плагина
 * (Напоминания, Блокнот…), которые рисует сам плагин. Чистая логика, без Obsidian API.
 */

/** Заголовок самой заметки (из кэша метаданных). */
export interface OutlineHeadingInput {
  text: string;
  level: number;
  /** Строка заголовка в файле (0-based). */
  line: number;
}

/** Пункт «Оглавления» записей задачи: то же, что показывает блок opa-task-view, плюс данные для перехода. */
export interface OutlineTocItem {
  /** Текст подзаголовка записи (или дата, если подзаголовков нет ни у одной записи). */
  text: string;
  /** Уровень относительно заголовка секции в ежедневной заметке (1 - ближайший). */
  level: number;
  /** Дата записи (имя ежедневной заметки). */
  dateText: string;
  /** Пункт - сама запись (дата), а не её подзаголовок. */
  isDateOnly: boolean;
  /** Ключ записи - атрибут data-entry-key записи в DOM блока. */
  entryKey: string;
  /** Какая по счёту запись с таким же ключом (одна задача дважды в одной ежедневной заметке). */
  entryOrdinal: number;
  /** Индекс подзаголовка в записи; null - пункт-дата. */
  subIndex: number | null;
  /** Какой по счёту в записи подзаголовок с таким же текстом (0 - первый). */
  occurrence: number;
  /** Путь ежедневной заметки. */
  sourcePath: string;
  /** Строка заголовка в ежедневной заметке (0-based), если известна. */
  line: number | null;
}

/** Блок плагина с заголовком (Напоминания, Блокнот…) в заметке. */
export interface OutlineBlockTitleInput {
  /** Строка начала блока кода (0-based). */
  line: number;
  title: string;
  /** Язык блока кода (opa-reminders-view…). */
  language: string;
  /** Какой по счёту в заметке блок этого языка (0 - первый). */
  ordinal: number;
}

export interface OutlineNode {
  /** Устойчивый ключ узла (для свёрнутости): не зависит от номеров строк. */
  id: string;
  kind: "heading" | "entry" | "block";
  text: string;
  /** Дата записи: выводится после текста в скобках. */
  suffix?: string;
  level: number;
  /** Строка заголовка (heading) или начала блока кода (block) в заметке. */
  line?: number;
  /** Пункт оглавления записи (kind = entry). */
  item?: OutlineTocItem;
  /** Блок плагина (kind = block). */
  block?: { language: string; ordinal: number };
  children: OutlineNode[];
}

const TASK_VIEW_LANGUAGE = "opa-task-view";

/** Текст заголовка без markdown-разметки - как он выглядит в заметке. */
export function cleanHeadingText(raw: string): string {
  const source = String(raw ?? "");
  const text = source
    // [[цель|алиас]] → алиас; [[цель#раздел]] → «цель > раздел»
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/!?\[\[([^\]]*)\]\]/g, (_match, target: string) =>
      target
        .split(/#\^?/)
        .map((part) => part.trim())
        .filter(Boolean)
        .join(" > ")
    )
    // [текст](адрес) и ![alt](картинка) → текст
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^\p{L}\p{N}_])__(.+?)__(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/\*(?!\s)([^*]+?)\*/g, "$1")
    // _курсив_ только на границе слова: iceberg_rest_vertica остаётся как есть
    .replace(/(^|[^\p{L}\p{N}_])_(?!\s)([^_]+?)_(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/==(.+?)==/g, "$1")
    .replace(/\s+#+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || source.trim();
}

/**
 * Ключ для сравнения заголовка из кэша с отрисованным (textContent): без разметки, регистра, лишних пробелов
 * и символов «#» (в подзаголовках записей блок задачи убирает все «#»: «C#», «#42», теги).
 */
export function headingMatchKey(text: string): string {
  return cleanHeadingText(text).replace(/#/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Строка (0-based), где начинается блок ```opa-task-view; null - блока в заметке нет. */
export function findTaskViewBlockLine(content: string): number | null {
  return findPluginBlocks(content).find((block) => block.language === TASK_VIEW_LANGUAGE)?.line ?? null;
}

/** Блоки кода плагина (```opa-…) в заметке: язык и строка начала, по порядку. Вне frontmatter и других блоков кода. */
export function findPluginBlocks(content: string): { language: string; line: number }[] {
  const blocks: { language: string; line: number }[] = [];
  const lines = String(content ?? "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""));
  let start = 0;
  if (lines[0] === "---") {
    const end = lines.findIndex((line, i) => i > 0 && (line === "---" || line === "..."));
    if (end > 0) start = end + 1;
  }
  let fence: string | null = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`~]*)/);
    if (!open) continue;
    const language = open[2].toLowerCase();
    if (language.startsWith("opa-")) blocks.push({ language, line: i });
    fence = open[1];
  }
  return blocks;
}

/**
 * Дерево для панели. Заголовки заметки вкладываются по уровням, как в стандартном Outline.
 * Пункты записей встают на место блока opa-task-view на верхнем уровне заметки (рядом с её разделами,
 * а не внутри раздела, где стоит блок), вложенность между собой - по уровням подзаголовков.
 * Заголовки блоков плагина (titledBlocks) встают на место блока внутри раздела, где он стоит.
 * Заголовки заметки после блока к пунктам записей и заголовкам блоков не цепляются.
 */
export function buildOutlineTree(
  headings: OutlineHeadingInput[],
  block: { line: number; items: OutlineTocItem[] } | null,
  titledBlocks: OutlineBlockTitleInput[] = []
): OutlineNode[] {
  const root: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  const seen = new Map<string, number>();
  const uniqueId = (base: string): string => {
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${count}`;
  };
  const top = (): OutlineNode | undefined => stack[stack.length - 1];

  const sorted = [...headings].sort((a, b) => a.line - b.line);
  const baseLevel = sorted.length > 0 ? Math.min(...sorted.map((h) => h.level)) : 1;

  const insertTaskView = (): void => {
    if (!block) return;
    while (stack.length > 0 && top()!.level >= baseLevel) stack.pop();
    const parentChildren = top()?.children ?? root;
    const local: OutlineNode[] = [];
    for (const item of block.items) {
      const level = baseLevel + Math.max(1, item.level) - 1;
      const node: OutlineNode = {
        id: uniqueId(`e:${item.entryKey}:${item.subIndex ?? "date"}`),
        kind: "entry",
        text: cleanHeadingText(item.text),
        suffix: item.isDateOnly ? undefined : item.dateText,
        level,
        item,
        children: [],
      };
      while (local.length > 0 && local[local.length - 1].level >= level) local.pop();
      (local[local.length - 1]?.children ?? parentChildren).push(node);
      local.push(node);
    }
  };

  const insertTitle = (titled: OutlineBlockTitleInput): void => {
    const parent = top();
    (parent?.children ?? root).push({
      id: uniqueId(`b:${titled.language}:${titled.ordinal}`),
      kind: "block",
      text: titled.title,
      level: parent ? parent.level + 1 : baseLevel,
      line: titled.line,
      block: { language: titled.language, ordinal: titled.ordinal },
      children: [],
    });
  };

  // Вставки на месте блоков - в порядке строк, между заголовками заметки
  const inserts: { line: number; run: () => void }[] = [];
  if (block && block.items.length > 0) inserts.push({ line: block.line, run: insertTaskView });
  for (const titled of titledBlocks) inserts.push({ line: titled.line, run: () => insertTitle(titled) });
  inserts.sort((a, b) => a.line - b.line);
  let nextInsert = 0;
  const insertBefore = (line: number): void => {
    while (nextInsert < inserts.length && inserts[nextInsert].line < line) inserts[nextInsert++].run();
  };

  for (const heading of sorted) {
    insertBefore(heading.line);
    const text = cleanHeadingText(heading.text);
    const node: OutlineNode = {
      id: uniqueId(`h:${text}`),
      kind: "heading",
      text,
      level: heading.level,
      line: heading.line,
      children: [],
    };
    while (stack.length > 0 && top()!.level >= node.level) stack.pop();
    (top()?.children ?? root).push(node);
    stack.push(node);
  }
  insertBefore(Number.POSITIVE_INFINITY);
  return root;
}

/** Узлы, где есть совпадение с запросом (по тексту и дате), вместе с их родителями. */
export function filterOutlineTree(nodes: OutlineNode[], query: string): OutlineNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  const walk = (list: OutlineNode[]): OutlineNode[] =>
    list.flatMap((node) => {
      const children = walk(node.children);
      const haystack = `${node.text} ${node.suffix ?? ""}`.toLowerCase();
      return haystack.includes(needle) || children.length > 0 ? [{ ...node, children }] : [];
    });
  return walk(nodes);
}

/** Id всех узлов с детьми (для «Свернуть все»). */
export function collectCollapsibleIds(nodes: OutlineNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: OutlineNode[]): void => {
    for (const node of list) {
      if (node.children.length === 0) continue;
      ids.push(node.id);
      walk(node.children);
    }
  };
  walk(nodes);
  return ids;
}

/** Подпись дерева: при совпадении панель не перерисовывается. */
export function outlineSignature(nodes: OutlineNode[]): string {
  const walk = (list: OutlineNode[]): unknown[] =>
    list.map((node) => [
      node.kind,
      node.id,
      node.text,
      node.suffix ?? "",
      node.level,
      node.line ?? -1,
      node.item
        ? [node.item.sourcePath, node.item.line ?? -1, node.item.subIndex ?? -1, node.item.occurrence, node.item.entryOrdinal]
        : 0,
      walk(node.children),
    ]);
  return JSON.stringify(walk(nodes));
}
