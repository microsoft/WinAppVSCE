/**
 * Webview script fragment: the virtualized visual tree.
 *
 * Covers the flattened row model, the windowed renderer and keyboard and
 * pointer interaction. Only the rows inside the viewport are ever in the DOM,
 * because a WinUI visual tree can run to many thousands of elements and a
 * webview gets none of the virtualization VS Code's native tree has.
 */

export const TREE_FRAGMENT = `    // ───────────────────────── tree model ─────────────────────────

    function nodeMatches(node, needle) {
        const type = (node.type || '').toLowerCase();
        const name = (node.name || '').toLowerCase();
        // The placeholder promises "#name", so honour it as a name-only search
        // rather than letting the hash fall through and match nothing.
        if (needle.charAt(0) === '#') {
            return name.indexOf(needle.slice(1)) !== -1;
        }
        return type.indexOf(needle) !== -1 || name.indexOf(needle) !== -1;
    }

    /**
     * Collects handles of nodes matching the filter plus all their ancestors,
     * so a deep match stays reachable without the user expanding by hand.
     */
    function computeFilterSet(needle) {
        const keep = new Set();

        function walk(node, ancestors) {
            const branch = ancestors.concat(node.handle);
            if (nodeMatches(node, needle)) {
                for (const handle of branch) { keep.add(handle); }
            }
            const children = node.children || [];
            for (const child of children) { walk(child, branch); }
        }

        for (const root of state.roots) { walk(root, []); }
        return keep;
    }

    /**
     * Rebuilds the flat row list from the expanded set and active filter.
     * Only expanded branches contribute rows, which is what keeps the flatten
     * cost proportional to what is actually on screen.
     */
    function rebuildRows() {
        const needle = state.filter.trim().toLowerCase();
        const filtering = needle.length > 0;
        const keep = filtering ? computeFilterSet(needle) : null;
        const rows = [];

        function walk(node, depth) {
            if (filtering && !keep.has(node.handle)) { return; }

            const children = (node.children || []).filter(function (child) {
                return !filtering || keep.has(child.handle);
            });
            const hasChildren = children.length > 0 || (node.childCount || 0) > 0;

            rows.push({ node: node, depth: depth, hasChildren: hasChildren });

            // While filtering, matched branches are forced open so results are
            // visible without disturbing the user's saved expansion state.
            const isOpen = filtering ? true : state.expanded.has(node.handle);
            if (isOpen) {
                for (const child of children) { walk(child, depth + 1); }
            }
        }

        for (const root of state.roots) { walk(root, 0); }
        state.rows = rows;
    }

    // ───────────────────────── tree rendering ─────────────────────────

    let renderQueued = false;

    function scheduleRender() {
        if (renderQueued) { return; }
        renderQueued = true;
        requestAnimationFrame(function () {
            renderQueued = false;
            renderTree();
        });
    }

    function countNodes(nodes) {
        let n = 0;
        for (const node of nodes) {
            n += 1 + countNodes(node.children || []);
        }
        return n;
    }

    function renderTree() {
        const total = state.rows.length;
        el.treeSizer.style.height = (total * ROW_HEIGHT) + 'px';
        el.treeHeader.textContent = 'VISUAL TREE \\u00B7 ' + countNodes(state.roots) + ' NODES';
        if (total === 0) {
            el.treeSizer.textContent = '';
            const empty = document.createElement('div');
            empty.className = 'tree-empty';
            empty.textContent = state.filter
                ? 'No elements match "' + state.filter + '".'
                : 'No elements to show.';
            el.treeSizer.appendChild(empty);
            el.treeViewport.removeAttribute('aria-activedescendant');
            return;
        }

        const scrollTop = el.treeViewport.scrollTop;
        const viewportHeight = el.treeViewport.clientHeight || 400;
        const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
        const last = Math.min(total - 1, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

        const fragment = document.createDocumentFragment();
        for (let i = first; i <= last; i++) {
            fragment.appendChild(buildRow(state.rows[i], i, total));
        }

        el.treeSizer.textContent = '';
        el.treeSizer.appendChild(fragment);
        requestPreviews(first, last);

        if (state.focused) {
            el.treeViewport.setAttribute('aria-activedescendant', rowId(state.focused));
        }
    }

    function rowId(handle) {
        return 'row-' + handle;
    }

    // ───────────────────────── row captions ─────────────────────────

    let previewTimer = null;
    let previewQueue = [];

    /**
     * Queues caption reads for the rows now on screen.
     *
     * Scrolling fires this on every frame, so the queue is debounced: a fast
     * flick through a large tree should cost one request for where the user
     * landed, not one per frame along the way.
     */
    function requestPreviews(first, last) {
        for (let i = first; i <= last; i++) {
            const row = state.rows[i];
            if (!row) { continue; }
            const handle = row.node.handle;
            if (state.previewsAsked.has(handle)) { continue; }
            state.previewsAsked.add(handle);
            previewQueue.push(handle);
        }
        if (previewQueue.length === 0 || previewTimer) { return; }

        previewTimer = setTimeout(function () {
            previewTimer = null;
            const handles = previewQueue;
            previewQueue = [];
            vscode.postMessage({ type: 'requestPreviews', handles: handles });
        }, PREVIEW_DEBOUNCE_MS);
    }

    /** Drops captions when the tree changes: handles do not survive a reload. */
    function resetPreviews() {
        state.previews = Object.create(null);
        state.previewsAsked = new Set();
        previewQueue = [];
        if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    }

    /**
     * The row's full caption, in the same order the native DevTools window
     * uses: type, then #name, then the element's own text in quotes.
     */
    function rowLabel(node) {
        const preview = state.previews[node.handle];
        let label = shortTypeName(node.type);
        if (node.name) { label += '  #' + node.name; }
        if (preview && preview.text) { label += '  \\u201C' + preview.text + '\\u201D'; }
        return label;
    }

    function buildRow(row, index, total) {
        const node = row.node;
        const div = document.createElement('div');
        div.className = 'tree-row' + (node.handle === state.selected ? ' selected' : '');
        div.style.top = (index * ROW_HEIGHT) + 'px';
        div.id = rowId(node.handle);
        div.dataset.handle = node.handle;
        // Rows ellipsize rather than scroll sideways, so the full label has to
        // stay reachable somehow.
        div.title = rowLabel(node);

        div.setAttribute('role', 'treeitem');
        div.setAttribute('aria-level', String(row.depth + 1));
        div.setAttribute('aria-selected', node.handle === state.selected ? 'true' : 'false');
        div.setAttribute('aria-setsize', String(total));
        div.setAttribute('aria-posinset', String(index + 1));
        if (row.hasChildren) {
            div.setAttribute('aria-expanded', state.expanded.has(node.handle) ? 'true' : 'false');
        }

        const indent = document.createElement('span');
        indent.className = 'prop-indent';
        indent.style.width = (row.depth * INDENT_PX) + 'px';
        div.appendChild(indent);

        const twisty = document.createElement('span');
        twisty.className = 'twisty' + (row.hasChildren ? '' : ' leaf');
        twisty.textContent = state.expanded.has(node.handle) ? '⌄' : '›';
        twisty.dataset.twisty = '1';
        div.appendChild(twisty);

        const type = document.createElement('span');
        type.className = 'node-type';
        type.textContent = shortTypeName(node.type);
        div.appendChild(type);

        if (node.name) {
            const name = document.createElement('span');
            name.className = 'node-name';
            name.textContent = node.name;
            div.appendChild(name);
        }

        const preview = state.previews[node.handle];
        if (preview && preview.text) {
            const caption = document.createElement('span');
            caption.className = 'node-preview';
            caption.textContent = '\\u201C' + preview.text + '\\u201D';
            div.appendChild(caption);
        }

        if (node.file) {
            const file = document.createElement('span');
            file.className = 'node-file';
            // The engine only reports a line with the caption, so a row shows
            // one as soon as its caption has arrived.
            file.textContent = preview && preview.line
                ? fileLabel(node.file) + ':' + preview.line
                : fileLabel(node.file);
            div.appendChild(file);
        }

        return div;
    }

    /** Trims the namespace so the tree reads as "Grid", not the full type name. */
    function shortTypeName(type) {
        if (!type) { return '(unknown)'; }
        const index = type.lastIndexOf('.');
        return index === -1 ? type : type.slice(index + 1);
    }

    function fileLabel(file) {
        const cleaned = String(file).replace(/^ms-appx(-web)?:\\/\\/\\//i, '');
        const index = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\\\'));
        return index === -1 ? cleaned : cleaned.slice(index + 1);
    }

    // ───────────────────────── tree interaction ─────────────────────────

    function indexOfHandle(handle) {
        for (let i = 0; i < state.rows.length; i++) {
            if (state.rows[i].node.handle === handle) { return i; }
        }
        return -1;
    }

    function selectHandle(handle, opts) {
        state.selected = handle;
        state.focused = handle;
        if (!opts || !opts.silent) {
            vscode.postMessage({ type: 'selectNode', handle: handle });
        }
        // The compose box is gated on having a target, so it has to follow the
        // selection rather than wait for the next comment list to arrive.
        updateCompose();
        scheduleRender();
    }

    function toggleExpand(handle, force) {
        const open = force === undefined ? !state.expanded.has(handle) : force;
        if (open) {
            state.expanded.add(handle);
        } else {
            state.expanded.delete(handle);
        }
        persist();
        rebuildRows();
        scheduleRender();
    }

    function revealHandle(handle) {
        // Open every ancestor so the row exists before scrolling to it.
        const path = [];
        function find(node, trail) {
            if (node.handle === handle) { path.push.apply(path, trail); return true; }
            const children = node.children || [];
            for (const child of children) {
                if (find(child, trail.concat(node.handle))) { return true; }
            }
            return false;
        }
        for (const root of state.roots) {
            if (find(root, [])) { break; }
        }
        for (const ancestor of path) { state.expanded.add(ancestor); }

        rebuildRows();
        const index = indexOfHandle(handle);
        if (index !== -1) {
            const target = index * ROW_HEIGHT;
            const viewTop = el.treeViewport.scrollTop;
            const viewBottom = viewTop + el.treeViewport.clientHeight;
            if (target < viewTop || target + ROW_HEIGHT > viewBottom) {
                el.treeViewport.scrollTop = Math.max(0, target - el.treeViewport.clientHeight / 2);
            }
        }
        scheduleRender();
    }

    el.treeViewport.addEventListener('scroll', scheduleRender);

    el.treeViewport.addEventListener('click', function (event) {
        const row = event.target.closest('.tree-row');
        if (!row) { return; }
        const handle = row.dataset.handle;
        if (event.target.dataset && event.target.dataset.twisty) {
            toggleExpand(handle);
            return;
        }
        selectHandle(handle);
    });

    el.treeViewport.addEventListener('mouseover', function (event) {
        if (!state.caps.canHighlight) { return; }
        const row = event.target.closest('.tree-row');
        if (!row) { return; }
        vscode.postMessage({ type: 'hoverNode', handle: row.dataset.handle });
    });

    el.treeViewport.addEventListener('mouseleave', function () {
        if (!state.caps.canHighlight) { return; }
        vscode.postMessage({ type: 'hoverNode', handle: undefined });
    });

    el.treeViewport.addEventListener('keydown', function (event) {
        if (state.rows.length === 0) { return; }

        let index = state.focused === null ? -1 : indexOfHandle(state.focused);
        if (index === -1) { index = 0; }
        const row = state.rows[index];

        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                moveFocus(Math.min(state.rows.length - 1, index + 1));
                break;
            case 'ArrowUp':
                event.preventDefault();
                moveFocus(Math.max(0, index - 1));
                break;
            case 'ArrowRight':
                event.preventDefault();
                if (row.hasChildren && !state.expanded.has(row.node.handle)) {
                    toggleExpand(row.node.handle, true);
                } else {
                    moveFocus(Math.min(state.rows.length - 1, index + 1));
                }
                break;
            case 'ArrowLeft':
                event.preventDefault();
                if (row.hasChildren && state.expanded.has(row.node.handle)) {
                    toggleExpand(row.node.handle, false);
                } else {
                    // Step to the parent, which is the nearest shallower row above.
                    for (let i = index - 1; i >= 0; i--) {
                        if (state.rows[i].depth < row.depth) { moveFocus(i); break; }
                    }
                }
                break;
            case 'Home':
                event.preventDefault();
                moveFocus(0);
                break;
            case 'End':
                event.preventDefault();
                moveFocus(state.rows.length - 1);
                break;
            case 'Enter':
            case ' ':
                event.preventDefault();
                selectHandle(row.node.handle);
                break;
            default:
                return;
        }
    });

    function moveFocus(index) {
        const row = state.rows[index];
        if (!row) { return; }
        selectHandle(row.node.handle);
        revealHandle(row.node.handle);
    }`;
