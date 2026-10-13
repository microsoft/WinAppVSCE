/**
 * Webview script fragment: the comments view and the surface switcher.
 */

export const COMMENTS_FRAGMENT = `
    // ───────────────────────── comments ─────────────────────────

    function renderComments() {
        el.commentsHost.textContent = '';
        updateCompose();

        const open = state.comments.filter(function (c) { return c.status === 'open'; }).length;
        el.commentsBadge.textContent = String(open);
        // Hidden at zero so "no comments" reads as absence, not as a zero score.
        el.commentsBadge.classList.toggle('hidden', open === 0);

        if (state.comments.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'props-empty';
            empty.textContent = 'No UI comments yet. Pick an element and add one.';
            el.commentsHost.appendChild(empty);
            return;
        }

        for (const comment of state.comments) {
            el.commentsHost.appendChild(buildComment(comment));
        }
    }

    function buildComment(comment) {
        const box = document.createElement('div');
        box.className = 'comment' + (comment.status && comment.status !== 'open' ? ' ' + comment.status : '');

        const element = document.createElement('div');
        element.className = 'comment-el';
        element.textContent = comment.element || comment.automationId || '(element)';
        box.appendChild(element);

        const text = document.createElement('div');
        text.className = 'comment-text';
        text.textContent = comment.text || '';
        box.appendChild(text);

        const meta = document.createElement('div');
        meta.className = 'comment-meta';
        const bits = [comment.status || 'open'];
        if (comment.window) { bits.push(comment.window); }
        if (comment.requiresConfirmation) { bits.push('needs confirmation'); }
        meta.textContent = bits.join(' \\u00B7 ');
        box.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'comment-actions';

        if (comment.handle) {
            const reveal = document.createElement('button');
            reveal.type = 'button';
            reveal.className = 'pbtn';
            reveal.textContent = 'Show in tree';
            reveal.addEventListener('click', function () {
                setView('tree');
                selectHandle(comment.handle);
                revealHandle(comment.handle);
            });
            actions.appendChild(reveal);
        }

        if (comment.status === 'open') {
            const resolve = document.createElement('button');
            resolve.type = 'button';
            resolve.className = 'pbtn';
            resolve.textContent = 'Resolve';
            resolve.addEventListener('click', function () {
                vscode.postMessage({ type: 'resolveComment', id: comment.id });
            });
            actions.appendChild(resolve);
        }

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'pbtn';
        remove.textContent = 'Delete';
        remove.addEventListener('click', function () {
            vscode.postMessage({ type: 'deleteComment', id: comment.id });
        });
        actions.appendChild(remove);

        box.appendChild(actions);
        return box;
    }

    // A comment is anchored to an element, so composing without a selection
    // would produce an orphan note the engine cannot re-find later.
    function updateCompose() {
        const node = state.selected ? nodeForHandle(state.selected) : null;
        const hasTarget = !!node;
        el.composeTarget.textContent = hasTarget
            ? 'On ' + (node.name ? node.name + ' (' + shortTypeName(node.type) + ')' : shortTypeName(node.type))
            : 'Select an element in the visual tree to comment on it.';
        el.composeText.disabled = !hasTarget;
        el.composeAdd.disabled = !hasTarget || el.composeText.value.trim() === '';
    }

    function nodeForHandle(handle) {
        let found = null;
        function walk(node) {
            if (found) { return; }
            if (node.handle === handle) { found = node; return; }
            for (const child of node.children || []) { walk(child); }
        }
        for (const root of state.roots) { walk(root); }
        return found;
    }

    el.composeText.addEventListener('input', updateCompose);

    el.composeAdd.addEventListener('click', function () {
        const text = el.composeText.value.trim();
        if (!text || !state.selected) { return; }
        showComposeError('');
        vscode.postMessage({ type: 'addComment', handle: state.selected, text: text });
        el.composeText.value = '';
        updateCompose();
    });

    function showComposeError(text) {
        el.composeError.textContent = text || '';
        el.composeError.classList.toggle('hidden', !text);
    }

    function renderSurfaces() {
        el.surface.textContent = '';
        const active = state.surfaces.filter(function (s) { return s.active; })[0];
        el.surface.appendChild(dropdown(
            state.surfaces.map(function (s) {
                return { value: s.id, label: s.title || s.id };
            }),
            active ? active.id : '',
            'Window',
            function (picked) {
                vscode.postMessage({ type: 'setSurface', surface: picked });
            },
        ));
        // A single window needs no switcher, and showing one is noise.
        el.surface.classList.toggle('hidden', state.surfaces.length < 2);
    }

    window.addEventListener('resize', scheduleRender);`;
