import type { ModuleContext } from "./types";
import { Paths } from "../core/Paths";
import { read } from "../core/FileIO";
import { readDataFile, writeDataFile, isInboxArchiveTrashEntry, getTrashDisplayText } from "../core/GamificationState";
import { UI_LABELS } from "../ui/Labels";
import { createCollapsibleSection } from "../ui/CollapsibleSection";
import { Notice } from "obsidian";

export class TrashModule {
  private ctx: ModuleContext;
  private blocks = new Set<{ el: HTMLElement; refresh: () => void }>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private rendering = new Set<HTMLElement>();

  private getDataPath(): string {
    return this.ctx.plugin.getGamificationDataPath();
  }

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
  }

  load(): void {
    this.ctx.app.metadataCache.on("changed", this.onChange);
    this.ctx.app.vault.on("modify", this.onChange);
    this.ctx.app.workspace.on("active-leaf-change", this.onLeafChange);

    this.ctx.plugin.registerMarkdownCodeBlockProcessor("opa-trash-view", (_source, el) => {
      el.addClass("opa-trash-view");
      this.blocks.forEach((b) => { if (b.el === el) this.blocks.delete(b); });
      const refresh = () => this.render(el);
      this.blocks.add({ el, refresh });
      this.render(el);
    });
  }

  /** Есть ли хотя бы один блок корзины в активной вкладке. */
  private isAnyBlockVisible(): boolean {
    const container = this.ctx.app.workspace.activeLeaf?.view?.containerEl;
    if (!container) return false;
    for (const b of this.blocks) {
      if (b.el.isConnected && container.contains(b.el)) return true;
    }
    return false;
  }

  /** Обновить все открытые блоки (в т.ч. на фоновых вкладках). */
  private runRefresh(): void {
    this.blocks.forEach((b) => {
      if (b.el.isConnected) b.refresh();
    });

    if (this.blocks.size > 30) {
      const stale = Array.from(this.blocks).filter((b) => !b.el.isConnected);
      for (let i = 0; i < stale.length - 10; i++) {
        this.blocks.delete(stale[i]);
      }
    }
  }

  private onLeafChange = (): void => {
    if (!this.ctx.plugin.settings.enableTrash) return;
    if (!this.isAnyBlockVisible()) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.isAnyBlockVisible()) return;
      this.runRefresh();
    }, 300);
  };

  private onChange = (...data: unknown[]): void => {
    if (!this.ctx.plugin.settings.enableTrash) return;
    const _file = data[0] as { path?: string } | undefined;
    if (_file?.path && _file.path !== this.getDataPath()) return;
    if (!this.isAnyBlockVisible()) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.isAnyBlockVisible()) return;
      this.runRefresh();
    }, 300);
  };

  /** Принудительное обновление блоков корзины (вызов после добавления в Trash из других модулей). */
  forceRefresh(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.runRefresh();
  }

  unload(): void {
    this.ctx.app.metadataCache.off("changed", this.onChange as (...data: unknown[]) => unknown);
    this.ctx.app.vault.off("modify", this.onChange as (...data: unknown[]) => unknown);
    this.ctx.app.workspace.off("active-leaf-change", this.onLeafChange);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.blocks.clear();
  }

  updateState(): void {
    this.runRefresh();
  }

  private async render(container: HTMLElement): Promise<void> {
    if (this.rendering.has(container)) return;
    this.rendering.add(container);

    if (!this.ctx.plugin.settings.enableTrash) {
      container.empty();
      container.style.display = "none";
      this.rendering.delete(container);
      return;
    }
    container.style.display = "";

    const scrollableParent = container.closest(".cm-scroller, .markdown-reading-view, .markdown-preview-view") as HTMLElement | null;
    const scrollTop = scrollableParent?.scrollTop ?? 0;

    try {
      let items: string[] = [];
      const dataPath = this.getDataPath();
      try {
        const data = await readDataFile(this.ctx.plugin);
        items = (data.trash ?? []).filter((l): l is string => typeof l === "string" && l.trim().length > 0);
      } catch {
        const content = await read(this.ctx.app, Paths.TRASH_FILE);
        if (content) {
          const rawLines = content.split("\n").filter((l) => l.trim().length > 0);
          items = rawLines.filter((l) => !l.trim().startsWith("# "));
        }
      }

      container.empty();
      const body = createCollapsibleSection(container, "Корзина", "trash");
      const L = UI_LABELS.trash;

      const toolbar = body.createEl("div", { cls: "trash-toolbar" });
      const clearBtn = toolbar.createEl("button", { text: L.clear, cls: "trash-clear-button view-btn" });
      clearBtn.addEventListener("click", async () => {
        if (items.length === 0) {
          new Notice(L.alreadyEmpty);
          this.runRefresh();
          return;
        }
        const data = await readDataFile(this.ctx.plugin);
        await writeDataFile(this.ctx.plugin, {
          gamification: data.gamification,
          projects: data.projects ?? [],
          reminders: data.reminders ?? [],
          inbox: data.inbox ?? [],
          trash: [],
        });
        new Notice(L.cleared);
        this.runRefresh();
      });

      if (items.length === 0) {
        body.createEl("div", { text: L.empty, cls: "trash-empty" });
      } else {
        items.forEach((line) => {
          const displayText = getTrashDisplayText(line);
          const fromArchive = isInboxArchiveTrashEntry(line);
          const itemEl = body.createEl("div", { cls: "trash-item" });
          itemEl.createEl("span", { cls: "trash-item-text", text: displayText });
          if (fromArchive) {
            itemEl.createEl("span", { cls: "trash-item-badge trash-item-badge-completed", text: L.completedBadge });
          }
        });
      }

      if (scrollableParent?.isConnected) {
        scrollableParent.scrollTop = scrollTop;
        setTimeout(() => {
          if (scrollableParent.isConnected) scrollableParent.scrollTop = scrollTop;
        }, 0);
      }
    } catch (e) {
      container.empty();
      container.createEl("p", { text: UI_LABELS.errors.renderShort, cls: "view-error" });
      console.error(e);
    } finally {
      this.rendering.delete(container);
    }
  }
}
