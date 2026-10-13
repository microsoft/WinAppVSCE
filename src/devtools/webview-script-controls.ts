/**
 * Webview script fragment: toolbar controls and view switching.
 *
 * Pick, focus, layout adorners, the DevTools window button, the tree and
 * comments tabs, and the two filter boxes.
 */

export const CONTROLS_FRAGMENT = `
    // ───────────────────────── controls ─────────────────────────

    el.pick.addEventListener('click', function () {
        state.picking = !state.picking;
        updatePickButton();
        vscode.postMessage({ type: 'togglePick', armed: state.picking });
    });

    el.focusBtn.addEventListener('click', function () {
        state.focusTracking = !state.focusTracking;
        setPressed(el.focusBtn, state.focusTracking);
        if (!state.focusTracking) { showFocusNotice(''); }
        vscode.postMessage({ type: 'toggleFocusTracking', armed: state.focusTracking });
    });

    el.layoutBtn.addEventListener('click', function () {
        state.layoutOn = !state.layoutOn;
        setPressed(el.layoutBtn, state.layoutOn);
        // The box is drawn from state.layout, so dropping the measurement and
        // re-rendering is what actually takes it off the pane; without this the
        // adorner vanished from the app but its numbers stayed behind.
        if (!state.layoutOn) { state.layout = null; }
        renderProperties();
        vscode.postMessage({
            type: 'toggleLayout',
            armed: state.layoutOn,
            handle: state.selected,
        });
    });

    el.jmx.addEventListener('click', function () {
        state.authored = !state.authored;
        setPressed(el.jmx, state.authored);
        persist();
        vscode.postMessage({ type: 'refreshTree', authored: state.authored });
    });

    el.tabTree.addEventListener('click', function () { setView('tree'); });
    el.tabComments.addEventListener('click', function () { setView('comments'); });

    function setView(view) {
        state.view = view;
        const onTree = view === 'tree';
        el.tabTree.setAttribute('aria-selected', onTree ? 'true' : 'false');
        el.tabComments.setAttribute('aria-selected', onTree ? 'false' : 'true');
        el.treeViewport.classList.toggle('hidden', !onTree);
        el.commentsViewport.classList.toggle('hidden', onTree);
        // Pick, focus tracking, the filter and Just my XAML are all scoped to
        // the tree, so the native window collapses the whole row with it
        // rather than leave controls acting on nothing.
        el.treeControls.classList.toggle('hidden', !onTree);
        if (onTree) {
            vscode.postMessage({ type: 'commentsHidden' });
        } else {
            updateCompose();
            vscode.postMessage({ type: 'loadComments' });
        }
    }

    function showFocusNotice(text) {
        el.focusNotice.textContent = text;
        el.focusNotice.classList.toggle('hidden', !text);
    }

    let filterTimer;
    el.filter.addEventListener('input', function () {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(function () {
            state.filter = el.filter.value;
            persist();
            rebuildRows();
            el.treeViewport.scrollTop = 0;
            scheduleRender();
        }, 150);
    });

    let propFilterTimer = 0;
    el.propFilter.addEventListener('input', function () {
        clearTimeout(propFilterTimer);
        propFilterTimer = setTimeout(function () {
            state.propFilter = el.propFilter.value.trim().toLowerCase();
            renderProperties();
        }, 150);
    });

    el.pviewComputed.addEventListener('click', function () { setPropView('computed'); });
    el.pviewSet.addEventListener('click', function () { setPropView('set'); });

    function updatePickButton() {
        setPressed(el.pick, state.picking);
    }

    // Matches the in-app shortcut so muscle memory carries across surfaces.
    window.addEventListener('keydown', function (event) {
        if (event.ctrlKey && event.shiftKey && (event.key === 'P' || event.key === 'p')) {
            event.preventDefault();
            el.pick.click();
        }
    });`;
