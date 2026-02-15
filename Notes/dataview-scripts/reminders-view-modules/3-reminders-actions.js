/**
 * Действия с напоминаниями: addReminder, updateReminder, deleteReminder (в Trash), processRecurrence. Файл по умолчанию Reminders.md.
 */
async function readContent(pathOrFile, dv) {
    const path = typeof pathOrFile === 'string' ? pathOrFile : pathOrFile?.path;
    if (!path) return null;
    if (dv?.io?.load) {
        const c = await dv.io.load(path);
        return c ?? null;
    }
    const f = app.vault.getAbstractFileByPath(path);
    return f ? await app.vault.read(f) : null;
}

async function addReminder(text, dateValue, recurrence = "", filePath = "Reminders.md", insertAfterLine = -1, dv) {
    let file = app.vault.getAbstractFileByPath(filePath);

    if (!file) {
        if (filePath === "Reminders.md") {
            file = await app.vault.create('Reminders.md', '');
            new Notice("Создан файл Reminders.md");
        } else {
            new Notice(`Ошибка: Файл "${filePath}" не найден.`);
            return false;
        }
    }

    const m = moment(dateValue);
    if (!m.isValid()) {
        new Notice("Некорректная дата");
        return false;
    }

    const dateTag = `(@${m.format('DD-MM-YYYY HH:mm')})`;
    const recurTag = recurrence ? `(${recurrence})` : "";
    let newLine = `- [ ] ${text} ${recurTag} ${dateTag}`;

    if (insertAfterLine >= 0) {
        const content = await readContent(filePath, dv);
        if (content != null) {
            const lines = content.split('\n');
            if (insertAfterLine < lines.length) {
            const parentLine = lines[insertAfterLine];
            const indentMatch = parentLine.match(/^\s*/);
            const indentation = indentMatch ? indentMatch[0] : "";
            
            newLine = `${indentation}${newLine}`;
            lines.splice(insertAfterLine + 1, 0, newLine);
            
            await app.vault.modify(file, lines.join('\n'));
            new Notice(`Напоминание добавлено в ${file.basename}`);
            return true;
            }
        }
    }

    await app.vault.append(file, `\n${newLine}`);
    new Notice(`Напоминание добавлено в ${file.basename}`);
    return true;
}

/**
 * Редактирует текст напоминания.
 * 
 * @param {string} filePath - Путь к файлу.
 * @param {string} originalLineText - Исходный текст строки для поиска.
 * @param {string} newDescription - Новый текст напоминания.
 * @returns {Promise<boolean>} Результат выполнения операции.
 */
async function editReminder(filePath, originalLineText, newDescription, dv) {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (!file) return false;

    const content = await readContent(filePath, dv);
    if (content == null) return false;
    const lines = content.split('\n');
    const normalize = (str) => str.replace(/\s+/g, ' ').trim();
    const searchNormalized = normalize(originalLineText.split('\n')[0]);
    const indexToEdit = lines.findIndex(line => normalize(line).includes(searchNormalized));

    if (indexToEdit === -1) {
        new Notice("Не удалось найти задачу для редактирования.");
        return false;
    }

    const currentLine = lines[indexToEdit];
    const indentMatch = currentLine.match(/^\s*[-*]\s+\[.\]\s/);
    const prefix = indentMatch ? indentMatch[0] : "- [ ] ";
    
    lines[indexToEdit] = `${prefix}${newDescription}`;
    
    await app.vault.modify(file, lines.join('\n'));
    new Notice("Напоминание обновлено");
    return true;
}

/**
 * Удаляет напоминание (переносит в корзину).
 * 
 * @param {string} filePath - Путь к файлу.
 * @param {string} originalText - Текст напоминания для удаления.
 * @param {number} lineIdx - Предполагаемый индекс строки.
 * @returns {Promise<boolean>} Результат выполнения операции.
 */
async function deleteReminder(filePath, originalText, lineIdx, trashFilePath, dv) {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (!file) return false;

    const content = await readContent(filePath, dv);
    if (content == null) return false;
    const lines = content.split('\n');
    const normalize = (str) => str.replace(/\s+/g, ' ').trim();
    const searchNormalized = normalize(originalText.split('\n')[0]);
    let indexToRemove = -1;

    if (lines[lineIdx]) {
        if (normalize(lines[lineIdx]).includes(searchNormalized)) {
            indexToRemove = lineIdx;
        }
    }

    if (indexToRemove === -1) {
        indexToRemove = lines.findIndex(line => {
            const taskRegex = /^\s*[-*]\s+\[[ xX]\]/;
            if (!taskRegex.test(line)) return false;
            return normalize(line).includes(searchNormalized);
        });
    }

    if (indexToRemove === -1) {
        new Notice("Не удалось найти исходную задачу для удаления.");
        return false;
    }

    const lineContent = lines[indexToRemove];
    const path = trashFilePath || 'Trash.md';
    const trashFile = app.vault.getAbstractFileByPath(path);

    if (trashFile) {
        await app.vault.append(trashFile, `\n${lineContent}`);
    } else {
        new Notice(`Warning: ${path} не найден, задача удалена безвозвратно.`);
    }

    lines.splice(indexToRemove, 1);
    await app.vault.modify(file, lines.join('\n'));
    new Notice("Напоминание перемещено в корзину");
    return true;
}

/**
 * Обрабатывает логику повторения напоминания (создает новую копию).
 * 
 * @param {string} originalText - Исходный текст напоминания.
 * @param {string} sourceFilePath - Путь к файлу источника.
 * @param {number} parentLineIndex - Индекс родительской строки.
 */
async function processRecurrence(originalText, sourceFilePath = "Reminders.md", parentLineIndex = -1) {
    const regex = /\(every\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)\)/i;
    const match = originalText.match(regex);
    if (!match) return;

    const amount = parseInt(match[1]);
    const unit = match[2];
    const nextDate = moment().add(amount, unit);

    const textWithoutDate = originalText.replace(/\(@\d{2,4}[-.]\d{2}[-.]\d{2,4}(?:[T\s]\d{1,2}:\d{2})?\)/g, "").trim();
    const textClean = textWithoutDate.replace(regex, "").trim();
    const recurrenceStr = `every ${amount} ${unit}`;

    await addReminder(textClean, nextDate.format('YYYY-MM-DDTHH:mm'), recurrenceStr, sourceFilePath, parentLineIndex);
    new Notice(`Создана следующая задача: через ${amount} ${unit}`);
}

/**
 * Сканирует файл на наличие выполненных повторяющихся напоминаний.
 * 
 * @param {TFile} file - Файл для сканирования.
 */
async function scanAndProcessRecurrences(file, dv) {
    const content = await readContent(file, dv);
    if (content == null) return;
    const lines = content.split('\n');
    
    const regex = /^(\s*)[-*]\s+\[[xX]\]\s+(.*)(\(every\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)\))(.*)$/i;
    let modified = false;

    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const match = line.match(regex);

        if (match) {
            const indent = match[1];
            const textPrefix = match[2];
            const recurrenceFull = match[3];
            const amount = parseInt(match[4]);
            const unit = match[5];
            const textSuffix = match[6];

            const originalTaskContent = textPrefix + recurrenceFull + textSuffix;
            let textClean = originalTaskContent.replace(/\(@\d{2,4}[-.]\d{2}[-.]\d{2,4}(?:[T\s]\d{1,2}:\d{2})?\)/g, "");
            textClean = textClean.replace(recurrenceFull, "").trim();

            const nextDate = moment().add(amount, unit);
            const recurrenceStr = `every ${amount} ${unit}`;
            const newDateTag = `(@${nextDate.format('DD-MM-YYYY HH:mm')})`;
            
            const newTaskLine = `${indent}- [ ] ${textClean} (${recurrenceStr}) ${newDateTag}`;

            lines.splice(i + 1, 0, newTaskLine);

            const completedLineWithoutRecurrence = line.replace(recurrenceFull, "").trimEnd();
            lines[i] = completedLineWithoutRecurrence;

            modified = true;
            new Notice(`Создана следующая задача: через ${amount} ${unit}`);
        }
    }

    if (modified) {
        await app.vault.modify(file, lines.join('\n'));
    }
}

/**
 * Помечает напоминание как выполненное (ставит галочку [x]).
 * 
 * @param {string} filePath - Путь к файлу.
 * @param {string} originalText - Текст напоминания.
 * @param {number} lineIdx - Индекс строки.
 * @returns {Promise<boolean>} Результат выполнения.
 */
async function completeReminder(filePath, originalText, lineIdx = -1, dv) {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (!file) return false;

    const content = await readContent(filePath, dv);
    if (content == null) return false;
    const lines = content.split('\n');
    
    const markLine = (idx) => { 
        lines[idx] = lines[idx].replace(/^(\s*[-*]\s+)\[\s\]/, '$1[x]'); 
    };

    const normalize = (str) => str.replace(/\s+/g, ' ').trim();
    const searchNormalized = normalize(originalText.split('\n')[0]);

    let targetIndex = -1;

    if (lineIdx >= 0 && lines[lineIdx]) {
        if (normalize(lines[lineIdx]).includes(searchNormalized)) {
            targetIndex = lineIdx;
        }
    } 
    
    if (targetIndex === -1) {
        targetIndex = lines.findIndex(l => {
            if (l.includes('[x]')) return false;
            return normalize(l).includes(searchNormalized);
        });
    }

    if (targetIndex !== -1) {
        markLine(targetIndex);
        await app.vault.modify(file, lines.join('\n'));
        return true;
    }

    new Notice("Не удалось найти задачу для завершения.");
    return false;
}

/**
 * Переносит напоминание на указанное количество минут от ТЕКУЩЕГО времени.
 * Изменяет текст в файле.
 * 
 * @param {string} filePath - Путь к файлу.
 * @param {string} originalText - Исходный текст напоминания.
 * @param {number} minutesFromNow - Время отсрочки в минутах.
 * @returns {Promise<boolean>} Результат выполнения.
 */
async function snoozeReminder(filePath, originalText, minutesFromNow, dv) {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (!file) return false;

    const content = await readContent(filePath, dv);
    if (content == null) return false;
    const lines = content.split('\n');

    const normalize = (str) => str.replace(/\s+/g, ' ').trim();
    const searchNormalized = normalize(originalText.split('\n')[0]);

    let lineIdx = lines.findIndex(line => normalize(line).includes(searchNormalized));

    if (lineIdx === -1) {
        new Notice("Не удалось найти задачу для переноса.");
        return false;
    }

    const newTime = moment().add(minutesFromNow, 'minutes');
    const newDateTag = `(@${newTime.format('DD-MM-YYYY HH:mm')})`;

    const dateRegex = /\(@\d{2,4}[-.]\d{2}[-.]\d{2,4}(?:[T\s]\d{1,2}:\d{2})?\)/;

    let currentLine = lines[lineIdx];

    if (dateRegex.test(currentLine)) {
        lines[lineIdx] = currentLine.replace(dateRegex, newDateTag);
    } else {
        lines[lineIdx] = `${currentLine} ${newDateTag}`;
    }

    await app.vault.modify(file, lines.join('\n'));
    return true;
}

/**
 * Устанавливает новую конкретную дату для напоминания.
 * 
 * @param {string} filePath - Путь к файлу.
 * @param {string} originalText - Исходный текст.
 * @param {string} newDateIso - Новая дата в формате ISO или совместимом.
 */
async function setReminderDate(filePath, originalText, newDateIso, dv) {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (!file) return false;

    const content = await readContent(filePath, dv);
    if (content == null) return false;
    const lines = content.split('\n');

    const normalize = (str) => str.replace(/\s+/g, ' ').trim();
    const searchNormalized = normalize(originalText.split('\n')[0]);
    let lineIdx = lines.findIndex(line => normalize(line).includes(searchNormalized));

    if (lineIdx === -1) {
        new Notice("Не удалось найти задачу.");
        return false;
    }

    const newTime = moment(newDateIso);
    const newDateTag = `(@${newTime.format('DD-MM-YYYY HH:mm')})`;

    const dateRegex = /\(@\d{2,4}[-.]\d{2}[-.]\d{2,4}(?:[T\s]\d{1,2}:\d{2})?\)/;

    let currentLine = lines[lineIdx];

    if (dateRegex.test(currentLine)) {
        lines[lineIdx] = currentLine.replace(dateRegex, newDateTag);
    } else {
        lines[lineIdx] = `${currentLine} ${newDateTag}`;
    }

    await app.vault.modify(file, lines.join('\n'));
    return true;
}

return { 
    addReminder, 
    editReminder, 
    deleteReminder, 
    processRecurrence, 
    scanAndProcessRecurrences,
    completeReminder,
    snoozeReminder,
    setReminderDate
};