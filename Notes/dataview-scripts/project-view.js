// Оборачиваем весь скрипт в асинхронную самовызывающуюся функцию (IIFE), что позволяет использовать 'await' на верхнем уровне и изолировать переменные скрипта от глобального пространства имен.
(async () => {
    // Получаем объект 'obsidian' из входных данных, которые Dataview передает в блок dv.view. Этот объект необходим для использования API рендеринга Markdown.
    const { obsidian } = input;

    /**
     * Загружает внешний JavaScript-модуль из файла в хранилище. 
	 * Dataview JS не имеет встроенной системы импорта (как 'require' или 'import'),
     * поэтому мы реализуем свою: читаем файл как текст и выполняем его как функцию.
     * @async
     * @param {string} path - Путь к файлу модуля.
     * @returns {Promise<object|null>} - Промис, который разрешается экспортированным объектом из модуля.
     */
    async function loadModule(path) {
	    // Читаем содержимое файла модуля.
        const moduleContent = await app.vault.adapter.read(path);
        // Создаем новую анонимную функцию из содержимого файла и немедленно ее вызываем. Это позволяет модулю вернуть объект с функциями.
        return new Function(moduleContent)();
    }

    // Параллельно загружаем все три модуля с помощью Promise.all для ускорения инициализации. Деструктурируем результат, чтобы сразу получить объекты с функциями каждого модуля.
    const [fetcher, renderer] = await Promise.all([
	    // Модуль для сбора данных
        loadModule("dataview-scripts/project-view-modules/1-project-data-fetcher.js"),
		// Модуль для отрисовки HTML
        loadModule("dataview-scripts/project-view-modules/2-project-renderer.js")
    ]);

    // Проверяем, что все модули успешно загрузились.
    if (!fetcher || !renderer) {
        dv.paragraph("Не удалось загрузить модули для project-view.");
        return;
    }

    /**
     * Основная функция отрисовки. Полностью перестраивает содержимое блока Dataview, получая свежие данные,
     * вызывая модули для отрисовки HTML и заменяя старое содержимое новым, сохраняя при этом позицию прокрутки.
     * @async
     */
    async function render() {
        // Сохраняем текущую позицию прокрутки, чтобы восстановить ее после обновления и избежать "прыжка" страницы.
        const scrollableParent = dv.container.closest('.markdown-reading-view .cm-scroller');
        const scrollTop = scrollableParent ? scrollableParent.scrollTop : 0;

        // Создаем временный DOM-элемент, в котором вся отрисовка происходит "за кадром", чтобы предотвратить мерцание старого контента во время загрузки нового.
        const tempContainer = document.createElement('div');
        // Вызываем функцию из модуля-отрисовщика, чтобы немедленно показать пользователю сообщение о процессе обновления.
        renderer.renderLoading(tempContainer);
        dv.container.innerHTML = tempContainer.innerHTML;

        // Делаем небольшую паузу, чтобы дать Dataview время проиндексировать последние изменения в файлах, что особенно важно для только что измененных задач.
        await new Promise(resolve => setTimeout(resolve, 100));

        // Вызываем модуль-сборщик для получения актуальных данных по проекту.
        const projectData = await fetcher.fetchData(dv, app);

        // Полностью очищаем контейнер от сообщения о загрузке перед финальной отрисовкой.
        dv.container.innerHTML = '';
        // Вызываем модуль-отрисовщик, чтобы он построил финальную HTML-таблицу с полученными данными.
        renderer.renderTable(dv, dv.container, projectData);

        // Восстанавливаем позицию прокрутки, если она была сохранена.
        if (scrollableParent) {
            setTimeout(() => { scrollableParent.scrollTop = scrollTop; }, 50);
        }
    }

    /**
     * Создает "обезвреженную" версию функции, которая будет вызвана только один раз через указанный промежуток времени после последнего события.
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

    // Создаем "обезвреженную" версию нашей функции рендеринга. Это "предохранитель", который не дает запускать тяжелую операцию перерисовки на каждое мелкое изменение в хранилище.
    const debouncedRender = debounce(render, 500);
    // Создаем уникальный ключ для нашего набора слушателей, используя путь к текущему файлу, чтобы предотвратить многократную регистрацию одних и тех же слушателей, если скрипт по какой-то причине перезапустится.
    const listenerKey = `project-view-refresher-${dv.current().file.path}`;

    // Регистрируем слушатели только один раз для этого блока кода, проверяя наличие нашего ключа в глобальном объекте window.
    if (!window[listenerKey]) {
        // Этот обработчик будет реагировать на любые изменения в хранилище (изменение, создание, удаление, переименование файлов), что является самым надежным способом отловить изменения на Kanban-досках или в ежедневных заметках.
        const vaultEventHandler = (file) => {
            // Запускаем обновление только если активная вкладка - это наша заметка-проект.
            if (app.workspace.getActiveFile()?.path === dv.current().file.path) {
                debouncedRender();
            }
        };

        // Этот обработчик срабатывает, когда пользователь переключается на вкладку с проектом
        const leafChangeHandler = (leaf) => {
            // Добавляем проверку на существование leaf.view.file и dv.current().file.path для надежности
            if (leaf?.view.file?.path === dv.current()?.file.path) {
                // Добавляем задержку в 100 мс, что даст Dataview время проиндексировать изменения, сделанные в других заметках
                setTimeout(() => render(), 100);
            }
        };

        // "Подписываемся" на все релевантные события в Obsidian, которые будут служить "ушами" нашего скрипта.
        app.vault.on('modify', vaultEventHandler);
        app.vault.on('create', vaultEventHandler);
        app.vault.on('delete', vaultEventHandler);
        app.vault.on('rename', vaultEventHandler);
        app.workspace.on('active-leaf-change', leafChangeHandler);

        // "Запоминаем", что мы зарегистрировали слушателей, чтобы потом их можно было корректно удалить при выгрузке.
        window[listenerKey] = {
            vaultHandler: vaultEventHandler,
            leafHandler: leafChangeHandler
        };

        // Регистрируем обработчик выгрузки. Это КРИТИЧЕСКИ ВАЖНО для очистки и предотвращения утечек памяти, так как он сработает, когда вы закроете заметку или перейдете в режим редактирования.
        dv.container.onunload = () => {
            if (window[listenerKey]) {
                const { vaultHandler, leafHandler } = window[listenerKey];
                // Отписываемся от всех событий, чтобы избежать "зомби"-слушателей, которые могут замедлить работу приложения.
                app.vault.off('modify', vaultHandler);
                app.vault.off('create', vaultHandler);
                app.vault.off('delete', vaultHandler);
                app.vault.off('rename', vaultHandler);
                app.workspace.off('active-leaf-change', leafHandler);
                // Удаляем наш флаг, чтобы при следующем открытии заметки слушатели снова корректно зарегистрировались.
                delete window[listenerKey];
            }
        };
    }

    // Выполняем самый первый рендер при загрузке заметки.
    await render();


})();
