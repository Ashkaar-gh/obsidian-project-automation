/**
 * Инициализирует всю интерактивность для представления задачи.
 * Эта функция прикрепляет все необходимые глобальные и локальные слушатели событий
 * и возвращает функцию для их последующей очистки, чтобы избежать утечек памяти.
 * @param {object} dv - Объект API Dataview.
 * @param {object} obsidian - Глобальный объект Obsidian API.
 * @param {object} app - Глобальный объект Obsidian App.
 * @param {HTMLElement} container - Корневой HTML-элемент блока Dataview, в котором работает скрипт.
 * @param {object} context - Объект общего состояния, содержащий данные и ссылку на активное поле редактирования.
 * @param {Function} render - Функция для полного перерендеринга представления, вызывается после сохранения.
 * @returns {Function} - Функция `cleanup`, вызов которой удаляет все добавленные слушатели событий.
 */
function initialize(dv, obsidian, app, container, context, render) {
    
    /**
     * Сохраняет измененный контент из <textarea> обратно в исходный файл ежедневной заметки.
     * Также управляет переключением UI из режима редактирования в режим отображения.
     * @async
     * @param {HTMLTextAreaElement} textarea - Элемент <textarea>, содержимое которого нужно сохранить.
     * @returns {Promise<void>} - Промис, который разрешается после завершения операции сохранения.
     */
    async function handleSave(textarea) {
        if (!textarea) return;
        const parentDetails = textarea.closest('details');
        if (!parentDetails) return;
        // Получаем индекс записи из data-атрибута, чтобы найти нужный объект в массиве данных.
        const entryIndex = parentDetails.dataset.entryIndex;
        const entry = context.structuredData[entryIndex];
        const newContent = textarea.value;
        // Сбрасываем ссылку на активное поле редактирования.
        context.activeEditArea = null;
        // Скрываем поле редактирования и снова показываем блок отображения.
        textarea.style.display = 'none';
        textarea.previousElementSibling.style.display = 'block';
        // Если контент не изменился, ничего не делаем, чтобы не перезаписывать файл без надобности.
        if (newContent.trim() === entry.content.trim()) { return; }
        const file = app.vault.getAbstractFileByPath(entry.sourcePath);
        if (!file) return;
        // Читаем оригинальный файл и "собираем" его заново с измененным контентом.
        const originalFileContent = await app.vault.read(file);
        const prefix = originalFileContent.substring(0, entry.contentStartOffset);
        const suffix = originalFileContent.substring(entry.contentEndOffset);
        // Сохраняем новый контент в отдельную переменную для возможной модификации.
        let finalContent = newContent;
        
        // Проверяем два условия: есть ли какой-то текст после нашей секции (т.е. это не конец файла) и не заканчивается ли наш новый текст уже на перенос строки.
        if (suffix.length > 0 && !finalContent.endsWith('\n')) {
            // Если оба условия верны, добавляем два переноса строки.
            finalContent += '\n\n';
        } else if (suffix.length > 0 && !finalContent.endsWith('\n\n') && finalContent.endsWith('\n')) {
            // Если есть только один перенос строки, добавляем второй для лучшего форматирования.
            finalContent += '\n';
        }
        
        // Собираем файл с уже гарантированно отформатированным контентом.
        await app.vault.modify(file, prefix + finalContent + suffix);
    }

    // Единый обработчик для всех кликов и правых кликов ВНУТРИ контейнера Dataview.
    const containerInteractionHandler = (event) => {
        // Игнорируем события, произошедшие вне нашего контейнера.
        if (!container.contains(event.target)) return;
        // Обработка левого клика.
        if (event.type === 'click') {
            // Ищем клик по заголовку сворачиваемого блока.
            const summary = event.target.closest('.task-view-summary');
            if (summary) {
                event.preventDefault();
                // Если клик был именно по кнопке, вручную переключаем состояние блока.
                const button = event.target.closest('.task-view-collapse-button');
                if (button) {
                    const details = summary.closest('details');
                    if (details) {
                        details.toggleAttribute('open');
                        button.textContent = details.hasAttribute('open') ? '▼' : '◀';
                    }
                }
                return;
            }
            // Ищем клик по ссылке в оглавлении.
            const tocLink = event.target.closest('a[data-scroll-to-id]');
            if (tocLink) {
                event.preventDefault();
                const elementToScroll = document.getElementById(tocLink.dataset.scrollToId);
                if (elementToScroll) {
                    const parentDetails = elementToScroll.closest('details');
                    if (!parentDetails) return;
                    // Функция для выполнения прокрутки.
                    const performScroll = () => { elementToScroll.scrollIntoView({ behavior: 'auto', block: 'start' }); };
                    // Если блок уже открыт, просто скроллим. Иначе - сначала открываем, потом скроллим.
                    if (parentDetails.hasAttribute('open')) { performScroll(); } 
                    else { parentDetails.setAttribute('open', ''); requestAnimationFrame(() => setTimeout(performScroll, 0)); }
                }
                return;
            }
        }
        // Обработка правого клика для перехода в режим редактирования.
        if (event.type === 'contextmenu') {
            const displayDiv = event.target.closest('.task-view-display');
            if (displayDiv) {
                event.preventDefault();
                // Если уже есть активное поле редактирования, сначала сохраняем его.
                if (context.activeEditArea) handleSave(context.activeEditArea);
                const editArea = displayDiv.nextElementSibling;
                displayDiv.style.display = 'none';
                editArea.style.display = 'block';
                // Автоматически подстраиваем высоту поля под содержимое.
                editArea.style.height = 'auto';
                editArea.style.height = (editArea.scrollHeight) + 'px';
                editArea.focus();
                // Сохраняем ссылку на активное поле в общем контексте.
                context.activeEditArea = editArea;
            }
        }
    };

    // Глобальный обработчик для выхода из режима редактирования (клик вне поля или нажатие Escape).
    const globalExitHandler = (event) => {
        if (!context.activeEditArea) return;
        const isEscape = event.type === 'keydown' && event.key === 'Escape';
        const isClickOutside = event.type === 'mousedown' && !context.activeEditArea.contains(event.target);
        if (isEscape || isClickOutside) {
            event.preventDefault();
            event.stopPropagation();
            handleSave(context.activeEditArea);
        }
    };

    // Функция, которая удаляет всех наших слушателей. Она будет возвращена из `initialize`.
    const cleanup = () => {
        document.removeEventListener('click', containerInteractionHandler, true);
        document.removeEventListener('contextmenu', containerInteractionHandler, true);
        document.removeEventListener('mousedown', globalExitHandler, true);
        document.removeEventListener('keydown', globalExitHandler, true);
    };

    // Прикрепляем слушатели к документу. Использование `true` (capturing phase) помогает перехватывать события надежнее.
    document.addEventListener('click', containerInteractionHandler, true);
    document.addEventListener('contextmenu', containerInteractionHandler, true);
    document.addEventListener('mousedown', globalExitHandler, true);
    document.addEventListener('keydown', globalExitHandler, true);
    
    // Возвращаем функцию очистки, чтобы главный скрипт мог вызвать ее при выгрузке.
    return cleanup;
}

// "Экспортируем" основную функцию инициализации.
return { initialize };