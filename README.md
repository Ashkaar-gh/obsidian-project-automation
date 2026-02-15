# Obsidian Project Automation
Набор шаблонов и скриптов для автоматизации проектов и задач в Obsidian: GTD-воркфлоу (входящие, напоминания, доска задач), создание заметок по типам и интеграция с ежедневными заметками.

# Используемые плагины
## Templater
Шаблон main должен применяться ко всем вновь созданным заметкам. Это можно реализовать в настройках плагина templater. В разделе Folder templates в качестве директории нужно выбрать / (корень), а в качестве шаблона - main.md.

<img width="587" height="512" alt="Screenshot 2025-09-02 221854" src="https://github.com/user-attachments/assets/bb8bc332-8ac6-45da-a91d-5901ca03d04c" />

Для ежедневных заметок используем шаблон daily.md. При старте загружается шаблон startup.md.
<img width="700" height="170" alt="изображение" src="https://github.com/user-attachments/assets/7a6ec0db-e7f3-4b8c-9333-a0a398f88406" />

Добавляем каталог templater-scripts, в котором лежат js функции используемые в шаблонах
<img width="700" height="140" alt="image" src="https://github.com/user-attachments/assets/bb9ba497-2da6-4a17-80a7-9fa6762a8a36" />
## Calendar 
А для удобства создания и управления ежедневными заметками используем плагин Calendar.
![image](https://github.com/user-attachments/assets/63bcdd4f-2946-42c3-8a6f-d71a87de1165)
## Periodic Notes
Надо задать формат даты и папку для хранения ежедневных заметок.
![image](https://github.com/user-attachments/assets/25c76431-2adc-4463-b44f-affa2f43645a)

## Dataview
Включаем поддержку JS
![image](https://github.com/user-attachments/assets/aabe23f7-a72d-49fc-a793-366aca079b75)
Отключаем авторефреши

<img width="563" height="64" alt="Screenshot 2025-09-16 205913" src="https://github.com/user-attachments/assets/727dc5d4-a830-47ae-acc1-0fd61735864b" />

# Шаблоны
## project
Шаблон для заметок с типом проект.

<img width="1984" height="705" alt="изображение" src="https://github.com/user-attachments/assets/4ee36f09-fa41-40a2-9824-282865c651f3" />

## task
Шаблон для заметок с типом задача.

<img width="1977" height="1175" alt="изображение" src="https://github.com/user-attachments/assets/9cc3732b-011f-4381-930d-2a2b4d931f02" />

## daily
Шаблон для ежедневных заметок.

<img width="250" height="159" alt="изображение" src="https://github.com/user-attachments/assets/c048075a-0880-4c15-8b09-2a0bc5eb7cf6" />

# Ссылки
- Dataview JavaScript API: https://blacksmithgu.github.io/obsidian-dataview/api/intro/
- Документацию Templater: https://silentvoid13.github.io/Templater/introduction.html
- Obsidian Docs: https://docs.obsidian.md/Reference/TypeScript+API/AbstractInputSuggest/(constructor)
- Статья на Habr: https://habr.com/ru/articles/852246/
