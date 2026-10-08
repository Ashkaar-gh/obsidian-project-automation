/**
 * Записи блокнота: чистые функции без Obsidian API (покрыты тестами).
 *
 * Запись - markdown-текст, в том числе многострочный. Записи различаются по тексту (без пробелов по краям):
 * так было и раньше, поэтому повтор не добавляется второй раз. Время создания хранится отдельно,
 * в `inboxCreatedAt` (текст → ISO): массив `inbox` остаётся массивом строк, и версия плагина без этого поля
 * (например, на другом устройстве с синхронизированным data.json) продолжает его читать. Так же, отдельно,
 * хранится привязка записи к задаче или проекту - `inboxLinks` (текст → привязка).
 */

import { formatDateKey } from "./DateUtils";

/**
 * К чему относится запись: задача (путь заметки-задачи) или проект (значение из списка проектов, как во frontmatter
 * задач). Одно из двух; задача важнее - проект у неё свой, во frontmatter.
 */
export interface InboxLink {
  task?: string;
  project?: string;
}

/** Поля data.json, которые меняют функции этого модуля. */
export interface InboxStore {
  inbox?: string[];
  inboxCreatedAt?: Record<string, string>;
  inboxLinks?: Record<string, InboxLink>;
}

/** Привязка из data.json: задача или проект (непустая строка). Всё остальное - привязки нет (null). */
export function normalizeInboxLink(value: unknown): InboxLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const task = typeof raw.task === "string" ? raw.task.trim() : "";
  if (task) return { task };
  const project = typeof raw.project === "string" ? raw.project.trim() : "";
  return project ? { project } : null;
}

/** Оставить привязки только у записей, которые есть в блокноте (и только корректные). */
export function pruneInboxLinks(
  links: Record<string, unknown> | undefined,
  inbox: readonly string[]
): Record<string, InboxLink> {
  const keys = new Set(inbox.map(normalizeInboxText));
  const out: Record<string, InboxLink> = {};
  for (const [key, value] of Object.entries(links ?? {})) {
    const link = normalizeInboxLink(value);
    if (link && keys.has(key)) out[key] = link;
  }
  return out;
}

export type AddInboxResult = "added" | "exists" | "empty";
export type EditInboxResult = "updated" | "unchanged" | "missing" | "exists" | "empty";

/**
 * Текст записи: переводы строк Windows → \n, пустые строки в начале и пробелы в конце убираются.
 * У многострочной записи отступ первой строки сохраняется (кусок кода вставляется как есть), однострочная
 * обрезается с обеих сторон, чтобы случайный пробел не делал из неё другую запись. Этот же текст - ключ записи.
 */
export function normalizeInboxText(raw: string): string {
  const text = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*\n/, "")
    .replace(/\s+$/, "");
  return text.includes("\n") ? text : text.trim();
}

/** Оставить время создания только у записей, которые есть в блокноте. */
export function pruneInboxCreatedAt(
  createdAt: Record<string, string> | undefined,
  inbox: readonly string[]
): Record<string, string> {
  const keys = new Set(inbox.map(normalizeInboxText));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(createdAt ?? {})) {
    if (keys.has(key) && typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Добавить запись (link - к чему она относится). Повтор не добавляется: запись уже есть, ничего не теряется;
 * если у неё ещё нет привязки, она берётся у повтора (чужая привязка не подменяется).
 */
export function addInboxEntry(store: InboxStore, text: string, nowIso: string, link?: InboxLink | null): AddInboxResult {
  const value = normalizeInboxText(text);
  if (!value) return "empty";
  const inbox = store.inbox ?? [];
  const valid = normalizeInboxLink(link);
  if (inbox.some((line) => normalizeInboxText(line) === value)) {
    if (valid && !normalizeInboxLink(store.inboxLinks?.[value])) {
      store.inboxLinks = { ...pruneInboxLinks(store.inboxLinks, inbox), [value]: valid };
    }
    return "exists";
  }
  const next = [...inbox, value];
  store.inbox = next;
  store.inboxCreatedAt = { ...pruneInboxCreatedAt(store.inboxCreatedAt, next), [value]: nowIso };
  if (valid || store.inboxLinks) {
    // Чистка - по блокноту до добавления: привязка, оставшаяся от удалённой записи с тем же текстом
    // (её могла удалить версия плагина без привязок), новой записи не достаётся.
    store.inboxLinks = { ...pruneInboxLinks(store.inboxLinks, inbox), ...(valid && { [value]: valid }) };
  }
  return "added";
}

/** Заменить текст записи; время создания и привязка переходят к новому тексту. */
export function editInboxEntry(store: InboxStore, oldText: string, newText: string): EditInboxResult {
  const from = normalizeInboxText(oldText);
  const to = normalizeInboxText(newText);
  if (!to) return "empty";
  if (to === from) return "unchanged";
  const inbox = store.inbox ?? [];
  const index = inbox.findIndex((line) => normalizeInboxText(line) === from);
  if (index === -1) return "missing";
  if (inbox.some((line, i) => i !== index && normalizeInboxText(line) === to)) return "exists";
  const next = [...inbox];
  next[index] = to;
  store.inbox = next;
  const createdAt = { ...(store.inboxCreatedAt ?? {}) };
  if (typeof createdAt[from] === "string") createdAt[to] = createdAt[from];
  delete createdAt[from];
  store.inboxCreatedAt = pruneInboxCreatedAt(createdAt, next);
  if (store.inboxLinks) {
    const links: Record<string, unknown> = { ...store.inboxLinks };
    if (links[from] !== undefined) links[to] = links[from];
    delete links[from];
    store.inboxLinks = pruneInboxLinks(links, next);
  }
  return "updated";
}

/** Привязать запись к задаче или проекту (null - убрать привязку). "missing" - записи нет в блокноте. */
export function setInboxEntryLink(
  store: InboxStore,
  text: string,
  link: InboxLink | null
): "updated" | "unchanged" | "missing" {
  const key = normalizeInboxText(text);
  const inbox = store.inbox ?? [];
  if (!inbox.some((line) => normalizeInboxText(line) === key)) return "missing";
  const next = normalizeInboxLink(link);
  const prev = normalizeInboxLink(store.inboxLinks?.[key]);
  if (JSON.stringify(next) === JSON.stringify(prev)) return "unchanged";
  const links = pruneInboxLinks(store.inboxLinks, inbox);
  if (next) links[key] = next;
  else delete links[key];
  store.inboxLinks = links;
  return "updated";
}

/** Убрать запись из блокнота; createdAt - когда она была записана, link - к чему относилась (для архива). */
export function removeInboxEntry(
  store: InboxStore,
  text: string
): { removed: boolean; createdAt?: string; link?: InboxLink } {
  const value = normalizeInboxText(text);
  const inbox = store.inbox ?? [];
  const next = inbox.filter((line) => normalizeInboxText(line) !== value);
  if (next.length === inbox.length) return { removed: false };
  const createdAt = store.inboxCreatedAt?.[value];
  const link = normalizeInboxLink(store.inboxLinks?.[value]);
  store.inbox = next;
  store.inboxCreatedAt = pruneInboxCreatedAt(store.inboxCreatedAt, next);
  if (store.inboxLinks) store.inboxLinks = pruneInboxLinks(store.inboxLinks, next);
  return {
    removed: true,
    ...(typeof createdAt === "string" && { createdAt }),
    ...(link && { link }),
  };
}

/**
 * Запись блокнота в корзине: когда записана и к чему относилась. Хранится отдельно от корзины (`trashMeta`,
 * строка корзины → сведения): корзина остаётся массивом строк, как у прежних версий плагина.
 */
export interface TrashEntryMeta {
  createdAt?: string;
  link?: InboxLink;
}

/** Сведения о записях корзины: только корректные и только для строк, которые в корзине есть. */
export function pruneTrashMeta(
  meta: Record<string, unknown> | undefined,
  trash: readonly string[]
): Record<string, TrashEntryMeta> {
  const lines = new Set(trash);
  const out: Record<string, TrashEntryMeta> = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (!lines.has(key) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const raw = value as Record<string, unknown>;
    const createdAt = typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : undefined;
    const link = normalizeInboxLink(raw.link);
    if (createdAt || link) out[key] = { ...(createdAt && { createdAt }), ...(link && { link }) };
  }
  return out;
}

/**
 * Положить строку в корзину вместе со сведениями о записи (время записи и привязка). Сведения строки - от последнего
 * удаления: у повтора без них прежние убираются.
 */
export function addToTrash(
  store: { trash?: string[]; trashMeta?: Record<string, TrashEntryMeta> },
  line: string,
  meta: TrashEntryMeta = {}
): void {
  const trash = [...(store.trash ?? []), line];
  store.trash = trash;
  const info = pruneTrashMeta({ [line]: meta }, trash)[line];
  if (!info && !store.trashMeta) return;
  const next = pruneTrashMeta(store.trashMeta, trash);
  if (info) next[line] = info;
  else delete next[line];
  store.trashMeta = next;
}

/**
 * Заметку-задачу переименовали или перенесли: привязки записей блокнота, архива и корзины идут за ней.
 * true - что-то поменялось (тогда data.json нужно сохранить).
 */
export function renameInboxLinkTask(
  store: {
    inboxLinks?: Record<string, InboxLink>;
    inboxArchive?: Array<{ link?: InboxLink }>;
    trashMeta?: Record<string, TrashEntryMeta>;
  },
  oldPath: string,
  newPath: string
): boolean {
  if (!oldPath || !newPath || oldPath === newPath) return false;
  let changed = false;
  if (store.inboxLinks) {
    const next: Record<string, InboxLink> = {};
    for (const [key, link] of Object.entries(store.inboxLinks)) {
      if (link?.task === oldPath) {
        next[key] = { task: newPath };
        changed = true;
      } else {
        next[key] = link;
      }
    }
    if (changed) store.inboxLinks = next;
  }
  if (store.inboxArchive?.some((item) => item?.link?.task === oldPath)) {
    store.inboxArchive = store.inboxArchive.map((item) =>
      item?.link?.task === oldPath ? { ...item, link: { task: newPath } } : item
    );
    changed = true;
  }
  if (store.trashMeta && Object.values(store.trashMeta).some((meta) => meta?.link?.task === oldPath)) {
    const next: Record<string, TrashEntryMeta> = {};
    for (const [key, meta] of Object.entries(store.trashMeta)) {
      next[key] = meta?.link?.task === oldPath ? { ...meta, link: { task: newPath } } : meta;
    }
    store.trashMeta = next;
    changed = true;
  }
  return changed;
}

const EMBED_REGEX = /!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g;
const FENCE_REGEX = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Название и остальной текст записи (для задачи). Название - первая строка вне блоков кода, в которой есть что-то
 * кроме встроенных картинок; rest - всё остальное, включая картинки из этой строки. Если такой строки нет
 * (запись - только код или картинки), название - первая строка кода, а rest - весь текст: ничего не теряется.
 */
export function splitInboxEntry(text: string): { title: string; rest: string } {
  const normalized = normalizeInboxText(text);
  const lines = normalized.split("\n");
  let fence: string | null = null;
  let firstCodeLine = -1;
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(FENCE_REGEX)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) {
      if (firstCodeLine === -1 && lines[i].trim()) firstCodeLine = i;
      continue;
    }
    if (lines[i].replace(EMBED_REGEX, "").trim() !== "") {
      index = i;
      break;
    }
  }
  if (index === -1) {
    return { title: firstCodeLine >= 0 ? lines[firstCodeLine].trim() : "", rest: normalized };
  }
  const line = lines[index];
  const title = line.replace(EMBED_REGEX, " ").replace(/\s+/g, " ").trim();
  const embeds = line.match(EMBED_REGEX) ?? [];
  const restLines = [...lines];
  if (embeds.length > 0) restLines[index] = embeds.join(" ");
  else restLines.splice(index, 1);
  return { title, rest: restLines.join("\n").replace(/^\s*\n/, "").replace(/\s+$/, "") };
}

/** Запись одной строкой (для напоминания: его строка в data.json не может содержать переводов строк). */
export function inboxEntryAsOneLine(text: string): string {
  return normalizeInboxText(text).replace(/\s*\n+\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Подпись времени записи: «сегодня 14:05», «вчера 09:10», «12.09 18:30», «12.09.2025 18:30». Пустая - нет времени. */
export function formatInboxTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "";
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const key = formatDateKey(date);
  if (key === formatDateKey(now)) return `сегодня ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === formatDateKey(yesterday)) return `вчера ${time}`;
  const day = `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}`;
  return date.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${day}.${date.getFullYear()} ${time}`;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

/** Расширение файла для картинки из буфера; null - не картинка (или формат, который Obsidian не покажет). */
export function imageExtensionForMime(mime: string): string | null {
  return IMAGE_EXTENSIONS[String(mime ?? "").toLowerCase().trim()] ?? null;
}

/** Имя вложения как у Obsidian: «Pasted image 20260928141530.png». */
export function pastedImageFileName(date: Date, extension: string): string {
  const stamp =
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  return `Pasted image ${stamp}.${extension}`;
}
