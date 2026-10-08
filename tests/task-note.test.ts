import assert from "node:assert/strict";
import test from "node:test";
import {
  addProjectInboxBlock,
  addTaskInboxBlock,
  hasProjectInboxBlock,
  hasTaskInboxBlock,
  isProjectHubPage,
  isTaskNote,
  isTemplateFile,
  moveTaskInboxBlockToTaskView,
} from "../src/core/TaskNote";

test("task note: any of status/project/group in frontmatter, but not the project's own page", () => {
  const task = { path: "Выдать доступ.md", basename: "Выдать доступ" };
  assert.equal(isTaskNote(task, { frontmatter: { status: "В работе" } }), true);
  assert.equal(isTaskNote(task, { frontmatter: { project: "Trino" } }), true);
  assert.equal(isTaskNote(task, { frontmatter: { group: "Доступы" } }), true);
  assert.equal(isTaskNote(task, { frontmatter: { cssclasses: ["wide-page"] } }), false);
  assert.equal(isTaskNote(task, { frontmatter: undefined }), false);
  assert.equal(isTaskNote(task, null), false);
  assert.equal(isTaskNote(task, undefined), false);

  // Страница проекта: project совпадает с именем файла (с папкой, .md и списком тоже)
  const hub = { path: "Проекты/Trino.md", basename: "Trino" };
  assert.equal(isProjectHubPage(hub, { project: "Trino" }), true);
  assert.equal(isProjectHubPage(hub, { project: "Проекты/Trino.md" }), true);
  assert.equal(isProjectHubPage(hub, { project: ["Другой", "Trino"] }), true);
  assert.equal(isProjectHubPage(hub, { project: "Другой" }), false);
  assert.equal(isTaskNote(hub, { frontmatter: { project: "Trino", status: "В работе" } }), false);
});

test("template files are recognised by folder", () => {
  assert.equal(isTemplateFile({ path: "templates/task-templates/task-trino-acl.md", basename: "task-trino-acl" }), true);
  assert.equal(isTemplateFile({ path: "templates/task.md", basename: "task" }), true);
  assert.equal(isTemplateFile({ path: "Задача.md", basename: "Задача" }), false);
  assert.equal(isTemplateFile({ path: "templates-old/x.md", basename: "x" }), false);
});

const BLOCK = "```opa-task-inbox\n```";
const VIEW = "```opa-task-view\n```";

test("notepad block goes right before the task view (its «Оглавление»), once", () => {
  const task = `---\nstatus: В работе\n---\n## Описание задачи\n\n## Список подзадач\n- [ ] \n\n${VIEW}\n`;
  const withBlock = addTaskInboxBlock(task)!;
  assert.equal(withBlock, `---\nstatus: В работе\n---\n## Описание задачи\n\n## Список подзадач\n- [ ] \n\n${BLOCK}\n\n${VIEW}\n`);
  assert.ok(hasTaskInboxBlock(withBlock));
  assert.equal(addTaskInboxBlock(withBlock), null, "a second block is not added");
  assert.equal(hasTaskInboxBlock(task), false);

  // Пустые строки перед блоком задачи не копятся; блок задачи сразу под текстом - пустая строка появляется
  assert.equal(addTaskInboxBlock(`текст\n\n\n${VIEW}`), `текст\n\n${BLOCK}\n\n${VIEW}`);
  assert.equal(addTaskInboxBlock(`- [ ] шаг\n${VIEW}\n`), `- [ ] шаг\n\n${BLOCK}\n\n${VIEW}\n`);
  // Блок задачи сразу после frontmatter
  assert.equal(addTaskInboxBlock(`---\nstatus: a\n---\n${VIEW}\n`), `---\nstatus: a\n---\n\n${BLOCK}\n\n${VIEW}\n`);
  // «opa-task-view» внутри другого блока кода - не блок задачи
  assert.equal(addTaskInboxBlock("````md\n```opa-task-view\n```\n````\n"), `\`\`\`\`md\n\`\`\`opa-task-view\n\`\`\`\n\`\`\`\`\n\n${BLOCK}\n`);
});

test("notepad block without a task view goes to the end of the note", () => {
  assert.equal(addTaskInboxBlock("---\nstatus: a\n---\n## Описание\nтекст\n\n\n"), `---\nstatus: a\n---\n## Описание\nтекст\n\n${BLOCK}\n`);
  assert.equal(addTaskInboxBlock("---\nstatus: a\n---"), `---\nstatus: a\n---\n\n${BLOCK}\n`);
  assert.equal(addTaskInboxBlock(""), `${BLOCK}\n`);
  // Переводы строк Windows сохраняются
  assert.equal(
    addTaskInboxBlock("---\r\nstatus: a\r\n---\r\nтекст\r\n\r\n```opa-task-view\r\n```\r\n"),
    "---\r\nstatus: a\r\n---\r\nтекст\r\n\r\n```opa-task-inbox\r\n```\r\n\r\n```opa-task-view\r\n```\r\n"
  );
  // Блок, вставленный руками в другое место (и с ~~~), тоже считается
  assert.ok(hasTaskInboxBlock("## Описание\n\n~~~ opa-task-inbox\n~~~\n"));
  assert.equal(hasTaskInboxBlock("```opa-task-inbox-old\n```"), false);
});

test("the block the previous version put at the start of a task moves before the task view", () => {
  const old = `---\nstatus: В работе\n---\n${BLOCK}\n\n## Описание задачи\n\n## Список подзадач\n- [ ] \n\n${VIEW}\n`;
  assert.equal(
    moveTaskInboxBlockToTaskView(old),
    `---\nstatus: В работе\n---\n## Описание задачи\n\n## Список подзадач\n- [ ] \n\n${BLOCK}\n\n${VIEW}\n`
  );
  // Заметка без frontmatter, пустые строки вокруг блока
  assert.equal(moveTaskInboxBlockToTaskView(`\n${BLOCK}\n\n\nтекст\n${VIEW}`), `\nтекст\n\n${BLOCK}\n\n${VIEW}`);
  // Не трогается: блок уже перед блоком задачи, стоит не в начале, не пустой, блока задачи нет или он выше
  assert.equal(moveTaskInboxBlockToTaskView(`---\na: 1\n---\n${BLOCK}\n\n${VIEW}\n`), null);
  assert.equal(moveTaskInboxBlockToTaskView(`---\na: 1\n---\nтекст\n\n${BLOCK}\n\nещё\n\n${VIEW}\n`), null);
  assert.equal(moveTaskInboxBlockToTaskView(`---\na: 1\n---\n\`\`\`opa-task-inbox\nзаметка\n\`\`\`\n\nтекст\n${VIEW}\n`), null);
  assert.equal(moveTaskInboxBlockToTaskView(`---\na: 1\n---\n${BLOCK}\n\nтекст\n`), null);
  assert.equal(moveTaskInboxBlockToTaskView(`${VIEW}\n\n${BLOCK}\n`), null);
  assert.equal(moveTaskInboxBlockToTaskView("текст"), null);
});

test("project notepad block goes before the project's task list, or to the end; once", () => {
  const project = "---\nproject: Trino\ncssclasses:\n  - wide-page\n---\n\n```opa-project-view\n```\n";
  const withBlock = addProjectInboxBlock(project)!;
  assert.equal(withBlock, "---\nproject: Trino\ncssclasses:\n  - wide-page\n---\n\n```opa-project-inbox\n```\n\n```opa-project-view\n```\n");
  assert.ok(hasProjectInboxBlock(withBlock));
  assert.equal(hasTaskInboxBlock(withBlock), false, "the task block is another block");
  assert.equal(addProjectInboxBlock(withBlock), null);
  assert.equal(addProjectInboxBlock("---\nproject: Kafka\n---\nзаметки\n"), "---\nproject: Kafka\n---\nзаметки\n\n```opa-project-inbox\n```\n");
});
