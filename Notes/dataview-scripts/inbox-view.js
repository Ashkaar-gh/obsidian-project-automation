// Оборачиваем весь скрипт в асинхронную самовызывающуюся функцию (IIFE).
(async () => {
    // Получаем объект 'obsidian' из входных данных.
    const { obsidian } = input;

    /**
     * Загружает внешний JavaScript-модуль из файла в хранилище.
     * @async
     * @param {string} path - Путь к файлу модуля.
     * @returns {Promise<object|null>} - Промис с экспортированным объектом из модуля.
     */
    async function loadModule(path) {
        try {
            const moduleContent = await app.vault.adapter.read(path);
            return new Function(moduleContent)();
        } catch (error) {
            console.error(`Ошибка загрузки модуля: ${path}`, error);
            return null;
        }
    }

    // Параллельно загружаем все наши модули.
    const [manager, renderer, eventHandler, utils] = await Promise.all([
        loadModule("dataview-scripts/inbox-view-modules/1-inbox-manager.js"),
        loadModule("dataview-scripts/inbox-view-modules/2-inbox-ui-renderer.js"),
        loadModule("dataview-scripts/inbox-view-modules/3-inbox-event-handler.js"),
        loadModule("dataview-scripts/inbox-view-modules/4-inbox-utils.js")
    ]);

    // Проверяем, что все модули успешно загрузились.
    if (!manager || !renderer || !eventHandler || !utils) {
        dv.paragraph("Не удалось загрузить один или несколько модулей для Inbox.");
        return;
    }

    // Создаем единый объект 'context' для хранения общего состояния, если потребуется.
    const context = {
        // Здесь можно хранить данные, которые должны быть доступны всем модулям.
    };

    /**
     * Основная функция отрисовки. Полностью перестраивает содержимое блока Dataview.
     * @async
     */
    async function render() {
        // Очищаем контейнер перед новой отрисовкой.
        dv.container.innerHTML = '';

        // Получаем данные с помощью менеджера.
        const inboxData = await manager.loadInboxData();
        if (!inboxData) {
            dv.paragraph("Не удалось загрузить данные Inbox.");
            return;
        }

        // Отрисовываем UI с помощью рендерера, передавая ему данные.
        const inboxContainer = renderer.renderInbox(inboxData);
        dv.container.appendChild(inboxContainer);

        // "Оживляем" отрисованный UI с помощью обработчика событий и передаем ему ссылки на другие модули и функцию render для возможности перезагрузки.
        eventHandler.initialize({
            container: inboxContainer,
            context,
            manager,
            renderer,
            utils,
            render
        });
    }

    // Регистрируем обработчик выгрузки для очистки.
    dv.container.onunload = () => {
        if (eventHandler.cleanup) {
            eventHandler.cleanup();
        }
    };

    // Выполняем самый первый рендер.
    await render();

})();