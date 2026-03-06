/** Парсинг тегов напоминаний (@DD-MM-YYYY HH:mm). */

export const REMINDER_DATE_TAG_REGEX = /\(@\d{2,4}[-.]\d{2}[-.]\d{2,4}(?:[T\s]\d{1,2}:\d{2})?\)/;

/** Тег повторения: (every N day|days|week|weeks|month|months|year|years). */
export const RECURRENCE_REGEX = /\(every\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)\)/i;

function parseDateFromReminderTag(tagStr: string): Date | null {
  if (!tagStr || tagStr.length < 4) return null;
  const inner = tagStr.slice(2, -1).trim();
  const parts = inner.split(/[-.\sT]/).filter(Boolean);
  if (parts.length < 3) return null;
  let day: number, month: number, year: number;
  if (parts[0].length === 4) {
    year = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10) - 1;
    day = parseInt(parts[2], 10);
  } else {
    day = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10) - 1;
    year = parseInt(parts[2], 10);
  }
  const timeMatch = inner.match(/(\d{1,2}):(\d{2})\s*$/);
  const hour = timeMatch
    ? Math.min(23, Math.max(0, parseInt(timeMatch[1], 10)))
    : 10;
  const minute = timeMatch
    ? Math.min(59, Math.max(0, parseInt(timeMatch[2], 10)))
    : 0;
  const d = new Date(year, month, day, hour, minute);
  return isNaN(d.getTime()) ? null : d;
}

export interface ParsedReminder {
  date: Date;
  cleanText: string;
  hasTime: boolean;
}

export function parseReminderDueFromText(text: string): ParsedReminder | null {
  if (!text || typeof text !== "string") return null;
  const match = text.match(REMINDER_DATE_TAG_REGEX);
  if (!match) return null;
  const date = parseDateFromReminderTag(match[0]);
  if (!date) return null;
  const hasTime = /[\sT]\d{1,2}:\d{2}\)/.test(match[0]);
  const withoutDate = text.replace(REMINDER_DATE_TAG_REGEX, "").trim();
  const cleanText = withoutDate.replace(/^\s*[-*]\s+\[.\]\s*/i, "").trim();
  return {
    date,
    cleanText: cleanText || withoutDate,
    hasTime,
  };
}

export function formatReminderDateTag(date: Date): string {
  const d = date.getDate().toString().padStart(2, "0");
  const m = (date.getMonth() + 1).toString().padStart(2, "0");
  const y = date.getFullYear();
  const h = date.getHours().toString().padStart(2, "0");
  const min = date.getMinutes().toString().padStart(2, "0");
  return `(@${d}-${m}-${y} ${h}:${min})`;
}

/** Заменить тег даты в строке на новый (для отложения). */
export function replaceReminderDateTag(line: string, newDateTag: string): string {
  if (!line || !newDateTag) return String(line ?? "");
  return String(line).replace(REMINDER_DATE_TAG_REGEX, newDateTag);
}

export interface ParsedRecurrence {
  amount: number;
  unit: string;
  pureName: string;
}

export function parseRecurrenceFromText(text: string): ParsedRecurrence | null {
  if (!text || typeof text !== "string") return null;
  const match = text.trim().match(RECURRENCE_REGEX);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const pureName = text
    .replace(RECURRENCE_REGEX, "")
    .replace(REMINDER_DATE_TAG_REGEX, "")
    .trim();
  return { amount, unit, pureName: pureName || "Напоминание" };
}

/** Грейс-период по умолчанию для стрика (мс). 0 = строго: пропустил цикл — стрик сгорел. */
const STREAK_GRACE_MS = 0;

/** Добавить к дате один период повторения (day/week/month/year). */
export function addRecurrencePeriod(date: Date, amount: number, unit: string): Date {
  const d = new Date(date);
  const u = unit.toLowerCase();
  if (u.startsWith("week")) d.setDate(d.getDate() + amount * 7);
  else if (u.startsWith("month")) d.setMonth(d.getMonth() + amount);
  else if (u.startsWith("year")) d.setFullYear(d.getFullYear() + amount);
  else d.setDate(d.getDate() + amount);
  return d;
}

/**
 * Проверка, выполнено ли повторяющееся напоминание вовремя для сохранения стрика.
 * scheduledDate — дата из тега (@...), completedDate — момент нажатия галочки.
 * Если выполнение позже чем (scheduledDate + 1 период + грейс), стрик сбрасывается.
 */
export function isRecurrenceCompletionOnTime(
  scheduledDate: Date,
  completedDate: Date,
  amount: number,
  unit: string,
  graceMs: number = STREAK_GRACE_MS
): boolean {
  const deadline = addRecurrencePeriod(scheduledDate, amount, unit);
  const deadlineMs = deadline.getTime() + graceMs;
  return completedDate.getTime() <= deadlineMs;
}

/** Относительное время до/после даты (кратко). */
export function fromNow(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dueTime = date.getTime();
  const nowTime = now.getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  if (dueDate.getTime() < today.getTime()) {
    const days = Math.ceil((today.getTime() - dueDate.getTime()) / dayMs);
    if (days === 1) return "вчера";
    if (days < 5) return `${days} дн. назад`;
    return "просрочено";
  }
  if (dueDate.getTime() === today.getTime()) return "сегодня";
  if (dueDate.getTime() === tomorrow.getTime()) return "завтра";
  const days = Math.ceil((dueTime - nowTime) / dayMs);
  if (days <= 0) return "скоро";
  if (days === 1) return "через день";
  if (days < 8) return `через ${days} дн.`;
  if (days < 32) return `через ${Math.round(days / 7)} нед.`;
  return `через ${Math.round(days / 30)} мес.`;
}

const REGEX_COMPLETED_WITH_RECURRENCE =
  /^(\s*)[-*]\s+\[[xX]\]\s+(.*)(\(every\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)\))(.*)$/i;

export function parseCompletedTaskWithRecurrence(line: string): {
  indent: string;
  textPrefix: string;
  recurrenceFull: string;
  amount: number;
  unit: string;
  textSuffix: string;
} | null {
  if (!line) return null;
  const match = String(line).match(REGEX_COMPLETED_WITH_RECURRENCE);
  if (!match) return null;
  return {
    indent: match[1],
    textPrefix: match[2],
    recurrenceFull: match[3],
    amount: parseInt(match[4], 10),
    unit: match[5],
    textSuffix: match[6],
  };
}

export function buildRecurrenceTaskLine(
  indent: string,
  textClean: string,
  recurrenceStr: string,
  dateTag: string
): string {
  return `${indent}- [ ] ${textClean} (${recurrenceStr}) ${dateTag}`;
}

export function completedLineWithoutRecurrence(line: string, recurrenceFull: string): string {
  if (!line || !recurrenceFull) return line;
  return line.replace(recurrenceFull, "").trimEnd();
}

export type ReminderItemType = "overdue" | "today" | "tomorrow" | "upcoming" | "completed";

export interface ReminderItem {
  filePath: string;
  lineIndex: number;
  lineText: string;
  text: string;
  date: Date;
  displayDate: string;
  displayTime: string | null;
  type: ReminderItemType;
  isRecurring: boolean;
}

export interface ReminderData {
  overdue: ReminderItem[];
  today: ReminderItem[];
  tomorrow: ReminderItem[];
  upcoming: ReminderItem[];
  completed: ReminderItem[];
}

export function formatReminderDate(d: Date): string {
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\./g, "-");
}

export function formatReminderTime(d: Date): string {
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export function getReminderItemType(date: Date): ReminderItemType {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (dueDate.getTime() < today.getTime()) return "overdue";
  if (dueDate.getTime() === today.getTime()) {
    return date.getTime() <= now.getTime() ? "overdue" : "today";
  }
  if (dueDate.getTime() === tomorrow.getTime()) return "tomorrow";
  return "upcoming";
}

const RECURRENCE_TEST = /\(every\s+\d+\s+(day|days|week|weeks|month|months|year|years)\)/i;

export function lineToReminderItem(
  filePath: string,
  lineIndex: number,
  lineText: string
): ReminderItem | null {
  const trimmed = lineText.trim();
  if (!trimmed.startsWith("- [ ]") && !trimmed.startsWith("* [ ]")) return null;
  if (!REMINDER_DATE_TAG_REGEX.test(trimmed)) return null;
  const parsed = parseReminderDueFromText(trimmed);
  if (!parsed) return null;
  const type = getReminderItemType(parsed.date);
  return {
    filePath,
    lineIndex,
    lineText: trimmed,
    text: parsed.cleanText,
    date: parsed.date,
    displayDate: formatReminderDate(parsed.date),
    displayTime: parsed.hasTime ? formatReminderTime(parsed.date) : null,
    type,
    isRecurring: RECURRENCE_TEST.test(trimmed),
  };
}

/** Парсинг выполненной строки напоминания ([x]) в ReminderItem для архива. */
export function completedLineToReminderItem(
  filePath: string,
  lineIndex: number,
  lineText: string
): ReminderItem | null {
  const trimmed = lineText.trim();
  if (!trimmed.startsWith("- [x]") && !trimmed.startsWith("- [X]") && !trimmed.startsWith("* [x]") && !trimmed.startsWith("* [X]")) return null;
  if (!REMINDER_DATE_TAG_REGEX.test(trimmed)) return null;
  const parsed = parseReminderDueFromText(trimmed);
  if (!parsed) return null;
  return {
    filePath,
    lineIndex,
    lineText: trimmed,
    text: parsed.cleanText,
    date: parsed.date,
    displayDate: formatReminderDate(parsed.date),
    displayTime: parsed.hasTime ? formatReminderTime(parsed.date) : null,
    type: "completed",
    isRecurring: RECURRENCE_TEST.test(trimmed),
  };
}
