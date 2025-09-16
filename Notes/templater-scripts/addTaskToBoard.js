/**
 * Добавляет задачу в указанную колонку на Kanban-доске.
 * @async
 * @param {string} boardName - Имя Kanban-доски (без расширения .md).
 * @param {string} taskName - Имя задачи, которую нужно добавить.
 * @returns {Promise<void>} - Промис, который разрешается после добавления задачи или вывода уведомления.
 */
async function addTaskToBoard(boardName, taskName) {
    // Формируем полный путь к файлу Kanban-доски.
    const kanbanFilePath = `kanban/${boardName}.md`;
    // Получаем объект файла по его пути для дальнейших манипуляций.
    const kanbanFile = app.vault.getAbstractFileByPath(kanbanFilePath);

    // Проверяем, была ли найдена доска. Если нет, выводим уведомление.
    if (!kanbanFile) {
        new Notice(`Kanban-доска "${kanbanFilePath}" не найдена.`);
        // Прерываем выполнение функции, так как доска не найдена.
        return;
    }

    // Считываем содержимое найденного файла доски в переменную.
    const kanbanContent = await app.vault.cachedRead(kanbanFile);
    // Определяем заголовок колонки, в которую по умолчанию будут добавляться задачи.
    const tasksSectionTitle = 'В работе';
    // Создаем регулярное выражение для поиска нужной колонки (секции h2) и всего ее содержимого.
    const taskSectionRegex = new RegExp(`(##\\s*${tasksSectionTitle}\\n)([\\s\\S]*?)(?=\\n##|$)`, 'm');
    // Ищем совпадение в содержимом доски.
    const taskSectionMatch = taskSectionRegex.exec(kanbanContent);

    // Проверяем, была ли найдена колонка. Если нет, выводим уведомление.
    if (!taskSectionMatch) {
        new Notice(`Колонка "${tasksSectionTitle}" не найдена на доске "${boardName}".`);
        // Прерываем выполнение функции, так как колонка не найдена.
        return;
    }

    // Извлекаем заголовок секции (например, "## В работе\n").
    const sectionHeader = taskSectionMatch[1];
    // Извлекаем текущее содержимое секции. Если секция пуста, будет пустая строка.
    const sectionContent = taskSectionMatch[2] || '';

    // Создаем регулярное выражение для проверки, существует ли уже такая задача в колонке.
    const taskExistsRegex = new RegExp(`- \\[ \\] \\[\\[${taskName}\\]\\]`);
    // Проверяем содержимое секции на наличие задачи.
    if (taskExistsRegex.test(sectionContent)) {
        new Notice(`Задача "${taskName}" уже есть в колонке "${tasksSectionTitle}" на доске "${boardName}".`);
        // Прерываем выполнение, чтобы избежать дублирования.
        return;
    }

    // Формируем новое содержимое для секции: старое содержимое + новая задача.
    const newTaskSectionContent = `${sectionContent.trim()}\n- [ ] [[${taskName}]]\n`;
    // Заменяем в полном содержимом доски старую секцию на новую, с добавленной задачей.
    const updatedKanbanContent = kanbanContent.replace(taskSectionRegex, `${sectionHeader}${newTaskSectionContent}`);
    // Перезаписываем файл доски с обновленным содержимым.
    await app.vault.modify(kanbanFile, updatedKanbanContent);
    // Уведомляем пользователя об успешном добавлении задачи.
    new Notice(`Задача "${taskName}" добавлена в колонку "${tasksSectionTitle}" на доске "${boardName}".`);
}

module.exports = addTaskToBoard;