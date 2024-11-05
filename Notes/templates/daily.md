<%*
// Оборачиваем в блок обработки исключений
try {
    // Получаем имя текущей ежедневной заметки
    const noteName = tp.file.title;
    
    // Разбиваем полученное имя на компоненты даты
    const [day, month, year] = noteName.split('-').map(Number);

    // Создаём объект Date на основе поученных компонентов
    const currentNoteDate = new Date(year, month - 1, day);

    // Вычисляем предыдущий и следующий день
    let previousDayDate = new Date(currentNoteDate.setDate(currentNoteDate.getDate() - 1));
    let nextDayDate = new Date(currentNoteDate.setDate(currentNoteDate.getDate() + 2));

    // Форматируем дату обратно в "DD-MM-YYYY"
    const formatDate = (date) => {
        const dd = String(date.getDate()).padStart(2, '0');
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const yyyy = date.getFullYear();
        return `${dd}-${mm}-${yyyy}`;
    };

    const previousDay = formatDate(previousDayDate);
    const nextDay = formatDate(nextDayDate);

    // Формируем ссылки
    const baseFolder = tp.file.folder(true);
    const previousNotePath = `${baseFolder}/${previousDay}.md`;
    const nextNotePath = `${baseFolder}/${nextDay}.md`;

    // Выводим даты в виде ссылок
    tR += `← [[${previousNotePath}|${previousDay}]]  |  [[${nextNotePath}|${nextDay}]] →`;
} catch (error) {
    console.error("Templater Error:", error);
}
%>