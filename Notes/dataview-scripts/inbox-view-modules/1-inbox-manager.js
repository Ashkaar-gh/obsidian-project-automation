/**
 * Inbox: loadInboxData(paths), addNewItemToInbox, editItem, deleteItem, createTask, updateItemDateTime.
 * Кэш шаблона задачи по mtime.
 */
let _templateCache = null;
let _templateMtime = 0;

async function readPath(pathOrFile, dv) {
    const path = typeof pathOrFile === 'string' ? pathOrFile : pathOrFile?.path;
    if (!path) return null;
    if (dv?.io?.load) {
        const c = await dv.io.load(path);
        return c ?? null;
    }
    const f = app.vault.getAbstractFileByPath(path);
    return f ? await app.vault.cachedRead(f) : null;
}

async function loadInboxData(paths, dv) {
    const inboxFile = app.vault.getAbstractFileByPath(paths.INBOX_FILE);
    const templateFile = app.vault.getAbstractFileByPath(paths.TASK_TEMPLATE_PATH);

    if (!inboxFile || !templateFile) {
        const missingFile = !inboxFile ? paths.INBOX_FILE : paths.TASK_TEMPLATE_PATH;
        new Notice(`Критическая ошибка: файл "${missingFile}" не найден.`);
        return null;
    }

    if (!_templateCache || templateFile.stat.mtime !== _templateMtime) {
        _templateCache = await readPath(paths.TASK_TEMPLATE_PATH, dv) ?? await app.vault.cachedRead(templateFile);
        _templateMtime = templateFile.stat.mtime;
    }
    const templateContent = _templateCache;

    const inboxContent = await readPath(paths.INBOX_FILE, dv);
    if (inboxContent == null) {
        new Notice(`Критическая ошибка: не удалось прочитать "${paths.INBOX_FILE}".`);
        return null;
    }
    const allLines = inboxContent.split('\n').map(line => line.trim());
    const visibleLines = allLines.filter(line => line.length > 0 && !line.startsWith('- ['));

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
 * Обновляет содержимое файла и выводит уведомление при наличии изменений.
 * @param {TFile} file - Целевой файл.
 * @param {string} newContent - Новое содержимое.
 * @param {string} currentContent - Текущее содержимое.
 * @param {string} message - Сообщение для уведомления.
 */
async function updateContentAndNotify(file, newContent, currentContent, message) {
    if (newContent !== currentContent) {
        await app.vault.modify(file, newContent);
        if (message) new Notice(message);
    }
}

/**
 * Добавляет новую запись в конец файла Inbox.
 * @param {string} newItem - Текст новой записи.
 */
async function addNewItemToInbox(newItem, paths, dv) {
    const inboxFile = app.vault.getAbstractFileByPath(paths.INBOX_FILE);

    if (!inboxFile) {
        new Notice(`Ошибка: Файл "${paths.INBOX_FILE}" не найден.`);
        return;
    }

    const content = (await readPath(paths.INBOX_FILE, dv)) ?? '';
    const updatedContent = `${content}\n${newItem}`.trim();

    await updateContentAndNotify(inboxFile, updatedContent, content, `Добавлено: "${newItem}"`);
}

/**
 * Редактирует существующую запись в Inbox.
 * @param {string} originalText - Старый текст записи.
 * @param {string} newText - Новый текст записи.
 * @param {string[]} allLines - Массив всех строк файла.
 * @param {TFile} inboxFile - Файл Inbox.
 * @returns {Promise<boolean>} Результат операции.
 */
async function editItem(originalText, newText, allLines, inboxFile, dv) {
    if (!newText || !newText.trim()) return false;
    const index = allLines.indexOf(originalText);
    if (index !== -1) {
        allLines[index] = newText.trim();
        const updatedContent = allLines.join('\n');
        const currentContent = (await readPath(inboxFile, dv)) ?? '';
        await updateContentAndNotify(inboxFile, updatedContent, currentContent, "Запись обновлена");
        return true;
    }
    return false;
}

/**
 * Удаляет запись из Inbox и перемещает её в корзину.
 * @param {string} originalText - Текст удаляемой записи.
 * @param {string[]} allLines - Массив всех строк файла.
 * @param {TFile} inboxFile - Файл Inbox.
 * @returns {Promise<boolean>} Результат операции.
 */
async function deleteItem(originalText, allLines, inboxFile, paths, dv) {
    const trashFile = app.vault.getAbstractFileByPath(paths.TRASH_FILE);

    if (!trashFile) {
        new Notice(`Ошибка: файл ${paths.TRASH_FILE} не найден.`);
        return false;
    }

    const trashContent = (await readPath(paths.TRASH_FILE, dv)) ?? '';
    const updatedTrashContent = `${trashContent}\n${originalText}`.trim();
    
    await updateContentAndNotify(
        trashFile,
        updatedTrashContent,
        trashContent,
        `Удалено: "${originalText}"`
    );

    const index = allLines.indexOf(originalText);
    if (index !== -1) {
        allLines.splice(index, 1);
        const updatedContent = allLines.join('\n');
        const inboxContent = (await readPath(inboxFile, dv)) ?? '';
        await updateContentAndNotify(inboxFile, updatedContent, inboxContent, '');
        return true;
    }
    return false;
}

/**
 * Создает новую задачу на основе записи из Inbox.
 * @param {string} originalText - Текст записи.
 * @param {string[]} allLines - Массив строк.
 * @param {TFile} inboxFile - Файл Inbox.
 * @returns {Promise<boolean>} Результат операции.
 */
async function createTask(originalText, allLines, inboxFile, dv) {
    const sanitizedFileName = originalText.replace(/[\\\/:*?"<>|]/g, '').trim();
    if (!sanitizedFileName) {
        new Notice("Ошибка: имя задачи не может быть пустым.");
        return false;
    }

    const newFilePath = `${sanitizedFileName}.md`;
    if (app.vault.getAbstractFileByPath(newFilePath)) {
        new Notice(`Ошибка: Заметка с именем "${sanitizedFileName}" уже существует.`);
        return false;
    }

    window.INBOX_CONTEXT = {
        noteType: 'task',
        noteName: sanitizedFileName
    };

    const tempFile = await app.vault.create(`temp-task-${Date.now()}.md`, '');
    await app.workspace.getLeaf().openFile(tempFile);
    new Notice(`Запускается создание задачи: "${sanitizedFileName}"`);

    const index = allLines.indexOf(originalText);
    if (index !== -1) {
        const currentInboxContent = (await readPath(inboxFile, dv)) ?? '';
        allLines.splice(index, 1);
        const updatedContent = allLines.join('\n');
        await updateContentAndNotify(inboxFile, updatedContent, currentInboxContent, '');
        return true;
    }
    return false;
}

/**
 * Перемещает запись из Inbox в Reminders.md с добавлением даты и повторения.
 * 
 * @param {string} originalText - Исходный текст записи.
 * @param {Array<string>} allLines - Массив строк Inbox.
 * @param {TFile} inboxFile - Объект файла Inbox.
 * @param {string} dateTime - Строка с датой и временем.
 * @param {string} recurrence - Строка с настройкой повторения (опционально).
 */
async function updateItemDateTime(originalText, allLines, inboxFile, dateTime, recurrence = "") {
    const index = allLines.indexOf(originalText);
    if (index === -1) return;

    allLines.splice(index, 1);
    const updatedInboxContent = allLines.join('\n');
    
    await app.vault.modify(inboxFile, updatedInboxContent);

    let remindersFile = app.vault.getAbstractFileByPath('Reminders.md');
    
    if (!remindersFile) {
        remindersFile = await app.vault.create('Reminders.md', '');
        new Notice("Создан файл Reminders.md");
    }

    const recurTag = recurrence ? `(${recurrence})` : "";
    const newLine = `- [ ] ${originalText} ${recurTag} (@${dateTime})`;
    
    await app.vault.append(remindersFile, `\n${newLine}`);

    new Notice(`Перемещено в Reminders: "${dateTime}"`);
}

return {
    loadInboxData,
    updateContentAndNotify,
    addNewItemToInbox,
    editItem,
    deleteItem,
    createTask,
    updateItemDateTime
};