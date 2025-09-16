---
cssclasses:
  - wide-page
obsidianUIMode: preview
---
[[GTD-scheme.canvas|GTD-scheme]]
[[Inbox]]
[[Trash]]

#### In progress
```tasks
path does not include kanban
path does not include templates
status.name includes unknown
no due date
no scheduled date
is not blocked
```
##### Blocked
```tasks
path does not include kanban
path does not include templates
status.name includes unknown
no due date
no scheduled date
is blocked
```
##### Recurring
```tasks
is recurring
not done
sort by scheduled
```

#### To do
```tasks
status.type is in_progress
path does not include kanban
path does not include templates
no due date
no scheduled date
```

#### Waiting
```tasks
status.type is NON_TASK
path does not include kanban
path does not include templates
no due date
no scheduled date
```

#### Inbox
```dataviewjs
// Вызываем внешний скрипт и передаем ему объект 'obsidian' в качестве входных данных.
await dv.view("dataview-scripts/inbox-view", { obsidian: obsidian });
```

#### Trash
```dataviewjs
// Вызываем внешний скрипт
await dv.view("dataview-scripts/trash-view");
```

#### Done this week
```tasks
done this week
sort by done reverse
```
