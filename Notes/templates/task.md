---
project: <%* 
// Оборачиваем в блок обработки исключений
try {
    // Подключаем содержимое заметки Homepage
    const content = await tp.file.include("[[Homepage]]");
    // Определяем название секции с проектами
    const sectionTitle = 'Проекты'; 
    // Создаём динамическое регулярное выражение для извлечения нужной секции
    const sectionRegex = new RegExp(`### ${sectionTitle}:\n([\\s\\S]*?)(?=\n###|$)`);
    // Извлекаем содержимое секции
    const section = sectionRegex.exec(content)?.[1];

    if (section) {
        // Ищем все строки с квадратными скобками
        const matchesIterator = section.matchAll(/- \[\[(.*?)\]\]/g);
        // Преобразуем итератор в массив названий проектов
        const projects = Array.from(matchesIterator, m => m[1]);
        // Предлагаем выбрать проект из списка
        const selectedProject = await tp.system.suggester(projects, projects);
        // Выводим выбранный проект в заметку
        tR += `${selectedProject}`;
    } else {
        console.log("Секция не найдена.");
    }
} catch (error) {
    console.error("Templater Error:", error);
}
%>
instance: <%* 
try {
    const instanceValue = await tp.system.prompt("Введите значение для instance:");
    if (instanceValue !== null) {
        tR += instanceValue + " ";
    }
} catch (error) {
    console.error("Templater Error:", error);
}
%>
date: <% tp.date.now("YYYY-MM-DD") %>
cssclasses:
  - wide-page
---
<%*
// Оборачиваем в блок обработки исключений
try {
    // Формируем полный путь к сегодняшней ежедневной заметке
    const dailyNoteCatalog = 'periodic/daily';
    const currentDate = tp.date.now("DD-MM-YYYY");
    const dailyNotePath = `${dailyNoteCatalog}/${currentDate}`;
    const dailyNotePathMd = `${dailyNotePath}.md`;
    
    let dailyNoteFile;

    // Проверяем, существует ли ежедневная заметка
    const dailyNoteExists = await tp.file.exists(dailyNotePathMd);

    if (dailyNoteExists) {
        // Если существует, получаем ее полный адрес
        dailyNoteFile = app.vault.getAbstractFileByPath(dailyNotePathMd);
    } else {
        // Если не существует, создаем ее с применением шаблона daily
        dailyNoteFile = await tp.file.create_new(tp.file.find_tfile("daily"), dailyNotePath);
    }

    // Получаем имя текущей заметки
    const currentNoteName = app.workspace.getActiveFile()?.basename;
    
    // Читаем содержимое ежедневной заметки
    const dailyNoteContent = await app.vault.read(dailyNoteFile);

    // Подготавливаем заголовок для добавления в ежедневную заметку
    const headingToAdd = `### [[${currentNoteName}]]`;

    // Проверяем, есть ли уже заголовок с именем текущей заметки
    if (!dailyNoteContent.includes(headingToAdd)) {
        // Если нет, то добавляем заголовок в конец файла
        await app.vault.append(dailyNoteFile, `\n${headingToAdd}\n`);
    }

    // Проверяем, открыта ли ежедневная заметка
    let leaf = app.workspace.getLeavesOfType('markdown').find(
        (leaf) => leaf.view.file && leaf.view.file.path === dailyNoteFile.path
    );

    if (leaf) {
        // Если заметка уже открыта, переходим в нее
        app.workspace.setActiveLeaf(leaf);
    } else {
        // Если заметка не открыта, открываем ее в новой вкладке
        await app.workspace.getLeaf('tab').openFile(dailyNoteFile);
    }
} catch (error) {
    console.error("Templater Error:", error);
}
%>
```dataviewjs
// Оборачиваем в блок обработки исключений
try {
    // Получаем имя текущей заметки
    const currentNoteName = dv.current().file.name;

    // Получаем все ежедневные заметки в виде массива
    let pages = dv.pages('"periodic/daily"').array();

    // Функция для извлечения даты из имени ежедневной заметки
    function datesFromDailyNotes(filename) {
        // Конвертируем строку формата "DD-MM-YYYY" в объект Date
        return moment(filename, 'DD-MM-YYYY').toDate();
    }

    // Сортируем ежедневные заметки по дате
    pages.sort((a, b) => datesFromDailyNotes(a.file.name) - datesFromDailyNotes(b.file.name));

    // Создаем массивы для оглавления и основного контента
    let tableOfContents = [];
    let mainContent = [];

    // Функция для подготовки заголовка в виде ссылки
    function escapeHeadingForLink(heading) {
        // Убираем из заголовка двойные квадратные скобки
        return heading.slice(2, -2);
    }

    // Проверяем, содержит ли заголовок имя текущей заметки
    function headingLinksToCurrentNote(heading, currentNoteName) {
        return heading.includes(currentNoteName);
    }

    // Проходим по каждой ежедневной заметке
    for (const page of pages) {
        // Получаем значение file.path заметки
        const file = app.vault.getAbstractFileByPath(page.file.path);

        // Получаем кэшированные метаданные файла
        const fileCache = app.metadataCache.getFileCache(file);

        // Проверяем, есть ли в полученном кэше заголовки
        if (fileCache?.headings) {
            // Если заголовки есть, то получаем их
            const headings = fileCache.headings;

            // Получаем содержимое ежедневной заметки
            const fileContent = await app.vault.cachedRead(file);

            // Проходим по каждому заголовку в ежедневной заметке
            for (let i = 0; i < headings.length; i++) {
                const heading = headings[i];

                // Если заголовок в ежедененой заметке совпадает с именем текущуей заметки
                if (headingLinksToCurrentNote(heading.heading, currentNoteName)) {
                    // Определяем начало секции с заголовком
                    const startOffset = heading.position.start.offset;
                    // По умолчанию конец секции - конец заметки
                    let endOffset = fileContent.length;

                    // Ищем конец текущей секции
                    for (let j = i + 1; j < headings.length; j++) {
                        // Если нашли заголовок третьего, второго или первого уровня, то считаем его началом следующей секции
                        if (headings[j].level <= heading.level) {
                            endOffset = headings[j].position.start.offset;
                            break;
                        }
                    }

                    // Извлекаем содержимое секции
                    const sectionContent = fileContent.substring(startOffset, endOffset).trim();
                    // Удаляем первую строку (сам заголовок) из содержимого
                    const contentWithoutHeading = sectionContent.split('\n').slice(1).join('\n').trim();
    
                    // Получаем дату из имени заметки
                    const formattedDate = page.file.name;
                    // Подготавливаем заголовок для вставки в ссылку
                    const encodedHeading = escapeHeadingForLink(heading.heading);
                    // Создаем ссылку, указывающую на секцию ежедневной заметки
                    const dateLink = `[[${page.file.path}#${encodedHeading}|${formattedDate}]]`;
    
                    // Добавляем содержимое секции в основной контент
                    mainContent.push(`**${dateLink}**\n${contentWithoutHeading}`);
                    // Добавляем ссылку на данную секцию в оглавление
                    tableOfContents.push(dateLink);
                }
            }
        }
    }

    // Если список оглавления не пустой, выводим его
    if (tableOfContents.length > 0) {
        dv.header(3, "Оглавление");
        dv.paragraph(tableOfContents.join(' -> '));
    }

    // Если основной контент не пустой, выводим его
    if (mainContent.length > 0) {
        dv.header(3, "Заметки");
        dv.paragraph(mainContent.join('\n\n'));
    }
} catch (error) {
    console.error("Templater Error:", error);
}
```
