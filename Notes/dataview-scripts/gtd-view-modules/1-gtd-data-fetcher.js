/**
 * Данные для GTD view: страницы со status (без templates/Trash/Archive), группировка по статусу, даты из buildTaskDateIndex.
 */
async function fetchData(dv, app, config, utils, paths) {
    const taskDateMap = await utils.buildTaskDateIndex(dv, app, paths);

    const excludedTemplates = paths ? paths.TEMPLATES_FOLDER : "templates";
    const excludedTrash = paths ? paths.TRASH_FILE : "Trash";
    const excludedArchive = paths ? paths.ARCHIVE_FOLDER : "Archive";

    const pages = dv.pages()
        .where(p => p.status
            && p.file.path !== dv.current().file.path
            && !p.file.path.includes(excludedTemplates)
            && !p.file.path.includes(excludedTrash)
            && !p.file.path.includes(excludedArchive)
        );

    let rawData = [];

    for (let page of pages) {
        let rawStatus = page.status;
        if (Array.isArray(rawStatus)) rawStatus = rawStatus[0];
        if (!rawStatus) rawStatus = "В работе";

        let eventDates = taskDateMap.get(page.file.name.toLowerCase()) || [];
        
        if (!eventDates.length && page.date) {
            const d = utils.parseDate(page.date);
            if (d) eventDates.push(d);
        }
        
        let startDate = eventDates.length ? new Date(Math.min(...eventDates)) : null;
        let endDate = eventDates.length ? new Date(Math.max(...eventDates)) : null;
        
        let executionTime = utils.getExecutionTime(startDate, endDate);

        let envRaw = page.environment;
        let envDisplay = Array.isArray(envRaw) ? envRaw.join(", ") : (envRaw ? String(envRaw) : "");
        
        let rawContext = page.context;
        if (Array.isArray(rawContext)) rawContext = rawContext[0];

        rawData.push({
            note: page.file.link,
            path: page.file.path,
            context: rawContext || "",
            environment: envDisplay,
            status: rawStatus,
            sortStatus: rawStatus,
            executionTime,
            startDate,
            endDate,
            group: rawStatus 
        });
    }

    const groupedData = new Map();
    for (const item of rawData) {
        if (!groupedData.has(item.group)) {
            groupedData.set(item.group, []);
        }
        groupedData.get(item.group).push(item);
    }

    for (const [group, tasks] of groupedData) {
        tasks.sort((a, b) => {
            const wA = config.getWeight(a.sortStatus);
            const wB = config.getWeight(b.sortStatus);
            if (wA !== wB) return wA - wB;

            const dateA = a.endDate ? a.endDate.getTime() : 0;
            const dateB = b.endDate ? b.endDate.getTime() : 0;
            
            if (dateA !== dateB) return dateB - dateA;

            return a.path.localeCompare(b.path);
        });
    }

    return groupedData;
}

return { fetchData };