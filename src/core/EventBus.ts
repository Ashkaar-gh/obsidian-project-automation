/** Шина событий (Pub/Sub) для связи модулей без жёстких зависимостей. */

export type TaskCompletedPayload = { path: string; difficulty?: string | null };

export interface PluginEventMap {
  "task:completed": TaskCompletedPayload;
  "task:uncompleted": { path: string };
  /** Эмитится TaskIndex после обновления индекса daily-заметок (create/changed/delete/rename). */
  "index:updated": void;
}

type EventName = keyof PluginEventMap;

export class EventBus {
  private listeners = new Map<EventName, Set<(payload: unknown) => void>>();

  on<K extends EventName>(event: K, handler: (payload: PluginEventMap[K]) => void): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler as (p: unknown) => void);
    return () => this.off(event, handler);
  }

  off<K extends EventName>(event: K, handler: (payload: PluginEventMap[K]) => void): void {
    this.listeners.get(event)?.delete(handler as (p: unknown) => void);
  }

  emit<K extends EventName>(event: K, payload: PluginEventMap[K]): void {
    this.listeners.get(event)?.forEach((fn) => fn(payload));
  }
}

export const eventBus = new EventBus();
