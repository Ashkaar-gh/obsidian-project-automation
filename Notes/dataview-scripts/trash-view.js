// Оборачиваем весь скрипт в асинхронную самовызывающуюся функцию (IIFE), чтобы изолировать переменные и использовать await.
(async () => {

    /**
     * Основная функция отрисовки. Считывает и отображает содержимое файла 'Trash.md'
     * в виде стилизованного списка в блоке Dataview.
     * @async
     */
    async function render() {
        // Определяем путь к файлу Trash.md.
        const trashFilePath = 'Trash.md';
        const trashFile = app.vault.getAbstractFileByPath(trashFilePath);

        // Очищаем контейнер перед каждой перерисовкой, чтобы избежать дублирования контента.
        dv.container.innerHTML = '';

        if (!trashFile) {
            new Notice(`Файл "${trashFilePath}" не найден.`);
            dv.paragraph(`Ошибка: Файл "${trashFilePath}" не найден.`);
            return;
        }

        // Асинхронно читаем содержимое файла из кэша.
        const content = await app.vault.cachedRead(trashFile);
        // Разделяем содержимое на строки и фильтруем пустые строки.
        const lines = content.split('\n').filter(line => line.trim().length > 0);

        // Проверяем, есть ли строки для отображения.
        if (lines.length === 0) {
            // Если файл пустой, создаем элемент с сообщением "Пусто".
            const emptyMessage = document.createElement('div');
            emptyMessage.textContent = 'Пусто';
            emptyMessage.style.fontStyle = 'italic';
            dv.container.appendChild(emptyMessage);
        } else {
            // Если есть строки, перебираем каждую.
            lines.forEach((line) => {
                // Создаем новый элемент для строки.
                const lineElement = document.createElement('div');
                lineElement.textContent = line.trim();
                // Добавляем стили для визуального оформления.
                lineElement.style.padding = '5px 0';
                lineElement.style.borderBottom = '1px solid var(--background-modifier-border)';
                dv.container.appendChild(lineElement);
            });
        }
    }

    /**
     * Создает "обезвреженную" версию функции для предотвращения слишком частых вызовов.
     * @param {Function} func - Функция, вызов которой нужно отложить.
     * @param {number} delay - Задержка в миллисекундах.
     * @returns {Function} - Обернутая функция.
     */
    function debounce(func, delay) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), delay);
        };
    }

    // Создаем "обезвреженную" версию нашей функции рендеринга.
    const debouncedRender = debounce(render, 300);

    // Этот обработчик будет реагировать на изменение любого файла в хранилище.
    const trashFileModifyHandler = (file) => {
        // Запускаем обновление, ТОЛЬКО если измененный файл - это наш Trash.md.
        // Это ключевая проверка для эффективности, чтобы не перерисовывать корзину при изменении других заметок.
        if (file.path === 'Trash.md') {
            debouncedRender();
        }
    };

    // "Подписываемся" на событие изменения файла в Obsidian.
    app.vault.on('modify', trashFileModifyHandler);

    // Регистрируем обработчик выгрузки. Это КРИТИЧЕСКИ ВАЖНО для очистки и предотвращения утечек памяти.
    // Он сработает, когда вы закроете заметку GTD или перейдете в режим редактирования.
    dv.container.onunload = () => {
        // Отписываемся от события, чтобы избежать "зомби"-слушателей.
        app.vault.off('modify', trashFileModifyHandler);
    };

    // Выполняем самый первый рендер при загрузке заметки.
    await render();

})();