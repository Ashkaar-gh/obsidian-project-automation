---
project: %%project%%
context: %%context%%
environment: %%environment%%
status: В работе
date: %%date%%
group: %%group%%
cssclasses:
  - wide-page
---
## Описание задачи

## Критерий выполнения

## Список подзадач
- [ ] 
Задача: %%task%%
Реквест: %%request%%
Тред: %%thread%%

Правим конфиг %%config_file%%
```bash
cd /opt/app
nano %%config_file%%
```

Деплоим
```bash
cd /opt/app
git status
git diff
git pull
git add .
git commit -m "%%commit_message%%"
git push
```

```dataviewjs
await dv.view("dataview-scripts/task-view", { obsidian: obsidian });
```
