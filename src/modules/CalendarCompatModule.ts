/**
 * Совместимость с плагином Calendar (Liam Cain): календарь в сайдбаре не дёргается, пока идёт набор текста
 * в ежедневной заметке. Файлы Calendar не меняются: источники его точек оборачиваются кэшем (см. CalendarSourceCache).
 *
 * Источники приходят в событии calendar:open - точке расширения Calendar: открываясь, вид отдаёт массив источников
 * другим плагинам. Вид, открытый раньше, чем загрузился этот плагин (перезагрузка плагина, порядок загрузки),
 * подхватывается из компонента календаря: массив источников лежит в состоянии его компонента Svelte.
 */

import type { EventRef } from "obsidian";
import type { ModuleContext, PluginModule } from "./types";
import { CalendarSourceCache, isCalendarSourceArray, type CalendarSource } from "../core/CalendarSourceCache";

export const CALENDAR_VIEW_TYPE = "calendar";
export const CALENDAR_OPEN_EVENT = "calendar:open";
/** Свежие ответы дней приходят вразнобой: одна перерисовка на все изменения. */
const REDRAW_DELAY_MS = 50;
/** Подключение к уже открытому календарю: дни вокруг показанного месяца, о которых источники спрашиваются заранее. */
const WARM_UP_DAYS_BEFORE = 7;
const WARM_UP_DAYS = 49;

/** Корневой компонент Svelte в виде Calendar: tick - перерисовать, $$.ctx - состояние компонента. */
interface CalendarComponentLike {
  tick?: () => void;
  $$?: { ctx?: unknown };
}

interface CalendarViewLike {
  calendar?: CalendarComponentLike | null;
}

interface MomentLike {
  clone(): MomentLike;
  startOf(unit: string): MomentLike;
  add(amount: number, unit: string): MomentLike;
  format(format?: string): string;
}

function componentState(view: unknown): unknown[] | null {
  const ctx = (view as CalendarViewLike | null)?.calendar?.$$?.ctx;
  return Array.isArray(ctx) ? ctx : null;
}

/** Массив источников открытого календаря (из состояния его компонента); null - не нашёлся. */
export function findCalendarSources(view: unknown): CalendarSource[] | null {
  const sources = componentState(view)?.find((item) => isCalendarSourceArray(item));
  return (sources as CalendarSource[] | undefined) ?? null;
}

function isMomentLike(value: unknown): value is MomentLike {
  const date = value as Partial<MomentLike> | null;
  return (
    date != null &&
    typeof date === "object" &&
    typeof date.clone === "function" &&
    typeof date.startOf === "function" &&
    typeof date.add === "function" &&
    typeof date.format === "function"
  );
}

/** Спросить источник, не оставляя необработанного отказа. */
function ask(fn: ((date: unknown) => unknown) | undefined, source: CalendarSource, date: MomentLike): void {
  if (typeof fn !== "function") return;
  try {
    void Promise.resolve(fn.call(source, date)).catch(() => undefined);
  } catch {
    // источник упал синхронно - прогрев просто пропускает этот день
  }
}

export class CalendarCompatModule implements PluginModule {
  private readonly cache: CalendarSourceCache;
  private redrawTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ctx: ModuleContext) {
    this.cache = new CalendarSourceCache({ onStale: () => this.scheduleRedraw() });
  }

  load(): void {
    const { app, plugin } = this.ctx;
    // Событие другого плагина: в типах Workspace его нет
    const workspace = app.workspace as unknown as {
      on(name: string, callback: (...data: unknown[]) => unknown): EventRef;
    };
    plugin.registerEvent(workspace.on(CALENDAR_OPEN_EVENT, (sources) => this.adopt(sources)));
    plugin.registerEvent(app.workspace.on("layout-change", () => this.adoptOpenViews()));
    app.workspace.onLayoutReady(() => this.adoptOpenViews());
  }

  unload(): void {
    if (this.redrawTimer) clearTimeout(this.redrawTimer);
    this.redrawTimer = null;
    this.cache.dispose();
  }

  /** calendar:open - вид открывается и сейчас отрисует сетку с этими источниками. */
  private adopt(sources: unknown): void {
    if (!isCalendarSourceArray(sources) || this.cache.wrap(sources) == null) return;
    // Другие плагины могут дописать свои источники в том же событии, уже после нас. Сетку вид к этому времени
    // уже нарисовал без их обёрток, поэтому о показанных днях они спрашиваются сразу
    queueMicrotask(() => {
      if (!this.cache.wrap(sources)) return;
      for (const view of this.calendarViews()) {
        if (findCalendarSources(view) === sources) this.warmUp(view, sources);
      }
    });
  }

  /** Календари, открытые без нас, и источники, дописанные позже: обернуть и заранее спросить о показанных днях. */
  private adoptOpenViews(): void {
    for (const view of this.calendarViews()) {
      const sources = findCalendarSources(view);
      if (sources && this.cache.wrap(sources)) this.warmUp(view, sources);
    }
  }

  /**
   * Первый вопрос о дне уходит источнику как есть, и ячейка ждёт ответа. Календарь, к которому подключились позже,
   * чем он отрисовался, спрашивается о днях вокруг показанного месяца сразу - его первая перерисовка пойдёт из памяти.
   */
  private warmUp(view: unknown, sources: CalendarSource[]): void {
    const month = componentState(view)?.find(isMomentLike);
    if (!month) return;
    const start = month.clone().startOf("month").add(-WARM_UP_DAYS_BEFORE, "day");
    const weeks = new Map<string, MomentLike>();
    for (let i = 0; i < WARM_UP_DAYS; i++) {
      const day = start.clone().add(i, "day");
      const week = day.clone().startOf("week");
      weeks.set(week.format("YYYY-MM-DD"), week);
      for (const source of sources) ask(source.getDailyMetadata, source, day);
    }
    for (const week of weeks.values()) {
      for (const source of sources) ask(source.getWeeklyMetadata, source, week);
    }
  }

  private calendarViews(): unknown[] {
    return this.ctx.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE).map((leaf) => leaf.view);
  }

  private scheduleRedraw(): void {
    if (this.redrawTimer) return;
    this.redrawTimer = setTimeout(() => {
      this.redrawTimer = null;
      this.redraw();
    }, REDRAW_DELAY_MS);
  }

  /** Перерисовать календари с обёрнутыми источниками: свежие ответы уже в памяти, ячейки не пустеют. */
  private redraw(): void {
    const components: CalendarComponentLike[] = [];
    for (const view of this.calendarViews()) {
      const component = (view as CalendarViewLike | null)?.calendar;
      if (typeof component?.tick !== "function") continue;
      const sources = findCalendarSources(view);
      // Массив не нашёлся (другое устройство компонента) - источники обёрнуты по calendar:open, перерисовываем
      if (sources && !this.cache.manages(sources)) continue;
      components.push(component);
    }
    if (components.length === 0) return;
    this.cache.replay(() => {
      for (const component of components) {
        try {
          component.tick?.();
        } catch (error) {
          console.error("[OPA] Calendar redraw failed:", error);
        }
      }
    });
  }
}
