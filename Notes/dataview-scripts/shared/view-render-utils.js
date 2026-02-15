/**
 * Общие компоненты для табличных view: renderLoading, getGroupState/setGroupState, createTableSkeleton, createTocButton, createTaskRow, fillSummaryByStatus, createTotalSummarySection.
 */
/** Иконки статусов и счётчики в targetContainer. */
function fillSummaryByStatus(config, tasks, targetContainer, ui) {
    const counts = {};
    tasks.forEach(t => {
        const s = (t.sortStatus || "").toLowerCase();
        const conf = config.STATUS_CONFIG.find(c => s.includes(c.key));
        const key = conf ? conf.key : s;
        counts[key] = (counts[key] || 0) + 1;
    });
    const displayedIcons = new Set();
    config.STATUS_CONFIG.forEach(conf => {
        if (counts[conf.key] && !displayedIcons.has(conf.icon)) {
            ui.create('span', { cls: 'pv-summary-item', text: `${conf.icon} ${counts[conf.key]}`, parent: targetContainer });
            displayedIcons.add(conf.icon);
        }
    });
}

/** Блок «Всего задач» со сводкой по статусам. */
function createTotalSummarySection(allTasks, config, ui) {
    const totalSummaryContainer = ui.create('div', {
        cls: 'pv-group-header-container',
        style: { marginBottom: '5px', padding: '4px 0', borderBottom: '1px solid var(--background-modifier-border)' }
    });
    const totalTitleDiv = ui.create('div', { cls: 'pv-group-title', parent: totalSummaryContainer });
    ui.create('span', { cls: 'pv-group-title-text', text: 'Всего задач', parent: totalTitleDiv, style: { marginLeft: '0' } });
    ui.create('span', { cls: 'pv-group-count', html: `&nbsp;(${allTasks.length})`, parent: totalTitleDiv });
    const totalStatsDiv = ui.create('div', { cls: 'pv-group-summary', parent: totalSummaryContainer });
    fillSummaryByStatus(config, allTasks, totalStatsDiv, ui);
    return totalSummaryContainer;
}

/** Текст «...» в контейнер. */
function renderLoading(container) {
    const p = document.createElement('p');
    p.textContent = '...';
    p.classList.add('pv-loading');
    container.appendChild(p);
}

/** Состояние свёрнутости группы в localStorage. */
function getGroupState(prefix, groupName) {
    return localStorage.getItem(`${prefix}-group-collapsed-${groupName}`) === 'true';
}

/** Сохранить состояние свёрнутости группы. */
function setGroupState(prefix, groupName, isCollapsed) {
    localStorage.setItem(`${prefix}-group-collapsed-${groupName}`, isCollapsed);
}

/** Таблица с заголовками: Задача, Контекст, Окружение, Статус, Срок. */
function createTableSkeleton(ui) {
    const columns = [
        { text: "Задача", class: "pv-col-auto" },
        { text: "Контекст", class: "pv-col-shrink" },
        { text: "Окружение", class: "pv-col-shrink" },
        { text: "Статус", class: "pv-col-fixed-status" },
        { text: "Срок", class: "pv-col-fixed-date" }
    ];

    const headerRow = ui.create('tr', {
        children: columns.map(col => {
            const classes = [col.class];
            if (col.text !== "Задача") classes.push('pv-col-shrink');
            else classes.push('pv-col-auto');
            return ui.create('th', { text: col.text, cls: classes });
        })
    });

    const thead = ui.create('thead', { children: [headerRow] });
    return ui.create('table', {
        cls: ['dataview', 'table-view-table', 'pv-table'],
        children: [thead]
    });
}

/** Кнопка оглавления: клик вызывает onClick(targetElement). */
function createTocButton(name, count, targetElement, icon, onClick, ui) {
    return ui.create('div', {
        cls: 'pv-toc-btn',
        html: `${icon} ${name} <span class="pv-toc-count">&nbsp;(${count})</span>`,
        events: {
            click: (e) => {
                e.preventDefault();
                e.stopPropagation();
                onClick(targetElement);
            }
        }
    });
}

/** Строка задачи: ссылка, контекст, окружение, селект статуса, срок. */
function createTaskRow(task, app, config, io, ui) {
    let nameContent;
    if (task.note && task.note.path) {
        nameContent = ui.create('a', {
            cls: 'pv-link',
            text: task.note.display || task.note.path.replace(/\.md$/, ''),
            events: {
                click: (e) => {
                    e.preventDefault();
                    app.workspace.openLinkText(task.note.path, "", false);
                }
            }
        });
    } else {
        nameContent = task.note;
    }

    const cellName = ui.create('td', {
        cls: ['pv-task-cell', 'pv-task-cell-main', 'pv-indent'],
        children: [nameContent]
    });

    const cellContext = ui.create('td', { cls: 'pv-task-cell', text: task.context || "-" });
    const cellEnv = ui.create('td', { cls: 'pv-task-cell', text: task.environment || "-" });

    const currentStatus = (task.status || "В работе").toLowerCase();

    const options = config.getDropdownOptions().map(opt => {
        return ui.create('option', { value: opt.value, text: opt.label });
    });

    const select = ui.create('select', {
        cls: 'pv-status-select',
        children: options,
        events: {
            click: (e) => e.stopPropagation(),
            change: async (e) => {
                const newStatus = e.target.value;
                if (io) await io.updateFrontmatter(app, task.path, 'status', newStatus);
            }
        }
    });

    Array.from(select.options).forEach(opt => {
        if (currentStatus.includes(opt.value.toLowerCase())) opt.selected = true;
    });

    const cellStatus = ui.create('td', { cls: 'pv-task-cell', children: [select] });
    const cellTime = ui.create('td', { cls: 'pv-task-cell', text: task.executionTime });

    return ui.create('tr', {
        cls: 'pv-task-row',
        children: [cellName, cellContext, cellEnv, cellStatus, cellTime]
    });
}

return {
    renderLoading,
    getGroupState,
    setGroupState,
    createTableSkeleton,
    createTocButton,
    createTaskRow,
    fillSummaryByStatus,
    createTotalSummarySection
};
