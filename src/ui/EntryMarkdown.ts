/**
 * Отрисовка записей блокнота как markdown: в блокноте, в его архиве и в корзине.
 * Общие правила: ссылки [[…]] открываются как в заметке, чекбоксы в тексте - просто разметка,
 * и блок плагина внутри отрисованной записи не рисуется (иначе он рисовал бы сам себя без конца).
 */

import { Keymap, MarkdownRenderer, type App, type Component } from "obsidian";

/** Класс элемента с отрисованным текстом записи (блокнот, архив, корзина). */
export const ENTRY_TEXT_CLASS = "inbox-text";

/** Отрисовать текст записи как markdown; если не вышло - простой текст с переносами строк. */
export async function renderEntryMarkdown(
  app: App,
  text: string,
  el: HTMLElement,
  sourcePath: string,
  component: Component
): Promise<void> {
  try {
    await MarkdownRenderer.render(app, text, el, sourcePath, component);
  } catch (error) {
    console.error("[Inbox] markdown render failed:", error);
    el.empty();
    el.addClass("is-plain");
    el.setText(text);
  }
  // Чекбокс в тексте записи - просто разметка: щелчок не должен менять только картинку.
  el.querySelectorAll("input[type=checkbox]").forEach((checkbox) => checkbox.setAttribute("disabled", ""));
}

/** Щелчок по [[ссылке]] в отрисованной записи: открыть заметку (Ctrl/Cmd - в новой вкладке). */
export function openInternalLink(app: App, ev: MouseEvent, sourcePath: string): void {
  const link = (ev.target as HTMLElement | null)?.closest?.("a.internal-link") as HTMLAnchorElement | null;
  if (!link) return;
  const href = (link.getAttribute("data-href") || link.getAttribute("href") || "").trim();
  if (!href || /^[\w+.-]+:/.test(href)) return;
  ev.preventDefault();
  ev.stopPropagation();
  void app.workspace.openLinkText(href, sourcePath, Keymap.isModEvent(ev));
}

/** Элемент стоит внутри отрисованной записи: блок плагина там не рисуется. */
export function isInsideRenderedEntry(el: HTMLElement): boolean {
  return el.parentElement?.closest(`.${ENTRY_TEXT_CLASS}`) != null;
}
