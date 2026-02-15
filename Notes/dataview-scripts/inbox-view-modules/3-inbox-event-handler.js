/**
 * События Inbox: добавление, редактирование, удаление, «в задачу», «в напоминания». initialize({ container, manager, renderer, utils, render, ui, paths }).
 */
let activeListeners = [];

function initialize({ container, manager, renderer, utils, render, ui, paths, dv }) {

    async function handleAddItem() {
        const inputField = container.querySelector('.view-input');
        if (!inputField) return;
        const newItem = inputField.value.trim();
        if (newItem) {
            inputField.value = '';
            await manager.addNewItemToInbox(newItem, paths, dv);
            if (typeof window !== 'undefined') window.__inboxFocusAddInput = true;
            await render({ focusAddInput: true });
        }
    }

    const inputElement = container.querySelector('.view-input');
    if (inputElement) {
        inputElement.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                handleAddItem();
            }
        });
    }

    function handleEditItem(lineContainer) {
        const textSpan = lineContainer.querySelector('.inbox-text');
        const actionsDiv = lineContainer.querySelector('.inbox-actions');
        const originalText = lineContainer.dataset.originalText;

        if (textSpan) textSpan.style.display = 'none';
        if (actionsDiv) actionsDiv.style.visibility = 'hidden';

        const editInput = ui.input("", {
            value: originalText,
            style: { width: '100%', marginRight: '10px' }
        });

        lineContainer.insertBefore(editInput, lineContainer.firstChild);
        editInput.focus();

        const saveChanges = async () => {
            const newText = editInput.value.trim();
            if (newText && newText !== originalText) {
                const inboxData = await manager.loadInboxData(paths, dv);
                await manager.editItem(originalText, newText, inboxData.allLines, inboxData.inboxFile, dv);
            }
            await render();
        };

        editInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                await saveChanges();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                editInput.remove();
                if (textSpan) textSpan.style.display = '';
                if (actionsDiv) actionsDiv.style.visibility = '';
            }
        });

        editInput.addEventListener('blur', async () => {
            if (editInput.parentElement) await saveChanges();
        });
    }

    async function handleDeleteItem(lineContainer) {
        const originalText = lineContainer.dataset.originalText;
        const inboxData = await manager.loadInboxData(paths, dv);
        const success = await manager.deleteItem(originalText, inboxData.allLines, inboxData.inboxFile, paths, dv);
        if (success) container.removeChild(lineContainer);
    }

    async function handleCreateTask(lineContainer) {
        const originalText = lineContainer.dataset.originalText;
        const inboxData = await manager.loadInboxData(paths, dv);
        utils.closeDropdownMenu();
        const success = await manager.createTask(originalText, inboxData.allLines, inboxData.inboxFile, dv);
        if (success) container.removeChild(lineContainer);
    }

    async function handleCalendarAction(button) {
        const lineContainer = button.closest('.inbox-line');
        const originalText = lineContainer.dataset.originalText;

        const result = await ui.openReminderModal(originalText);

        if (result) {
            const formattedDate = moment(result.date).format('DD-MM-YYYY HH:mm');
            const inboxData = await manager.loadInboxData(paths, dv);
            if (result.text !== originalText) {
                await manager.editItem(originalText, result.text, inboxData.allLines, inboxData.inboxFile, dv);
                const refreshedData = await manager.loadInboxData(paths, dv);
                await manager.updateItemDateTime(result.text, refreshedData.allLines, refreshedData.inboxFile, formattedDate, result.recurrence);
            } else {
                await manager.updateItemDateTime(originalText, inboxData.allLines, inboxData.inboxFile, formattedDate, result.recurrence);
            }

            await render();
        }
    }

    function inboxContainerClickHandler(event) {
        const target = event.target;

        if (target.closest('.view-btn')) {
            handleAddItem();
            return;
        }

        const lineContainer = target.closest('.inbox-line');
        if (!lineContainer) return;

        const actionButton = target.closest('[data-action]');
        if (actionButton) {
            event.stopPropagation();
            const action = actionButton.dataset.action;
            if (action === 'delete') handleDeleteItem(lineContainer);
            else if (action === 'task') handleCreateTask(lineContainer);
            else if (action === 'edit') handleEditItem(lineContainer);
            else if (action === 'calendar') handleCalendarAction(actionButton);
            return;
        }
    }

    container.addEventListener('click', inboxContainerClickHandler);
}

function cleanup() {
    activeListeners = [];
}

return { initialize, cleanup };