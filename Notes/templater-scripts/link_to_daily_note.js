/**
 * Находит или создаёт ежедневную заметку на указанную дату, добавляет ссылку на задачу, возвращает TFile. dateStr в формате ДД-ММ-ГГГГ; если не передан — сегодня.
 */
async function linkToDailyNote(tp, app, currentNoteName, dateStr, dailyUi) {
    const defaultCreatedNotice = function(date) { return "Создана ежедневная заметка: " + date; };
    const ui = dailyUi || {
        templateNotFoundNotice: "Шаблон для ежедневных заметок 'daily' не найден!",
        createdNotice: defaultCreatedNotice
    };
    const dailyNoteCatalog = 'periodic/daily';
    const currentDate = dateStr || tp.date.now("DD-MM-YYYY");
    const dailyNotePath = `${dailyNoteCatalog}/${currentDate}.md`;

    let dailyNoteFile;
    if (await tp.file.exists(dailyNotePath)) {
        dailyNoteFile = app.vault.getAbstractFileByPath(dailyNotePath);
    } else {
        const dailyTemplate = tp.file.find_tfile("daily");
        if (!dailyTemplate) {
            new Notice(ui.templateNotFoundNotice);
            return null;
        }
        dailyNoteFile = await tp.file.create_new(dailyTemplate, `${dailyNoteCatalog}/${currentDate}`);
        new Notice(typeof ui.createdNotice === "function" ? ui.createdNotice(currentDate) : ui.createdNotice);
        await new Promise(r => setTimeout(r, 300));
    }

    const dailyNoteContent = await app.vault.read(dailyNoteFile);
    const headingToAdd = `### [[${currentNoteName}]]`;

    if (!dailyNoteContent.includes(headingToAdd)) {
        let prefix = "";
        const trimmedContent = dailyNoteContent.trim();
        if (trimmedContent.length > 0) {
            const isJustNavBar = trimmedContent.includes('←') && trimmedContent.includes('→') && trimmedContent.split('\n').length === 1;
            if (isJustNavBar) {
                prefix = dailyNoteContent.endsWith("\n") ? "" : "\n";
            } else {
                if (dailyNoteContent.endsWith("\n\n")) prefix = "";
                else if (dailyNoteContent.endsWith("\n")) prefix = "\n";
                else prefix = "\n\n";
            }
        }
        await app.vault.append(dailyNoteFile, `${prefix}${headingToAdd}\n`);
    }

    return dailyNoteFile;
}

module.exports = linkToDailyNote;