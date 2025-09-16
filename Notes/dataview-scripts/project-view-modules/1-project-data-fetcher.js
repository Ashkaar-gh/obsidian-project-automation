/**
 * Сканирует ежедневные заметки, находит в них упоминания текущей задачи и извлекает связанный контент.
 * @async
 * @param {object} dv - Объект API Dataview, переданный из основного скрипта.
 * @param {object} app - Глобальный объект Obsidian App.
 * @returns {Promise<{structuredData: Array<object>, flatTocEntries: Array<object>}>} - Промис, который разрешается объектом с двумя массивами: structuredData (основные данные по блокам) и flatTocEntries (данные для оглавления).
 */
async function fetchData(dv, app) {
    // Получаем имя текущей заметки-проекта и приводим его к нижнему регистру для надежного, регистронезависимого сравнения. Это наш главный фильтр.
    const filterProject = dv.current().file.name.toLowerCase();
    // Сохраняем путь к текущему файлу, чтобы случайно не включить саму заметку-проект в список ее задач.
    const currentPath = dv.current().file.path;

    // Вспомогательные функции для унификации работы с датами и статусами, чтобы обеспечить консистентность во всем скрипте.
    function parseDate(dateStr) { return moment(dateStr, 'DD-MM-YYYY').toDate(); }
    function formatDate(date) { return moment(date).format('DD-MM-YYYY'); }
    function getStatusIcon(status) {
        const icons = {
            'backlog': '🗒️', 'to do': '📋', 'canceled': '🚫',
            'в работе': '⚙️', 'тестирование': '🔍',
            'повторяющиеся': '🔁', 'done': '☑️'
        };
        return icons[status.toLowerCase()] || '❓';
    }

    /**
     * Сканирует все ежедневные заметки в поисках упоминаний конкретной задачи. Это позволяет собрать
     * реальные даты, когда над задачей велась работа, что гораздо точнее, чем одно статичное поле 'date'.
     * @async
     * @param {string} taskName - Имя файла задачи, которую нужно найти.
     * @returns {Promise<Array<Date>>} - Массив объектов Date, соответствующих датам из имен ежедневных заметок.
     */
    async function getEventDatesFromDailyNotes(taskName) {
        // Находим все страницы в папке "periodic/daily".
        const dailyNotes = dv.pages('"periodic/daily"').values;
        const eventDates = [];
        for (const page of dailyNotes) {
            const file = app.vault.getAbstractFileByPath(page.file.path);
            if (file?.extension === 'md') {
                // Читаем содержимое файла и ищем заголовок, содержащий ссылку на нашу задачу.
                const fileContent = await app.vault.cachedRead(file);
                const taskHeaderPattern = new RegExp(`###\\s*[^\\n]*\\[\\[${taskName}(#[^\\]]+)?\\]\\]`, 'i');
                if (taskHeaderPattern.test(fileContent)) {
                    // Если упоминание найдено, парсим дату из имени файла ежедневной заметки и добавляем в массив.
                    const date = parseDate(page.file.name);
                    if (date) eventDates.push(date);
                }
            }
        }
        return eventDates;
    }

    // Находим все Kanban-доски, сканируем их содержимое и создаем карту "имя задачи -> ее статус и доска".
    // Это ключевая оптимизация: мы один раз читаем все доски и создаем быструю структуру для поиска,
    // вместо того чтобы перечитывать файлы для каждой отдельной задачи проекта.
    const kanbanFiles = app.vault.getMarkdownFiles().filter(file => file.path.startsWith('kanban/'));
    const taskBoardStatusMap = {};
    for (const kanbanFile of kanbanFiles) {
        const kanbanContent = await app.vault.cachedRead(kanbanFile);
        let currentStatus = null;
        kanbanContent.split('\n').forEach(line => {
            const headingMatch = line.match(/^##\s+(.*)/);
            if (headingMatch) {
                // Когда находим заголовок (## To do), запоминаем его как текущий статус.
                currentStatus = headingMatch[1].trim();
            } else if (currentStatus) {
                // Для всех последующих строк ищем ссылки на задачи.
                const linkMatch = line.match(/\[\[([^\]]+)\]\]/);
                if (linkMatch) {
                    // Если нашли ссылку, добавляем в нашу карту информацию о том, что эта задача имеет `currentStatus` на этой `kanbanFile`.
                    const taskName = linkMatch[1].trim();
                    if (!taskBoardStatusMap[taskName]) taskBoardStatusMap[taskName] = [];
                    taskBoardStatusMap[taskName].push({
                        kanbanBoard: kanbanFile.basename,
                        status: currentStatus
                    });
                }
            }
        });
    }

    // Используем API Dataview для поиска всех заметок, у которых в метаданных (YAML frontmatter) указан текущий проект.
    const pages = dv.pages().filter(p => {
        if (!p.project) return false;
        // Обрабатываем как одиночное значение (`project: ProjA`), так и массив (`project: [ProjA, ProjB]`).
        const projects = Array.isArray(p.project) ? p.project : [p.project];
        const lowercaseProjects = projects.map(proj => String(proj).toLowerCase());
        // Проверяем, есть ли в списке проектов нашей заметки текущий проект, и исключаем саму страницу проекта.
        return lowercaseProjects.includes(filterProject) && p.file.path !== currentPath;
    });

    // Проходим по каждой найденной задаче, чтобы собрать всю необходимую информацию в единый объект.
    let data = [];
    for (let page of pages) {
        // Получаем даты из ежедневных заметок.
        let eventDates = await getEventDatesFromDailyNotes(page.file.name);
        // Если в ежедневниках дат нет, используем дату из метаданных задачи как запасной вариант.
        if (!eventDates.length && page.date) eventDates.push(parseDate(page.date));
        
        // Определяем самую раннюю и самую позднюю дату, чтобы вычислить период работы над задачей.
        let startDate = eventDates.length ? new Date(Math.min(...eventDates)) : null;
        let endDate = eventDates.length ? new Date(Math.max(...eventDates)) : null;
        
        const taskName = page.file.name;
        // Используем нашу заранее созданную карту для мгновенного получения статуса и досок задачи.
        const taskBoardStatusList = taskBoardStatusMap[taskName] || [];
        
        // Используем Set, чтобы получить уникальные значения досок и статусов (на случай дубликатов).
        const uniqueKanbanBoards = [...new Set(taskBoardStatusList.map(entry => entry.kanbanBoard))];
        const uniqueStatuses = [...new Set(taskBoardStatusList.map(entry => entry.status))];
        // Форматируем статусы с иконками для наглядного отображения.
        const statusIcons = uniqueStatuses.map(s => `${s} ${getStatusIcon(s)}`).join(', ') || "Не указано";
        
        // Формируем строку "Время выполнения" в зависимости от того, одна дата у нас или диапазон.
        let executionTime;
        if (startDate && endDate && startDate.getTime() !== endDate.getTime()) {
            executionTime = `${formatDate(startDate)} — ${formatDate(endDate)}`;
        } else if (startDate) {
            executionTime = formatDate(startDate);
        } else {
            executionTime = "Нет даты";
        }
        
        // Собираем все обработанные данные в один объект и добавляем его в итоговый массив.
        data.push({
            note: page.file.link,
            instance: page.instance || "Не указано",
            kanbanBoards: uniqueKanbanBoards.join(', ') || "Не указано",
            status: statusIcons,
            executionTime,
            startDate // Сохраняем startDate отдельно для последующей сортировки.
        });
    }

    // Сортируем все задачи по дате начала в хронологическом порядке. Задачи без даты окажутся в конце списка.
    data.sort((a, b) => (a.startDate || Infinity) - (b.startDate || Infinity));
    
    // Возвращаем готовый и отсортированный массив данных.
    return data;
}

// "Экспортируем" функцию fetchData, чтобы ее можно было загрузить и вызвать в основном скрипте project-view.js.
return { fetchData };