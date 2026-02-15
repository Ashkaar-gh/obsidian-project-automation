/**
 * Рендер таблицы GTD: группы по статусу, оглавление, строки задач со сменой статуса.
 */
function renderTable(dv, container, groupedData, scrollModule, config, io, renderUtils, ui) {
    if (!groupedData || groupedData.size === 0) {
        ui.create('p', { text: "Нет активных задач.", cls: 'pv-empty-message', parent: container });
        return;
    }

    const groupsArray = Array.from(groupedData).sort((a, b) => {
        const wA = config.getWeight(a[0]);
        const wB = config.getWeight(b[0]);
        if (wA !== wB) return wA - wB;
        return a[0].localeCompare(b[0]);
    });

    const tocContainer = ui.create('div', { cls: 'pv-toc-container' });
    const table = renderUtils.createTableSkeleton(ui);
    const allTasks = Array.from(groupedData.values()).flat();
    const totalSummaryContainer = renderUtils.createTotalSummarySection(allTasks, config, ui);

    groupsArray.forEach(([groupName, tasks]) => {
        const collapsed = renderUtils.getGroupState('gtd', groupName);
        
        const tbody = ui.create('tbody', {
            cls: collapsed ? 'pv-collapsed' : undefined
        });

        const displayIcon = config.getIcon(groupName);
        
        const headerContainer = ui.create('div', { cls: 'pv-group-header-container' });

        const titleDiv = ui.create('div', { cls: 'pv-group-title', parent: headerContainer });
        
        ui.create('span', { 
            cls: 'pv-collapse-arrow', 
            text: '▼', 
            parent: titleDiv 
        });
        
        ui.create('span', { 
            cls: 'pv-group-title-text', 
            text: `${displayIcon} ${groupName}`, 
            parent: titleDiv 
        });
        
        ui.create('span', { 
            cls: 'pv-group-count', 
            html: `&nbsp;(${tasks.length})`,
            parent: titleDiv 
        });

        const groupCell = ui.create('td', {
            attr: { colSpan: 5 },
            cls: 'pv-group-cell',
            children: [headerContainer],
            events: {
                click: () => {
                    tbody.classList.toggle('pv-collapsed');
                    renderUtils.setGroupState('gtd', groupName, tbody.classList.contains('pv-collapsed'));
                }
            }
        });

        const groupRow = ui.create('tr', {
            cls: 'pv-group-row',
            children: [groupCell]
        });

        tbody.appendChild(groupRow);

        const tocBtn = renderUtils.createTocButton(groupName, tasks.length, groupRow, displayIcon, (target) => {
            if (scrollModule) {
                scrollModule.scrollToElement(target, {
                    behavior: 'smooth',
                    onBeforeScroll: () => {
                        const tb = target.closest('tbody');
                        if (tb?.classList.contains('pv-collapsed')) {
                            tb.classList.remove('pv-collapsed');
                            renderUtils.setGroupState('gtd', groupName, false);
                        }
                    }
                });
            }
        }, ui);
        tocContainer.appendChild(tocBtn);

        tasks.forEach(task => {
            const row = renderUtils.createTaskRow(task, app, config, io, ui);
            tbody.appendChild(row);
        });

        table.appendChild(tbody);
    });

    container.appendChild(tocContainer);
    container.appendChild(totalSummaryContainer);
    container.appendChild(table);
}

return { renderTable };