/**
 * Прокрутка к элементу: явный расчёт scrollTop (Live Preview / Reading) или scrollIntoView.
 * Опции: onBeforeScroll, delay, behavior, scrollAgainDelay, explicitScroll, offset. На время скролла — блокировщик.
 */
const SCROLL_CONTAINERS = '.cm-scroller, .markdown-reading-view, .markdown-preview-view';

/** Расчёт позиции и scrollTo по контейнеру из SCROLL_CONTAINERS. Возвращает false, если скроллить нечего. */
function explicitScrollTo(targetElement, offset, behavior) {
    const scroller = targetElement.closest(SCROLL_CONTAINERS);
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return false;
    const containerRect = scroller.getBoundingClientRect();
    const elementRect = targetElement.getBoundingClientRect();
    const targetTop = scroller.scrollTop + (elementRect.top - containerRect.top) - offset;
    const clamped = Math.max(0, Math.min(targetTop, scroller.scrollHeight - scroller.clientHeight));
    scroller.scrollTo({ top: clamped, behavior: behavior || 'auto' });
    return true;
}

async function scrollToElement(targetElement, options = {}) {
    if (!targetElement) return;

    const {
        onBeforeScroll = null,
        delay = 50,
        behavior = 'auto',
        scrollAgainDelay = 0,
        explicitScroll = false,
        offset = 0,
        highlightClass = 'view-highlight-anim',
        blockerClass = 'view-scroll-blocker'
    } = options;

    if (onBeforeScroll) onBeforeScroll();

    const blocker = document.createElement('div');
    blocker.classList.add(blockerClass);

    const preventEvent = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
    blocker.addEventListener('wheel', preventEvent, { passive: false });
    blocker.addEventListener('touchmove', preventEvent, { passive: false });
    blocker.addEventListener('mousedown', preventEvent, { capture: true });
    document.body.appendChild(blocker);

    targetElement.classList.add(highlightClass);

    const doScroll = () => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (explicitScroll && explicitScrollTo(targetElement, offset, behavior)) return;
                targetElement.scrollIntoView({ behavior, block: 'start' });
            });
        });
    };

    const cleanupDelay = behavior === 'smooth' ? 2500 : 1500;
    setTimeout(() => {
        doScroll();
        if (scrollAgainDelay > 0) setTimeout(doScroll, scrollAgainDelay);
        setTimeout(() => {
            targetElement.classList.remove(highlightClass);
            if (blocker.parentNode) blocker.parentNode.removeChild(blocker);
        }, cleanupDelay);
    }, delay);
}

return { scrollToElement };
