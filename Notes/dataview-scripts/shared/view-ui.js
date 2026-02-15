/**
 * Фабрика DOM: create(tag, options), пресеты btn/input/dropdown/checkbox, modal, openReminderModal.
 * options: cls, attr, style, text, html, children, events, parent, value, type, placeholder.
 */
function create(tag, options = {}) {
    const el = document.createElement(tag);
    const { cls, attr, style, text, html, children, events, parent, value, type, placeholder } = options;

    if (cls) {
        if (Array.isArray(cls)) el.classList.add(...cls);
        else el.className = cls;
    }
    if (attr) {
        for (const [key, val] of Object.entries(attr)) el.setAttribute(key, val);
    }
    if (style) {
        for (const [key, val] of Object.entries(style)) el.style[key] = val;
    }
    if (text !== undefined) el.textContent = text;
    if (html !== undefined) el.innerHTML = html;
    if (value !== undefined) el.value = value;
    if (type !== undefined) el.type = type;
    if (placeholder !== undefined) el.placeholder = placeholder;
    if (children) {
        children.forEach(child => {
            if (child instanceof Node) el.appendChild(child);
            else if (child !== null && child !== undefined) el.appendChild(document.createTextNode(String(child)));
        });
    }
    if (events) {
        for (const [name, handler] of Object.entries(events)) el.addEventListener(name, handler);
    }
    if (parent) parent.appendChild(el);
    return el;
}

function formContainer(children = []) {
    return create('div', { cls: 'view-add-form', children });
}

function btn(text, onClick, options = {}) {
    return create('button', { cls: 'view-btn', text, events: { click: onClick }, ...options });
}

function actionBtn(text, actionName, onClick) {
    return create('button', { cls: 'inbox-action-btn', text, attr: { 'data-action': actionName }, events: onClick ? { click: onClick } : undefined });
}

function input(placeholder, options = {}) {
    return create('input', { type: 'text', cls: 'view-input', placeholder, ...options });
}

function dateInput(initialValue, options = {}) {
    return create('input', { type: 'datetime-local', cls: 'view-date-input', value: initialValue, ...options });
}

function dropdown(optionsList, options = {}) {
    const optionElements = optionsList.map(opt => create('option', { value: opt.value, text: opt.label }));
    return create('select', { cls: 'view-input', children: optionElements, ...options });
}

function checkbox(checked, onChange) {
    const box = create('input', { type: 'checkbox', cls: 'rv-checkbox', events: { click: (e) => { e.stopPropagation(); if (onChange) onChange(e); } } });
    if (checked) box.checked = true;
    return box;
}

function icon(content, cls = '') {
    return create('span', { cls: `view-icon ${cls}`, html: content });
}

/** Возвращает { overlay, modal, contentContainer, close }. */
function modal(title, options = {}) {
    const overlay = create('div', { cls: 'view-modal-overlay' });
    const modalDiv = create('div', { cls: ['view-modal', options.cls].filter(Boolean), parent: overlay });

    if (title) {
        create('h3', { text: title, style: options.titleStyle, parent: modalDiv });
    }

    const contentContainer = create('div', { cls: 'view-modal-content', parent: modalDiv });

    const close = () => {
        overlay.remove();
        if (options.onClose) options.onClose();
    };

    document.body.appendChild(overlay);
    return { overlay, modal: modalDiv, contentContainer, close };
}

/** Модалка напоминания: текст, дата, повторение. Resolve: { text, date, recurrence } или null. */
function openReminderModal(defaultText = "", defaultDate = "") {
    return new Promise((resolve) => {
        const m = modal('Настройка напоминания', { onClose: () => resolve(null) });
        const container = m.contentContainer;

        const textInput = input('Текст напоминания', { value: defaultText, style: { width: '100%', marginBottom: '15px' } });
        container.appendChild(textInput);

        create('div', { text: 'Дата и время:', style: { marginBottom: '5px', fontSize: '0.9em', color: 'var(--text-muted)' }, parent: container });
        const initialDate = defaultDate || moment().add(1, 'hour').startOf('hour').format('YYYY-MM-DDTHH:mm');
        const dateField = dateInput(initialDate, { style: { width: '100%', marginBottom: '15px' } });
        container.appendChild(dateField);

        create('div', { text: 'Повторение:', style: { marginBottom: '5px', fontSize: '0.9em', color: 'var(--text-muted)' }, parent: container });
        const recurrenceContainer = create('div', { style: { display: 'flex', gap: '10px', marginBottom: '20px' }, parent: container });

        const recurAmount = input('', { type: 'number', value: '1', attr: { min: '1' }, style: { width: '60px' } });
        const recurUnit = dropdown([
            { value: "", label: "Без повтора" },
            { value: "days", label: "Дней" },
            { value: "weeks", label: "Недель" },
            { value: "months", label: "Месяцев" },
            { value: "years", label: "Лет" }
        ], { style: { flex: '1' } });

        recurrenceContainer.appendChild(recurAmount);
        recurrenceContainer.appendChild(recurUnit);

        const btnContainer = create('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '10px' }, parent: container });

        const cancelBtn = btn('Отмена', () => {
            m.close();
            resolve(null);
        });

        const saveBtn = btn('Сохранить', () => {
            const text = textInput.value.trim();
            const date = dateField.value;
            const unit = recurUnit.value;
            const amount = recurAmount.value;

            if (!text || !date) {
                new Notice("Заполните текст и дату");
                return;
            }

            let recurrence = "";
            if (unit) recurrence = `every ${amount} ${unit}`;

            m.overlay.remove();
            resolve({ text, date, recurrence });
        });

        btnContainer.appendChild(cancelBtn);
        btnContainer.appendChild(saveBtn);

        textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });
        textInput.focus();
    });
}

return {
    create,
    formContainer,
    btn,
    actionBtn,
    input,
    dateInput,
    dropdown,
    checkbox,
    icon,
    modal,
    openReminderModal
};
