import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskContentTargetFromTemplate,
  removeLinesWithUnfilledPlaceholders,
  splitTemplateBodyByTarget,
} from "../src/core/TaskTemplateContent";

/** Шаблон вида Trino ACL: скелет в задачу, runbook - в ежедневную. */
const WITH_DAILY_PART = [
  "---",
  "title: Trino ACL",
  "opa_project: Trino",
  "opa_content_target: task",
  "---",
  "<!-- opa:task -->",
  "## Описание задачи",
  "",
  "## Список подзадач",
  "- [ ] ",
  "",
  "```opa-task-view",
  "```",
  "",
  "<!-- opa:daily -->",
  "Задача: %%task%%",
  "Реквест: %%request%%",
  "Правим values файл %%values_file%%",
  "```bash",
  "cd /opt/argocd/Helms/trino",
  "nano %%values_file%%",
  "```",
  "",
  "Деплоим",
  "```bash",
  "git commit -m \"%%commit_message%%\"",
  "```",
].join("\n");

/** Шаблон без маркеров: весь текст идёт в задачу, для ежедневной части нет. */
const TASK_ONLY = ["---", "title: Простая", "---", "## Описание задачи", "", "Текст %%task%%", "", "```opa-task-view", "```"].join(
  "\n"
);

test("template content target comes from frontmatter without a YAML parser", () => {
  assert.equal(parseTaskContentTargetFromTemplate(WITH_DAILY_PART), "task");
  assert.equal(parseTaskContentTargetFromTemplate("---\nopa_content_target: \"Daily\"\n---\nтекст"), "daily");
  assert.equal(parseTaskContentTargetFromTemplate("---\nopa_content_target: both # всё\n---\n"), "both");
  assert.equal(parseTaskContentTargetFromTemplate("---\nopa_content_target: nowhere\n---\n"), "task");
  assert.equal(parseTaskContentTargetFromTemplate(TASK_ONLY), "task");
  assert.equal(parseTaskContentTargetFromTemplate("без frontmatter"), "task");
});

test("template body splits by markers and keeps the default target before the first marker", () => {
  const split = splitTemplateBodyByTarget("общее\n<!-- opa:daily -->\nдень\n%%opa:task%%\nзадача\n<!-- OPA:both -->\nоба", "task");
  assert.equal(split.taskBody, "общее\nзадача\nоба");
  assert.equal(split.dailyBody, "день\nоба");
  const dailyDefault = splitTemplateBodyByTarget("всё в день\n<!-- opa:default -->\nи это", "daily");
  assert.equal(dailyDefault.taskBody, "");
  assert.equal(dailyDefault.dailyBody, "всё в день\nи это");
});

test("only the task part of a template reaches the task note; the daily part is ignored", () => {
  const target = parseTaskContentTargetFromTemplate(WITH_DAILY_PART);
  const body = WITH_DAILY_PART.split("\n---\n")[1];
  const { taskBody, dailyBody } = splitTemplateBodyByTarget(body, target);
  // Скелет задачи целиком, без runbook-части
  assert.equal(removeLinesWithUnfilledPlaceholders(taskBody).trim(), "## Описание задачи\n\n## Список подзадач\n- [ ] \n\n```opa-task-view\n```");
  assert.equal(taskBody.includes("Реквест"), false);
  // Часть для ежедневной по-прежнему разбирается (маркеры не ломают задачу), но плагин её не пишет
  assert.match(dailyBody, /^Задача: %%task%%/);
  const plain = splitTemplateBodyByTarget(TASK_ONLY.split("\n---\n")[1], parseTaskContentTargetFromTemplate(TASK_ONLY));
  assert.equal(plain.dailyBody, "");
  assert.match(plain.taskBody, /^## Описание задачи/);
});
