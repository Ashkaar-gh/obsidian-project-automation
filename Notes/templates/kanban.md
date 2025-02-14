---

kanban-plugin: board

---
<%*
// Получаем путь до заметки Homepage
const homepageFile = await app.vault.getAbstractFileByPath('Homepage.md');

// Читаем содержимое заметки Homepage
const content = await app.vault.cachedRead(homepageFile);

// Определяем название секции с Kanban-досками
const sectionTitle = 'Kanban';

// Создаём динамическое регулярное выражение для извлечения нужной секции
const sectionRegex = new RegExp(`### ${sectionTitle}:\n([\\s\\S]*?)(?=\\n###|$)`);

// Извлекаем содержимое секции
const sectionMatch = sectionRegex.exec(content);
const sectionContent = sectionMatch?.[1] || '';

// Ищем все ссылки на проекты в квадратных скобках
const matchesIterator = sectionContent.matchAll(/- \[\[(.*?)\]\]/g);

// Преобразуем итератор в массив названий проектов
const projects = Array.from(matchesIterator, m => m[1]);

// Получаем имя текущей заметки
const currentNoteName = app.workspace.getActiveFile()?.basename;

// Проверяем, есть ли создаваемая доска в общем списке досок
if (projects.includes(currentNoteName)) {
    new Notice(`Доска "${currentNoteName}" уже существует. Добавление отменено.`);
} else {
    // Добавляем новую доску в список досок
    const newSectionContent = sectionContent.trim() + `\n- [[${currentNoteName}]]\n`;
    // Обновляем содержимое списка досок, добавляя новую доску
    const updatedContent = content.replace(sectionRegex, `### ${sectionTitle}:\n${newSectionContent}`);
    await app.vault.modify(homepageFile, updatedContent);
    new Notice(`Доска "${currentNoteName}" добавлена в секцию "${sectionTitle}".`);
}
%>
## Backlog



## To do



## В работе



## Тестирование



## Done

**Complete**


## Canceled

**Complete**


## Повторяющиеся





%% kanban:settings
```
{"kanban-plugin":"board","list-collapse":[true,false,false,false,false,true,true],"show-checkboxes":false,"full-list-lane-width":false,"move-tags":false,"move-dates":false,"show-archive-all":false}
```
%%