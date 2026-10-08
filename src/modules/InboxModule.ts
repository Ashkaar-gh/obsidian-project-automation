import { Component, Notice, TFile, type App } from "obsidian";
import type { ModuleContext, PluginModule } from "./types";
import { Paths } from "../core/Paths";
import { processFile, read } from "../core/FileIO";
import { formatDateDDMMYYYY, formatDateKey } from "../core/DateUtils";
import { buildReminderLine, formatReminderTime } from "../core/ReminderDataUtils";
import {
  emptyGamificationState,
  readDataFile,
  updateDataFile,
  type InboxArchiveItem,
  INBOX_ARCHIVE_TRASH_PREFIX,
} from "../core/GamificationState";
import {
  addInboxEntry,
  addToTrash,
  editInboxEntry,
  inboxEntryAsOneLine,
  normalizeInboxLink,
  normalizeInboxText,
  removeInboxEntry,
  renameInboxLinkTask,
  setInboxEntryLink,
  splitInboxEntry,
  type AddInboxResult,
  type EditInboxResult,
  type InboxLink,
} from "../core/InboxEntries";
import {
  buildLinkOptions,
  groupInboxEntries,
  inboxLinkKey,
  isSameProject,
  linkOptionLabel,
  optionToLink,
  projectDisplayName,
  projectLinkTarget,
  type InboxLinkOption,
} from "../core/InboxLinks";
import {
  collectProjectNoteValues,
  collectTaskOptions,
  contextLinkOption,
  describeInboxLink,
  linkOptionFromLink,
  projectForLink,
  projectTaskView,
  resolveTaskFile,
  taskProjects,
  type InboxLinkView,
} from "./InboxLinkSources";
import {
  PROJECT_INBOX_BLOCK,
  TASK_INBOX_BLOCK,
  addProjectInboxBlock,
  addTaskInboxBlock,
  hasProjectInboxBlock,
  hasTaskInboxBlock,
  isProjectHubPage,
  moveTaskInboxBlockToTaskView,
} from "../core/TaskNote";
import { appendBlockToTaskDescriptionContent } from "../core/TaskDescriptionUtils";
import { taskNameFromEditorLine } from "../core/DailyNoteEdit";
import { saveImageAttachment } from "../core/Attachments";
import { UI_LABELS } from "../ui/Labels";
import { createCollapsibleSection } from "../ui/CollapsibleSection";
import { BlockRegistry } from "../ui/BlockRegistry";
import { isRenderUnchanged, markRendered, renderSignature } from "../ui/RenderCache";
import { attachInboxComposer, autosizeTextarea, isComposerBusy, whenComposerIdle } from "../ui/InboxComposer";
import { QuickCaptureModal, addSubmitTooltip } from "../ui/QuickCaptureModal";
import { createInboxLinkField, type InboxLinkField } from "../ui/InboxLinkField";
import { isInsideRenderedEntry, openInternalLink, renderEntryMarkdown } from "../ui/EntryMarkdown";
import { formatInboxFullDate, renderInboxMeta, renderLinkView } from "../ui/InboxMeta";
import { getSelectedText } from "../ui/SelectedText";

const DEFAULT_INBOX_REWARDS = { xp: 5, gold: 2 };

interface InboxData {
  visibleLines: string[];
  /** Время создания записей: текст → ISO. */
  createdAt: Record<string, string>;
  /** К чему относятся записи: текст → задача или проект. */
  links: Record<string, InboxLink>;
  inboxArchive: InboxArchiveItem[];
}

/** Состояние поля ввода блока, которое переживает перерисовку (набранный текст, курсор, фокус, привязка). */
interface ComposerState {
  value: string;
  start: number;
  end: number;
  focused: boolean;
  /** Поле «Относится к»: выбранное, набранный текст и фокус. */
  link: { option: InboxLinkOption | null; text: string; focused: boolean } | null;
}

const INBOX_ARCHIVE_COLLAPSED_KEY = "opa-inbox-collapsed-archive";
const QUICK_CAPTURE_DRAFT_KEY = "opa-inbox-quick-capture-draft";
const COMPOSER_SELECTOR = 'textarea[data-focus-restore="add-input"]';

function getInboxArchiveCollapsed(): boolean {
  try {
    return localStorage.getItem(INBOX_ARCHIVE_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function setInboxArchiveCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(INBOX_ARCHIVE_COLLAPSED_KEY, "1");
    else localStorage.removeItem(INBOX_ARCHIVE_COLLAPSED_KEY);
  } catch {}
}

/** Хранилище Obsidian для значений одного хранилища заметок (с 1.8.7); localStorage общий для всех хранилищ. */
type VaultLocalStorage = App & {
  loadLocalStorage?: (key: string) => unknown;
  saveLocalStorage?: (key: string, data: unknown) => void;
};

/** Строка этого хранилища заметок в локальном хранилище Obsidian (на этом устройстве); "" - нет. */
function loadVaultValue(app: App, key: string): string {
  try {
    const vaultStorage = app as VaultLocalStorage;
    if (typeof vaultStorage.loadLocalStorage === "function") {
      const value = vaultStorage.loadLocalStorage(key);
      return typeof value === "string" ? value : "";
    }
    return localStorage.getItem(vaultStorageKey(app, key)) ?? "";
  } catch {
    return "";
  }
}

/** Записать строку этого хранилища заметок (пустая - удалить). */
function saveVaultValue(app: App, key: string, text: string): void {
  try {
    const value = text.trim() ? text : null;
    const vaultStorage = app as VaultLocalStorage;
    if (typeof vaultStorage.saveLocalStorage === "function") {
      vaultStorage.saveLocalStorage(key, value);
      return;
    }
    const storageKey = vaultStorageKey(app, key);
    if (value) localStorage.setItem(storageKey, value);
    else localStorage.removeItem(storageKey);
  } catch {}
}

/** Ключ для Obsidian без loadLocalStorage: с именем хранилища заметок. */
function vaultStorageKey(app: App, key: string): string {
  const name = typeof app.vault?.getName === "function" ? app.vault.getName() : "";
  return name ? `${key}:${name}` : key;
}

/** Имя заметки без папки и .md (у заметки проекта - имя проекта, как у списка задач проекта). */
function noteName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

/**
 * Черновик окна «Запись в блокнот»: переживает закрытие окна и перезапуск Obsidian. Свой у каждого хранилища
 * заметок: черновик рабочего хранилища не должен всплыть и записаться в личном.
 */
function readQuickCaptureDraft(app: App): string {
  return loadVaultValue(app, QUICK_CAPTURE_DRAFT_KEY);
}

function writeQuickCaptureDraft(app: App, text: string): void {
  saveVaultValue(app, QUICK_CAPTURE_DRAFT_KEY, text);
}

/**
 * Блоки «Блокнот», которые прошлая версия ставила в начало задач, перенесены к блоку задачи (на этом устройстве
 * один раз: блок, который потом поставят в начало руками, остаётся на месте).
 */
const TASK_BLOCKS_MOVED_KEY = "opa-task-inbox-blocks-moved";

/** Пауза, за которую переименования заметок собираются в одну пачку (перенос папки). */
const RENAME_BATCH_MS = 200;

/** Сколько после добавления записи ещё возвращать фокус в поле (отложенная перерисовка фокус не крадёт). */
const FOCUS_AFTER_ADD_MS = 2000;

/**
 * Сколько последних записей архива показывать сразу. Архив только растёт, а markdown для каждой записи
 * при каждой перерисовке блока со временем замедлил бы его; более ранние записи - по кнопке.
 */
const ARCHIVE_VISIBLE = 20;

export class InboxModule implements PluginModule {
  private ctx: ModuleContext;
  private registry: BlockRegistry;
  /** Заметка, в которой стоит блок: от неё разрешаются ссылки и считается папка вложений. */
  private sourcePaths = new WeakMap<HTMLElement, string>();
  /** Компонент markdown-рендера текущей отрисовки блока (выгружается при следующей отрисовке и удалении блока). */
  private components = new WeakMap<HTMLElement, Component>();
  /** Номер последней отрисовки блока: устаревшая асинхронная отрисовка не заменяет новую. */
  private renderEpochs = new WeakMap<HTMLElement, number>();
  /** Блоки, чья перерисовка отложена до конца правки записи. */
  private deferredRender = new WeakSet<HTMLElement>();
  /** После добавления записи фокус возвращается в поле ввода этого блока (время добавления). */
  private focusAfterRender = new WeakMap<HTMLElement, number>();
  /** Блоки, где в архиве нажали «Показать более ранние»: дальше архив показывается целиком. */
  private archiveShowAll = new WeakSet<HTMLElement>();
  /** Поле «Относится к» под полем ввода блока (текущее, после последней отрисовки). */
  private composerLinks = new WeakMap<HTMLElement, InboxLinkField>();
  /** Привязка записи в строке (для «Изменить»; после правки - новая). */
  private rowLinks = new WeakMap<HTMLElement, InboxLink | null>();
  private ribbonEl: HTMLElement | null = null;
  /**
   * Блоки «Блокнот» в заметках задач (opa-task-inbox) и проектов (opa-project-inbox): записи, привязанные к задаче;
   * к проекту и к задачам проекта.
   */
  private noteRegistry: BlockRegistry;
  /** Заметки, в которые блок уже вставлялся в этом сеансе (второй раз заметку не читаем). */
  private noteBlockEnsured = new Set<string>();
  /** Переименования заметок, ещё не перенесённые в привязки записей. */
  private pendingRenames: Array<[string, string]> = [];
  private renameTimer: number | null = null;
  private renameQueue: Promise<void> = Promise.resolve();

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.registry = new BlockRegistry({
      app: ctx.app,
      isEnabled: () => ctx.plugin.settings.enableInbox,
      debounceMs: 500,
      domSelector: ".opa-inbox-view",
      createRefresh: (el) => (force) => this.render(el, force),
      onPrune: (el) => this.releaseComponent(el),
    });
    this.noteRegistry = new BlockRegistry({
      app: ctx.app,
      isEnabled: () => ctx.plugin.settings.enableInbox,
      debounceMs: 500,
      domSelector: ".opa-note-inbox",
      createRefresh: (el) => (force) => this.renderNoteBlock(el, force),
      onPrune: (el) => this.releaseComponent(el),
    });
  }

  private getDataPath(): string {
    return this.ctx.plugin.getGamificationDataPath();
  }

  private onChange = (file: { path?: string }): void => {
    if (file?.path && file.path !== this.getDataPath()) return;
    this.scheduleRefresh();
  };

  /**
   * Задачу переименовали или перенесли: привязанные к ней записи идут за ней. События собираются пачкой (перенос
   * папки - много событий подряд) и обрабатываются по очереди: A→B и сразу B→C дают C.
   */
  private onRename = (file: { path?: string }, oldPath: string): void => {
    const newPath = file?.path;
    if (!newPath || !/\.md$/i.test(oldPath ?? "")) return;
    // Открытая заметка после переименования не перерисовывается: её блоки должны знать новый путь
    // (по нему блок «Блокнот» в задаче и в проекте находит свои записи).
    document.querySelectorAll<HTMLElement>(".opa-inbox-view, .opa-note-inbox").forEach((el) => {
      if (this.sourcePaths.get(el) === oldPath) this.sourcePaths.set(el, newPath);
    });
    this.pendingRenames.push([oldPath, newPath]);
    if (this.renameTimer != null) window.clearTimeout(this.renameTimer);
    this.renameTimer = window.setTimeout(() => {
      this.renameTimer = null;
      const batch = this.pendingRenames.splice(0);
      this.renameQueue = this.renameQueue.then(() => this.renameLinks(batch));
    }, RENAME_BATCH_MS);
  };

  private async renameLinks(batch: Array<[string, string]>): Promise<void> {
    try {
      // Переименований в хранилище много, привязок к ним обычно нет: data.json пишется, только если есть что менять.
      const data = await readDataFile(this.ctx.plugin);
      const probe = JSON.parse(
        JSON.stringify({ inboxLinks: data.inboxLinks, inboxArchive: data.inboxArchive, trashMeta: data.trashMeta })
      );
      if (!batch.reduce((any, [from, to]) => renameInboxLinkTask(probe, from, to) || any, false)) return;
      let changed = false;
      await updateDataFile(this.ctx.plugin, (d) => {
        for (const [from, to] of batch) changed = renameInboxLinkTask(d, from, to) || changed;
        if (!changed) return {};
      });
      if (changed) this.forceRefresh();
    } catch (error) {
      console.error("[Inbox] rename of linked task failed:", error);
    }
  }

  load(): void {
    const { plugin, app } = this.ctx;
    plugin.registerEvent(app.vault.on("modify", this.onChange));
    plugin.registerEvent(app.vault.on("rename", this.onRename));
    plugin.registerEvent(app.workspace.on("active-leaf-change", this.scheduleRefresh));

    plugin.registerMarkdownCodeBlockProcessor("opa-inbox-view", (_source, el, ctx) => {
      // Блок внутри записи блокнота (код или ![[Homepage]] в тексте записи) рисовал бы сам себя без конца.
      if (isInsideRenderedEntry(el)) {
        el.setText(UI_LABELS.inbox.nested);
        return;
      }
      el.addClass("opa-inbox-view");
      if (ctx?.sourcePath) this.sourcePaths.set(el, ctx.sourcePath);
      this.registry.register(el, (force) => this.render(el, force), ctx);
    });

    // «Блокнот» в заметке задачи (перед блоком задачи) и проекта (перед списком задач): записи блокнота,
    // привязанные к этой задаче; к проекту и к его задачам.
    for (const [language, cls] of [
      [TASK_INBOX_BLOCK, "opa-task-inbox"],
      [PROJECT_INBOX_BLOCK, "opa-project-inbox"],
    ] as const) {
      plugin.registerMarkdownCodeBlockProcessor(language, (_source, el, ctx) => {
        if (isInsideRenderedEntry(el)) {
          el.setText(UI_LABELS.inbox.nested);
          return;
        }
        el.addClass("opa-note-inbox");
        el.addClass(cls);
        if (ctx?.sourcePath) this.sourcePaths.set(el, ctx.sourcePath);
        this.noteRegistry.register(el, (force) => this.renderNoteBlock(el, force), ctx);
      });
    }
    // Когда хранилище готово: блоки из начала задач - к блоку задачи (один раз), задачи и проекты, к которым записи
    // привязаны раньше (и проекты этих задач), получают блок.
    const workspace = app.workspace as { onLayoutReady?: (callback: () => void) => void };
    if (typeof workspace.onLayoutReady === "function") {
      workspace.onLayoutReady(() => {
        void this.moveTaskBlocksOnce().then(() => this.ensureNoteBlocksForInbox());
      });
    }

    const L = UI_LABELS.inbox.quickCapture;
    plugin.addCommand({
      id: "inbox-quick-capture",
      name: L.command,
      checkCallback: (checking: boolean) => {
        if (!plugin.settings.enableInbox) return false;
        if (!checking) this.openQuickCapture();
        return true;
      },
    });
    this.ribbonEl = plugin.addRibbonIcon("pencil", L.command, () => this.openQuickCapture()) ?? null;
    this.updateRibbon();
  }

  private scheduleRefresh = (): void => {
    this.registry.scheduleRefresh();
    this.noteRegistry.scheduleRefresh();
  };

  /** Принудительное обновление блоков инбокса (сразу после добавления записи). */
  forceRefresh(): void {
    this.registry.forceRefresh();
    this.noteRegistry.forceRefresh();
  }

  unload(): void {
    this.registry.clear();
    this.noteRegistry.clear();
    if (this.renameTimer != null) window.clearTimeout(this.renameTimer);
    this.renameTimer = null;
    this.pendingRenames = [];
  }

  updateState(): void {
    this.updateRibbon();
    this.registry.runRefresh();
    this.noteRegistry.runRefresh();
  }

  /** Иконка на ленте видна, только пока блокнот включён. */
  private updateRibbon(): void {
    if (this.ribbonEl) this.ribbonEl.style.display = this.ctx.plugin.settings.enableInbox ? "" : "none";
  }

  private releaseComponent(el: HTMLElement): void {
    this.components.get(el)?.unload();
    this.components.delete(el);
  }

  /** Идёт ли в блоке правка записи (по DOM: правок может быть несколько, и строка может исчезнуть сама). */
  private isEditing(container: HTMLElement): boolean {
    return container.querySelector(".inbox-line.is-editing") != null;
  }

  // ========================================================================
  // ДАННЫЕ
  // ========================================================================

  private async loadInboxData(): Promise<InboxData | null> {
    try {
      const data = await readDataFile(this.ctx.plugin);
      const visibleLines = (data.inbox ?? []).filter((l) => typeof l === "string" && l.trim().length > 0);
      const createdAt = data.inboxCreatedAt ?? {};
      const links = data.inboxLinks ?? {};
      if (visibleLines.length > 0 || (data.inbox ?? []).length > 0 || data.inboxMigrated) {
        return { visibleLines, createdAt, links, inboxArchive: data.inboxArchive ?? [] };
      }
      // data.json пуст и переноса ещё не было - возможно, есть старый Inbox.md. Перенос одноразовый:
      // иначе каждый раз, когда блокнот опустеет, старые записи «воскресали» бы из файла.
      const content = await read(this.ctx.app, Paths.INBOX_FILE);
      if (content != null) {
        const migrated = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("- ["));
        await updateDataFile(this.ctx.plugin, (d) => {
          if (migrated.length > 0 && !d.inbox?.length) d.inbox = migrated;
          d.inboxMigrated = true;
        });
        if (migrated.length > 0) {
          return { visibleLines: migrated, createdAt: {}, links: {}, inboxArchive: data.inboxArchive ?? [] };
        }
      }
      return { visibleLines: [], createdAt, links, inboxArchive: data.inboxArchive ?? [] };
    } catch {
      new Notice(UI_LABELS.inbox.loadDataError);
      return null;
    }
  }

  /**
   * Записать в блокнот (link - к чему запись). Повтор не добавляется второй раз ("exists"): текст уже в блокноте;
   * привязка повтора достаётся записи, у которой её ещё нет.
   */
  async addEntry(text: string, link?: InboxLink | null): Promise<AddInboxResult | "error"> {
    let result = "empty" as AddInboxResult;
    try {
      await updateDataFile(this.ctx.plugin, (d) => {
        const linksBefore = JSON.stringify(d.inboxLinks ?? null);
        result = addInboxEntry(d, text, new Date().toISOString(), link);
        if (result !== "added" && JSON.stringify(d.inboxLinks ?? null) === linksBefore) return {};
      });
      return result;
    } catch (error) {
      console.error("[Inbox] add failed:", error);
      new Notice(UI_LABELS.inbox.notices.saveFailed);
      return "error";
    }
  }

  /** Правка записи: текст и (link не undefined) привязка; null - убрать привязку. */
  private async editEntry(
    oldText: string,
    newText: string,
    link?: InboxLink | null
  ): Promise<EditInboxResult | "error"> {
    let result = "missing" as EditInboxResult;
    try {
      await updateDataFile(this.ctx.plugin, (d) => {
        result = editInboxEntry(d, oldText, newText);
        if (result !== "updated" && result !== "unchanged") return {};
        if (link !== undefined && setInboxEntryLink(d, result === "updated" ? newText : oldText, link) === "updated") {
          result = "updated";
        }
        if (result !== "updated") return {};
      });
      return result;
    } catch (error) {
      console.error("[Inbox] edit failed:", error);
      new Notice(UI_LABELS.inbox.notices.saveFailed);
      return "error";
    }
  }

  /** Картинки из буфера → вложения (по одной, чтобы имена в одну секунду не совпали). */
  private async saveImages(files: File[], sourcePath: string): Promise<string[]> {
    const snippets: string[] = [];
    for (const file of files) {
      try {
        snippets.push(await saveImageAttachment(this.ctx.app, file, sourcePath));
      } catch (error) {
        console.error("[Inbox] image save failed:", error);
        new Notice(UI_LABELS.inbox.notices.imageFailed);
      }
    }
    return snippets;
  }

  // ========================================================================
  // ОКНО «ЗАПИСЬ В БЛОКНОТ»
  // ========================================================================

  /**
   * Окно «Запись в блокнот»: черновик прошлого раза и выделенный текст уже в поле. «Относится к» - задача или проект
   * открытой заметки (прошлый выбор не запоминается: следующая мысль может быть о другом).
   */
  openQuickCapture(): void {
    const L = UI_LABELS.inbox;
    if (!this.ctx.plugin.settings.enableInbox) {
      new Notice(L.quickCapture.disabled);
      return;
    }
    const app = this.ctx.app;
    const initialText = [readQuickCaptureDraft(app), getSelectedText(app)]
      .map((part) => part.replace(/\s+$/, ""))
      .filter((part) => part.trim())
      .join("\n");
    new QuickCaptureModal(app, {
      initialText,
      onSave: async (text, option) => {
        const link = option ? optionToLink(option) : null;
        const result = await this.addEntry(text, link);
        if (result === "error") return false;
        writeQuickCaptureDraft(app, "");
        if (result === "exists") new Notice(L.notices.alreadyThere);
        else new Notice(option ? L.quickCapture.savedWithLink(linkOptionLabel(option)) : L.quickCapture.saved);
        // Запись видна и в самой задаче (проекте): блок «Блокнот» в её заметке (вставляется один раз).
        void this.ensureNoteBlock(link);
        this.forceRefresh();
        return true;
      },
      onDraft: (text) => writeQuickCaptureDraft(app, text),
      // Вложения - как у записей в блоке на домашней странице, а не рядом со случайной открытой заметкой.
      saveImages: (files) => this.saveImages(files, Paths.HOMEPAGE_FILE),
      link: {
        initial: contextLinkOption(app, this.ctx.taskIndex ?? null),
        loadOptions: () => this.loadLinkOptions(),
      },
    }).open();
  }

  /**
   * Варианты для «Относится к»: все проекты (список проектов, заметки проектов, проекты из задач) и все задачи
   * со статусами; порядок - в buildLinkOptions.
   */
  private async loadLinkOptions(): Promise<InboxLinkOption[]> {
    const app = this.ctx.app;
    const tasks = collectTaskOptions(app, this.ctx.taskIndex ?? null);
    let projects: string[] = [];
    try {
      if (typeof this.ctx.plugin.getProjects === "function") projects = await this.ctx.plugin.getProjects();
    } catch (error) {
      console.error("[Inbox] projects for link failed:", error);
    }
    return buildLinkOptions(tasks, [...projects, ...collectProjectNoteValues(app)]);
  }

  // ========================================================================
  // ОТРИСОВКА
  // ========================================================================

  private captureComposer(container: HTMLElement): ComposerState | null {
    const input = container.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR);
    if (!input) return null;
    const field = this.composerLinks.get(container);
    const active = input.ownerDocument.activeElement;
    return {
      value: input.value,
      start: input.selectionStart ?? input.value.length,
      end: input.selectionEnd ?? input.value.length,
      focused: active === input,
      link: field?.input.isConnected
        ? { option: field.value(), text: field.input.value, focused: active === field.input }
        : null,
    };
  }

  private restoreComposer(container: HTMLElement, state: ComposerState | null): void {
    const input = container.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR);
    if (!input) return;
    const addedAt = this.focusAfterRender.get(container);
    this.focusAfterRender.delete(container);
    const justAdded = addedAt != null && Date.now() - addedAt < FOCUS_AFTER_ADD_MS;
    const focus = justAdded || !!state?.focused;
    if (state?.value) {
      input.value = state.value;
      autosizeTextarea(input);
    }
    // Привязку, выбранную до перерисовки, не теряем; набранный в поле привязки текст - тоже, если в нём был фокус.
    // Сразу после записи фокус - в поле текста: следующая мысль.
    const field = this.composerLinks.get(container);
    if (field && state?.link) {
      field.setValue(state.link.option);
      if (state.link.focused && !justAdded) {
        field.input.focus();
        field.input.value = state.link.text;
        return;
      }
    }
    if (focus) {
      input.focus();
      if (state?.value) input.setSelectionRange(state.start, state.end);
    }
  }

  /** force=false - фоновое обновление: при неизменившихся данных DOM (и текст в поле ввода) не трогаем. */
  private async render(container: HTMLElement, force = true): Promise<void> {
    if (!this.ctx.plugin.settings.enableInbox) {
      this.releaseComponent(container);
      container.empty();
      container.addClass("opa-hidden");
      return;
    }
    container.removeClass("opa-hidden");
    // Идёт правка записи: перерисовка стёрла бы поле правки. Повторим, когда правка закончится.
    if (this.isEditing(container)) {
      this.deferredRender.add(container);
      return;
    }

    const epoch = (this.renderEpochs.get(container) ?? 0) + 1;
    this.renderEpochs.set(container, epoch);
    const L = UI_LABELS.inbox;
    const common = UI_LABELS.common;
    let component: Component | null = null;

    try {
      const data = await this.loadInboxData();
      if (this.renderEpochs.get(container) !== epoch) return;
      if (isInsideRenderedEntry(container)) {
        container.empty();
        container.setText(L.nested);
        return;
      }
      // Подписи привязок зависят от заметок задач (имя, проект), а не только от data.json - они тоже в подписи.
      const linkViews: Record<string, InboxLinkView> = {};
      for (const line of data?.visibleLines ?? []) {
        const key = normalizeInboxText(line);
        const view = describeInboxLink(this.ctx.app, data?.links[key]);
        if (view) linkViews[key] = view;
      }
      // От даты зависят подписи «сегодня / вчера»: в новый день блок перерисуется и при фоновом обновлении.
      const signature = renderSignature(
        "inbox",
        this.ctx.plugin.settings.enableReminders,
        data,
        linkViews,
        formatDateKey(new Date())
      );
      if (!force && isRenderUnchanged(container, signature)) return;

      const sourcePath = this.sourcePaths.get(container) ?? Paths.HOMEPAGE_FILE;
      const doc = container.ownerDocument;
      const temp = doc.createElement("div");
      const body = createCollapsibleSection(temp, UI_LABELS.blockTitles.inbox, "inbox");

      if (!data) {
        body.createEl("p", { text: L.loadDataError, cls: "view-error" });
        this.releaseComponent(container);
        container.empty();
        while (temp.firstChild) container.appendChild(temp.firstChild);
        return;
      }

      component = new Component();
      component.load();
      const renderComponent = component;
      body.addEventListener("click", (ev) => openInternalLink(this.ctx.app, ev, sourcePath));

      // --- Поле ввода: многострочное, Enter - новая строка, Ctrl/Cmd+Enter или «Добавить» - записать ---
      const formWrap = body.createEl("div", { cls: "view-add-form inbox-add-form" });
      const input = formWrap.createEl("textarea", {
        cls: "inbox-composer-input",
        attr: {
          rows: "1",
          placeholder: L.addPlaceholder,
          "data-focus-restore": "add-input",
        },
      });
      // «Относится к» - под полем ввода, во всю его ширину (как в окне записи); Tab из текста переходит в него.
      // Контекста здесь нет: поле пустое, после записи очищается.
      const linkField = createInboxLinkField(this.ctx.app, formWrap, {
        initial: null,
        loadOptions: () => this.loadLinkOptions(),
        preload: false,
        onSubmit: () => void submit(),
      });
      formWrap.toggleClass("has-link-field", linkField != null);
      const addBtn = formWrap.createEl("button", { text: common.add, cls: "view-btn" });
      addSubmitTooltip(addBtn);
      let submitting = false;
      const submit = async (): Promise<void> => {
        if (submitting) return;
        submitting = true;
        try {
          // Скриншот ещё сохраняется: ждём, чтобы ссылка на него попала в запись.
          await whenComposerIdle(input);
          const text = input.value;
          if (!text.trim()) return;
          // Поле привязки - текущее: блок мог перерисоваться, пока сохранялся скриншот.
          const option = (this.composerLinks.get(container) ?? linkField)?.value() ?? null;
          const link = option ? optionToLink(option) : null;
          const result = await this.addEntry(text, link);
          if (result === "error") return;
          // Поле могло смениться, если блок успел перерисоваться (текст переносится в новое поле) - чистим оба.
          for (const field of [input, container.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR)]) {
            if (field && normalizeInboxText(field.value) === normalizeInboxText(text)) {
              field.value = "";
              autosizeTextarea(field);
            }
          }
          // Привязка не запоминается: следующая мысль может быть совсем о другом.
          linkField?.setValue(null);
          this.composerLinks.get(container)?.setValue(null);
          if (result === "exists") new Notice(L.notices.alreadyThere);
          // Запись видна и в самой задаче (проекте): блок «Блокнот» в её заметке (вставляется один раз).
          void this.ensureNoteBlock(link);
          this.focusAfterRender.set(container, Date.now());
          this.forceRefresh();
        } finally {
          submitting = false;
        }
      };
      attachInboxComposer(input, {
          onSubmit: () => void submit(),
        saveImages: (files) => this.saveImages(files, sourcePath),
      });
      addBtn.addEventListener("click", () => void submit());

      // --- Записи ---
      const listWrap = body.createEl("div", { cls: "inbox-list" });
      const pending: Promise<void>[] = [];
      if (data.visibleLines.length === 0) {
        const empty = listWrap.createEl("div", { cls: "inbox-empty" });
        empty.createEl("div", { text: L.empty });
        empty.createEl("div", { cls: "inbox-empty-hint", text: L.emptyHint });
      } else {
        const now = new Date();
        // Записи с одной привязкой (от двух) - группой под заголовком; подпись привязки у них только в заголовке.
        const items = groupInboxEntries(data.visibleLines, (line) => data.links[normalizeInboxText(line)]);
        const addRow = (parent: HTMLElement, line: string, showLink: boolean): void => {
          const key = normalizeInboxText(line);
          pending.push(
            this.buildRow(container, parent, line, {
              createdAt: data.createdAt[key],
              link: data.links[key] ?? null,
              view: showLink ? linkViews[key] ?? null : null,
              now,
              sourcePath,
              component: renderComponent,
            })
          );
        };
        for (const item of items) {
          if (item.kind === "entry") {
            addRow(listWrap, item.line, true);
            continue;
          }
          const first = normalizeInboxText(item.lines[0]);
          const groupList = this.buildGroup(listWrap, { view: linkViews[first] ?? null, count: item.lines.length });
          for (const line of item.lines) addRow(groupList, line, false);
        }
      }

      // --- Архив: рисуется, когда раскрыт; сразу - последние записи, более ранние - по кнопке ---
      if (data.inboxArchive.length > 0) {
        const archiveTitle = L.archiveTitle ?? "Архив";
        const isArchiveCollapsed = getInboxArchiveCollapsed();
        const archiveSection = body.createEl("div", { cls: "inbox-archive rv-section rv-completed" });
        const archiveHeader = archiveSection.createEl("h3", { cls: "rv-section-header opa-collapsible-header" });
        const archiveArrow = archiveHeader.createEl("span", { cls: "rv-section-arrow", text: isArchiveCollapsed ? "▶" : "▼" });
        const titleSpan = archiveHeader.createEl("span", { cls: "rv-section-title-text" });
        titleSpan.setText(`📦 ${archiveTitle}`);
        archiveHeader.createEl("span", { cls: "rv-count", text: String(data.inboxArchive.length) });
        const archiveList = archiveSection.createEl("div", { cls: "rv-list inbox-archive-list" });
        archiveList.toggleClass("opa-hidden", isArchiveCollapsed);
        let archiveBuilt = false;
        /** Строка архива (before - вставить перед этой строкой, иначе в конец); возвращает окончание отрисовки. */
        const addArchiveRow = (entry: InboxArchiveItem, before: Element | null): Promise<void> => {
          const archiveRow = archiveList.createEl("div", { cls: "inbox-archive-line rv-item" });
          if (before) archiveList.insertBefore(archiveRow, before);
          const contentWrap = archiveRow.createEl("div", { cls: "rv-item-content-wrap" });
          const content = contentWrap.createEl("div", { cls: "rv-content" });
          // inbox-text: те же стили markdown и та же защита от блока внутри записи, что у записей блокнота
          const textEl = content.createEl("div", { cls: "rv-text inbox-text markdown-rendered" });
          const view = describeInboxLink(this.ctx.app, normalizeInboxLink(entry.link));
          if (view) renderLinkView(content.createEl("div", { cls: "inbox-meta" }), view);
          const timeDiv = archiveRow.createEl("div", { cls: "rv-time" });
          timeDiv.createEl("span", { cls: "rv-badge rv-badge-date", text: formatInboxFullDate(entry.completedAt) });
          const archiveActions = archiveRow.createEl("div", { cls: "rv-actions" });
          const btnArchiveDel = archiveActions.createEl("button", { text: L.actions.delete, cls: "inbox-action-btn" });
          btnArchiveDel.addEventListener("click", () => this.handleDeleteFromArchive(entry, archiveRow));
          return renderEntryMarkdown(this.ctx.app, entry.text, textEl, sourcePath, renderComponent);
        };
        const buildArchive = (): Promise<void> => {
          if (archiveBuilt) return Promise.resolve();
          archiveBuilt = true;
          const all = data.inboxArchive;
          const hidden = this.archiveShowAll.has(container) ? 0 : Math.max(0, all.length - ARCHIVE_VISIBLE);
          if (hidden > 0) {
            const more = archiveList.createEl("button", { cls: "inbox-archive-more", text: L.archiveShowEarlier(hidden) });
            more.addEventListener("click", () => {
              this.archiveShowAll.add(container);
              const firstShown = more.nextElementSibling;
              for (const entry of all.slice(0, hidden)) void addArchiveRow(entry, firstShown);
              more.remove();
            });
          }
          return Promise.all(all.slice(hidden).map((entry) => addArchiveRow(entry, null))).then(() => undefined);
        };
        archiveHeader.addEventListener("click", () => {
          const collapsed = !archiveList.hasClass("opa-hidden");
          if (!collapsed) void buildArchive();
          archiveList.toggleClass("opa-hidden", collapsed);
          archiveArrow.textContent = collapsed ? "▶" : "▼";
          setInboxArchiveCollapsed(collapsed);
        });
        if (!isArchiveCollapsed) pending.push(buildArchive());
      }

      // Блок собирается целиком вне документа и подменяется за один раз: без мигания и прыжков страницы.
      await Promise.all(pending);
      // В старом поле ещё сохраняется скриншот: ссылка на него должна попасть в текст до переноса в новое поле.
      const oldComposer = container.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR);
      if (oldComposer && isComposerBusy(oldComposer)) await whenComposerIdle(oldComposer);
      if (this.renderEpochs.get(container) !== epoch || this.isEditing(container)) {
        if (this.isEditing(container)) this.deferredRender.add(container);
        component.unload();
        return;
      }
      const composerState = this.captureComposer(container);
      this.composerLinks.get(container)?.close();
      container.empty();
      while (temp.firstChild) container.appendChild(temp.firstChild);
      this.releaseComponent(container);
      this.components.set(container, component);
      component = null;
      if (linkField) this.composerLinks.set(container, linkField);
      else this.composerLinks.delete(container);
      markRendered(container, signature);
      this.restoreComposer(container, composerState);
      autosizeTextarea(input);
    } catch (e) {
      component?.unload();
      container.empty();
      container.createEl("p", { text: UI_LABELS.errors.renderShort, cls: "view-error" });
      console.error(e);
    }
  }

  // ========================================================================
  // БЛОК «БЛОКНОТ» В ЗАДАЧЕ И В ПРОЕКТЕ
  // ========================================================================

  /** Привязана ли запись к задаче taskPath (задачу могли перенести: тогда - по имени заметки). */
  private isLinkedToTask(link: InboxLink | null | undefined, taskPath: string): boolean {
    if (!link?.task || !taskPath) return false;
    if (link.task === taskPath) return true;
    return resolveTaskFile(this.ctx.app, link.task)?.path === taskPath;
  }

  /**
   * Привязана ли запись к проекту заметки notePath. Проект - имя заметки, как у списка задач проекта; с папкой
   * и без («Проекты/Trino» и «Trino») - один проект.
   */
  private isLinkedToProject(link: InboxLink | null | undefined, notePath: string): boolean {
    return !!link?.project && !!notePath && isSameProject(link.project, noteName(notePath));
  }

  /**
   * Блок «Блокнот» в заметке задачи или проекта: записи блокнота, привязанные к ней, а в проекте - и к его задачам
   * (под такой записью - её задача, записи одной задачи от двух - группой, как в блокноте). Текст, время и кнопки
   * для разбора на месте: «Архив», «Изменить», «Удалить», в проекте ещё «Задача» (форма с проектом записи).
   * Таких записей нет - блока не видно.
   */
  private async renderNoteBlock(container: HTMLElement, force = true): Promise<void> {
    const project = container.hasClass("opa-project-inbox");
    const hide = (): void => {
      this.releaseComponent(container);
      container.empty();
      container.addClass("opa-hidden");
    };
    if (!this.ctx.plugin.settings.enableInbox) {
      hide();
      return;
    }
    // Идёт правка записи: перерисовка стёрла бы поле правки. Повторим, когда правка закончится.
    if (this.isEditing(container)) {
      this.deferredRender.add(container);
      return;
    }
    const epoch = (this.renderEpochs.get(container) ?? 0) + 1;
    this.renderEpochs.set(container, epoch);
    let component: Component | null = null;
    try {
      const data = await this.loadInboxData();
      if (this.renderEpochs.get(container) !== epoch) return;
      // Блок мог оказаться внутри записи уже после вызова обработчика (как и блокнот, см. render).
      if (isInsideRenderedEntry(container)) {
        this.releaseComponent(container);
        container.empty();
        container.setText(UI_LABELS.inbox.nested);
        return;
      }
      const notePath = this.sourcePaths.get(container) ?? "";
      // Записи блока - в порядке блокнота. В проекте к своим записям добавляются записи его задач, с подписью задачи.
      const lines: string[] = [];
      const taskViews: Record<string, InboxLinkView> = {};
      for (const line of data?.visibleLines ?? []) {
        const key = normalizeInboxText(line);
        const link = data?.links[key];
        if (project ? this.isLinkedToProject(link, notePath) : this.isLinkedToTask(link, notePath)) {
          lines.push(line);
          continue;
        }
        const view = project ? projectTaskView(this.ctx.app, link, noteName(notePath)) : null;
        if (!view) continue;
        lines.push(line);
        taskViews[key] = view;
      }
      if (!data || lines.length === 0) {
        hide();
        return;
      }
      const kind = project ? "project-inbox" : "task-inbox";
      const times = lines.map((line) => data.createdAt[normalizeInboxText(line)] ?? null);
      // Задачи записей в проекте - по их заметкам (имя, проект), а не только по data.json: они тоже в подписи.
      const signature = renderSignature(kind, notePath, lines, times, taskViews, formatDateKey(new Date()));
      if (!force && isRenderUnchanged(container, signature)) return;

      const temp = container.ownerDocument.createElement("div");
      const body = createCollapsibleSection(temp, UI_LABELS.inbox.noteBlockTitle(lines.length), kind);
      component = new Component();
      component.load();
      const renderComponent = component;
      body.addEventListener("click", (ev) => openInternalLink(this.ctx.app, ev, notePath));
      const list = body.createEl("div", { cls: "inbox-list" });
      const now = new Date();
      const pending: Promise<void>[] = [];
      const addRow = (parent: HTMLElement, line: string, view: InboxLinkView | null): void => {
        const key = normalizeInboxText(line);
        pending.push(
          this.buildRow(container, parent, line, {
            createdAt: data.createdAt[key],
            link: data.links[key] ?? null,
            view,
            now,
            sourcePath: notePath,
            component: renderComponent,
            actions: project ? "inProject" : "inTask",
          })
        );
      };
      // Записи одной задачи проекта (от двух) - группой под заголовком задачи, как в блокноте; группа стоит на месте
      // самой ранней своей записи. Записи самой заметки (задачи, проекта) не группируются и без подписи.
      const taskOf = (line: string): InboxLinkView | null => taskViews[normalizeInboxText(line)] ?? null;
      const items = groupInboxEntries(lines, (line) => {
        const href = taskOf(line)?.href;
        return href ? { task: href } : null;
      });
      for (const item of items) {
        if (item.kind === "entry") {
          addRow(list, item.line, taskOf(item.line));
          continue;
        }
        const groupList = this.buildGroup(list, { view: taskOf(item.lines[0]), count: item.lines.length });
        for (const line of item.lines) addRow(groupList, line, null);
      }
      await Promise.all(pending);
      if (this.renderEpochs.get(container) !== epoch || this.isEditing(container)) {
        if (this.isEditing(container)) this.deferredRender.add(container);
        component.unload();
        return;
      }
      container.removeClass("opa-hidden");
      container.empty();
      while (temp.firstChild) container.appendChild(temp.firstChild);
      this.releaseComponent(container);
      this.components.set(container, component);
      component = null;
      markRendered(container, signature);
    } catch (e) {
      component?.unload();
      hide();
      console.error(e);
    }
  }

  /**
   * Блок «Блокнот» в заметке, к которой привязана запись: в задаче (перед блоком задачи) или в заметке проекта
   * (перед списком его задач; проекта без заметки - нет). Запись задачи видна и в заметке её проекта (проектов) -
   * туда блок тоже встаёт. Вставляется один раз: так запись видна там, где с ней работают.
   */
  private async ensureNoteBlock(link: InboxLink | null | undefined): Promise<void> {
    if (link?.task) {
      const file = resolveTaskFile(this.ctx.app, link.task);
      if (!file) return;
      await this.ensureBlockInNote(file, hasTaskInboxBlock, addTaskInboxBlock);
      for (const project of taskProjects(this.ctx.app, file)) await this.ensureProjectBlock(project);
    } else if (link?.project) {
      await this.ensureProjectBlock(link.project);
    }
  }

  /** Блок «Блокнот» в заметке проекта (у проекта без заметки блока нет). */
  private async ensureProjectBlock(project: string): Promise<void> {
    const file = this.projectNoteFile(project);
    if (file) await this.ensureBlockInNote(file, hasProjectInboxBlock, addProjectInboxBlock);
  }

  /** Заметка проекта: корневая (project во frontmatter совпадает с именем файла); null - такой заметки нет. */
  private projectNoteFile(project: string): TFile | null {
    const app = this.ctx.app;
    const name = projectDisplayName(project);
    for (const target of [projectLinkTarget(project), name]) {
      try {
        const file = app.metadataCache?.getFirstLinkpathDest?.(target, "");
        if (!(file instanceof TFile) || file.basename.toLowerCase() !== name.toLowerCase()) continue;
        const fm = app.metadataCache?.getFileCache?.(file)?.frontmatter;
        if (fm && isProjectHubPage(file, fm)) return file;
      } catch {
        // кэш заметок ещё не готов - блока пока не будет
      }
    }
    return null;
  }

  /** Вставить блок в заметку, если его там ещё нет. За сеанс заметка проверяется один раз. */
  private async ensureBlockInNote(
    file: TFile,
    hasBlock: (content: string) => boolean,
    addBlock: (content: string) => string | null
  ): Promise<void> {
    if (!this.ctx.plugin.settings.enableInbox || this.noteBlockEnsured.has(file.path)) return;
    this.noteBlockEnsured.add(file.path);
    try {
      if (hasBlock(await this.ctx.app.vault.cachedRead(file))) return;
      await this.ctx.app.vault.process(file, (content) => addBlock(content) ?? content);
    } catch (error) {
      this.noteBlockEnsured.delete(file.path);
      console.error("[Inbox] notepad block insert failed:", error);
    }
  }

  /**
   * Прошлая версия ставила блок «Блокнот» в начало задачи; теперь его место - перед блоком задачи («Оглавление»).
   * Один раз на этом устройстве: задачи из привязок (блокнот и архив) и заметки, которые начинаются с блока кода.
   */
  private async moveTaskBlocksOnce(): Promise<void> {
    const app = this.ctx.app;
    if (!this.ctx.plugin.settings.enableInbox || loadVaultValue(app, TASK_BLOCKS_MOVED_KEY)) return;
    try {
      const candidates = new Map<string, TFile>();
      const data = await readDataFile(this.ctx.plugin);
      const links = [...Object.values(data.inboxLinks ?? {}), ...(data.inboxArchive ?? []).map((item) => item.link)];
      for (const link of links) {
        const file = link?.task ? resolveTaskFile(app, link.task) : null;
        if (file) candidates.set(file.path, file);
      }
      for (const file of app.vault.getMarkdownFiles?.() ?? []) {
        const sections = app.metadataCache?.getFileCache?.(file)?.sections;
        if (sections?.find((section) => section.type !== "yaml")?.type === "code") candidates.set(file.path, file);
      }
      for (const file of candidates.values()) {
        if (moveTaskInboxBlockToTaskView(await app.vault.cachedRead(file)) == null) continue;
        await app.vault.process(file, (content) => moveTaskInboxBlockToTaskView(content) ?? content);
      }
      saveVaultValue(app, TASK_BLOCKS_MOVED_KEY, "1");
    } catch (error) {
      console.error("[Inbox] moving task blocks failed:", error);
    }
  }

  /**
   * При загрузке: задачи и проекты, к которым привязаны записи блокнота (в том числе в прошлых сеансах), и проекты
   * этих задач получают блок.
   */
  private async ensureNoteBlocksForInbox(): Promise<void> {
    try {
      const data = await readDataFile(this.ctx.plugin);
      const inbox = new Set((data.inbox ?? []).map(normalizeInboxText));
      const seen = new Set<string>();
      for (const [key, link] of Object.entries(data.inboxLinks ?? {})) {
        const id = inboxLinkKey(link);
        if (!inbox.has(key) || !id || seen.has(id)) continue;
        seen.add(id);
        await this.ensureNoteBlock(link);
      }
    } catch (error) {
      console.error("[Inbox] notepad blocks check failed:", error);
    }
  }

  /**
   * Группа записей с одной привязкой: заголовок (задача · проект, число записей) и список записей.
   * Возвращает элемент, куда класть строки записей.
   */
  private buildGroup(listWrap: HTMLElement, opts: { view: InboxLinkView | null; count: number }): HTMLElement {
    const group = listWrap.createEl("div", { cls: "inbox-group" });
    const header = group.createEl("div", { cls: "inbox-group-header" });
    if (opts.view) renderLinkView(header, opts.view);
    header.createEl("span", {
      cls: "inbox-group-count",
      text: String(opts.count),
      attr: { title: UI_LABELS.inbox.groupCount(opts.count) },
    });
    return group.createEl("div", { cls: "inbox-group-list" });
  }

  /**
   * Строка записи: текст (markdown), под ним - время записи и к чему она относится, кнопки.
   * Возвращает окончание отрисовки markdown.
   */
  private buildRow(
    container: HTMLElement,
    listWrap: HTMLElement,
    line: string,
    opts: {
      createdAt: string | undefined;
      link: InboxLink | null;
      view: InboxLinkView | null;
      now: Date;
      sourcePath: string;
      component: Component;
      /**
       * Кнопки: все (блокнот) или для разбора на месте - в блоке «Блокнот» задачи (без «Задача» и «Напоминание»)
       * и проекта (без «Напоминание»).
       */
      actions?: "all" | "inTask" | "inProject";
    }
  ): Promise<void> {
    const { createdAt, link, view, now, sourcePath, component } = opts;
    const inNote = opts.actions === "inTask" || opts.actions === "inProject";
    const L = UI_LABELS.inbox;
    const row = listWrap.createEl("div", { cls: "inbox-line view-list-row" });
    row.setAttribute("data-original-text", line);
    const entry = row.createEl("div", { cls: "inbox-entry" });
    const textEl = entry.createEl("div", { cls: "inbox-text markdown-rendered" });
    renderInboxMeta(entry, { createdAt, view, now });

    const actions = row.createEl("div", { cls: "inbox-actions view-list-row-actions" });
    const addAction = (label: string, handler: () => void): void => {
      const btn = actions.createEl("button", { text: label, cls: "inbox-action-btn" });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        handler();
      });
    };
    addAction(L.actions.done, () => void this.handleDone(this.rowText(row, line), row));
    if (opts.actions !== "inTask") {
      addAction(L.actions.task, () => this.handleCreateTask(this.rowText(row, line), row, this.rowLinks.get(row) ?? null));
    }
    this.rowLinks.set(row, link);
    addAction(L.actions.edit, () => this.handleEdit(container, this.rowText(row, line), row, sourcePath));
    if (!inNote && this.ctx.plugin.settings.enableReminders) {
      addAction(L.actions.reminder, () => this.handleReminder(this.rowText(row, line), row));
    }
    addAction(L.actions.delete, () => void this.handleDelete(this.rowText(row, line), row));

    return renderEntryMarkdown(this.ctx.app, line, textEl, sourcePath, component);
  }

  /** Актуальный текст записи (после редактирования замыкания не устаревают). */
  private rowText(rowEl: HTMLElement, fallback: string): string {
    return rowEl.getAttribute("data-original-text") ?? fallback;
  }

  // ========================================================================
  // ДЕЙСТВИЯ С ЗАПИСЬЮ
  // ========================================================================

  /** «Удалить»: запись уходит в корзину; там видно, когда она сделана и к чему относилась. */
  private async handleDelete(originalText: string, rowEl: HTMLElement): Promise<void> {
    let removed = false;
    await updateDataFile(this.ctx.plugin, (d) => {
      const result = removeInboxEntry(d, originalText);
      if (!result.removed) return {};
      removed = true;
      addToTrash(d, normalizeInboxText(originalText), { createdAt: result.createdAt, link: result.link });
    });
    rowEl.remove();
    if (removed) this.ctx.plugin.triggerTrashRefresh?.();
    this.forceRefresh();
  }

  /** «Архив»: запись уходит в архив (с временем записи и разбора и с привязкой), за разбор начисляется награда. */
  private async handleDone(originalText: string, rowEl: HTMLElement): Promise<void> {
    let removed = false;
    const reward = this.ctx.plugin.settings.gamificationInboxRewards ?? DEFAULT_INBOX_REWARDS;
    await updateDataFile(this.ctx.plugin, (d) => {
      const result = removeInboxEntry(d, originalText);
      if (!result.removed) return {};
      removed = true;
      const archived: InboxArchiveItem = {
        text: normalizeInboxText(originalText),
        completedAt: new Date().toISOString(),
        ...(result.createdAt && { createdAt: result.createdAt }),
        ...(result.link && { link: result.link }),
      };
      d.inboxArchive = [...(d.inboxArchive ?? []), archived];
      if (this.ctx.plugin.settings.enableGamification) {
        const state = d.gamification ?? emptyGamificationState();
        state.xp += reward.xp;
        state.gold += reward.gold;
        d.gamification = state;
      }
    });
    if (!removed) return;
    const L = UI_LABELS.inbox;
    if (this.ctx.plugin.settings.enableGamification) {
      await this.ctx.plugin.refreshGamificationState();
      new Notice(`${L.notices.processed} ${UI_LABELS.gamification.rewardLine(reward.xp, reward.gold)}`);
      this.ctx.plugin.gamification?.updateState?.();
    } else {
      new Notice(L.notices.processed);
    }
    rowEl.remove();
    this.forceRefresh();
  }

  private async handleDeleteFromArchive(entry: InboxArchiveItem, rowEl: HTMLElement): Promise<void> {
    let removed = false;
    await updateDataFile(this.ctx.plugin, (d) => {
      const archive = d.inboxArchive ?? [];
      const item = archive.find((e) => e.text === entry.text && e.completedAt === entry.completedAt);
      // Уже удалена (в другом блоке или на другом устройстве) - второй раз в корзину не кладём.
      if (!item) return {};
      removed = true;
      d.inboxArchive = archive.filter((e) => e !== item);
      addToTrash(d, INBOX_ARCHIVE_TRASH_PREFIX + item.text, { createdAt: item.createdAt, link: item.link });
    });
    rowEl.remove();
    if (removed) {
      new Notice(UI_LABELS.inbox.notices.movedToTrash);
      this.ctx.plugin.triggerTrashRefresh?.();
    }
    this.forceRefresh();
  }

  /**
   * Правка записи на месте: многострочное поле, Enter - новая строка, Ctrl/Cmd+Enter или клик вне правки - сохранить,
   * Escape - отмена. Под текстом - «Относится к» с привязкой записи: её можно поставить, сменить или убрать.
   */
  private handleEdit(container: HTMLElement, originalText: string, rowEl: HTMLElement, sourcePath: string): void {
    if (rowEl.hasClass("is-editing")) return;
    const L = UI_LABELS.inbox;
    rowEl.addClass("is-editing");

    const doc = rowEl.ownerDocument;
    const wrap = doc.createElement("div");
    wrap.className = "inbox-edit";
    const editInput = doc.createElement("textarea");
    editInput.className = "inbox-composer-input inbox-edit-input";
    editInput.rows = 1;
    editInput.value = originalText;
    wrap.appendChild(editInput);
    rowEl.insertBefore(wrap, rowEl.firstChild);

    let finished = false;
    let saving = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      linkField?.close();
      wrap.remove();
      rowEl.removeClass("is-editing");
      // Отложенная перерисовка - когда в блоке не осталось ни одной правки.
      if (this.deferredRender.has(container) && !this.isEditing(container)) {
        this.deferredRender.delete(container);
        this.forceRefresh();
      }
    };
    const save = async (): Promise<void> => {
      if (finished || saving) return;
      saving = true;
      await whenComposerIdle(editInput);
      if (finished) {
        saving = false;
        return;
      }
      // Без поля привязки (старый Obsidian) привязка не меняется.
      const option = linkField ? linkField.value() : undefined;
      const link = option === undefined ? undefined : option ? optionToLink(option) : null;
      const result = await this.editEntry(originalText, editInput.value, link);
      saving = false;
      if (result === "error") return;
      finish();
      if (result === "exists") new Notice(L.notices.alreadyThere);
      if (result === "updated") {
        new Notice(L.notices.updated);
        rowEl.setAttribute("data-original-text", normalizeInboxText(editInput.value));
        if (link !== undefined) this.rowLinks.set(rowEl, link);
        void this.ensureNoteBlock(link);
        this.forceRefresh();
      }
    };

    const linkField = createInboxLinkField(this.ctx.app, wrap, {
      initial: linkOptionFromLink(this.ctx.app, this.rowLinks.get(rowEl), this.ctx.taskIndex ?? null),
      loadOptions: () => this.loadLinkOptions(),
      onSubmit: () => void save(),
      onEscape: finish,
    });
    attachInboxComposer(editInput, {
      onSubmit: () => void save(),
      onEscape: finish,
      saveImages: (files) => this.saveImages(files, sourcePath),
    });
    // Клик вне правки сохраняет; переход между текстом и «Относится к» (Tab, клик) - нет.
    wrap.addEventListener("focusout", (evt) => {
      const next = evt.relatedTarget;
      if (next instanceof Node && wrap.contains(next)) return;
      window.setTimeout(() => {
        if (finished) return;
        const active = doc.activeElement;
        if (active && wrap.contains(active)) return;
        void save();
      }, 0);
    });
    editInput.focus();
    editInput.setSelectionRange(editInput.value.length, editInput.value.length);
  }

  /**
   * Задача из записи: название - первая строка (вне блоков кода), остальной текст дописывается в «Описание задачи».
   * Проект в форме - из привязки записи (проект или проект привязанной задачи).
   * Запись уходит из блокнота, только когда задача создана и текст перенесён.
   */
  private handleCreateTask(originalText: string, rowEl: HTMLElement, link: InboxLink | null = null): void {
    const { title, rest } = splitInboxEntry(originalText);
    const name = taskNameFromEditorLine(title);
    if (!name) {
      new Notice(UI_LABELS.inbox.notices.emptyName);
      return;
    }
    // Если имя файла потеряло что-то из первой строки (ссылку, адрес, разметку), в описание идёт вся запись.
    const description = name === title ? rest : normalizeInboxText(originalText);
    const onSuccess = async (file: TFile): Promise<void> => {
      if (description) {
        const moved = await processFile(this.ctx.app, file, (content) => appendBlockToTaskDescriptionContent(content, description));
        if (!moved) {
          new Notice(UI_LABELS.inbox.notices.restNotSaved);
          return;
        }
      }
      await updateDataFile(this.ctx.plugin, (d) => {
        removeInboxEntry(d, originalText);
      });
      rowEl.remove();
      this.forceRefresh();
    };
    const project = projectForLink(this.ctx.app, link);
    this.ctx.plugin.openCreateTaskFromInbox?.(name, onSuccess, project || undefined);
  }

  /** Напоминание из записи: текст напоминания - одной строкой (строка напоминания не может переноситься). */
  private handleReminder(originalText: string, rowEl: HTMLElement): void {
    this.ctx.plugin.openCreateReminderFromInbox?.(inboxEntryAsOneLine(originalText), async (result) => {
      const reminderLine = buildReminderLine(result.text, result.date, result.recurrence);
      // Одной записью: запись уходит из блокнота и появляется в напоминаниях
      await updateDataFile(this.ctx.plugin, (d) => {
        d.reminders = [...(d.reminders ?? []), reminderLine];
        removeInboxEntry(d, originalText);
      });

      rowEl.remove();
      new Notice(`В напоминания: ${formatDateDDMMYYYY(result.date)} ${formatReminderTime(result.date)}`);
      this.forceRefresh();
    });
  }
}
