/**
 * Сканирует ежедневные заметки, находит в них упоминания текущей задачи и извлекает связанный контент.
 * @async
 * @param {object} dv - Объект API Dataview, переданный из основного скрипта.
 * @param {object} app - Глобальный объект Obsidian App.
 * @returns {Promise<{structuredData: Array<object>, flatTocEntries: Array<object>}>} - Промис, который разрешается объектом с двумя массивами: structuredData (основные данные по блокам) и flatTocEntries (данные для оглавления).
 */
async function fetchData(dv, app) {
    // Получаем имя текущей заметки, это будет наш ключ для поиска.
    const currentNoteName = dv.current().file.name;
    
    // Находим все страницы в папке "periodic/daily" и сразу преобразуем результат в массив.
    // Сортируем заметки по дате в хронологическом порядке, чтобы записи в задаче шли последовательно.
    const pages = dv.pages('"periodic/daily"').array()
        .sort((a, b) => moment(a.file.name, 'DD-MM-YYYY').toDate() - moment(b.file.name, 'DD-MM-YYYY').toDate());

    // Основной массив, каждый элемент которого - объект, представляющий блок контента из ежедневной заметки.
    const structuredData = [];
    // "Плоский" список всех подзаголовков из всех найденных блоков для построения общего оглавления.
    const flatTocEntries = [];
    // Простой счетчик для создания уникальных ID для HTML-элементов.
    let mainIndex = 0;

    // Запускаем цикл по всем найденным и отсортированным ежедневным заметкам.
    for (const page of pages) {
        // Получаем объект файла TFile для доступа к API чтения и записи.
        const file = app.vault.getAbstractFileByPath(page.file.path);
        // Получаем кэшированные метаданные файла, это самый быстрый способ получить информацию о заголовках.
        const fileCache = app.metadataCache.getFileCache(file);

        // Если в файле нет заголовков, переходим к следующему файлу.
        if (!fileCache?.headings) continue;

        // Получаем массив всех заголовков в файле и его полное текстовое содержимое.
        const headings = fileCache.headings;
        const fileContent = await app.vault.cachedRead(file);

        // Запускаем внутренний цикл по всем заголовкам в текущей ежедневной заметке.
        for (let i = 0; i < headings.length; i++) {
            const currentHeading = headings[i];
            // Ищем заголовок, который содержит ссылку на нашу текущую задачу.
            if (!currentHeading.heading.includes(currentNoteName)) continue;

            // Если мы здесь, значит, мы нашли нужную секцию.
            const sectionSubHeadings = [];
            // Запускаем цикл, который начнется со следующего заголовка после найденного.
            for (let j = i + 1; j < headings.length && headings[j].level > currentHeading.level; j++) {
                // Условие `headings[j].level > currentHeading.level` собирает только "дочерние" заголовки.
                const nextHeading = headings[j];
                sectionSubHeadings.push({
                    // Очищаем текст заголовка от символов '#'.
                    text: nextHeading.heading.replace(/#/g, '').trim(),
                    // Сохраняем относительный уровень вложенности.
                    level: nextHeading.level - currentHeading.level,
                    // Генерируем уникальный ID для навигации.
                    id: `content-block-${mainIndex}-sub-${sectionSubHeadings.length}`
                });
            }

            // Точно извлекаем контент, используя смещения (offsets) из кэша.
            // Контент начинается сразу после заголовка.
            const contentStartOffset = currentHeading.position.end.offset + 1;
            // По умолчанию, контент идет до конца файла.
            let contentEndOffset = fileContent.length;
            // Ищем следующий заголовок того же или более высокого уровня, чтобы определить конец секции.
            for (let k = i + 1; k < headings.length; k++) {
                if (headings[k].level <= currentHeading.level) {
                    // Если нашли, то это конец нашей секции.
                    contentEndOffset = headings[k].position.start.offset;
                    break;
                }
            }
            // "Вырезаем" нужный кусок текста из полного содержимого файла.
            const content = fileContent.substring(contentStartOffset, contentEndOffset);

            // Дата из имени файла, например "08-09-2025".
            const formattedDate = page.file.name;
            // Убираем `[[` и `]]` из текста заголовка для якорной ссылки.
            const encodedHeading = currentHeading.heading.slice(2, -2);
            // Создаем готовую Markdown-ссылку на конкретный заголовок в ежедневной заметке.
            const dateLink = `[[${page.file.path}#${encodedHeading}|${formattedDate}]]`;

            // Добавляем собранные подзаголовки в "плоский" список для оглавления.
            sectionSubHeadings.forEach(subH => flatTocEntries.push({ ...subH, dateText: formattedDate }));

            // Собираем все извлеченные данные в один объект и добавляем его в наш главный массив.
            structuredData.push({
                // Уникальный ID для всего блока.
                id: `content-block-${mainIndex}`,
                // Готовая ссылка на источник.
                dateLink,
                // Массив подзаголовков.
                subHeadings: sectionSubHeadings,
                // Текстовое содержимое.
                content,
                // Путь к файлу-источнику, нужен для сохранения изменений.
                sourcePath: file.path,
                // Начальная позиция контента, нужна для сохранения.
                contentStartOffset,
                // Конечная позиция контента, нужна для сохранения.
                contentEndOffset
            });
            // Увеличиваем счетчик для следующего найденного блока.
            mainIndex++;
        }
    }
    // Возвращаем объект с двумя подготовленными массивами данных.
    return { structuredData, flatTocEntries };
}

// "Экспортируем" функцию fetchData, чтобы ее можно было загрузить и вызвать в основном скрипте task-view.js.
return { fetchData };