---
project: %%projectName%%
cssclasses:
  - wide-page
  - table-divider
---

```dataviewjs
// Вызываем внешний скрипт и передаем ему объект 'obsidian' в качестве входных данных.
await dv.view("dataview-scripts/project-view", { obsidian: obsidian });
```
