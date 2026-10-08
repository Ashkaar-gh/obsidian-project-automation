/**
 * Поиск Ctrl+F в режиме редактирования по записям блока opa-task-view - логика без Obsidian.
 *
 * Штатный поиск редактора ищет только по markdown-тексту заметки. Записи из ежедневных заметок блок задачи рисует
 * сам, в файле задачи их нет, поэтому в режиме редактирования они не находились (режим чтения ищет по отрисованной
 * странице и находит). Здесь совпадения в тексте заметки и в отрисованном блоке сводятся в один список по порядку
 * в заметке, а курсор с устройством курсора штатного поиска (findNext/findPrevious/getIndexAndCount/…) ходит по нему.
 * Подключение к панели поиска Obsidian - в TaskViewSearchModule.
 */

export const TASK_VIEW_LANGUAGE = "opa-task-view";

// ---------------------------------------------------------------------------
// Текст и совпадения
// ---------------------------------------------------------------------------

/**
 * Текст для сравнения без учёта регистра той же длины, что исходный: позиции совпадений - позиции в исходном тексте.
 * Неразрывный пробел считается обычным (в отрисованном тексте он выглядит как пробел).
 */
export function foldForSearch(text: string): string {
  const source = String(text ?? "");
  let lower = source.toLowerCase();
  if (lower.length !== source.length) {
    // Редкие символы меняют длину в нижнем регистре (İ → i̇) - такие оставляем как есть
    lower = "";
    for (const ch of source) {
      const low = ch.toLowerCase();
      lower += low.length === ch.length ? low : ch;
    }
  }
  return lower.replace(/ /g, " ");
}

/** Непересекающиеся вхождения query в text без учёта регистра: [from, to) в позициях text. */
export function findTextMatches(text: string, query: string): { from: number; to: number }[] {
  const needle = foldForSearch(query);
  if (!needle) return [];
  const haystack = foldForSearch(text);
  const result: { from: number; to: number }[] = [];
  for (let from = haystack.indexOf(needle); from !== -1; from = haystack.indexOf(needle, from + needle.length)) {
    result.push({ from, to: from + needle.length });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Блоки кода в тексте заметки
// ---------------------------------------------------------------------------

export interface CodeBlockRange {
  /** Начало строки с открывающим ``` (позиция в тексте заметки). */
  from: number;
  /** Конец строки с закрывающим ``` без перевода строки; у незакрытого блока - конец текста. */
  to: number;
  /** Строки открывающего и закрывающего ``` (0-based). */
  lineStart: number;
  lineEnd: number;
}

/**
 * Блоки кода на языке language (```opa-task-view) по порядку: вне frontmatter и других блоков кода -
 * по тем же правилам, что findPluginBlocks для панели «Структура».
 */
export function findCodeBlockRanges(content: string, language: string): CodeBlockRange[] {
  const text = String(content ?? "");
  const lines = text.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  const clean = (i: number): string => lines[i].replace(/\r$/, "");
  const lineEndOffset = (i: number): number => offsets[i] + clean(i).length;
  const wanted = language.toLowerCase();

  let start = 0;
  if (clean(0) === "---") {
    const end = lines.findIndex((_line, i) => i > 0 && (clean(i) === "---" || clean(i) === "..."));
    if (end > 0) start = end + 1;
  }
  const result: CodeBlockRange[] = [];
  let fence: string | null = null;
  let current: CodeBlockRange | null = null;
  for (let i = start; i < lines.length; i++) {
    const line = clean(i);
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        fence = null;
        if (current) {
          current.to = lineEndOffset(i);
          current.lineEnd = i;
          current = null;
        }
      }
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`~]*)/);
    if (!open) continue;
    fence = open[1];
    if (open[2].toLowerCase() === wanted) {
      current = { from: offsets[i], to: text.length, lineStart: i, lineEnd: lines.length - 1 };
      result.push(current);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Текст отрисованного блока
// ---------------------------------------------------------------------------

/** Элементы, текст которых не ищется: кнопки и поля (служебные надписи), скрипты, иконки. */
const SKIP_TAGS = new Set(["BUTTON", "TEXTAREA", "INPUT", "SELECT", "OPTION", "SCRIPT", "STYLE", "SVG", "NOSCRIPT", "TEMPLATE"]);
/** Скрытый редактор записи блока задачи (textarea и кнопка «Сохранить»). */
const SKIP_CLASSES = ["task-view-edit-wrap"];
/**
 * Блочные элементы: между их текстами - разделитель, чтобы конец одного абзаца (ячейки, пункта) и начало
 * следующего не складывались в одно слово. Разделитель - перевод строки: в запрос из поля поиска он не попадает.
 */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DETAILS", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE",
  "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "IMG", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

function isSkipped(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
  const html = el as HTMLElement;
  if (html.hidden) return true;
  // Скрытые на месте части записи: редактор, пока открыт просмотр, и просмотр, пока открыт редактор
  if (html.style?.display === "none") return true;
  return SKIP_CLASSES.some((cls) => el.classList?.contains(cls));
}

/** Текст блока, как его видно на странице, и текстовые узлы с позициями начала в этом тексте. */
export interface SearchableText {
  text: string;
  nodes: Text[];
  starts: number[];
}

/**
 * Видимый текст блока в порядке чтения. Текст свёрнутых записей входит: при переходе к совпадению запись
 * разворачивается (как в режиме чтения, где поиск тоже видит свёрнутое).
 */
export function collectSearchableText(root: Element): SearchableText {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  const separate = (): void => {
    if (text !== "" && !text.endsWith("\n")) text += "\n";
  };
  const walk = (parent: Node): void => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        const value = child.nodeValue ?? "";
        if (value === "") continue;
        nodes.push(child as Text);
        starts.push(text.length);
        text += value;
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      if (isSkipped(el)) continue;
      const block = BLOCK_TAGS.has(el.tagName.toUpperCase());
      if (block) separate();
      walk(el);
      if (block) separate();
    }
  };
  walk(root);
  return { text, nodes, starts };
}

/** Номер текстового узла, в котором стоит символ с позицией pos (разделители ни одному узлу не принадлежат). */
function nodeIndexAt(source: SearchableText, pos: number): number {
  const { starts, nodes } = source;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= pos) lo = mid + 1;
    else hi = mid - 1;
  }
  if (hi < 0) return -1;
  return pos < starts[hi] + (nodes[hi].nodeValue ?? "").length ? hi : -1;
}

/** Диапазон DOM для позиций [from, to) видимого текста; null - позиции не в текстовых узлах. */
export function rangeForMatch(source: SearchableText, doc: Document, from: number, to: number): Range | null {
  const first = nodeIndexAt(source, from);
  const last = nodeIndexAt(source, to - 1);
  if (first < 0 || last < 0) return null;
  const range = doc.createRange();
  range.setStart(source.nodes[first], from - source.starts[first]);
  range.setEnd(source.nodes[last], to - source.starts[last]);
  return range;
}

/** Вхождения query в видимый текст блока - диапазоны DOM в порядке чтения. */
export function findTextRanges(root: Element, query: string, source = collectSearchableText(root)): Range[] {
  const ranges: Range[] = [];
  for (const match of findTextMatches(source.text, query)) {
    const range = rangeForMatch(source, root.ownerDocument, match.from, match.to);
    if (range) ranges.push(range);
  }
  return ranges;
}

/**
 * Видимый текст блоков, пока открыт поиск: панель спрашивает курсор несколько раз на каждое нажатие (совпадение,
 * счётчик), а обходить DOM большого блока каждый раз дорого. Текст пересчитывается, когда в блоке что-то
 * изменилось (MutationObserver; изменения, о которых он ещё не сообщил, забираются takeRecords).
 */
export class SearchableTextCache {
  private entries = new Map<Element, { value: SearchableText; observer: MutationObserver; dirty: boolean }>();

  get(root: Element): SearchableText {
    const entry = this.entries.get(root);
    if (entry) {
      if (entry.observer.takeRecords().length > 0) entry.dirty = true;
      if (entry.dirty) {
        entry.value = collectSearchableText(root);
        entry.dirty = false;
      }
      return entry.value;
    }
    const value = collectSearchableText(root);
    const Observer = root.ownerDocument?.defaultView?.MutationObserver;
    if (typeof Observer !== "function") return value;
    const created = { value, observer: null as unknown as MutationObserver, dirty: false };
    created.observer = new Observer(() => {
      created.dirty = true;
    });
    created.observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "hidden", "class"],
    });
    this.entries.set(root, created);
    return value;
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.observer.disconnect();
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Общий список совпадений: текст заметки + отрисованные блоки
// ---------------------------------------------------------------------------

/** Блок задачи в заметке для поиска. */
export interface SearchBlockSource<H> {
  /** Позиции блока кода в тексте заметки (см. CodeBlockRange). */
  from: number;
  to: number;
  /**
   * true - блок показан отрисованным: его markdown спрятан, совпадения в нём не считаются, вместо них - find().
   * false - Obsidian показывает markdown блока (курсор внутри блока): он ищется как остальной текст заметки.
   */
  rendered: boolean;
  /** Совпадения в отрисованном блоке в порядке чтения (пусто, если блок сейчас не отрисован). */
  find(query: string): H[];
}

export interface DocSearchMatch {
  kind: "doc";
  from: number;
  to: number;
}

export interface BlockSearchMatch<H> {
  kind: "block";
  /** Номер блока в списке блоков и номер совпадения в блоке. */
  block: number;
  ordinal: number;
  /** Позиция блока в заметке: по ней совпадение стоит в общем списке. */
  anchor: number;
  hit: H;
}

export type SearchMatch<H> = DocSearchMatch | BlockSearchMatch<H>;

/** Все совпадения по порядку в заметке: совпадения блока стоят на месте блока. */
export function mergeSearchMatches<H>(
  text: string,
  query: string,
  blocks: readonly SearchBlockSource<H>[]
): SearchMatch<H>[] {
  if (!foldForSearch(query)) return [];
  const rendered = blocks
    .map((block, index) => ({ block, index }))
    .filter((item) => item.block.rendered)
    .sort((a, b) => a.block.from - b.block.from);
  const result: SearchMatch<H>[] = [];
  let next = 0;
  const addBlocksUpTo = (pos: number): void => {
    while (next < rendered.length && rendered[next].block.from <= pos) {
      const { block, index } = rendered[next++];
      block.find(query).forEach((hit, ordinal) => {
        result.push({ kind: "block", block: index, ordinal, anchor: block.from, hit });
      });
    }
  };
  for (const match of findTextMatches(text, query)) {
    // markdown отрисованного блока на экране не виден
    if (rendered.some(({ block }) => match.from < block.to && match.to > block.from)) continue;
    addBlocksUpTo(match.from);
    result.push({ kind: "doc", from: match.from, to: match.to });
  }
  addBlocksUpTo(Number.POSITIVE_INFINITY);
  return result;
}

// ---------------------------------------------------------------------------
// Курсор для панели поиска редактора
// ---------------------------------------------------------------------------

/** Позиция совпадения для сравнения: [позиция в заметке, номер в блоке + 1] (у текста заметки второе - 0). */
type OrderKey = readonly [number, number];

function compareKeys(a: OrderKey, b: OrderKey): number {
  return a[0] - b[0] || a[1] - b[1];
}

function startKey<H>(match: SearchMatch<H>): OrderKey {
  return match.kind === "doc" ? [match.from, 0] : [match.anchor, match.ordinal + 1];
}

function endKey<H>(match: SearchMatch<H>): OrderKey {
  return match.kind === "doc" ? [match.to, 0] : [match.anchor, match.ordinal + 1];
}

function identityOf<H>(match: SearchMatch<H>): string {
  return match.kind === "doc" ? `doc:${match.from}:${match.to}` : `block:${match.block}:${match.ordinal}`;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}

/** Окружение курсора: текст и блоки заметки, преобразование результатов, правка текста. */
export interface MergedCursorHost<H, R> {
  getText(): string;
  /** Выделение в редакторе (позиции в тексте): с него начинается поиск, как у штатного курсора. */
  getSelection(): { from: number; to: number };
  getBlocks(text: string): SearchBlockSource<H>[];
  /** Результат для панели поиска: диапазон редактора для совпадения в тексте заметки. */
  docResult(from: number, to: number): R;
  /** Результат для совпадения в отрисованном блоке (панель передаст его в highlight). */
  blockResult(match: BlockSearchMatch<H>): R;
  replaceRange(text: string, from: number, to: number, origin?: string): void;
  replaceRanges(changes: { from: number; to: number; text: string }[], origin?: string): void;
  /** Замена не тронула совпадения в записях блока (их текст лежит в ежедневных заметках). */
  onBlockReplaceSkipped?(count: number): void;
}

interface SelectedMatch {
  identity: string;
  start: OrderKey;
  kind: "doc" | "block";
  from: number;
  to: number;
}

/**
 * Курсор поиска с устройством курсора редактора Obsidian (editor.searchCursor): панель поиска вызывает
 * findNext/findPrevious/findAll/current/getIndexAndCount/replace/replaceAll. Порядок и начало - как у штатного:
 * первое совпадение после выделения, по кругу. Список совпадений считается заново при каждом вызове - заметка
 * и блок могли измениться между нажатиями (правка, фоновая перерисовка блока).
 */
export class MergedSearchCursor<H, R> {
  private selected: SelectedMatch | null = null;
  /** Откуда продолжать, если выбранного совпадения нет (как from/to штатного курсора). */
  private lastFrom: number;
  private lastTo: number;

  constructor(private readonly host: MergedCursorHost<H, R>, readonly query: string) {
    const selection = host.getSelection();
    this.lastFrom = selection.from;
    this.lastTo = selection.to;
  }

  matches(): SearchMatch<H>[] {
    const text = this.host.getText();
    return mergeSearchMatches(text, this.query, this.host.getBlocks(text));
  }

  findNext(): R | null {
    const list = this.matches();
    if (list.length === 0) return this.select(null);
    const index = this.indexOfSelected(list);
    let next: number;
    if (index >= 0) next = (index + 1) % list.length;
    else if (this.selected) {
      const after = this.selected.start;
      next = list.findIndex((match) => compareKeys(startKey(match), after) > 0);
    } else {
      next = list.findIndex((match) => compareKeys(startKey(match), [this.lastTo, 0]) >= 0);
    }
    return this.select(list[next < 0 ? 0 : next]);
  }

  findPrevious(): R | null {
    const list = this.matches();
    if (list.length === 0) return this.select(null);
    const index = this.indexOfSelected(list);
    let previous: number;
    if (index >= 0) previous = (index - 1 + list.length) % list.length;
    else if (this.selected) {
      const before = this.selected.start;
      previous = findLastIndex(list, (match) => compareKeys(startKey(match), before) < 0);
    } else {
      previous = findLastIndex(list, (match) => compareKeys(endKey(match), [this.lastFrom, 0]) <= 0);
    }
    return this.select(list[previous < 0 ? list.length - 1 : previous]);
  }

  findAll(): R[] {
    return this.matches().map((match) => this.result(match));
  }

  /**
   * Выбранное совпадение в тексте заметки. Для совпадения в блоке - null: при закрытии поиска панель ставит
   * выделение редактора на current(), а у текста записи места в тексте заметки нет - курсор остаётся где был.
   */
  current(): R | null {
    const selected = this.selected;
    return selected && selected.kind === "doc" ? this.host.docResult(selected.from, selected.to) : null;
  }

  /** [номер выбранного совпадения (с 1), всего]; [0, 0] - ничего не выбрано (как у штатного курсора). */
  getIndexAndCount(): [number, number] {
    const selected = this.selected;
    if (!selected) return [0, 0];
    const list = this.matches();
    const index = this.indexOfSelected(list);
    if (index >= 0) return [index + 1, list.length];
    return [list.filter((match) => compareKeys(startKey(match), selected.start) <= 0).length, list.length];
  }

  replace(text: string, origin?: string): void {
    const selected = this.selected;
    if (!selected) return;
    if (selected.kind === "block") {
      this.host.onBlockReplaceSkipped?.(1);
      return;
    }
    this.host.replaceRange(text, selected.from, selected.to, origin);
    // Следующий поиск - сразу после вставленного текста
    this.lastFrom = selected.from;
    this.lastTo = selected.from + text.length;
    this.selected = null;
  }

  replaceAll(text: string, origin?: string): void {
    const list = this.matches();
    const inNote = list.filter((match): match is DocSearchMatch => match.kind === "doc");
    if (inNote.length > 0) {
      this.host.replaceRanges(
        inNote.map((match) => ({ from: match.from, to: match.to, text })),
        origin
      );
    }
    const skipped = list.length - inNote.length;
    if (skipped > 0) this.host.onBlockReplaceSkipped?.(skipped);
    // Выбранное совпадение в записи осталось на месте (записи не менялись), в тексте заметки - заменено
    if (this.selected?.kind === "doc") this.selected = null;
  }

  /** Выбрано ли сейчас какое-нибудь совпадение (счётчик не «0 / …»). */
  hasSelection(): boolean {
    return this.selected != null;
  }

  private indexOfSelected(list: SearchMatch<H>[]): number {
    const selected = this.selected;
    if (!selected) return -1;
    return list.findIndex((match) => identityOf(match) === selected.identity);
  }

  private select(match: SearchMatch<H> | null | undefined): R | null {
    if (!match) {
      this.selected = null;
      return null;
    }
    const from = match.kind === "doc" ? match.from : match.anchor;
    const to = match.kind === "doc" ? match.to : match.anchor;
    this.selected = { identity: identityOf(match), start: startKey(match), kind: match.kind, from, to };
    this.lastFrom = from;
    this.lastTo = to;
    return this.result(match);
  }

  private result(match: SearchMatch<H>): R {
    return match.kind === "doc" ? this.host.docResult(match.from, match.to) : this.host.blockResult(match);
  }
}
