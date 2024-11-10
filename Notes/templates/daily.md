<%*
// Вычисляем предыдущий и следующий день
const previousDay = tp.date.now("DD-MM-YYYY", -1, tp.file.title, "DD-MM-YYYY");
const nextDay = tp.date.now("DD-MM-YYYY", 1, tp.file.title, "DD-MM-YYYY");

// Формируем ссылки
const baseFolder = tp.file.folder(true);
const previousNotePath = `${baseFolder}/${previousDay}.md`;
const nextNotePath = `${baseFolder}/${nextDay}.md`;

// Выводим даты в виде ссылок
tR += `← [[${previousNotePath}|${previousDay}]]  |  [[${nextNotePath}|${nextDay}]] →`;
%>