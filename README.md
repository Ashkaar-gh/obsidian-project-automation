# Алгоритм работы
1. Создаем заметку с типом kanban.
Для удобства можно создать несколько kanban досок, например, для работы, личных дел и хобби.
- Kanban доска автоматически добаляется в заметку Homepage.
2. Создаем заметку с типом проект.
В проекте отображаются все его задачи с датами, статусами и ссылками.
- Проект автоматически добавляется в заметку Homepage.
3. Создаем заметку с типом задача.
В задаче отображается все содержание из ежедневных заметок, относящееся к этой задаче.
- Автоматически создается ежедневная заметка текущего дня, в которую добавляется заголовок задачи.
- Задача автоматически попадает в выбранную kanban доску в колонку "В работе".
4. Вносим записи в ежедневную заметку под заговком задачи.

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
Все доски лежат в каталоге kanban.

В доске используем следующие колонки: 
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

## Tasks
Задача без статуса сначала получает статус To do, при следующем нажатии - In progress, при следующем - Done.

![image](https://github.com/user-attachments/assets/fd59195e-b44d-4e8e-8369-e80aec89ec3d)

# Шаблоны
## main
Это центральный шаблон, в котором выбирается тип создаваемой заметки.

![image](https://github.com/user-attachments/assets/594d11c0-b670-4acd-a36e-6621084e9491)

## kanban
Шаблон для заметок с типом kanban.

![image](https://github.com/user-attachments/assets/e2cedef0-5c26-4314-babb-74875a219a46)

## project
Шаблон для заметок с типом проект.

![image](https://github.com/user-attachments/assets/5173b5c7-6d6a-4b06-9d38-95002f0271e8)

## task
Шаблон для заметок с типом задача.

![image](https://github.com/user-attachments/assets/04fe4c3b-ea5a-4764-ac72-b6250cac31b0)

## daily
Шаблон для ежедневных заметок.

![image](https://github.com/user-attachments/assets/b517d996-2079-49f1-85b8-6e00562403c4)

# Ссылки
- Dataview JavaScript API: https://blacksmithgu.github.io/obsidian-dataview/api/intro/
- Документацию Templater: https://silentvoid13.github.io/Templater/introduction.html
- Obsidian Docs: https://docs.obsidian.md/Reference/TypeScript+API/AbstractInputSuggest/(constructor)
- Статья на Habr: https://habr.com/ru/articles/852246/
