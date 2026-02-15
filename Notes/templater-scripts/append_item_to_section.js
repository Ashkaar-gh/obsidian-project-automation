/**
 * Добавляет элемент в виде ссылки [[item]] в указанную секцию (###) Markdown-файла. Проверяет дубликаты.
 */
async function appendItemToSection(filePath, sectionTitle, itemToAdd, messages) {
    const ui = messages || {
        fileNotFound: (fp) => `Ошибка: файл "${fp}" не найден.`,
        sectionNotFound: (section, fp) => `Ошибка: секция "${section}" не найдена в файле "${fp}".`,
        alreadyExists: (item, section) => `Элемент "${item}" уже существует в секции "${section}". Добавление отменено.`,
        added: (item, section) => `Элемент "${item}" добавлен в секцию "${section}".`
    };
    const file = app.vault.getAbstractFileByPath(filePath);
    if (!file) {
        new Notice(ui.fileNotFound(filePath));
        return;
    }

    const content = await app.vault.cachedRead(file);
    const sectionRegex = new RegExp(`(### ${sectionTitle}:\\n)([\\s\\S]*?)(?=\\n###|$)`);
    const sectionMatch = content.match(sectionRegex);

    if (!sectionMatch) {
        new Notice(ui.sectionNotFound(sectionTitle, filePath));
        return;
    }

    const sectionHeader = sectionMatch[1];
    const sectionContent = sectionMatch[2] || '';
    const itemExistsRegex = new RegExp(`- \\[\\[${itemToAdd}\\]\\]`);
    if (itemExistsRegex.test(sectionContent)) {
        new Notice(ui.alreadyExists(itemToAdd, sectionTitle));
        return;
    }

    const newSectionContent = sectionContent.trim() + `\n- [[${itemToAdd}]]\n`;
    const updatedContent = content.replace(sectionRegex, `${sectionHeader}${newSectionContent}`);
    await app.vault.modify(file, updatedContent);
    new Notice(ui.added(itemToAdd, sectionTitle));
}

module.exports = appendItemToSection;
