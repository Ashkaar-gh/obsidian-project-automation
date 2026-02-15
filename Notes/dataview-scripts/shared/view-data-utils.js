/**
 * Утилиты дат и индекса: parseDate, formatDate, getExecutionTime, buildTaskDateIndex.
 * buildTaskDateIndex — Map(имя задачи → даты упоминаний в daily notes).
 */
/** Строка/Date/luxon → Date; форматы DD-MM-YYYY, YYYY-MM-DD, DD.MM.YYYY, ISO. */
function parseDate(dateValue) {
    if (!dateValue) return null;
    if (dateValue instanceof Date) return dateValue;
    if (dateValue.toJSDate) return dateValue.toJSDate();
    if (typeof dateValue === 'string') {
        const cleanStr = dateValue.replace(/\.md$/i, '').trim();
        const formats = ["DD-MM-YYYY", "YYYY-MM-DD", "DD.MM.YYYY", moment.ISO_8601];
        const m = moment(cleanStr, formats, true);
        if (m.isValid()) return m.toDate();
    }
    return null;
}

/** Date → DD-MM-YYYY. */
function formatDate(date) {
    if (!date) return "";
    return moment(date).format('DD-MM-YYYY');
}

/** Одна дата или диапазон в виде строки. */
function getExecutionTime(startDate, endDate) {
    if (!startDate) return "";
    if (startDate && endDate && startDate.getTime() !== endDate.getTime()) {
        return `${formatDate(startDate)} - ${formatDate(endDate)}`;
    }
    return formatDate(startDate);
}

const TASK_DATE_INDEX_TTL_MS = 2500;
let taskDateIndexCache = { dailyFolder: null, result: null, timestamp: 0 };

/** Map(имя задачи → массив дат) по daily notes и заголовкам h3 со ссылками; кэш TTL 2.5s. */
async function buildTaskDateIndex(dv, app, paths) {
    const dailyFolder = paths ? paths.DAILY_FOLDER : 'periodic/daily';
    const now = Date.now();
    if (taskDateIndexCache.result && taskDateIndexCache.dailyFolder === dailyFolder && (now - taskDateIndexCache.timestamp) < TASK_DATE_INDEX_TTL_MS) {
        return taskDateIndexCache.result;
    }
    const taskDateMap = new Map();
    const dailyNotes = dv.pages(`"${dailyFolder}"`);

    for (const page of dailyNotes) {
        if (!page.file.outlinks || page.file.outlinks.length === 0) continue;

        let date = null;
        if (page.file.day) {
            date = page.file.day.toJSDate();
        } else {
            date = parseDate(page.file.name);
        }
        if (!date) continue;

        const tFile = app.vault.getAbstractFileByPath(page.file.path);
        if (!tFile) continue;
        const cache = app.metadataCache.getFileCache(tFile);

        if (cache && cache.headings) {
            for (const h of cache.headings) {
                if (h.level !== 3) continue;
                const linkMatch = /\[\[(.*?)(?:\|.*?)?\]\]/.exec(h.heading);
                if (linkMatch) {
                    const linkedTaskName = linkMatch[1].toLowerCase();
                    if (!taskDateMap.has(linkedTaskName)) taskDateMap.set(linkedTaskName, []);
                    taskDateMap.get(linkedTaskName).push(date);
                }
            }
        }
    }
    taskDateIndexCache = { dailyFolder, result: taskDateMap, timestamp: Date.now() };
    return taskDateMap;
}

return {
    parseDate,
    formatDate,
    getExecutionTime,
    buildTaskDateIndex
};