<%*
/**
 * Навигация по ежедневным заметкам: ссылки на предыдущий и следующий день по имени текущего файла (DD-MM-YYYY).
 */
const previousDay = tp.date.now("DD-MM-YYYY", -1, tp.file.title, "DD-MM-YYYY");
const nextDay = tp.date.now("DD-MM-YYYY", 1, tp.file.title, "DD-MM-YYYY");
const baseFolder = tp.file.folder(true);
const previousNotePath = `${baseFolder}/${previousDay}.md`;
const nextNotePath = `${baseFolder}/${nextDay}.md`;
tR += `← [[${previousNotePath}|${previousDay}]]  |  [[${nextNotePath}|${nextDay}]] →`;
%>