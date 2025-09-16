/**
 * Асинхронно загружает все необходимые данные для работы Inbox.
 * Читает содержимое файлов Inbox.md и шаблона задачи.
 * @returns {Promise<object|null>} Объект с данными или null в случае ошибки.
 */
async function loadInboxData() {
    // Получаем файлы Inbox и шаблона задачи одновременно для эффективности.
    const [inboxFile, templateFile] = await Promise.all([
        app.vault.getAbstractFileByPath('Inbox.md'),
        app.vault.getAbstractFileByPath('templates/task.md')
    ]);

    // Проверяем наличие обоих файлов, так как без них работа невозможна.
    if (!inboxFile || !templateFile) {
        const missingFile = !inboxFile ? 'Inbox.md' : 'templates/task.md';
        new Notice(`Критическая ошибка: файл "${missingFile}" не найден.`);
        return null;
    }

    // Читаем содержимое шаблона задачи и Inbox одновременно.
    const [templateContent, inboxContent] = await Promise.all([
        app.vault.cachedRead(templateFile),
        app.vault.cachedRead(inboxFile)
    ]);

    // Разбиваем содержимое на строки и обрезаем пробелы.
    const allLines = inboxContent.split('\n').map(line => line.trim());
    // Фильтруем строки для отображения (игнорируем уже помеченные как задачи).
    const visibleLines = allLines.filter(line => line.length > 0 && !line.startsWith('- ['));

    // Возвращаем структурированный объект со всеми необходимыми данными.
    return {
        inboxFile,
        templateFile,
        templateContent,
        inboxContent,
        allLines,
        visibleLines
    };
}

/**
 * Функция для обновления содержимого файла и уведомления пользователя, если содержимое изменилось.
 * @param {TFile} file - Файл, который нужно обновить.
 * @param {string} newContent - Новое содержимое файла.
 * @param {string} currentContent - Текущее содержимое файла для сравнения.
 * @param {string} message - Сообщение для уведомления пользователя.
 */
async function updateContentAndNotify(file, newContent, currentContent, message) {
    // Проверяем, изменилось ли содержимое, чтобы избежать лишних операций записи.
    if (newContent !== currentContent) {
        // Модифицируем файл новым содержимым.
        await app.vault.modify(file, newContent);
        // Показываем уведомление, если сообщение задано.
        if (message) new Notice(message);
    }
}

/**
 * Функция для добавления новой записи в файл Inbox.
 * @param {string} newItem - Текст новой записи.
 */
async function addNewItemToInbox(newItem) {
    const inboxFilePath = 'Inbox.md';
    const inboxFile = app.vault.getAbstractFileByPath(inboxFilePath);

    if (!inboxFile) {
        new Notice(`Ошибка: Файл "${inboxFilePath}" не найден.`);
        return;
    }

    // Читаем текущее содержимое Inbox.
    const content = await app.vault.cachedRead(inboxFile);
    // Добавляем новую запись к содержимому, обеспечивая чистоту формата.
    const updatedContent = `${content}\n${newItem}`.trim();

    // Обновляем файл и показываем уведомление.
    await updateContentAndNotify(inboxFile, updatedContent, content, `Добавлено: "${newItem}"`);
}

/**
 * Функция для удаления строки из Inbox и добавления её в Trash.
 * @param {string} originalText - Исходный текст строки.
 * @param {Array} allLines - Массив всех строк из Inbox.
 * @param {TFile} inboxFile - Файл Inbox, который нужно обновить.
 */
async function deleteItem(originalText, allLines, inboxFile) {
    const trashFilePath = 'Trash.md';
    const trashFile = app.vault.getAbstractFileByPath(trashFilePath);

    if (!trashFile) {
        new Notice('Ошибка: файл Trash.md не найден.');
        return false; // Возвращаем false в случае неудачи.
    }

    // Читаем текущее содержимое Trash.
    const trashContent = await app.vault.cachedRead(trashFile);
    // Добавляем удалённую строку в Trash.
    const updatedTrashContent = `${trashContent}\n${originalText}`.trim();
    // Обновляем файл Trash и показываем уведомление.
    await updateContentAndNotify(
        trashFile,
        updatedTrashContent,
        trashContent,
        `Удалено: "${originalText}"`
    );

    // Удаление строки из Inbox.
    const index = allLines.indexOf(originalText);
    if (index !== -1) {
        allLines.splice(index, 1);
        const updatedContent = allLines.join('\n');
        const inboxContent = await app.vault.cachedRead(inboxFile);
        // Обновляем файл Inbox без сообщения.
        await updateContentAndNotify(inboxFile, updatedContent, inboxContent, '');
        return true; // Возвращаем true в случае успеха.
    }
    return false;
}

/**
 * Функция для создания новой задачи через шаблон main.md и удаления строки из Inbox.
 * @param {string} originalText - Исходный текст строки.
 * @param {Array} allLines - Массив всех строк из Inbox.
 * @param {TFile} inboxFile - Файл Inbox.
 */
async function createTask(originalText, allLines, inboxFile) {
    // Очищаем имя файла от недопустимых символов.
    const sanitizedFileName = originalText.replace(/[\\\/:*?"<>|]/g, '').trim();
    if (!sanitizedFileName) {
        new Notice("Ошибка: имя задачи не может быть пустым.");
        return false;
    }

    // Определяем путь к файлу будущей задачи.
    const newFilePath = `${sanitizedFileName}.md`;
    // Проверяем, существует ли уже файл по этому пути.
    if (app.vault.getAbstractFileByPath(newFilePath)) {
        new Notice(`Ошибка: Заметка с именем "${sanitizedFileName}" уже существует.`);
        return false;
    }

    // Устанавливаем глобальный контекст с желаемым именем для скрипта main.md.
    window.INBOX_CONTEXT = {
        noteType: 'task',
        noteName: sanitizedFileName
    };

    // Создаем временный файл и запускаем скрипт main.md.
    const tempFile = await app.vault.create(`temp-task-${Date.now()}.md`, '');
    await app.workspace.getLeaf().openFile(tempFile);
    new Notice(`Запускается создание задачи: "${sanitizedFileName}"`);

    // Удаляем исходную строку из Inbox.
    const index = allLines.indexOf(originalText);
    if (index !== -1) {
        const currentInboxContent = await app.vault.cachedRead(inboxFile);
        allLines.splice(index, 1);
        const updatedContent = allLines.join('\n');
        await updateContentAndNotify(inboxFile, updatedContent, currentInboxContent, '');
        return true;
    }
    return false;
}

/**
 * Обновляет статус для указанной строки в массиве строк.
 * @param {string} originalText - Исходный текст строки.
 * @param {Array} allLines - Массив всех строк из Inbox.
 * @param {TFile} inboxFile - Файл Inbox.
 * @param {string} status - Новый статус (например, 'In progress').
 * @param {string} symbol - Символ статуса (например, '/').
 */
async function updateItemStatus(originalText, allLines, inboxFile, status, symbol) {
    const index = allLines.indexOf(originalText);
    if (index === -1) return;

    const currentContent = await app.vault.cachedRead(inboxFile);
    // Обновляем строку с новым статусом.
    allLines[index] = `- [${symbol}] ${originalText}`;
    const updatedContent = allLines.join('\n');

    await updateContentAndNotify(
        inboxFile,
        updatedContent,
        currentContent,
        `Статус "${originalText}" изменен на "${status}"`
    );
}

/**
 * Обновляет дату и время для указанной строки.
 * @param {string} originalText - Исходный текст строки.
 * @param {Array} allLines - Массив всех строк из Inbox.
 * @param {TFile} inboxFile - Файл Inbox.
 * @param {string} dateTime - Выбранная дата и время.
 */
async function updateItemDateTime(originalText, allLines, inboxFile, dateTime) {
    const index = allLines.indexOf(originalText);
    if (index === -1) return;

    const currentContent = await app.vault.cachedRead(inboxFile);
    // Формируем новую строку с датой и временем.
    const newLine = `- [ ] ${originalText} (@${dateTime})`;
    allLines[index] = newLine;
    const updatedContent = allLines.join('\n');

    await updateContentAndNotify(
        inboxFile,
        updatedContent,
        currentContent,
        `Добавлено время: "${dateTime}"`
    );
}

// "Экспортируем" все функции, чтобы их можно было вызвать в главном скрипте.
return {
    loadInboxData,
    updateContentAndNotify,
    addNewItemToInbox,
    deleteItem,
    createTask,
    updateItemStatus,
    updateItemDateTime
};