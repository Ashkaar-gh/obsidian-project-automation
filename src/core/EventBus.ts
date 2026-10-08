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
  private listeners = new Map<EventName, Set<(payload: unknown) => void | Promise<void>>>();

  on<K extends EventName>(event: K, handler: (payload: PluginEventMap[K]) => void | Promise<void>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler as (p: unknown) => void | Promise<void>);
    return () => this.off(event, handler);
  }

  off<K extends EventName>(event: K, handler: (payload: PluginEventMap[K]) => void | Promise<void>): void {
    this.listeners.get(event)?.delete(handler as (p: unknown) => void | Promise<void>);
  }

  /**
   * Вызвать всех слушателей и дождаться их. Ошибка одного слушателя логируется и не мешает остальным
   * и не прерывает вызывающий код (смена статуса задачи не должна падать из-за геймификации).
   */
  async emit<K extends EventName>(event: K, payload: PluginEventMap[K]): Promise<void> {
    await Promise.all(
      [...(this.listeners.get(event) ?? [])].map(async (fn) => {
        try {
          await fn(payload);
        } catch (error) {
          console.error(`[EventBus] listener for "${event}" failed:`, error);
        }
      })
    );
  }
}
