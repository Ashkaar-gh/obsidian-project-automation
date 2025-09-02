---
project: %%project%%
instance: %%instance%%
kanban: %%kanban%%
date: %%date%%
cssclasses:
  - wide-page
---
## Описании задачи

## Критерий выполнения

## Cписок подзадач
- [ ] 
```dataviewjs
// Получаем имя текущей заметки
const currentNoteName = dv.current().file.name;

// Получаем все ежедневные заметки в виде массива
let pages = dv.pages('"periodic/daily"').array();

/**
 * Извлекает дату из имени файла ежедневной заметки.
 * @param {string} filename - Имя файла в формате "DD-MM-YYYY".
 * @returns {Date} - Объект Date.
 */
function datesFromDailyNotes(filename) {
    // Конвертируем строку формата "DD-MM-YYYY" в объект Date
    return moment(filename, 'DD-MM-YYYY').toDate();
}

// Сортируем ежедневные заметки по дате
pages.sort((a, b) => datesFromDailyNotes(a.file.name) - datesFromDailyNotes(b.file.name));

// Создаем массивы для оглавления и основного контента
let tableOfContents = [];
let mainContent = [];

/**
 * Подготавливает текст заголовка для использования в Markdown-ссылке.
 * @param {string} heading - Текст заголовка, содержащий ссылку (например, "### [[Задача]]").
 * @returns {string} - Очищенный текст заголовка.
 */
function escapeHeadingForLink(heading) {
    // Убираем из заголовка двойные квадратные скобки
    return heading.slice(2, -2);
}

/**
 * Проверяет, содержит ли заголовок ссылку на текущую заметку.
 * @param {string} heading - Текст заголовка для проверки.
 * @param {string} currentNoteName - Имя текущей заметки.
 * @returns {boolean} - True, если заголовок содержит ссылку на заметку.
 */
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
```
