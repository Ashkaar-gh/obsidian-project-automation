/**
 * Создает кликабельный заголовок (<summary>) для сворачиваемого блока (<details>).
 * @async
 * @param {object} dv - Объект API Dataview, переданный из основного скрипта.
 * @param {object} obsidian - Глобальный объект Obsidian API, переданный из dv.view.
 * @param {HTMLElement} detailsElement - Родительский HTML-элемент <details>, в который будет добавлен заголовок.
 * @param {string} titleContent - Содержимое заголовка в виде строки (может быть HTML или Markdown).
 * @param {boolean} [isMarkdown=false] - Флаг, указывающий, нужно ли рендерить titleContent как Markdown.
 * @returns {Promise<void>} - Промис, который разрешается после завершения отрисовки.
 */
async function createCollapsibleHeader(dv, obsidian, detailsElement, titleContent, isMarkdown = false) {
    // <summary> — это видимая часть блока <details>, по которой можно кликнуть.
    const summary = detailsElement.createEl('summary', { cls: 'task-view-summary' });
    const titleContainer = summary.createDiv();

    // Если заголовок содержит Markdown (например, ссылку [[...]]), его нужно отрендерить через API Obsidian.
    if (isMarkdown) {
        await obsidian.MarkdownRenderer.render(app, titleContent, titleContainer, dv.current().file.path, new obsidian.Component());
        // Удаляем стандартный отступ у параграфа, который создается рендерером, для чистоты вида.
        const renderedP = titleContainer.querySelector('p');
        if (renderedP) renderedP.style.margin = '0';
    } else {
        // Если это простой HTML, просто вставляем его.
        titleContainer.innerHTML = titleContent;
    }

    // Создаем кнопку для сворачивания/разворачивания.
    const button = summary.createEl('button', { cls: 'task-view-collapse-button' });
    // Устанавливаем иконку в зависимости от того, открыт или закрыт блок.
    button.textContent = detailsElement.hasAttribute('open') ? '▼' : '◀';
}

/**
 * Отрисовывает блок "Оглавление" в виде сворачиваемого callout-блока.
 * @async
 * @param {object} dv - Объект API Dataview.
 * @param {object} obsidian - Глобальный объект Obsidian API.
 * @param {HTMLElement} container - Родительский HTML-элемент, в котором будет создано оглавление.
 * @param {Array<object>} tocEntries - "Плоский" массив объектов подзаголовков, полученный от сборщика данных.
 * @returns {Promise<void>} - Промис, который разрешается после завершения отрисовки.
 */
async function renderToc(dv, obsidian, container, tocEntries) {
    // Если подзаголовков нет, то и оглавление не нужно.
    if (tocEntries.length === 0) return;
    // Создаем сворачиваемый блок <details>, стилизованный как callout.
    const details = container.createEl('details', { cls: 'callout', attr: { 'data-callout': 'toc', open: '' } });
    // Получаем HTML-код иконки "карандаш" из Obsidian.
    const iconEl = obsidian.getIcon('pencil').outerHTML;
    // Используем нашу вспомогательную функцию для создания заголовка "Оглавление".
    await createCollapsibleHeader(dv, obsidian, details, `<div class="callout-title"><div class="callout-icon">${iconEl}</div><div class="callout-title-inner">Оглавление</div></div>`);
    const content = details.createDiv({ cls: 'callout-content' });
    const tocList = content.createEl('ul', { cls: 'task-toc-list' });
    // Проходим по каждому подзаголовку и создаем для него элемент списка.
    tocEntries.forEach(entry => {
        const li = tocList.createEl('li');
        // Создаем отступ слева, чтобы имитировать вложенность заголовков.
        li.style.marginLeft = `${(entry.level - 1) * 1.5}em`;
        // Создаем ссылку с текстом заголовка и датой.
        const link = li.createEl('a', { text: `${entry.text} (${entry.dateText})` });
        // Добавляем data-атрибут с ID блока, к которому нужно прокрутить страницу. Этот атрибут будет использован обработчиком событий.
        link.dataset.scrollToId = entry.id;
    });
}

/**
 * Отрисовывает основной контент: список сворачиваемых блоков для каждой записи из ежедневных заметок.
 * @async
 * @param {object} dv - Объект API Dataview.
 * @param {object} obsidian - Глобальный объект Obsidian API.
 * @param {HTMLElement} container - Родительский HTML-элемент, в котором будет создан контент.
 * @param {Array<object>} structuredData - Основной массив объектов с данными, полученный от сборщика.
 * @returns {Promise<void>} - Промис, который разрешается после завершения отрисовки.
 */
async function renderContent(dv, obsidian, container, structuredData) {
    // Проходим по каждой записи (блоку контента) из собранных данных.
    for (const [index, entry] of structuredData.entries()) {
        // Каждая запись — это отдельный сворачиваемый блок <details>.
        const detailsContainer = container.createEl('details', { cls: 'task-view-entry', attr: { open: '' } });
        // Присваиваем блоку ID, на который ссылаются ссылки из оглавления.
        detailsContainer.id = entry.id;
        // Сохраняем индекс элемента в data-атрибуте. Это нужно обработчику событий, чтобы знать, какой элемент данных обновлять при сохранении.
        detailsContainer.dataset.entryIndex = index;
        // Создаем заголовок блока с помощью нашей вспомогательной функции, передавая Markdown-ссылку на дату.
        await createCollapsibleHeader(dv, obsidian, detailsContainer, `**${entry.dateLink}**`, true);
        // Создаем div для отображения отрендеренного контента.
        const displayDiv = detailsContainer.createEl('div', { cls: 'task-view-display' });
        // Создаем скрытое по умолчанию поле <textarea> для редактирования.
        detailsContainer.createEl('textarea', { cls: 'task-view-edit', text: entry.content });
        // Отрисовываем Markdown-содержимое в div для отображения.
        await obsidian.MarkdownRenderer.render(app, entry.content || " ", displayDiv, entry.sourcePath, new obsidian.Component());
        // Находим все заголовки (h1, h2 и т.д.) внутри только что отрендеренного HTML.
        const renderedHeadings = displayDiv.querySelectorAll('h1, h2, h3, h4, h5, h6');
        // Присваиваем этим заголовкам ID, которые мы сгенерировали в сборщике данных. Это позволяет оглавлению ссылаться не только на блок целиком, но и на конкретный подзаголовок внутри него.
        renderedHeadings.forEach((hEl, idx) => {
            if (entry.subHeadings[idx]) hEl.id = entry.subHeadings[idx].id;
        });
    }
}

// "Экспортируем" основные функции отрисовки, чтобы их можно было вызвать в главном скрипте task-view.js.
return { renderToc, renderContent };