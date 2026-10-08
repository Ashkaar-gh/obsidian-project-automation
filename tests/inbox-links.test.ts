import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLinkOptions,
  filterLinkOptions,
  groupInboxEntries,
  headingLinkTargetsAtLine,
  inboxLinkKey,
  isOpenTaskStatus,
  isSameProject,
  linkOptionLabel,
  matchProjectsInList,
  optionToLink,
  projectDisplayName,
  projectLinkTarget,
  sortTasksByStatus,
  taskProjectValues,
  taskStatusLabel,
  type InboxTaskOption,
} from "../src/core/InboxLinks";

function task(name: string, projects: string[] = [], lastActivity = 0, status = "В работе"): InboxTaskOption {
  return { kind: "task", path: `${name}.md`, name, projects, lastActivity, status };
}

const names = (options: Array<{ kind: string; name: string }>) => options.map((o) => `${o.kind}:${o.name}`);

test("project names: folder, .md and [[link]] are dropped for display; the link target keeps the folder", () => {
  assert.equal(projectDisplayName("Проекты/Тест"), "Тест");
  assert.equal(projectDisplayName("[[Проекты/Тест]]"), "Тест");
  assert.equal(projectDisplayName("[[Проекты/Тест|Мой тест]]"), "Мой тест");
  assert.equal(projectDisplayName("Trino.md"), "Trino");
  assert.equal(projectLinkTarget("[[Проекты/Тест|Мой тест]]"), "Проекты/Тест");
  assert.equal(projectLinkTarget(" Trino "), "Trino");
});

test("one project: with and without the folder, as a [[link]], in any case; an empty name is no project", () => {
  assert.equal(isSameProject("Проекты/Trino", "Trino"), true);
  assert.equal(isSameProject("[[Проекты/Trino]]", "trino"), true);
  assert.equal(isSameProject(" Trino.md ", "TRINO"), true);
  assert.equal(isSameProject("Trino ACL", "Trino"), false);
  assert.equal(isSameProject("Проекты/Spark", "Trino"), false);
  assert.equal(isSameProject("", ""), false);
});

test("task projects from frontmatter: comma list, YAML list and empty values", () => {
  assert.deepEqual(taskProjectValues("Trino, Spark"), ["Trino", "Spark"]);
  assert.deepEqual(taskProjectValues(["Trino", ["Проекты/Spark"], null, ""]), ["Trino", "Проекты/Spark"]);
  assert.deepEqual(taskProjectValues(undefined), []);
});

test("statuses: labels as on the board, open and closed tasks", () => {
  assert.equal(taskStatusLabel("В работе"), "⚙️ В работе");
  assert.equal(taskStatusLabel("backlog"), "🗒️ Backlog");
  assert.equal(taskStatusLabel("Готово"), "☑️ Готово");
  assert.equal(taskStatusLabel("Ждёт ответа"), "Ждёт ответа", "an unknown status is shown as written");
  assert.equal(taskStatusLabel(" "), "", "no status - no label");
  assert.ok(isOpenTaskStatus("В работе") && isOpenTaskStatus("") && isOpenTaskStatus("Ждёт ответа"));
  assert.ok(!isOpenTaskStatus("Готово") && !isOpenTaskStatus("Отменено"));
});

test("tasks by status: «В работе» first, closed ones last, recent first within a status", () => {
  const sorted = sortTasksByStatus([
    task("Сделанная", [], 9, "Готово"),
    task("Бэклог", [], 8, "Backlog"),
    task("Старая в работе", [], 1),
    task("Без статуса", [], 7, ""),
    task("Свежая в работе", [], 5),
    task("Отменённая", [], 9, "Отменено"),
    task("Тест", [], 3, "Тестирование"),
  ]);
  assert.deepEqual(sorted.map((t) => t.name), [
    "Свежая в работе",
    "Старая в работе",
    "Тест",
    "Бэклог",
    "Без статуса",
    "Сделанная",
    "Отменённая",
  ]);
});

test("options: all projects on top (the list, task projects, no repeats), busy ones first; then all tasks", () => {
  const options = buildLinkOptions(
    [
      task("Старая", ["Trino"], 1),
      task("Свежая", ["Проекты/Spark", "Spark"], 5, "Backlog"),
      task("Сделанная", ["Kafka"], 9, "Готово"),
    ],
    ["Проекты/Trino", "Spark", "проекты/trino", "Тихий", ""]
  );
  assert.deepEqual(names(options), [
    "project:Trino", // есть задача «В работе»
    "project:Spark", // есть незакрытая задача
    "project:Тихий", // из списка проектов, задач нет
    "project:Kafka", // только из задачи, и та закрыта
    "task:Старая",
    "task:Свежая",
    "task:Сделанная",
  ]);
  assert.equal(linkOptionLabel(options[5]), "Свежая · Spark");
  assert.equal(linkOptionLabel(options[0]), "Trino");
  assert.deepEqual(optionToLink(options[5]), { task: "Свежая.md" });
  assert.deepEqual(optionToLink(options[0]), { project: "Проекты/Trino" }, "the list value wins over a task's spelling");
});

test("search: every word must match; projects first, tasks by status, own name before project; ё and case do not matter", () => {
  const options = buildLinkOptions(
    [
      task("Trino ACL", ["Trino"], 2, "Backlog"),
      task("Выдать доступ", ["Trino"], 3),
      task("Trino SA", ["Trino"], 1),
      task("Отчёт", ["Spark"], 1),
    ],
    ["Trino"]
  );
  assert.deepEqual(
    filterLinkOptions(options, "trino").map((o) => o.name),
    ["Trino", "Trino SA", "Выдать доступ", "Trino ACL"],
    "in-work tasks before the backlog one, even if it matches only by project"
  );
  assert.deepEqual(filterLinkOptions(options, "доступ TRINO").map((o) => o.name), ["Выдать доступ"]);
  assert.deepEqual(filterLinkOptions(options, "отчет").map((o) => o.name), ["Отчёт"]);
  assert.equal(filterLinkOptions(options, "  ").length, 6);
  assert.deepEqual(filterLinkOptions(options, "", 2).map((o) => o.name), ["Trino", "Spark"]);
  assert.deepEqual(filterLinkOptions(options, "kafka"), []);
});

test("context: links of the headings above the line, from the nearest one outwards", () => {
  const lines = [
    "---",
    "# [[Не заголовок]]",
    "---",
    "← навигация →",
    "### [[Trino ACL|ACL]]",
    "#### Образ",
    "```bash",
    "# комментарий, не заголовок",
    "```",
    "текст",
    "#### [[Справка]]",
    "ещё",
    "## Встречи",
    "заметка",
  ];
  assert.deepEqual(headingLinkTargetsAtLine(lines, 3), [], "above every heading");
  assert.deepEqual(headingLinkTargetsAtLine(lines, 4), ["Trino ACL"], "on the heading line itself");
  assert.deepEqual(headingLinkTargetsAtLine(lines, 9), ["Trino ACL"], "a sub-heading and code do not hide the task");
  assert.deepEqual(headingLinkTargetsAtLine(lines, 11), ["Справка", "Trino ACL"], "nearest heading link first");
  assert.deepEqual(headingLinkTargetsAtLine(lines, 13), [], "a higher heading ends the task section");
});

test("form project: values are matched to the form's project list, unknown ones kept as is", () => {
  const list = ["Проекты/Trino", "Spark"];
  assert.equal(matchProjectsInList("trino", list), "Проекты/Trino");
  assert.equal(matchProjectsInList("Trino, spark, Trino", list), "Проекты/Trino, Spark");
  assert.equal(matchProjectsInList("Kafka", list), "Kafka");
  assert.equal(matchProjectsInList("", list), "");
});

test("grouping: entries with one link (two or more) form a group in place of the earliest one", () => {
  assert.equal(inboxLinkKey({ task: "Папка/T.md" }), "task:Папка/T.md");
  assert.equal(inboxLinkKey({ project: "Проекты/Trino" }), inboxLinkKey({ project: "trino" }));
  assert.equal(inboxLinkKey(null), null);
  const links: Record<string, { task?: string; project?: string }> = {
    a: { task: "T.md" },
    c: { task: "T.md" },
    d: { project: "Проекты/Trino" },
    e: { project: "trino" },
    f: { task: "U.md" },
  };
  const items = groupInboxEntries(["a", "b", "c", "d", "e", "f"], (line) => links[line]);
  assert.deepEqual(items, [
    { kind: "group", key: "task:T.md", lines: ["a", "c"] },
    { kind: "entry", line: "b" },
    { kind: "group", key: "project:trino", lines: ["d", "e"] },
    { kind: "entry", line: "f" },
  ]);
  assert.deepEqual(
    groupInboxEntries(["x", "y"], () => null),
    [{ kind: "entry", line: "x" }, { kind: "entry", line: "y" }],
    "entries without links are never grouped"
  );
});
