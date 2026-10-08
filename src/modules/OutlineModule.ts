/**
 * Панель «Структура»: регистрация вида, команда открытия и однократная установка панели
 * рядом со стандартным Outline.
 */

import { Platform, type App, type WorkspaceLeaf, type WorkspaceSplit } from "obsidian";
import type { PluginSettings } from "../main";
import type { ModuleContext, PluginModule } from "./types";
import { OUTLINE_VIEW_TYPE, TaskOutlineView, isSidebarLeaf } from "../ui/TaskOutlineView";
import { UI_LABELS } from "../ui/Labels";

/** Блоки плагина с заголовком и настройка, при которой блок виден (выключенный модуль блок скрывает). */
const BLOCK_TITLES: Record<string, { title: string; enabled: (settings: PluginSettings) => boolean }> = {
  "opa-reminders-view": { title: UI_LABELS.blockTitles.reminders, enabled: (s) => s.enableReminders },
  "opa-projects-view": { title: UI_LABELS.blockTitles.projects, enabled: (s) => s.enableTasksDashboard },
  "opa-home-view": { title: UI_LABELS.blockTitles.tasksDashboard, enabled: (s) => s.enableTasksDashboard },
  "opa-inbox-view": { title: UI_LABELS.blockTitles.inbox, enabled: (s) => s.enableInbox },
  "opa-trash-view": { title: UI_LABELS.blockTitles.trash, enabled: (s) => s.enableTrash },
  "opa-activities-view": { title: UI_LABELS.blockTitles.activities, enabled: (s) => s.enableActivities },
  "opa-gamification-view": { title: UI_LABELS.blockTitles.gamification, enabled: (s) => s.enableGamification },
};

/** Заголовок блока плагина по языку блока кода; null - у блока нет заголовка или модуль выключен. */
export function pluginBlockTitle(language: string, settings: PluginSettings | undefined): string | null {
  const entry = Object.prototype.hasOwnProperty.call(BLOCK_TITLES, language) ? BLOCK_TITLES[language] : undefined;
  if (!entry) return null;
  return !settings || entry.enabled(settings) ? entry.title : null;
}

/** Флаг в localStorage хранилища: панель уже ставилась автоматически (дальше - как её расположит пользователь). */
const AUTO_OPEN_KEY = "opa-outline-auto-opened";

export class OutlineModule implements PluginModule {
  constructor(private readonly ctx: ModuleContext) {}

  load(): void {
    const { plugin, app, eventBus } = this.ctx;
    plugin.registerView(
      OUTLINE_VIEW_TYPE,
      (leaf) =>
        new TaskOutlineView(leaf, {
          getTocItems: (taskPath) =>
            plugin.taskView?.getTocItems(taskPath) ?? Promise.resolve({ items: [], stale: false }),
          onIndexUpdated: (callback) => eventBus.on("index:updated", callback),
          getBlockTitle: (language) => pluginBlockTitle(language, plugin.settings),
        })
    );
    plugin.addCommand({
      id: "open-outline-view",
      name: UI_LABELS.outline.openCommand,
      callback: () => {
        void this.openView();
      },
    });
    app.workspace.onLayoutReady(() => {
      void this.autoOpenOnce().catch((error) => console.error("[OPA] Failed to open the outline panel:", error));
    });
  }

  unload(): void {
    // Вкладки панели не закрываем: Obsidian сохранит их место в раскладке и восстановит при следующей загрузке.
  }

  /** Смена настроек: включённые/выключенные модули меняют набор заголовков блоков. */
  updateState(): void {
    for (const leaf of this.ctx.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)) {
      if (leaf.view instanceof TaskOutlineView) leaf.view.refresh();
    }
  }

  /**
   * Показать панель: существующую - вывести на передний план, иначе создать рядом со стандартным Outline.
   * quiet - установка при запуске: заметка остаётся активной, свёрнутый сайдбар не разворачивается,
   * на телефоне выдвижная панель не открывается.
   */
  async openView(options: { quiet?: boolean } = {}): Promise<void> {
    const { workspace } = this.ctx.app;
    const existing = workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)[0];
    if (existing) {
      await workspace.revealLeaf(existing);
      return;
    }
    const previous = workspace.getMostRecentLeaf();
    const leaf = this.createLeafNextToCoreOutline() ?? workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: OUTLINE_VIEW_TYPE, active: false });
    if (options.quiet) {
      // Новая вкладка стала активной (так работает createLeafInParent) - возвращаем активность заметке
      if (previous) workspace.setActiveLeaf(previous, { focus: false });
      if (Platform.isMobile || isCollapsedSidedock(leaf)) return;
    }
    await workspace.revealLeaf(leaf);
  }

  /** Новая вкладка в той же группе, что и стандартный Outline в сайдбаре, сразу после него. */
  private createLeafNextToCoreOutline(): WorkspaceLeaf | null {
    const { workspace } = this.ctx.app;
    // Outline может быть открыт и в основной области (связанная панель) - туда панель не ставим
    const outline = workspace.getLeavesOfType("outline").find((leaf) => isSidebarLeaf(workspace, leaf));
    if (!outline?.parent) return null;
    try {
      const parent = outline.parent as unknown as WorkspaceSplit & { children?: unknown[] };
      const index = Array.isArray(parent.children) ? parent.children.indexOf(outline) + 1 : 0;
      return workspace.createLeafInParent(parent, Math.max(0, index));
    } catch (error) {
      console.warn("[OPA] Could not place the outline panel next to the core Outline:", error);
      return null;
    }
  }

  /** Один раз на хранилище поставить панель рядом со стандартным Outline и показать её. */
  private async autoOpenOnce(): Promise<void> {
    const { app } = this.ctx;
    if (readAutoOpened(app)) return;
    saveAutoOpened(app);
    if (app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE).length > 0) return;
    await this.openView({ quiet: true });
  }
}

/** Вкладка в свёрнутом сайдбаре. */
function isCollapsedSidedock(leaf: WorkspaceLeaf): boolean {
  try {
    return (leaf.getRoot() as { collapsed?: boolean }).collapsed === true;
  } catch {
    return false;
  }
}

function readAutoOpened(app: App): boolean {
  try {
    return typeof app.loadLocalStorage === "function" && Boolean(app.loadLocalStorage(AUTO_OPEN_KEY));
  } catch {
    return false;
  }
}

function saveAutoOpened(app: App): void {
  try {
    if (typeof app.saveLocalStorage === "function") app.saveLocalStorage(AUTO_OPEN_KEY, "1");
  } catch {
    // без localStorage панель просто будет ставиться при каждой загрузке, если её закрыли
  }
}
