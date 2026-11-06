/**
 * Webview script fragment: the comments view and the surface switcher.
 */

export const COMMENTS_FRAGMENT = `
    // ───────────────────────── comments ─────────────────────────

    function renderComments() {
        // A rebuild would drop focus to the page; remember which comment action had it.
        const active = document.activeElement;
        const keep = active && el.commentsHost.contains(active) && active.dataset && active.dataset.commentId
            ? { id: active.dataset.commentId, action: active.dataset.action }
            : null;
        el.commentsHost.textContent = '';
        el.commentsHost.removeAttribute('role');
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
            if (keep) { (el.composeText.disabled ? el.tabComments : el.composeText).focus(); }
            return;
        }

        el.commentsHost.setAttribute('role', 'list');
        el.commentsHost.setAttribute('aria-label', 'UI comments');
        for (const comment of state.comments) {
            el.commentsHost.appendChild(buildComment(comment));
        }
        if (keep) { restoreCommentFocus(keep); }
    }

    /** Same action on the same comment, else the next comment's first action, else the compose box. */
    function restoreCommentFocus(keep) {
        const buttons = Array.from(el.commentsHost.querySelectorAll('[data-action]'));
        const mine = buttons.filter(function (b) { return b.dataset.commentId === keep.id; });
        const target = mine.find(function (b) { return b.dataset.action === keep.action; })
            || mine[0] || buttons[0] || el.composeText;
        target.focus();
    }

    function commentButton(comment, action, label, subject) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pbtn';
        button.textContent = label;
        button.dataset.commentId = comment.id;
        button.dataset.action = action;
        button.setAttribute('aria-label', label + ' comment on ' + subject);
        return button;
    }

    function buildComment(comment) {
        const box = document.createElement('div');
        box.className = 'comment' + (comment.status && comment.status !== 'open' ? ' ' + comment.status : '');
        box.setAttribute('role', 'listitem');
        const subject = comment.element || comment.automationId || 'element';

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
        if (comment.requiresConfirmation) { bits.push('needs confirmation'); }
        meta.textContent = bits.join(' \\u00B7 ');
        box.appendChild(meta);

        if (comment.file) {
            // The native window prints this as plain text. In an editor it can
            // be the thing you actually wanted: the declaration, open.
            const source = document.createElement('button');
            source.type = 'button';
            source.className = 'comment-source';
            source.textContent = comment.line
                ? fileLabel(comment.file) + ':' + comment.line
                : fileLabel(comment.file);
            source.title = 'Open ' + comment.file;
            source.addEventListener('click', function () {
                vscode.postMessage({ type: 'goToSource', file: comment.file, line: comment.line });
            });
            box.appendChild(source);
        }

        const actions = document.createElement('div');
        actions.className = 'comment-actions';

        if (comment.handle) {
            const reveal = commentButton(comment, 'reveal', 'Show in tree', subject);
            reveal.setAttribute('aria-label', 'Show ' + subject + ' in tree');
            reveal.addEventListener('click', function () {
                setView('tree');
                selectHandle(comment.handle);
                revealHandle(comment.handle);
            });
            actions.appendChild(reveal);
        }

        if (comment.status === 'open') {
            const resolve = commentButton(comment, 'resolve', 'Resolve', subject);
            resolve.addEventListener('click', function () {
                vscode.postMessage({ type: 'resolveComment', id: comment.id });
            });
            actions.appendChild(resolve);
        }

        const remove = commentButton(comment, 'delete', 'Delete', subject);
        remove.addEventListener('click', function () {
            vscode.postMessage({ type: 'deleteComment', id: comment.id });
        });
        actions.appendChild(remove);

        box.appendChild(actions);
        return box;
    }

    // A comment is anchored to an element, so composing without a selection
    // would produce an orphan note the engine cannot re-find later. A draft
    // stays pinned to the element it was started on.
    function updateCompose() {
        if (el.composeText.value.trim() === '') { state.composeHandle = null; }
        const pinned = state.composeHandle;
        const handle = pinned || state.selected;
        const node = handle ? nodeForHandle(handle) : null;
        if (pinned && !node) {
            el.composeTarget.textContent = 'The element this draft was for is gone. Copy or clear the text to comment on another element.';
            el.composeText.disabled = false;
            el.composeAdd.disabled = true;
            return;
        }
        const hasTarget = !!node && state.caps.canEdit;
        let target = hasTarget
            ? 'On ' + (node.name ? node.name + ' (' + shortTypeName(node.type) + ')' : shortTypeName(node.type))
            : 'Select an element in the visual tree to comment on it.';
        if (hasTarget && pinned && pinned !== state.selected) {
            target += '. Draft started here; clear it to comment on the selected element.';
        }
        el.composeTarget.textContent = target;
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

    el.composeText.addEventListener('input', function () {
        if (!state.composeHandle && el.composeText.value.trim() !== '') { state.composeHandle = state.selected; }
        updateCompose();
    });

    el.composeAdd.addEventListener('click', function () {
        const text = el.composeText.value.trim();
        const handle = state.composeHandle || state.selected;
        if (!text || !handle) { return; }
        showComposeError('');
        // The draft stays until the host confirms the add; a failure must not
        // throw away what the user typed.
        vscode.postMessage({ type: 'addComment', handle: handle, text: text });
        el.composeAdd.disabled = true;
    });

    function commentAdded() {
        el.composeText.value = '';
        state.composeHandle = null;
        updateCompose();
    }

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
