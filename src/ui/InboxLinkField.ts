/**
 * Поле «Относится к»: одна строка под текстом записи, во всю его ширину - в окне «Запись в блокнот», под полем ввода
 * блокнота и при правке записи. Привязка необязательна: запись сохраняется и без неё. Поле открывается с задачей
 * или проектом открытой заметки (контекст) или с привязкой записи, сменить - набрать пару букв и выбрать из списка
 * (сверху проекты, затем задачи: «В работе» первыми, у каждой - статус), крестик в поле - убрать. Набранный,
 * но не выбранный текст привязку не меняет; стёртый целиком - убирает.
 */

import { AbstractInputSuggest, requireApiVersion, setIcon, type App } from "obsidian";
import { UI_LABELS } from "./Labels";
import { isInboxSubmitKey } from "./InboxComposer";
import {
  LINK_OPTIONS_LIMIT,
  filterLinkOptions,
  linkOptionLabel,
  linkOptionProjects,
  optionToLink,
  taskStatusLabel,
  type InboxLinkOption,
} from "../core/InboxLinks";

export interface InboxLinkFieldOptions {
  /** С чем поле открывается (контекст открытой заметки или привязка записи); null - пустое. */
  initial: InboxLinkOption | null;
  /** Варианты выбора. */
  loadOptions: () => Promise<InboxLinkOption[]>;
  /**
   * Загрузить варианты сразу (окно: к первому фокусу они готовы). false - при первом фокусе в поле: блок
   * на домашней странице перерисовывается часто, а в поле заходят не всегда.
   */
  preload?: boolean;
  /** Ctrl/Cmd+Enter в поле - сохранить запись, как и в поле текста. */
  onSubmit?: () => void;
  /** Escape в поле, когда список закрыт (правка записи - отмена). */
  onEscape?: () => void;
}

export interface InboxLinkField {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  /** Выбранная привязка; null - без привязки. */
  value(): InboxLinkOption | null;
  /** Поставить привязку (null - очистить поле). */
  setValue(option: InboxLinkOption | null): void;
  /** Закрыть список вариантов (окно закрывается). */
  close(): void;
}

/**
 * Вариант в списке, как в списках Obsidian: имя, ниже мельче - статус и проект задачи («⚙️ В работе · Trino»),
 * у проекта - «проект».
 */
export function renderLinkOption(option: InboxLinkOption, el: HTMLElement): void {
  el.addClass("mod-complex");
  const content = el.createDiv({ cls: "suggestion-content" });
  content.createDiv({ cls: "suggestion-title", text: option.name });
  if (option.kind === "project") {
    content.createDiv({ cls: "suggestion-note", text: UI_LABELS.inbox.link.projectNote });
    return;
  }
  const status = taskStatusLabel(option.status);
  const projects = linkOptionProjects(option);
  if (!status && !projects) return;
  const note = content.createDiv({ cls: "suggestion-note" });
  if (status) note.createEl("span", { cls: "opa-link-status", text: status });
  if (status && projects) note.createEl("span", { cls: "opa-link-sep", text: " · " });
  if (projects) note.createEl("span", { cls: "opa-link-projects", text: projects });
}

let fieldCounter = 0;

/** Один и тот же вариант (задача - по пути, проект - по значению). */
function sameOption(a: InboxLinkOption, b: InboxLinkOption): boolean {
  return JSON.stringify(optionToLink(a)) === JSON.stringify(optionToLink(b));
}

/** Поле «Относится к»; null - в этой версии Obsidian нет подсказок в полях ввода (нужна 1.5.7+), поля нет. */
export function createInboxLinkField(
  app: App,
  parent: HTMLElement,
  options: InboxLinkFieldOptions
): InboxLinkField | null {
  if (typeof AbstractInputSuggest !== "function" || !requireApiVersion("1.5.7")) return null;
  const L = UI_LABELS.inbox.link;
  const row = parent.createDiv({ cls: "opa-inbox-link-field" });
  const id = `opa-inbox-link-${++fieldCounter}`;
  row.createEl("label", { cls: "opa-inbox-link-label", text: L.label, attr: { for: id } });
  // Поле тянется до правого края, как поле текста над ним; крестик - внутри поля, справа.
  const control = row.createDiv({ cls: "opa-inbox-link-control" });
  const input = control.createEl("input", {
    cls: "opa-inbox-link-input",
    attr: { id, type: "text", placeholder: L.placeholder, autocomplete: "off", spellcheck: "false" },
  });
  const clear = control.createEl("button", {
    cls: "opa-inbox-link-clear clickable-icon",
    attr: { type: "button", "aria-label": L.clear },
  });
  setIcon(clear, "x");

  let current: InboxLinkOption | null = options.initial;
  // Варианты грузятся сразу при открытии окна: к первому фокусу в поле они уже готовы, и список отвечает сразу.
  let all: InboxLinkOption[] | null = null;
  let loading: Promise<InboxLinkOption[]> | null = null;
  const load = (): Promise<InboxLinkOption[]> =>
    (loading ??= options.loadOptions().then(
      (list) => (all = list),
      (error) => {
        console.error("[Inbox] link options failed:", error);
        return (all = []);
      }
    ));
  if (options.preload !== false) void load();
  const show = (): void => {
    input.value = current ? linkOptionLabel(current) : "";
    row.toggleClass("has-link", current != null);
  };
  /**
   * Список для запроса. В поле подпись уже выбранного (фокус, клик) - весь список, и выбранное в нём первым:
   * Tab и Enter подтверждают привязку, а не меняют её на верхнюю задачу.
   */
  const suggestionsFor = (list: InboxLinkOption[], query: string): InboxLinkOption[] => {
    const q = current && query === linkOptionLabel(current) ? "" : query;
    const found = filterLinkOptions(list, q, LINK_OPTIONS_LIMIT);
    const chosen = current;
    if (q.trim() || !chosen) return found;
    return [chosen, ...found.filter((option) => !sameOption(option, chosen))].slice(0, LINK_OPTIONS_LIMIT);
  };
  /** Поле ещё в окне и в фокусе: поздний ответ не открывает список в закрытом окне. */
  const isActive = (): boolean => input.isConnected && input.ownerDocument.activeElement === input;
  /** Открыт ли список: Escape при открытом списке закрывает список, а не отменяет правку. */
  let listOpen = false;
  // Список Obsidian - всплывающий элемент .suggestion-container в документе: его видно и без open() (запасная проверка).
  const isListOpen = (): boolean => listOpen || input.ownerDocument.querySelector(".suggestion-container") != null;

  class LinkSuggest extends AbstractInputSuggest<InboxLinkOption> {
    protected getSuggestions(query: string): InboxLinkOption[] | Promise<InboxLinkOption[]> {
      if (all) return suggestionsFor(all, query);
      return load().then((list) => (isActive() ? suggestionsFor(list, query) : []));
    }

    open(): void {
      super.open();
      listOpen = true;
    }

    close(): void {
      super.close();
      listOpen = false;
    }

    renderSuggestion(option: InboxLinkOption, el: HTMLElement): void {
      renderLinkOption(option, el);
    }

    selectSuggestion(option: InboxLinkOption): void {
      current = option;
      show();
      this.close();
    }
  }
  const suggest = new LinkSuggest(app, input);
  suggest.limit = LINK_OPTIONS_LIMIT;
  // Пока список открыт, клавиши идут в его область: Ctrl+Enter и здесь сохраняет запись, а не уходит
  // горячей клавише редактора под окном (та переключила бы чекбокс в заметке).
  suggest.scope?.register?.(["Mod"], "Enter", (evt: KeyboardEvent) => {
    if (evt.isComposing) return true;
    evt.preventDefault();
    options.onSubmit?.();
    return false;
  });

  // В поле с привязкой набор заменяет подпись целиком, а не дописывается к ней. Щелчок мышью снял бы выделение
  // при отпускании кнопки - первое отпускание после фокуса пропускаем.
  let keepSelection = false;
  input.addEventListener("focus", () => {
    void load();
    input.select();
    keepSelection = true;
  });
  input.addEventListener("mouseup", (evt) => {
    if (keepSelection) evt.preventDefault();
    keepSelection = false;
  });
  input.addEventListener("keydown", (evt) => {
    keepSelection = false;
    if (evt.key === "Escape" && options.onEscape && !isListOpen() && !evt.isComposing) {
      evt.preventDefault();
      evt.stopPropagation();
      options.onEscape();
      return;
    }
    if (!isInboxSubmitKey(evt)) return;
    evt.preventDefault();
    options.onSubmit?.();
  });
  // Стёртое поле - без привязки сразу, даже если Ctrl+Enter нажат, не выходя из поля.
  input.addEventListener("input", () => {
    if (input.value.trim()) return;
    current = null;
    row.toggleClass("has-link", false);
  });
  input.addEventListener("blur", () => {
    if (!input.value.trim()) current = null;
    show();
  });
  clear.addEventListener("click", () => {
    current = null;
    show();
    suggest.close();
  });
  show();

  return {
    el: row,
    input,
    value: () => current,
    setValue: (option) => {
      current = option;
      show();
    },
    close: () => suggest.close(),
  };
}
