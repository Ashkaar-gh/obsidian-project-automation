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
## Описании задачи

## Критерий выполнения

## Cписок подзадач
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

/** Пример шаблона задачи для кнопки в настройках. Показывает suggester и связанные поля. */
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
opa_labels:
  task: Задача
  details: Детали
  preset: Вариант
  env_name: Окружение
  env_url: URL
opa_prompts:
  - key: task
    label: Задача
    optional: true
  - key: details
    label: Детали
    optional: true
  - key: preset
    label: Вариант
    type: suggester
    options:
      - id: prod
        label: Production
        values:
          env_name: Production
          env_url: https://prod.example.com
      - id: staging
        label: Staging
        values:
          env_name: Staging
          env_url: https://staging.example.com
      - id: dev
        label: Dev
        values:
          env_name: Dev
          env_url: https://dev.example.com
---
## Описание задачи

## Критерии выполнения

## Подзадачи
- [ ] 

Задача: %%task%%
Детали: %%details%%

Выбран вариант: **%%env_name%%** — %%env_url%%

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
