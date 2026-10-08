/**
 * Встроенные шаблоны. Используются, если в хранилище нет файла в templates/.
 */

export const DEFAULT_TASK = `---
project: %%project%%
context: %%context%%
environment: %%environment%%
status: В работе
difficulty: %%difficulty%%
date: %%date%%
deadline: "%%deadline%%"
cssclasses:
  - wide-page
---
## Описание задачи

## Критерий выполнения

## Список подзадач
- [ ] 

\`\`\`opa-task-view
\`\`\`
`;

export const DEFAULT_PROJECT = `---
project: %%projectName%%
cssclasses:
  - wide-page
  - table-divider
---

\`\`\`opa-project-view
\`\`\`
`;

export const DEFAULT_DAILY = `%%daily_nav%%
`;

/** Имя файла примера шаблона задачи в templates/task-templates. */
export const DEFAULT_TASK_TEMPLATE_EXAMPLE_FILENAME = "task-example.md";

/**
 * Пример шаблона задачи для кнопки в настройках. Шаблон задаёт проект и группу (opa_project, opa_group)
 * и скелет заметки; ключи opa_* в созданную задачу не попадают.
 */
export const DEFAULT_TASK_TEMPLATE_EXAMPLE = `---
title: Пример задачи
project: "%%project%%"
context: "%%context%%"
environment: "%%environment%%"
status: В работе
date: "%%date%%"
group: "%%group%%"
cssclasses:
  - wide-page
opa_project: ""
opa_group: ""
---
## Описание задачи

## Критерий выполнения

## Список подзадач
- [ ] 

\`\`\`opa-task-view
\`\`\`
`;

/** Универсальная домашняя страница, поставляемая с плагином. */
export const DEFAULT_HOMEPAGE = `---
cssclasses:
  - three-column-grid-list
  - wide-page
obsidianUIMode: preview
---

\`\`\`opa-gamification-view
\`\`\`

\`\`\`opa-activities-view
\`\`\`

\`\`\`opa-reminders-view
\`\`\`

\`\`\`opa-projects-view
\`\`\`

\`\`\`opa-home-view
\`\`\`

\`\`\`opa-inbox-view
\`\`\`

\`\`\`opa-trash-view
\`\`\`
`;
