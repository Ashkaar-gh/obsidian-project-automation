/**
 * Рендер напоминаний: форма добавления, секции просрочено/сегодня/завтра/предстоящие, кнопки редактировать/удалить.
 */
async function renderReminders(dv, container, data, actions, refreshCallback, ui, renderUtils, paths) {
    container.appendChild(createAddForm(ui, actions, refreshCallback, dv));

    if (data.overdue.length === 0 && data.today.length === 0 && data.tomorrow.length === 0 && data.upcoming.length === 0) {
        ui.create('div', { cls: 'rv-empty', text: "Нет активных напоминаний", parent: container });
        return;
    }

    const sections = [
        { title: "Просрочено", items: data.overdue, cls: "rv-overdue", icon: "🔥" },
        { title: "Сегодня", items: data.today, cls: "rv-today", icon: "📅" },
        { title: "Завтра", items: data.tomorrow, cls: "rv-tomorrow", icon: "🌤️" },
        { title: "Предстоящие", items: data.upcoming, cls: "rv-upcoming", icon: "🔭" }
    ];

    sections.forEach(sec => {
        const sectionEl = createSection(sec.title, sec.items, sec.cls, sec.icon, ui, actions, refreshCallback, renderUtils, paths, dv);
        if (sectionEl) container.appendChild(sectionEl);
    });
}

/**
 * Создает форму добавления нового напоминания.
 */
function createAddForm(ui, actions, refreshCallback, dv) {
    const openModalHandler = async () => {
        const text = input.value.trim();
        const result = await ui.openReminderModal(text);
        if (result) {
            const success = await actions.addReminder(result.text, result.date, result.recurrence, "Reminders.md", -1, dv);
            if (success) {
                input.value = '';
                if (typeof window !== 'undefined') window.__remindersFocusAddInput = true;
                if (refreshCallback) refreshCallback();
            }
        }
    };

    const input = ui.input('Добавить напоминание', {
        events: { keydown: (e) => { if (e.key === 'Enter') openModalHandler(); } }
    });
    
    const addBtn = ui.btn('Добавить', openModalHandler);

    return ui.formContainer([input, addBtn]);
}

/**
 * Создает визуальную секцию для группы напоминаний.
 */
function createSection(title, items, className, icon, ui, actions, refreshCallback, renderUtils, paths, dv) {
    if (items.length === 0) return null;

    let isCollapsed = renderUtils ? renderUtils.getGroupState('reminders', title) : false;

    const section = ui.create('div', { cls: `rv-section ${className}` });
    
    const header = ui.create('h3', { 
        style: { cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center' },
        parent: section
    });

    const arrow = ui.create('span', {
        text: isCollapsed ? '▶' : '▼',
        style: { marginRight: '8px', fontSize: '0.8em', width: '12px', display: 'inline-block', textAlign: 'center' },
        parent: header
    });

    ui.create('span', {
        html: `${icon} ${title}`,
        parent: header
    });

    ui.create('span', { 
        cls: 'rv-count', 
        text: `${items.length}`,
        parent: header
    });

    const list = ui.create('div', { 
        cls: 'rv-list', 
        parent: section,
        style: { display: isCollapsed ? 'none' : 'block' }
    });

    header.addEventListener('click', () => {
        isCollapsed = !isCollapsed;
        list.style.display = isCollapsed ? 'none' : 'block';
        arrow.textContent = isCollapsed ? '▶' : '▼';
        
        if (renderUtils) {
            renderUtils.setGroupState('reminders', title, isCollapsed);
        }
    });

    items.forEach(item => {
        const row = ui.create('div', { cls: 'rv-item', parent: list });
        const checkboxLabel = ui.create('label', { cls: 'rv-checkbox-label', parent: row });
        
        const checkbox = ui.checkbox(false, async () => {
            const success = await actions.completeReminder(item.file, item.originalText, item.task.line, dv);
            if (success) {
                new Notice("Напоминание выполнено");
                if (refreshCallback) refreshCallback();
            }
        });
        checkboxLabel.appendChild(checkbox);

        const content = ui.create('div', { cls: 'rv-content', parent: row });
        
        let displayText = item.text;
        if (item.originalText.match(/\(every\s+\d+\s+\w+\)/i)) {
             displayText = "🔁 " + displayText;
        }

        const textDiv = ui.create('div', { cls: 'rv-text', text: displayText, parent: content });
        const fileName = item.file.split('/').pop().replace('.md', ''); 
        
        ui.create('a', {
            cls: 'rv-file-link',
            text: fileName,
            parent: content,
            events: { click: () => app.workspace.openLinkText(item.file, "", false) }
        });

        const actionsContainer = ui.create('div', { cls: 'rv-actions', parent: row });
        
        const editBtn = ui.actionBtn('Изменить', 'edit', async (e) => {
            e.stopPropagation();
            textDiv.style.display = 'none';
            actionsContainer.style.visibility = 'hidden';
            content.classList.add('is-editing');

            const editInput = ui.input("", {
                value: item.originalText,
                style: { width: '100%', marginBottom: '4px' }
            });

            content.insertBefore(editInput, content.children[1]); 
            editInput.focus();

            const save = async () => {
                const newValue = editInput.value.trim();
                if (newValue && newValue !== item.originalText) {
                     await actions.editReminder(item.file, item.originalText, newValue, dv);
                     if (refreshCallback) refreshCallback();
                } else {
                     cancel();
                }
            };

            const cancel = () => {
                editInput.remove();
                textDiv.style.display = '';
                actionsContainer.style.visibility = '';
                content.classList.remove('is-editing');
            };

            editInput.addEventListener('keydown', async (evt) => {
                if (evt.key === 'Enter') {
                    evt.preventDefault();
                    await save();
                }
                if (evt.key === 'Escape') {
                    evt.preventDefault();
                    cancel();
                }
            });

            editInput.addEventListener('blur', async () => {
                if (editInput.parentElement) await save();
            });
        });
        actionsContainer.appendChild(editBtn);

        const delBtn = ui.actionBtn('Удалить', 'delete', async (e) => {
            e.stopPropagation();
            const success = await actions.deleteReminder(item.file, item.originalText, item.task.line, paths.TRASH_FILE, dv);
            if (success && refreshCallback) refreshCallback();
        });
        actionsContainer.appendChild(delBtn);

        const timeDiv = ui.create('div', { cls: 'rv-time', parent: row });
        const timeText = item.displayTime ? `${item.displayTime}` : item.displayDate;
        const timeClass = item.displayTime ? 'rv-badge rv-badge-time' : 'rv-badge rv-badge-date';
        
        ui.create('span', { cls: timeClass, text: timeText, parent: timeDiv });
        ui.create('span', { cls: 'rv-rel-time', text: item.fromNow, parent: timeDiv });
    });

    return section;
}

return { renderReminders };