import { Component, Notice } from "obsidian";
import type { ModuleContext, PluginModule } from "./types";
import { Paths } from "../core/Paths";
import { read } from "../core/FileIO";
import { formatDateKey } from "../core/DateUtils";
import type { TrashEntryMeta } from "../core/InboxEntries";
import {
  readDataFile,
  writeDataFile,
  isInboxArchiveTrashEntry,
  isReminderTrashEntry,
  getTrashDisplayText,
  getTrashEntryMarkdown,
} from "../core/GamificationState";
import { UI_LABELS } from "../ui/Labels";
import { createCollapsibleSection } from "../ui/CollapsibleSection";
import { BlockRegistry } from "../ui/BlockRegistry";
import { isRenderUnchanged, markRendered, renderSignature } from "../ui/RenderCache";
import { ENTRY_TEXT_CLASS, isInsideRenderedEntry, openInternalLink, renderEntryMarkdown } from "../ui/EntryMarkdown";
import { renderInboxMeta } from "../ui/InboxMeta";
import { describeInboxLink, type InboxLinkView } from "./InboxLinkSources";

export class TrashModule implements PluginModule {
  private ctx: ModuleContext;
  private registry: BlockRegistry;
  private rendering = new Set<HTMLElement>();
  private pendingRender = new Set<HTMLElement>();
  /** Заметка, в которой стоит блок: от неё разрешаются ссылки и картинки записей. */
  private sourcePaths = new WeakMap<HTMLElement, string>();
  /** Компонент markdown-рендера текущей отрисовки блока (выгружается при следующей отрисовке и удалении блока). */
  private components = new WeakMap<HTMLElement, Component>();

  private getDataPath(): string {
    return this.ctx.plugin.getGamificationDataPath();
  }

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.registry = new BlockRegistry({
      app: ctx.app,
      isEnabled: () => ctx.plugin.settings.enableTrash,
      domSelector: ".opa-trash-view",
      createRefresh: (el) => (force) => this.render(el, force),
      onPrune: (el) => this.releaseComponent(el),
    });
  }

  load(): void {
    const { plugin, app } = this.ctx;
    plugin.registerEvent(app.vault.on("modify", this.onChange));
    plugin.registerEvent(app.workspace.on("active-leaf-change", this.registry.scheduleRefresh));

    plugin.registerMarkdownCodeBlockProcessor("opa-trash-view", (_source, el, ctx) => {
      // Корзина внутри записи блокнота (код или ![[Homepage]] в тексте записи) рисовала бы сама себя без конца.
      if (isInsideRenderedEntry(el)) {
        el.setText(UI_LABELS.trash.nested);
        return;
      }
      el.addClass("opa-trash-view");
      if (ctx?.sourcePath) this.sourcePaths.set(el, ctx.sourcePath);
      this.registry.register(el, (force) => this.render(el, force), ctx);
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

  private releaseComponent(el: HTMLElement): void {
    this.components.get(el)?.unload();
    this.components.delete(el);
  }

  private async render(container: HTMLElement, force = true): Promise<void> {
    if (this.rendering.has(container)) {
      this.pendingRender.add(container);
      return;
    }
    this.rendering.add(container);

    if (!this.ctx.plugin.settings.enableTrash) {
      this.releaseComponent(container);
      container.empty();
      container.addClass("opa-hidden");
      this.rendering.delete(container);
      return;
    }
    container.removeClass("opa-hidden");

    let component: Component | null = null;
    try {
      let items: string[] = [];
      /** Записи блокнота: когда сделаны и к чему относились (строка корзины → сведения). */
      let meta: Record<string, TrashEntryMeta> = {};
      try {
        const data = await readDataFile(this.ctx.plugin);
        items = (data.trash ?? []).filter((l): l is string => typeof l === "string" && l.trim().length > 0);
        meta = data.trashMeta ?? {};
      } catch {
        const content = await read(this.ctx.app, Paths.TRASH_FILE);
        if (content) {
          const rawLines = content.split("\n").filter((l) => l.trim().length > 0);
          items = rawLines.filter((l) => !l.trim().startsWith("# "));
        }
      }

      // Подписи привязок зависят от заметок задач, «сегодня / вчера» - от даты: они тоже в подписи блока.
      const views: Record<string, InboxLinkView> = {};
      for (const line of items) {
        const view = describeInboxLink(this.ctx.app, meta[line]?.link);
        if (view) views[line] = view;
      }
      const signature = renderSignature("trash", items, meta, views, formatDateKey(new Date()));
      if (!force && isRenderUnchanged(container, signature)) return;
      const L = UI_LABELS.trash;
      if (isInsideRenderedEntry(container)) {
        container.empty();
        container.setText(L.nested);
        return;
      }

      // Блок собирается вне документа и подменяется за один раз: markdown записей рисуется асинхронно.
      const sourcePath = this.sourcePaths.get(container) ?? Paths.HOMEPAGE_FILE;
      const temp = container.ownerDocument.createElement("div");
      const body = createCollapsibleSection(temp, UI_LABELS.blockTitles.trash, "trash");
      component = new Component();
      component.load();
      const renderComponent = component;
      body.addEventListener("click", (ev) => openInternalLink(this.ctx.app, ev, sourcePath));

      const toolbar = body.createEl("div", { cls: "trash-toolbar" });
      const clearBtn = toolbar.createEl("button", { text: L.clear, cls: "trash-clear-button view-btn" });
      clearBtn.addEventListener("click", async () => {
        if (items.length === 0) {
          new Notice(L.alreadyEmpty);
          this.registry.runRefresh();
          return;
        }
        await writeDataFile(this.ctx.plugin, { trash: [], trashMeta: {} });
        new Notice(L.cleared);
        this.registry.runRefresh();
      });

      const renders: Promise<void>[] = [];
      const now = new Date();
      if (items.length === 0) {
        body.createEl("div", { text: L.empty, cls: "trash-empty" });
      } else {
        items.forEach((line) => {
          const fromArchive = isInboxArchiveTrashEntry(line);
          const itemEl = body.createEl("div", { cls: "trash-item" });
          if (isReminderTrashEntry(line)) {
            // Удалённое напоминание - простой строкой, как раньше: его текст не markdown.
            itemEl.createEl("span", { cls: "trash-item-text", text: getTrashDisplayText(line) });
          } else {
            // Запись блокнота (удалённая или разобранная) - как в блокноте: с картинками и ссылками, под ней -
            // когда сделана и к чему относилась (у записей, удалённых до этой версии, этого нет).
            const entryEl = itemEl.createEl("div", { cls: "trash-item-entry" });
            const textEl = entryEl.createEl("div", { cls: `trash-item-text ${ENTRY_TEXT_CLASS} markdown-rendered` });
            renders.push(renderEntryMarkdown(this.ctx.app, getTrashEntryMarkdown(line), textEl, sourcePath, renderComponent));
            renderInboxMeta(entryEl, { createdAt: meta[line]?.createdAt, view: views[line] ?? null, now });
          }
          if (fromArchive) {
            itemEl.createEl("span", { cls: "trash-item-badge trash-item-badge-completed", text: L.completedBadge });
          }
        });
      }

      await Promise.all(renders);
      container.empty();
      while (temp.firstChild) container.appendChild(temp.firstChild);
      this.releaseComponent(container);
      this.components.set(container, component);
      component = null;
      markRendered(container, signature);
    } catch (e) {
      component?.unload();
      container.empty();
      container.createEl("p", { text: UI_LABELS.errors.renderShort, cls: "view-error" });
      console.error(e);
    } finally {
      this.rendering.delete(container);
      if (this.pendingRender.delete(container) && container.isConnected) {
        void this.render(container);
      }
    }
  }
}
