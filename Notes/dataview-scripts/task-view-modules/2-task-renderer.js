/**
 * Рендер task-view: оглавление (renderToc), контент секций (renderContent), сворачиваемые details, кнопка копирования в code block.
 */
/** summary + заголовок (markdown или html) + кнопка свёртки. */
async function createCollapsibleHeader(dv, obsidian, detailsElement, titleContent, isMarkdown = false, ui) {
    const summary = ui.create('summary', { cls: 'task-view-summary', parent: detailsElement });
    const titleContainer = ui.create('div', { parent: summary });

    if (isMarkdown) {
        await obsidian.MarkdownRenderer.render(app, titleContent, titleContainer, dv.current().file.path, new obsidian.Component());
    } else {
        titleContainer.innerHTML = titleContent;
    }

    ui.create('button', {
        cls: 'task-view-collapse-button',
        text: detailsElement.hasAttribute('open') ? '▼' : '◀',
        parent: summary
    });
}

/** Добавить кнопку копирования в pre, если её ещё нет. */
function injectCopyButton(obsidian, preElement, ui) {
    if (preElement.querySelector('.task-view-copy-btn')) return;
    const copyIcon = obsidian.getIcon('copy');
    ui.create('button', {
        cls: 'task-view-copy-btn',
        attr: { 'aria-label': 'Copy code' },
        html: copyIcon ? copyIcon.outerHTML : '&#128203;',
        parent: preElement
    });
}

/** Оглавление: callout с списком ссылок data-scroll-to-id. */
async function renderToc(dv, obsidian, container, tocEntries, ui) {
    if (!tocEntries || tocEntries.length === 0) return;

    const details = ui.create('details', {
        cls: 'callout',
        attr: { 'data-callout': 'toc', open: '' },
        parent: container
    });

    const iconEl = obsidian.getIcon('pencil').outerHTML;

    await createCollapsibleHeader(
        dv, 
        obsidian, 
        details, 
        `<div class="callout-title"><div class="callout-icon">${iconEl}</div><div class="callout-title-inner">Оглавление</div></div>`,
        false,
        ui
    );

    const content = ui.create('div', { cls: 'callout-content', parent: details });
    const tocList = ui.create('ul', { cls: 'task-toc-list', parent: content });

    tocEntries.forEach(entry => {
        const li = ui.create('li', {
            style: { marginLeft: `${(entry.level - 1) * 1.5}em` },
            parent: tocList
        });

        const linkAttrs = {};
        if (entry.id) linkAttrs['data-scroll-to-id'] = entry.id;

        ui.create('a', {
            text: entry.isDateOnly ? entry.text : `${entry.text} (${entry.dateText})`,
            attr: linkAttrs,
            parent: li
        });
    });
}

/**
 * Основная функция рендера контента.
 * 
 * @param {Object} dv - API Dataview.
 * @param {Object} obsidian - API Obsidian.
 * @param {HTMLElement} container - Контейнер.
 * @param {Array} structuredData - Данные.
 * @param {Object} ui - Модуль UI.
 */
async function renderContent(dv, obsidian, container, structuredData, ui) {
    const component = new obsidian.Component();

    for (const [index, entry] of structuredData.entries()) {
        const detailsContainer = ui.create('details', {
            cls: 'task-view-entry',
            attr: { 
                open: '', 
                'data-entry-index': index 
            },
            parent: container
        });
        detailsContainer.id = entry.id;

        await createCollapsibleHeader(dv, obsidian, detailsContainer, `**${entry.dateLink}**`, true, ui);

        const previewWrap = ui.create('div', { cls: 'markdown-preview-view', parent: detailsContainer });
        const renderedDiv = ui.create('div', { cls: 'markdown-rendered', parent: previewWrap });
        const displayDiv = ui.create('div', { cls: 'task-view-display', parent: renderedDiv });

        ui.create('textarea', {
            cls: 'task-view-edit', 
            text: entry.content, 
            parent: detailsContainer
        });

        await obsidian.MarkdownRenderer.render(app, entry.content || "", displayDiv, entry.sourcePath, component);
        displayDiv.querySelectorAll('pre').forEach(pre => injectCopyButton(obsidian, pre, ui));

        if (entry.subHeadings && entry.subHeadings.length > 0) {
            const allHeadings = Array.from(displayDiv.querySelectorAll('h1, h2, h3, h4, h5, h6'));
            const renderedHeadings = allHeadings.filter(h => !h.closest('.internal-embed'));

            renderedHeadings.forEach(hEl => {
                const hText = hEl.textContent.trim();
                const matchingSubHeading = entry.subHeadings.find(subH => subH.text === hText);
                if (matchingSubHeading) {
                    hEl.setAttribute('id', matchingSubHeading.id);
                }
            });
        }
    }
}

return { renderToc, renderContent };