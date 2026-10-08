import assert from "node:assert/strict";
import test from "node:test";
import {
  CHOSEN_DAY_OPTION,
  dailyHeadingDropdownValue,
  dailyHeadingFollowingTaskDate,
  isMultiSelectOptionVisible,
  taskDateDropdownValue,
  taskDateKey,
} from "../src/ui/CreateTaskFormState";

test("create task: daily note date follows the task date (today or a chosen day)", () => {
  assert.deepEqual(
    dailyHeadingFollowingTaskDate({ mode: "choose", chosen: "05-09-2026" }, { mode: "today", date: "" }),
    { mode: "choose", date: "05-09-2026" }
  );
  // Ежедневная уже была на другой день - переезжает на день задачи
  assert.deepEqual(
    dailyHeadingFollowingTaskDate({ mode: "choose", chosen: "05-09-2026" }, { mode: "choose", date: "01-09-2026" }),
    { mode: "choose", date: "05-09-2026" }
  );
  assert.deepEqual(
    dailyHeadingFollowingTaskDate({ mode: "today", chosen: "" }, { mode: "choose", date: "01-09-2026" }),
    { mode: "today", date: "" }
  );
  // Режим «выбрать» без даты (окно выбора ещё не закрыто) считается сегодняшним днём
  assert.deepEqual(
    dailyHeadingFollowingTaskDate({ mode: "choose", chosen: "" }, { mode: "choose", date: "01-09-2026" }),
    { mode: "today", date: "" }
  );
});

test("create task: explicit «-» for the daily note is kept when the task date changes", () => {
  const none = { mode: "none" as const, date: "" };
  assert.deepEqual(dailyHeadingFollowingTaskDate({ mode: "choose", chosen: "05-09-2026" }, none), none);
  assert.deepEqual(dailyHeadingFollowingTaskDate({ mode: "today", chosen: "" }, none), none);
});

test("create task: task date key changes only when the effective date changes", () => {
  assert.equal(taskDateKey({ mode: "today", chosen: "" }), taskDateKey({ mode: "today", chosen: "" }));
  assert.notEqual(taskDateKey({ mode: "today", chosen: "" }), taskDateKey({ mode: "choose", chosen: "05-09-2026" }));
  assert.notEqual(
    taskDateKey({ mode: "choose", chosen: "05-09-2026" }),
    taskDateKey({ mode: "choose", chosen: "06-09-2026" })
  );
});

test("create task: a chosen date selects the hidden option so «Выбрать день» can be picked again", () => {
  // «Выбрать день» - действие: после выбора даты <select> стоит на скрытом пункте, а не на «choose»
  assert.equal(taskDateDropdownValue({ mode: "choose", chosen: "05-09-2026" }), CHOSEN_DAY_OPTION);
  assert.equal(taskDateDropdownValue({ mode: "today", chosen: "" }), "today");
  // Окно даты ещё открыто (даты нет) - остаётся сам пункт «choose»
  assert.equal(taskDateDropdownValue({ mode: "choose", chosen: "" }), "choose");

  assert.equal(dailyHeadingDropdownValue({ mode: "choose", date: "05-09-2026" }), CHOSEN_DAY_OPTION);
  assert.equal(dailyHeadingDropdownValue({ mode: "choose", date: "" }), "choose");
  assert.equal(dailyHeadingDropdownValue({ mode: "today", date: "" }), "today");
  assert.equal(dailyHeadingDropdownValue({ mode: "none", date: "" }), "none");
  assert.notEqual(CHOSEN_DAY_OPTION, "choose");
});

test("multi-select filter: checked options stay visible while searching", () => {
  assert.equal(isMultiSelectOptionVisible("Trino", false, "tri"), true);
  assert.equal(isMultiSelectOptionVisible("Alpha", false, "tri"), false);
  assert.equal(isMultiSelectOptionVisible("Alpha", true, "tri"), true);
  // Регистр и пробелы по краям запроса не важны; пустой запрос показывает всё
  assert.equal(isMultiSelectOptionVisible("Trino", false, "  TRI "), true);
  assert.equal(isMultiSelectOptionVisible("Alpha", false, ""), true);
  assert.equal(isMultiSelectOptionVisible("Alpha", false, "   "), true);
});
