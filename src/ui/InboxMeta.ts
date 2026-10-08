/**
 * Подпись под записью блокнота: когда она сделана и к чему относится («сегодня 14:05 · Trino ACL · Trino»).
 * Одна и та же в блокноте, в архиве, в блоке «Блокнот» задачи и в корзине.
 */

import { formatInboxTime } from "../core/InboxEntries";
import type { InboxLinkView } from "../modules/InboxLinkSources";
import { UI_LABELS } from "./Labels";

/** Полная дата и время: «04.10.2026, 12:16» (подсказка к времени записи, дата разбора в архиве). */
export function formatInboxFullDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

/**
 * Подпись привязки под записью: «Trino ACL · Trino» (ссылки на заметки задачи и проекта). Заметки задачи нет -
 * имя зачёркнуто; проект без заметки - просто текст.
 */
export function renderLinkView(parent: HTMLElement, view: InboxLinkView): void {
  const L = UI_LABELS.inbox.link;
  const unresolved = view.kind === "task" && view.href == null;
  const wrap = parent.createEl("span", { cls: unresolved ? "inbox-link is-unresolved" : "inbox-link" });
  const add = (name: string, href: string | null, cls: string): void => {
    if (href != null) wrap.createEl("a", { cls: `internal-link ${cls}`, text: name, attr: { "data-href": href, href } });
    else wrap.createEl("span", { cls, text: name, attr: unresolved && cls === "inbox-link-task" ? { title: L.missing } : {} });
  };
  add(view.name, view.href, view.kind === "task" ? "inbox-link-task" : "inbox-link-project");
  for (const project of view.projects) {
    wrap.createEl("span", { cls: "inbox-link-sep", text: " · " });
    add(project.name, project.href, "inbox-link-project");
  }
}

/** Строка «когда · к чему» под записью; ни времени, ни привязки - строки нет. */
export function renderInboxMeta(
  parent: HTMLElement,
  opts: { createdAt: string | undefined; view: InboxLinkView | null; now: Date }
): void {
  const time = formatInboxTime(opts.createdAt, opts.now);
  if (!time && !opts.view) return;
  const meta = parent.createEl("div", { cls: "inbox-meta" });
  if (time) {
    const timeEl = meta.createEl("span", { cls: "inbox-time", text: time });
    if (opts.createdAt) timeEl.setAttribute("title", formatInboxFullDate(opts.createdAt));
  }
  if (opts.view) renderLinkView(meta, opts.view);
}
