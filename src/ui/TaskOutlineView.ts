/**
 * Панель «Структура» (правый сайдбар): заголовки открытой заметки, как в стандартном Outline, плюс то,
 * что рисует сам плагин: пункты «Оглавления» записей из ежедневных заметок (блок opa-task-view) и заголовки
 * блоков (Напоминания, Блокнот…). Стандартный Outline их не видит: он берёт заголовки только из самой заметки.
 */

import {
  ItemView,
  Keymap,
  MarkdownView,
  Menu,
  Notice,
  Platform,
  TFile,
  setIcon,
  type PaneType,
  type Workspace,
  type WorkspaceLeaf,
} from "obsidian";
import {
  buildOutlineTree,
  collectCollapsibleIds,
  filterOutlineTree,
  findPluginBlocks,
  outlineSignature,
  type OutlineBlockTitleInput,
  type OutlineHeadingInput,
  type OutlineNode,
  type OutlineTocItem,
} from "../core/OutlineTree";
import { findScrollContainer, findTaskViewTarget } from "../modules/TaskViewModule";
import { UI_LABELS } from "./Labels";

export const OUTLINE_VIEW_TYPE = "opa-outline";

export interface OutlineTocResult {
  items: OutlineTocItem[];
  /** Кэш метаданных части ежедневных заметок ещё не догнал файлы - пункты могут быть неточны. */
  stale: boolean;
}

export interface OutlineViewDeps {
  /** Пункты «Оглавления» записей задачи (как в блоке opa-task-view). */
  getTocItems(taskPath: string): Promise<OutlineTocResult>;
  /** Заголовок блока плагина по языку блока кода; null - у блока нет заголовка или модуль выключен. */
  getBlockTitle(language: string): string | null;
  /** Подписка на обновление индекса ежедневных заметок; возвращает отписку. */
  onIndexUpdated(callback: () => void): () => void;
}

/** Задержка обновления после правок заметки или ежедневных. */
const UPDATE_DEBOUNCE_MS = 300;
/** Повтор, пока кэш метаданных отстаёт от файлов (как у блока задачи). */
const STALE_RETRY_MS = 1200;
const MAX_STALE_RETRIES = 3;
/** Сколько ждать, пока блок задачи отрисуется после прокрутки к нему. */
const TARGET_WAIT_MS = 2500;
const TARGET_POLL_MS = 50;
/** Отступ сверху при прокрутке к записи. */
const SCROLL_MARGIN_PX = 8;
/** Повторные выравнивания, пока догружаются картинки и соседние секции. */
const REALIGN_DELAYS_MS = [80, 250, 600, 1200];
const FLASH_MS = 1200;
/** Действия пользователя, после которых панель больше не двигает заметку сама. */
const USER_INPUT_EVENTS = ["wheel", "touchmove", "keydown", "pointerdown"];
const TASK_VIEW_LANGUAGE = "opa-task-view";

export class TaskOutlineView extends ItemView {
  navigation = false;
  private file: TFile | null = null;
  /** Вкладка с заметкой, по которой строится панель и в которой выполняются переходы. */
  private targetLeaf: WorkspaceLeaf | null = null;
  private tree: OutlineNode[] = [];
  /** Заметка, по которой построено текущее дерево: пока идёт обновление, клики по прежнему дереву не работают. */
  private treeFile: TFile | null = null;
  /** Строка блока opa-task-view в заметке (null - блока нет). */
  private blockLine: number | null = null;
  private signature: string | null = null;
  private staleRetries = 0;
  /** Свёрнутые узлы по файлам (в памяти, как у стандартного Outline). */
  private readonly collapsedByFile = new Map<string, Set<string>>();
  private query = "";
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private updateToken = 0;
  private unsubscribeIndex: (() => void) | null = null;
  private headerEl: HTMLElement | null = null;
  private treeEl: HTMLElement | null = null;
  private searchWrapEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private searchButtonEl: HTMLElement | null = null;
  private collapseButtonEl: HTMLElement | null = null;
  /** Номер текущего перехода: новый переход отменяет ожидание и довыравнивание предыдущего. */
  private navigationToken = 0;
  private cancelReveal: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly deps: OutlineViewDeps) {
    super(leaf);
  }

  getViewType(): string {
    return OUTLINE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file ? UI_LABELS.outline.titleFor(this.file.basename) : UI_LABELS.outline.title;
  }

  getIcon(): string {
    return "list-tree";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("opa-outline-view");
    this.buildHeader();
    this.treeEl = this.contentEl.createDiv({ cls: "opa-outline-tree" });

    const { workspace, metadataCache, vault } = this.app;
    this.registerEvent(workspace.on("active-leaf-change", (leaf) => this.syncTarget(leaf)));
    this.registerEvent(workspace.on("file-open", () => this.syncTarget(null)));
    this.registerEvent(workspace.on("layout-change", () => this.syncTarget(null)));
    this.registerEvent(
      metadataCache.on("changed", (file) => {
        if (file.path === this.file?.path) this.scheduleUpdate();
      })
    );
    this.registerEvent(
      vault.on("rename", (file) => {
        if (file !== this.file) return;
        this.updateHeaderTitle();
        this.scheduleUpdate(0);
      })
    );
    this.unsubscribeIndex = this.deps.onIndexUpdated(() => {
      if (this.blockLine != null) this.scheduleUpdate();
    });
    workspace.onLayoutReady(() => this.syncTarget(null));
    // Заметка найдена - дерево отрисует запущенное обновление; иначе сразу показываем пустое состояние
    if (!this.file) this.render();
  }

  /** Перестроить дерево (например, после смены настроек: заголовки выключенных модулей не показываются). */
  refresh(): void {
    this.signature = null;
    this.scheduleUpdate(0);
  }

  async onClose(): Promise<void> {
    this.unsubscribeIndex?.();
    this.unsubscribeIndex = null;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = null;
    this.updateToken++;
    this.startNavigation();
  }

  // ------------------------------------------------------------------
  // Какую заметку показывать
  // ------------------------------------------------------------------

  private syncTarget(changed: WorkspaceLeaf | null): void {
    const leaf = this.pickTargetLeaf(changed);
    this.targetLeaf = leaf;
    const file = markdownFileOf(leaf);
    if (file === this.file) return;
    // Незавершённый переход относился к прежней заметке
    this.startNavigation();
    this.file = file;
    this.signature = null;
    this.blockLine = null;
    this.staleRetries = 0;
    this.updateHeaderTitle();
    this.scheduleUpdate(0);
  }

  /**
   * Вкладка-источник, как у стандартного Outline: активная markdown-вкладка. Фокус в сайдбаре (в том числе
   * клик по самой панели), связанные панели (обратные ссылки, граф) и ещё не загруженные фоновые вкладки её
   * не меняют; другая вкладка в основной области (canvas, PDF, пустая) - панель пуста.
   */
  private pickTargetLeaf(changed: WorkspaceLeaf | null): WorkspaceLeaf | null {
    const { workspace } = this.app;
    const candidate = changed ?? workspace.getMostRecentLeaf();
    if (candidate && markdownFileOf(candidate)) return candidate;
    const keepCurrent =
      !candidate ||
      candidate === this.leaf ||
      isDeferredLeaf(candidate) ||
      candidate.view?.navigation === false ||
      isSidebarLeaf(workspace, candidate);
    if (!keepCurrent) return null;
    const current = this.targetLeaf;
    if (current && markdownFileOf(current) && isLeafAlive(current)) return current;
    const recent = workspace.getMostRecentLeaf();
    return recent && markdownFileOf(recent) ? recent : null;
  }

  private updateHeaderTitle(): void {
    // Подпись вкладки (подсказка при наведении) - внутренний метод, есть не во всех версиях
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
  }

  // ------------------------------------------------------------------
  // Данные
  // ------------------------------------------------------------------

  /** Обновить дерево через delayMs (0 - сразу); новый вызов заменяет запланированный. */
  private scheduleUpdate(delayMs: number = UPDATE_DEBOUNCE_MS): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = null;
    if (delayMs <= 0) {
      void this.update();
      return;
    }
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      void this.update();
    }, delayMs);
  }

  /** Пересобрать дерево для текущей заметки (перерисовка - только если оно изменилось). */
  async update(): Promise<void> {
    const token = ++this.updateToken;
    const file = this.file;
    if (!file) {
      this.setTree([], null, null);
      return;
    }
    let headings: OutlineHeadingInput[] = [];
    try {
      const cache = this.app.metadataCache.getFileCache(file);
      headings = (cache?.headings ?? []).map((h) => ({
        text: h.heading,
        level: h.level,
        line: h.position.start.line,
      }));
      let block: { line: number; items: OutlineTocItem[] } | null = null;
      const titled: OutlineBlockTitleInput[] = [];
      let stale = false;
      // Блоки плагина - блоки кода: заметки без блоков кода не читаем
      const mayHaveBlock = !cache?.sections || cache.sections.some((section) => section.type === "code");
      if (mayHaveBlock) {
        const content = await this.app.vault.cachedRead(file);
        if (token !== this.updateToken) return;
        const blocks = findPluginBlocks(content);
        const ordinals = new Map<string, number>();
        for (const found of blocks) {
          const ordinal = ordinals.get(found.language) ?? 0;
          ordinals.set(found.language, ordinal + 1);
          const title = this.deps.getBlockTitle(found.language);
          if (title) titled.push({ line: found.line, title, language: found.language, ordinal });
        }
        const taskViewLine = blocks.find((found) => found.language === TASK_VIEW_LANGUAGE)?.line;
        if (taskViewLine != null) {
          const result = await this.deps.getTocItems(file.path);
          if (token !== this.updateToken) return;
          block = { line: taskViewLine, items: result.items };
          stale = result.stale;
        }
      }
      this.setTree(buildOutlineTree(headings, block, titled), block?.line ?? null, file);
      if (!stale) {
        this.staleRetries = 0;
      } else if (this.staleRetries < MAX_STALE_RETRIES) {
        this.staleRetries++;
        this.scheduleUpdate(STALE_RETRY_MS);
      }
    } catch (error) {
      console.error("[OPA] Outline update failed:", error);
      // Хотя бы заголовки самой заметки - не оставлять дерево прежней заметки
      if (token === this.updateToken) this.setTree(buildOutlineTree(headings, null), null, file);
    }
  }

  private setTree(tree: OutlineNode[], blockLine: number | null, file: TFile | null): void {
    this.blockLine = blockLine;
    this.treeFile = file;
    const signature = `${file?.path ?? ""}\n${outlineSignature(tree)}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.tree = tree;
    this.render();
  }

  // ------------------------------------------------------------------
  // Отрисовка
  // ------------------------------------------------------------------

  private buildHeader(): void {
    this.headerEl?.remove();
    const header = this.containerEl.ownerDocument.createElement("div");
    header.className = "nav-header opa-outline-header";
    this.containerEl.insertBefore(header, this.contentEl);
    this.headerEl = header;

    const buttons = header.createDiv({ cls: "nav-buttons-container" });
    this.searchButtonEl = this.createNavButton(buttons, "search", UI_LABELS.outline.search, () => this.toggleSearch());
    this.collapseButtonEl = this.createNavButton(buttons, "chevrons-down-up", UI_LABELS.outline.collapseAll, () =>
      this.toggleCollapseAll()
    );

    const searchWrap = header.createDiv({ cls: "search-input-container opa-outline-search" });
    searchWrap.style.display = "none";
    const input = searchWrap.createEl("input", {
      attr: { type: "search", placeholder: UI_LABELS.outline.searchPlaceholder, spellcheck: "false" },
    });
    input.addEventListener("input", () => {
      this.query = input.value;
      this.render();
    });
    input.addEventListener("keydown", (evt) => {
      if (evt.key !== "Escape") return;
      evt.preventDefault();
      this.toggleSearch(false);
    });
    this.searchWrapEl = searchWrap;
    this.searchInputEl = input;
  }

  private createNavButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
    const button = parent.createDiv({ cls: "clickable-icon nav-action-button", attr: { "aria-label": label } });
    setIcon(button, icon);
    button.addEventListener("click", (evt) => {
      evt.preventDefault();
      onClick();
    });
    return button;
  }

  private render(): void {
    const treeEl = this.treeEl;
    if (!treeEl) return;
    const scrollTop = this.contentEl.scrollTop;
    const filtering = this.query.trim() !== "";
    treeEl.empty();
    this.updateCollapseButton(filtering);
    if (!this.file) {
      treeEl.createDiv({ cls: "pane-empty", text: UI_LABELS.outline.noFile });
      return;
    }
    const nodes = filterOutlineTree(this.tree, this.query);
    if (nodes.length === 0) {
      treeEl.createDiv({
        cls: "pane-empty",
        text: filtering ? UI_LABELS.outline.noMatches : UI_LABELS.outline.noHeadings,
      });
      return;
    }
    // При поиске совпадения показываются целиком, свёртывание недоступно
    this.renderNodes(treeEl, nodes, filtering ? null : this.collapsedSet());
    this.contentEl.scrollTop = scrollTop;
  }

  /** collapsed = null - режим поиска: всё развёрнуто, стрелок нет. */
  private renderNodes(parentEl: HTMLElement, nodes: OutlineNode[], collapsed: Set<string> | null): void {
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      const collapsible = hasChildren && collapsed != null;
      const isCollapsed = collapsible && collapsed.has(node.id);
      const itemEl = parentEl.createDiv({ cls: isCollapsed ? "tree-item is-collapsed" : "tree-item" });
      const selfCls = ["tree-item-self", "is-clickable"];
      if (collapsible) selfCls.push("mod-collapsible");
      if (node.kind === "entry") selfCls.push("opa-outline-entry");
      const selfEl = itemEl.createDiv({ cls: selfCls.join(" ") });
      if (collapsible) {
        const iconEl = selfEl.createDiv({
          cls: isCollapsed ? "tree-item-icon collapse-icon is-collapsed" : "tree-item-icon collapse-icon",
        });
        setIcon(iconEl, "right-triangle");
        iconEl.addEventListener("click", (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          this.toggleCollapsed(node.id);
        });
      }
      const innerEl = selfEl.createDiv({ cls: "tree-item-inner" });
      innerEl.createEl("span", { cls: "opa-outline-text", text: node.text });
      if (node.suffix) innerEl.createEl("span", { cls: "opa-outline-suffix", text: ` (${node.suffix})` });
      selfEl.addEventListener("click", (evt) => this.onNodeClick(node, evt));
      selfEl.addEventListener("contextmenu", (evt) => this.onNodeContextMenu(node, evt));
      if (hasChildren && !isCollapsed) {
        this.renderNodes(itemEl.createDiv({ cls: "tree-item-children" }), node.children, collapsed);
      }
    }
  }

  private collapsedSet(): Set<string> {
    const key = this.file?.path ?? "";
    let set = this.collapsedByFile.get(key);
    if (!set) {
      set = new Set<string>();
      this.collapsedByFile.set(key, set);
    }
    return set;
  }

  private toggleCollapsed(id: string): void {
    const set = this.collapsedSet();
    if (set.has(id)) set.delete(id);
    else set.add(id);
    this.render();
  }

  private allCollapsed(): boolean {
    const ids = collectCollapsibleIds(this.tree);
    const set = this.collapsedSet();
    return ids.length > 0 && ids.every((id) => set.has(id));
  }

  private toggleCollapseAll(): void {
    const collapse = !this.allCollapsed();
    const set = this.collapsedSet();
    set.clear();
    if (collapse) for (const id of collectCollapsibleIds(this.tree)) set.add(id);
    this.render();
  }

  private updateCollapseButton(filtering: boolean): void {
    const button = this.collapseButtonEl;
    if (!button) return;
    button.style.display = filtering ? "none" : "";
    const allCollapsed = this.allCollapsed();
    setIcon(button, allCollapsed ? "chevrons-up-down" : "chevrons-down-up");
    button.setAttribute("aria-label", allCollapsed ? UI_LABELS.outline.expandAll : UI_LABELS.outline.collapseAll);
  }

  private toggleSearch(show?: boolean): void {
    const wrap = this.searchWrapEl;
    const input = this.searchInputEl;
    if (!wrap || !input) return;
    const visible = show ?? wrap.style.display === "none";
    wrap.style.display = visible ? "" : "none";
    this.searchButtonEl?.toggleClass("is-active", visible);
    if (visible) {
      input.focus();
      input.select();
      return;
    }
    if (this.query) {
      this.query = "";
      input.value = "";
      this.render();
    }
  }

  // ------------------------------------------------------------------
  // Переходы
  // ------------------------------------------------------------------

  private run(action: () => Promise<void>): void {
    action().catch((error) => console.error("[OPA] Outline navigation failed:", error));
  }

  private onNodeClick(node: OutlineNode, evt: MouseEvent): void {
    evt.preventDefault();
    // Дерево ещё от прежней заметки (обновление не закончилось)
    if (this.treeFile !== this.file) return;
    if (node.kind === "heading" && node.line != null) {
      const line = node.line;
      this.run(() => this.goToLine(line));
      return;
    }
    if (node.kind === "block" && node.block && node.line != null) {
      const block = node.block;
      const line = node.line;
      this.run(() => this.goToBlock(block, line));
      return;
    }
    const item = node.item;
    if (node.kind !== "entry" || !item) return;
    const newLeaf = Keymap.isModEvent(evt);
    this.run(() => (newLeaf ? this.openInDaily(item, newLeaf) : this.goToEntry(item)));
  }

  private onNodeContextMenu(node: OutlineNode, evt: MouseEvent): void {
    const item = node.item;
    if (node.kind !== "entry" || !item || this.treeFile !== this.file) return;
    evt.preventDefault();
    const menu = new Menu();
    menu.addItem((menuItem) =>
      menuItem
        .setTitle(UI_LABELS.outline.goToEntry)
        .setIcon("arrow-right")
        .onClick(() => this.run(() => this.goToEntry(item)))
    );
    menu.addItem((menuItem) =>
      menuItem
        .setTitle(UI_LABELS.outline.openInDaily)
        .setIcon("calendar-days")
        .onClick(() => this.run(() => this.openInDaily(item, "tab")))
    );
    menu.showAtMouseEvent(evt);
  }

  /** Начать новый переход: отменить ожидание и довыравнивание предыдущего. */
  private startNavigation(): number {
    this.cancelReveal?.();
    this.cancelReveal = null;
    return ++this.navigationToken;
  }

  /** Сделать вкладку с заметкой активной; на телефоне убрать выдвижные панели, которые закрывают заметку. */
  private activateTarget(view: MarkdownView, focus: boolean): void {
    const { workspace } = this.app;
    workspace.setActiveLeaf(view.leaf, { focus });
    if (!Platform.isMobile) return;
    for (const split of [workspace.leftSplit, workspace.rightSplit]) {
      (split as { collapse?: () => void } | null)?.collapse?.();
    }
  }

  /** Заголовок заметки - как в стандартном Outline: вкладка активна, курсор на заголовке. */
  private async goToLine(line: number): Promise<void> {
    const token = this.startNavigation();
    const view = await this.ensureTargetView();
    if (!view || token !== this.navigationToken) return;
    this.activateTarget(view, true);
    view.setEphemeralState({ line });
  }

  /** Пункт записи: прокрутить к записи/подзаголовку в отрисованном блоке задачи. */
  async goToEntry(item: OutlineTocItem): Promise<void> {
    await this.jumpToRendered(
      (view, file) => findTaskViewTarget(view.containerEl, file.path, item),
      this.blockLine
    );
  }

  /** Заголовок блока плагина: прокрутить к шапке отрисованного блока. */
  async goToBlock(block: { language: string; ordinal: number }, line: number): Promise<void> {
    await this.jumpToRendered((view) => findRenderedBlockHeader(view.containerEl, block.language, block.ordinal), line);
  }

  /**
   * Прокрутить к элементу, который отрисовал плагин (запись блока задачи, шапка блока). Если блок сейчас
   * не в DOM - сначала к строке блока в заметке, потом ждём отрисовки.
   */
  private async jumpToRendered(
    find: (view: MarkdownView, file: TFile) => HTMLElement | null,
    blockLine: number | null
  ): Promise<void> {
    const token = this.startNavigation();
    const file = this.file;
    const view = await this.ensureTargetView();
    if (!file || !view || token !== this.navigationToken) return;
    const cancelled = (): boolean => token !== this.navigationToken;
    // Редактор в фокус не ставим: курсор остался бы в другом месте заметки, и первая же клавиша увела бы туда
    this.activateTarget(view, view.getMode() === "preview");
    const probe = (): HTMLElement | null => find(view, file);
    let target = probe();
    if (!target && blockLine != null) {
      // Блок далеко от экрана: Obsidian не держит в DOM дальние секции (режим чтения) и строки (Live Preview).
      // Прокручиваем к блоку и ждём отрисовки; прокрутка, клавиша или клик в заметке отменяют ожидание.
      const stopWatching = onUserInput(view.containerEl, () => {
        if (!cancelled()) this.startNavigation();
      });
      try {
        scrollViewToLine(view, blockLine);
        // В режиме исходного кода блок не отрисовывается - остаёмся у его строки
        if (isSourceMode(view)) return;
        target = await waitFor(probe, TARGET_WAIT_MS, cancelled);
        if (!target && !cancelled()) {
          // Запасной путь - как переход по ссылке на строку: заодно разворачивает свёрнутый раздел
          view.setEphemeralState({ line: blockLine });
          target = await waitFor(probe, TARGET_WAIT_MS, cancelled);
        }
      } finally {
        stopWatching();
      }
    }
    if (target && !cancelled()) this.cancelReveal = revealElement(target);
  }

  private async openInDaily(item: OutlineTocItem, newLeaf: PaneType | boolean): Promise<void> {
    this.startNavigation();
    const file = this.app.vault.getAbstractFileByPath(item.sourcePath);
    if (!(file instanceof TFile)) {
      new Notice(UI_LABELS.errors.fileNotFound(item.sourcePath));
      return;
    }
    const leaf = this.app.workspace.getLeaf(newLeaf === true ? "tab" : newLeaf || "tab");
    await leaf.openFile(file, { active: true, ...(item.line != null ? { eState: { line: item.line } } : {}) });
  }

  /**
   * Вкладка с текущей заметкой. Если её уже нет - другая вкладка с этой заметкой (в том числе ещё
   * не загруженная фоновая), иначе заметка открывается в новой вкладке, не заменяя текущую.
   */
  private async ensureTargetView(): Promise<MarkdownView | null> {
    const file = this.file;
    if (!file) return null;
    const current = this.targetLeaf;
    if (current && isLeafAlive(current) && markdownFileOf(current)?.path === file.path) {
      return current.view as MarkdownView;
    }
    const { workspace } = this.app;
    const leaves: WorkspaceLeaf[] = [];
    workspace.iterateAllLeaves((leaf) => {
      leaves.push(leaf);
    });
    let leaf =
      leaves.find((candidate) => markdownFileOf(candidate)?.path === file.path) ??
      leaves.find((candidate) => viewStateFile(candidate) === file.path) ??
      null;
    if (leaf) {
      // Фоновая вкладка может быть ещё не загружена (Obsidian 1.7.2+)
      await (leaf as { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.();
    } else {
      leaf = workspace.getLeaf("tab");
      await leaf.openFile(file);
    }
    this.targetLeaf = leaf;
    return leaf.view instanceof MarkdownView ? leaf.view : null;
  }
}

/** Файл markdown-вкладки; null - вкладка не markdown (canvas, PDF, пустая) или без файла. */
function markdownFileOf(leaf: WorkspaceLeaf | null | undefined): TFile | null {
  const view = leaf?.view;
  return view instanceof MarkdownView ? view.file : null;
}

/** Файл из состояния вкладки - есть и у ещё не загруженной фоновой вкладки. */
function viewStateFile(leaf: WorkspaceLeaf): string | null {
  try {
    const state = leaf.getViewState();
    const file = (state.state as { file?: unknown } | undefined)?.file;
    return state.type === "markdown" && typeof file === "string" ? file : null;
  } catch {
    return null;
  }
}

function isLeafAlive(leaf: WorkspaceLeaf): boolean {
  return Boolean(leaf.view?.containerEl?.isConnected);
}

function isDeferredLeaf(leaf: WorkspaceLeaf): boolean {
  return (leaf as { isDeferred?: boolean }).isDeferred === true;
}

/**
 * Шапка отрисованного блока плагина (заголовок со стрелкой) - ordinal-го из видимых блоков этого языка.
 * Модули помечают контейнер блока классом, равным языку блока (opa-reminders-view…).
 */
function findRenderedBlockHeader(root: HTMLElement, language: string, ordinal: number): HTMLElement | null {
  const containers = (Array.from(root.getElementsByClassName(language)) as HTMLElement[]).filter(
    (el) => el.isConnected && el.getClientRects().length > 0
  );
  const container = containers[ordinal];
  if (!container) return null;
  return container.querySelector<HTMLElement>(".opa-section-header") ?? container;
}

/** Вкладка в левом или правом сайдбаре. */
export function isSidebarLeaf(workspace: Workspace, leaf: WorkspaceLeaf): boolean {
  try {
    const root = leaf.getRoot();
    return root === workspace.leftSplit || root === workspace.rightSplit;
  } catch {
    return false;
  }
}

/**
 * Прокрутить вкладку к строке без подсветки и без смены курсора - чтобы Obsidian отрисовал секцию
 * (режим чтения: прокрутка с ожиданием отрисовки) или строки (Live Preview) с блоком задачи.
 */
function scrollViewToLine(view: MarkdownView, line: number): void {
  try {
    if (view.getMode() === "preview") {
      view.setEphemeralState({ scroll: line });
    } else {
      const pos = { line, ch: 0 };
      view.editor.scrollIntoView({ from: pos, to: pos }, true);
    }
    return;
  } catch (error) {
    console.warn("[OPA] Outline: scrolling to the block failed, using ephemeral state:", error);
  }
  view.setEphemeralState({ line });
}

/** Режим исходного кода (не Live Preview): блоки кода не отрисовываются. */
function isSourceMode(view: MarkdownView): boolean {
  try {
    return view.getMode() === "source" && (view.getState() as { source?: unknown }).source === true;
  } catch {
    return false;
  }
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number, cancelled: () => boolean): Promise<T | null> {
  const started = Date.now();
  for (;;) {
    if (cancelled()) return null;
    const value = probe();
    if (value) return value;
    if (Date.now() - started >= timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, TARGET_POLL_MS));
  }
}

/** Слушать действия пользователя в элементе (прокрутка, клавиши, клики); возвращает отписку. */
function onUserInput(el: HTMLElement, callback: () => void): () => void {
  for (const type of USER_INPUT_EVENTS) el.addEventListener(type, callback, { passive: true, capture: true });
  return () => {
    for (const type of USER_INPUT_EVENTS) el.removeEventListener(type, callback, { capture: true });
  };
}

/**
 * Поставить элемент к верху области прокрутки и коротко подсветить. Пока догружаются картинки и соседние
 * секции, позиция может уехать - выравниваем ещё несколько раз, если пользователь не начал прокручивать сам.
 * Возвращает отмену довыравнивания (следующий переход из панели).
 */
function revealElement(target: HTMLElement): () => void {
  // Поиск области прокрутки - от контейнера блока: превью записи внутри него тоже помечено markdown-preview-view
  const blockRoot = target.closest<HTMLElement>(".opa-task-view, [class*='block-language-']");
  const scroller = findScrollContainer(blockRoot ?? target);
  const align = (): void => {
    if (!target.isConnected) return;
    if (!scroller) {
      target.scrollIntoView({ block: "start" });
      return;
    }
    const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - SCROLL_MARGIN_PX;
    if (!Number.isFinite(delta) || Math.abs(delta) < 2) return;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.min(maxTop, Math.max(0, scroller.scrollTop + delta));
  };
  align();
  const summary = target.tagName === "DETAILS" ? target.querySelector<HTMLElement>(":scope > summary") : null;
  flash(summary ?? target);
  if (!scroller) return () => undefined;

  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;
  let unlisten = (): void => undefined;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    unlisten();
  };
  // Пользователь сам прокручивает или кликает - больше не вмешиваемся
  unlisten = onUserInput(scroller, stop);
  for (const delay of REALIGN_DELAYS_MS) {
    timers.push(
      setTimeout(() => {
        if (!stopped) align();
      }, delay)
    );
  }
  timers.push(setTimeout(stop, REALIGN_DELAYS_MS[REALIGN_DELAYS_MS.length - 1] + 100));
  return stop;
}

function flash(el: HTMLElement): void {
  el.classList.remove("opa-outline-flash");
  void el.offsetWidth; // перезапуск анимации при повторном клике
  el.classList.add("opa-outline-flash");
  setTimeout(() => el.classList.remove("opa-outline-flash"), FLASH_MS);
}
