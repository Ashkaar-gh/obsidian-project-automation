import assert from "node:assert/strict";
import test from "node:test";
import moment from "moment";
import { MockEvents } from "obsidian";
import { CalendarSourceCache, isCalendarSourceArray, type CalendarSource } from "../src/core/CalendarSourceCache";
import { CALENDAR_OPEN_EVENT, CalendarCompatModule, findCalendarSources } from "../src/modules/CalendarCompatModule";

/** Граница задач: здесь браузер может нарисовать кадр. */
const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Выполнен ли промис к концу текущей задачи (до кадра). */
async function settledBeforeFrame(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => (settled = true), () => (settled = true));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return settled;
}

/** Время «чтения заметки» у медленного источника: кадр (setImmediate) заведомо наступает раньше ответа. */
const READ_MS = 10;
/** Чтение + задержка перерисовки модуля (50 мс) с запасом. */
const SETTLE_MS = 150;

/** Источник точек, как wordCountSource Calendar: читает «заметку» асинхронно (ответ - следующей задачей). */
function createSlowSource(dots: Map<string, number>) {
  const calls: string[] = [];
  const source: CalendarSource = {
    getDailyMetadata: (date) => {
      const key = (date as moment.Moment).format("YYYY-MM-DD");
      calls.push(key);
      return new Promise((resolve) =>
        setTimeout(() => resolve({ dots: Array.from({ length: dots.get(key) ?? 0 }, () => ({ isFilled: true })) }), READ_MS)
      );
    },
    getWeeklyMetadata: async () => ({ dots: [] }),
  };
  return { source, calls };
}

/**
 * Сетка как у Calendar 1.5.10: tick перерисовывает в микрозадаче, каждая ячейка получает новый промис метаданных
 * и до его ответа пуста (MetadataResolver без ветки ожидания).
 */
class FakeCalendar {
  readonly cells = new Map<string, unknown>();
  private readonly tokens = new Map<string, object>();
  ticks = 0;

  constructor(readonly sources: CalendarSource[], readonly days: moment.Moment[]) {}

  readonly tick = (): void => {
    this.ticks++;
    queueMicrotask(() => this.render());
  };

  render(): void {
    for (const day of this.days) {
      const key = day.format("YYYY-MM-DD");
      const token = {};
      this.tokens.set(key, token);
      this.cells.delete(key);
      void Promise.all(this.sources.map((source) => source.getDailyMetadata!(day))).then((metas) => {
        if (this.tokens.get(key) === token) this.cells.set(key, metas);
      });
    }
  }

  dotsOf(key: string): number {
    const metas = this.cells.get(key) as Array<{ dots: unknown[] }> | undefined;
    return metas ? metas.reduce((sum, meta) => sum + meta.dots.length, 0) : -1;
  }
}

function monthDays(): moment.Moment[] {
  const start = moment("2026-09-01");
  return Array.from({ length: 30 }, (_, i) => start.clone().add(i, "day"));
}

/** Сколько ячеек пусты на каждой границе задач после действия. */
async function emptyCellsPerFrame(calendar: FakeCalendar, action: () => void, frames = 20): Promise<number[]> {
  action();
  const counts: number[] = [];
  for (let i = 0; i < frames; i++) {
    await nextTask();
    counts.push(calendar.days.length - calendar.cells.size);
  }
  return counts;
}

function createWorkspace() {
  const events = new MockEvents();
  const views: unknown[] = [];
  let layoutReady: Array<() => void> | null = [];
  const workspace = {
    views,
    on: (name: string, callback: (...args: any[]) => any) => events.on(name, callback),
    trigger: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    getLeavesOfType: (type: string) => (type === "calendar" ? views.map((view) => ({ view })) : []),
    onLayoutReady(callback: () => void) {
      if (layoutReady) layoutReady.push(callback);
      else callback();
    },
    markLayoutReady() {
      const callbacks = layoutReady ?? [];
      layoutReady = null;
      for (const callback of callbacks) callback();
    },
    listenerCount: (name: string) => events.listenerCount(name),
  };
  const refs: any[] = [];
  const plugin = {
    registerEvent: (ref: any) => refs.push(ref),
    unregisterAll: () => refs.splice(0).forEach((ref) => ref.emitter.offref(ref)),
  };
  const module = new CalendarCompatModule({ app: { workspace }, plugin } as any);
  return { workspace, plugin, module };
}

/** Вид Calendar: как CalendarView.onOpen - событие calendar:open, затем компонент с этими источниками. */
function openCalendarView(workspace: ReturnType<typeof createWorkspace>["workspace"], sources: CalendarSource[]) {
  workspace.trigger(CALENDAR_OPEN_EVENT, sources);
  const calendar = new FakeCalendar(sources, monthDays());
  const view = { calendar: { tick: calendar.tick, $$: { ctx: [moment("2026-09-01"), sources, () => undefined] } } };
  workspace.views.push(view);
  calendar.render();
  return { calendar, view };
}

test("calendar source detection accepts only arrays of metadata sources", () => {
  assert.equal(isCalendarSourceArray([{ getDailyMetadata: () => null }]), true);
  assert.equal(isCalendarSourceArray([{ getWeeklyMetadata: () => null }, { getDailyMetadata: () => null }]), true);
  assert.equal(isCalendarSourceArray([]), false);
  assert.equal(isCalendarSourceArray([{}]), false);
  assert.equal(isCalendarSourceArray([{ getDailyMetadata: () => null }, null]), false);
  assert.equal(isCalendarSourceArray("calendar"), false);
  assert.equal(findCalendarSources({ calendar: { $$: { ctx: [moment(), [{ getDailyMetadata: () => null }]] } } })?.length, 1);
  assert.equal(findCalendarSources({ calendar: null }), null);
});

test("CalendarSourceCache: a known day is answered from memory while the source is asked again in the background", async () => {
  const pending = [deferred<unknown>(), deferred<unknown>()];
  let calls = 0;
  const source: CalendarSource = { getDailyMetadata: () => pending[calls++].promise };
  const sources = [source];
  const cache = new CalendarSourceCache({ onStale: () => assert.fail("data did not change") });
  assert.equal(cache.wrap(sources), 1);
  assert.equal(cache.wrap(sources), 0);
  assert.equal(cache.wrap([{}]), null);
  assert.notEqual(sources[0], source);
  const day = moment("2026-09-29");

  // Первый вопрос о дне - как у самого источника: ждёт ответа
  const first = sources[0].getDailyMetadata!(day) as Promise<unknown>;
  assert.equal(await settledBeforeFrame(first), false);
  pending[0].resolve({ dots: [1] });
  assert.deepEqual(await first, { dots: [1] });

  // Повторный - сразу из памяти, хотя источник снова читает заметку
  const second = sources[0].getDailyMetadata!(day) as Promise<unknown>;
  assert.equal(await settledBeforeFrame(second), true);
  assert.deepEqual(await second, { dots: [1] });
  assert.equal(calls, 2);
  pending[1].resolve({ dots: [1] });
  await sleep(0);
});

test("CalendarSourceCache: changed data asks for one redraw, which is answered from memory without re-reading", async () => {
  let value = { dots: [1] };
  let calls = 0;
  const source: CalendarSource = {
    getDailyMetadata: async () => {
      calls++;
      return value;
    },
  };
  const sources = [source];
  let stale = 0;
  const cache = new CalendarSourceCache({ onStale: () => stale++ });
  cache.wrap(sources);
  const day = moment("2026-09-29");
  await sources[0].getDailyMetadata!(day);

  value = { dots: [1, 2] };
  assert.deepEqual(await sources[0].getDailyMetadata!(day), { dots: [1] });
  await sleep(0);
  assert.equal(stale, 1);
  assert.equal(calls, 2);

  let replayed: unknown;
  cache.replay(() => {
    replayed = sources[0].getDailyMetadata!(day);
  });
  assert.deepEqual(await replayed, { dots: [1, 2] });
  assert.equal(calls, 2, "the redraw is answered from memory");
  // Второй вопрос о том же дне во время перерисовки - это уже tick календаря: источник спрашивается
  await sources[0].getDailyMetadata!(day);
  assert.equal(calls, 3);
  await sleep(0);
  assert.equal(stale, 1, "the same data does not ask for another redraw");
});

test("CalendarSourceCache: a late answer to an older question does not overwrite a newer one", async () => {
  const pending: Array<ReturnType<typeof deferred<unknown>>> = [];
  const source: CalendarSource = {
    getDailyMetadata: () => {
      const next = deferred<unknown>();
      pending.push(next);
      return next.promise;
    },
  };
  const sources = [source];
  let stale = 0;
  const cache = new CalendarSourceCache({ onStale: () => stale++ });
  cache.wrap(sources);
  const day = moment("2026-09-29");
  const first = sources[0].getDailyMetadata!(day);
  pending[0].resolve({ dots: [] });
  await first;

  void sources[0].getDailyMetadata!(day); // старый вопрос
  void sources[0].getDailyMetadata!(day); // новый вопрос
  pending[2].resolve({ dots: [1, 2, 3] });
  await sleep(0);
  pending[1].resolve({ dots: [1] });
  await sleep(0);
  assert.equal(stale, 1);
  let shown: unknown;
  cache.replay(() => {
    shown = sources[0].getDailyMetadata!(day);
  });
  assert.deepEqual(await shown, { dots: [1, 2, 3] });
});

test("CalendarSourceCache: results that cannot be serialized are not cached", async () => {
  let calls = 0;
  const source: CalendarSource = {
    getDailyMetadata: async () => {
      calls++;
      const value: Record<string, unknown> = { dots: [] };
      value.self = value;
      return value;
    },
  };
  const sources = [source];
  const cache = new CalendarSourceCache({ onStale: () => assert.fail("nothing is cached") });
  cache.wrap(sources);
  const day = moment("2026-09-29");
  await sources[0].getDailyMetadata!(day);
  const second = sources[0].getDailyMetadata!(day) as Promise<unknown>;
  assert.equal(await settledBeforeFrame(second), true);
  await second;
  assert.equal(calls, 2);
  let replayCall: Promise<unknown> | undefined;
  cache.replay(() => {
    replayCall = sources[0].getDailyMetadata!(day) as Promise<unknown>;
  });
  await replayCall;
  assert.equal(calls, 3, "without a cached answer the source is asked as usual");
});

test("CalendarSourceCache: a failed background read keeps the last answer", async () => {
  let fail = false;
  const source: CalendarSource = {
    getDailyMetadata: async () => {
      if (fail) throw new Error("read failed");
      return { dots: [1] };
    },
  };
  const sources = [source];
  const cache = new CalendarSourceCache({ onStale: () => assert.fail("a failed read is not a change") });
  cache.wrap(sources);
  const day = moment("2026-09-29");
  await sources[0].getDailyMetadata!(day);
  fail = true;
  assert.deepEqual(await sources[0].getDailyMetadata!(day), { dots: [1] });
  await sleep(0);
});

test("CalendarSourceCache: wrapping is idempotent and dispose restores the original sources", async () => {
  const original: CalendarSource = { getDailyMetadata: async () => ({ dots: [] }), getWeeklyMetadata: async () => ({ dots: [] }) };
  const extra = { getDailyMetadata: async () => ({ dots: [] }), label: "extra" };
  const sources: CalendarSource[] = [original];
  let stale = 0;
  const cache = new CalendarSourceCache({ onStale: () => stale++ });
  cache.wrap(sources);
  const wrapped = sources[0];
  sources.push(extra);
  assert.equal(cache.wrap(sources), 1, "only the new source is wrapped");
  assert.equal(sources[0], wrapped);
  assert.notEqual(sources[1], extra);
  assert.equal((sources[1] as typeof extra).label, "extra", "other fields are visible through the wrapper");
  assert.equal(cache.manages(sources), true);

  cache.dispose();
  assert.equal(sources[0], original);
  assert.equal(sources[1], extra);
  assert.equal(cache.manages(sources), false);
  assert.equal(cache.wrap(sources), null, "a disposed cache does not wrap again");
  assert.equal(stale, 0);
});

test("Calendar grid: without the fix cells with notes are empty on the frame after a save", async () => {
  const dots = new Map([["2026-09-28", 1], ["2026-09-29", 2]]);
  const { source } = createSlowSource(dots);
  const calendar = new FakeCalendar([source], monthDays());
  calendar.render();
  await sleep(4 * READ_MS);
  assert.equal(calendar.cells.size, 30);
  const empty = await emptyCellsPerFrame(calendar, calendar.tick);
  assert.ok(empty[0] > 0, "the fake reproduces the flicker");
});

test("CalendarCompatModule: sources from calendar:open keep every cell on screen through saves", async () => {
  const { workspace, module } = createWorkspace();
  module.load();
  workspace.markLayoutReady();
  const dots = new Map([["2026-09-28", 1], ["2026-09-29", 2]]);
  const { source, calls } = createSlowSource(dots);
  const sources: CalendarSource[] = [source];
  const { calendar } = openCalendarView(workspace, sources);
  assert.notEqual(sources[0], source, "sources are wrapped before the first render");
  await sleep(4 * READ_MS);
  assert.equal(calendar.cells.size, 30);

  // Сохранение без смены точек: ни в одном кадре нет пустых ячеек, лишних перерисовок нет
  let empty = await emptyCellsPerFrame(calendar, calendar.tick);
  assert.deepEqual([...new Set(empty)], [0]);
  await sleep(SETTLE_MS);
  assert.equal(calendar.ticks, 1);

  // Точки дня изменились: кадры без пустых ячеек, новая точка появляется одной перерисовкой из памяти
  dots.set("2026-09-29", 3);
  const readsBefore = calls.length;
  empty = await emptyCellsPerFrame(calendar, calendar.tick);
  assert.deepEqual([...new Set(empty)], [0]);
  await sleep(SETTLE_MS);
  assert.equal(calendar.dotsOf("2026-09-29"), 3);
  assert.equal(calendar.ticks, 3, "one redraw after the save");
  assert.equal(calls.length - readsBefore, 30, "the redraw does not read the notes again");

  module.unload();
  assert.equal(sources[0], source);
});

test("CalendarCompatModule: a calendar opened before the plugin is adopted and warmed up", async () => {
  const { workspace, module } = createWorkspace();
  const dots = new Map([["2026-09-10", 1], ["2026-09-29", 2]]);
  const { source, calls } = createSlowSource(dots);
  const sources: CalendarSource[] = [source];
  // Календарь открылся, пока плагина не было: calendar:open прошло мимо
  const { calendar } = openCalendarView(workspace, sources);
  await sleep(4 * READ_MS);

  module.load();
  workspace.markLayoutReady();
  assert.notEqual(sources[0], source);
  assert.ok(calls.length >= 30 + 42, "shown days are asked about right away");
  await sleep(4 * READ_MS);

  const empty = await emptyCellsPerFrame(calendar, calendar.tick);
  assert.deepEqual([...new Set(empty)], [0]);
  await sleep(SETTLE_MS);
  assert.equal(calendar.dotsOf("2026-09-29"), 2);

  // Повторный layout-change не прогревает календарь заново
  const readsBefore = calls.length;
  workspace.trigger("layout-change");
  assert.equal(calls.length, readsBefore);
  module.unload();
  assert.equal(sources[0], source);
});

test("CalendarCompatModule: sources another plugin adds in the same calendar:open are wrapped and warmed up", async () => {
  const { workspace, module } = createWorkspace();
  module.load();
  workspace.markLayoutReady();
  const dots = new Map([["2026-09-29", 1]]);
  const own = createSlowSource(dots);
  const extra = createSlowSource(new Map([["2026-09-15", 2]]));
  // Слушатель другого плагина срабатывает после нашего и дописывает свой источник
  workspace.on(CALENDAR_OPEN_EVENT, (list: CalendarSource[]) => list.push(extra.source));
  const sources: CalendarSource[] = [own.source];
  const { calendar } = openCalendarView(workspace, sources);
  assert.equal(sources[1], extra.source, "the first render sees the source as it is");
  await Promise.resolve();
  assert.notEqual(sources[1], extra.source);
  assert.ok(extra.calls.length >= 30 + 42, "the added source is asked about the shown days right away");
  await sleep(4 * READ_MS);

  const empty = await emptyCellsPerFrame(calendar, calendar.tick);
  assert.deepEqual([...new Set(empty)], [0]);
  await sleep(SETTLE_MS);
  assert.equal(calendar.dotsOf("2026-09-15"), 2);
  module.unload();
  assert.deepEqual(sources, [own.source, extra.source]);
});

test("CalendarCompatModule: no redraw after unload", async () => {
  const { workspace, module } = createWorkspace();
  module.load();
  workspace.markLayoutReady();
  const dots = new Map([["2026-09-29", 1]]);
  const { source } = createSlowSource(dots);
  const sources: CalendarSource[] = [source];
  const { calendar } = openCalendarView(workspace, sources);
  await sleep(4 * READ_MS);
  dots.set("2026-09-29", 2);
  calendar.tick();
  await sleep(3 * READ_MS);
  module.unload();
  await sleep(SETTLE_MS);
  assert.equal(calendar.ticks, 1, "the scheduled redraw is cancelled");
});
