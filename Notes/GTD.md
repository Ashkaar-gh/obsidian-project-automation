---
cssclasses:
  - wide-page
  - three-column-grid-list
---
- [[Reminders]]
- [[Inbox]]
- [[Trash]]

#### Напоминания
```dataviewjs
await dv.view("dataview-scripts/reminders-view", { obsidian: obsidian });
```

#### Входящие
```dataviewjs
await dv.view("dataview-scripts/inbox-view", { obsidian: obsidian });
```

#### Корзина
```dataviewjs
await dv.view("dataview-scripts/trash-view");
```

#### Доска задач
```dataviewjs
await dv.view("dataview-scripts/gtd-view", { obsidian: obsidian });
```
