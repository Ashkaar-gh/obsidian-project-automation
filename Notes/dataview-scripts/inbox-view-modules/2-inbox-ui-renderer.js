/**
 * Главная функция-отрисовщик. Создает корневой контейнер и наполняет его
 * формой добавления и списком элементов из Inbox.
 * @param {object} inboxData - Объект с данными, полученный от менеджера.
 * @returns {HTMLElement} - Созданный корневой DOM-элемент для всего Inbox.
 */
function renderInbox(inboxData) {
    // Создаём новый контейнер для Inbox, чтобы избежать дублирования при обновлении.
    const container = document.createElement('div');
    container.className = 'inbox-container';

    // Добавляем форму для добавления новых записей.
    const addItemForm = createAddItemForm();
    container.appendChild(addItemForm);

    // Если нет видимых строк для отображения.
    if (inboxData.visibleLines.length === 0) {
        // Создаём элемент с текстом "Пусто" и курсивным начертанием.
        const emptyMessage = document.createElement('div');
        emptyMessage.textContent = 'Пусто';
        emptyMessage.style.fontStyle = 'italic';
        container.appendChild(emptyMessage);
    } else {
        // Проходимся по каждой видимой строке.
        inboxData.visibleLines.forEach(line => {
            // Создаём и добавляем элемент строки в интерфейс.
            const lineElement = createLineElement(line, inboxData);
            container.appendChild(lineElement);
        });
    }
    return container;
}

/**
 * Функция для создания формы добавления новой записи в Inbox.
 * @returns {HTMLElement} - Контейнер с формой.
 */
function createAddItemForm() {
    // Создаём контейнер для формы.
    const formContainer = document.createElement('div');

    // Создаём поле ввода с типом "text" и плейсхолдером.
    const inputField = document.createElement('input');
    inputField.setAttribute('type', 'text');
    inputField.setAttribute('placeholder', 'Новая запись');
    inputField.className = 'input-field';

    // Создаём кнопку "Добавить" с классом.
    const addButton = document.createElement('button');
    addButton.textContent = 'Добавить';
    addButton.className = 'add-button';

    // Добавляем поле ввода и кнопку в контейнер формы.
    formContainer.appendChild(inputField);
    formContainer.appendChild(addButton);

    return formContainer;
}

/**
 * Функция для создания нового элемента строки в интерфейсе.
 * @param {string} line - Текст строки.
 * @param {object} inboxData - Объект с данными.
 * @returns {HTMLElement} - Созданный контейнер строки.
 */
function createLineElement(line, inboxData) {
    // Создаём контейнер для строки с классом.
    const lineContainer = document.createElement('div');
    lineContainer.className = 'line-divider';
    // Сохраняем оригинальный текст в data-атрибуте для легкого доступа.
    lineContainer.dataset.originalText = line;

    // Создаём элемент текста со строкой.
    const textElement = document.createElement('span');
    textElement.textContent = line;

    // Создаём контейнер с кнопками для строки.
    const buttonContainer = createButtons();
    // Скрываем контейнер с кнопками по умолчанию.
    buttonContainer.style.visibility = 'hidden';

    // Добавляем текстовый элемент и контейнер с кнопками в контейнер строки.
    lineContainer.appendChild(textElement);
    lineContainer.appendChild(buttonContainer);

    return lineContainer;
}

/**
 * Функция для создания набора кнопок (Статус, Календарь, Задача, Удалить) для каждой строки.
 * @returns {HTMLElement} - Контейнер с кнопками.
 */
function createButtons() {
    // Создаём контейнер для кнопок.
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'button-container';

    // ИЗМЕНЕНИЕ: Теперь мы используем массив объектов.
    // 'label' - то, что видит пользователь.
    // 'action' - надежный ключ для нашей логики.
    const buttonConfigs = [
        { label: 'Статус', action: 'status' },
        { label: 'Календарь', action: 'calendar' },
        { label: 'Задача', action: 'task' },
        { label: 'Удалить', action: 'delete' }
    ];

    // Проходимся по каждой конфигурации.
    buttonConfigs.forEach(config => {
        // Создаём кнопку с текстом из 'label'.
        const button = document.createElement('button');
        button.textContent = config.label;
        button.className = 'dropdown-button';
        // Устанавливаем data-атрибут из 'action'.
        button.dataset.action = config.action;
        // Добавляем кнопку в контейнер кнопок.
        buttonContainer.appendChild(button);
    });

    return buttonContainer;
}

/**
 * Функция для создания меню статусов.
 * @returns {HTMLElement} - Контейнер меню с элементами статусов.
 */
function createStatusMenu() {
    const menu = document.createElement('div');
    menu.className = 'status-menu';

    // Определяем доступные статусы с соответствующими символами.
    const statuses = [
        { status: 'In progress', symbol: '/' }, // Статус "В процессе"
        { status: 'To do', symbol: '<' }, // Статус "Выполнить"
        { status: 'Waiting', symbol: '>' } // Статус "Ожидание"
    ];

    // Проходимся по каждому статусу.
    statuses.forEach(({ status, symbol }) => {
        // Создаём элемент меню для статуса.
        const menuItem = document.createElement('div');
        menuItem.className = 'menu-item';
        menuItem.textContent = status;
        // Сохраняем данные в атрибутах для обработчика событий.
        menuItem.dataset.status = status;
        menuItem.dataset.symbol = symbol;
        menu.appendChild(menuItem);
    });
    return menu;
}

/**
 * Функция для создания меню календаря, позволяющего установить дату и время.
 * @returns {HTMLElement} - Контейнер меню с полем ввода даты и времени.
 */
function createCalendarMenu() {
    const menu = document.createElement('div');
    menu.className = 'calendar-menu';

    // Создаём поле ввода с типом "datetime-local".
    const datetimeInput = document.createElement('input');
    datetimeInput.setAttribute('type', 'datetime-local');
    menu.appendChild(datetimeInput);

    return menu;
}

// "Экспортируем" основные функции отрисовки.
return {
    renderInbox,
    createStatusMenu,
    createCalendarMenu
};