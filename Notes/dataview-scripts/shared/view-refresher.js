/**
 * Debounce-обновление view при изменении файлов/метаданных.
 * Если вкладка не видна — рендер откладывается до переключения на неё.
 * options: { delay, watchModify, shouldUpdate(file, reason, cache) }.
 */
/** Подписка на metadataCache/vault/workspace; debounce; при невидимой вкладке — отложенный рендер до active-leaf-change. */
function setup(dv, app, renderFn, options = {}) {
    const { delay = 1000, watchModify = false, shouldUpdate = null } = options;
    let updatePending = false;
    let _debounceTimer;

    function isVisible() {
        if (!dv.container || !dv.container.isConnected) return false;
        return dv.container.offsetParent !== null;
    }

    const runRender = () => {
        updatePending = false;
        renderFn();
    };

    const scheduleRender = () => {
        if (!isVisible()) {
            updatePending = true;
            return;
        }
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(runRender, delay);
    };

    const handleUpdate = (file, reason, cache) => {
        if (shouldUpdate && !shouldUpdate(file, reason, cache)) return;
        scheduleRender();
    };

    const events = [];
    events.push([app.metadataCache, 'changed', app.metadataCache.on('changed', (file, data, cache) => {
        handleUpdate(file, 'changed', cache);
    })]);
    events.push([app.vault, 'rename', app.vault.on('rename', (file) => handleUpdate(file, 'rename', null))]);
    events.push([app.vault, 'delete', app.vault.on('delete', (file) => handleUpdate(file, 'delete', null))]);
    if (watchModify) {
        events.push([app.vault, 'modify', app.vault.on('modify', (file) => handleUpdate(file, 'modify', null))]);
    }
    events.push([app.workspace, 'active-leaf-change', app.workspace.on('active-leaf-change', () => {
        setTimeout(() => {
            if (isVisible() && updatePending) runRender();
        }, 50);
    })]);

    const cleanup = () => {
        clearTimeout(_debounceTimer);
        events.forEach(([obj, name, ref]) => obj.off(name, ref));
    };

    const oldUnload = dv.container.onunload;
    dv.container.onunload = () => {
        cleanup();
        if (oldUnload) oldUnload();
    };

    return { forceRender: runRender, cleanup };
}

return { setup };