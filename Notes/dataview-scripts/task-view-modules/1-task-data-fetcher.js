/**
 * Данные для task-view: секции из daily notes, где в заголовках упоминается targetNoteName.
 * Возвращает { structuredData, flatTocEntries } для оглавления и контента.
 */
/** Секции daily notes с упоминанием targetNoteName в заголовках; подзаголовки и границы контента. */
async function fetchData(dv, app, targetNoteName, paths) {
    let currentNoteName = targetNoteName;
    if (!currentNoteName) {
        const currentPage = dv.current();
        if (currentPage && currentPage.file) {
            currentNoteName = currentPage.file.name;
        } else {
            return { structuredData: [], flatTocEntries: [] };
        }
    }

    const dailyNotesFolder = paths ? paths.DAILY_FOLDER : "periodic/daily";

    const allDailyFiles = app.vault.getMarkdownFiles()
        .filter(file => file.path.startsWith(dailyNotesFolder));

    const mappedFiles = allDailyFiles.map(file => ({
        file: file,
        time: moment(file.basename, 'DD-MM-YYYY').valueOf()
    }));
    mappedFiles.sort((a, b) => a.time - b.time);
    const pages = mappedFiles.map(item => item.file);

    const preliminaryData = [];
    let hasAnySubheadings = false;
    for (const file of pages) {
        const fileCache = app.metadataCache.getFileCache(file);
        if (!fileCache?.headings) continue;

        const hasMention = fileCache.headings.some(h => h.heading.includes(currentNoteName));
        if (!hasMention) continue;

        const fileContent = await dv.io.load(file.path);
        if (!fileContent) continue;
        const headings = fileCache.headings;

        for (let i = 0; i < headings.length; i++) {
            const currentHeading = headings[i];

            if (!currentHeading.heading.includes(currentNoteName)) continue;

            const sectionSubHeadings = [];
            for (let j = i + 1; j < headings.length && headings[j].level > currentHeading.level; j++) {
                const nextHeading = headings[j];
                sectionSubHeadings.push({
                    text: nextHeading.heading.replace(/#/g, '').trim(),
                    level: nextHeading.level - currentHeading.level,
                });
            }

            if (sectionSubHeadings.length > 0) hasAnySubheadings = true;

            const contentStartOffset = currentHeading.position.end.offset + 1;
            let contentEndOffset = fileContent.length;

            for (let k = i + 1; k < headings.length; k++) {
                if (headings[k].level <= currentHeading.level) {
                    contentEndOffset = headings[k].position.start.offset;
                    break;
                }
            }

            const content = fileContent.substring(contentStartOffset, contentEndOffset).replace(/^\n+/, '').replace(/\n+$/, '');
            const formattedDate = file.basename;
            const encodedHeading = currentHeading.heading.slice(2, -2);
            const dateLink = `[[${file.path}#${encodedHeading}|${formattedDate}]]`;

            preliminaryData.push({
                date: formattedDate,
                dateLink,
                subHeadings: sectionSubHeadings,
                content,
                sourcePath: file.path,
                contentStartOffset,
                contentEndOffset
            });
        }
    }

    const structuredData = [];
    const flatTocEntries = [];
    const processedDatesForToc = new Set();
    const uniquePrefix = `tv-${Math.floor(Math.random() * 100000)}`;

    preliminaryData.forEach((item, index) => {
        const currentBlockId = `${uniquePrefix}-block-${index}`;

        const finalSubHeadings = item.subHeadings.map((subH, subIndex) => ({
            ...subH,
            id: `${currentBlockId}-h-${subIndex}`
        }));

        structuredData.push({
            id: currentBlockId,
            dateLink: item.dateLink,
            subHeadings: finalSubHeadings,
            content: item.content,
            sourcePath: item.sourcePath,
            contentStartOffset: item.contentStartOffset,
            contentEndOffset: item.contentEndOffset
        });

        if (hasAnySubheadings) {
            finalSubHeadings.forEach(subH => {
                flatTocEntries.push({
                    ...subH,
                    dateText: item.date,
                    isDateOnly: false
                });
            });
        } else {
            if (!processedDatesForToc.has(item.date)) {
                flatTocEntries.push({
                    text: item.date,
                    level: 1,
                    id: currentBlockId,
                    isDateOnly: true
                });
                processedDatesForToc.add(item.date);
            }
        }
    });

    return { structuredData, flatTocEntries };
}

return { fetchData };
