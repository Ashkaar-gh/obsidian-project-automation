// Оборачиваем весь скрипт в асинхронную самовызывающуюся функцию (IIFE). Это позволит использовать 'await' на верхнем уровне и изолировать переменные скрипта от глобального пространства имен.
(async () => {
    // Получаем объект 'obsidian' из входных данных, которые Dataview передает в блок dv.view. Этот объект необходим для использования API рендеринга Markdown.
    const { obsidian } = input;

    /**
     * Загружает внешний JavaScript-модуль из файла в хранилище.
     * Dataview JS не имеет встроенной системы импорта (как 'require' или 'import'),
     * поэтому мы реализуем свою: читаем файл как текст и выполняем его как функцию.
     * @async
     * @param {string} path - Путь к файлу модуля.
     * @returns {Promise<object|null>} - Промис, который разрешается экспортированным объектом из модуля или null в случае ошибки.
     */
    async function loadModule(path) {
        // Читаем содержимое файла модуля.
        const moduleContent = await app.vault.adapter.read(path);
        // Создаем новую анонимную функцию из содержимого файла и немедленно ее вызываем. Это позволяет модулю вернуть объект с функциями.
        return new Function(moduleContent)();
    }

    // Параллельно загружаем все три модуля с помощью Promise.all для ускорения инициализации. Деструктурируем результат, чтобы сразу получить объекты с функциями каждого модуля.
    const [fetcher, renderer, eventHandler] = await Promise.all([
        // Модуль для сбора данных
        loadModule("dataview-scripts/task-view-modules/1-task-data-fetcher.js"),
        // Модуль для отрисовки HTML
        loadModule("dataview-scripts/task-view-modules/2-task-renderer.js"),
        // Модуль для обработки интерактивности
        loadModule("dataview-scripts/task-view-modules/3-task-event-handler.js")
    ]);

    // Проверяем, что все модули успешно загрузились.
    if (!fetcher || !renderer || !eventHandler) { 
        dv.paragraph("Не удалось загрузить модули."); 
        return; 
    }

    // Создаем единый объект 'context' для хранения состояния. Он передается в разные модули и позволяет им обмениваться информацией, например, данными о задаче (structuredData) или ссылкой на активное поле редактирования (activeEditArea).
    const context = { 
        structuredData: [], 
        flatTocEntries: [], 
        activeEditArea: null 
    };

    /**
     * Основная функция отрисовки. Полностью перестраивает содержимое блока Dataview.
     * Она получает данные, вызывает модули для отрисовки HTML и заменяет старое содержимое новым,
     * сохраняя при этом позицию прокрутки.
     * @async
     * @returns {Promise<void>} - Промис, который разрешается после завершения отрисовки.
     */
    async function render() {
        // Сохраняем текущую позицию прокрутки, чтобы восстановить ее после обновления и избежать "прыжка" страницы.
        const scrollableParent = dv.container.closest('.markdown-reading-view .cm-scroller');
        const scrollTop = scrollableParent ? scrollableParent.scrollTop : 0;

        // Создаем временный DOM-элемент. Вся отрисовка происходит в нем "за кадром". Это предотвращает мерцание старого контента во время загрузки нового.
        const tempContainer = document.createElement('div');

        // Вызываем модуль-сборщик для получения актуальных данных.
        const taskData = await fetcher.fetchData(dv, app);

        // Обновляем данные в общем контексте.
        context.structuredData = taskData.structuredData;
        context.flatTocEntries = taskData.flatTocEntries;

        // Вызываем модуль-отрисовщик, чтобы он построил HTML-структуру во временном контейнере.
        await renderer.renderToc(dv, obsidian, tempContainer, context.flatTocEntries);
        await renderer.renderContent(dv, obsidian, tempContainer, context.structuredData);

        // Заменяем реальное содержимое контейнера Dataview на уже готовый HTML из временного.
        dv.container.innerHTML = tempContainer.innerHTML;
        
        // Восстанавливаем позицию прокрутки.
        if (scrollableParent) { 
            scrollableParent.scrollTop = scrollTop; 
        }
    }

    // Вызываем модуль-обработчик, который "навешивает" все необходимые слушатели событий (клики, и т.д.). Взамен он возвращает функцию 'cleanupUI', которую мы вызовем позже для удаления этих слушателей.
    const cleanupUI = eventHandler.initialize(dv, obsidian, app, dv.container, context, render);

    /**
     * Создает "обезвреженную" версию функции, которая будет вызвана только один раз
     * через указанный промежуток времени после последнего события.
     * @param {Function} func - Функция, вызов которой нужно отложить.
     * @param {number} delay - Задержка в миллисекундах.
     * @returns {Function} - Обернутая функция, готовая к использованию.
     */
    function debounce(func, delay) {
        let timeout;
        return function(...args) { 
            clearTimeout(timeout); 
            timeout = setTimeout(() => func.apply(this, args), delay); 
        };
    }
    // Создаем "обезвреженную" версию нашей функции рендеринга.
    const debouncedRender = debounce(render, 200);

    // Этот обработчик срабатывает, когда пользователь переключается на вкладку с нашей задачей. Он гарантирует, что при открытии задачи данные будут на 100% актуальны.
    const leafChangeListener = (leaf) => {
        // Добавляем проверку, что dv.current() существует.
        const dvFile = dv.current();
        if (dvFile && leaf?.view.file?.path === dvFile.file.path) {
            // Небольшая задержка, чтобы Dataview успел проиндексироваться.
            setTimeout(render, 100);
        }
    };
    app.workspace.on('active-leaf-change', leafChangeListener);

    // Этот обработчик реагирует на внутреннее событие Dataview, которое срабатывает при изменении метаданных любого файла. Это надежный способ отловить изменения в ежедневных заметках и запустить обновление.
    const dataviewUpdateListener = () => {
        // Добавляем проверку, что dv.current() существует.
        const activeFile = app.workspace.getActiveFile();
        const dvFile = dv.current();
        if (activeFile && dvFile && activeFile.path === dvFile.file.path) {
            debouncedRender();
        }
    };
    app.metadataCache.on('dataview:metadata-change', dataviewUpdateListener);

    // Создаем обработчик выгрузки од внутри сработает, когда блок Dataview будет уничтожен (например, при закрытии заметки или переходе в режим редактирования).
    dv.container.onunload = () => {
        // Вызываем функцию очистки, которую нам вернул модуль обработчика событий.
        cleanupUI(); 
        // Явно удаляем слушатели, которые мы добавили в этом файле.
        app.workspace.off('active-leaf-change', leafChangeListener);
        app.metadataCache.off('dataview:metadata-change', dataviewUpdateListener);
    };

    // Выполняем самый первый рендер при загрузке заметки.
    await render();

})();