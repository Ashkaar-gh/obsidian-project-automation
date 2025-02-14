---
cssclasses:
  - wide-page
---
#### In progress
```tasks
path does not include kanban
path does not include templates
status.name includes unknown
no due date
no scheduled date
is not blocked
```
##### Blocked
```tasks
path does not include kanban
path does not include templates
status.name includes unknown
no due date
no scheduled date
is blocked
```

#### To do
```tasks
status.type is in_progress
path does not include kanban
path does not include templates
no due date
no scheduled date
```

#### Waiting
```tasks
status.type is NON_TASK
path does not include kanban
path does not include templates
no due date
no scheduled date
```

#### Inbox
```dataviewjs
// Глобальная переменная для хранения ссылки на текущее открытое меню
let openMenu = null;

// Переменная для отслеживания активного поля ввода
let activeInput = null;

// Функция для создания кнопки
function createButton(text) {
    // Создаем элемент кнопки
    const button = document.createElement('button');
    // Устанавливаем текст кнопки
    button.textContent = text;
    // Добавляем стили
    button.classList.add('dropdown-button'); 
    return button;
}

// Функция для закрытия текущего открытого меню
function closeDropdownMenu() {
    if (openMenu) {
        // Удаляем меню из DOM
        openMenu.remove();
        // Сбрасываем переменную
        openMenu = null;
    }
}

// Функция для добавления статуса в строку
function createStatusMenu(menu, originalText, allLines, inboxFile) {
    // Определяем массив возможных статусов
    const statuses = [
        { status: 'In progress', symbol: '/' },
        { status: 'To do', symbol: '<' },
        { status: 'Waiting', symbol: '>' }
    ];

    // Проходимся по каждому статусу в массиве
    statuses.forEach(({ status, symbol }) => {
        // Создаем элемент div для каждого элемента меню
        const menuItem = document.createElement('div');
        // Устанавливаем имена для элементов меню соответствующие статусу
        menuItem.textContent = status;
        // Добавляем стили
        menuItem.classList.add('menu-item');

        // Добавляем обработчик события нажатия на элемент в меню
        menuItem.addEventListener('click', async () => {
            // Находим индекс оригинального текста в массиве строк, взятого из inbox
            const index = allLines.indexOf(originalText);
            // Если индекс не найден, выходим из функции
            if (index === -1) return;
            // Сохраняем текущее содержание строки
            const currentContent = allLines[index];
            // Добавляем к строке статус
            allLines[index] = `- [${symbol}] ${originalText}`;
            // Собираем все строки, разделяем переносами
            const updatedContent = allLines.join('\n');
            // Обновление содержимого файла и уведомляем пользователя
            await updateContentAndNotify(inboxFile, updatedContent, currentContent, `Статус "${originalText}" поменялся на "${status}"`);
            // Закрываем меню
            closeDropdownMenu();
        });

        // Добавляем элемент в контейнер меню
        menu.appendChild(menuItem);
    });
}

// Функция создания выпадающего меню для кнопки
function createDropdownMenu(button, menuClass, lineContainer, createMenuContent) {
    button.addEventListener('click', (event) => {
        // Предотвращаем всплытие события клика
        event.stopPropagation();
        // Закрываем любое другое открытое меню
        closeDropdownMenu();

        // Создаем контейнер для меню
        const menuContainer = document.createElement('div');
        // Применяем стиль для меню
        menuContainer.classList.add(menuClass);
        // Заполняем меню содержимым
        createMenuContent(menuContainer);

        // Добавляем меню в тело документа
        document.body.appendChild(menuContainer);
        // Сохраняем ссылку на открытое меню
        openMenu = menuContainer;

        // Получаем положение кнопки
        const rect = button.getBoundingClientRect();
        // Устанавливаем позицию меню относительно кнопки
        menuContainer.style.left = `${rect.left}px`; 
        menuContainer.style.top = `${rect.bottom}px`; 

        // Обработчик события ухода курсора с меню
        menuContainer.addEventListener('mouseleave', () => {
            // Закрываем меню, если курсор не на элементе
            if (!lineContainer.matches(':hover') && !menuContainer.matches(':hover')) {
                closeDropdownMenu();
            }
        });
    });
}

// Асинхронная функция для обновления содержимого файла и отображения уведомлений
async function updateContentAndNotify(file, newContent, currentContent, message) {
    // Проверяем, изменилось ли содержимое
    if (newContent !== currentContent) {
        // Обновляем файл
        await app.vault.modify(file, newContent);
        // Показываем уведомление, если необходимо
        if (message) {
            new Notice(message);
        }
    }
}

// Функция для создания формы добавления новых записей в список
function createAddItemForm(parentElement) {
    // Создаем контейнер для формы
    const formContainer = document.createElement('div');
    // Создаем поле ввода для новых записей
    const inputField = document.createElement('input');
    // Устанавливаем тип ввода как текст
    inputField.type = 'text';
    // Подсказка для ввода текста
    inputField.placeholder = 'Новая запись';
    // Добавляем CSS-класс к полю ввода
    inputField.classList.add('input-field');

    // Создаем кнопку Добавить
    const addButton = createButton('Добавить');
    // Добавляем CSS-класс к кнопке
    addButton.classList.add('add-button');
    // Устанавливаем обработчик клика для кнопки
    addButton.addEventListener('click', async () => {
        // Получаем и обрезаем значение из поля ввода
        const newItem = inputField.value.trim();
        // Проверяем, что введено непустое значение
        if (newItem) {
            // Очищаем поле ввода
            inputField.value = '';
            // Добавляем новую запись в Inbox
            await addNewItemToInbox(newItem);
        }
    });

    // Устанавливаем обработчик нажатия клавиши в поле ввода
    inputField.addEventListener('keydown', async (event) => {
        // Проверяем, была ли нажата клавиша Enter
        if (event.key === 'Enter') {
            // Получаем и обрезаем значение из поля ввода
            const newItem = inputField.value.trim();
            // Проверяем, что введено непустое значение
            if (newItem) {
                // Очищаем поле ввода
                inputField.value = '';
                // Добавляем новую запись в Inbox
                await addNewItemToInbox(newItem);
            }
        }
    });

    // Добавляем поле ввода в контейнер формы
    formContainer.appendChild(inputField);
    // Добавляем кнопку "Добавить" в контейнер формы
    formContainer.appendChild(addButton);
    // Размещаем форму в начале родительского элемента
    parentElement.prepend(formContainer);
}

// Функция для добавления новой записи в файл Inbox
async function addNewItemToInbox(newItem) {
    // Определяем путь к файлу Inbox
    const inboxFilePath = 'Inbox.md';
    // Получаем абстрактный файл по заданному пути
    const inboxFile = app.vault.getAbstractFileByPath(inboxFilePath);

    // Если файла Inbox не найдено
    if (!inboxFile) {
        // Показываем уведомление об ошибке
        new Notice(`Файл "${inboxFilePath}" не найден.`);
        // Прекращаем выполнение функции
        return;
    }

    // Читаем текущее содержимое файла Inbox
    const content = await app.vault.cachedRead(inboxFile);

    // Формируем обновленное содержимое с новой записью
    const updatedContent = `${content}\n${newItem}`.trim();
    // Обновляем файл Inbox новым содержимым
    await app.vault.modify(inboxFile, updatedContent);

    // Показываем уведомление о добавлении новой записи
    new Notice(`Добавлено: "${newItem}"`);
    // Добавляем новую строку в пользовательский интерфейс
    addNewLineToUI(newItem, inboxFile, templateContent);
}

// Функция для добавления новой строки в UI
function addNewLineToUI(line, inboxFile, templateContent) {
    // Получаем контейнер для отображения записей
    const container = document.querySelector('div[data-view="dv"]');

    // Проверяем, что контейнер существует
    if (container) {
        // Создаем контейнер для новой строки
        const lineContainer = document.createElement('div');
        // Добавляем CSS-класс для оформления контейнера строки
        lineContainer.className = 'line-divider';

        // Создаем элемент для отображения текста строки
        const textElement = document.createElement('span');
        // Устанавливаем текстовое содержание элемента
        textElement.textContent = line;

        // Устанавливаем обработчик клика для редактирования строки
        textElement.addEventListener('click', async () => {
            // Создаем элемент для ввода текста
            const inputField = document.createElement('input');
            // Устанавливаем тип ввода как текст
            inputField.type = 'text';
            // Устанавливаем текущее значение в поле ввода
            inputField.value = line;

            // Проверяем, что контейнер строки содержит текстовый элемент
            if (lineContainer.contains(textElement)) {
                // Заменяем текстовый элемент на поле ввода
                lineContainer.replaceChild(inputField, textElement);
                // Устанавливаем фокус на поле ввода
                inputField.focus();
                // Устанавливаем контейнер строки как активный элемент
                activeInput = lineContainer;
                // Включаем редактирование для строки
                enableEditing(lineContainer, inputField, textElement, line, allLines, inboxFile, templateContent);
            }
        });

        // Создаем контейнер для кнопок, привязанных к строке
        const buttonContainer = createButtons(lineContainer, line, allLines, inboxFile, container, templateContent, textElement);

        // Добавляем текстовый элемент в контейнер строки
        lineContainer.appendChild(textElement);
        // Добавляем контейнер с кнопками в контейнер строки
        lineContainer.appendChild(buttonContainer);
        // Добавляем контейнер строки в общий контейнер
        container.appendChild(lineContainer);
    }
}

// Функция редактирования строк
function enableEditing(lineContainer, inputField, textElement, originalText, allLines, inboxFile, content) {
    // Флаг для предотвращения повторного сохранения изменений
    let changesSaved = false;

    // Функция для установки ширины поля ввода на основе длины текста
    const setInputWidth = () => {
        // Рассчет примерной ширины строки (8px на каждый символ)
        const approxWidth = originalText.length * 8;
        // Установка ширины поля ввода, минимальная ширина — 100px
        inputField.style.width = `${Math.max(100, approxWidth)}px`;
    };

    setInputWidth();

    // Функция для сохранения изменений
    const saveChanges = async () => {
        // Если изменения уже сохранены, выходим из функции
        if (changesSaved) return;
        changesSaved = true;

        // Получаем и обрезаем новое значение из поля ввода
        const newText = inputField.value.trim();
        // Если новый текст отличается от оригинала и не пустой
        if (newText !== originalText && newText !== '') {
            // Находим индекс оригинального текста в массиве строк
            const globalIndex = allLines.indexOf(originalText);
            // Обновляем строку в массиве новым текстом
            allLines[globalIndex] = newText;
            // Составляем обновленное содержимое для файла
            const updatedContent = allLines.join('\n');
            // Обновляем файл и показываем уведомление
            await updateContentAndNotify(inboxFile, updatedContent, content, `Изменено: "${newText}"`);
            // Обновляем текстовый элемент на отображаемой странице
            textElement.textContent = newText;
        }

        // Если поле ввода все еще содержится в контейнере строки
        if (lineContainer.contains(inputField)) {
            // Заменяем поле ввода обратно на текстовый элемент
            lineContainer.replaceChild(textElement, inputField);
        }
        // Сбрасываем активный элемент ввода
        activeInput = null;
    };

    // Добавляем обработчик события для нажатия клавиши в поле ввода
    inputField.addEventListener('keydown', async (event) => {
        // Если нажата клавиша Enter
        if (event.key === 'Enter') {
            // Сохраняем изменения
            await saveChanges();
            // Убираем фокус из поля ввода
            inputField.blur();
        }
    });

    // Обновляем ширину поля ввода при изменении текста
    inputField.addEventListener('input', setInputWidth);
    // Обработчик при потери фокуса поля ввода, сохраняет изменения
    inputField.addEventListener('blur', saveChanges);

    // Обработчик клика по документу, чтобы завершить редактирование
    const handleDocumentClick = async (event) => {
        // Проверяет, не кликнул ли пользователь за пределами активного поля ввода
        if (activeInput && !activeInput.contains(event.target)) {
            // Сохраняем изменения и удаляем обработчик события
            await saveChanges();
            document.removeEventListener('click', handleDocumentClick, true);
        }
    };

    // Добавляем обработчик событий кликов по документу
    document.addEventListener('click', handleDocumentClick, true);
}

// Функция для создания кнопок
// Функция для создания кнопок
function createButtons(lineContainer, originalText, allLines, inboxFile, container, templateContent, textElement) {
    // Создаем контейнер для кнопок
    const buttonContainer = document.createElement('div');
    // Устанавливаем класс оформления для контейнера кнопок
    buttonContainer.className = 'button-container';

    // Массив объектов, каждый из которых представляет кнопку с её свойствами
    const buttons = [
        {
            // Название кнопки
            name: 'Статус',
            // Класс меню для стилизации
            menuClass: 'status-menu',
            // Функция для создания содержимого меню статусов
            createMenuContent: (menu) => 
                createStatusMenu(menu, originalText, allLines, inboxFile)
        },
        {
            // Название кнопки
            name: 'Календарь',
            // Класс меню для стилизации
            menuClass: 'calendar-menu',
            // Функция для создания содержимого меню календаря
            createMenuContent: (menu) => {
                // Создаем поле ввода для выбора даты и времени
                const datetimeInput = document.createElement('input');
                // Устанавливаем тип поля ввода как дата и время
                datetimeInput.type = 'datetime-local';
                // Добавляем обработчик события изменения значения поля ввода
                datetimeInput.addEventListener('change', async (e) => {
                    // Получаем выбранное значение даты и времени
                    const selectedDateTime = e.target.value;
                    // Проверяем, что значение выбрано
                    if (selectedDateTime) {
                        // Находим текущее содержание строки по оригинальному тексту
                        const currentContent = allLines[allLines.indexOf(originalText)];
                        // Создаем новую строку с добавленным временем
                        const newLine = `- [ ] ${originalText} (@${selectedDateTime})`; 
                        // Обновляем строку в массиве allLines
                        allLines[allLines.indexOf(originalText)] = newLine;
                        // Объединяем все строки в обновленное содержимое
                        const updatedContent = allLines.join('\n');
                        // Обновляем содержимое файла и показываем уведомление
                        await updateContentAndNotify(inboxFile, updatedContent, currentContent, `Добавлено время: "${selectedDateTime}"`);
                        // Обновляем текстовый элемент в UI новой строкой
                        textElement.textContent = newLine;
                        // Обновляем оригинальный текст на новый
                        originalText = newLine;

                        // Проверяем, содержится ли меню в документе
                        if (document.body.contains(menu)) {
                            // Удаляем меню из документа
                            document.body.removeChild(menu);
                        }
                    }
                });

                // Добавляем поле ввода в меню
                menu.appendChild(datetimeInput);
                // Фокусируемся на поле ввода для непосредственного ввода даты и времени
                datetimeInput.focus();
            }
        },
        {
            // Название кнопки
            name: 'Задача',
            // Класс меню для стилизации
            menuClass: 'task-menu',
            // Асинхронная функция для создания новой задачи
            createMenuContent: async () => {
                // Очищаем оригинальный текст от недопустимых символов для имен файлов
                const sanitizedFileName = originalText.replace(/[\\\/:*?"<>|]/g, ''); 
                // Формируем новое имя файла с расширением .md
                const newFileName = `${sanitizedFileName}.md`;
                // Устанавливаем содержимое нового файла из шаблона
                const newFileContent = templateContent;
        
                // Читаем текущее содержимое файла Inbox
                const content = await app.vault.cachedRead(inboxFile);
                
                // Создаем новый файл с заданным именем и содержимым
                await app.vault.create(newFileName, newFileContent);
                // Показываем уведомление о создании новой задачи
                new Notice(`Создана новая задача: "${sanitizedFileName}"`);
                
                // Получаем лист (вкладку) для открытия нового файла
                const leaf = app.workspace.getLeaf(true);
                // Открываем созданный файл в новой вкладке
                await leaf.openFile(await app.vault.getAbstractFileByPath(newFileName));
        
                // Удаляем контейнер текущей строки из общего контейнера
                container.removeChild(lineContainer);
                // Находим индекс оригинальной строки в массиве allLines
                const globalIndex = allLines.indexOf(originalText);
                if (globalIndex !== -1) {
                    // Удаляем строку из массива
                    allLines.splice(globalIndex, 1);
                    // Объединяем оставшиеся строки в обновленное содержимое
                    const updatedContent = allLines.join('\n');
                    // Обновляем содержимое файла Inbox
                    await updateContentAndNotify(inboxFile, updatedContent, content, '');
                }
            }
        },
        {
            // Название кнопки
            name: 'Удалить',
            // Функция действия при нажатии на кнопку "Удалить"
            action: async () => {
                // Определяем путь к файлу корзины
                const trashFilePath = 'Trash.md';
                // Пытаемся получить файл корзины по пути
                let trashFile = app.vault.getAbstractFileByPath(trashFilePath);
            
                // Если файл корзины не существует, показываем уведомление и прерываем выполнение
                if (!trashFile) { 
                    new Notice('Ошибка: файл Trash.md не найден.');
                    return; // Выход из функции
                }
            
                // Читаем текущее содержимое файла корзины
                const trashContent = await app.vault.cachedRead(trashFile);
                // Обновляем содержимое файла корзины, добавляя удаленную строку
                const updatedTrashContent = `${trashContent}\n${originalText}`.trim();
                // Обновляем файл корзины
                await updateContentAndNotify(trashFile, updatedTrashContent, trashContent, '');
            
                // Удаляем контейнер строки из общего контейнера UI
                container.removeChild(lineContainer);
                // Находим индекс оригинальной строки в массиве allLines
                const globalIndex = allLines.indexOf(originalText);
                // Удаляем строку из массива allLines
                allLines.splice(globalIndex, 1);
                // Объединяем оставшиеся строки в обновленное содержимое
                const updatedContent = allLines.join('\n');
            
                // Читаем текущее содержимое файла Inbox, инициализируем переменную content
                const content = await app.vault.cachedRead(inboxFile);
                // Обновляем содержимое файла Inbox
                await updateContentAndNotify(inboxFile, updatedContent, content, '');
            
                // Показываем уведомление о успешном удалении
                new Notice(`Удалено: "${originalText}"`);
            }
        }
    ];

    // Проходимся по каждому объекту кнопки в массиве buttons
    buttons.forEach(({ name, menuClass, createMenuContent, action }) => {
        // Создаем кнопку с заданным именем
        const button = createButton(name);
    
        // Если определено действие для кнопки
        if (action) {
            // Добавляем обработчик события клика, выполняющий действие
            button.addEventListener('click', action);
        } else {
            // Иначе, создаем выпадающее меню для кнопки
            createDropdownMenu(button, menuClass, lineContainer, createMenuContent);
        }
        
        // Добавляем кнопку в контейнер кнопок
        buttonContainer.appendChild(button);
    });

    // Возвращаем готовый контейнер с кнопками
    return buttonContainer;
}

// Асинхронная функция для загрузки и отображения содержимого файла Inbox
async function loadAndDisplayInboxContent() {
    // Пути к файлам Inbox и шаблону задачи
    const inboxFilePath = 'Inbox.md';
    const taskTemplatePath = 'templates/task.md';

    // Одновременное получение абстрактных ссылок на файл Inbox и файл шаблона
    const [inboxFile, templateFile] = await Promise.all([
        app.vault.getAbstractFileByPath(inboxFilePath),
        app.vault.getAbstractFileByPath(taskTemplatePath),
    ]);

    // Проверка существования обоих файлов
    if (!inboxFile || !templateFile) {
        new Notice(`Файл "${!inboxFile ? inboxFilePath : taskTemplatePath}" не найден.`);
        // Завершаем выполнение, если хотя бы один из файлов не найден
        return; 
    }

    // Чтение содержимого обоих файлов одновременно
    const [templateContent, content] = await Promise.all([
        // Читаем шаблон задачи
        app.vault.cachedRead(templateFile),
        // Читаем содержимое файла Inbox
        app.vault.cachedRead(inboxFile),
    ]);

    // Создаем контейнер для элементов интерфейса
    const container = document.createElement('div');
    // Очищаем содержимое контейнера
    container.innerHTML = '';

    // Создание формы для добавления новых записей в Inbox
    createAddItemForm(container);

    // Разделяем содержимое файла Inbox на массив строк и убираем лишние пробелы
    const allLines = content.split('\n').map(line => line.trim());

    // Фильтрация видимых строк — убираем пустые строки и строки, начинающиеся с '- ['
    const visibleLines = allLines.filter(line => line.length > 0 && !line.startsWith('- ['));

    // Проверяем, есть ли видимые строки
    if (visibleLines.length === 0) {
        // Если нет, мы добавляем сообщение "Inbox пустой"
        const emptyMessage = document.createElement('div');
        emptyMessage.textContent = 'Пусто';
        emptyMessage.style.fontStyle = 'italic';
        container.appendChild(emptyMessage);
    } else {
        // Для каждой видимой строки создаем её представление в UI
        visibleLines.forEach((line) => {
            // Создаем контейнер для одной строки
            const lineContainer = document.createElement('div');
            // Устанавливаем класс для стилей
            lineContainer.className = 'line-divider';

            // Сохраняем оригинальный текст строки
            let originalText = line;

            // Создаем текстовый элемент для отображения строки
            const textElement = document.createElement('span');
            textElement.textContent = originalText;

            // Устанавливаем обработчик клика для редактирования строки
            textElement.addEventListener('click', async () => {
                const inputField = document.createElement('input');
                inputField.type = 'text';
                inputField.value = originalText;

                if (lineContainer.contains(textElement)) {
                    // Замена текстового элемента на поле ввода
                    lineContainer.replaceChild(inputField, textElement);
                    // Фокусируемся на поле ввода
                    inputField.focus();
                    // Обозначаем активный элемент
                    activeInput = lineContainer;

                    // Инициализация режима редактирования для строки
                    enableEditing(lineContainer, inputField, textElement, originalText, allLines, inboxFile, content);
                }
            });

            // Создание контейнера для кнопок
            const buttonContainer = createButtons(lineContainer, originalText, allLines, inboxFile, container, templateContent);

            // Добавляем текстовый элемент и кнопки в контейнер строки
            lineContainer.appendChild(textElement);
            lineContainer.appendChild(buttonContainer);
            // Добавляем строку в общий контейнер
            container.appendChild(lineContainer);

            // Отображение кнопок при наведении мыши
            lineContainer.addEventListener('mouseenter', () => {
                buttonContainer.style.visibility = 'visible';
            });

            // Скрытие кнопок, если меню не активно и курсор мыши уходит
            lineContainer.addEventListener('mouseleave', () => {
                if (!openMenu || !openMenu.matches(':hover')) {
                    buttonContainer.style.visibility = 'hidden';
                }
            });
        });
    }

    // Вставляем конечный контейнер в интерфейс через DataView
    dv.el('div', container);
}

// Обработчик клика для закрытия выпадающего меню при клике вне его
document.addEventListener('click', (event) => {
    if (openMenu && !openMenu.contains(event.target)) {
        closeDropdownMenu();
    }
});

// Запуск инициализации при загрузке
loadAndDisplayInboxContent(); 
```

#### Trash
```dataviewjs
// Асинхронная функция для отображения содержимого корзины
async function displayTrashContent() {
    // Определяем путь к файлу Trash.md
    const trashFilePath = 'Trash.md';
    // Получаем объект файла по указанному пути
    const trashFile = app.vault.getAbstractFileByPath(trashFilePath);

    // Проверяем, существует ли файл
    if (!trashFile) {
        // Если файл не найден, выводим уведомление
        new Notice(`Файл "${trashFilePath}" не найден.`);
        return;
    }

    // Асинхронно читаем содержимое файла из кэша
    const content = await app.vault.cachedRead(trashFile);
    // Разделяем содержимое на строки и фильтруем пустые строки
    const lines = content.split('\n').filter(line => line.trim().length > 0);

    // Создаем контейнер для отображения строк
    const container = dv.el('div');
    // Очищаем содержимое контейнера
    container.innerHTML = '';

    // Проверяем, есть ли строки для отображения
    if (lines.length === 0) {
        // Если файл пустой, создаем элемент с сообщением "Пусто"
        const emptyMessage = document.createElement('div');
        emptyMessage.textContent = 'Пусто';
        // Добавляем отступ и курсивный стиль к сообщению
        emptyMessage.style.padding = '5px';
        emptyMessage.style.fontStyle = 'italic';
        // Добавляем сообщение в контейнер
        container.appendChild(emptyMessage);
    } else {
        // Если есть строки, перебираем каждую строку
        lines.forEach((line) => {
            // Создаем новый элемент для строки
            const lineElement = document.createElement('div');
            // Устанавливаем текстовое содержимое элемента, убирая пробелы по краям
            lineElement.textContent = line.trim();
            // Добавляем отступ для визуального оформления
            lineElement.style.padding = '5px';
            // Добавляем нижний разделитель
            lineElement.style.borderBottom = '1px solid #444';

            // Добавляем элемент строки в контейнер
            container.appendChild(lineElement);
        });
    }

    // Отображаем контейнер с содержимым
    dv.el('div', container);
}

// Вызываем функцию для отображения содержимого Trash
displayTrashContent();
```

#### Done this month
```tasks
done this month
```
