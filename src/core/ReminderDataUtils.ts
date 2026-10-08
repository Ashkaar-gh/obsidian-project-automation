/** Парсинг тегов напоминаний (@DD-MM-YYYY HH:mm), повторений (every N unit) и строк напоминаний. */

import { createValidLocalDate, formatDateDDMMYYYY } from "./DateUtils";

/** Тег даты: (@DD-MM-YYYY HH:mm) или (@YYYY-MM-DD HH:mm); год только четырёхзначный, время необязательно. */
export const REMINDER_DATE_TAG_REGEX =
  /\(@(?:\d{2}[-.]\d{2}[-.]\d{4}|\d{4}[-.]\d{2}[-.]\d{2})(?:[T\s]\d{1,2}:\d{2})?\)/;

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
    month = parseInt(parts[1], 10);
    day = parseInt(parts[2], 10);
  } else {
    day = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    year = parseInt(parts[2], 10);
  }
  // Regex уже требует четырёхзначный год; страховка на случай вызова с произвольным тегом
  if (year < 1000) return null;
  const timeMatch = inner.match(/(\d{1,2}):(\d{2})\s*$/);
  const hour = timeMatch ? parseInt(timeMatch[1], 10) : 10;
  const minute = timeMatch ? parseInt(timeMatch[2], 10) : 0;
  return createValidLocalDate(year, month, day, hour, minute);
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
  return `(@${formatDateDDMMYYYY(date)} ${formatReminderTime(date)})`;
}

/**
 * Строка нового напоминания: `- [ ] текст (every N unit) (@DD-MM-YYYY HH:mm)`.
 * recurrence - «every N unit» или пустая строка. Единый формат для блока напоминаний, блокнота и дедлайнов.
 */
export function buildReminderLine(text: string, date: Date, recurrence = ""): string {
  const recurTag = recurrence ? ` (${recurrence})` : "";
  return `- [ ] ${text}${recurTag} ${formatReminderDateTag(date)}`;
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
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unit = match[2];
  const pureName = text
    .replace(RECURRENCE_REGEX, "")
    .replace(REMINDER_DATE_TAG_REGEX, "")
    .trim();
  return { amount, unit, pureName: pureName || "Напоминание" };
}

// ---------------------------------------------------------------------------
// Правка напоминания в окне («Изменить»)
// ---------------------------------------------------------------------------

/** Повторение в окне напоминания: число и единица во множественном числе - как значения списка в окне. */
export interface ReminderRecurrence {
  amount: number;
  unit: "days" | "weeks" | "months" | "years";
}

/** Поля строки напоминания для окна «Изменить». */
export interface ReminderEditFields {
  /** Текст без чекбокса, тегов даты и повторения и id блока (^abc); пробелы схлопнуты. */
  text: string;
  date: Date;
  recurrence: ReminderRecurrence | null;
}

/** Что изменили в окне «Изменить»: в строку переписываются только эти части. */
export interface ReminderEditChanges {
  text?: string;
  date?: Date;
  /** null - повторение убрали. */
  recurrence?: ReminderRecurrence | null;
}

function toReminderRecurrence(parsed: { amount: number; unit: string } | null): ReminderRecurrence | null {
  if (!parsed) return null;
  const u = parsed.unit.toLowerCase();
  const unit = u.startsWith("week") ? "weeks" : u.startsWith("month") ? "months" : u.startsWith("year") ? "years" : "days";
  return { amount: parsed.amount, unit };
}

/** Повторение из значения окна напоминания: «every 2 months» или пустая строка (без повтора). */
export function parseRecurrenceValue(value: string): ReminderRecurrence | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? toReminderRecurrence(parseRecurrenceFromText(`(${trimmed})`)) : null;
}

/** Тег повторения в том виде, в каком его пишет окно напоминания: «(every 2 months)». */
export function formatRecurrenceTag(recurrence: ReminderRecurrence): string {
  return `(every ${recurrence.amount} ${recurrence.unit})`;
}

/**
 * Строка напоминания по частям: отступ с чекбоксом, тело (текст и теги) и хвост - id блока (^abc), который
 * Obsidian узнаёт только в конце строки, и пробелы (\r) в конце строки.
 */
function splitReminderLine(line: string): { prefix: string; body: string; suffix: string } {
  const prefix = line.match(/^\s*[-*]\s+\[.\]\s*/)?.[0] ?? "";
  const rest = line.slice(prefix.length);
  const content = rest.trimEnd();
  const blockId = content.match(/\s+\^[A-Za-z0-9-]+$/)?.[0] ?? "";
  return {
    prefix,
    body: content.slice(0, content.length - blockId.length),
    suffix: blockId + rest.slice(content.length),
  };
}

/** Убрать из текста фрагмент [start, end): соседние части соединяются одним пробелом. */
function cutSegment(text: string, start: number, end: number): string {
  const left = text.slice(0, start).trimEnd();
  const right = text.slice(end).trimStart();
  return left && right ? `${left} ${right}` : left + right;
}

/** Поля для окна «Изменить»: текст, срок и повторение строки; null - строка не напоминание. */
export function reminderEditFields(line: string): ReminderEditFields | null {
  const due = parseReminderDueFromText(line);
  if (!due) return null;
  const { body } = splitReminderLine(line);
  const text = body
    .replace(REMINDER_DATE_TAG_REGEX, " ")
    .replace(RECURRENCE_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { text, date: due.date, recurrence: toReminderRecurrence(parseRecurrenceFromText(body)) };
}

function sameRecurrence(a: ReminderRecurrence | null, b: ReminderRecurrence | null): boolean {
  if (!a || !b) return a === b;
  return a.amount === b.amount && a.unit === b.unit;
}

/**
 * Что изменили в окне «Изменить» относительно полей, с которыми окно открылось: текст - без учёта лишних
 * пробелов, срок - с точностью до минуты (как в теге), повторение - без учёта формы единицы (week = weeks).
 */
export function reminderEditChanges(
  initial: ReminderEditFields,
  result: { text: string; date: Date; recurrence: string }
): ReminderEditChanges {
  const changes: ReminderEditChanges = {};
  const text = result.text.trim();
  if (text.replace(/\s+/g, " ") !== initial.text) changes.text = text;
  if (Math.floor(result.date.getTime() / 60000) !== Math.floor(initial.date.getTime() / 60000)) {
    changes.date = result.date;
  }
  const recurrence = parseRecurrenceValue(result.recurrence);
  if (!sameRecurrence(recurrence, initial.recurrence)) changes.recurrence = recurrence;
  return changes;
}

/**
 * Строка напоминания после правки в окне: переписывается только изменённое. Остальное остаётся как было
 * в строке: отступ и чекбокс, нетронутый тег даты в своём формате (без времени, ГГГГ-ММ-ДД), id блока.
 * Новый текст ставит части в обычный порядок - текст, повторение, дата (как у нового напоминания).
 */
export function applyReminderEdit(line: string, changes: ReminderEditChanges): string {
  const { prefix, body, suffix } = splitReminderLine(line);
  const dateMatch = body.match(REMINDER_DATE_TAG_REGEX);
  if (!dateMatch) return line;
  const dateTag = changes.date ? formatReminderDateTag(changes.date) : dateMatch[0];
  const recurrenceChanged = changes.recurrence !== undefined;
  const newRecurrenceTag = changes.recurrence ? formatRecurrenceTag(changes.recurrence) : "";

  if (changes.text !== undefined) {
    const recurrenceTag = recurrenceChanged ? newRecurrenceTag : body.match(RECURRENCE_REGEX)?.[0] ?? "";
    return prefix + [changes.text.trim(), recurrenceTag, dateTag].filter(Boolean).join(" ") + suffix;
  }

  let next = changes.date ? body.replace(REMINDER_DATE_TAG_REGEX, () => dateTag) : body;
  if (recurrenceChanged) {
    const current = RECURRENCE_REGEX.exec(next);
    if (current && newRecurrenceTag) {
      next = next.slice(0, current.index) + newRecurrenceTag + next.slice(current.index + current[0].length);
    } else if (current) {
      next = cutSegment(next, current.index, current.index + current[0].length);
    } else if (newRecurrenceTag) {
      // Повторения в строке не было: новое ставим перед датой, как в строке нового напоминания
      const at = next.search(REMINDER_DATE_TAG_REGEX);
      const before = next.slice(0, at).trimEnd();
      next = `${before ? `${before} ` : ""}${newRecurrenceTag} ${next.slice(at)}`;
    }
  }
  return prefix + next + suffix;
}

/** Грейс-период по умолчанию для стрика (мс). 0 = строго: пропустил цикл - стрик сгорел. */
const STREAK_GRACE_MS = 0;

/** Добавить к дате один период повторения (day/week/month/year). */
export function addRecurrencePeriod(date: Date, amount: number, unit: string): Date {
  const d = new Date(date);
  const u = unit.toLowerCase();
  if (u.startsWith("week")) d.setDate(d.getDate() + amount * 7);
  else if (u.startsWith("month")) {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + amount);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  } else if (u.startsWith("year")) {
    const day = d.getDate();
    const month = d.getMonth();
    d.setDate(1);
    d.setFullYear(d.getFullYear() + amount);
    d.setMonth(month);
    const lastDay = new Date(d.getFullYear(), month + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  } else d.setDate(d.getDate() + amount);
  return d;
}

/** Нормализованный текст напоминания для поиска уже созданного recurrence. */
export function normalizeReminderIdentity(line: string): string {
  return String(line ?? "")
    .replace(/^\s*[-*]\s+\[[ xX]\]\s*/i, "")
    .replace(/\s*<!-- opa-reminder-reward:[^>]+ -->/g, "")
    .replace(REMINDER_DATE_TAG_REGEX, "")
    .replace(RECURRENCE_REGEX, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Проверка, выполнено ли повторяющееся напоминание вовремя для сохранения стрика.
 * scheduledDate - дата из тега (@...), completedDate - момент нажатия галочки.
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
  const amount = parseInt(match[4], 10);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  return {
    indent: match[1],
    textPrefix: match[2],
    recurrenceFull: match[3],
    amount,
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

/** Выполненная строка без тега повторения (вместе с пробелом перед ним - без двойных пробелов в тексте). */
export function completedLineWithoutRecurrence(line: string, recurrenceFull: string): string {
  if (!line || !recurrenceFull) return line;
  const withSpace = ` ${recurrenceFull}`;
  const stripped = line.includes(withSpace) ? line.replace(withSpace, "") : line.replace(recurrenceFull, "");
  return stripped.trimEnd();
}

/**
 * Строка следующего вхождения для выполненного повторяющегося напоминания:
 * дата = первая дата строго в будущем в сетке периодов от scheduledDate.
 */
export function buildNextRecurrenceLine(parsed: {
  indent: string;
  textPrefix: string;
  textSuffix: string;
  amount: number;
  unit: string;
}, scheduledDate: Date, now = new Date()): string | null {
  if (!Number.isSafeInteger(parsed.amount) || parsed.amount <= 0) return null;
  if (isNaN(scheduledDate.getTime()) || isNaN(now.getTime())) return null;
  let nextDate = addRecurrencePeriod(scheduledDate, parsed.amount, parsed.unit);
  while (nextDate.getTime() <= now.getTime()) {
    const following = addRecurrencePeriod(nextDate, parsed.amount, parsed.unit);
    if (following.getTime() <= nextDate.getTime()) return null;
    nextDate = following;
  }
  const recurrenceStr = `every ${parsed.amount} ${parsed.unit}`;
  const dateTag = formatReminderDateTag(nextDate);
  const textClean = (parsed.textPrefix + parsed.textSuffix).replace(REMINDER_DATE_TAG_REGEX, "").trim();
  return buildRecurrenceTaskLine(parsed.indent, textClean, recurrenceStr, dateTag);
}

/**
 * Выполненные повторяющиеся строки (`- [x] … (every N unit) (@дата)`) в тексте заметки: под каждой
 * вставляется следующее вхождение, а повторение из выполненной строки убирается. Если следующее вхождение
 * с тем же текстом уже стоит строкой ниже, повторение только снимается. Возвращает исходную строку,
 * если менять нечего (вызывающий код тогда файл не пишет).
 */
export function insertNextRecurrenceLines(content: string, now = new Date()): string {
  const lines = content.split("\n");
  let changed = false;
  for (let lineIdx = lines.length - 1; lineIdx >= 0; lineIdx--) {
    const line = lines[lineIdx];
    const parsed = parseCompletedTaskWithRecurrence(line);
    if (!parsed) continue;
    const due = parseReminderDueFromText(line);
    if (!due) continue;
    const newLine = buildNextRecurrenceLine(parsed, due.date, now);
    if (!newLine) continue;

    lines[lineIdx] = completedLineWithoutRecurrence(line, parsed.recurrenceFull);
    changed = true;
    const textClean = normalizeReminderIdentity(parsed.textPrefix + parsed.textSuffix);
    const nextLine = lines[lineIdx + 1]?.trim() ?? "";
    if (nextLine && RECURRENCE_TEST.test(nextLine) && normalizeReminderIdentity(nextLine) === textClean) continue;
    lines.splice(lineIdx + 1, 0, newLine);
  }
  return changed ? lines.join("\n") : content;
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
  return formatDateDDMMYYYY(d);
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
