/**
 * Находит или создает сегодняшнюю ежедневную заметку, добавляет в нее ссылку на задачу
 * и ВОЗВРАЩАЕТ объект файла этой ежедневной заметки.
 * @async
 * @param {object} tp - Объект API Templater.
 * @param {object} app - Глобальный объект Obsidian App.
 * @param {string} currentNoteName - Имя текущей заметки (задачи), на которую нужно сослаться.
 * @returns {Promise<TFile|null>} - Промис, который разрешается объектом файла ежедневной заметки (TFile) или null в случае ошибки.
 */
async function linkToDailyNote(tp, app, currentNoteName) {
    // Определяем папку, где хранятся ежедневные заметки.
    const dailyNoteCatalog = 'periodic/daily';
    // Получаем текущую дату в нужном формате "ДД-ММ-ГГГГ".
    const currentDate = tp.date.now("DD-MM-YYYY");
    // Формируем полный путь к файлу сегодняшней ежедневной заметки.
    const dailyNotePath = `${dailyNoteCatalog}/${currentDate}.md`;

    // Пытаемся получить объект файла по сформированному пути.
    let dailyNoteFile = app.vault.getAbstractFileByPath(dailyNotePath);

    // Проверяем, существует ли файл. Если нет (dailyNoteFile равен null), то создаем его.
    if (!dailyNoteFile) {
        // Находим файл шаблона для ежедневных заметок по его имени 'daily'.
        const dailyTemplate = tp.file.find_tfile("daily");
        // Если шаблон не найден, выводим уведомление и прерываем выполнение.
        if (!dailyTemplate) {
            new Notice("Шаблон для ежедневных заметок 'daily' не найден!");
            return null;
        }
        // Создаем новый файл из шаблона в нужной папке и с нужным именем.
        dailyNoteFile = await tp.file.create_new(dailyTemplate, `${dailyNoteCatalog}/${currentDate}`);
        // Уведомляем пользователя о создании новой заметки.
        new Notice(`Создана ежедневная заметка: ${currentDate}`);
    }

    // Считываем содержимое ежедневной заметки (существующей или только что созданной).
    const dailyNoteContent = await app.vault.read(dailyNoteFile);
    // Формируем строку заголовка со ссылкой на текущую задачу.
    const headingToAdd = `### [[${currentNoteName}]]`;

    // Проверяем, не содержит ли файл уже такой заголовок, чтобы избежать дублирования.
    if (!dailyNoteContent.includes(headingToAdd)) {
        // Если заголовок отсутствует, добавляем его в конец файла.
        await app.vault.append(dailyNoteFile, `\n${headingToAdd}\n`);
    }

    // Возвращаем объект файла ежедневной заметки для дальнейшего использования (например, для открытия).
    return dailyNoteFile;
}

module.exports = linkToDailyNote;