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

/**
 * Вспомогательная функция для создания DOM-элементов с указанными атрибутами и дочерними элементами.
 * @param {string} tag - Тег создаваемого элемента (например, 'div', 'span', 'button').
 * @param {object} options - Объект с настройками для элемента.
 * @param {string} [options.className] - Класс или классы для элемента.
 * @param {object} [options.attributes] - Объект с атрибутами и их значениями.
 * @param {Array} [options.children] - Массив дочерних элементов или текстовых узлов.
 * @returns {HTMLElement} - Созданный DOM-элемент.
 */
const createElement = (tag, { className, attributes = {}, children = [] } = {}) => {
    // Создаём элемент с указанным тегом
    const element = document.createElement(tag);

    // Присваиваем классы, если они указаны
    if (className) element.className = className;
    
    // Устанавливаем каждый атрибут
    for (const [attr, value] of Object.entries(attributes)) {
        element.setAttribute(attr, value);
    }

    // Добавляем дочерние элементы
    children.forEach(child => element.appendChild(child));

    // Возвращаем созданный элемент
    return element;
};

/**
 * Функция для создания кнопки с текстом и списком классов.
 * @param {string} text - Текст, отображаемый на кнопке.
 * @param {Array} [classList=['dropdown-button']] - Список классов для кнопки.
 * @returns {HTMLElement} - Созданная кнопка.
 */
const createButton = (text, classList = ['dropdown-button']) => {
    // Создаём кнопку с указанным текстом и классами
    return createElement('button', {
        className: classList.join(' '), // Объединяем классы в одну строку
        children: [document.createTextNode(text)] // Добавляем текстовый узел внутри кнопки
    });
};

/**
 * Функция для закрытия текущего открытого выпадающего меню.
 */
const closeDropdownMenu = () => {
    // Проверяем, есть ли открытое меню
    if (openMenu) {
        // Удаляем его из DOM
        openMenu.remove();
        // Сбрасываем ссылку на него
        openMenu = null;
    }
};

/**
 * Функция для обновления содержимого файла и уведомления пользователя, если содержимое изменилось.
 * @param {TFile} file - Файл, который нужно обновить.
 * @param {string} newContent - Новое содержимое файла.
 * @param {string} currentContent - Текущее содержимое файла.
 * @param {string} message - Сообщение для уведомления пользователя.
 */
const updateContentAndNotify = async (file, newContent, currentContent, message) => {
    // Проверяем, изменилось ли содержимое
    if (newContent !== currentContent) {
        // Модифицируем файл новым содержимым
        await app.vault.modify(file, newContent);
        // Показываем уведомление, если сообщение задано
        if (message) new Notice(message);
    }
};

/**
 * Функция для создания формы добавления новой записи в Inbox.
 * @param {HTMLElement} parentElement - Родительский элемент, в который будет добавлена форма.
 */
const createAddItemForm = (parentElement) => {
    // Создаём контейнер для формы
    const formContainer = createElement('div');

    // Создаём поле ввода с типом "text" и плейсхолдером
    const inputField = createElement('input', {
        attributes: { type: 'text', placeholder: 'Новая запись' },
        className: 'input-field'
    });

    // Создаём кнопку "Добавить" с классом
    const addButton = createButton('Добавить', ['add-button']);

    /**
     * Обработчик для добавления новой записи в Inbox.
     */
    const addItem = async () => {
        // Получаем и обрезаем значение из поля ввода
        const newItem = inputField.value.trim();
        // Если введено какое-либо значение
        if (newItem) {
            // Очищаем поле ввода
            inputField.value = '';
            // Вызываем функцию для добавления новой записи
            await addNewItemToInbox(newItem);
        }
    };

    // Назначаем обработчик клика на кнопку
    addButton.addEventListener('click', addItem);

    // Назначаем обработчик нажатия клавиш на поле ввода
    inputField.addEventListener('keydown', (event) => {
        // Если нажата клавиша Enter, вызываем addItem
        if (event.key === 'Enter') addItem();
    });

    // Добавляем поле ввода и кнопку в контейнер формы
    formContainer.appendChild(inputField);
    formContainer.appendChild(addButton);

    // Добавляем форму в начало родительского элемента
    parentElement.prepend(formContainer);
};

/**
 * Функция для добавления новой записи в файл Inbox.
 * @param {string} newItem - Текст новой записи.
 */
const addNewItemToInbox = async (newItem) => {
    // Путь к файлу Inbox
    const inboxFilePath = 'Inbox.md';
    // Получаем файл Inbox
    const inboxFile = app.vault.getAbstractFileByPath(inboxFilePath);

    // Если файл не найден
    if (!inboxFile) {
        // Показываем уведомление об ошибке
        new Notice(`Файл "${inboxFilePath}" не найден.`);
        return; // Выход из функции
    }

    // Читаем текущее содержимое Inbox
    const content = await app.vault.cachedRead(inboxFile);
    // Добавляем новую запись к содержимому
    const updatedContent = `${content}\n${newItem}`.trim();

    // Обновляем файл и показываем уведомление
    await updateContentAndNotify(inboxFile, updatedContent, content, `Добавлено: "${newItem}"`);
    // Перезагружаем и отображаем содержимое Inbox
    await loadAndDisplayInboxContent();
};

/**
 * Функция для создания меню статусов.
 * @param {HTMLElement} menu - Контейнер меню, куда будут добавлены элементы.
 * @param {string} originalText - Исходный текст строки, к которой применяется статус.
 * @param {Array} allLines - Массив всех строк из Inbox.
 * @param {TFile} inboxFile - Файл Inbox, который нужно обновить.
 */
const createStatusMenu = (menu, originalText, allLines, inboxFile) => {
    // Определяем доступные статусы с соответствующими символами
    const statuses = [
        { status: 'In progress', symbol: '/' }, // Статус "В процессе"
        { status: 'To do', symbol: '<' }, // Статус "Выполнить"
        { status: 'Waiting', symbol: '>' } // Статус "Ожидание"
    ];

    // Проходимся по каждому статусу
    statuses.forEach(({ status, symbol }) => {
        // Создаём элемент меню для статуса
        const menuItem = createElement('div', { 
            className: 'menu-item', // Задаём класс для стилизации элемента меню
            children: [document.createTextNode(status)] // Добавляем текст статуса
        });

        /**
         * Обработчик клика на элементе меню статусов.
         */
        menuItem.addEventListener('click', async () => {
            // Находим индекс исходной строки
            const index = allLines.indexOf(originalText);
            // Если строка не найдена, выходим из функции
            if (index === -1) return;
            // Сохраняем текущее содержимое строки
            const currentContent = allLines[index];
            // Обновляем строку с новым статусом
            allLines[index] = `- [${symbol}] ${originalText}`;
            // Объединяем все строки обратно
            const updatedContent = allLines.join('\n');
            // Обновляем файл и показываем уведомление
            await updateContentAndNotify(
                inboxFile,
                updatedContent,
                currentContent,
                `Статус "${originalText}" поменялся на "${status}"`
            );
            // Закрываем меню
            closeDropdownMenu();
            // Перезагружаем и отображаем содержимое Inbox
            await loadAndDisplayInboxContent();
        });

        // Добавляем элемент меню в контейнер меню
        menu.appendChild(menuItem);
    });
};

/**
 * Функция для создания выпадающего меню для кнопки.
 * @param {HTMLElement} button - Кнопка, к которой привязывается меню.
 * @param {string} menuClass - Класс для стилизации меню.
 * @param {HTMLElement} lineContainer - Контейнер строки, к которой относится меню.
 * @param {Function} createMenuContent - Функция для создания содержимого меню.
 */
const createDropdownMenu = (button, menuClass, lineContainer, createMenuContent) => {
    // Назначаем обработчик клика на кнопку
    button.addEventListener('click', (event) => {
        // Останавливаем всплытие события, чтобы предотвратить закрытие меню
        event.stopPropagation();
        // Закрываем любое другое открытое меню
        closeDropdownMenu();

        // Создаём контейнер для меню с указанным классом
        const menuContainer = createElement('div', { className: menuClass });
        // Заполняем меню содержимым через переданную функцию
        createMenuContent(menuContainer);

        // Добавляем меню в тело документа
        document.body.appendChild(menuContainer);
        // Устанавливаем ссылку на открытое меню
        openMenu = menuContainer;

        // Получаем позицию кнопки
        const rect = button.getBoundingClientRect();
        // Устанавливаем позицию меню по горизонтали
        menuContainer.style.left = `${rect.left}px`; 
        // Устанавливаем позицию меню по вертикали
        menuContainer.style.top = `${rect.bottom}px`; 

        /**
         * Обработчик ухода курсора за пределы меню.
         */
        menuContainer.addEventListener('mouseleave', () => {
            // Проверяем, находится ли курсор над строкой или меню
            if (!lineContainer.matches(':hover') && !menuContainer.matches(':hover')) {
                // Закрываем меню, если курсор не над ними
                closeDropdownMenu();
            }
        });
    });
};

/**
 * Функция для создания набора кнопок (Статус, Календарь, Задача, Удалить) для каждой строки.
 * @param {HTMLElement} lineContainer - Контейнер строки.
 * @param {string} originalText - Исходный текст строки.
 * @param {Array} allLines - Массив всех строк из Inbox.
 * @param {TFile} inboxFile - Файл Inbox, который нужно обновить.
 * @param {HTMLElement} container - Родительский контейнер для строк.
 * @param {string} templateContent - Шаблон содержимого для новых задач.
 * @param {HTMLElement} textElement - Элемент текста строки.
 * @returns {HTMLElement} - Контейнер с кнопками.
 */
const createButtons = (lineContainer, originalText, allLines, inboxFile, container, templateContent, textElement) => {
    // Создаём контейнер для кнопок
    const buttonContainer = createElement('div', { className: 'button-container' });

    // Определяем конфигурацию для каждой кнопки
    const buttonConfigs = [
        {
            name: 'Статус', // Название кнопки
            menuClass: 'status-menu', // Класс для меню статусов
            createMenuContent: (menu) => createStatusMenu(menu, originalText, allLines, inboxFile) // Функция для создания содержимого меню
        },
        {
            name: 'Календарь',
            menuClass: 'calendar-menu',
            createMenuContent: (menu) => createCalendarMenu(menu, originalText, allLines, inboxFile, textElement)
        },
        {
            name: 'Задача',
            menuClass: 'task-menu',
            createMenuContent: (menu) => createTask(menu, originalText, allLines, inboxFile, container, templateContent, lineContainer)
        },
        {
            name: 'Удалить',
            action: () => deleteItem(originalText, allLines, inboxFile, container, lineContainer) // Прямой обработчик действия для удаления
        }
    ];

    // Проходимся по каждой конфигурации кнопок
    buttonConfigs.forEach(({ name, menuClass, createMenuContent, action }) => {
        // Создаём кнопку с указанным названием
        const button = createButton(name);
        // Если есть прямой обработчик действия
        if (action) {
            // Назначаем обработчик клика на кнопку
            button.addEventListener('click', action);
        } else {
            // Иначе, создаём выпадающее меню
            createDropdownMenu(button, menuClass, lineContainer, createMenuContent);
        }
        // Добавляем кнопку в контейнер кнопок
        buttonContainer.appendChild(button);
    });

    // Возвращаем контейнер кнопок
    return buttonContainer;
};

/**
 * Функция для создания меню календаря, позволяющего установить дату и время.
 * @param {HTMLElement} menu - Контейнер меню, куда будет добавлено поле ввода даты и времени.
 * @param {string} originalText - Исходный текст строки.
 * @param {Array} allLines - Массив всех строк из Inbox.
 * @param {TFile} inboxFile - Файл Inbox, который нужно обновить.
 * @param {HTMLElement} textElement - Элемент текста строки, который нужно обновить после выбора времени.
 */
const createCalendarMenu = (menu, originalText, allLines, inboxFile, textElement) => {
    // Создаём поле ввода с типом "datetime-local"
    const datetimeInput = createElement('input', {
        attributes: { type: 'datetime-local' }
    });

    /**
     * Обработчик изменения значения в поле ввода даты и времени.
     */
    datetimeInput.addEventListener('change', async (e) => {
        // Получаем выбранную дату и время
        const selectedDateTime = e.target.value;
        // Если ничего не выбрано, выходим из функции
        if (!selectedDateTime) return;

        // Находим индекс исходной строки
        const index = allLines.indexOf(originalText);
        // Если строка не найдена, выходим из функции
        if (index === -1) return;

        // Сохраняем текущее содержимое строки
        const currentContent = allLines[index];
        // Формируем новую строку с датой и временем
        const newLine = `- [ ] ${originalText} (@${selectedDateTime})`;
        // Обновляем строку в массиве строк
        allLines[index] = newLine;
        // Объединяем все строки обратно
        const updatedContent = allLines.join('\n');

        // Обновляем файл и показываем уведомление
        await updateContentAndNotify(
            inboxFile,
            updatedContent,
            currentContent,
            `Добавлено время: "${selectedDateTime}"`
        );

        // Обновляем текстовый элемент строки
        textElement.textContent = newLine;
        // Закрываем меню
        closeDropdownMenu();
        // Перезагружаем и отображаем содержимое Inbox
        await loadAndDisplayInboxContent();
    });

    // Добавляем поле ввода в меню
    menu.appendChild(datetimeInput);
    // Устанавливаем фокус на поле ввода
    datetimeInput.focus();
};

/**
 * Функция для создания новой задачи через шаблон main.md и удаления строки из Inbox.
 * @param {HTMLElement} menu - Контейнер меню.
 * @param {string} originalText - Исходный текст строки.
 * @param {Array} allLines - Массив всех строк из Inbox.
 * @param {TFile} inboxFile - Файл Inbox.
 * @param {HTMLElement} container - Родительский контейнер для строк.
 * @param {string} templateContent - (Принимается для совместимости).
 * @param {HTMLElement} lineContainer - Контейнер строки, которую нужно удалить из UI.
 */
const createTask = async (menu, originalText, allLines, inboxFile, container, templateContent, lineContainer) => {
    const sanitizedFileName = originalText.replace(/[\\\/:*?"<>|]/g, '').trim();
    if (!sanitizedFileName) {
        new Notice("Ошибка: имя задачи не может быть пустым.");
        return;
    }

    // Определяем путь к файлу будущей задачи.
    const newFilePath = `${sanitizedFileName}.md`;
    // Проверяем, существует ли уже файл по этому пути.
    if (app.vault.getAbstractFileByPath(newFilePath)) {
        // Если файл существует, выводим уведомление и прерываем выполнение.
        new Notice(`Ошибка: Заметка с именем "${sanitizedFileName}" уже существует.`);
        closeDropdownMenu(); // Закрываем меню, чтобы оно не оставалось открытым.
        return;
    }

    // Устанавливаем глобальный контекст с желаемым именем.
    window.INBOX_CONTEXT = {
        noteType: 'task',
        noteName: sanitizedFileName
    };

    // Создаем временный файл и запусткаем скрипт main.md.
    const tempFile = await app.vault.create(`temp-task-${Date.now()}.md`, '');
    await app.workspace.getLeaf().openFile(tempFile);
    new Notice(`Запускается создание задачи: "${sanitizedFileName}"`);

    // Удаляем исходную строку из Inbox.
    const index = allLines.indexOf(originalText);
    if (index !== -1) {
        const currentInboxContent = await app.vault.cachedRead(inboxFile);
        allLines.splice(index, 1);
        const updatedContent = allLines.join('\n');
        await updateContentAndNotify(inboxFile, updatedContent, currentInboxContent, '');
        container.removeChild(lineContainer);
    }
    closeDropdownMenu();
};

/**
 * Функция для удаления строки из Inbox и добавления её в Trash.
 * @param {string} originalText - Исходный текст строки.
 * @param {Array} allLines - Массив всех строк из Inbox.
 * @param {TFile} inboxFile - Файл Inbox, который нужно обновить.
 * @param {HTMLElement} container - Родительский контейнер для строк.
 * @param {HTMLElement} lineContainer - Контейнер строки, которую нужно удалить из UI.
 */
const deleteItem = async (originalText, allLines, inboxFile, container, lineContainer) => {
    // Путь к файлу Trash
    const trashFilePath = 'Trash.md';
    // Получаем файл Trash
    const trashFile = app.vault.getAbstractFileByPath(trashFilePath);

    // Если файл Trash не найден
    if (!trashFile) {
        // Показываем уведомление об ошибке
        new Notice('Ошибка: файл Trash.md не найден.');
        return; // Выход из функции
    }

    // Читаем текущее содержимое Trash
    const trashContent = await app.vault.cachedRead(trashFile);
    // Добавляем удалённую строку в Trash
    const updatedTrashContent = `${trashContent}\n${originalText}`.trim();
    // Обновляем файл Trash и показываем уведомление
    await updateContentAndNotify(
        trashFile,
        updatedTrashContent,
        trashContent,
        `Удалено: "${originalText}"`
    );

    // Удаление строки из Inbox
    const index = allLines.indexOf(originalText); // Находим индекс исходной строки
    // Если строка найдена
    if (index !== -1) {
        // Удаляем строку из массива строк
        allLines.splice(index, 1);
        // Объединяем все строки обратно
        const updatedContent = allLines.join('\n');
        // Читаем актуальное содержимое Inbox
        const inboxContent = await app.vault.cachedRead(inboxFile);
        // Обновляем файл Inbox без сообщения
        await updateContentAndNotify(inboxFile, updatedContent, inboxContent, '');
        // Удаляем строку из UI
        container.removeChild(lineContainer);
    }
};

/**
 * Функция для переключения строки в режим редактирования.
 * @param {HTMLElement} lineContainer - Контейнер строки.
 * @param {HTMLElement} textElement - Элемент текста строки.
 * @param {string} originalText - Исходный текст строки.
 * @param {Array} allLines - Массив всех строк из Inbox.
 * @param {TFile} inboxFile - Файл Inbox, который нужно обновить.
 * @param {string} templateContent - Содержимое шаблона для новой задачи.
 */
const toggleEditMode = (lineContainer, textElement, originalText, allLines, inboxFile, templateContent) => {
    // Создаём поле ввода с типом "text" и начальным значением
    const inputField = createElement('input', {
        attributes: { type: 'text', value: originalText },
        className: 'edit-input'
    });

    // Заменяем текстовый элемент на поле ввода
    lineContainer.replaceChild(inputField, textElement);
    // Устанавливаем фокус на поле ввода
    inputField.focus();
    // Отмечаем текущую строку как активную для редактирования
    activeInput = lineContainer;

    // Инициализируем процесс редактирования
    enableEditing(lineContainer, inputField, textElement, originalText, allLines, inboxFile, templateContent);
};

/**
 * Функция для обработки редактирования строки, сохранения изменений и обновления UI.
 * @param {HTMLElement} lineContainer - Контейнер строки.
 * @param {HTMLElement} inputField - Поле ввода для редактирования текста.
 * @param {HTMLElement} textElement - Элемент текста строки.
 * @param {string} originalText - Исходный текст строки.
 * @param {Array} allLines - Массив всех строк из Inbox.
 * @param {TFile} inboxFile - Файл Inbox, который нужно обновить.
 * @param {string} content - Текущее содержимое файла Inbox.
 */
const enableEditing = async (lineContainer, inputField, textElement, originalText, allLines, inboxFile, content) => {
    /**
     * Функция для установки ширины поля ввода на основе длины текста.
     */
    const setInputWidth = () => {
        const approxWidth = originalText.length * 8;
        inputField.style.width = `${Math.max(100, approxWidth)}px`;
    };

    // Устанавливаем начальную ширину и обновляем при вводе
    setInputWidth();
    inputField.addEventListener('input', setInputWidth);

    /**
     * Функция для сохранения изменений и выхода из редактирования.
     */
    const saveChanges = async () => {
        const newText = inputField.value.trim();
        if (newText && newText !== originalText) {
            const index = allLines.indexOf(originalText);
            if (index !== -1) {
                allLines[index] = newText;
                const updatedContent = allLines.join('\n');
                await updateContentAndNotify(
                    inboxFile,
                    updatedContent,
                    content,
                    `Изменено: "${newText}"`
                );
                await loadAndDisplayInboxContent();
                return; // Выход после сохранения и перезагрузки
            }
        }
        // Если текст не изменился или пустой, просто выйти из режима редактирования
        lineContainer.replaceChild(textElement, inputField);
    };

    // Обработчик нажатия клавиш
    inputField.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            saveChanges();
        }
    });

    // Обработчик потери фокуса
    inputField.addEventListener('blur', () => {
        saveChanges();
    });
};


/**
 * Функция для создания нового элемента строки в интерфейсе.
 * @param {string} line - Текст строки.
 * @param {Array} allLines - Массив всех строк из Inbox.
 * @param {TFile} inboxFile - Файл Inbox, который нужно обновить.
 * @param {string} templateContent - Содержимое шаблона для новой задачи.
 * @param {HTMLElement} container - Родительский контейнер для строк.
 * @returns {HTMLElement} - Созданный контейнер строки.
 */
const createLineElement = (line, allLines, inboxFile, templateContent, container) => {
    // Создаём контейнер для строки с классом
    const lineContainer = createElement('div', { className: 'line-divider' });
    // Создаём элемент текста со строкой
    const textElement = createElement('span', {
        children: [document.createTextNode(line)]
    });

    /**
     * Обработчик клика по тексту строки для перехода в режим редактирования.
     */
    textElement.addEventListener('click', () => {
        // Переключаем строку в режим редактирования
        toggleEditMode(lineContainer, textElement, line, allLines, inboxFile, templateContent);
    });

    // Создаём контейнер с кнопками для строки
    const buttonContainer = createButtons(
        lineContainer,
        line,
        allLines,
        inboxFile,
        container,
        templateContent,
        textElement
    );
    // Скрываем контейнер с кнопками по умолчанию
    buttonContainer.style.visibility = 'hidden';

    // Добавляем текстовый элемент и контейнер с кнопками в контейнер строки
    lineContainer.appendChild(textElement);
    lineContainer.appendChild(buttonContainer);
    // Добавляем контейнер строки в родительский контейнер
    container.appendChild(lineContainer);

    /**
     * Обработчик наведения курсора на строку для отображения кнопок.
     */
    lineContainer.addEventListener('mouseenter', () => {
        // Показываем кнопки при наведении
        buttonContainer.style.visibility = 'visible';
    });

    /**
     * Обработчик ухода курсора с строки для скрытия кнопок.
     */
    lineContainer.addEventListener('mouseleave', () => {
        // Проверяем, находится ли курсор над открытым меню
        if (!openMenu || !openMenu.matches(':hover')) {
            // Скрываем кнопки, если меню не активно
            buttonContainer.style.visibility = 'hidden';
        }
    });

    // Возвращаем контейнер строки
    return lineContainer;
};

/**
 * Функция для загрузки и отображения содержимого файла Inbox.
 */
const loadAndDisplayInboxContent = async () => {
    // Получаем файлы Inbox и шаблона задачи одновременно
    const [inboxFile, templateFile] = await Promise.all([
        app.vault.getAbstractFileByPath('Inbox.md'),
        app.vault.getAbstractFileByPath('templates/task.md')
    ]);

    // Проверяем наличие обоих файлов
    if (!inboxFile || !templateFile) {
        // Определяем, какой файл отсутствует
        const missingFile = !inboxFile ? 'Inbox.md' : 'templates/task.md';
        // Показываем уведомление об отсутствующем файле
        new Notice(`Файл "${missingFile}" не найден.`);
        return; // Выход из функции
    }

    // Читаем содержимое шаблона задачи и Inbox одновременно
    const [templateContent, content] = await Promise.all([
        app.vault.cachedRead(templateFile),
        app.vault.cachedRead(inboxFile)
    ]);

    // Удаляем старый контейнер Inbox, если он существует, чтобы избежать дублирования
    const existingContainer = document.querySelector('.inbox-container');
    if (existingContainer) existingContainer.remove();

    // Создаём новый контейнер для Inbox
    const container = createElement('div', { className: 'inbox-container' });

    // Добавляем форму для добавления новых записей
    createAddItemForm(container);

    // Разбиваем содержимое на строки и обрезаем пробелы
    const allLines = content.split('\n').map(line => line.trim());
    // Фильтруем строки для отображения (игнорируем уже помеченные)
    const visibleLines = allLines.filter(line => line.length > 0 && !line.startsWith('- ['));

    // Если нет видимых строк
    if (visibleLines.length === 0) {
        // Создаём элемент с текстом "Пусто" и курсивным начертанием
        const emptyMessage = createElement('div', {
            children: [document.createTextNode('Пусто')],
            attributes: { style: 'font-style: italic;' }
        });
        // Добавляем сообщение в контейнер
        container.appendChild(emptyMessage);
    } else {
        // Проходимся по каждой видимой строке
        visibleLines.forEach(line => {
            // Создаём и добавляем элемент строки в интерфейс
            createLineElement(line, allLines, inboxFile, templateContent, container);
        });
    }

    // Вставляем контейнер в элемент DataView
    dv.el('div', container);
};

/**
 * Обработчик кликов по документу для закрытия открытого меню при клике вне его.
 * @param {Event} event - Событие клика.
 */
document.addEventListener('click', (event) => {
    // Если есть открытое меню и клик произошёл вне его
    if (openMenu && !openMenu.contains(event.target)) {
        // Закрываем меню
        closeDropdownMenu();
    }
});

// Инициализируем загрузку содержимого Inbox при загрузке скрипта
loadAndDisplayInboxContent();
```

#### Trash
```dataviewjs
/**
 * Асинхронно считывает и отображает содержимое файла 'Trash.md'
 * в виде стилизованного списка в блоке Dataview.
 * @async
 * @returns {Promise<void>} Промис, который разрешается после отображения содержимого.
 */
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
