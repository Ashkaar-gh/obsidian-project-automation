/**
 * View корзины: список записей из Trash.md и кнопка «Очистить» (оставляет только первый заголовок или пустой файл).
 */
(async () => {
    const loader = new Function(await app.vault.adapter.read("dataview-scripts/shared/view-loader.js"))();
    const { modules, paths } = await loader.load(app, [
        "dataview-scripts/shared/view-refresher.js",
        "dataview-scripts/shared/view-io.js",
        "dataview-scripts/shared/view-ui.js"
    ]);
    if (!modules || modules.some(m => m == null)) {
        new Notice("Не загружены модули: Корзина");
        return;
    }
    const [refresher, io, ui] = modules;

    async function render() {
        dv.container.innerHTML = '';
        const content = await dv.io.load(paths.TRASH_FILE);
        if (content === undefined) {
            ui.create('div', {
                text: `Ошибка: Файл "${paths.TRASH_FILE}" не найден.`,
                style: { color: 'var(--text-error)', padding: '10px' },
                parent: dv.container
            });
            return;
        }

        const toolbar = ui.create('div', { cls: 'trash-toolbar' });
        const handleClear = async () => {
            const currentContent = await dv.io.load(paths.TRASH_FILE);
            const allLines = (currentContent ?? '').split('\n').filter(line => line.trim() !== '');
            if (allLines.length > 0) {
                const firstLine = allLines[0].trim();
                await io.modify(app, paths.TRASH_FILE, firstLine.startsWith('#') ? firstLine : '');
                new Notice('Корзина очищена');
            } else {
                new Notice('Корзина уже пуста');
            }
        };

        const clearButton = ui.btn('Очистить', handleClear, { cls: 'trash-clear-button' });
        toolbar.appendChild(clearButton);
        dv.container.appendChild(toolbar);

        const rawLines = content.split('\n').filter(line => line.trim().length > 0);
        const lines = rawLines.filter(line => !line.trim().startsWith('# '));

        if (lines.length === 0) {
            ui.create('div', { text: 'Пусто', cls: 'trash-empty', parent: dv.container });
        } else {
            lines.forEach((line) => {
                let cleanText = line.trim().replace(/^[-*]\s+(\[[xX\s]\]\s+)?/, '');
                ui.create('div', { text: cleanText, cls: 'trash-item', parent: dv.container });
            });
        }
    }

    refresher.setup(dv, app, render, {
        watchModify: true,
        delay: 300,
        shouldUpdate: (file) => file.path === paths.TRASH_FILE
    });

    await render();
})();