/**
 * Напоминания: задачи с меткой @date (и опционально time), без templates/Trash. Группировка: overdue, today, tomorrow, upcoming.
 */
async function fetchReminders(dv, app, paths) {
    moment.locale('ru');

    const reminderRegex = /\(@(\d{2,4}[-.]\d{2}[-.]\d{2,4})(?:[T\s](\d{1,2}:\d{2}))?\)/;

    const excludeTemplates = paths ? paths.TEMPLATES_FOLDER : 'templates';
    const excludeTrash = paths ? paths.TRASH_FILE.replace(/\.md$/i, '') : 'Trash';
    const pages = dv.pages(`!"${excludeTemplates}" AND !"${excludeTrash}"`);
    if (!pages || pages.length === 0) return emptyData();

    const tasks = pages.file.tasks
        .where(t => !t.completed && reminderRegex.test(t.text));

    const reminders = [];
    const now = moment();
    for (let t of tasks) {
        const match = t.text.match(reminderRegex);
        if (!match) continue;

        const dateStr = match[1];
        
        const rawTimeStr = match[2];

        const calcTimeStr = rawTimeStr || "10:00";
        
        let dueMoment = moment(`${dateStr} ${calcTimeStr}`, ["DD-MM-YYYY HH:mm", "YYYY-MM-DD HH:mm", "DD.MM.YYYY HH:mm"], true);
        
        if (!dueMoment.isValid()) {
             dueMoment = moment(`${dateStr} ${calcTimeStr}`);
        }

        if (!dueMoment.isValid()) continue;

        const cleanText = t.text.replace(reminderRegex, "").trim();

        let type = "upcoming";
        
        
        if (dueMoment.isBefore(now, 'day')) {
            type = "overdue"; 
        } else if (dueMoment.isSame(now, 'day')) {
            
            if (dueMoment.isBefore(now)) type = "overdue_today"; 
            else type = "today"; 
            
        } else if (dueMoment.clone().subtract(1, 'days').isSame(now, 'day')) {
            type = "tomorrow";
        }

        reminders.push({
            task: t,
            text: cleanText,
            originalText: t.text,
            date: dueMoment.toDate(),
            displayDate: dueMoment.format("DD.MM.YYYY"),
            displayTime: rawTimeStr ? rawTimeStr : null,
            fromNow: dueMoment.fromNow(),
            file: t.path,
            link: t.link,
            type: type
        });
    }

    reminders.sort((a, b) => a.date - b.date);

    return {
        overdue: reminders.filter(r => r.type === "overdue" || r.type === "overdue_today"),
        today: reminders.filter(r => r.type === "today"),
        tomorrow: reminders.filter(r => r.type === "tomorrow"),
        upcoming: reminders.filter(r => r.type === "upcoming")
    };
}

/**
 * Генерирует пустую структуру данных.
 * 
 * @returns {Object} Возвращает объект с пустыми массивами категорий.
 */
function emptyData() {
    return { overdue: [], today: [], tomorrow: [], upcoming: [] };
}

return { fetchReminders };