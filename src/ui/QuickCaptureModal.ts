/**
 * Окно «Запись в блокнот»: записать в блокнот, не уходя из текущей заметки.
 * Открывается командой «Запись в блокнот» (удобно на горячей клавише) и иконкой на ленте.
 * Под текстом - необязательное поле «Относится к» (задача или проект записи).
 */

import { Modal, Platform, setTooltip, type App } from "obsidian";
import { attachInboxComposer, isComposerBusy, whenComposerIdle } from "./InboxComposer";
import { createInboxLinkField, type InboxLinkField } from "./InboxLinkField";
import { UI_LABELS } from "./Labels";
import type { InboxLinkOption } from "../core/InboxLinks";

export interface QuickCaptureOptions {
  /** Текст при открытии: черновик и/или выделенный текст. */
  initialText: string;
  /** Записать в блокнот (link - к чему запись, null - без привязки); true - запись в блокноте, окно закрывается. */
  onSave: (text: string, link: InboxLinkOption | null) => Promise<boolean>;
  /** Окно закрыто без записи, текст изменён: сохранить черновик. */
  onDraft: (text: string) => void;
  /** Картинки из буфера → вложения (markdown для вставки). */
  saveImages?: (files: File[]) => Promise<string[]>;
  /** Поле «Относится к»: с чем открыть (контекст открытой заметки) и откуда брать варианты. Без него поля нет. */
  link?: {
    initial: InboxLinkOption | null;
    loadOptions: () => Promise<InboxLinkOption[]>;
  };
}

/** Сочетание, которое сохраняет запись (на Mac - Cmd). */
export function inboxSubmitShortcut(): string {
  const L = UI_LABELS.inbox;
  return Platform.isMacOS ? L.submitShortcutMac : L.submitShortcut;
}

/** Подсказка «Ctrl+Enter» при наведении на кнопку, которая сохраняет запись. */
export function addSubmitTooltip(button: HTMLElement): void {
  const shortcut = inboxSubmitShortcut();
  // setTooltip - с Obsidian 1.4.4; в более старом - обычная подсказка браузера.
  if (typeof setTooltip === "function") setTooltip(button, shortcut);
  else button.title = shortcut;
}

export class QuickCaptureModal extends Modal {
  private textarea: HTMLTextAreaElement | null = null;
  private linkField: InboxLinkField | null = null;
  private saving = false;
  private saved = false;

  constructor(app: App, private readonly options: QuickCaptureOptions) {
    super(app);
  }

  onOpen(): void {
    const L = UI_LABELS.inbox.quickCapture;
    this.modalEl.addClass("opa-quick-capture-modal");
    this.titleEl.setText(L.title);
    this.contentEl.empty();

    const textarea = this.contentEl.createEl("textarea", {
      cls: "inbox-composer-input opa-quick-capture-input",
      attr: { rows: "3", placeholder: UI_LABELS.inbox.addPlaceholder },
    });
    textarea.value = this.options.initialText;
    this.textarea = textarea;
    attachInboxComposer(textarea, {
      onSubmit: () => void this.submit(),
      saveImages: this.options.saveImages,
      maxRows: 14,
    });
    // Ctrl/Cmd+Enter - через область окна: иначе его может перехватить горячая клавиша редактора под окном.
    this.scope.register(["Mod"], "Enter", (evt: KeyboardEvent) => {
      if (evt.isComposing) return true;
      evt.preventDefault();
      void this.submit();
      return false;
    });

    // «Относится к»: сразу под текстом, Tab из текста переходит в него. Ctrl+Enter в поле тоже сохраняет запись.
    if (this.options.link) {
      this.linkField = createInboxLinkField(this.app, this.contentEl, {
        initial: this.options.link.initial,
        loadOptions: this.options.link.loadOptions,
        onSubmit: () => void this.submit(),
      });
    }

    // Кнопки как в других окнах плагина: «Отмена» и «Сохранить» рядом, справа. Слева - подсказка про Ctrl+Enter
    // (на телефоне её нет: там обычно нет клавиатуры с Ctrl).
    const buttons = this.contentEl.createDiv({ cls: "opa-quick-capture-buttons" });
    if (!Platform.isMobile) {
      buttons.createEl("span", { cls: "opa-quick-capture-shortcut", text: UI_LABELS.inbox.submitHint(inboxSubmitShortcut()) });
    }
    buttons.createEl("button", { text: UI_LABELS.common.cancel, cls: "mod-secondary" }).addEventListener("click", () => this.close());
    const saveBtn = buttons.createEl("button", { text: UI_LABELS.common.save, cls: "mod-cta" });
    saveBtn.addEventListener("click", () => void this.submit());
    addSubmitTooltip(saveBtn);

    window.setTimeout(() => {
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    }, 0);
  }

  private async submit(): Promise<void> {
    const textarea = this.textarea;
    if (this.saving || this.saved || !textarea) return;
    this.saving = true;
    try {
      // Скриншот ещё сохраняется: ждём, чтобы ссылка на него попала в запись.
      await whenComposerIdle(textarea);
      if (this.textarea !== textarea) return;
      const text = textarea.value;
      if (!text.trim()) {
        this.close();
        return;
      }
      if (await this.options.onSave(text, this.linkField?.value() ?? null)) {
        this.saved = true;
        this.close();
      }
    } finally {
      this.saving = false;
    }
  }

  onClose(): void {
    // Повторное закрытие ничего не меняет (поле уже убрано).
    const textarea = this.textarea;
    if (!textarea) return;
    this.textarea = null;
    this.linkField?.close();
    this.linkField = null;
    // Черновик меняется, только если текст правили: просто открыть и закрыть окно - ничего не трогает.
    const keepDraft = (): void => {
      if (!this.saved && textarea.value !== this.options.initialText) this.options.onDraft(textarea.value);
    };
    // Окно закрыли, пока сохраняется скриншот: ссылка на него должна попасть в черновик.
    if (isComposerBusy(textarea)) void whenComposerIdle(textarea).then(keepDraft);
    else keepDraft();
    this.contentEl.empty();
  }
}
