/**
 * Чтение/запись файлов и обновление frontmatter. read — cachedRead, modify — полная перезапись.
 */
/** Обновить одно поле frontmatter через processFrontMatter. */
async function updateFrontmatter(app, filePath, key, value) {
    const tFile = app.vault.getAbstractFileByPath(filePath);
    if (!tFile) {
        new Notice(`IO Error: Файл не найден ${filePath}`);
        return;
    }
    await app.fileManager.processFrontMatter(tFile, (frontmatter) => {
        frontmatter[key] = value;
    });
}

/** Прочитать файл: dv.io.load или vault.cachedRead. */
async function read(appOrDv, filePath) {
    if (appOrDv?.io?.load) {
        const content = await appOrDv.io.load(filePath);
        return content ?? null;
    }
    const file = appOrDv.vault.getAbstractFileByPath(filePath);
    if (!file) return null;
    return await appOrDv.vault.cachedRead(file);
}

/** Полная перезапись файла. */
async function modify(app, filePath, newContent) {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (!file) return false;
    await app.vault.modify(file, newContent);
    return true;
}

return {
    updateFrontmatter,
    read,
    modify
};
