/**
 * Webview script fragment: the host message handler and startup.
 *
 * Must be emitted last: it is the only fragment that runs anything at load
 * time, so every const the other fragments declare is already initialized by
 * the time this one executes.
 */

export const MESSAGES_FRAGMENT = `
    // ───────────────────────── host messages ─────────────────────────

    window.addEventListener('message', function (event) {
        const message = event.data;

        switch (message.type) {
            case 'status': {
                const status = message.status;
                if (status.state === 'connecting') {
                    setStatus('Connecting to the app…', 'info');
                } else if (status.state === 'connected') {
                    const note = status.experimental
                        ? 'Connected to process ' + status.processId +
                          ' · protocol ' + status.protocolVersion + ' (experimental)'
                        : 'Connected to process ' + status.processId;
                    setStatus(note, 'info');
                    // Transient confirmation; the toolbar carries state from here.
                    setTimeout(function () { setStatus(''); }, 4000);
                } else if (status.state === 'disconnected') {
                    setStatus(status.message || 'Disconnected.', 'warn');
                    state.caps = { canEdit: false, canPick: false, canHighlight: false };
                    state.picking = false;
                    state.focusTracking = false;
                    state.layoutOn = false;
                    state.selected = null;
                    state.focused = null;
                    state.roots = [];
                    state.properties = null;
                    state.layout = null;
                    state.comments.forEach(function (comment) { delete comment.handle; });
                    el.pick.disabled = true;
                    el.layoutBtn.disabled = true;
                    el.focusBtn.disabled = true;
                    updatePickButton();
                    setPressed(el.focusBtn, false);
                    setPressed(el.layoutBtn, false);
                    rebuildRows();
                    scheduleRender();
                    renderProperties();
                    renderComments();
                } else if (status.state === 'error') {
                    setStatus(status.message || 'DevTools error.', 'error');
                }
                break;
            }

            case 'capabilities':
                state.caps = {
                    canEdit: !!message.canEdit,
                    canPick: !!message.canPick,
                    canHighlight: !!message.canHighlight,
                };
                el.pick.disabled = !state.caps.canPick;
                el.pick.title = state.caps.canPick
                    ? 'Pick element (Ctrl+Shift+P)'
                    : 'Element picking is not available in this app';
                el.layoutBtn.disabled = !state.caps.canHighlight;
                el.focusBtn.disabled = false;
                break;

            case 'tree': {
                state.roots = message.tree.nodes || [];
                resetPreviews();
                // First load has nothing expanded; open the first root so the
                // panel is not an empty box.
                if (state.expanded.size === 0 && state.roots.length > 0) {
                    state.expanded.add(state.roots[0].handle);
                }
                rebuildRows();
                requestFullTreeIfFiltering();
                for (const handle of state.expanded) {
                    const node = nodeForHandle(handle);
                    if (node && (node.childCount || 0) > 0 && !(node.children || []).length) {
                        vscode.postMessage({ type: 'expandNode', handle: handle });
                    }
                }
                scheduleRender();
                break;
            }

            case 'previews': {
                for (const row of message.previews || []) {
                    state.previews[row.handle] = {
                        text: row.preview || row.automationId || '',
                        line: row.line,
                    };
                }
                // A caption that arrives or changes can add or drop a match.
                if (state.filter.trim()) { rebuildRows(); }
                scheduleRender();
                break;
            }

            case 'properties': {
                // Expansion and staging are scoped to one element; carrying
                // them to the next selection would show another element's
                // pending edit.
                const sameElement = !!state.properties
                    && state.properties.handle === message.properties.handle;
                const previousProps = sameElement ? state.properties.props : null;
                if (!sameElement) {
                    state.openProps = new Set();
                    state.staged = Object.create(null);
                    state.applied = Object.create(null);
                    state.bindings = Object.create(null);
                    state.resources = Object.create(null);
                    state.restoreConfirm = null;
                }
                state.properties = {
                    handle: message.properties.handle,
                    props: message.properties.props,
                    source: message.properties.source,
                    canEdit: message.properties.canEdit,
                };
                if (sameElement) {
                    dropRestoredBindingEdits(message.properties.handle, message.properties.props);
                    refreshOpenDiagnostics(previousProps);
                    // A reload means a value changed, and the caption may show it.
                    refreshPreview(message.properties.handle);
                }
                renderProperties();
                break;
            }

            case 'propertiesError':
                state.properties = { error: message.message };
                renderProperties();
                break;

            case 'setPropertyFailed':
                forgetRejectedEdit(message.handle, message.name);
                break;

            case 'selectHandle':
                state.filter = '';
                el.filter.value = '';
                setView('tree');
                selectHandle(message.handle, { silent: true });
                revealHandle(message.handle);
                break;

            case 'showInspect':
                setView('tree');
                break;

            case 'showComments':
                setView('comments');
                break;

            case 'pickStateChanged':
                state.picking = !!message.armed;
                updatePickButton();
                break;

            case 'treeInvalidated':
                setStatus(
                    message.reason
                        ? 'Visual tree reloaded (' + message.reason + ').'
                        : 'Visual tree reloaded.',
                    'info',
                );
                setTimeout(function () { setStatus(''); }, 3000);
                break;

            case 'comments':
                state.comments = message.comments || [];
                renderComments();
                break;

            case 'commentError':
                showComposeError(message.message || 'Adding the comment failed.');
                updateCompose();
                break;

            case 'commentAdded':
                commentAdded();
                break;

            case 'surfaces':
                state.surfaces = message.surfaces || [];
                renderSurfaces();
                break;

            case 'binding':
                state.bindings[message.name] = message.binding;
                renderProperties();
                break;

            case 'bindingRestoreConfirm':
                state.restoreConfirm = message.name;
                state.restoreConfirmScope = message.scope || '';
                renderProperties();
                break;

            case 'resource':
                state.resources[message.name] = message.resource;
                renderProperties();
                break;

            case 'layout':
                state.layout = message.layout;
                renderProperties();
                break;

            case 'focusChanged':
                if (state.focusTracking && message.handle) {
                    showFocusNotice('Focus moved to ' + (message.label || message.handle));
                    selectHandle(message.handle, { silent: false });
                    revealHandle(message.handle);
                }
                break;
        }
    });

    renderProperties();
    renderComments();
    renderSurfaces();
    vscode.postMessage({ type: 'ready' });`;
