/** Создать локальную дату, отклоняя несуществующие календарные даты и время. */
export function createValidLocalDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0
): Date | null {
  if (![year, month, day, hour, minute].every(Number.isInteger)) return null;
  const date = new Date(0);
  date.setHours(hour, minute, 0, 0);
  date.setFullYear(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null;
  }
  return date;
}

export const MONTH_NAMES_RU = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
] as const;

/** Дней в месяце (month - 1..12). */
export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Дата как DD-MM-YYYY: имена ежедневных заметок, таблицы, теги напоминаний. */
export function formatDateDDMMYYYY(date: Date): string {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${d}-${m}-${date.getFullYear()}`;
}

/** Дата как ключ YYYY-MM-DD: история активностей, проверка смены календарного дня. */
export function formatDateKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

/** Строгий разбор DD-MM-YYYY (имена ежедневных заметок, даты формы задачи); несуществующие даты → null. */
export function parseDDMMYYYY(value: string): Date | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value.trim());
  if (!m) return null;
  return createValidLocalDate(parseInt(m[3], 10), parseInt(m[2], 10), parseInt(m[1], 10));
}

/** Парсинг календарной даты DD-MM-YYYY, YYYY-MM-DD или DD.MM.YYYY. */
export function parseCalendarDate(value: unknown): Date | null {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;

  const clean = value.replace(/\.md$/i, "").trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (match) {
    return createValidLocalDate(
      parseInt(match[1], 10),
      parseInt(match[2], 10),
      parseInt(match[3], 10)
    );
  }

  match = /^(\d{2})[-.](\d{2})[-.](\d{4})$/.exec(clean);
  if (!match) return null;
  return createValidLocalDate(
    parseInt(match[3], 10),
    parseInt(match[2], 10),
    parseInt(match[1], 10)
  );
}
