/**
 * Выбор одного или нескольких элементов из секции файла по заголовку (###). Парсит списки и вики-ссылки, цикл выбора через tp.system.suggester.
 */
async function selectItemsFromSection(tp, filePath, sectionTitle, promptMessage, messages) {
    const ui = messages || {
        fileNotFound: (fp) => `Ошибка: файл "${fp}" не найден.`,
        sectionNotFound: (section, fp) => `Секция "${section}" не найдена в файле "${fp}".`,
        sectionEmpty: (section) => `Секция "${section}" пуста.`,
        noListItems: (section) => `В секции "${section}" нет элементов списка.`,
        doneOption: "<Завершить выбор>",
        added: (choice) => `Добавлено: "${choice}"`,
        allSelected: "Все доступные элементы выбраны."
    };
    const file = app.vault.getAbstractFileByPath(filePath);
    if (!file) {
        new Notice(ui.fileNotFound(filePath));
        return [];
    }

    const content = await app.vault.cachedRead(file);
    const sectionRegex = new RegExp(`###\\s+${sectionTitle}:?\\n([\\s\\S]*?)(?=\\n###|$)`, 'i');
    const match = content.match(sectionRegex);

    if (!match) {
        new Notice(ui.sectionNotFound(sectionTitle, filePath));
        return [];
    }

    const sectionContent = match[1].trim();
    if (!sectionContent) {
        new Notice(ui.sectionEmpty(sectionTitle));
        return [];
    }

    const lines = sectionContent.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('- ') || line.startsWith('* '));

    let items = lines.map(line => {
        let text = line.substring(2).trim();
        if (text.startsWith('[[') && text.endsWith(']]')) {
            text = text.slice(2, -2);
            if (text.includes('|')) text = text.split('|')[0];
        }
        return text;
    });

    if (items.length === 0) {
        new Notice(ui.noListItems(sectionTitle));
        return [];
    }

    const doneOption = ui.doneOption;
    const selectedItems = [];

    while (items.length > 0) {
        const choice = await tp.system.suggester([doneOption, ...items], [doneOption, ...items], false, promptMessage);
        if (!choice || choice === doneOption) break;

        selectedItems.push(choice);
        items = items.filter(it => it !== choice);
        new Notice(ui.added(choice));

        if (items.length === 0) {
            new Notice(ui.allSelected);
            break;
        }
    }

    return selectedItems;
}

module.exports = selectItemsFromSection;
