/**
 * События task-view: клики, контекстное меню, горячие клавиши; редактирование секции в файле, копирование кода, скролл к секции. Возвращает cleanup.
 */
function initialize(dv, obsidian, app, container, context, render, scrollModule, copyModule) {

    /** Сохранить текст из textarea в entry.sourcePath (замена блока content по contentStartOffset..contentEndOffset). */
    async function handleSave(textarea) {
        if (!textarea) return;
        const parentDetails = textarea.closest('details');
        if (!parentDetails) return;
        const entryIndex = parentDetails.dataset.entryIndex;

        if (!context.structuredData || !context.structuredData[entryIndex]) return;

        const entry = context.structuredData[entryIndex];
        const newContent = textarea.value;
        context.activeEditArea = null;
        textarea.style.display = 'none';

        const displayDiv = textarea.previousElementSibling;
        if (displayDiv) displayDiv.style.display = 'block';

        if (newContent.trim() === entry.content.trim()) return;

        const file = app.vault.getAbstractFileByPath(entry.sourcePath);
        if (!file) return;

        const originalFileContent = await dv.io.load(entry.sourcePath);
        if (originalFileContent == null) return;
        const prefix = originalFileContent.substring(0, entry.contentStartOffset);
        const suffix = originalFileContent.substring(entry.contentEndOffset);
        let finalContent = newContent;

        if (suffix.length > 0 && !finalContent.endsWith('\n')) finalContent += '\n\n';
        else if (suffix.length > 0 && !finalContent.endsWith('\n\n') && finalContent.endsWith('\n')) finalContent += '\n';

        await app.vault.modify(file, prefix + finalContent + suffix);
    }

    const containerInteractionHandler = async (event) => {
        if (!container.contains(event.target)) return;

        if (event.type === 'click') {
            const copyBtn = event.target.closest('.task-view-copy-btn');
            if (copyBtn) {
                event.preventDefault(); event.stopPropagation();
                const pre = copyBtn.closest('pre');
                const codeEl = pre && pre.querySelector('code');
                if (codeEl) {
                    try {
                        const codeText = (codeEl.textContent || '').replace(/\n+$/, '');
                        const cls = (pre.className || '') + ' ' + (codeEl.className || '');
                        const langMatch = cls.match(/\blanguage-(\S+)\b/);
                        const lang = langMatch ? langMatch[1] : '';
                        const wrapped = (lang ? '```' + lang + '\n' : '```\n') + codeText + '\n```';
                        await navigator.clipboard.writeText(wrapped);
                        const checkIcon = obsidian.getIcon('check'), copyIcon = obsidian.getIcon('copy');
                        copyBtn.innerHTML = checkIcon ? checkIcon.outerHTML : '&#10003;';
                        copyBtn.classList.add('copied');
                        setTimeout(() => {
                            copyBtn.innerHTML = copyIcon ? copyIcon.outerHTML : '&#128203;';
                            copyBtn.classList.remove('copied');
                        }, 2000);
                    } catch (err) { console.error(err); }
                }
                return;
            }

            const summary = event.target.closest('.task-view-summary');
            if (summary) {
                const collapseBtn = event.target.closest('.task-view-collapse-button');
                /** Кнопка сворачивания/разворачивания details. */
                if (collapseBtn) {
                    event.preventDefault(); event.stopPropagation();
                    const details = summary.closest('details');
                    if (details) {
                        details.hasAttribute('open') ? details.removeAttribute('open') : details.setAttribute('open', '');
                        collapseBtn.textContent = details.hasAttribute('open') ? '▼' : '◀';
                    }
                    return;
                }
                if (event.target.closest('a')) return;
                event.preventDefault();
                return;
            }

            const tocLink = event.target.closest('a[data-scroll-to-id]');
            /** Клик по пункту оглавления — скролл к секции (explicitScroll + при необходимости раскрыть details). */
            if (tocLink) {
                event.preventDefault(); event.stopPropagation();
                const targetId = tocLink.dataset.scrollToId;
                const elementToScroll = document.getElementById(targetId);

                if (elementToScroll && scrollModule) {
                    const parentDetails = elementToScroll.closest('details.task-view-entry');

                    scrollModule.scrollToElement(elementToScroll, {
                        explicitScroll: true,
                        behavior: 'auto',
                        offset: 0,
                        delay: 250,
                        scrollAgainDelay: 450,
                        onBeforeScroll: () => {
                            if (parentDetails && !parentDetails.hasAttribute('open')) {
                                parentDetails.open = true;
                                const btn = parentDetails.querySelector('.task-view-collapse-button');
                                if (btn) btn.textContent = '▼';
                            }
                        }
                    });
                }
                return;
            }
        }

        if (event.type === 'contextmenu') {
            /** ПКМ по контенту секции — переключить в режим редактирования (textarea). */
            const displayDiv = event.target.closest('.task-view-display');
            if (displayDiv) {
                event.preventDefault();
                if (context.activeEditArea) handleSave(context.activeEditArea);
                const detailsEl = displayDiv.closest('details');
                const previewWrap = displayDiv.closest('.markdown-preview-view');
                const editArea = detailsEl && detailsEl.querySelector('.task-view-edit');
                if (previewWrap) previewWrap.style.display = 'none';
                if (editArea) editArea.style.display = 'block';
                if (editArea) {
                    editArea.style.height = 'auto';
                    editArea.style.height = (editArea.scrollHeight + 10) + 'px';
                }
                context.activeEditArea = editArea;
            }
        }
    };

    /** Выход из редактирования: Escape или клик снаружи; не срабатывает при клике по скроллбару. */
    const globalExitHandler = (event) => {
        if (!context.activeEditArea) return;

        if (event.type === 'keydown' && event.key === 'Escape') {
            handleSave(context.activeEditArea);
            return;
        }

        if (event.type === 'mousedown') {
            const target = event.target;

            if (context.activeEditArea.contains(target)) return;

            const rect = target.getBoundingClientRect();
            const clickX = event.clientX - rect.left;
            const clickY = event.clientY - rect.top;

            const hitVerticalScrollbar = (target.offsetWidth > target.clientWidth) &&
                                       (clickX >= target.clientWidth);

            const hitHorizontalScrollbar = (target.offsetHeight > target.clientHeight) &&
                                         (clickY >= target.clientHeight);

            if (hitVerticalScrollbar || hitHorizontalScrollbar) return;

            const isScrollable = target.scrollHeight > target.clientHeight;
            const isRightEdge = (rect.width - clickX) <= 20;

            const isWindowScrollbar = (window.innerWidth - event.clientX) <= 20;

            if ((isScrollable && isRightEdge) || isWindowScrollbar) {
                return;
            }

            handleSave(context.activeEditArea);
        }
    };

    /** Копирование: только внутри .task-view-display; один pre — copyPartFromPre, иначе fragmentToCopyText. */
    const copyHandler = (e) => {
        if (!copyModule) return;
        const sel = window.getSelection();
        if (!sel.rangeCount || !container.contains(sel.anchorNode)) return;
        const anchorEl = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
        const display = anchorEl && anchorEl.closest ? anchorEl.closest('.task-view-display') : null;
        if (!display || !container.contains(display)) return;
        if (!sel.toString()) return;

        const focusEl = sel.focusNode && (sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement);
        const pre = anchorEl && anchorEl.closest ? anchorEl.closest('pre') : null;
        const samePre = pre && focusEl && pre.contains(focusEl);
        if (pre && samePre) {
            e.preventDefault();
            const selectedText = (sel.toString() || '').trim();
            const codeEl = pre.querySelector('code');
            const fullText = (codeEl ? codeEl.textContent : pre.textContent || '').replace(/\n+$/, '').trim();
            const isSingleLineBlock = !fullText.includes('\n');
            if (selectedText && (selectedText !== fullText || isSingleLineBlock)) {
                e.clipboardData.setData('text/plain', selectedText);
            } else {
                e.clipboardData.setData('text/plain', copyModule.copyPartFromPre(pre));
            }
            return;
        }

        const fragment = sel.getRangeAt(0).cloneContents();
        e.preventDefault();
        e.clipboardData.setData('text/plain', copyModule.fragmentToCopyText(fragment));
    };

    const cleanup = () => {
        container.removeEventListener('click', containerInteractionHandler);
        container.removeEventListener('contextmenu', containerInteractionHandler);
        container.removeEventListener('copy', copyHandler);
        document.removeEventListener('mousedown', globalExitHandler, true);
        document.removeEventListener('keydown', globalExitHandler, true);
    };

    container.addEventListener('click', containerInteractionHandler);
    container.addEventListener('contextmenu', containerInteractionHandler);
    container.addEventListener('copy', copyHandler);
    document.addEventListener('mousedown', globalExitHandler, true);
    document.addEventListener('keydown', globalExitHandler, true);

    return cleanup;
}

return { initialize };