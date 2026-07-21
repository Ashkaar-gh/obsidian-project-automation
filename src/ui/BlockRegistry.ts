/**
 * Общий реестр блоков кода (code block processors) модуля.
 * Держит список отрисованных блоков, чистит отсоединённые от DOM
 * (иначе detached-деревья с обработчиками копятся и Obsidian со временем виснет),
 * планирует обновления с debounce.
 */

import type { App } from "obsidian";
import { MarkdownView } from "obsidian";

interface BlockEntry {
  el: HTMLElement;
  refresh: () => void | Promise<void>;
}

export interface BlockRegistryOptions {
  app: App;
  /** Модуль включён в настройках (выключенный не обновляется по событиям). */
  isEnabled: () => boolean;
  /** Задержка debounce для scheduleRefresh (мс). */
  debounceMs?: number;
  /** Можно ли сейчас обновлять этот блок (false — например, идёт редактирование). */
  shouldRefresh?: (el: HTMLElement) => boolean;
  /** Очистка ресурсов блока при удалении из реестра (компоненты, слушатели). */
  onPrune?: (el: HTMLElement) => void;
  /** Вызывается один раз перед обновлением всех блоков (например, общий кэш данных). */
  beforeRefresh?: () => void | Promise<void>;
  /**
   * CSS-селектор блоков модуля в DOM. Obsidian отсоединяет вкладки (detach/attach),
   * и блок мог быть удалён prune'ом, пока был отсоединён; при следующем attach
   * processor не перезапускается — блок «зависает». Селектор позволяет вернуть его в реестр.
   */
  domSelector?: string;
  /** Фабрика refresh для блоков, найденных по domSelector. */
  createRefresh?: (el: HTMLElement) => () => void | Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 300;

export class BlockRegistry {
  private blocks = new Set<BlockEntry>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private options: BlockRegistryOptions) {}

  /** Зарегистрировать блок и сразу отрисовать. Вызывать из code block processor. */
  register(el: HTMLElement, refresh: () => void | Promise<void>): void {
    this.prune();
    for (const b of this.blocks) {
      if (b.el === el) this.blocks.delete(b);
    }
    this.blocks.add({ el, refresh });
    void refresh();
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

  /** Есть ли живые (подключённые к DOM) блоки — в т.ч. на фоновых вкладках. */
  hasConnectedBlocks(): boolean {
    for (const b of this.blocks) {
      if (b.el.isConnected) return true;
    }
    return false;
  }

  /** Обновить все живые блоки (в т.ч. на фоновых вкладках) и удалить мёртвые. */
  runRefresh(): void {
    void this.runRefreshAsync();
  }

  /** Вернуть в реестр живые блоки из DOM, потерянные при detach вкладки. */
  private adoptLostBlocks(): void {
    const { domSelector, createRefresh } = this.options;
    if (!domSelector || !createRefresh) return;
    document.querySelectorAll(domSelector).forEach((node) => {
      if (!(node instanceof HTMLElement) || !node.isConnected) return;
      if (this.hasBlock(node)) return;
      this.blocks.add({ el: node, refresh: createRefresh(node) });
    });
  }

  /** То же, что runRefresh, но с ожиданием async-рендеров. */
  async runRefreshAsync(): Promise<void> {
    this.adoptLostBlocks();
    this.prune();
    if (this.options.beforeRefresh) {
      await this.options.beforeRefresh();
    }
    const promises: Promise<void>[] = [];
    this.blocks.forEach((b) => {
      if (this.options.shouldRefresh && !this.options.shouldRefresh(b.el)) return;
      const result = b.refresh();
      if (result && typeof (result as Promise<void>).then === "function") {
        promises.push(result as Promise<void>);
      }
    });
    if (promises.length) await Promise.all(promises);
  }

  /** Найти и обновить конкретный блок. */
  refreshBlock(el: HTMLElement): void {
    for (const b of this.blocks) {
      if (b.el === el) {
        void b.refresh();
        return;
      }
    }
  }

  /**
   * Отложенное обновление: если есть живые блоки (и на фоновых вкладках тоже).
   * Раньше требовалась активная вкладка — из‑за этого homepage не обновлялся
   * после смены даты напоминания (модалка/другой фокус).
   */
  scheduleRefresh = (): void => {
    if (!this.options.isEnabled()) return;
    if (!this.hasConnectedBlocks()) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.runRefresh();
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
    await this.runRefreshAsync();
  }

  /** Очистка при выгрузке модуля. */
  clear(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const b of this.blocks) {
      this.options.onPrune?.(b.el);
    }
    this.blocks.clear();
  }

  private prune(): void {
    for (const b of this.blocks) {
      if (!b.el.isConnected) {
        this.options.onPrune?.(b.el);
        this.blocks.delete(b);
      }
    }
  }
}
