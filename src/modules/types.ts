import type { App } from "obsidian";
import type { ObsidianProjectAutomationPlugin } from "../main";
import type { TaskIndex } from "../core/TaskIndex";
import type { RemindersIndex } from "../core/RemindersIndex";
import type { EventBus } from "../core/EventBus";

/** Контекст, передаваемый каждому модулю. */
export interface ModuleContext {
  app: App;
  plugin: ObsidianProjectAutomationPlugin;
  taskIndex: TaskIndex;
  remindersIndex: RemindersIndex;
  eventBus: EventBus;
}

/** Базовый контракт модуля: load() при включении, unload() при выключении. */
export interface PluginModule {
  load(): void;
  unload(): void;
  /** Опционально: обновить состояние при смене настроек (скрыть/показать блоки, старт/стоп фоновых задач). */
  updateState?(): void;
}
