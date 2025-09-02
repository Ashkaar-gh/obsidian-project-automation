---
project: %%projectName%%
cssclasses:
  - wide-page
  - table-divider
---

```dataviewjs
// Получаем имя заметки
const filterProject = app.workspace.getActiveFile()?.basename.toLowerCase();
const currentPath = dv.current().file.path;

/**
 * Преобразует строку с датой в формате 'DD-MM-YYYY' в объект Date.
 * @param {string} dateStr - Строка с датой.
 * @returns {Date} - Объект Date.
 */
function parseDate(dateStr) {
    return moment(dateStr, 'DD-MM-YYYY').toDate();
}

/**
 * Форматирует объект Date в строку формата 'DD-MM-YYYY'.
 * @param {Date} date - Объект Date для форматирования.
 * @returns {string} - Строка с отформатированной датой.
 */
function formatDate(date) {
    return moment(date).format('DD-MM-YYYY');
}

/**
 * Возвращает иконку в зависимости от статуса задачи.
 * @param {string} status - Статус задачи в нижнем регистре.
 * @returns {string} - Emoji-иконка, соответствующая статусу.
 */
function getStatusIcon(status) {
    const icons = {
        'backlog': '🗒️',
        'to do': '📋',
        'canceled': '🚫',
        'в работе': '⚙️',
        'тестирование': '🔍',
        'повторяющиеся': '🔁',
        'done': '☑️'
    };
    return icons[status.toLowerCase()] || '❓';
}

/**
 * Находит даты упоминания задачи в заголовках ежедневных заметок.
 * @async
 * @param {string} taskName - Имя задачи для поиска.
 * @returns {Promise<Date[]>} - Промис, который разрешается массивом объектов Date.
 */
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
