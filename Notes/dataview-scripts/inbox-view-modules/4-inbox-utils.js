// Глобальная переменная для хранения ссылки на текущее открытое выпадающее меню.
let openMenu = null;

/**
 * Вспомогательная функция для создания DOM-элементов с указанными атрибутами и дочерними элементами.
 * @param {string} tag - Тег создаваемого элемента (например, 'div', 'span', 'button').
 * @param {object} options - Объект с настройками для элемента.
 * @param {string} [options.className] - Класс или классы для элемента.
 * @param {object} [options.attributes] - Объект с атрибутами и их значениями.
 * @param {Array} [options.children] - Массив дочерних элементов или текстовых узлов.
 * @returns {HTMLElement} - Созданный DOM-элемент.
 */
function createElement(tag, { className, attributes = {}, children = [] } = {}) {
    // Создаём элемент с указанным тегом.
    const element = document.createElement(tag);

    // Присваиваем классы, если они указаны.
    if (className) element.className = className;
    
    // Устанавливаем каждый атрибут из объекта.
    for (const [attr, value] of Object.entries(attributes)) {
        element.setAttribute(attr, value);
    }

    // Добавляем дочерние элементы.
    children.forEach(child => element.appendChild(child));

    // Возвращаем полностью собранный элемент.
    return element;
};

/**
 * Функция для создания кнопки с текстом и списком классов.
 * @param {string} text - Текст, отображаемый на кнопке.
 * @param {Array} [classList=['dropdown-button']] - Список классов для кнопки.
 * @returns {HTMLElement} - Созданная кнопка.
 */
function createButton(text, classList = ['dropdown-button']) {
    // Используем нашу универсальную функцию createElement для создания кнопки.
    return createElement('button', {
        className: classList.join(' '), // Объединяем классы в одну строку.
        children: [document.createTextNode(text)] // Добавляем текстовый узел внутри кнопки.
    });
};

/**
 * Функция для закрытия текущего открытого выпадающего меню.
 */
function closeDropdownMenu() {
    // Проверяем, есть ли открытое меню.
    if (openMenu) {
        // Удаляем его из DOM.
        openMenu.remove();
        // Сбрасываем ссылку на него, чтобы система знала, что меню закрыто.
        openMenu = null;
    }
};

/**
 * Функция для установки ссылки на текущее открытое меню.
 * @param {HTMLElement} menuElement - Элемент меню, который был открыт.
 */
function setOpenMenu(menuElement) {
    openMenu = menuElement;
}

/**
 * Функция для проверки, открыто ли в данный момент какое-либо меню.
 * @returns {HTMLElement|null} - Возвращает элемент открытого меню или null.
 */
function getOpenMenu() {
    return openMenu;
}

// "Экспортируем" все утилиты для использования в других модулях.
return {
    createElement,
    createButton,
    closeDropdownMenu,
    setOpenMenu,
    getOpenMenu
};