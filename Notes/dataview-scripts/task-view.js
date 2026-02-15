/**
 * View задач на странице заметки: оглавление по секциям + контент из daily notes.
 * Зависит от текущей страницы (dv.current()); обновляется при изменении затронутых файлов.
 */
(async () => {
    const { obsidian } = input;
    const myself = dv.current();
    if (!myself) return;
    const myFileName = myself.file.name;

    const loader = new Function(await app.vault.adapter.read("dataview-scripts/shared/view-loader.js"))();
    const { modules, paths } = await loader.load(app, [
        "dataview-scripts/task-view-modules/1-task-data-fetcher.js",
        "dataview-scripts/task-view-modules/2-task-renderer.js",
        "dataview-scripts/task-view-modules/3-task-event-handler.js",
        "dataview-scripts/task-view-modules/4-task-copy.js",
        "dataview-scripts/shared/view-refresher.js",
        "dataview-scripts/shared/view-scroll.js",
        "dataview-scripts/shared/view-ui.js"
    ]);
    const [fetcher, renderer, eventHandler, taskCopy, refresher, scroll, ui] = modules;
    if (!modules || modules.some(m => m == null)) {
        new Notice("Не загружены модули: Задачи");
        return;
    }
    const copyModule = taskCopy || null;

    const context = {
        structuredData: [],
        flatTocEntries: [],
        activeEditArea: null,
        lastContainerType: null,
    };

    async function render() {
        if (!dv.container || !dv.container.isConnected) return;

        const scrollableParent = dv.container.closest('.cm-scroller, .markdown-reading-view, .markdown-preview-view');
        const containerType = scrollableParent ? scrollableParent.className : null;
        const isModeSwitch = context.lastContainerType && context.lastContainerType !== containerType;
        context.lastContainerType = containerType;

        let scrollTop = 0;
        if (scrollableParent && !isModeSwitch) scrollTop = scrollableParent.scrollTop;

        const tempContainer = ui.create('div');
        const taskData = await fetcher.fetchData(dv, app, myFileName, paths);
        if (!taskData) return;

        context.structuredData = taskData.structuredData;
        context.flatTocEntries = taskData.flatTocEntries;

        await renderer.renderToc(dv, obsidian, tempContainer, context.flatTocEntries, ui);
        await renderer.renderContent(dv, obsidian, tempContainer, context.structuredData, ui);

        dv.container.replaceChildren(...tempContainer.childNodes);

        if (scrollableParent && !isModeSwitch) {
            setTimeout(() => { if (scrollableParent.isConnected) scrollableParent.scrollTop = scrollTop; }, 0);
        } 
    }

    const cleanupUI = eventHandler.initialize(dv, obsidian, app, dv.container, context, render, scroll, copyModule);

    refresher.setup(dv, app, render, {
        delay: 600,
        shouldUpdate: (file, reason) => {
            if (reason !== 'changed') return true;
            if (file.path.startsWith(paths.DAILY_FOLDER)) return true;
            return context.structuredData.some(entry => entry.sourcePath === file.path);
        }
    });

    const autoUnload = dv.container.onunload;
    dv.container.onunload = () => {
        if (autoUnload) autoUnload();
        cleanupUI();
    };

    await render();
})();