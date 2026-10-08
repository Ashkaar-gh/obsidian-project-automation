/**
 * Поле записи блокнота: в блоке, в окне «Запись в блокнот» и при правке записи.
 *
 * Многострочный textarea растёт вместе с текстом. Enter переносит строку, как в остальных полях плагина;
 * сохраняют кнопка и Ctrl/Cmd+Enter. Картинка из буфера (скриншот) сохраняется вложением, в текст вставляется
 * ссылка на неё.
 *
 * Только стандартный DOM, без помощников Obsidian: поле проверяется в DOM-тестах.
 */

import { imageExtensionForMime } from "../core/InboxEntries";

export interface InboxComposerOptions {
  /** Ctrl/Cmd+Enter: сохранить. */
  onSubmit: () => void;
  /** Escape (при правке записи - отмена). Без обработчика Escape не перехватывается: окно закроется само. */
  onEscape?: () => void;
  /** Сохранить картинки из буфера вложениями; вернуть markdown для вставки, по одному на файл. */
  saveImages?: (files: File[]) => Promise<string[]>;
  /** До скольких строк поле растёт, дальше появляется прокрутка. */
  maxRows?: number;
}

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "isComposing"> & {
  keyCode?: number;
};

/** Сохраняет ли это нажатие запись: Ctrl/Cmd+Enter, но не во время набора через IME (там Enter подтверждает слово). */
export function isInboxSubmitKey(e: KeyLike): boolean {
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return false;
  return e.ctrlKey || e.metaKey;
}

const DEFAULT_MAX_ROWS = 12;

/** Подогнать высоту под текст (до maxRows строк). */
export function autosizeTextarea(textarea: HTMLTextAreaElement, maxRows = DEFAULT_MAX_ROWS): void {
  const view = textarea.ownerDocument?.defaultView;
  const style = view?.getComputedStyle ? view.getComputedStyle(textarea) : null;
  const num = (value: string | undefined, fallback: number): number => {
    const n = parseFloat(value ?? "");
    return Number.isFinite(n) ? n : fallback;
  };
  const lineHeight = num(style?.lineHeight, num(style?.fontSize, 14) * 1.5);
  const extra =
    num(style?.paddingTop, 0) + num(style?.paddingBottom, 0) +
    num(style?.borderTopWidth, 0) + num(style?.borderBottomWidth, 0);
  const max = Math.round(lineHeight * maxRows + extra);
  textarea.style.height = "auto";
  // Поле не отрисовано (вне документа или в свёрнутом блоке): высоту не знаем - оставляем CSS, подгоним позже.
  if (textarea.scrollHeight <= 0) {
    textarea.style.height = "";
    textarea.style.overflowY = "";
    return;
  }
  const needed = textarea.scrollHeight + num(style?.borderTopWidth, 0) + num(style?.borderBottomWidth, 0);
  textarea.style.height = `${Math.min(needed, max)}px`;
  textarea.style.overflowY = needed > max ? "auto" : "hidden";
}

/** Вставить текст на место выделения [start, end) и сообщить полю о правке (высота, черновик). */
export function insertIntoTextarea(textarea: HTMLTextAreaElement, text: string, start: number, end: number): void {
  const length = textarea.value.length;
  const from = Math.max(0, Math.min(start, length));
  const to = Math.max(from, Math.min(end, length));
  if (typeof textarea.setRangeText === "function") {
    textarea.setRangeText(text, from, to, "end");
  } else {
    textarea.value = textarea.value.slice(0, from) + text + textarea.value.slice(to);
    const caret = from + text.length;
    textarea.setSelectionRange(caret, caret);
  }
  textarea.dispatchEvent(new (textarea.ownerDocument.defaultView?.Event ?? Event)("input", { bubbles: true }));
}

/** Картинки из события вставки. Если в буфере есть и текст (Excel, Word кладут оба), берётся текст: картинок нет. */
export function imagesFromClipboard(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const text = data.getData("text/plain");
  if (text && text.trim()) return [];
  const files: File[] = [];
  for (const file of Array.from(data.files ?? [])) {
    if (imageExtensionForMime(file.type)) files.push(file);
  }
  if (files.length === 0 && data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file && imageExtensionForMime(file.type)) files.push(file);
    }
  }
  return files;
}

/** Картинки, которые ещё сохраняются в поле: запись ждёт их, иначе ссылка на картинку не попадёт в текст. */
const pendingPastes = new WeakMap<HTMLTextAreaElement, Set<Promise<void>>>();

/** Идёт ли в поле сохранение вставленной картинки. */
export function isComposerBusy(textarea: HTMLTextAreaElement): boolean {
  return (pendingPastes.get(textarea)?.size ?? 0) > 0;
}

/** Дождаться, пока вставленные картинки сохранятся и ссылки на них окажутся в тексте поля. */
export async function whenComposerIdle(textarea: HTMLTextAreaElement): Promise<void> {
  while (isComposerBusy(textarea)) {
    await Promise.all([...(pendingPastes.get(textarea) ?? [])]);
  }
}

function trackPaste(textarea: HTMLTextAreaElement, job: Promise<void>): void {
  let jobs = pendingPastes.get(textarea);
  if (!jobs) {
    jobs = new Set();
    pendingPastes.set(textarea, jobs);
  }
  const tracked = job.finally(() => jobs?.delete(tracked));
  jobs.add(tracked);
}

/** Подключить поведение поля записи к textarea. */
export function attachInboxComposer(textarea: HTMLTextAreaElement, options: InboxComposerOptions): void {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const resize = (): void => autosizeTextarea(textarea, maxRows);

  textarea.addEventListener("input", resize);
  // Блок могли развернуть уже после отрисовки: при фокусе высота подгоняется под текст.
  textarea.addEventListener("focus", resize);
  textarea.addEventListener("keydown", (e) => {
    // Уже обработано раньше (например, горячей клавишей окна) - второй раз не сохраняем.
    if (e.defaultPrevented) return;
    // Набор через IME: Enter подтверждает слово, Escape отменяет подсказку - это не команды поля.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape" && options.onEscape) {
      e.preventDefault();
      e.stopPropagation();
      options.onEscape();
      return;
    }
    if (isInboxSubmitKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      options.onSubmit();
    }
  });

  if (options.saveImages) {
    const saveImages = options.saveImages;
    textarea.addEventListener("paste", (e) => {
      const files = imagesFromClipboard(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      trackPaste(
        textarea,
        saveImages(files)
          .then((snippets) => {
            if (snippets.length > 0) insertIntoTextarea(textarea, snippets.join("\n"), start, end);
          })
          .catch((error) => console.error("[Inbox] image paste failed:", error))
      );
    });
  }

  // Высота по начальному тексту: у поля, ещё не вставленного в документ, scrollHeight равен 0 - тогда позже.
  resize();
  if (!textarea.isConnected) {
    const view = textarea.ownerDocument?.defaultView;
    const schedule = view?.requestAnimationFrame?.bind(view) ?? ((cb: () => void) => setTimeout(cb, 0));
    schedule(() => resize());
  }
}
