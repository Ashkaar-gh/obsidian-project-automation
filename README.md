# Алгоритм работы с проектом
1. Создаем заметку с типом проект.
- Проект автоматически добавляется в заметку Homepage.
- В проекте отображаются все его задачи с датами, статусами и ссылками.
2. Создаем заметку с типом задача.
- Автоматически создается ежедневная заметка.
- В задаче отображается все содержание из ежедневных заметок, относящееся к этой задаче.
3. Вносим записи в ежедневную заметку.

# Используемые плагины
## Templater
Шаблон main должен применяться ко всем вновь созданным заметкам. Это можно реализовать в настройках плагина templater. В разделе Folder templates в качестве директории нужно выбрать / (корень), а в качестве шаблона - main.md.
![image](https://github.com/user-attachments/assets/b819a9b6-6265-47be-be01-b0f9cc6299f6)
## Calendar 
А для удобства создания и управления ежедневными заметками используем плагин Calendar.
![image](https://github.com/user-attachments/assets/c1a9ccce-ee84-43f1-86bf-58e8309bea90)
## Periodic Notes
Надо задать формат даты и папку для хранения ежедневных заметок.
![image](https://github.com/user-attachments/assets/0c473a7b-4162-4046-870b-836a795bfcc7)
## Kanban
Доску называем Рабочие задачи.

Используем следующие колонки: 
- Backlog
- To do
- В работе
- Тестирование
- Done
- Canceled
- Повторяющиеся

![image](https://github.com/user-attachments/assets/f2bb688a-1fee-4889-8dce-d7d7a6ab86fe)
## Dataview
Включаем поддержку JS
![image](https://github.com/user-attachments/assets/cab6b72b-3b6f-4581-943a-447e05be0e3e)

# Шаблоны
## main
Это центральный шаблон.

## daily
Шаблон для ежедневных заметок.

![image](https://github.com/user-attachments/assets/c48c5db2-07e9-4c2d-840a-6a924122699e)

## project
Шаблон для заметок с типом проект.

![image](https://github.com/user-attachments/assets/41dd0035-f6c3-43dc-aafd-1984bdcd8034)

## task
Шаблон для заметок с типом задача.

![image](https://github.com/user-attachments/assets/be26d96b-f99e-4eeb-8e57-1e2acf47a407)


# Ссылки
- Dataview JavaScript API: https://blacksmithgu.github.io/obsidian-dataview/api/intro/
- Документацию Templater: https://silentvoid13.github.io/Templater/introduction.html
- Obsidian Docs: https://docs.obsidian.md/Reference/TypeScript+API/AbstractInputSuggest/(constructor)
- Статья на Habr: https://habr.com/ru/articles/852246/
