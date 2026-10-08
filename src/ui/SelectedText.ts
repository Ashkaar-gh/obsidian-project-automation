/**
 * Выделенный текст для окон записи («Запись в блокнот», «Новое напоминание»).
 */

import type { App, MarkdownFileInfo } from "obsidian";

/**
 * Сначала - выделение на странице вне редактора (режим чтения, блок задачи, боковая панель): в режиме чтения
 * у заметки остаётся старое выделение скрытого редактора, и оно не должно подменять новое. Выделение редактора
 * берётся только в режиме правки (в нём оно точнее: включает строки за пределами экрана). Нет выделения - "".
 */
export function getSelectedText(app: App): string {
  try {
    const win = ((globalThis as { activeWindow?: Window }).activeWindow ?? window) as Window;
    const selection = win.getSelection?.();
    const domText = selection?.toString() ?? "";
    const anchor = selection?.anchorNode ?? null;
    const anchorEl = anchor && anchor.nodeType === 1 ? (anchor as Element) : anchor?.parentElement ?? null;
    if (domText.trim() && !anchorEl?.closest?.(".cm-editor")) return domText;
    const active = app.workspace.activeEditor as (MarkdownFileInfo & { getMode?: () => string }) | null;
    if (active && active.getMode?.() === "preview") return "";
    const editorText = active?.editor?.getSelection?.() ?? "";
    return editorText.trim() ? editorText : "";
  } catch {
    return "";
  }
}
