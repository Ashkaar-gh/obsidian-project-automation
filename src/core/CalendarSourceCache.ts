/**
 * Источники точек плагина Calendar (Liam Cain) с ответом из памяти.
 *
 * Calendar 1.5.x на каждое сохранение ежедневной заметки (пока идёт набор, Obsidian сохраняет её раз в пару секунд),
 * на открытие файла и раз в минуту заново спрашивает у источников точки всех дней сетки. Ответ - промис, и пока он
 * не выполнен, ячейка дня пустая: число и точки убраны из DOM ({#await} без ветки ожидания). Источники читают заметки
 * (vault.cachedRead), ответ приходит следующей задачей - ячейки дней с заметками пустеют на кадр, строки теряют высоту,
 * сетка дёргается.
 *
 * Обёртка источника на повторный вопрос о дне отвечает сразу прошлым результатом (готовым промисом): Svelte
 * возвращает ячейку ещё до отрисовки кадра. Свежий результат считается тут же, в фоне; если он другой, он запоминается
 * и календарь перерисовывается ещё раз (replay) - тоже из памяти, без повторного чтения заметок.
 */

/** Методы источника, которые спрашивает календарь: точки дня и точки недели (колонка номеров недель). */
const METHODS = ["getDailyMetadata", "getWeeklyMetadata"] as const;
type MetadataMethod = (typeof METHODS)[number];
type MetadataFn = (date: unknown, ...rest: unknown[]) => unknown;

/** Источник календаря (ICalendarSource из obsidian-calendar-ui): метод получает moment дня и возвращает промис. */
export type CalendarSource = Partial<Record<MetadataMethod, MetadataFn>>;

/** Исходный источник обёртки: по нему обёртка узнаётся и снимается. */
const ORIGINAL = Symbol("opa-calendar-source");

type WrappedSource = CalendarSource & { [ORIGINAL]: CalendarSource };

interface CachedResult {
  value: unknown;
  /** JSON результата: по нему свежий ответ сравнивается с показанным. */
  signature: string;
}

export interface CalendarSourceCacheOptions {
  /** Свежий ответ источника отличается от показанного: календарь надо перерисовать (данные уже в памяти). */
  onStale: () => void;
}

/** Похоже на массив источников календаря: непустой, у каждого элемента есть метод точек. */
export function isCalendarSourceArray(value: unknown): value is CalendarSource[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (source) =>
        source != null &&
        typeof source === "object" &&
        METHODS.some((method) => typeof (source as CalendarSource)[method] === "function")
    )
  );
}

function isWrapped(source: unknown): source is WrappedSource {
  return source != null && typeof source === "object" && ORIGINAL in source;
}

/** Ключ дня (moment → YYYY-MM-DD); null - дата не moment, такой вопрос не кэшируется. */
function dayKey(date: unknown): string | null {
  const format = (date as { format?: unknown } | null)?.format;
  if (typeof format !== "function") return null;
  try {
    const key: unknown = format.call(date, "YYYY-MM-DD");
    return typeof key === "string" && key !== "" ? key : null;
  } catch {
    return null;
  }
}

/** JSON результата; null - результат не сериализуется: он не кэшируется, источник работает как без обёртки. */
function signatureOf(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : null;
  } catch {
    return null;
  }
}

function callSource(fn: MetadataFn, source: CalendarSource, date: unknown, rest: unknown[]): Promise<unknown> {
  try {
    return Promise.resolve(fn.call(source, date, ...rest));
  } catch (error) {
    return Promise.reject(error);
  }
}

export class CalendarSourceCache {
  /** Массивы источников, в которых стоят обёртки (чтобы снять их при выгрузке). */
  private readonly arrays = new Set<CalendarSource[]>();
  /** Идёт собственная перерисовка: известные дни отвечают из памяти, заметки не перечитываются. */
  private replaying = false;
  /** Номер собственной перерисовки: по нему обёртка отличает её вопросы от вопросов следующего tick. */
  private replayGeneration = 0;
  private disposed = false;

  constructor(private readonly options: CalendarSourceCacheOptions) {}

  /**
   * Обернуть источники массива на месте; уже обёрнутые не трогаются. Возвращает, сколько источников обёрнуто сейчас
   * (0 - все уже были обёрнуты), или null - это не массив источников календаря.
   */
  wrap(sources: unknown): number | null {
    if (this.disposed || !isCalendarSourceArray(sources)) return null;
    this.arrays.add(sources);
    let added = 0;
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      if (isWrapped(source)) continue;
      sources[i] = this.createWrapper(source);
      added++;
    }
    return added;
  }

  /** Источники этого массива обёрнуты этим кэшем. */
  manages(sources: unknown): boolean {
    return Array.isArray(sources) && this.arrays.has(sources as CalendarSource[]);
  }

  /**
   * Перерисовать календарь по уже полученным данным: redraw вызывает tick календаря. Svelte перерисовывает
   * в микрозадачах после tick (у Calendar два рантайма Svelte - две очереди подряд), поэтому флаг снимается
   * следующей задачей, когда они уже выполнены. Если за это время календарь спросит о дне второй раз, это уже
   * его собственный tick (сохранение заметки, открытие файла) - такой вопрос проверяется как обычно.
   */
  replay(redraw: () => void): void {
    this.replaying = true;
    this.replayGeneration++;
    try {
      redraw();
    } finally {
      setTimeout(() => {
        this.replaying = false;
      }, 0);
    }
  }

  /** Вернуть исходные источники и больше не просить перерисовок (выгрузка плагина). */
  dispose(): void {
    this.disposed = true;
    for (const sources of this.arrays) {
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        if (isWrapped(source)) sources[i] = source[ORIGINAL];
      }
    }
    this.arrays.clear();
  }

  private createWrapper(source: CalendarSource): WrappedSource {
    // Прототип обёртки - сам источник: остальные его поля и методы видны через неё как есть
    const wrapper = Object.create(source) as WrappedSource;
    Object.defineProperty(wrapper, ORIGINAL, { value: source });
    for (const method of METHODS) {
      const original = source[method];
      if (typeof original === "function") wrapper[method] = this.cachedMethod(source, original);
    }
    return wrapper;
  }

  private cachedMethod(source: CalendarSource, original: MetadataFn): MetadataFn {
    const results = new Map<string, CachedResult>();
    /** Номер последнего вопроса о дне: ответ на более ранний вопрос, пришедший позже, не запоминается. */
    const latest = new Map<string, number>();
    let requests = 0;
    /** Дни, на которые в текущей собственной перерисовке уже ответили из памяти. */
    const replayed = new Set<string>();
    let replayedGeneration = -1;
    return (date: unknown, ...rest: unknown[]): Promise<unknown> => {
      const key = dayKey(date);
      const known = key == null ? undefined : results.get(key);
      if (key != null && known && this.replaying) {
        if (replayedGeneration !== this.replayGeneration) {
          replayed.clear();
          replayedGeneration = this.replayGeneration;
        }
        if (!replayed.has(key)) {
          replayed.add(key);
          return Promise.resolve(known.value);
        }
      }
      const fresh = callSource(original, source, date, rest);
      if (key == null) return fresh;
      const request = ++requests;
      latest.set(key, request);
      /** Запомнить ответ; true - он отличается от прежнего. */
      const remember = (value: unknown): boolean => {
        if (latest.get(key) !== request) return false;
        const signature = signatureOf(value);
        if (signature == null) {
          results.delete(key);
          return false;
        }
        const previous = results.get(key);
        results.set(key, { value, signature });
        return previous !== undefined && previous.signature !== signature;
      };
      if (!known) {
        // Ответа о дне в памяти нет (не спрашивали или он не сериализуется): как у самого источника
        return fresh.then((value) => {
          remember(value);
          return value;
        });
      }
      fresh.then(
        (value) => {
          if (remember(value) && !this.disposed) this.options.onStale();
        },
        // Ошибка чтения: остаётся прошлый результат, следующий вопрос о дне спросит источник снова
        () => undefined
      );
      return Promise.resolve(known.value);
    };
  }
}
