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
![image](https://github.com/user-attachments/assets/abc9828b-e911-40a1-8e27-7ab5d0f73f59)
## Calendar 
А для удобства создания и управления ежедневными заметками используем плагин Calendar.
![image](https://github.com/user-attachments/assets/63bcdd4f-2946-42c3-8a6f-d71a87de1165)
## Periodic Notes
Надо задать формат даты и папку для хранения ежедневных заметок.
![image](https://github.com/user-attachments/assets/25c76431-2adc-4463-b44f-affa2f43645a)
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

![image](https://github.com/user-attachments/assets/eb5c42b8-82f0-4474-89f7-638d981d7b54)
## Dataview
Включаем поддержку JS
![image](https://github.com/user-attachments/assets/aabe23f7-a72d-49fc-a793-366aca079b75)

# Шаблоны
## main
Это центральный шаблон.

## daily
Шаблон для ежедневных заметок.

![image](https://github.com/user-attachments/assets/6101aa82-d51d-4819-a498-30558c22adfe)

## project
Шаблон для заметок с типом проект.

![image](https://github.com/user-attachments/assets/7e862eaf-fa3e-4e6a-afe1-8bc5b06528f9)

## task
Шаблон для заметок с типом задача.

![image](https://github.com/user-attachments/assets/6480e693-1062-4ada-8cd8-81c46413d407)

# Ссылки
- Dataview JavaScript API: https://blacksmithgu.github.io/obsidian-dataview/api/intro/
- Документацию Templater: https://silentvoid13.github.io/Templater/introduction.html
- Obsidian Docs: https://docs.obsidian.md/Reference/TypeScript+API/AbstractInputSuggest/(constructor)
- Статья на Habr: https://habr.com/ru/articles/852246/
