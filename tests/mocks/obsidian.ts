type Callback = (...args: any[]) => any;

export interface EventRef {
  event: string;
  callback: Callback;
  emitter: MockEvents;
}

export class MockEvents {
  private listeners = new Map<string, Set<Callback>>();

  on(event: string, callback: Callback): EventRef {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback);
    return { event, callback, emitter: this };
  }

  off(event: string, callback: Callback): void {
    this.listeners.get(event)?.delete(callback);
  }

  offref(ref: EventRef): void {
    ref.emitter.off(ref.event, ref.callback);
  }

  emit(event: string, ...args: any[]): void {
    for (const callback of [...(this.listeners.get(event) ?? [])]) callback(...args);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

export class TAbstractFile {
  path: string;
  name: string;

  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() ?? path;
  }
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string;
  stat: { mtime: number };

  constructor(path: string, mtime = Date.now()) {
    super(path);
    const dot = this.name.lastIndexOf(".");
    this.extension = dot >= 0 ? this.name.slice(dot + 1) : "";
    this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name;
    this.stat = { mtime };
  }
}

export class TFolder extends TAbstractFile {}

export class Notice {
  static messages: string[] = [];

  constructor(message: string) {
    Notice.messages.push(message);
  }
}

export class Component {
  private loaded = false;
  private children: Component[] = [];
  private cleanups: Array<() => void> = [];
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.onload();
    for (const child of this.children) child.load();
  }
  unload(): void {
    if (!this.loaded) return;
    this.loaded = false;
    for (const child of this.children) child.unload();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.onunload();
  }
  /** Как в Obsidian: обработчики снимаются при unload(). */
  register(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }
  registerEvent(ref: EventRef | Record<string, unknown>): void {
    const eventRef = ref as EventRef;
    if (eventRef?.emitter && typeof eventRef.emitter.offref === "function") {
      this.register(() => eventRef.emitter.offref(eventRef));
    }
  }
  registerDomEvent(el: any, type: string, callback: any, options?: any): void {
    el.addEventListener(type, callback, options);
    this.register(() => el.removeEventListener(type, callback, options));
  }
  /** Как в Obsidian: ребёнок загружается сразу, если родитель уже загружен. */
  addChild<T extends Component>(child: T): T {
    this.children.push(child);
    if (this.loaded) child.load();
    return child;
  }
  removeChild<T extends Component>(child: T): T {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.unload();
    }
    return child;
  }
  onload(): void {}
  onunload(): void {}
}

export class MarkdownRenderChild extends Component {
  constructor(public containerEl: HTMLElement) {
    super();
  }
}

/** Горячая клавиша окна, зарегистрированная через scope.register. */
export interface MockScopeHandler {
  modifiers: string[] | null;
  key: string;
  func: (evt: any) => any;
}

/**
 * Модальное окно: open()/close() вызывают onOpen()/onClose(). Без DOM (тесты файловой логики) элементов окна нет -
 * модули с окнами просто импортируются. В DOM-тестах (есть document) у окна есть modalEl/titleEl/contentEl,
 * open() вставляет его в документ, close() убирает; Modal.opened - открытые окна, scope.handlers - горячие клавиши.
 */
export class Modal {
  static opened: Modal[] = [];
  modalEl: any = null;
  contentEl: any = null;
  titleEl: any = null;
  isOpen = false;
  scope = {
    handlers: [] as MockScopeHandler[],
    register(modifiers: string[] | null, key: string, func: (evt: any) => any): void {
      this.handlers.push({ modifiers, key, func });
    },
  };
  constructor(public app: any) {
    const doc = (globalThis as { document?: Document }).document;
    if (doc) {
      this.modalEl = doc.createElement("div");
      this.modalEl.className = "modal";
      this.titleEl = this.modalEl.appendChild(doc.createElement("div"));
      this.titleEl.className = "modal-title";
      this.contentEl = this.modalEl.appendChild(doc.createElement("div"));
      this.contentEl.className = "modal-content";
    }
  }
  setTitle(_title: string): this {
    return this;
  }
  open(): void {
    this.isOpen = true;
    Modal.opened.push(this);
    const doc = (globalThis as { document?: Document }).document;
    if (doc && this.modalEl) doc.body.appendChild(this.modalEl);
    this.onOpen();
  }
  close(): void {
    this.isOpen = false;
    Modal.opened = Modal.opened.filter((modal) => modal !== this);
    this.modalEl?.remove?.();
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

/**
 * Окно выбора из списка (SuggestModal): в тестах окно не рисуется; choose(i, query) выбирает i-й вариант
 * по запросу, как Enter или клик (окно закрывается, затем onChooseSuggestion).
 */
export class SuggestModal<T> extends Modal {
  emptyStateText = "";
  limit = 100;
  placeholder = "";
  instructions: Array<{ command: string; purpose: string }> = [];
  setPlaceholder(placeholder: string): void {
    this.placeholder = placeholder;
  }
  setInstructions(instructions: Array<{ command: string; purpose: string }>): void {
    this.instructions = instructions;
  }
  getSuggestions(_query: string): T[] | Promise<T[]> {
    return [];
  }
  renderSuggestion(_value: T, _el: HTMLElement): void {}
  onChooseSuggestion(_value: T, _evt: unknown): void {}
  async choose(index = 0, query = ""): Promise<T | undefined> {
    const items = await this.getSuggestions(query);
    const item = items[index];
    this.close();
    if (item !== undefined) this.onChooseSuggestion(item, {});
    return item;
  }
}

/**
 * Подсказки в поле ввода (AbstractInputSuggest): как в Obsidian, список обновляется при фокусе и наборе
 * (getSuggestions по тексту поля). В тестах: instances - созданные подсказки, suggestions - последний список,
 * isOpen - открыт ли он, refresh() - пересчитать список сейчас.
 */
export class AbstractInputSuggest<T> {
  static instances: AbstractInputSuggest<any>[] = [];
  limit = 100;
  isOpen = false;
  suggestions: T[] = [];
  /** Область клавиш открытого списка (как у окна): handlers - зарегистрированные сочетания. */
  scope = {
    handlers: [] as MockScopeHandler[],
    register(modifiers: string[] | null, key: string, func: (evt: any) => any): void {
      this.handlers.push({ modifiers, key, func });
    },
  };
  constructor(public app: any, public inputEl: HTMLInputElement) {
    AbstractInputSuggest.instances.push(this);
    const refresh = () => void this.refresh();
    inputEl?.addEventListener?.("input", refresh);
    inputEl?.addEventListener?.("focus", refresh);
  }
  protected getSuggestions(_query: string): T[] | Promise<T[]> {
    return [];
  }
  renderSuggestion(_value: T, _el: HTMLElement): void {}
  selectSuggestion(_value: T, _evt?: unknown): void {}
  async refresh(): Promise<T[]> {
    this.suggestions = await this.getSuggestions(this.inputEl.value);
    this.isOpen = true;
    return this.suggestions;
  }
  setValue(value: string): void {
    this.inputEl.value = value;
  }
  getValue(): string {
    return this.inputEl.value;
  }
  onSelect(_callback: unknown): this {
    return this;
  }
  open(): void {
    this.isOpen = true;
  }
  close(): void {
    this.isOpen = false;
  }
}

/** Строка настроек формы: формы в тестах не строятся, класс нужен, чтобы импортировались модули с формами. */
export class Setting {
  constructor(public containerEl: unknown) {}
}

/** YAML в тестах не разбирается: заглушки нужны для импорта модулей, которые пишут frontmatter. */
export function parseYaml(_text: string): unknown {
  throw new Error("parseYaml недоступен в тестовой заглушке obsidian");
}

export function stringifyYaml(_value: unknown): string {
  throw new Error("stringifyYaml недоступен в тестовой заглушке obsidian");
}

/** Контекст code block processor: addChild загружает ребёнка, unloadChildren - выгружает (как при уничтожении секции). */
export function createMockProcessorContext(sourcePath = "") {
  const children: Component[] = [];
  return {
    sourcePath,
    addChild(child: Component) {
      children.push(child);
      child.load();
    },
    unloadChildren() {
      for (const child of children.splice(0)) child.unload();
    },
  };
}

/** Пункт меню: setTitle/setIcon/onClick как у Obsidian; click() - вызвать обработчик из теста. */
export class MenuItem {
  title = "";
  icon = "";
  private handler: ((evt?: unknown) => unknown) | null = null;
  setTitle(title: string): this {
    this.title = title;
    return this;
  }
  setIcon(icon: string): this {
    this.icon = icon;
    return this;
  }
  onClick(handler: (evt?: unknown) => unknown): this {
    this.handler = handler;
    return this;
  }
  click(): unknown {
    return this.handler?.();
  }
}

/** Меню: собирает пункты; showAtMouseEvent запоминает последнее показанное меню в Menu.last. */
export class Menu {
  static last: Menu | null = null;
  items: MenuItem[] = [];
  addItem(cb: (item: MenuItem) => void): this {
    const item = new MenuItem();
    cb(item);
    this.items.push(item);
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(_evt: MouseEvent): this {
    Menu.last = this;
    return this;
  }
  showAtPosition(_pos: { x: number; y: number }): this {
    Menu.last = this;
    return this;
  }
  hide(): this {
    return this;
  }
}

export const MarkdownRenderer = {};

/** Вид в сайдбаре: containerEl с contentEl внутри, как у Obsidian (app - из листа). */
export class ItemView extends Component {
  app: any;
  leaf: any;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  navigation = true;
  icon = "";
  constructor(leaf: any) {
    super();
    this.leaf = leaf;
    this.app = leaf?.app;
    const doc = (globalThis as { document?: Document }).document;
    this.containerEl = doc ? doc.createElement("div") : ({} as HTMLElement);
    this.contentEl = doc ? (this.containerEl.appendChild(doc.createElement("div")) as HTMLElement) : ({} as HTMLElement);
  }
  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  getIcon(): string {
    return this.icon;
  }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

/** Платформа: в тестах - десктоп (не Mac). */
export const Platform = { isMobile: false, isDesktop: true, isDesktopApp: true, isMacOS: false };

/** Иконка: в тестах только помечаем элемент. */
export function setIcon(el: HTMLElement, icon: string): void {
  if (el && typeof el.setAttribute === "function") el.setAttribute("data-icon", icon);
}

/** Версия API Obsidian: в тестах - любая нужная. */
export function requireApiVersion(_version: string): boolean {
  return true;
}

/** Подсказка при наведении: в тестах только помечаем элемент. */
export function setTooltip(el: HTMLElement, tooltip: string): void {
  if (el && typeof el.setAttribute === "function") el.setAttribute("data-tooltip", tooltip);
}

/** Ctrl/Cmd+клик - открыть в новой вкладке. */
export class Keymap {
  static isModEvent(evt?: { ctrlKey?: boolean; metaKey?: boolean } | null): "tab" | false {
    return evt && (evt.ctrlKey || evt.metaKey) ? "tab" : false;
  }
}

export function htmlToMarkdown(value: string): string {
  return value;
}

export class MarkdownView {
  file: TFile | null = null;
  constructor(public containerEl: { contains(node: unknown): boolean }) {}
  /** Как в Obsidian: открыть панель поиска текущего режима (в заглушке - ничего). */
  showSearch(_replace?: boolean): void {}
}

export type App = any;

export function createMockApp(initialFiles: Record<string, string> = {}) {
  const vault = new MockEvents() as MockEvents & Record<string, any>;
  const metadataCache = new MockEvents() as MockEvents & Record<string, any>;
  const files = new Map<string, TFile>();
  const contents = new Map<string, string>();
  const caches = new Map<string, any>();
  const destinations = new Map<string, TFile>();
  const frontmatters = new Map<string, Record<string, unknown>>();
  const layoutCallbacks: Array<() => void> = [];

  for (const [path, content] of Object.entries(initialFiles)) {
    files.set(path, new TFile(path));
    contents.set(path, content);
  }

  vault.getMarkdownFiles = () => [...files.values()].filter((file) => file.extension === "md");
  vault.getAbstractFileByPath = (path: string) => files.get(path) ?? null;
  vault.read = async (file: TFile) => contents.get(file.path) ?? "";
  vault.cachedRead = vault.read;
  vault.modify = async (file: TFile, content: string) => {
    contents.set(file.path, content);
  };
  vault.append = async (file: TFile, text: string) => {
    contents.set(file.path, (contents.get(file.path) ?? "") + text);
  };
  vault.process = async (file: TFile, processor: (content: string) => string) => {
    const next = processor(contents.get(file.path) ?? "");
    contents.set(file.path, next);
    return next;
  };

  metadataCache.initialized = true;
  metadataCache.getFileCache = (file: TFile) => caches.get(file.path) ?? null;
  metadataCache.getFirstLinkpathDest = (link: string) => destinations.get(link) ?? null;

  const workspace = {
    layoutReady: true,
    onLayoutReady(callback: () => void) {
      if (this.layoutReady) callback();
      else layoutCallbacks.push(callback);
    },
    markLayoutReady() {
      this.layoutReady = true;
      for (const callback of layoutCallbacks.splice(0)) callback();
    },
    getActiveViewOfType: () => null,
  };

  const app = {
    vault,
    metadataCache,
    workspace,
    fileManager: {
      async processFrontMatter(file: TFile, updater: (value: Record<string, unknown>) => void) {
        const value = frontmatters.get(file.path) ?? {};
        updater(value);
        frontmatters.set(file.path, value);
      },
    },
  };

  return {
    app,
    vault,
    metadataCache,
    workspace,
    files,
    contents,
    caches,
    destinations,
    frontmatters,
    addFile(path: string, content = "", mtime = Date.now()) {
      const file = new TFile(path, mtime);
      files.set(path, file);
      contents.set(path, content);
      return file;
    },
  };
}
