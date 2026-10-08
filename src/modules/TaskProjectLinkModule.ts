/**
 * Переход из задачи в её проект. Значение project в свойствах заметки (панель свойств над текстом и панель
 * «Свойства файла» в сайдбаре) - ссылка на заметку проекта: клик открывает её в той же вкладке, Ctrl/Cmd+клик
 * и средняя кнопка - в новой, Ctrl/Cmd при наведении - предпросмотр. Изменить такое значение - через меню правой
 * кнопки мыши (двойной клик Obsidian, как у ссылок, не получает). Команда «Открыть проект задачи» - то же
 * с клавиатуры.
 *
 * Во frontmatter ничего не меняется: значения остаются текстом («Trino», «Проекты/Trino»), заметку проекта находит
 * то же правило, что у ссылки [[Trino]]. Значение без заметки остаётся обычным текстом, значения-ссылки [[…]]
 * Obsidian открывает сам.
 *
 * Панель свойств рисует Obsidian, модуль опирается на её разметку (строка .metadata-property с data-property-key,
 * значения списка .multi-select-pill). Если в другой версии Obsidian она устроена иначе, значения остаются текстом,
 * а команда работает.
 */

import {
  Keymap,
  MarkdownView,
  Notice,
  SuggestModal,
  TFile,
  type App,
  type HoverParent,
  type PaneType,
} from "obsidian";
import type { ModuleContext, PluginModule } from "./types";
import { flattenProjectField, isTemplateFile } from "../core/TaskNote";
import { projectDisplayName, projectLinkTarget, taskProjectValues } from "../core/InboxLinks";
import { UI_LABELS } from "../ui/Labels";

/** Строка свойства project в панели свойств Obsidian. */
const PROJECT_PROPERTY_SELECTOR = '.metadata-property[data-property-key="project"]';
/** Значение свойства-списка (плашка) и её текст. */
const PILL_SELECTOR = ".multi-select-pill";
const PILL_CONTENT_SELECTOR = ".multi-select-pill-content";
/** Панель свойств: Obsidian перерисовывает в ней плашки (правка свойств), класс ссылки надо вернуть. */
const METADATA_CONTAINER_SELECTOR = ".metadata-container";
/** Вид «Свойства файла» в сайдбаре: показывает свойства активной заметки. */
const FILE_PROPERTIES_VIEW_TYPE = "file-properties";
/** Плашка проекта, у которого есть заметка: выглядит и работает как ссылка. */
export const PROJECT_LINK_CLASS = "opa-project-link";
/** Источник предпросмотра для плагина «Предпросмотр страниц» (там же его можно настроить). */
export const PROJECT_HOVER_SOURCE = "obsidian-project-automation";
const PROJECT_HOVER_SOURCE_NAME = "Obsidian Project Automation";
/** События хранилища и вкладок идут пачками: плашки размечаются один раз после паузы. */
const DECORATE_DELAY_MS = 50;
/**
 * Сколько после перехода гасить двойной клик: второй щелчок приходит уже в заметку проекта (или, при Ctrl, в ту же
 * плашку), и Obsidian открыл бы там правку значения.
 */
const DBLCLICK_GUARD_MS = 700;
/** Символы, из-за которых путь заметки читается как ссылка не так: «C#.md» - заголовок в заметке «C». */
const LINK_BREAKING_CHARS = /[#^|[\]]/;

type Frontmatter = Record<string, unknown>;

/** Проект заметки, у которого есть своя заметка. */
export interface ProjectNote {
  /** Имя проекта для показа (без папки). */
  name: string;
  file: TFile;
}

/** Плашка проекта и куда она ведёт. */
interface ProjectPillLink {
  pill: HTMLElement;
  /** Заметка, в свойствах которой плашка. */
  source: TFile;
  /** Заметка проекта. */
  project: TFile;
  hoverParent: HoverParent;
}

/** Чьи свойства показывает панель. */
interface PropertiesOwner {
  file: TFile;
  hoverParent: HoverParent;
}

function frontmatterOf(app: App, file: TFile): Frontmatter | null {
  try {
    return (app.metadataCache?.getFileCache?.(file)?.frontmatter as Frontmatter | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Значение project, которое показывает плашка: её текст совпадает со значением во frontmatter (элементом списка;
 * строку «Trino, Spark» Obsidian показывает одной плашкой). null - такого значения нет (frontmatter ещё не перечитан)
 * или это ссылка [[…]]: её Obsidian открывает сам.
 */
export function pillProjectValue(text: string, project: unknown): string | null {
  const shown = String(text ?? "").trim();
  if (!shown || !flattenProjectField(project).some((value) => value === shown)) return null;
  return /^\[\[[\s\S]*\]\]$/.test(shown) ? null : shown;
}

/**
 * Заметка проекта для значения project заметки sourcePath - та, что открыла бы ссылка [[значение]]: «Проекты/Trino» -
 * по пути, а если такой нет - по имени («Trino»). null - заметки нет или это сама заметка (у заметки проекта в project
 * её же имя).
 */
export function projectNoteFile(app: App, value: string, sourcePath: string): TFile | null {
  for (const target of new Set([projectLinkTarget(value), projectDisplayName(value)])) {
    if (!target) continue;
    let dest: unknown = null;
    try {
      dest = app.metadataCache?.getFirstLinkpathDest?.(target, sourcePath);
    } catch {
      dest = null;
    }
    if (dest instanceof TFile && dest.extension === "md") return dest.path === sourcePath ? null : dest;
  }
  return null;
}

/**
 * Проекты заметки из frontmatter: found - с заметкой (без повторов), missing - имена проектов без заметки.
 * Своё имя не считается: у заметки проекта в project записан сам проект.
 */
export function projectTargetsOf(app: App, file: TFile): { found: ProjectNote[]; missing: string[] } {
  const found: ProjectNote[] = [];
  const missing: string[] = [];
  for (const value of taskProjectValues(frontmatterOf(app, file)?.project)) {
    const name = projectDisplayName(value);
    if (!name || name.toLowerCase() === file.basename.toLowerCase()) continue;
    const note = projectNoteFile(app, value, file.path);
    if (note) {
      if (!found.some((project) => project.file.path === note.path)) found.push({ name, file: note });
    } else if (!missing.includes(name)) {
      missing.push(name);
    }
  }
  return { found, missing };
}

/**
 * Открыть заметку проекта, как ссылку (newLeaf: false - эта вкладка, закреплённая - новая). Путь с # ^ | [ ] ссылкой
 * не прочитать - такую заметку открыть напрямую.
 */
function openProjectNote(app: App, file: TFile, sourcePath: string, newLeaf: PaneType | boolean): void {
  if (LINK_BREAKING_CHARS.test(file.path)) void app.workspace.getLeaf(newLeaf).openFile(file);
  else void app.workspace.openLinkText(file.path, sourcePath, newLeaf);
}

/** Элемент, на котором событие (у текста - его родитель). Без instanceof: у отдельных окон свои классы DOM. */
function elementOf(target: EventTarget | null): Element | null {
  const node = target as (Node & { closest?: unknown }) | null;
  if (!node) return null;
  if (typeof node.closest === "function") return node as Element;
  return node.parentElement ?? null;
}

/** Текст плашки - значение свойства. */
function pillText(pill: Element): string {
  return (pill.querySelector(PILL_CONTENT_SELECTOR) ?? pill).textContent ?? "";
}

/**
 * Щелчок по тексту плашки: не по крестику (он убирает значение, как обычно) и не в поле правки значения (правка
 * через меню правой кнопки - курсор в тексте ставится как обычно).
 */
function isOnPillText(el: Element, pill: Element): boolean {
  // Только поле внутри плашки: редактор вокруг панели свойств (contenteditable) клику не мешает.
  const editable = el.closest('input, textarea, [contenteditable]:not([contenteditable="false"])');
  if (editable && pill.contains(editable)) return false;
  const content = pill.querySelector(PILL_CONTENT_SELECTOR);
  if (content) return content.contains(el);
  const control = el.closest('[class*="remove"], button, svg');
  return !(control && control !== pill && pill.contains(control));
}

/** Выбор проекта, когда у задачи их несколько. */
class ProjectChoiceModal extends SuggestModal<ProjectNote> {
  constructor(
    app: App,
    private readonly projects: ProjectNote[],
    private readonly onChoose: (project: ProjectNote, evt: MouseEvent | KeyboardEvent) => void
  ) {
    super(app);
    this.setPlaceholder(UI_LABELS.projectLink.choosePlaceholder);
  }

  getSuggestions(query: string): ProjectNote[] {
    const normalize = (s: string) => s.toLowerCase().replace(/ё/g, "е");
    const q = normalize(query.trim());
    return this.projects.filter(
      (project) => normalize(project.name).includes(q) || normalize(project.file.path).includes(q)
    );
  }

  renderSuggestion(project: ProjectNote, el: HTMLElement): void {
    el.createDiv({ text: project.name });
    const path = project.file.path.replace(/\.md$/i, "");
    if (path !== project.name) el.createEl("small", { text: path, cls: "opa-project-choice-path" });
  }

  onChooseSuggestion(project: ProjectNote, evt: MouseEvent | KeyboardEvent): void {
    this.onChoose(project, evt);
  }
}

export class TaskProjectLinkModule implements PluginModule {
  private ctx: ModuleContext;
  private loaded = false;
  /** Документы с обработчиками и как их снять: у отдельных окон Obsidian свой document. */
  private listeners = new Map<Document, () => void>();
  /** Панели свойств под наблюдением (перерисовка плашек - вернуть класс ссылки). */
  private observers = new Map<Element, MutationObserver>();
  private decorateTimer: ReturnType<typeof setTimeout> | null = null;
  /** До какого времени (Date.now) гасить двойной клик после перехода. */
  private dblClickGuardUntil = 0;
  /** Родитель предпросмотра для панели «Свойства файла» (у вкладки заметки родитель - её вид). */
  private sidebarHoverParent: HoverParent = { hoverPopover: null };

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
  }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const { app, plugin } = this.ctx;
    plugin.addCommand({
      id: "open-task-project",
      name: UI_LABELS.projectLink.command,
      checkCallback: (checking: boolean) => this.runOpenProjectCommand(checking),
    });
    plugin.registerHoverLinkSource?.(PROJECT_HOVER_SOURCE, { display: PROJECT_HOVER_SOURCE_NAME, defaultMod: true });
    this.listen(typeof document === "undefined" ? null : document);

    const schedule = (): void => this.scheduleDecorate();
    const workspace = app.workspace;
    plugin.registerEvent(workspace.on("layout-change", schedule));
    plugin.registerEvent(workspace.on("active-leaf-change", schedule));
    plugin.registerEvent(workspace.on("file-open", schedule));
    plugin.registerEvent(
      workspace.on("window-open", (win) => {
        this.listen(win?.doc);
        schedule();
      })
    );
    plugin.registerEvent(workspace.on("window-close", (win) => this.forget(win?.doc)));
    workspace.onLayoutReady?.(() => {
      // После загрузки хранилища (при загрузке create приходит на каждый файл). Правка project у задачи, появление,
      // переименование и удаление заметки проекта меняют, какие плашки - ссылки.
      plugin.registerEvent(app.metadataCache.on("changed", schedule));
      plugin.registerEvent(app.vault.on("create", schedule));
      plugin.registerEvent(app.vault.on("rename", schedule));
      plugin.registerEvent(app.vault.on("delete", schedule));
      schedule();
    });
  }

  unload(): void {
    if (!this.loaded) return;
    this.loaded = false;
    if (this.decorateTimer != null) clearTimeout(this.decorateTimer);
    this.decorateTimer = null;
    for (const doc of [...this.listeners.keys()]) {
      doc.querySelectorAll(`.${PROJECT_LINK_CLASS}`).forEach((el) => el.classList.remove(PROJECT_LINK_CLASS));
      this.forget(doc);
    }
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
  }

  /** Обработчики клика и наведения в документе окна - один раз на документ. */
  private listen(doc: Document | null | undefined): void {
    if (!doc || this.listeners.has(doc)) return;
    // Перехват до обработчиков самой плашки: клик по проекту - переход, а не выбор плашки.
    const capture = { capture: true };
    doc.addEventListener("click", this.onClick, capture);
    doc.addEventListener("auxclick", this.onAuxClick, capture);
    doc.addEventListener("dblclick", this.onDblClick, capture);
    doc.addEventListener("mouseover", this.onMouseOver);
    this.listeners.set(doc, () => {
      doc.removeEventListener("click", this.onClick, capture);
      doc.removeEventListener("auxclick", this.onAuxClick, capture);
      doc.removeEventListener("dblclick", this.onDblClick, capture);
      doc.removeEventListener("mouseover", this.onMouseOver);
    });
  }

  /** Окно закрыто (или модуль выгружается): снять обработчики и наблюдателей его документа. */
  private forget(doc: Document | null | undefined): void {
    if (!doc) return;
    this.listeners.get(doc)?.();
    this.listeners.delete(doc);
    for (const [container, observer] of this.observers) {
      if (container.ownerDocument !== doc) continue;
      observer.disconnect();
      this.observers.delete(container);
    }
  }

  private onClick = (evt: MouseEvent): void => {
    if (evt.button !== 0) return;
    this.openFromEvent(evt, Keymap.isModEvent(evt));
  };

  /** Средняя кнопка - в новой вкладке, как у ссылок. */
  private onAuxClick = (evt: MouseEvent): void => {
    if (evt.button !== 1) return;
    this.openFromEvent(evt, "tab");
  };

  /** Двойной клик сразу после перехода не доходит до Obsidian (иначе - правка значения под курсором). */
  private onDblClick = (evt: MouseEvent): void => {
    if (Date.now() > this.dblClickGuardUntil) return;
    this.dblClickGuardUntil = 0;
    evt.preventDefault();
    evt.stopPropagation();
  };

  private openFromEvent(evt: MouseEvent, newLeaf: PaneType | boolean): void {
    // Второй щелчок двойного клика проект второй раз не открывает.
    if (evt.detail > 1) return;
    const link = this.linkAt(evt.target);
    if (!link) return;
    evt.preventDefault();
    evt.stopPropagation();
    this.dblClickGuardUntil = Date.now() + DBLCLICK_GUARD_MS;
    openProjectNote(this.ctx.app, link.project, link.source.path, newLeaf);
  }

  /** Наведение: плашка - ссылка (если разметка ещё не успела), с Ctrl/Cmd - предпросмотр заметки проекта. */
  private onMouseOver = (evt: MouseEvent): void => {
    const link = this.linkAt(evt.target);
    if (!link) return;
    link.pill.classList.add(PROJECT_LINK_CLASS);
    this.ctx.app.workspace.trigger?.("hover-link", {
      event: evt,
      source: PROJECT_HOVER_SOURCE,
      hoverParent: link.hoverParent,
      targetEl: link.pill,
      linktext: link.project.path,
      sourcePath: link.source.path,
    });
  };

  /** Плашка проекта со своей заметкой под элементом события; null - нет (тогда событие не трогаем). */
  private linkAt(target: EventTarget | null): ProjectPillLink | null {
    if (!this.loaded) return null;
    const el = elementOf(target);
    const pill = el?.closest<HTMLElement>(PILL_SELECTOR) ?? null;
    if (!el || !pill || !isOnPillText(el, pill)) return null;
    const property = pill.closest<HTMLElement>(PROJECT_PROPERTY_SELECTOR);
    const owner = property ? this.ownerOf(property) : null;
    return owner ? this.pillLink(pill, owner) : null;
  }

  private pillLink(pill: HTMLElement, owner: PropertiesOwner): ProjectPillLink | null {
    // Значение-ссылку [[…]] Obsidian рисует ссылкой и открывает сам.
    if (pill.matches(".internal-link") || pill.querySelector("a, .internal-link")) return null;
    const app = this.ctx.app;
    const value = pillProjectValue(pillText(pill), frontmatterOf(app, owner.file)?.project);
    const project = value ? projectNoteFile(app, value, owner.file.path) : null;
    return project ? { pill, source: owner.file, project, hoverParent: owner.hoverParent } : null;
  }

  /** Чьи свойства показывает панель: заметки во вкладке или (панель «Свойства файла») активной заметки. */
  private ownerOf(el: Element): PropertiesOwner | null {
    const workspace = this.ctx.app.workspace;
    for (const leaf of workspace.getLeavesOfType?.("markdown") ?? []) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file && view.containerEl?.contains(el)) {
        return { file: view.file, hoverParent: view };
      }
    }
    for (const leaf of workspace.getLeavesOfType?.(FILE_PROPERTIES_VIEW_TYPE) ?? []) {
      if (!leaf.view?.containerEl?.contains(el)) continue;
      const file = workspace.getActiveFile?.();
      return file instanceof TFile ? { file, hoverParent: this.sidebarHoverParent } : null;
    }
    return null;
  }

  private scheduleDecorate(): void {
    if (!this.loaded || this.decorateTimer != null) return;
    this.decorateTimer = setTimeout(() => {
      this.decorateTimer = null;
      this.decorateAll();
    }, DECORATE_DELAY_MS);
  }

  /** Плашки проектов со своей заметкой выглядят ссылками (класс), остальные - как были. */
  decorateAll(): void {
    if (!this.loaded) return;
    for (const leaf of this.ctx.app.workspace.getLeavesOfType?.("markdown") ?? []) {
      this.listen(leaf.view?.containerEl?.ownerDocument);
    }
    for (const [container, observer] of this.observers) {
      if (container.isConnected) continue;
      observer.disconnect();
      this.observers.delete(container);
    }
    for (const doc of this.listeners.keys()) {
      for (const property of Array.from(doc.querySelectorAll<HTMLElement>(PROJECT_PROPERTY_SELECTOR))) {
        this.observe(property.closest(METADATA_CONTAINER_SELECTOR) ?? property);
        const owner = this.ownerOf(property);
        for (const pill of Array.from(property.querySelectorAll<HTMLElement>(PILL_SELECTOR))) {
          pill.classList.toggle(PROJECT_LINK_CLASS, owner != null && this.pillLink(pill, owner) != null);
        }
      }
    }
  }

  /** Следить за перерисовкой панели свойств: новые плашки получают класс ссылки. */
  private observe(container: Element): void {
    if (this.observers.has(container)) return;
    // Наблюдатель из окна панели: у всплывающих окон Obsidian свой window.
    const win = container.ownerDocument?.defaultView as (Window & typeof globalThis) | null | undefined;
    const Observer = win?.MutationObserver ?? (typeof MutationObserver === "undefined" ? null : MutationObserver);
    if (!Observer) return;
    try {
      const observer = new Observer(() => this.scheduleDecorate());
      observer.observe(container, { childList: true, subtree: true });
      this.observers.set(container, observer);
    } catch {
      // Без наблюдателя плашки размечаются по событиям хранилища и вкладок и при наведении.
    }
  }

  /**
   * Команда «Открыть проект задачи»: доступна в заметке с проектом во frontmatter (не в шаблоне). Проект с заметкой -
   * открыть её в этой же вкладке, несколько - выбрать, у проекта нет заметки - подсказка.
   */
  private runOpenProjectCommand(checking: boolean): boolean {
    const app = this.ctx.app;
    const file = app.workspace.getActiveFile();
    if (!(file instanceof TFile) || isTemplateFile(file)) return false;
    const { found, missing } = projectTargetsOf(app, file);
    if (found.length === 0 && missing.length === 0) return false;
    if (checking) return true;
    const open = (project: ProjectNote, newLeaf: PaneType | boolean): void =>
      openProjectNote(app, project.file, file.path, newLeaf);
    if (found.length === 1) open(found[0], false);
    else if (found.length > 1) {
      new ProjectChoiceModal(app, found, (project, evt) => open(project, Keymap.isModEvent(evt))).open();
    } else new Notice(UI_LABELS.projectLink.noNote(missing));
    return true;
  }
}
