// dataview-scripts/inbox-view-modules/3-event-handler.js

// Массив для хранения ссылок на глобальные слушатели событий. Это необходимо для того, чтобы мы могли их корректно удалить при выгрузке скрипта, предотвращая утечки памяти.
let activeListeners = [];

/**
 * Инициализирует всю интерактивность для представления Inbox. Эта функция является "мозгом" интерфейса:
 * она берет "мертвый" HTML от отрисовщика и "оживляет" его, прикрепляя все необходимые слушатели событий.
 * @param {object} params - Объект с параметрами, содержащий все необходимые зависимости (модули, контейнер, функцию рендера).
 */
function initialize({ container, manager, renderer, utils, render }) {
    
    /**
     * Обрабатывает логику добавления нового элемента в Inbox.
     * @async
     */
    async function handleAddItem() {
        const inputField = container.querySelector('.input-field');
        const newItem = inputField.value.trim();
        // Проверяем, что пользователь действительно что-то ввел.
        if (newItem) {
            inputField.value = ''; // Очищаем поле для удобства пользователя.
            await manager.addNewItemToInbox(newItem); // Вызываем менеджер для записи в файл.
            await render(); // Запускаем полный перерендеринг для отображения изменений.
        }
    }

    /**
     * Обрабатывает логику удаления элемента из Inbox.
     * @async
     * @param {HTMLElement} lineContainer - Контейнер строки, которую нужно удалить.
     */
    async function handleDeleteItem(lineContainer) {
        const originalText = lineContainer.dataset.originalText;
        const inboxData = await manager.loadInboxData(); // Получаем актуальные данные.
        const success = await manager.deleteItem(originalText, inboxData.allLines, inboxData.inboxFile);
        // Если удаление из файла прошло успешно, удаляем элемент из DOM без полной перерисовки. Это оптимизация для более плавной работы интерфейса.
        if (success) {
            container.removeChild(lineContainer);
        }
    }

    /**
     * Обрабатывает логику создания новой задачи из элемента Inbox.
     * @async
     * @param {HTMLElement} lineContainer - Контейнер строки, из которой создается задача.
     */
    async function handleCreateTask(lineContainer) {
        const originalText = lineContainer.dataset.originalText;
        const inboxData = await manager.loadInboxData();
        utils.closeDropdownMenu(); // Закрываем меню на случай, если оно было открыто.
        const success = await manager.createTask(originalText, inboxData.allLines, inboxData.inboxFile);
        if (success) {
            container.removeChild(lineContainer);
        }
    }

    /**
     * Обрабатывает открытие и позиционирование выпадающих меню ("Статус", "Календарь").
     * @param {HTMLElement} button - Кнопка, по которой кликнули.
     */
    function handleDropdown(button) {
        utils.closeDropdownMenu(); // Гарантируем, что в любой момент времени открыто не более одного меню.

        let menuContent;
        const action = button.dataset.action;

        // В зависимости от действия на кнопке, вызываем соответствующую функцию из отрисовщика для создания HTML-структуры меню.
        if (action === 'status') {
            menuContent = renderer.createStatusMenu();
        } else if (action === 'calendar') {
            menuContent = renderer.createCalendarMenu();
        } else {
            return; // Если это не кнопка с меню, ничего не делаем.
        }

        // Добавляем меню в самый конец документа, чтобы оно отображалось поверх всех остальных элементов.
        document.body.appendChild(menuContent);
        utils.setOpenMenu(menuContent); // Сообщаем утилитам, что это меню теперь является "активным".

        // Вычисляем и устанавливаем позицию меню точно под кнопкой, которая его вызвала.
        const rect = button.getBoundingClientRect();
        menuContent.style.left = `${rect.left}px`;
        menuContent.style.top = `${rect.bottom}px`;

        // Сразу после создания меню "оживляем" его, добавляя необходимые слушатели событий.
        addMenuEventListeners(menuContent, button, action);
    }

    /**
     * "Оживляет" только что созданное выпадающее меню, добавляя к его элементам слушатели событий.
     * @param {HTMLElement} menu - Контейнер меню.
     * @param {HTMLElement} button - Кнопка, открывшая меню (нужна для получения контекста строки).
     * @param {string} action - Тип меню ('status' или 'calendar').
     */
    function addMenuEventListeners(menu, button, action) {
        const lineContainer = button.closest('.line-divider');
        const originalText = lineContainer.dataset.originalText;

        if (action === 'status') {
            // Для меню статусов мы слушаем клики по его элементам.
            menu.addEventListener('click', async (event) => {
                const menuItem = event.target.closest('.menu-item');
                if (!menuItem) return;

                const status = menuItem.dataset.status;
                const symbol = menuItem.dataset.symbol;
                const inboxData = await manager.loadInboxData();
                
                await manager.updateItemStatus(originalText, inboxData.allLines, inboxData.inboxFile, status, symbol);
                utils.closeDropdownMenu();
                await render(); // Перерисовываем все для чистоты и отображения изменений.
            });
        } else if (action === 'calendar') {
            // Для меню календаря мы слушаем событие 'change' на поле ввода даты.
            const input = menu.querySelector('input');
            input.focus(); // Сразу устанавливаем фокус на поле ввода для удобства.
            input.addEventListener('change', async (event) => {
                const dateTime = event.target.value;
                if (!dateTime) return;

                const inboxData = await manager.loadInboxData();
                await manager.updateItemDateTime(originalText, inboxData.allLines, inboxData.inboxFile, dateTime);
                utils.closeDropdownMenu();
                await render();
            });
        }
    }

    /**
     * Единый обработчик для всех кликов внутри контейнера Inbox. Использует делегирование событий:
     * вместо того чтобы вешать сотни слушателей на каждую кнопку, мы вешаем один на родительский контейнер,
     * что значительно повышает производительность.
     * @param {Event} event - Событие клика.
     */
    function inboxContainerClickHandler(event) {
        const target = event.target;

        // Ищем клик по кнопке "Добавить".
        if (target.closest('.add-button')) {
            handleAddItem();
            return;
        }

        // Находим ближайший родительский контейнер строки, чтобы понять, к какому элементу относится действие.
        const lineContainer = target.closest('.line-divider');
        if (!lineContainer) return; // Если клик был не на строке, выходим.

        // Ищем клик по кнопке с атрибутом [data-action].
        const actionButton = target.closest('[data-action]');
        if (actionButton) {
            // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Останавливаем "всплытие" события. Это не дает глобальному обработчику
            // немедленно закрыть меню, которое мы только что собираемся открыть.
            event.stopPropagation();

            const action = actionButton.dataset.action;
            // В зависимости от действия, вызываем соответствующую функцию.
            if (action === 'delete') {
                handleDeleteItem(lineContainer);
            } else if (action === 'task') {
                handleCreateTask(lineContainer);
            } else {
                handleDropdown(actionButton);
            }
            return;
        }
    }

    /**
     * Обработчик наведения и ухода мыши для показа/скрытия кнопок.
     * @param {Event} event - Событие мыши (mouseover или mouseout).
     */
    function handleHover(event) {
        const lineContainer = event.target.closest('.line-divider');
        if (!lineContainer) return;

        const buttonContainer = lineContainer.querySelector('.button-container');
        if (event.type === 'mouseover') {
            buttonContainer.style.visibility = 'visible';
        } else {
            // Скрываем кнопки, только если курсор не находится над открытым в данный момент меню.
            const openMenu = utils.getOpenMenu();
            if (!openMenu || !openMenu.matches(':hover')) {
                buttonContainer.style.visibility = 'hidden';
            }
        }
    }

    /**
     * Глобальный обработчик кликов по всему документу. Его единственная задача — закрывать
     * открытое меню, если пользователь кликнул где-либо за его пределами.
     * @param {Event} event - Событие клика.
     */
    function globalClickHandler(event) {
        const openMenu = utils.getOpenMenu();
        // Если есть открытое меню и клик произошёл не по нему.
        if (openMenu && !openMenu.contains(event.target)) {
            utils.closeDropdownMenu();
        }
    }

    // Прикрепляем все необходимые слушатели событий.
    container.addEventListener('click', inboxContainerClickHandler);
    container.addEventListener('mouseover', handleHover);
    container.addEventListener('mouseout', handleHover);
    document.addEventListener('click', globalClickHandler);

    // Сохраняем ссылку на глобальный слушатель для последующей очистки.
    activeListeners.push({ target: document, type: 'click', handler: globalClickHandler });
}

/**
 * Функция для очистки. Удаляет все глобальные слушатели событий,
 * чтобы избежать утечек памяти и "зомби"-слушателей при закрытии заметки.
 */
function cleanup() {
    activeListeners.forEach(({ target, type, handler }) => {
        target.removeEventListener(type, handler);
    });
    activeListeners = []; // Очищаем массив после удаления.
}

// "Экспортируем" функции initialize и cleanup, чтобы главный скрипт мог их вызвать.
return {
    initialize,
    cleanup
};