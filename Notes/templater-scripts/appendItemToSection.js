/**
 * Добавляет элемент в виде ссылки в указанную секцию файла.
 * @async
 * @param {string} filePath - Путь к файлу, который нужно изменить.
 * @param {string} sectionTitle - Заголовок секции (###), в которую нужно добавить элемент.
 * @param {string} itemToAdd - Текст элемента, который будет обернут в ссылку `[[itemToAdd]]`.
 * @returns {Promise<void>} - Промис, который разрешается после добавления элемента или вывода уведомления.
 */
async function appendItemToSection(filePath, sectionTitle, itemToAdd) {
    // Получаем объект файла по его пути, используя глобальный объект 'app'.
    const file = app.vault.getAbstractFileByPath(filePath);
    // Если файл не найден, выводим уведомление об ошибке.
    if (!file) {
        new Notice(`Ошибка: файл "${filePath}" не найден.`);
        return;
    }

    // Считываем содержимое файла из кэша для быстрого доступа.
    const content = await app.vault.cachedRead(file);
    // Создаем регулярное выражение для поиска секции (заголовок h3) и всего ее содержимого.
    const sectionRegex = new RegExp(`(### ${sectionTitle}:\\n)([\\s\\S]*?)(?=\\n###|$)`);
    // Ищем совпадение в содержимом файла.
    const sectionMatch = content.match(sectionRegex);

    // Если секция не найдена, выводим уведомление об ошибке.
    if (!sectionMatch) {
        new Notice(`Ошибка: секция "${sectionTitle}" не найдена в файле "${filePath}".`);
        return;
    }

    // Извлекаем заголовок секции (например, "### Проекты:\n").
    const sectionHeader = sectionMatch[1];
    // Извлекаем текущее содержимое секции.
    const sectionContent = sectionMatch[2] || '';

    // Создаем регулярное выражение для проверки, существует ли уже такой элемент в секции.
    const itemExistsRegex = new RegExp(`- \\[\\[${itemToAdd}\\]\\]`);
    // Проверяем содержимое секции на наличие элемента.
    if (itemExistsRegex.test(sectionContent)) {
        new Notice(`Элемент "${itemToAdd}" уже существует в секции "${sectionTitle}". Добавление отменено.`);
        // Прерываем выполнение, чтобы избежать дублирования.
        return;
    }

    // Формируем новое содержимое для секции: старое содержимое + новый элемент в виде ссылки.
    const newSectionContent = sectionContent.trim() + `\n- [[${itemToAdd}]]\n`;
    // Заменяем в полном содержимом файла старую секцию на новую.
    const updatedContent = content.replace(sectionRegex, `${sectionHeader}${newSectionContent}`);

    // Перезаписываем файл с обновленным содержимым.
    await app.vault.modify(file, updatedContent);
    // Уведомляем пользователя об успешном добавлении элемента.
    new Notice(`Элемент "${itemToAdd}" добавлен в секцию "${sectionTitle}".`);
}

module.exports = appendItemToSection;