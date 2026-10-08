/**
 * Копирование из блока просмотра задачи (opa-task-view).
 *
 * Идея: отрисованный DOM записи сопоставляется с её исходным markdown по тексту -
 * каждый верхнеуровневый блок (абзац, заголовок, список, ```-код, таблица…) получает
 * диапазон строк исходника. Целиком выделенные блоки копируются из исходника как есть
 * (wikilinks, картинки с размерами, fenced-код с языком, отступы), частично выделенные -
 * сериализуются из DOM в markdown без экранирования. Служебные элементы блока
 * (кнопки, заголовки записей, textarea редактирования) в копию не попадают.
 *
 * Все функции чистые (работают только с переданными узлами DOM) - их можно тестировать
 * в jsdom без Obsidian.
 */

const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;
const PIPE_PLACEHOLDER = "\u0001";
const CODE_PLACEHOLDER = "\u0002";
const ESCAPE_PLACEHOLDER = "\u0003";

/** Убрать zero-width символы (плагин вставляет их при рендере), схлопнуть пробелы. */
export function normalizeText(text: string): string {
  return text.replace(ZERO_WIDTH_RE, "").replace(/\s+/g, " ").trim();
}

/** Текст без любых пробельных и zero-width символов - для сравнения DOM с исходником. */
export function compactText(text: string): string {
  return text.replace(ZERO_WIDTH_RE, "").replace(/\s+/g, "");
}

function reverseString(text: string): string {
  return Array.from(text).reverse().join("");
}

/** Служебные элементы, которые не должны попадать в копию. */
export const CHROME_SELECTOR = [
  ".task-view-summary",
  ".task-view-edit-wrap",
  ".task-view-summary-actions",
  "button",
  "input",
  "select",
  "textarea",
  "svg",
  ".copy-code-button",
  ".collapse-indicator",
  ".heading-collapse-indicator",
  ".list-collapse-indicator",
  ".edit-block-button",
  ".markdown-embed-link",
  ".callout-fold",
  ".callout-icon",
  '.callout[data-callout="toc"]',
  ".task-toc-list",
  ".metadata-container",
  ".frontmatter",
  ".mod-header",
  ".mod-footer",
].join(", ");

export function removeChrome(root: ParentNode): void {
  root.querySelectorAll(CHROME_SELECTOR).forEach((node) => node.remove());
}

// ============================================================================
// Верхнеуровневые блоки отрисованного контента
// ============================================================================

export type BlockKind =
  | "code"
  | "hr"
  | "heading"
  | "list"
  | "table"
  | "quote"
  | "callout"
  | "embed"
  | "math"
  | "paragraph"
  | "other";

const TRANSPARENT_WRAPPER_CLASSES = ["markdown-preview-sizer", "markdown-preview-section", "markdown-preview-pusher"];

function isTransparentWrapper(el: Element): boolean {
  return TRANSPARENT_WRAPPER_CLASSES.some((cls) => el.classList.contains(cls));
}

/** Верхнеуровневые блоки контента записи (обёртки .el-* считаются блоком). */
export function getRenderedBlocks(display: Element): Element[] {
  const result: Element[] = [];
  const visit = (parent: Element): void => {
    for (const child of Array.from(parent.children)) {
      if (child.matches(CHROME_SELECTOR)) continue;
      if (isTransparentWrapper(child)) {
        visit(child);
        continue;
      }
      result.push(child);
    }
  };
  visit(display);
  return result;
}

/** Содержательный элемент блока: снимаем обёртки вида <div class="el-p">. */
export function contentElementOf(block: Element): Element {
  let el = block;
  for (let guard = 0; guard < 4 && el.tagName === "DIV"; guard++) {
    if (el.classList.contains("callout") || el.classList.contains("internal-embed") || el.classList.contains("math")) break;
    const meaningful = Array.from(el.children).filter((c) => !c.matches(CHROME_SELECTOR));
    if (meaningful.length !== 1) break;
    el = meaningful[0];
  }
  return el;
}

export function blockKind(block: Element): BlockKind {
  const el = contentElementOf(block);
  const tag = el.tagName;
  if (tag === "PRE") return "code";
  if (tag === "HR") return "hr";
  if (/^H[1-6]$/.test(tag)) return "heading";
  if (tag === "UL" || tag === "OL") return "list";
  if (tag === "TABLE") return "table";
  if (el.classList.contains("callout")) return "callout";
  if (tag === "BLOCKQUOTE") return "quote";
  if (el.classList.contains("internal-embed")) return "embed";
  if (el.classList.contains("math")) return "math";
  if (tag === "P") return "paragraph";
  return "other";
}

/** Видимый текст блока без служебных элементов (compact). */
export function blockText(block: Element): string {
  const clone = block.cloneNode(true) as Element;
  removeChrome(clone);
  return compactText(clone.textContent ?? "");
}

// ============================================================================
// Исходник → приблизительный видимый текст строки
// ============================================================================

export interface StripState {
  inFence: boolean;
  fenceChar: string;
  fenceLen: number;
  /** Обратный проход: закрывающая скобка кода встречается первой. */
  reversed: boolean;
}

export function createStripState(reversed = false): StripState {
  return { inFence: false, fenceChar: "", fenceLen: 0, reversed };
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * Приблизительный текст, который Obsidian покажет для строки markdown.
 * Точность нужна только с точностью до пробелов (сравнение идёт по compactText).
 * Строки внутри ```-блоков возвращаются как есть, сами скобки - как пустая строка.
 */
export function stripMarkdownLine(raw: string, state: StripState = createStripState()): string {
  const line = raw.replace(/\r$/, "");
  const fence = line.match(FENCE_RE);
  if (state.inFence) {
    // Вперёд: закрывающая скобка - только маркер, не короче открывающей.
    // Назад: «закрывает» исходная открывающая скобка - у неё может быть язык (```bash).
    const isClosing =
      fence &&
      fence[1][0] === state.fenceChar &&
      (state.reversed
        ? fence[1].length <= state.fenceLen && !line.slice(fence[0].length).includes(fence[1][0])
        : fence[1].length >= state.fenceLen && line.trim() === fence[1]);
    if (isClosing) {
      state.inFence = false;
      return "";
    }
    return line;
  }
  if (fence) {
    state.inFence = true;
    state.fenceChar = fence[1][0];
    state.fenceLen = fence[1].length;
    return "";
  }
  if (/^\s*$/.test(line)) return "";

  let s = line;
  // Комментарии
  s = s.replace(/%%[^%]*%%/g, "").replace(/<!--[\s\S]*?-->/g, "");
  // Горизонтальная линия / подчёркивание setext-заголовка (`=` не трогаем: плагин рендерит такие строки как текст)
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(s)) return "";
  // Цитата / callout
  while (/^\s*>/.test(s)) s = s.replace(/^\s*>\s?/, "");
  const callout = s.match(/^\[!([\w-]+)\]([+-]?)\s*(.*)$/);
  if (callout) s = callout[3].trim() || capitalize(callout[1]);
  // Заголовок
  s = s.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s+#+\s*$/, "");
  // Маркер списка и чекбокс
  s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s+)?/, "");
  // Таблица
  if (/^\s*\|/.test(s)) {
    if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s)) return "";
    s = s.replace(/\\\|/g, PIPE_PLACEHOLDER).split("|").join(" ").split(PIPE_PLACEHOLDER).join("|");
  }
  // Идентификатор блока
  s = s.replace(/\s+\^[\w-]+\s*$/, "");
  // Inline-код: содержимое защищаем от дальнейшей обработки
  const codeSpans: string[] = [];
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, content: string) => {
    codeSpans.push(content);
    return `${CODE_PLACEHOLDER}${codeSpans.length - 1}${CODE_PLACEHOLDER}`;
  });
  // Экранированные символы: защищаем, чтобы не сработали как разметка
  const escaped: string[] = [];
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~=><])/g, (_m, ch: string) => {
    escaped.push(ch);
    return `${ESCAPE_PLACEHOLDER}${escaped.length - 1}${ESCAPE_PLACEHOLDER}`;
  });
  // Картинки и встраивания (нет текста)
  s = s.replace(/!\[\[[^\]]*\]\]/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // Wikilinks: alias или цель (Obsidian показывает "Заметка > Заголовок")
  s = s.replace(
    /\[\[([^\]|#]*)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g,
    (_m, target: string, sub: string | undefined, alias: string | undefined) =>
      alias != null ? alias : target + (sub ? " > " + sub.slice(1) : "")
  );
  // Markdown-ссылки, автоссылки, сноски
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<((?:https?|mailto):[^>]*)>/g, "$1");
  s = s.replace(/\[\^[^\]]*\]/g, "");
  // Выделение
  s = s.replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, "$2");
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1").replace(/==(?=\S)([\s\S]*?\S)==/g, "$1");
  s = s.replace(/\*(?=\S)([^*]*?\S)\*/g, "$1");
  s = s.replace(/(^|[^\w\\])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2");
  // HTML-теги и сущности
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  s = decodeEntities(s);
  // Вернуть экранированные символы и inline-код
  s = s.replace(new RegExp(`${ESCAPE_PLACEHOLDER}(\\d+)${ESCAPE_PLACEHOLDER}`, "g"), (_m, idx: string) => escaped[Number(idx)] ?? "");
  s = s.replace(new RegExp(`${CODE_PLACEHOLDER}(\\d+)${CODE_PLACEHOLDER}`, "g"), (_m, idx: string) => codeSpans[Number(idx)] ?? "");
  return s;
}

// ============================================================================
// Сопоставление блоков DOM со строками исходника
// ============================================================================

/** Диапазон строк исходника [from, to). */
export interface LineRange {
  from: number;
  to: number;
}

const EMBED_TOKEN_RE = /!\[(?:\[[^\]]*\]\]|[^\]]*\]\([^)]*\))/g;

/** Сколько картинок/встраиваний в строке, если она состоит только из них (иначе 0). */
export function embedsInLine(line: string): number {
  const rest = line.replace(EMBED_TOKEN_RE, "").trim();
  if (rest !== "") return 0;
  return (line.match(EMBED_TOKEN_RE) ?? []).length;
}

/** Строка исходника - только картинки/встраивания (текста не даёт): ![[...]] или ![alt](...). */
export function isEmbedLine(line: string): boolean {
  return embedsInLine(line) > 0;
}

/** Число картинок/встраиваний в блоке DOM (img внутри .internal-embed не считается дважды). */
export function countEmbeds(block: Element): number {
  const embeds = block.querySelectorAll(".internal-embed").length;
  const bareImages = Array.from(block.querySelectorAll("img")).filter((img) => !img.closest(".internal-embed")).length;
  return embeds + bareImages;
}

/** Строка без видимого текста вне ```-блока (комментарий, пустая строка, разделитель). */
function isZeroTextLine(line: string): boolean {
  return compactText(stripMarkdownLine(line, createStripState())) === "";
}

const IMAGE_ABSORBING_KINDS = new Set<BlockKind>(["paragraph", "list", "quote", "callout", "embed", "other"]);

interface AlignInput {
  targets: string[];
  kinds: BlockKind[];
  /** Сколько картинок/встраиваний содержит каждый блок DOM. */
  embedCounts: number[];
  lines: string[];
  reversed: boolean;
}

function alignForward({ targets, kinds, embedCounts, lines, reversed }: AlignInput): LineRange[] {
  const state = createStripState(reversed);
  const ranges: LineRange[] = [];
  let cursor = 0;
  for (let b = 0; b < targets.length; b++) {
    const target = targets[b];
    while (cursor < lines.length && lines[cursor].trim() === "") cursor++;
    if (cursor >= lines.length) break;
    let from = cursor;
    let acc = "";
    let k = cursor;
    let consumedAny = false;
    let consumedEmbedLines = 0;
    let done = false;
    while (k < lines.length) {
      const line = lines[k];
      if (!state.inFence && line.trim() === "") {
        k++;
        continue;
      }
      let piece = compactText(stripMarkdownLine(line, state));
      if (reversed) piece = reverseString(piece);
      acc += piece;
      consumedAny = true;
      if (!state.inFence) consumedEmbedLines += embedsInLine(line);
      if (!target.startsWith(acc)) return ranges;
      k++;
      if (acc === target && !state.inFence) {
        // Картинки в конце абзаца текста не дают, но принадлежат ему: «Смотри скрин:\n![[shot.png]]».
        // Забираем ровно столько строк-картинок, сколько картинок реально отрисовано в блоке.
        if (IMAGE_ABSORBING_KINDS.has(kinds[b])) {
          while (k < lines.length && consumedEmbedLines < embedCounts[b] && isEmbedLine(lines[k])) {
            consumedEmbedLines += embedsInLine(lines[k]);
            k++;
          }
        }
        // Setext-заголовок: «Заголовок\n---» - подчёркивание тоже часть блока (но не после ATX-заголовка «### …»)
        if (
          !reversed &&
          kinds[b] === "heading" &&
          k === from + 1 &&
          !/^\s{0,3}#/.test(lines[from]) &&
          k < lines.length &&
          /^\s{0,3}(-+|=+)\s*$/.test(lines[k])
        ) {
          k++;
        }
        done = true;
        break;
      }
    }
    // Незакрытый ```-блок в конце записи: текст совпал, но скобки нет
    if (!done && consumedAny && acc === target) done = true;
    if (!done || !consumedAny) return ranges;
    // Ведущие строки без текста (комментарии), отделённые от контента пустой строкой, блоку не принадлежат
    let firstContent = from;
    while (firstContent < k && !isEmbedLine(lines[firstContent]) && isZeroTextLine(lines[firstContent])) firstContent++;
    for (let i = firstContent - 1; i >= from; i--) {
      if (lines[i].trim() === "") {
        from = i + 1;
        break;
      }
    }
    ranges.push({ from, to: k });
    cursor = k;
  }
  return ranges;
}

/**
 * Для каждого блока - диапазон строк исходника или null, если сопоставить не удалось.
 * Проход вперёд до первого расхождения, затем назад с конца: расхождение в одном месте
 * (формула, встроенная заметка) не лишает соответствия остальные блоки. Каждое
 * соответствие проверено: compact-текст строк исходника равен compact-тексту блока.
 */
export function alignBlocksToSource(blocks: Element[], lines: string[]): (LineRange | null)[] {
  const n = blocks.length;
  const result: (LineRange | null)[] = new Array(n).fill(null);
  if (n === 0 || lines.length === 0) return result;
  const targets = blocks.map((b) => blockText(b));
  const kinds = blocks.map((b) => blockKind(b));
  const embedCounts = blocks.map((b) => countEmbeds(b));

  const forward = alignForward({ targets, kinds, embedCounts, lines, reversed: false });
  for (let i = 0; i < forward.length; i++) result[i] = forward[i];
  if (forward.length === n) return result;

  const m = lines.length;
  const backward = alignForward({
    targets: [...targets].reverse().map(reverseString),
    kinds: [...kinds].reverse(),
    embedCounts: [...embedCounts].reverse(),
    lines: [...lines].reverse(),
    reversed: true,
  });
  const minFrom = forward.length > 0 ? forward[forward.length - 1].to : 0;
  for (let j = 0; j < backward.length; j++) {
    const i = n - 1 - j;
    if (i < forward.length) break;
    const from = m - backward[j].to;
    const to = m - backward[j].from;
    if (from < minFrom) break;
    result[i] = { from, to };
  }
  return result;
}

/** Строки без пустых по краям. */
export function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

// ============================================================================
// DOM → markdown (без экранирования)
// ============================================================================

export interface SerializeOptions {
  /** Выделение начинается внутри блока кода - открывающие ``` не нужны. */
  partialCodeStart?: boolean;
  /** Выделение заканчивается внутри блока кода - закрывающие ``` не нужны. */
  partialCodeEnd?: boolean;
}

interface Piece {
  text: string;
  /** В исходнике за блоком нет пустой строки (заголовок/код без отступа) - не добавлять её. */
  tight?: boolean;
}

interface SerializeContext {
  opts: SerializeOptions;
  preIndex: number;
  preTotal: number;
}

const BLOCK_TAGS = new Set([
  "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "PRE", "BLOCKQUOTE",
  "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "HR", "SECTION", "ARTICLE", "ASIDE", "HEADER",
  "FOOTER", "NAV", "FIGURE", "FIGCAPTION", "DETAILS", "SUMMARY", "DL", "DT", "DD", "ADDRESS",
  "MAIN", "FORM", "FIELDSET",
]);

function isBlockElement(el: Element): boolean {
  if (el.classList.contains("internal-embed")) return !el.classList.contains("image-embed") && el.tagName !== "SPAN";
  if (el.classList.contains("math")) return el.classList.contains("math-block");
  return BLOCK_TAGS.has(el.tagName);
}

function isTight(el: Element): boolean {
  if (el.getAttribute("data-after-blank") === "0") return true;
  const parent = el.parentElement;
  return !!parent && parent.tagName === "DIV" && parent.getAttribute("data-after-blank") === "0";
}

/** В исходнике сразу за верхнеуровневым блоком нет пустой строки (разметка заголовка/кода под обёрткой .el-*). */
function blockTightAfter(block: Element): boolean {
  return isTight(block) || isTight(contentElementOf(block));
}

function textOfNode(node: Node): string {
  return (node.nodeValue ?? "").replace(ZERO_WIDTH_RE, "").replace(/\s+/g, " ");
}

/** Убрать лишние пробелы в inline-тексте абзаца (переводы строк от <br> сохраняются). */
function cleanInline(text: string): string {
  return text
    .replace(ZERO_WIDTH_RE, "")
    .split("\n")
    .map((line) => line.replace(/[ \u00A0]+/g, " ").replace(/[ ]*\t[ \t]*/g, "\t").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/^\n+|\n+$/g, "");
}

function wrapInline(marker: string, inner: string, closeMarker = marker): string {
  const core = inner.trim();
  if (!core) return inner;
  const lead = inner.match(/^\s*/)?.[0] ?? "";
  const trail = inner.match(/\s*$/)?.[0] ?? "";
  return `${lead}${marker}${core}${closeMarker}${trail}`;
}

function inlineCode(text: string): string {
  const code = text.replace(ZERO_WIDTH_RE, "");
  const longest = Math.max(0, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${ticks}${pad}${code}${pad}${ticks}`;
}

function fileNameFromUrl(src: string): string {
  const tail = (src.split("/").pop() ?? src).split("?")[0].split("#")[0];
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

/** Markdown для <img> вне .internal-embed (или для картинки без атрибутов на обёртке). */
export function imageMarkdown(img: Element): string {
  const src = (img.getAttribute("src") ?? "").trim();
  const alt = (img.getAttribute("alt") ?? "").trim();
  if (!src || /^(app|capacitor|file):\/\//.test(src)) {
    const name = src ? fileNameFromUrl(src) : "";
    if (alt && (!name || alt.startsWith(name))) return `![[${alt}]]`;
    if (name) return `![[${name}]]`;
    return "";
  }
  return `![${alt}](${src})`;
}

/** Markdown для .internal-embed (картинка, заметка, pdf…): ![[src|alias]]. */
export function embedMarkdown(embed: Element): string {
  const src = (embed.getAttribute("src") ?? "").trim();
  const alt = (embed.getAttribute("alt") ?? "").trim();
  const img = embed.querySelector("img");
  if (!src && !alt) return img ? imageMarkdown(img) : "";
  let inner: string;
  if (!src) inner = alt;
  else if (!alt || alt === src) inner = src;
  else if (alt.startsWith(src + "|")) inner = alt;
  else inner = `${src}|${alt}`;
  const width = img?.getAttribute("width");
  if (width && /^\d+$/.test(width) && !inner.includes("|")) inner += `|${width}`;
  return `![[${inner}]]`;
}

function linkMarkdown(a: Element, inner: string): string {
  const text = cleanInline(inner);
  const cls = a.classList;
  if (cls.contains("tag")) return text;
  if (cls.contains("footnote-link") || cls.contains("footnote-backref")) return text;
  if (cls.contains("internal-link")) {
    let href = (a.getAttribute("data-href") ?? a.getAttribute("href") ?? "").trim();
    if (/^(app|obsidian):\/\//.test(href)) href = fileNameFromUrl(href);
    if (!href) return text;
    const shown = href.replace(/#\^?/, " > ");
    if (!text || text === href || text === shown) return `[[${href}]]`;
    return `[[${href}|${text}]]`;
  }
  const href = (a.getAttribute("href") ?? "").trim();
  if (!href || href.startsWith("#")) return text;
  if (!text || text === href) return href;
  return `[${text}](${href})`;
}

function serializeInlineChildren(el: Node, ctx: SerializeContext): string {
  let out = "";
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) out += textOfNode(child);
    else if (child.nodeType === 1) {
      const childEl = child as Element;
      if (isBlockElement(childEl)) out += "\n" + joinPieces(serializeBlockElement(childEl, ctx)) + "\n";
      else out += serializeInline(childEl, ctx);
    }
  }
  return out;
}

function serializeInline(el: Element, ctx: SerializeContext): string {
  if (el.matches(CHROME_SELECTOR)) return "";
  const tag = el.tagName;
  if (tag === "BR") return "\n";
  if (tag === "IMG") return el.closest(".internal-embed") ? "" : imageMarkdown(el);
  if (el.classList.contains("internal-embed")) return embedMarkdown(el);
  if (el.classList.contains("math")) return "";
  if (tag === "CODE") return inlineCode(el.textContent ?? "");
  const inner = serializeInlineChildren(el, ctx);
  switch (tag) {
    case "STRONG":
    case "B":
      return wrapInline("**", inner);
    case "EM":
    case "I":
      return wrapInline("*", inner);
    case "DEL":
    case "S":
    case "STRIKE":
      return wrapInline("~~", inner);
    case "MARK":
      return wrapInline("==", inner);
    case "U":
      return wrapInline("<u>", inner, "</u>");
    case "SUP":
      return wrapInline("<sup>", inner, "</sup>");
    case "SUB":
      return wrapInline("<sub>", inner, "</sub>");
    case "A":
      return linkMarkdown(el, inner);
    case "TD":
    case "TH":
      return `${inner.trim()}\t`;
    default:
      return inner;
  }
}

function indentLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line ? indent + line : line))
    .join("\n");
}

function serializeListItem(li: Element, ctx: SerializeContext): string[] {
  const out: string[] = [];
  let inlineBuf = "";
  const flush = (): void => {
    const t = cleanInline(inlineBuf);
    if (t) out.push(t);
    inlineBuf = "";
  };
  for (const child of Array.from(li.childNodes)) {
    if (child.nodeType === 3) {
      inlineBuf += textOfNode(child);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    if (el.matches(CHROME_SELECTOR)) continue;
    if (el.tagName === "UL" || el.tagName === "OL") {
      flush();
      const nested = serializeList(el, ctx);
      if (nested) out.push(indentLines(nested, "    "));
    } else if (isBlockElement(el)) {
      flush();
      const text = joinPieces(serializeBlockElement(el, ctx));
      if (text) out.push(el.tagName === "P" ? text : indentLines(text, "    "));
    } else {
      inlineBuf += serializeInline(el, ctx);
    }
  }
  flush();
  return out;
}

function serializeList(list: Element, ctx: SerializeContext): string {
  const ordered = list.tagName === "OL";
  let counter = parseInt(list.getAttribute("start") ?? "1", 10);
  if (!Number.isFinite(counter)) counter = 1;
  const lines: string[] = [];
  for (const li of Array.from(list.children)) {
    if (li.tagName !== "LI") continue;
    const marker = ordered ? `${counter++}. ` : "- ";
    let task = "";
    if (li.classList.contains("task-list-item")) {
      const dataTask = (li.getAttribute("data-task") ?? "").trim();
      const checked = li.classList.contains("is-checked");
      task = `[${dataTask || (checked ? "x" : " ")}] `;
    }
    const parts = serializeListItem(li, ctx);
    if (parts.length === 0) {
      lines.push(`${marker}${task}`.trimEnd());
      continue;
    }
    const [first, ...rest] = parts;
    const firstLines = first.split("\n");
    lines.push(`${marker}${task}${firstLines[0]}`);
    const indent = " ".repeat(marker.length);
    for (const l of firstLines.slice(1)) lines.push(l ? indent + l : l);
    for (const part of rest) {
      for (const l of part.split("\n")) lines.push(l ? (l.startsWith("    ") ? l : indent + l) : l);
    }
  }
  return lines.join("\n");
}

function serializePre(pre: Element, ctx: SerializeContext): string {
  const code = pre.querySelector("code");
  const raw = (code ?? pre).textContent ?? "";
  const text = raw.replace(ZERO_WIDTH_RE, "").replace(/\n$/, "");
  const cls = `${pre.className ?? ""} ${code?.className ?? ""}`;
  const lang = cls.match(/\blanguage-([\w+#.-]+)/)?.[1] ?? "";
  const index = ctx.preIndex++;
  const isFirst = index === 0;
  const isLast = index === ctx.preTotal - 1;
  const fence = text.includes("```") ? "````" : "```";
  const open = ctx.opts.partialCodeStart && isFirst ? "" : `${fence}${lang}\n`;
  const close = ctx.opts.partialCodeEnd && isLast ? "" : `\n${fence}`;
  return `${open}${text}${close}`;
}

function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function serializeCallout(el: Element, ctx: SerializeContext): string {
  const type = el.getAttribute("data-callout") ?? "note";
  const fold = el.getAttribute("data-callout-fold") ?? "";
  const titleEl = el.querySelector(":scope > .callout-title .callout-title-inner");
  const title = titleEl ? cleanInline(serializeInlineChildren(titleEl, ctx)) : "";
  const contentEl = el.querySelector(":scope > .callout-content");
  const body = contentEl ? joinPieces(serializeBlocks(contentEl, ctx)) : "";
  const showTitle = title && title.toLowerCase() !== type.toLowerCase();
  const head = `> [!${type}]${fold}${showTitle ? " " + title : ""}`;
  return body ? `${head}\n${quoteLines(body)}` : head;
}

function serializeTable(table: Element, ctx: SerializeContext): string {
  const rows = table.tagName === "TR" ? [table] : Array.from(table.querySelectorAll("tr"));
  const lines: string[] = [];
  let firstRowDone = false;
  for (const tr of rows) {
    const cells = Array.from(tr.children).filter((c) => c.tagName === "TD" || c.tagName === "TH");
    if (!cells.length) continue;
    const texts = cells.map((c) =>
      cleanInline(serializeInlineChildren(c, ctx)).replace(/\n/g, " ").replace(/\|/g, "\\|")
    );
    lines.push(`| ${texts.join(" | ")} |`);
    if (!firstRowDone) {
      lines.push(`| ${texts.map(() => "---").join(" | ")} |`);
      firstRowDone = true;
    }
  }
  return lines.join("\n");
}

function wrapInList(li: Element): Element {
  const parentTag = li.parentElement?.tagName ?? li.parentNode?.nodeName ?? "";
  const list = li.ownerDocument.createElement(parentTag.toUpperCase() === "OL" ? "ol" : "ul");
  list.appendChild(li.cloneNode(true));
  return list;
}

function serializeBlockElement(el: Element, ctx: SerializeContext): Piece[] {
  if (el.matches(CHROME_SELECTOR)) return [];
  const tag = el.tagName;
  if (el.classList.contains("callout")) return [{ text: serializeCallout(el, ctx) }];
  if (el.classList.contains("internal-embed")) {
    const md = embedMarkdown(el);
    return md ? [{ text: md }] : [];
  }
  if (el.classList.contains("math")) return [];
  switch (tag) {
    case "P": {
      const text = cleanInline(serializeInlineChildren(el, ctx));
      return text ? [{ text, tight: isTight(el) }] : [];
    }
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const text = cleanInline(serializeInlineChildren(el, ctx)).replace(/\n/g, " ");
      return text ? [{ text: `${"#".repeat(Number(tag.charAt(1)))} ${text}`, tight: isTight(el) }] : [];
    }
    case "PRE":
      return [{ text: serializePre(el, ctx), tight: isTight(el) }];
    case "UL":
    case "OL": {
      const text = serializeList(el, ctx);
      return text ? [{ text }] : [];
    }
    case "LI": {
      const text = serializeList(wrapInList(el), ctx);
      return text ? [{ text }] : [];
    }
    case "BLOCKQUOTE": {
      const body = joinPieces(serializeBlocks(el, ctx));
      return body ? [{ text: quoteLines(body) }] : [];
    }
    case "TABLE":
    case "THEAD":
    case "TBODY":
    case "TFOOT":
    case "TR": {
      const text = serializeTable(el, ctx);
      return text ? [{ text }] : [];
    }
    case "HR":
      return [{ text: "---" }];
    default: {
      const pieces = serializeBlocks(el, ctx);
      if (pieces.length && isTight(el)) pieces[pieces.length - 1].tight = true;
      return pieces;
    }
  }
}

function serializeBlocks(parent: Node, ctx: SerializeContext): Piece[] {
  const pieces: Piece[] = [];
  let inlineBuf = "";
  const flush = (): void => {
    const t = cleanInline(inlineBuf);
    if (t) pieces.push({ text: t });
    inlineBuf = "";
  };
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 3) {
      inlineBuf += textOfNode(child);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    if (isBlockElement(el)) {
      flush();
      pieces.push(...serializeBlockElement(el, ctx));
    } else {
      inlineBuf += serializeInline(el, ctx);
    }
  }
  flush();
  return pieces;
}

function joinPieces(pieces: Piece[]): string {
  let out = "";
  pieces.forEach((piece, index) => {
    out += piece.text;
    if (index < pieces.length - 1) out += piece.tight ? "\n" : "\n\n";
  });
  return out;
}

/**
 * DocumentFragment или элемент → markdown. Служебные элементы исключаются,
 * wikilinks/встраивания/выделения восстанавливаются, спецсимволы не экранируются.
 */
export function fragmentToMarkdown(root: Node, opts: SerializeOptions = {}): string {
  const doc = root.ownerDocument;
  if (!doc) return "";
  const container = doc.createElement("div");
  container.appendChild(root.cloneNode(true));
  removeChrome(container);
  const ctx: SerializeContext = { opts, preIndex: 0, preTotal: container.querySelectorAll("pre").length };
  return joinPieces(serializeBlocks(container, ctx))
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}

// ============================================================================
// Выделение → текст для копирования
// ============================================================================

const START_TO_START = 0;
const END_TO_END = 2;

/** Обрезать диапазон границами элемента. null - диапазон не пересекает содержимое элемента. */
export function clipRangeToElement(range: Range, el: Element): Range | null {
  const elRange = el.ownerDocument.createRange();
  elRange.selectNodeContents(el);
  const clipped = range.cloneRange();
  if (clipped.compareBoundaryPoints(START_TO_START, elRange) < 0) {
    clipped.setStart(elRange.startContainer, elRange.startOffset);
  }
  if (clipped.compareBoundaryPoints(END_TO_END, elRange) > 0) {
    clipped.setEnd(elRange.endContainer, elRange.endOffset);
  }
  // setStart/setEnd схлопывают диапазон, если границы поменялись местами (нет пересечения)
  return clipped.collapsed ? null : clipped;
}

/** Видимый текст диапазона без служебных элементов (compact). */
export function visibleTextOfRange(range: Range): string {
  const frag = range.cloneContents();
  removeChrome(frag);
  return compactText(frag.textContent ?? "");
}

/** Есть ли в диапазоне картинка или встраивание (выделение без текста, но с контентом). */
export function rangeHasEmbed(range: Range): boolean {
  const frag = range.cloneContents();
  removeChrome(frag);
  return frag.querySelector(".internal-embed, img") != null;
}

/** Покрывает ли диапазон весь видимый текст блока с начала / до конца. */
export function coverageOfBlock(range: Range, block: Element): { startFull: boolean; endFull: boolean } {
  const blockRange = block.ownerDocument.createRange();
  blockRange.selectNodeContents(block);
  let startFull = range.compareBoundaryPoints(START_TO_START, blockRange) <= 0;
  if (!startFull) {
    const before = blockRange.cloneRange();
    before.setEnd(range.startContainer, range.startOffset);
    startFull = visibleTextOfRange(before) === "";
  }
  let endFull = range.compareBoundaryPoints(END_TO_END, blockRange) >= 0;
  if (!endFull) {
    const after = blockRange.cloneRange();
    after.setStart(range.endContainer, range.endOffset);
    endFull = visibleTextOfRange(after) === "";
  }
  return { startFull, endFull };
}

/** Контексты, в которых частичное выделение - просто текст (без маркеров списка, ячеек, заголовков). */
const INLINE_CONTEXT_RE = /^(P|H[1-6]|LI|TD|TH|TR|DT|DD|SPAN|A|STRONG|EM|B|I|S|DEL|STRIKE|MARK|U|SUP|SUB|SMALL|LABEL|FIGCAPTION|SUMMARY)$/;

/**
 * Копия содержимого диапазона с восстановленной структурой: Range.cloneContents() не включает
 * общего предка, поэтому две строки, выделенные внутри одного <pre>, приходят «голым» текстом,
 * а элементы списка - без <ul>. Оборачиваем фрагмент в пустые клоны предков до блока включительно.
 * Если предок - абзац, элемент списка или ячейка, структуру не восстанавливаем: это просто текст.
 */
export function cloneRangeWithContext(range: Range, block: Element): Node {
  const fragment = range.cloneContents();
  let ancestor: Node | null = range.commonAncestorContainer;
  if (ancestor && ancestor.nodeType !== 1) ancestor = ancestor.parentNode;
  if (!ancestor || ancestor.nodeType !== 1) return fragment;
  const ancestorEl = ancestor as Element;
  if (ancestorEl !== block && !block.contains(ancestorEl)) return fragment;
  const insideCode = ancestorEl.closest("pre") != null && block.contains(ancestorEl.closest("pre"));
  if (!insideCode && INLINE_CONTEXT_RE.test(ancestorEl.tagName)) return fragment;
  let current: Node = fragment;
  let node: Element | null = ancestorEl;
  while (node) {
    const shell = node.cloneNode(false) as Element;
    shell.appendChild(current);
    current = shell;
    if (node === block) break;
    node = node.parentElement;
  }
  return current;
}

type CopyPart =
  | { kind: "source"; from: number; to: number }
  | {
      kind: "markdown";
      text: string;
      /** Строки исходника блока, если сопоставлены (текст при этом взят из DOM - блок выделен частично). */
      range: LineRange | null;
      /** В исходнике сразу за блоком нет пустой строки (data-after-blank у заголовков и кода). */
      tightAfter: boolean;
      /** Часть кода без ```-скобок: с соседями разделяется пустой строкой, иначе при вставке слилась бы с абзацем. */
      bare: boolean;
    };

/** Собранная часть копии со строками исходника без пустых по краям (null - строки неизвестны). */
interface AssembledPiece {
  text: string;
  from: number | null;
  to: number | null;
  tightAfter: boolean;
  bare: boolean;
}

/** Границы содержимого [from, to) без пустых строк по краям. */
function contentBounds(lines: string[], from: number, to: number): { from: number; to: number } {
  let start = from;
  let end = Math.min(to, lines.length);
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return { from: start, to: end };
}

/**
 * Разделитель между соседними частями копии - как в исходнике: если между блоками нет пустой строки
 * («#### Заголовок» и сразу абзац), только перевод строки; иначе столько пустых строк, сколько было.
 * Когда строки исходника неизвестны, ориентируемся на разметку блока (заголовок/код без отступа после).
 */
function separatorBetween(prev: AssembledPiece, next: AssembledPiece, lines: string[]): string {
  if (prev.bare || next.bare) return "\n\n";
  if (prev.to != null && next.from != null && next.from >= prev.to) {
    const between = lines.slice(prev.to, next.from);
    if (between.every((line) => line.trim() === "")) return "\n".repeat(between.length + 1);
    return "\n\n";
  }
  return prev.tightAfter ? "\n" : "\n\n";
}

function assembleParts(parts: CopyPart[], lines: string[]): string {
  const pieces: AssembledPiece[] = [];
  let runFrom = -1;
  let runTo = -1;
  const flushRun = (): void => {
    if (runFrom < 0) return;
    const bounds = contentBounds(lines, runFrom, runTo);
    const text = lines.slice(bounds.from, bounds.to).join("\n");
    if (text) pieces.push({ text, from: bounds.from, to: bounds.to, tightAfter: false, bare: false });
    runFrom = -1;
    runTo = -1;
  };
  for (const part of parts) {
    if (part.kind === "source") {
      if (runFrom < 0) runFrom = part.from;
      runTo = part.to;
    } else {
      flushRun();
      if (!part.text) continue;
      const bounds = part.range ? contentBounds(lines, part.range.from, part.range.to) : null;
      pieces.push({
        text: part.text,
        from: bounds ? bounds.from : null,
        to: bounds ? bounds.to : null,
        tightAfter: part.tightAfter,
        bare: part.bare,
      });
    }
  }
  flushRun();
  let out = "";
  pieces.forEach((piece, index) => {
    out += piece.text;
    if (index < pieces.length - 1) out += separatorBetween(piece, pieces[index + 1], lines);
  });
  return out;
}

/**
 * Текст для копирования по диапазону внутри контента одной записи.
 * source - исходный markdown записи (может быть пустым: тогда только DOM → markdown).
 */
export function buildCopyTextForRange(range: Range, display: Element, source: string): string {
  const lines = source.split("\n");
  const blocks = getRenderedBlocks(display);
  const touched = blocks.filter((b) => range.intersectsNode(b));
  if (touched.length === 0) return fragmentToMarkdown(range.cloneContents());
  const mapping = source ? alignBlocksToSource(blocks, lines) : blocks.map(() => null);
  const parts: CopyPart[] = [];
  for (const block of touched) {
    const index = blocks.indexOf(block);
    const { startFull, endFull } = coverageOfBlock(range, block);
    const lineRange = mapping[index];
    if (startFull && endFull) {
      if (lineRange) parts.push({ kind: "source", from: lineRange.from, to: lineRange.to });
      else parts.push({ kind: "markdown", text: fragmentToMarkdown(block), range: null, tightAfter: blockTightAfter(block), bare: false });
      continue;
    }
    const clipped = clipRangeToElement(range, block);
    if (!clipped) continue;
    // Частично выделенный код копируем без ```-скобок: незакрытая скобка при вставке
    // «съела» бы весь текст ниже, а половина блока кода - это уже просто текст.
    const partialCode = blockKind(block) === "code";
    const text = fragmentToMarkdown(cloneRangeWithContext(clipped, block), {
      partialCodeStart: partialCode,
      partialCodeEnd: partialCode,
    });
    // Строки исходника блока нужны для разделителя с соседями (в исходнике за заголовком может не быть пустой строки)
    parts.push({ kind: "markdown", text, range: lineRange, tightAfter: endFull && blockTightAfter(block), bare: partialCode });
  }
  return assembleParts(parts, lines);
}

/** Текст для копирования целого верхнеуровневого блока (без выделения - по клику мышью). */
export function buildCopyTextForBlock(block: Element, display: Element, source: string): string {
  const blocks = getRenderedBlocks(display);
  const index = blocks.indexOf(block);
  if (index >= 0 && source) {
    const lines = source.split("\n");
    const mapping = alignBlocksToSource(blocks, lines);
    const lineRange = mapping[index];
    if (lineRange) return trimBlankLines(lines.slice(lineRange.from, lineRange.to)).join("\n");
  }
  return fragmentToMarkdown(block);
}

/** Строки исходника, соответствующие блоку (null - сопоставить не удалось). */
export function sourceRangeForBlock(block: Element, display: Element, source: string): LineRange | null {
  if (!source) return null;
  const blocks = getRenderedBlocks(display);
  const index = blocks.indexOf(block);
  if (index < 0) return null;
  return alignBlocksToSource(blocks, source.split("\n"))[index];
}

/** Верхнеуровневый блок, содержащий узел (или null). */
export function findRenderedBlock(display: Element, node: Node | null): Element | null {
  if (!node) return null;
  for (const block of getRenderedBlocks(display)) {
    if (block === node || block.contains(node)) return block;
  }
  return null;
}
