import type { ModuleContext } from "./types";
import { Paths } from "../core/Paths";
import { read } from "../core/FileIO";
import { readDataFile, writeDataFile, isInboxArchiveTrashEntry, getTrashDisplayText } from "../core/GamificationState";
import { UI_LABELS } from "../ui/Labels";
import { createCollapsibleSection } from "../ui/CollapsibleSection";
import { BlockRegistry } from "../ui/BlockRegistry";
import { Notice } from "obsidian";

export class TrashModule {
  private ctx: ModuleContext;
  private registry: BlockRegistry;
  private rendering = new Set<HTMLElement>();

  private getDataPath(): string {
    return this.ctx.plugin.getGamificationDataPath();
  }

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.registry = new BlockRegistry({
      app: ctx.app,
      isEnabled: () => ctx.plugin.settings.enableTrash,
      domSelector: ".opa-trash-view",
      createRefresh: (el) => () => this.render(el),
    });
  }

  load(): void {
    const { plugin, app } = this.ctx;
    plugin.registerEvent(app.vault.on("modify", this.onChange));
    plugin.registerEvent(app.workspace.on("active-leaf-change", this.registry.scheduleRefresh));

    plugin.registerMarkdownCodeBlockProcessor("opa-trash-view", (_source, el) => {
      el.addClass("opa-trash-view");
      this.registry.register(el, () => this.render(el));
    });
  }

  private onChange = (file: { path?: string }): void => {
    if (file?.path && file.path !== this.getDataPath()) return;
    this.registry.scheduleRefresh();
  };

  /** Принудительное обновление блоков корзины (вызов после добавления в Trash из других модулей). */
  forceRefresh(): void {
    this.registry.forceRefresh();
  }

  unload(): void {
    this.registry.clear();
  }

  updateState(): void {
    this.registry.runRefresh();
  }

  private async render(container: HTMLElement): Promise<void> {
    if (this.rendering.has(container)) return;
    this.rendering.add(container);

    if (!this.ctx.plugin.settings.enableTrash) {
      container.empty();
      container.addClass("opa-hidden");
      this.rendering.delete(container);
      return;
    }
    container.removeClass("opa-hidden");

    try {
      let items: string[] = [];
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
          this.registry.runRefresh();
          return;
        }
        await writeDataFile(this.ctx.plugin, { trash: [] });
        new Notice(L.cleared);
        this.registry.runRefresh();
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

    } catch (e) {
      container.empty();
      container.createEl("p", { text: UI_LABELS.errors.renderShort, cls: "view-error" });
      console.error(e);
    } finally {
      this.rendering.delete(container);
    }
  }
}
