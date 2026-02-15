/**
 * Фоновая проверка напоминаний: таймер раз в CHECK_PERIOD_MS, уведомления при наступлении времени. start(dv, app, actions, fetcher, ui, paths?) → { stop, checkNow }.
 */
let checkInterval = null;
const CHECK_PERIOD_MS = 60 * 1000;

function start(dv, app, actions, fetcher, ui, paths) {
    stop();
    console.log("[Checker] Запущен.");

    const checkRoutine = async () => {
        try {
            const data = await fetcher.fetchReminders(dv, app, paths);
            if (!data || (!data.overdue.length && !data.today.length)) return;

            const candidates = [...data.overdue, ...data.today];
            const now = moment();

            for (const item of candidates) {
                let triggerTime = moment(item.date);

                if (!item.displayTime) {
                    triggerTime.set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
                }

                if (now.isSameOrAfter(triggerTime)) {
                    console.log(`[Checker] Время пришло для: "${item.text}"`);
                    showNotificationModal(app, item, actions, ui);
                    break;
                }
            }
        } catch (err) {
            console.error("[Checker] Ошибка проверки:", err);
        }
    };

    checkInterval = setInterval(checkRoutine, CHECK_PERIOD_MS);
    checkRoutine();

    return { stop: stop, checkNow: checkRoutine };
}

/**
 * Останавливает процесс проверки напоминаний.
 */
function stop() {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
    }
}

/**
 * Создает и отображает модальное окно уведомления.
 * 
 * @param {Object} app - Api приложения.
 * @param {Object} item - Объект напоминания.
 * @param {Object} actions - Модуль действий.
 * @param {Object} ui - Модуль ui.
 */
function showNotificationModal(app, item, actions, ui) {
    if (document.querySelector('.view-modal-overlay')) return;

    const m = ui.modal('🔔 Напоминание', {
        titleStyle: { color: 'var(--interactive-accent)', marginBottom: '15px' }
    });
    const container = m.contentContainer;

    ui.create('div', { 
        text: item.text, 
        style: { fontSize: '1.1em', fontWeight: 'bold', marginBottom: '8px', lineHeight: '1.4' }, 
        parent: container 
    });

    const timeStr = item.displayTime ? `${item.displayDate} в ${item.displayTime}` : item.displayDate;
    ui.create('div', { 
        text: `Срок: ${timeStr}`, 
        style: { color: 'var(--text-muted)', marginBottom: '25px', fontSize: '0.9em' }, 
        parent: container 
    });

    const btnContainer = ui.create('div', { 
        style: { display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }, 
        parent: container 
    });

    btnContainer.appendChild(ui.btn('✅ Выполнено', async () => {
        const res = await actions.completeReminder(item.file, item.originalText, item.task.line);
        if(res) new Notice("Задача выполнена!");
        m.close(); 
    }, { style: { width: '100%', fontWeight: 'bold' } }));

    btnContainer.appendChild(ui.btn('🕐 Отложить на 1 час', async () => {
        const success = await actions.snoozeReminder(item.file, item.originalText, 60);
        if (success) {
            new Notice("Перенесено на 1 час");
            m.close();
        }
    }, { style: { width: '100%' } }));

    btnContainer.appendChild(ui.btn('☀️ Отложить на завтра', async () => {
        const success = await actions.snoozeReminder(item.file, item.originalText, 1440);
        if (success) {
            new Notice("Перенесено на завтра");
            m.close();
        }
    }, { style: { width: '100%' } }));

    btnContainer.appendChild(ui.btn('📅 Выбрать дату...', async () => {
        m.close();

        const picker = ui.modal('Выберите время переноса');
        
        const defaultDate = moment().add(2, 'hours').startOf('hour').format('YYYY-MM-DDTHH:mm');
        const dateInput = ui.dateInput(defaultDate, { style: { width: '100%', marginBottom: '15px' } });
        picker.contentContainer.appendChild(dateInput);

        const saveBtn = ui.btn('Сохранить', async () => {
            const dateVal = dateInput.value;
            if (dateVal) {
                const success = await actions.setReminderDate(item.file, item.originalText, dateVal);
                if (success) {
                    new Notice(`Перенесено на ${moment(dateVal).format('DD.MM HH:mm')}`);
                    picker.close();
                }
            }
        }, { style: { width: '100%' } });

        picker.contentContainer.appendChild(saveBtn);
        dateInput.focus();

    }, { style: { width: '100%' } }));
}

return { start, stop };