/**
 * Общий реестр блоков кода (code block processors) модуля.
 * Держит список отрисованных блоков, чистит удалённые Obsidian'ом,
 * планирует обновления с debounce.
 *
 * Жизненный цикл блока: если processor передал ctx (MarkdownPostProcessorContext),
 * блок снимается с учёта по onunload дочернего MarkdownRenderChild - т.е. ровно тогда,
 * когда Obsidian уничтожает секцию. Проверка `isConnected` для таких блоков не используется:
 * Obsidian временно отсоединяет от DOM секции, ушедшие за пределы экрана, и блок,
 * удалённый по `isConnected`, «зависал» без обновлений и без обработчиков копирования.
 */

import { MarkdownRenderChild, MarkdownView, type App, type MarkdownPostProcessorContext } from "obsidian";

/**
 * Функция перерисовки блока.
 * force=true - явное обновление (первичная отрисовка, собственные мутации данных, смена настроек);
 * false - фоновое (по событиям хранилища/вкладок): модуль вправе пропустить перерисовку,
 * если данные блока не изменились.
 */
export type BlockRefresh = (force: boolean) => void | Promise<void>;

interface BlockEntry {
  el: HTMLElement;
  refresh: BlockRefresh;
  /** Снимается с учёта по onunload MarkdownRenderChild (а не по isConnected). */
  managed: boolean;
}

export interface BlockRegistryOptions {
  app: App;
  /** Модуль включён в настройках (выключенный не обновляется по событиям). */
  isEnabled: () => boolean;
  /** Задержка debounce для scheduleRefresh (мс). */
  debounceMs?: number;
  /**
   * Можно ли сейчас обновлять этот блок (false - например, идёт редактирование или выделен текст).
   * force - признак цикла (см. BlockRefresh): модуль может запомнить его, чтобы повторить отложенное обновление.
   */
  shouldRefresh?: (el: HTMLElement, force: boolean) => boolean;
  /** Очистка ресурсов блока при удалении из реестра (компоненты, слушатели). */
  onPrune?: (el: HTMLElement) => void;
  /** Вызывается один раз перед обновлением всех блоков (например, общий кэш данных). */
  beforeRefresh?: () => void | Promise<void>;
  /**
   * CSS-селектор блоков модуля в DOM. Страховка: если блок выпал из реестра, но остался
   * в DOM (зарегистрирован без ctx и был отсоединён/присоединён обратно), селектор
   * позволяет вернуть его в реестр.
   */
  domSelector?: string;
  /** Фабрика refresh для блоков, найденных по domSelector. */
  createRefresh?: (el: HTMLElement) => BlockRefresh;
}

const DEFAULT_DEBOUNCE_MS = 300;

/** Дочерний компонент секции Obsidian: его onunload - момент реального удаления блока. */
class BlockLifecycle extends MarkdownRenderChild {
  constructor(containerEl: HTMLElement, private readonly onRemoved: () => void) {
    super(containerEl);
  }

  onunload(): void {
    this.onRemoved();
  }
}

/** Минимальный контракт контекста процессора, нужный реестру. */
export type BlockProcessorContext = Pick<MarkdownPostProcessorContext, "addChild"> | null | undefined;

export class BlockRegistry {
  private blocks = new Set<BlockEntry>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private pending = false;
  private pendingForce = false;
  private generation = 0;
  /** После clear() (модуль выгружен) реестр не подбирает блоки из DOM и не планирует обновления. */
  private cleared = false;

  constructor(private options: BlockRegistryOptions) {}

  /**
   * Зарегистрировать блок и сразу отрисовать. Вызывать из code block processor.
   * ctx - контекст процессора: через него блок привязывается к жизненному циклу секции Obsidian.
   */
  register(el: HTMLElement, refresh: BlockRefresh, ctx?: BlockProcessorContext): void {
    this.cleared = false;
    this.prune();
    for (const b of this.blocks) {
      if (b.el === el) this.blocks.delete(b);
    }
    let managed = false;
    if (ctx && typeof ctx.addChild === "function") {
      try {
        ctx.addChild(new BlockLifecycle(el, () => this.unregister(el)));
        managed = true;
      } catch (error) {
        console.error("[BlockRegistry] addChild failed, falling back to isConnected tracking:", error);
      }
    }
    this.blocks.add({ el, refresh, managed });
    this.runInitialRefresh(refresh);
  }

  /** Снять блок с учёта и освободить его ресурсы (Obsidian уничтожил секцию). */
  unregister(el: HTMLElement): void {
    for (const b of this.blocks) {
      if (b.el === el) {
        this.blocks.delete(b);
        this.options.onPrune?.(el);
      }
    }
  }

  /** Первичная отрисовка только нового блока, без обновления уже открытых вкладок. */
  private runInitialRefresh(refresh: BlockRefresh): void {
    if (this.running) {
      // Новый блок отрисуется в следующем цикле (у него ещё нет подписи данных - пропуска не будет);
      // остальные блоки при этом перерисовывать принудительно не нужно.
      this.pending = true;
      return;
    }
    const generation = this.generation;
    this.running = (async () => {
      try {
        await refresh(true);
      } catch (error) {
        console.error("[BlockRegistry] refresh failed:", error);
      }
      while (this.pending && generation === this.generation) {
        this.pending = false;
        const force = this.pendingForce;
        this.pendingForce = false;
        await this.runOneCycle(generation, force);
      }
    })().finally(() => {
      this.running = null;
    });
  }

  /** Есть ли хотя бы один блок в активной вкладке. */
  isAnyBlockVisible(): boolean {
    const container = this.options.app.workspace.getActiveViewOfType(MarkdownView)?.containerEl;
    if (!container) return false;
    for (const b of this.blocks) {
      if (b.el.isConnected && container.contains(b.el)) return true;
    }
    return false;
  }

  /** Есть ли блок с этим элементом в реестре. */
  hasBlock(el: HTMLElement): boolean {
    for (const b of this.blocks) {
      if (b.el === el) return true;
    }
    return false;
  }

  /** Есть ли живые блоки: подключённые к DOM или временно отсоединённые Obsidian'ом (managed). */
  hasConnectedBlocks(): boolean {
    for (const b of this.blocks) {
      if (b.managed || b.el.isConnected) return true;
    }
    return false;
  }

  /** Обновить все живые блоки (в т.ч. на фоновых вкладках) и удалить мёртвые. */
  runRefresh(): void {
    void this.runRefreshAsync().catch((error) => console.error("[BlockRegistry] refresh cycle failed:", error));
  }

  /** Вернуть в реестр живые блоки из DOM, потерянные при detach вкладки. */
  private adoptLostBlocks(): void {
    const { domSelector, createRefresh } = this.options;
    if (this.cleared || !domSelector || !createRefresh) return;
    document.querySelectorAll(domSelector).forEach((node) => {
      if (!(node instanceof HTMLElement) || !node.isConnected) return;
      if (this.hasBlock(node)) return;
      this.blocks.add({ el: node, refresh: createRefresh(node), managed: false });
    });
  }

  private async runOneCycle(generation: number, force: boolean): Promise<void> {
    this.adoptLostBlocks();
    this.prune();
    if (generation !== this.generation) return;
    if (this.options.beforeRefresh) {
      try {
        await this.options.beforeRefresh();
      } catch (error) {
        console.error("[BlockRegistry] beforeRefresh failed:", error);
        return;
      }
    }
    if (generation !== this.generation) return;
    const promises: Promise<void>[] = [];
    this.blocks.forEach((b) => {
      if (this.options.shouldRefresh && !this.options.shouldRefresh(b.el, force)) return;
      promises.push(
        Promise.resolve()
          .then(() => b.refresh(force))
          .catch((error) => console.error("[BlockRegistry] refresh failed:", error))
      );
    });
    if (promises.length) await Promise.all(promises);
  }

  /**
   * То же, что runRefresh, но сериализует циклы и не теряет запросы во время render.
   * force=false - фоновое обновление: модули пропускают перерисовку неизменившихся блоков.
   */
  runRefreshAsync(force = true): Promise<void> {
    if (this.running) {
      this.pending = true;
      this.pendingForce = this.pendingForce || force;
      return this.running;
    }

    const generation = this.generation;
    this.pendingForce = this.pendingForce || force;
    this.running = (async () => {
      do {
        this.pending = false;
        const cycleForce = this.pendingForce;
        this.pendingForce = false;
        await this.runOneCycle(generation, cycleForce);
      } while (this.pending && generation === this.generation);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Найти и обновить конкретный блок (явное обновление). */
  refreshBlock(el: HTMLElement): void {
    for (const b of this.blocks) {
      if (b.el === el) {
        void Promise.resolve()
          .then(() => b.refresh(true))
          .catch((error) => console.error("[BlockRegistry] refresh failed:", error));
        return;
      }
    }
  }

  /**
   * Отложенное фоновое обновление: если есть живые блоки (и на фоновых вкладках тоже).
   * Блоки с неизменившимися данными модули не перерисовывают.
   */
  scheduleRefresh = (): void => {
    if (this.cleared || !this.options.isEnabled()) return;
    this.adoptLostBlocks();
    if (!this.hasConnectedBlocks()) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runRefreshAsync(false).catch((error) =>
        console.error("[BlockRegistry] refresh cycle failed:", error)
      );
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  };

  /** Немедленное обновление (после собственных мутаций данных). */
  forceRefresh(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.runRefresh();
  }

  /** Немедленное обновление с ожиданием async-рендеров. */
  async forceRefreshAsync(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.runRefreshAsync(true);
  }

  /** Очистка при выгрузке модуля. */
  clear(): void {
    this.cleared = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.generation++;
    this.pending = false;
    this.pendingForce = false;
    for (const b of this.blocks) {
      this.options.onPrune?.(b.el);
    }
    this.blocks.clear();
  }

  /** Удалить блоки без привязки к жизненному циклу секции, отсоединённые от DOM. */
  private prune(): void {
    for (const b of this.blocks) {
      if (!b.managed && !b.el.isConnected) {
        this.options.onPrune?.(b.el);
        this.blocks.delete(b);
      }
    }
  }
}
