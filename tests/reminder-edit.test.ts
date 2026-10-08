import assert from "node:assert/strict";
import test from "node:test";
import {
  applyReminderEdit,
  formatRecurrenceTag,
  parseRecurrenceValue,
  reminderEditChanges,
  reminderEditFields,
} from "../src/core/ReminderDataUtils";

/** Окно «Изменить» у напоминания: поля окна из строки и запись в строку только изменённого (без DOM). */

const LINE = "- [ ] Почистить робот пылесос (every 2 months) (@05-10-2026 19:00)";

/** Правка, как её вернёт окно: поля, которые не переданы, остаются такими, с какими окно открылось. */
function edit(line: string, result: Partial<{ text: string; date: Date; recurrence: string }>): string {
  const initial = reminderEditFields(line);
  assert.ok(initial, `not a reminder line: ${line}`);
  const recurrence = initial.recurrence ? `every ${initial.recurrence.amount} ${initial.recurrence.unit}` : "";
  const changes = reminderEditChanges(initial, { text: initial.text, date: initial.date, recurrence, ...result });
  return applyReminderEdit(line, changes);
}

test("edit window fields: text without tags, the due date, recurrence in the window's units", () => {
  const fields = reminderEditFields(LINE);
  assert.ok(fields);
  assert.equal(fields.text, "Почистить робот пылесос");
  assert.equal(fields.date.getTime(), new Date(2026, 9, 5, 19, 0).getTime());
  assert.deepEqual(fields.recurrence, { amount: 2, unit: "months" });

  // Текст вокруг тегов, единица в единственном числе, отступ и id блока: в поле текста только слова строки
  const other = reminderEditFields("    - [ ] Позвонить (@2026-10-06) маме (every 1 week) ^abc1");
  assert.ok(other);
  assert.equal(other.text, "Позвонить маме");
  assert.equal(other.date.getTime(), new Date(2026, 9, 6, 10, 0).getTime(), "без времени - 10:00, как у уведомления");
  assert.deepEqual(other.recurrence, { amount: 1, unit: "weeks" });

  assert.equal(reminderEditFields("- [ ] Просто задача"), null);
});

test("saving the window unchanged changes nothing, whatever the spaces or the unit form", () => {
  const fields = reminderEditFields(LINE);
  assert.ok(fields);
  assert.deepEqual(
    reminderEditChanges(fields, {
      text: "  Почистить  робот пылесос ",
      date: new Date(2026, 9, 5, 19, 0),
      recurrence: "every 2 months",
    }),
    {}
  );
  const line = "- [ ] Отчёт (every 1 week) (@05-10-2026)";
  assert.equal(edit(line, {}), line);
  assert.equal(edit(line, { recurrence: "every 1 weeks" }), line, "week = weeks");
  assert.equal(edit(line, { date: new Date(2026, 9, 5, 10, 0) }), line, "дата без времени не получает 10:00");
});

test("a new date replaces only the date tag, in place", () => {
  assert.equal(
    edit(LINE, { date: new Date(2026, 9, 12, 9, 30) }),
    "- [ ] Почистить робот пылесос (every 2 months) (@12-10-2026 09:30)"
  );
  // Дата перед текстом, отступ, id блока: порядок строки сохраняется
  assert.equal(
    edit("  - [ ] (@2026-10-05 19:00) Позвонить маме ^abc", { date: new Date(2026, 9, 6, 8, 0) }),
    "  - [ ] (@06-10-2026 08:00) Позвонить маме ^abc"
  );
});

test("a new text puts the line in the usual order and keeps untouched tags as written", () => {
  assert.equal(
    edit(LINE, { text: "Почистить щётки робота" }),
    "- [ ] Почистить щётки робота (every 2 months) (@05-10-2026 19:00)"
  );
  // Дата без времени в формате ГГГГ-ММ-ДД остаётся как была; отступ, id блока и \r на месте
  assert.equal(
    edit("\t- [ ] Позвонить (@2026-10-06) маме (every 1 week) ^abc1\r", { text: "Позвонить папе" }),
    "\t- [ ] Позвонить папе (every 1 week) (@2026-10-06) ^abc1\r"
  );
});

test("recurrence: added before the date, changed in place, removed without leftover spaces", () => {
  assert.equal(
    edit("- [ ] Полить цветы (@05-10-2026 19:00)", { recurrence: "every 3 days" }),
    "- [ ] Полить цветы (every 3 days) (@05-10-2026 19:00)"
  );
  assert.equal(
    edit("- [ ] Позвонить (@05-10-2026 19:00) маме", { recurrence: "every 1 weeks" }),
    "- [ ] Позвонить (every 1 weeks) (@05-10-2026 19:00) маме"
  );
  assert.equal(
    edit(LINE, { recurrence: "every 1 months" }),
    "- [ ] Почистить робот пылесос (every 1 months) (@05-10-2026 19:00)"
  );
  assert.equal(edit(LINE, { recurrence: "" }), "- [ ] Почистить робот пылесос (@05-10-2026 19:00)");
  assert.equal(
    edit("- [ ] (every 1 week) Зарядка (@05-10-2026 07:00)", { recurrence: "" }),
    "- [ ] Зарядка (@05-10-2026 07:00)"
  );
  assert.equal(
    edit(LINE, { text: "Помыть робот", date: new Date(2026, 11, 1, 18, 0), recurrence: "every 1 years" }),
    "- [ ] Помыть робот (every 1 years) (@01-12-2026 18:00)"
  );
});

test("the window's recurrence value and the tag agree", () => {
  assert.deepEqual(parseRecurrenceValue("every 2 months"), { amount: 2, unit: "months" });
  assert.deepEqual(parseRecurrenceValue("every 1 week"), { amount: 1, unit: "weeks" });
  assert.equal(parseRecurrenceValue(""), null);
  assert.equal(parseRecurrenceValue("every 0 days"), null);
  assert.equal(formatRecurrenceTag({ amount: 2, unit: "months" }), "(every 2 months)");
});
