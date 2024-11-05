---
project: <%*
// Оборачиваем в блок обработки исключений
try {
    // Получаем путь до заметки Homepage
    const homepageFile = await app.vault.getAbstractFileByPath('Homepage.md');
    // Читаем содержимое заметки Homepage
    const content = await app.vault.cachedRead(homepageFile);
    // Определяем название секции с проектами
    const sectionTitle = 'Проекты'; 
    // Создаём динамическое регулярное выражение для извлечения нужной секции
    const sectionRegex = new RegExp(`### ${sectionTitle}:\n([\\s\\S]*?)(?=\\n###|$)`);
    // Извлекаем содержимое секции
    const sectionMatch = sectionRegex.exec(content);
    const sectionContent = sectionMatch?.[1] || '';
    // Ищем все ссылки на проекты в квадратных скобках
    const matchesIterator = sectionContent.matchAll(/- \[\[(.*?)\]\]/g);
    // Преобразуем итератор в массив названий проектов
    const projects = Array.from(matchesIterator, m => m[1]);
    // Получаем имя текущей заметки
    const currentNoteName = app.workspace.getActiveFile()?.basename;
    
    // Проверяем, есть ли создаваемый проект в общем списке проектов
    if (projects.includes(currentNoteName)) {
        new Notice(`Проект "${currentNoteName}" уже существует. Добавление отменено.`);
    } else {
        // Добавляем новый проект в список проектов
        const newSectionContent = sectionContent.trim() + `\n- [[${currentNoteName}]]\n`;
        // Обновляем содержимое списка проектов, добавляя новый проект
        const updatedContent = content.replace(sectionRegex, `### ${sectionTitle}:\n${newSectionContent}`);
        await app.vault.modify(homepageFile, updatedContent);
        new Notice(`Проект "${currentNoteName}" добавлен в секцию "${sectionTitle}".`);
    }
    tR += currentNoteName;
} catch (error) {
    console.error("Templater Error:", error);
}
%>
cssclasses:
  - wide-page
---

```dataviewjs
// Оборачиваем в блок обработки исключений
try {
  // Получаем имя заметки
  const filterProject = app.workspace.getActiveFile()?.basename.toLowerCase();
  const currentPath = dv.current().file.path;

  // Функция для преобразования строки в дату
  function parseDate(dateStr) {
    return moment(dateStr, 'DD-MM-YYYY').toDate();
  }

  // Функция для преобразования даты в строку
  function formatDate(date) {
    return moment(date).format('DD-MM-YYYY');
  }

  // Функция для получения иконки по статусу задачи
  function getStatusIcon(status) {
    const icons = {
      'backlog': '🗒️',
      'to do': '📋',
      'canceled': '🚫',
      'в работе': '⚙️',
      'тестирование': '🔍',
      'done': '☑️'
    };
    return icons[status.toLowerCase()] || '❓';
  }

  // Функция для получения даты из имени ежедневной заметки
  async function getEventDatesFromDailyNotes(taskName) {
    const dailyNotes = dv.pages('"periodic/daily"').values;
    const eventDates = [];

    for (const page of dailyNotes) {
      const file = app.vault.getAbstractFileByPath(page.file.path);

      if (file?.extension === 'md') {
        const fileContent = await app.vault.cachedRead(file);
        const taskHeaderPattern = new RegExp(`###\\s*[^\\n]*\\[\\[${taskName}(#[^\\]]+)?\\]\\]`, 'i');

        if (taskHeaderPattern.test(fileContent)) {
          const dateStr = page.file.name;
          const date = parseDate(dateStr);
          if (date) {
            eventDates.push(date);
          }
        }
      }
    }
    return eventDates;
  }

  // Проверяем наличие Kanban доски
  const kanbanFile = app.vault.getAbstractFileByPath("Рабочие задачи.md");
  if (!kanbanFile) {
    dv.paragraph("Kanban доска не найдена.");
    return;
  }

  // Получаем содержимое Kanban доски
  const kanbanContent = await app.vault.cachedRead(kanbanFile);
  const taskStatusMap = {};
  let currentStatus = null;

  // Разбираем содержимого Kanban доски по строкам
  kanbanContent.split('\n').forEach(line => {
    // Ищем заголовки статусов
    const headingMatch = line.match(/^##\s+(.*)/);
    if (headingMatch) {
      // Устанавливаем текущий статус
      currentStatus = headingMatch[1].trim();
    } else if (currentStatus) {
      // Ищем ссылки на задачи
      const linkMatch = line.match(/\[\[([^\]]+)\]\]/);
      // Сопоставляем задачу со статусом
      if (linkMatch) taskStatusMap[linkMatch[1].trim()] = currentStatus;
    }
  });

  // Фильтруем страницы по проекту
  const pages = dv.pages().filter(p => p.project && p.project.toLowerCase() === filterProject && p.file.path !== currentPath);
  let data = [];

  for (let page of pages) {
    // Получаем даты событий из ежедневных заметок
    let eventDates = await getEventDatesFromDailyNotes(page.file.name);
    // Если даты нет, используем дату страницы
    if (!eventDates.length && page.date) eventDates.push(parseDate(page.date));

    // Определяем начальную дату
    let startDate = eventDates.length ? new Date(Math.min(...eventDates)) : null;
    // Определяем конечную дату
    let endDate = eventDates.length ? new Date(Math.max(...eventDates)) : null;

    const taskName = page.file.name;
    // Получаем текущий статус задачи
    const status = taskStatusMap[taskName] || "Не указано";
    // Получаем иконку статуса
    const statusIcon = getStatusIcon(status);

    // Определяем формат времени выполнения
    let executionTime;
    if (startDate && endDate && startDate.getTime() !== endDate.getTime()) {
      // Если диапазон дат
      executionTime = `${formatDate(startDate)} — ${formatDate(endDate)}`;
    } else if (startDate) {
      // Если одна дата
      executionTime = formatDate(startDate);
    } else {
      // Если даты нет
      executionTime = "Нет даты";
    }

    // Заполняем массив данными для таблицы
    data.push({
      note: page.file.link,
      instance: page.instance || "Не указано",
      status: `${status} ${statusIcon}`,
      executionTime,
      startDate
    });
  }

  // Сортируем данные по дате начала задачи
  data.sort((a, b) => (a.startDate || Infinity) - (b.startDate || Infinity));

  if (data.length) {
    // Отображаем таблицу с данными
    dv.table(
      ["Заметка", "Инстанс", "Статус", "Время выполнения"],
      data.map(d => [d.note, d.instance, d.status, d.executionTime])
    );
  } else {
    // Выводим сообщение, если данных нет
    dv.paragraph("Нет данных для отображения.");
  }
} catch (error) {
  console.error("Templater Error:", error);
}
```
