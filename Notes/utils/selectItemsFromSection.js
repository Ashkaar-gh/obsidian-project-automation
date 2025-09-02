/**
 * Позволяет пользователю выбрать один или несколько элементов из указанной секции файла.
 * @async
 * @param {object} tp - Объект API Templater.
 * @param {string} filePath - Путь к файлу, из которого нужно прочитать элементы.
 * @param {string} sectionTitle - Заголовок секции (###), из которой извлекаются элементы.
 * @param {string} promptMessage - Сообщение, которое будет показано пользователю в окне выбора.
 * @returns {Promise<string[]>} - Промис, который разрешается массивом выбранных пользователем строк.
 */
async function selectItemsFromSection(tp, filePath, sectionTitle, promptMessage) {
    // Получаем объект файла по его пути.
    const file = app.vault.getAbstractFileByPath(filePath);
    // Если файл не найден, выводим ошибку и возвращаем пустой массив.
    if (!file) {
        new Notice(`Ошибка: файл "${filePath}" не найден.`);
        return [];
    }

    // Считываем содержимое файла.
    const content = await app.vault.cachedRead(file);
    // Создаем регулярное выражение для поиска нужной секции (заголовок h3) и ее содержимого.
    const sectionRegex = new RegExp(`###\\s+${sectionTitle}:?\\n([\\s\\S]*?)(?=\\n###|$)`);
    // Ищем совпадение в содержимом файла.
    const match = content.match(sectionRegex);

    // Если секция не найдена, выводим уведомление и возвращаем пустой массив.
    if (!match) {
        new Notice(`Секция "${sectionTitle}" не найдена в файле "${filePath}".`);
        return [];
    }

    // Извлекаем содержимое секции и удаляем лишние пробелы по краям.
    const sectionContent = match[1].trim();
    // Ищем все элементы списка, которые являются ссылками (например, "- [[Проект 1]]").
    const matchesIterator = sectionContent.matchAll(/- \[\[(.*?)\]\]/g);
    // Преобразуем итератор с результатами в массив строк (извлекаем только имена из ссылок).
    let items = Array.from(matchesIterator, m => m[1]);

    // Если в секции не найдено элементов, выводим уведомление и возвращаем пустой массив.
    if (items.length === 0) {
        new Notice(`Секция "${sectionTitle}" пуста.`);
        return [];
    }

    // Определяем текстовую опцию для завершения выбора в меню.
    const doneOption = "<Завершить выбор>";
    // Создаем пустой массив для хранения выбранных пользователем элементов.
    let selectedItems = [];

    // Запускаем цикл, который будет продолжаться, пока есть элементы для выбора.
    while (items.length > 0) {
        // Показываем пользователю модальное окно выбора (suggester) с доступными элементами.
        const choice = await tp.system.suggester([doneOption, ...items], [doneOption, ...items], false, promptMessage);

        // Если пользователь отменил выбор (нажал Esc) или выбрал опцию завершения, выходим из цикла.
        if (!choice || choice === doneOption) {
            new Notice(`Выбор "${sectionTitle}" завершён.`);
            break;
        }

        // Добавляем сделанный выбор в массив выбранных элементов.
        selectedItems.push(choice);
        // Удаляем выбранный элемент из списка доступных, чтобы он не появился снова.
        items = items.filter(item => item !== choice);
        // Уведомляем пользователя о добавлении элемента.
        new Notice(`Элемент "${choice}" добавлен.`);

        // Если все элементы из секции были выбраны, выводим уведомление и выходим из цикла.
        if (items.length === 0) {
            new Notice(`Все элементы из секции "${sectionTitle}" выбраны.`);
            break;
        }
    }
    // Возвращаем массив с элементами, которые выбрал пользователь.
    return selectedItems;
}

module.exports = selectItemsFromSection;