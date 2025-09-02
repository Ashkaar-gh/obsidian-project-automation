<%*
// Объявляем переменные
let chosenOptionKey;
let chosenTemplate;
let noteName = tp.file.title;
let fileToOpenAtEnd = null;

// Определяем, был ли скрипт запущен из Inbox, чтобы управлять логикой редиректа.
const isInboxRun = !!window.INBOX_CONTEXT;

// Проверяем, существует ли глобальная переменная, установленная скриптом из Inbox.
if (isInboxRun) {
    const context = window.INBOX_CONTEXT;
    new Notice("Автоматическое создание задачи...");
    // Берем тип и имя из контекста.
    chosenOptionKey = context.noteType;
    chosenTemplate = context.noteType;
    noteName = context.noteName;
    // Очищаем глобальную переменную, чтобы она не повлияла на следующий запуск.
    delete window.INBOX_CONTEXT;
    // Переименовываем файл, если его текущее имя не совпадает с тем, что передано в контексте.
    if (tp.file.title !== noteName) {
        await tp.file.rename(noteName);
    }

// Если глобальной переменной нет.
} else {
    // Создаем объект 'options' для хранения соответствий между отображаемыми именами шаблонов и их реальными именами файлов (без расширения .md).
    const options = {
        "<Без шаблона>": null,
        "задача": "task",
        "проект": "project",
        "kanban": "kanban"
    };

    // Показываем пользователю список выбора с типами заметок.
    chosenOptionKey = await tp.system.suggester(Object.keys(options), Object.keys(options), false, "Выберите шаблон для заметки");
    
    // Проверяем, нажал ли пользователь Esc.
    if (!chosenOptionKey) {
        // Выводим уведомление пользователю о том, что операция отменена.
        new Notice("Создание заметки отменено.");
        // Перемещаем ненужный теперь файл в корзину (по умолчанию это корзина в ОС).
        await app.vault.trash(tp.config.target_file, true);
        return;
    }
    
    // Получаем имя шаблона из объекта 'options'.
    chosenTemplate = options[chosenOptionKey];

    // Проверяем, выбрал ли пользователь "<Без шаблона>".
    if (!chosenTemplate) {
        // Выводим уведомление о том, что создана пустая заметка.
        new Notice("Создана пустая заметка.");
        return;
    }

    // Определяем, является ли текущее имя файла стандартным именем Obsidian для новых заметок.
    const isDefaultName = /^Untitled( \d*)?$/.test(tp.file.title);
    // Если имя уже задано (например, из Inbox), предлагаем его в качестве значения по умолчанию.
    let promptValue = isDefaultName ? "" : tp.file.title;
    
    // Запускаем цикл для определения имени заметки.
    while (true) {
        // Запрашиваем у пользователя имя для нового файла.
        noteName = await tp.system.prompt(`Введите имя для заметки с типом "${chosenOptionKey}":`, promptValue);
        // Проверяем, нажал ли пользователь Esc.
        if (!noteName) {
            // Выводим уведомление пользователю о том, что операция отменена.
            new Notice("Создание заметки отменено.");
            // Перемещаем ненужный теперь файл в корзину (по умолчанию это корзина в ОС).
            await app.vault.trash(tp.config.target_file, true);
            return;
        }
        // Если имя не изменилось, проверку на существование файла можно пропустить (актуально для сценария из Inbox)
        if (noteName === tp.file.title) break;

        // Определяем, какой будет путь у файла. Если это kanban-доска, путь будет 'kanban/имя.md', иначе просто 'имя.md'.
        const filePath = (chosenTemplate === "kanban") ? `kanban/${noteName}.md` : `${noteName}.md`;
        // Проверяем, существует ли уже файл по указанному пути.
        if (await tp.file.exists(filePath)) {
            // Если файл существует, выводим уведомление. Цикл продолжится, и пользователю снова будет предложено ввести имя.
            new Notice("Заметка с таким именем уже существует.");
            promptValue = noteName; 
        } else {
            // Если файла не существует, прерываем цикл.
            break;
        }
    }
    // Переименовываем файл только в том случае, если новое имя отличается от старого
    if (noteName !== tp.file.title) {
        await tp.file.rename(noteName);
    }
}

// Если выбранный шаблон - "kanban", то перемещаем только что переименованный файл в папку 'kanban/'.
if (chosenTemplate === "kanban") {
    await tp.file.move(`kanban/${noteName}`);
}

// Находим файл шаблона (например, "task.md") по его имени ('chosenTemplate').
const templateFile = tp.file.find_tfile(chosenTemplate);
// Считываем содержимое найденного файла шаблона в переменную 'templateContent'.
let templateContent = await app.vault.read(templateFile);

// Если был выбран шаблон "задача".
if (chosenTemplate === "task") {
    // Вызываем функцию для выбора одного или нескольких проектов из секции "Проекты" в файле "Homepage.md".
    const selectedProjects = await tp.user.selectItemsFromSection(tp, "Homepage.md", "Проекты", 'Выберите проект(ы)');
    // Запрашиваем у пользователя ввод значения для 'instance' (не обязательное поле).
    const instanceValue = await tp.system.prompt("Введите значение для instance:");
    // Вызываем функцию для выбора одной или нескольких Kanban-досок из секции "Kanban" в файле "Homepage.md".
    const selectedBoards = await tp.user.selectItemsFromSection(tp, "Homepage.md", "Kanban", 'Выберите Kanban-доску(и)');
    // Получаем текущую дату в формате "ГГГГ-ММ-ДД".
    const currentDate = tp.date.now("YYYY-MM-DD");

    // Формируем строку для проектов. Если проекты выбраны, создаем многострочную строку с отступами, иначе - пустую строку.
    const projectString = selectedProjects.length > 0 ? '\n' + selectedProjects.map(p => `  - ${p}`).join('\n') : '';
    // Формируем строку для Kanban-досок по аналогии с проектами.
    const kanbanString = selectedBoards.length > 0 ? '\n' + selectedBoards.map(b => `  - ${b}`).join('\n') : '';

    // Заменяем плейсхолдер '%%project%%' шаблона на сформированную строку проектов.
    templateContent = templateContent.replace("%%project%%", projectString);
    // Заменяем '%%instance%%' на введенное пользователем значение (или на пустую строку, если ничего не введено).
    templateContent = templateContent.replace("%%instance%%", instanceValue || '');
    // Заменяем '%%kanban%%' на сформированную строку Kanban-досок.
    templateContent = templateContent.replace("%%kanban%%", kanbanString);
    // Заменяем '%%date%%' на текущую дату.
    templateContent = templateContent.replace("%%date%%", currentDate);

    // Запускаем цикл по всем выбранным Kanban-доскам.
    for (const boardName of selectedBoards) {
        // Для каждой доски вызываем пользовательскую функцию, которая добавляет ссылку на текущую задачу ('noteName') в эту доску.
        await tp.user.addTaskToBoard(boardName, noteName);
    }
    // Вызываем функцию для создания/обновления ежедневной заметки и сохраняем ее объект.
    const dailyNoteFile = await tp.user.linkToDailyNote(tp, app, noteName);
    
    // Сохраняем ежедневную заметку для открытия в конце.
    fileToOpenAtEnd = dailyNoteFile;

// Если был выбран шаблон "проект",
} else if (chosenTemplate === "project") {
    // Заменяем плейсхолдер '%%projectName%%' шаблона на имя заметки.
    templateContent = templateContent.replace("%%projectName%%", noteName);
}

// Присваиваем обработанное содержимое шаблона переменной 'finalContent'.
const finalContent = templateContent;
// Добавляем содержимое 'finalContent' в текущую заметку.
tR += finalContent;

// Если был создан "проект",
if (chosenTemplate === "project") {
    // Вызываем функцию, чтобы добавить ссылку на новый проект в секцию "Проекты" файла "Homepage.md".
    await tp.user.appendItemToSection('Homepage.md', 'Проекты', noteName);
// Иначе, если была создана "kanban"-доска,
} else if (chosenTemplate === "kanban") {
    // Вызываем пользовательскую функцию, чтобы добавить ссылку на новую доску в секцию "Kanban" файла "Homepage.md".
    await tp.user.appendItemToSection('Homepage.md', 'Kanban', noteName);
}

// Выводим финальное уведомление об успешном создании заметки.
new Notice(`"${noteName}" успешно создан!`);

// Если в процессе работы была сохранена заметка для открытия (только при ручном создании).
if (fileToOpenAtEnd) {
    // Даем Obsidian мгновение, чтобы завершить все фоновые процессы.
    await sleep(100);
    // Используем надежный метод для открытия файла и переключения фокуса.
    await app.workspace.openLinkText(fileToOpenAtEnd.path, tp.file.path(true), true);
}
%>