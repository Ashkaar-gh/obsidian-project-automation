/**
 * Копирование из task-view: блоки кода (```lang\n...\n```), картинки (![[path]]), текст. Для вставки в буфер из выделенного фрагмента.
 */
/** Блок кода pre → markdown с языком из language-* в class. */
function copyPartFromPre(pre) {
    const codeEl = pre.querySelector('code');
    const raw = codeEl ? codeEl.textContent : pre.textContent;
    const codeText = (raw || '').replace(/\n+$/, '');
    const cls = (pre.className || '') + ' ' + (codeEl && codeEl.className || '');
    const langMatch = cls.match(/\blanguage-(\S+)\b/);
    const lang = langMatch ? langMatch[1] : '';
    return (lang ? '```' + lang + '\n' : '```\n') + codeText + '\n```';
}

/** Картинка: путь из data-href/href родителя или из src/alt; убираем ? и #. */
function copyPartFromImg(img) {
    const parent = img.parentElement;
    let path = parent && parent.tagName === 'A' && (parent.getAttribute('data-href') || parent.getAttribute('href') || '').trim();
    if (!path || /^[\w+.-]+:/.test(path)) {
        try {
            const src = (img.getAttribute('src') || '').trim();
            path = src ? decodeURIComponent(src.split('/').pop() || src) : '';
        } catch (_) {
            path = '';
        }
    }
    if (!path && img.getAttribute('alt')) path = img.getAttribute('alt').trim();
    if (path) path = path.split('?')[0].split('#')[0].trim();
    return path ? `![[${path}]]` : '![image]';
}

/** Обход DocumentFragment: текст → { text, block: false }, PRE/IMG → { text, block: true }. */
function fragmentToParts(fragment) {
    const parts = [];
    function walk(n) {
        if (n.nodeType === 3) {
            parts.push({ text: n.textContent, block: false });
            return;
        }
        if (n.nodeType !== 1) return;
        if (n.tagName === 'PRE') {
            parts.push({ text: copyPartFromPre(n), block: true });
            return;
        }
        if (n.tagName === 'IMG') {
            parts.push({ text: copyPartFromImg(n), block: true });
            return;
        }
        n.childNodes.forEach(walk);
    }
    fragment.childNodes.forEach(walk);
    return parts;
}

/** Склейка частей: после блока (code/image) — пустая строка, иначе один \n; обрезка и схлопывание \n. */
function joinParts(parts) {
    const normalize = (s) => (s || '').replace(/\n+$/, '').replace(/^\n+/, '');
    const trimmed = parts.map((p) => ({ ...p, text: normalize(p.text) })).filter((p) => p.text.length > 0);
    let out = '';
    for (let i = 0; i < trimmed.length; i++) {
        const sep = i === 0 ? '' : (trimmed[i - 1].block ? '\n\n' : '\n');
        out += sep + trimmed[i].text;
    }
    return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '\n');
}

/** Фрагмент выделения → одна строка для буфера (markdown). */
function fragmentToCopyText(fragment) {
    return joinParts(fragmentToParts(fragment));
}

return { copyPartFromPre, fragmentToCopyText };
