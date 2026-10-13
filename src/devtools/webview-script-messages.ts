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
                break;

            case 'tree': {
                state.roots = message.tree.nodes || [];
                // First load has nothing expanded; open the first root so the
                // panel is not an empty box.
                if (state.expanded.size === 0 && state.roots.length > 0) {
                    state.expanded.add(state.roots[0].handle);
                }
                rebuildRows();
                scheduleRender();
                break;
            }

            case 'properties':
                // Expansion and staging are scoped to one element; carrying
                // them to the next selection would show another element's
                // pending edit.
                if (!state.properties || state.properties.handle !== message.properties.handle) {
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
                renderProperties();
                break;

            case 'propertiesError':
                state.properties = { error: message.message };
                renderProperties();
                break;

            case 'selectHandle':
                selectHandle(message.handle, { silent: true });
                revealHandle(message.handle);
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
