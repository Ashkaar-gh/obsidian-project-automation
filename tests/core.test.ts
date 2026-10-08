import assert from "node:assert/strict";
import test from "node:test";
import {
  createValidLocalDate,
  formatDateDDMMYYYY,
  formatDateKey,
  parseCalendarDate,
  parseDDMMYYYY,
} from "../src/core/DateUtils";
import { appendLineToTaskDescriptionContent } from "../src/core/TaskDescriptionUtils";
import {
  addRecurrencePeriod,
  buildNextRecurrenceLine,
  buildReminderLine,
  insertNextRecurrenceLines,
  normalizeReminderIdentity,
  parseCompletedTaskWithRecurrence,
  parseRecurrenceFromText,
  parseReminderDueFromText,
} from "../src/core/ReminderDataUtils";

test("calendar parser rejects impossible and malformed dates", () => {
  assert.equal(parseCalendarDate("31-02-2026"), null);
  assert.equal(parseCalendarDate("2026-13-01"), null);
  assert.equal(parseCalendarDate("2026-07-01 trailing"), null);
  assert.equal(createValidLocalDate(2026, 7, 1, 24, 0), null);

  const leapDay = parseCalendarDate("29-02-2024");
  assert.ok(leapDay);
  assert.equal(leapDay.getDate(), 29);
  assert.equal(leapDay.getMonth(), 1);
});

test("date formatting and the strict DD-MM-YYYY parser are inverse to each other", () => {
  const date = new Date(2026, 8, 5, 15, 30);
  assert.equal(formatDateDDMMYYYY(date), "05-09-2026");
  assert.equal(formatDateKey(date), "2026-09-05");
  assert.deepEqual(parseDDMMYYYY("05-09-2026"), new Date(2026, 8, 5));
  // Только DD-MM-YYYY: другие форматы и несуществующие даты отклоняются
  assert.equal(parseDDMMYYYY("2026-09-05"), null);
  assert.equal(parseDDMMYYYY("31-02-2026"), null);
  assert.equal(parseDDMMYYYY("5-9-2026"), null);
});

test("reminder parser rejects invalid calendar dates, times and two-digit years", () => {
  assert.equal(parseReminderDueFromText("- [ ] Invalid (@31-02-2026 10:00)"), null);
  assert.equal(parseReminderDueFromText("- [ ] Invalid (@01-07-2026 24:00)"), null);
  // «(@16-09-26)» раньше становился 26-м годом и вечно просроченным напоминанием
  assert.equal(parseReminderDueFromText("- [ ] Short year (@16-09-26 10:00)"), null);
  assert.ok(parseReminderDueFromText("- [ ] Valid (@01-07-2026 09:30)"));
});

test("reminder line builder writes the same tag the parser reads", () => {
  const date = new Date(2026, 8, 17, 9, 5);
  assert.equal(buildReminderLine("Позвонить", date), "- [ ] Позвонить (@17-09-2026 09:05)");
  assert.equal(buildReminderLine("Отчёт", date, "every 1 weeks"), "- [ ] Отчёт (every 1 weeks) (@17-09-2026 09:05)");
  const parsed = parseReminderDueFromText(buildReminderLine("Отчёт", date, "every 1 weeks"));
  assert.ok(parsed);
  assert.equal(parsed.date.getTime(), date.getTime());
  assert.equal(parsed.hasTime, true);
});

test("completed recurring lines in a note get their next occurrence inserted once", () => {
  const now = new Date(2026, 6, 10, 12, 0);
  const content = [
    "# Заметка",
    "- [x] Отчёт (every 1 week) (@01-07-2026 10:00)",
    "- [ ] Обычная задача (@20-07-2026 10:00)",
  ].join("\n");
  const next = insertNextRecurrenceLines(content, now);
  assert.equal(
    next,
    [
      "# Заметка",
      "- [x] Отчёт (@01-07-2026 10:00)",
      "- [ ] Отчёт (every 1 week) (@15-07-2026 10:00)",
      "- [ ] Обычная задача (@20-07-2026 10:00)",
    ].join("\n")
  );
  // Повторный проход ничего не меняет (тот же объект строки - файл не пишется)
  assert.equal(insertNextRecurrenceLines(next, now), next);
  // Следующее вхождение уже стоит под строкой - только снимается повторение с выполненной
  const alreadyThere = ["- [x] Отчёт (every 1 week) (@01-07-2026 10:00)", "- [ ] Отчёт (every 1 week) (@15-07-2026 10:00)"].join("\n");
  assert.equal(
    insertNextRecurrenceLines(alreadyThere, now),
    ["- [x] Отчёт (@01-07-2026 10:00)", "- [ ] Отчёт (every 1 week) (@15-07-2026 10:00)"].join("\n")
  );
  const untouched = "- [ ] Открытая (every 1 week) (@01-07-2026 10:00)\n- [x] Без даты (every 1 week)";
  assert.equal(insertNextRecurrenceLines(untouched, now), untouched);
});

test("recurrence requires a positive safe integer", () => {
  assert.equal(parseRecurrenceFromText("Task (every 0 days)"), null);
  assert.equal(parseCompletedTaskWithRecurrence("- [x] Task (every 0 days) (@01-07-2026)"), null);
  assert.ok(parseRecurrenceFromText("Task (every 2 weeks)"));
});

test("month and year recurrence clamp to the target month", () => {
  const january31 = new Date(2025, 0, 31, 10, 0);
  const february = addRecurrencePeriod(january31, 1, "month");
  assert.equal(february.getFullYear(), 2025);
  assert.equal(february.getMonth(), 1);
  assert.equal(february.getDate(), 28);

  const leapDay = new Date(2024, 1, 29, 10, 0);
  const nextYear = addRecurrencePeriod(leapDay, 1, "year");
  assert.equal(nextYear.getFullYear(), 2025);
  assert.equal(nextYear.getMonth(), 1);
  assert.equal(nextYear.getDate(), 28);
});

test("next recurrence stays on its scheduled grid", () => {
  const parsed = parseCompletedTaskWithRecurrence(
    "- [x] Weekly report (every 1 week) (@01-07-2026 10:00)"
  );
  assert.ok(parsed);
  const line = buildNextRecurrenceLine(
    parsed,
    new Date(2026, 6, 1, 10, 0),
    new Date(2026, 6, 10, 10, 0)
  );
  assert.match(line ?? "", /\(@15-07-2026 10:00\)/);
});

test("reminder identity ignores checkbox, recurrence, date and reward marker", () => {
  const completed = "- [x] Report (every 1 week) (@01-07-2026 10:00) <!-- opa-reminder-reward:id -->";
  const next = "- [ ] Report (every 1 week) (@08-07-2026 10:00)";
  assert.equal(normalizeReminderIdentity(completed), normalizeReminderIdentity(next));
});

test("task description append only matches the exact level-two heading", () => {
  const content = [
    "---",
    "status: active",
    "---",
    "",
    "Описание задачи упомянуто в обычном абзаце.",
    "",
    "### Описание задачи",
    "Текст подзаголовка",
  ].join("\n");

  const result = appendLineToTaskDescriptionContent(content, "Комментарий");

  assert.match(result, /---\n\n## Описание задачи\n- Комментарий\nОписание задачи упомянуто/);
  assert.match(result, /### Описание задачи\nТекст подзаголовка$/);
});

test("task description append stays inside the existing section", () => {
  const content = [
    "# Задача",
    "",
    "##   Описание   задачи",
    "Исходное описание",
    "",
    "### Детали",
    "Подробности",
    "",
    "## Следующая секция",
    "Не изменять",
  ].join("\n");

  const result = appendLineToTaskDescriptionContent(content, "  Новый комментарий  ");

  assert.match(result, /### Детали\nПодробности\n- Новый комментарий\n## Следующая секция/);
  assert.match(result, /## Следующая секция\nНе изменять$/);
});

test("task description append ignores an empty line", () => {
  const content = "## Описание задачи\nТекст";
  assert.equal(appendLineToTaskDescriptionContent(content, "   "), content);
});

test("task description section is created at the top of a note without frontmatter, ignoring horizontal rules", () => {
  // Раньше «\n---» горизонтальной линии принималось за конец frontmatter, и раздел вставлялся после неё
  const withRule = "Вступление\n\n---\n\nПродолжение";
  assert.equal(
    appendLineToTaskDescriptionContent(withRule, "Комментарий"),
    "## Описание задачи\n- Комментарий\nВступление\n\n---\n\nПродолжение"
  );
  assert.equal(appendLineToTaskDescriptionContent("", "Комментарий"), "## Описание задачи\n- Комментарий\n");
  // С frontmatter (CRLF тоже) - сразу после него, через пустую строку
  assert.equal(
    appendLineToTaskDescriptionContent("---\r\nstatus: x\r\n---\r\nТекст", "Комментарий"),
    "---\r\nstatus: x\r\n---\n\n## Описание задачи\n- Комментарий\nТекст"
  );
});

test("task description append falls back to the misspelled or differently cased heading", () => {
  // Старые задачи по шаблонам с опечаткой «Описании»: раньше рядом создавался второй раздел
  const misspelled = ["---", "status: В работе", "---", "## Описании задачи", "", "## Критерий выполнения", "Готово"].join("\n");
  const result = appendLineToTaskDescriptionContent(misspelled, "05-09-2026: В работе → Готово");
  assert.equal(result.split("## Описани").length - 1, 1, "второй раздел описания не создаётся");
  assert.match(result, /## Описании задачи\n- 05-09-2026: В работе → Готово\n## Критерий выполнения/);

  const lowerCase = "## описание задачи\nТекст\n\n## Другое";
  assert.match(appendLineToTaskDescriptionContent(lowerCase, "Комментарий"), /## описание задачи\nТекст\n- Комментарий\n## Другое/);

  // Точный заголовок важнее запасного, даже если стоит ниже
  const both = ["## Описании задачи", "Старый текст", "", "## Описание задачи", "- Первый комментарий"].join("\n");
  assert.match(appendLineToTaskDescriptionContent(both, "Второй"), /## Описание задачи\n- Первый комментарий\n- Второй\n?$/);
  assert.match(appendLineToTaskDescriptionContent(both, "Второй"), /## Описании задачи\nСтарый текст\n\n## Описание задачи/);

  // Заголовок третьего уровня и упоминание в тексте запасным вариантом не считаются
  const noSection = "### Описании задачи\nТекст\nописание задачи в абзаце";
  const created = appendLineToTaskDescriptionContent(noSection, "Комментарий");
  assert.match(created, /## Описание задачи\n- Комментарий\n### Описании задачи\nТекст\nописание задачи в абзаце$/);
  assert.equal(created.split("## Описание задачи").length - 1, 1);
});
