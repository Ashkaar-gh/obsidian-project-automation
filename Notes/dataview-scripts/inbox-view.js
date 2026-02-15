/**
 * View входящих (Inbox): список записей, добавление/редактирование/удаление, перенос в задачи или напоминания.
 * Обновляется при изменении Inbox.md или Trash.md.
 */
(async () => {
    const { obsidian } = input;

    const loader = new Function(await app.vault.adapter.read("dataview-scripts/shared/view-loader.js"))();
    const { modules, paths } = await loader.load(app, [
        "dataview-scripts/inbox-view-modules/1-inbox-manager.js",
        "dataview-scripts/inbox-view-modules/2-inbox-ui-renderer.js",
        "dataview-scripts/inbox-view-modules/3-inbox-event-handler.js",
        "dataview-scripts/inbox-view-modules/4-inbox-utils.js",
        "dataview-scripts/shared/view-refresher.js",
        "dataview-scripts/shared/view-ui.js"
    ]);
    const [manager, renderer, eventHandler, utils, refresher, ui] = modules;
    if (!modules || modules.some(m => m == null)) {
        new Notice("Не загружены модули: Inbox");
        return;
    }

    const context = {};

    async function render(options = {}) {
        dv.container.innerHTML = '';
        const inboxData = await manager.loadInboxData(paths, dv);
        if (!inboxData) {
            dv.paragraph("Не удалось загрузить данные Inbox.");
            return;
        }
        const inboxContainer = renderer.renderInbox(inboxData, ui);
        dv.container.appendChild(inboxContainer);
        eventHandler.initialize({
            container: inboxContainer,
            context,
            manager,
            renderer,
            utils,
            render,
            ui,
            paths,
            dv
        });
        const shouldFocus = options.focusAddInput || (typeof window !== 'undefined' && window.__inboxFocusAddInput);
        if (shouldFocus) {
            const input = inboxContainer.querySelector('.view-input');
            if (input) input.focus();
            if (typeof window !== 'undefined' && window.__inboxFocusAddInput) {
                clearTimeout(window.__inboxFocusAddInputTimer);
                window.__inboxFocusAddInputTimer = setTimeout(() => { window.__inboxFocusAddInput = false; }, 1500);
            }
        }
    }

    refresher.setup(dv, app, render, {
        watchModify: true,
        delay: 500,
        shouldUpdate: (file) => file.path === paths.INBOX_FILE || file.path === paths.TRASH_FILE
    });

    await render();
})();