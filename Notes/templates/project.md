---
project: <%*
// Получаем путь до заметки Homepage
const homepageFile = await app.vault.getAbstractFileByPath('Homepage.md');

// Читаем содержимое заметки Homepage
const content = await app.vault.cachedRead(homepageFile);

// Определяем название секции с проектами
const sectionTitle = 'Проекты'; 

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

// Проверяем, есть ли создаваемый проект в общем списке проектов
if (projects.includes(currentNoteName)) {
    new Notice(`Проект "${currentNoteName}" уже существует. Добавление отменено.`);
} else {
    // Добавляем новый проект в список проектов
    const newSectionContent = sectionContent.trim() + `\n- [[${currentNoteName}]]\n`;
    // Обновляем содержимое списка проектов, добавляя новый проект
    const updatedContent = content.replace(sectionRegex, `### ${sectionTitle}:\n${newSectionContent}`);
    await app.vault.modify(homepageFile, updatedContent);
    new Notice(`Проект "${currentNoteName}" добавлен в секцию "${sectionTitle}".`);
}
tR += currentNoteName;
%>
cssclasses:
  - wide-page
---

```dataviewjs
// Получаем имя заметки
const filterProject = app.workspace.getActiveFile()?.basename.toLowerCase();
const currentPath = dv.current().file.path;

// Функция для преобразования строки в дату
function parseDate(dateStr) {
    return moment(dateStr, 'DD-MM-YYYY').toDate();
}

// Функция для преобразования даты в строку
function formatDate(date) {
    return moment(date).format('DD-MM-YYYY');
}

// Функция для получения иконки по статусу задачи
function getStatusIcon(status) {
    const icons = {
        'backlog': '🗒️',
        'to do': '📋',
        'canceled': '🚫',
        'в работе': '⚙️',
        'тестирование': '🔍',
        'done': '☑️'
    };
    return icons[status.toLowerCase()] || '❓';
}

// Функция для получения даты из имени ежедневной заметки
async function getEventDatesFromDailyNotes(taskName) {
    const dailyNotes = dv.pages('"periodic/daily"').values;
    const eventDates = [];
    
    for (const page of dailyNotes) {
        const file = app.vault.getAbstractFileByPath(page.file.path);
	    
        if (file?.extension === 'md') {
            const fileContent = await app.vault.cachedRead(file);
            const taskHeaderPattern = new RegExp(`###\\s*[^\\n]*\\[\\[${taskName}(#[^\\]]+)?\\]\\]`, 'i');
		    
            if (taskHeaderPattern.test(fileContent)) {
                const dateStr = page.file.name;
                const date = parseDate(dateStr);
                if (date) {
                    eventDates.push(date);
                }
            }
        }
    }
    return eventDates;
}

// Получаем все Kanban доски из каталога kanban
const kanbanFiles = app.vault.getMarkdownFiles().filter(file => file.path.startsWith('kanban/'));

// Проверяем нашли ли мы доски
if (kanbanFiles.length === 0) {
    dv.paragraph("Канбан доски не найдены.");
    return;
}

// Создаем объект для хранения соответствий между задачами и их статусами
const taskBoardStatusMap = {};

// Проходим по каждой доске
for (const kanbanFile of kanbanFiles) {
    // Читаем содержимое доски из кэша
    const kanbanContent = await app.vault.cachedRead(kanbanFile);
    // Создаем переменную для хранения текущего статуса
    let currentStatus = null;

    // Проходим по каждой строке доски
    kanbanContent.split('\n').forEach(line => {
        const headingMatch = line.match(/^##\s+(.*)/);
        // Если строка является заголовком второго уровня, обновляем текущий статус
        if (headingMatch) {
            currentStatus = headingMatch[1].trim();
        // Если статус уже установлен, ищем ссылки на задачи в строке
        } else if (currentStatus) {
            const linkMatch = line.match(/\[\[([^\]]+)\]\]/);
            // Если нашли ссылку на задачу, извлекаем название задачи и ее статус
            if (linkMatch) {
                const taskName = linkMatch[1].trim();

                // Если задача еще не добавлена в объект, создаем для нее пустой массив
                if (!taskBoardStatusMap[taskName]) {
                    taskBoardStatusMap[taskName] = [];
                }
                // Добавляем в массив информацию о доске и статусе задачи
                taskBoardStatusMap[taskName].push({
                    kanbanBoard: kanbanFile.basename,
                    status: currentStatus
                });
            }
        }
    });
}

// Получаем заметки, относящиеся к текущему проекту
const pages = dv.pages().filter(p => {
    // Если свойство project отсутствует, исключаем эту страницу
    if (!p.project) return false;
    // Приводим project к массиву, если это не массив
    const projects = Array.isArray(p.project) ? p.project : [p.project];
    // Приводим все имена проектов к нижнему регистру
    const lowercaseProjects = projects.map(proj => proj.toLowerCase());
    // Проверяем, соответствует ли проект фильтру и исключаем текущую страницу
    return lowercaseProjects.includes(filterProject) && p.file.path !== currentPath;
});

// Создаем пустой массив для хранения данных для таблицы
let data = [];

// Проходим по каждой странице в списке
for (let page of pages) {
    // Получаем даты событий из ежедневных заметок для текущей задачи
    let eventDates = await getEventDatesFromDailyNotes(page.file.name);
    // Если даты не найдены и у страницы есть свойство date, добавляем его
    if (!eventDates.length && page.date) eventDates.push(parseDate(page.date));
    
    // Определяем начальную и конечную даты выполнения задачи
    let startDate = eventDates.length ? new Date(Math.min(...eventDates)) : null;
    let endDate = eventDates.length ? new Date(Math.max(...eventDates)) : null;
    
    // Получаем имя задачи
    const taskName = page.file.name;
    // Получаем список статусов и досок для текущей задачи
    const taskBoardStatusList = taskBoardStatusMap[taskName] || [];

    // Получаем список досок, к которым относится задача
    const kanbanBoards = taskBoardStatusList.map(entry => entry.kanbanBoard);
    // Избавляемся от повторений в списке досок
    const uniqueKanbanBoards = [...new Set(kanbanBoards)];

    // Получаем список статусов задачи
    const statusList = taskBoardStatusList.map(entry => entry.status);
    // Избавляемся от повторений в списке статусов
    const uniqueStatuses = [...new Set(statusList)];
    // Добавляем иконки к статусам и соединяем их в строку
    const statusIcons = uniqueStatuses.map(s => `${s} ${getStatusIcon(s)}`).join(', ') || "Не указано";
    
    // Определяем время выполнения задачи в виде строки
    let executionTime;
    if (startDate && endDate && startDate.getTime() !== endDate.getTime()) {
        executionTime = `${formatDate(startDate)} — ${formatDate(endDate)}`;
    } else if (startDate) {
        executionTime = formatDate(startDate);
    } else {
        executionTime = "Нет даты";
    }
    // Добавляем объект с данными о задаче в массив data
    data.push({
        note: page.file.link,
        instance: page.instance || "Не указано",
        kanbanBoards: uniqueKanbanBoards.join(', ') || "Не указано",
        status: statusIcons,
        executionTime,
        startDate
    });
}

// Сортируем данные по начальной дате выполнения
data.sort((a, b) => (a.startDate || Infinity) - (b.startDate || Infinity));

// Если есть данные, отображаем таблицу с нужной информацией
if (data.length) {
    dv.table(
        ["Заметка", "Инстанс", "Kanban", "Статус", "Время выполнения"],
        data.map(d => [d.note, d.instance, d.kanbanBoards, d.status, d.executionTime])
    );
// Иначе выводим сообщение о том, что данных нет
} else {
    dv.paragraph("Нет данных для отображения.");
}
```
