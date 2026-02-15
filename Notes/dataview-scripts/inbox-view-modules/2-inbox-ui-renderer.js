/**
 * UI Inbox: renderInbox(inboxData, ui), форма добавления, строки с кнопками (редактировать, удалить, в задачу, в напоминания).
 */
function renderInbox(inboxData, ui) {
    const container = ui.create('div', { cls: 'inbox-container' });
    const addItemForm = createAddItemForm(ui);
    container.appendChild(addItemForm);

    if (inboxData.visibleLines.length === 0) {
        ui.create('div', {
            text: 'Пусто',
            style: { fontStyle: 'italic', padding: '10px 0', color: 'var(--text-muted)' },
            parent: container
        });
    } else {
        inboxData.visibleLines.forEach(line => {
            const lineElement = createLineElement(line, ui);
            container.appendChild(lineElement);
        });
    }
    return container;
}

/**
 * Создает форму добавления новой записи.
 * 
 * @param {Object} ui - Модуль UI утилит.
 * @returns {HTMLElement} Возвращает контейнер формы.
 */
function createAddItemForm(ui) {
    const input = ui.input('Добавить запись');
    const btn = ui.btn('Добавить');
    
    return ui.formContainer([input, btn]);
}

/**
 * Создает визуальный элемент строки списка.
 * 
 * @param {string} line - Текст строки.
 * @param {Object} ui - Модуль UI утилит.
 * @returns {HTMLElement} Возвращает элемент строки.
 */
function createLineElement(line, ui) {
    const lineContainer = ui.create('div', {
        cls: 'inbox-line',
        attr: { 'data-original-text': line }
    });

    ui.create('span', {
        cls: 'inbox-text',
        text: line,
        parent: lineContainer
    });

    const buttonContainer = createButtons(ui);
    lineContainer.appendChild(buttonContainer);

    return lineContainer;
}

/**
 * Генерирует кнопки действий для элемента списка.
 * 
 * @param {Object} ui - Модуль UI утилит.
 * @returns {HTMLElement} Возвращает контейнер кнопок.
 */
function createButtons(ui) {
    const buttonContainer = ui.create('div', { cls: 'inbox-actions' });
    
    const actions = [
        { label: 'Задача', action: 'task' },
        { label: 'Изменить', action: 'edit' },
        { label: 'Календарь', action: 'calendar' },
        { label: 'Удалить', action: 'delete' }
    ];

    actions.forEach(conf => {
        const btn = ui.actionBtn(conf.label, conf.action);
        buttonContainer.appendChild(btn);
    });

    return buttonContainer;
}

/**
 * Создает меню выбора даты.
 * 
 * @param {Object} ui - Модуль UI утилит.
 * @returns {HTMLElement} Возвращает элемент меню.
 */
function createCalendarMenu(ui) {
    const menu = ui.create('div', { cls: 'calendar-menu' });
    
    const dateField = ui.dateInput(null, {
        style: { width: '200px' }
    });

    menu.appendChild(dateField);
    return menu;
}

return {
    renderInbox,
    createCalendarMenu
};