/**
 * Webview script fragment: property editors.
 *
 * The themed dropdown, the colour picker, the text, number, enum and
 * multi-field editors, and the staged commit path that posts an edit back to
 * the host.
 */

export const EDITORS_FRAGMENT = `    /* ── Dropdown ───────────────────────────────────────────────────────
       A native select renders its popup through the OS, which ignores the
       VS Code theme, so the manifest editor replaced it with plain elements
       long ago. This is that control, as a value picker: the shared classes
       give the popup, and the trigger carries the current value.
       ─────────────────────────────────────────────────────────────────── */

    /** The menu currently open, so opening one closes the last. */
    let openDrop = null;
    let propsRenderPending = false;
    let dropSeq = 0;

    function closeDrop() {
        if (!openDrop) { return; }
        openDrop.menu.classList.remove('open');
        openDrop.btn.setAttribute('aria-expanded', 'false');
        openDrop.btn.removeAttribute('aria-activedescendant');
        openDrop = null;
        // Flush a refresh held while the menu was open, unless another menu opened meanwhile.
        if (propsRenderPending) {
            queueMicrotask(function () { if (!openDrop && propsRenderPending) { renderProperties(); } });
        }
    }

    document.addEventListener('click', function (ev) {
        if (openDrop && !openDrop.root.contains(ev.target)) { closeDrop(); }
    });

    /**
     * options: array of strings, or of { value, label } pairs.
     * onPick receives the chosen value. Returns the root element.
     */
    function dropdown(options, value, ariaLabel, onPick) {
        const items = options.map(function (o) {
            return typeof o === 'string' ? { value: o, label: o } : o;
        });
        const current = items.filter(function (i) { return i.value === value; })[0];

        const root = document.createElement('div');
        root.className = 'custom-dropdown pdrop';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pdrop-btn';
        btn.setAttribute('aria-haspopup', 'listbox');
        btn.setAttribute('aria-expanded', 'false');
        // A select-only combobox: the label names its purpose and the shown value is read as its value.
        btn.setAttribute('role', 'combobox');
        btn.setAttribute('aria-label', ariaLabel);
        const shown = current ? current.label : (value || '');
        const menuId = 'pdrop-' + (++dropSeq);
        btn.setAttribute('aria-controls', menuId);

        const label = document.createElement('span');
        label.className = 'pdrop-label';
        label.textContent = shown;
        btn.appendChild(label);

        const chev = document.createElement('span');
        chev.className = 'pdrop-chev';
        chev.textContent = '\\uE70D';
        chev.setAttribute('aria-hidden', 'true');
        btn.appendChild(chev);
        root.appendChild(btn);

        const menu = document.createElement('div');
        menu.className = 'custom-dropdown-menu';
        menu.id = menuId;
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-label', ariaLabel);

        const rows = items.map(function (item, i) {
            const row = document.createElement('div');
            row.id = menuId + '-' + i;
            row.className = 'custom-dropdown-item'
                + (item.value === value ? ' selected' : '');
            row.setAttribute('role', 'option');
            row.setAttribute('data-value', item.value);
            row.setAttribute('aria-selected', item.value === value ? 'true' : 'false');
            row.textContent = item.label;
            row.addEventListener('click', function (ev) {
                ev.stopPropagation();
                closeDrop();
                btn.focus();
                if (item.value !== value) { onPick(item.value); }
            });
            menu.appendChild(row);
            return row;
        });
        root.appendChild(menu);

        // Tracks the keyboard cursor, which starts on the current value.
        let focused = Math.max(0, items.map(function (i) { return i.value; }).indexOf(value));

        function paintFocus() {
            rows.forEach(function (row, i) { row.classList.toggle('focused', i === focused); });
            const row = rows[focused];
            if (row) { btn.setAttribute('aria-activedescendant', row.id); }
            if (row && row.scrollIntoView) { row.scrollIntoView({ block: 'nearest' }); }
        }

        function open() {
            closeDrop();
            menu.classList.add('open');
            btn.setAttribute('aria-expanded', 'true');
            openDrop = { root: root, menu: menu, btn: btn };
            paintFocus();
        }

        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (menu.classList.contains('open')) { closeDrop(); } else { open(); }
        });

        root.addEventListener('keydown', function (ev) {
            const isOpen = menu.classList.contains('open');
            if (ev.key === 'Escape') {
                if (!isOpen) { return; }
                closeDrop();
                btn.focus();
            } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                if (!isOpen) { open(); return; }
                focused = (focused + (ev.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
                paintFocus();
            } else if (ev.key === 'Enter' || ev.key === ' ') {
                if (!isOpen) { open(); } else if (rows[focused]) { rows[focused].click(); }
            } else {
                return;
            }
            ev.preventDefault();
        });

        return root;
    }

    /**
     * The expansion card. Block order mirrors the native window exactly:
     * KIND, the selected kind's editor, any staged change, EDITED, then
     * DIAGNOSIS.
     */
    function buildExpansion(prop, payload) {
        const card = document.createElement('div');
        card.className = 'pexpand';

        // A brush row edits as a whole colour; its sub-properties cannot be written over the RPC.
        const editable = payload.canEdit
            && state.caps.canEdit
            && !prop.redacted
            && !prop.parent
            && !READONLY_EDIT_KINDS.has(prop.editKind || '')
            && (!(prop.children && prop.children.length) || prop.editKind === 'color');

        if (editable) {
            const kinds = kindsFor(prop);
            const kind = activeKind(prop);

            card.appendChild(caption('KIND'));
            // Choosing a kind stages the change; nothing reaches the app until
            // Apply. Switching representation can destroy a binding, so the
            // native window refuses to do it as a side effect of a dropdown.
            card.appendChild(dropdown(
                kinds.map(function (k) { return { value: k, label: KIND_LABELS[k] || k }; }),
                kind,
                'Kind of value for ' + prop.name,
                function (picked) {
                    if (picked === currentKind(prop) || ['binding', 'xbind', 'resource'].includes(picked)) {
                        delete state.staged[prop.name];
                        state.applied[prop.name] = picked;
                    } else {
                        state.staged[prop.name] = { kind: picked };
                    }
                    renderProperties();
                },
            ));

            const staged = state.staged[prop.name];
            card.appendChild(buildEditor(kind,
                staged && staged.value !== undefined ? Object.assign({}, prop, { value: staged.value }) : prop,
                payload));
            if (staged) { card.appendChild(buildStaged(prop, staged)); }

            if (isEdited(payload.handle, prop.name)) {
                const record = state.edited[editKey(payload.handle, prop.name)];
                card.appendChild(caption('EDITED', true));
                const was = document.createElement('div');
                was.className = 'pwit-text';
                was.textContent = record.wasSet
                    ? 'was ' + record.value
                    : 'was ' + record.value + ' (not set on this element)';
                card.appendChild(was);
            }

            if (prop.valueSource === 'DevTools' && isResourceAuthored(prop)) {
                card.appendChild(note('A live value replaced ' + (prop.authored || 'the resource reference')
                    + '. Restore original writes the old value back but cannot reconnect the resource; restart the app for that.'));
            }

            card.appendChild(buildValueActions(prop, payload));
        }

        if (prop.chain && prop.chain.length > 1) { card.appendChild(buildChain(prop, payload)); }
        if (prop.binding || bindingReplaced(prop)) { card.appendChild(buildDiagnosis(prop, payload)); }
        return card;
    }

    /** Every source competing for the value, with the winner marked, as the native window lists it. */
    function buildChain(prop, payload) {
        const host = document.createElement('div');
        host.className = 'pchain';
        host.appendChild(caption('PRECEDENCE', true));
        const edited = isEdited(payload.handle, prop.name);
        for (const entry of prop.chain) {
            const line = document.createElement('div');
            line.className = 'pwit-text' + (entry.winner ? ' winner' : '');
            // A bare handle number means nothing to a reader; name the type instead.
            const value = /^\\d{10,}$/.test(entry.value || '') ? shortTypeName(prop.valueType || '') : entry.value;
            let text = (entry.winner ? '\\u25B8 ' : '   ') + entry.source + '  ' + value;
            if (entry.winner && entry.source === 'Local' && edited) {
                text += '   set by DevTools';
            } else if (entry.file && entry.line) {
                text += '   ' + String(entry.file).split(/[\\\\/]/).pop() + ':' + entry.line;
            }
            line.textContent = text;
            host.appendChild(line);
        }
        return host;
    }

    /** Restore original and Clear value, offered only where they can act. */
    function buildValueActions(prop, payload) {
        const actions = document.createElement('div');
        actions.className = 'prow-actions';

        if (isEdited(payload.handle, prop.name)) {
            const restore = document.createElement('button');
            restore.type = 'button';
            restore.className = 'pbtn';
            restore.textContent = 'Restore original';
            restore.setAttribute('aria-label', 'Restore original value of ' + prop.name);
            restore.addEventListener('click', function () { restoreOriginal(payload.handle, prop); });
            actions.appendChild(restore);
        }

        if (canClear(prop, payload)) {
            const clear = document.createElement('button');
            clear.type = 'button';
            clear.className = 'pbtn';
            clear.textContent = 'Clear value';
            clear.setAttribute('aria-label', 'Clear value of ' + prop.name);
            clear.addEventListener('click', function () { clearValue(payload.handle, prop); });
            actions.appendChild(clear);
        }
        return actions;
    }

    /** What a literal write costs when the value currently follows a binding or resource. */
    function linkLossWarning(prop, nextKind) {
        if (nextKind === 'binding' || nextKind === 'xbind' || nextKind === 'resource') { return ''; }
        const now = currentKind(prop);
        if (now === 'binding' || now === 'xbind') {
            return 'It replaces the binding, so its source stops updating this property until you use Restore binding.';
        }
        if (now === 'resource') {
            return 'It replaces ' + (prop.authored || 'the resource reference') + ', which cannot be reconnected live; restart the app to get it back.';
        }
        return '';
    }

    function buildStaged(prop, staged) {
        const box = document.createElement('div');
        box.className = 'pstaged';

        const head = document.createElement('div');
        head.className = 'pstaged-head';
        head.textContent = 'Staged, not applied';
        box.appendChild(head);

        const body = document.createElement('div');
        body.className = 'pstaged-body';
        body.textContent = 'This will write the value as ' + (KIND_LABELS[staged.kind] || staged.kind) + '.';
        const warning = linkLossWarning(prop, staged.kind);
        if (warning) { body.textContent += ' ' + warning; }
        box.appendChild(body);

        const actions = document.createElement('div');
        actions.className = 'prow-actions';

        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'pbtn primary';
        apply.textContent = 'Apply';
        apply.addEventListener('click', function () {
            commit(state.properties.handle, prop,
                staged.value === undefined ? prop.value : staged.value, { apply: true });
        });
        actions.appendChild(apply);

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'pbtn';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', function () {
            delete state.staged[prop.name];
            renderProperties();
        });
        actions.appendChild(cancel);

        box.appendChild(actions);
        return box;
    }

    /** BINDING: status, source, path and mode, current value, and the walk. */
    function buildDiagnosis(prop, payload) {
        const host = document.createElement('div');
        host.appendChild(caption('BINDING', true));

        // A live write leaves nothing to diagnose; only Restore applies, as in the native window.
        const replaced = bindingReplaced(prop);
        const info = replaced ? null : state.bindings[prop.name];
        if (replaced) {
            host.appendChild(note('A live edit replaced this binding; its source no longer updates ' + prop.name + '.'));
        } else if (!info) {
            host.appendChild(note('Diagnosing...'));
            return host;
        } else if (info.unavailable) {
            host.appendChild(note(info.message || 'Binding diagnosis is not available for this app.'));
            return host;
        }
        if (info) { appendDiagnosis(host, info); }
        if (!replaced) { return host; }

        const actions = document.createElement('div');
        actions.className = 'prow-actions';
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'pbtn';
        restore.textContent = 'Restore binding';
        restore.addEventListener('click', function () {
            vscode.postMessage({
                type: 'restoreBinding',
                handle: payload.handle,
                name: prop.name,
                // Second press is the consent the engine asks for.
                confirm: state.restoreConfirm === prop.name,
            });
        });
        actions.appendChild(restore);
        host.appendChild(actions);

        if (state.restoreConfirm === prop.name) {
            restore.textContent = 'Restore binding (confirm)';
            restore.classList.add('needs-confirm');
            host.appendChild(note(
                'This re-pushes every compiled binding on '
                + (state.restoreConfirmScope || 'the owning page')
                + ' and can undo other live edits there. Press again to go ahead.'));
        } else if (prop.authoredKind === 'xBind') {
            host.appendChild(note('Re-applies every x:Bind on this page.'));
        }
        return host;
    }

    /** Status, source, path and mode, value, and the path walk of a live binding. */
    function appendDiagnosis(host, info) {
        const grid = document.createElement('div');
        grid.className = 'pbind-grid';
        addPair(grid, 'Status', info.status || 'unknown', info.ok === false);
        addPair(grid, 'Source', info.source || '(none)', false);
        addPair(grid, 'Path \\u00B7 Mode', (info.path || '') + ' \\u00B7 ' + (info.mode || ''), false);
        addPair(grid, 'Value', info.value === undefined ? '' : String(info.value), false);
        host.appendChild(grid);

        if (info.walk && info.walk.length) {
            const walk = document.createElement('div');
            walk.className = 'pwalk';
            for (const step of info.walk) {
                const row = document.createElement('div');
                row.className = 'pwit-text';
                row.textContent = step;
                walk.appendChild(row);
            }
            host.appendChild(walk);
        }
    }

    function addPair(grid, key, value, bad) {
        const k = document.createElement('div');
        k.className = 'pbind-key';
        k.textContent = key;
        grid.appendChild(k);

        const v = document.createElement('div');
        if (bad) { v.className = 'pbind-bad'; }
        v.textContent = value;
        grid.appendChild(v);
    }

    /**
     * Exactly one editor is shown at a time, selected by KIND. This mirrors the
     * native window, where all eight editors exist in the template and
     * visibility — not construction — picks the live one.
     */
    function buildEditor(kind, prop, payload) {
        switch (kind) {
            case 'bool': return boolEditor(prop, payload);
            case 'enum': return enumEditor(prop, payload);
            case 'color': return colorEditor(prop, payload);
            case 'fields': return fieldsEditor(prop, payload);
            case 'resource': return resourceEditor(prop, payload);
            case 'binding': return bindingEditor(prop, payload);
            case 'xbind': return xbindEditor(prop, payload);
            default: return textEditor(prop, payload);
        }
    }

    function textEditor(prop, payload) {
        const input = document.createElement('input');
        const wasStaged = !!state.staged[prop.name];
        input.type = 'text';
        input.className = 'pfield';
        input.value = prop.value;
        // 'number' is a distinct engine editKind; keep the text box but ask
        // touch keyboards for digits.
        if (prop.editKind === 'number') { input.inputMode = 'decimal'; }
        input.setAttribute('aria-label', prop.name);
        input.dataset.draft = prop.name;
        // Lets a re-render for another element save this draft where it was typed.
        input.saveDraft = function (value) {
            if (!wasStaged && value !== prop.value) { commit(payload.handle, prop, value); }
        };
        input.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                input.dataset.committed = '1';
                commit(payload.handle, prop, input.value);
            } else if (event.key === 'Escape') {
                input.value = prop.value;
                input.blur();
            }
        });
        input.addEventListener('input', function () {
            delete input.dataset.committed;
            if (state.staged[prop.name]) { state.staged[prop.name].value = input.value; }
        });
        input.addEventListener('blur', function () {
            // A re-render replaces this box; that is not the user leaving it.
            if (propsRendering) { return; }
            // A committed box may still show the pre-edit payload; never write that back.
            if (input.dataset.committed === '1') { return; }
            if (input.value !== prop.value) { commit(payload.handle, prop, input.value); }
        });
        return input;
    }

    function boolEditor(prop, payload) {
        const label = document.createElement('label');
        label.className = 'pnote';

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = /^true$/i.test(String(prop.value));
        box.setAttribute('aria-label', prop.name);
        box.addEventListener('change', function () {
            commit(payload.handle, prop, box.checked ? 'True' : 'False');
        });
        label.appendChild(box);
        label.appendChild(document.createTextNode(box.checked ? ' True' : ' False'));
        return label;
    }

    function enumEditor(prop, payload) {
        return dropdown(
            enumOptionsFor(prop) || [],
            prop.value,
            prop.name,
            function (picked) { commit(payload.handle, prop, picked); },
        );
    }

    function colorEditor(prop, payload) {
        const host = document.createElement('div');
        host.className = 'pcolor';

        const hex = normalizeHex(prop.value);

        const swatch = document.createElement('input');
        swatch.type = 'color';
        swatch.className = 'pswatch';
        swatch.setAttribute('aria-label', prop.name + ' color');
        if (hex) { swatch.value = hex; }
        host.appendChild(swatch);

        const text = document.createElement('input');
        text.type = 'text';
        text.className = 'pfield';
        text.value = prop.value;
        text.setAttribute('aria-label', prop.name);
        text.dataset.draft = prop.name;
        host.appendChild(text);

        let originalText;
        swatch.addEventListener('coloropen', function () { originalText = text.value; });
        swatch.addEventListener('colorcancel', function () { text.value = originalText; });
        swatch.addEventListener('input', function () {
            text.value = swatch.value;
        });
        swatch.addEventListener('change', function () {
            commit(payload.handle, prop, text.value);
        });
        text.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                commit(payload.handle, prop, text.value);
            }
        });
        text.addEventListener('input', function () {
            delete text.dataset.committed;
            if (state.staged[prop.name]) { state.staged[prop.name].value = text.value; }
        });

        // One-click common values; each goes through commit, so staging still applies.
        const presets = document.createElement('div');
        presets.className = 'pcolor-presets';
        presets.setAttribute('role', 'group');
        presets.setAttribute('aria-label', prop.name + ' color presets');
        for (const preset of COLOR_PRESETS) {
            const chip = document.createElement('button');
            chip.type = 'button';
            const transparent = preset.value === '#00000000';
            chip.className = 'pcolor-preset' + (transparent ? ' transparent' : '');
            chip.style.backgroundColor = transparent ? 'transparent' : '#' + preset.value.slice(3);
            chip.title = preset.name + ' (' + preset.value + ')';
            chip.setAttribute('aria-label', 'Set ' + prop.name + ' to ' + preset.name);
            chip.addEventListener('click', function () {
                text.value = preset.value;
                if (preset.value !== '#00000000') { swatch.value = '#' + preset.value.slice(3); }
                commit(payload.handle, prop, preset.value);
            });
            presets.appendChild(chip);
        }
        host.appendChild(presets);
        return host;
    }

    /** The Windows default palette, plus the values people reach for when debugging layout. */
    const COLOR_PRESETS = [
        { name: 'Transparent', value: '#00000000' },
        { name: 'Black', value: '#FF000000' },
        { name: 'White', value: '#FFFFFFFF' },
        { name: 'Gray', value: '#FF808080' },
        { name: 'Red', value: '#FFE81123' },
        { name: 'Orange', value: '#FFF7630C' },
        { name: 'Yellow', value: '#FFFFB900' },
        { name: 'Green', value: '#FF107C10' },
        { name: 'Blue', value: '#FF0078D4' },
        { name: 'Purple', value: '#FF881798' },
    ];

    /** Accepts #RGB, #RRGGBB and #AARRGGBB; the picker only understands the middle one. */
    function normalizeHex(value) {
        const match = /^#([0-9a-f]{3,8})$/i.exec(String(value || '').trim());
        if (!match) { return null; }
        const digits = match[1];
        if (digits.length === 8) { return '#' + digits.slice(2); }
        if (digits.length === 6) { return '#' + digits; }
        if (digits.length === 3) {
            return '#' + digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2];
        }
        return null;
    }

    function fieldsEditor(prop, payload) {
        const names = fieldNamesFor(prop) || [];
        const parts = String(prop.value || '').split(',');

        const host = document.createElement('div');
        host.className = 'pfields';
        const inputs = [];

        for (let i = 0; i < names.length; i++) {
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'pfield';
            input.value = (parts[i] === undefined ? (parts[0] || '') : parts[i]).trim();
            input.setAttribute('aria-label', prop.name + ' ' + names[i]);
            input.dataset.draft = prop.name + '/' + i;
            input.dataset.draftGroup = prop.name;
            input.title = names[i];
            inputs.push(input);
            host.appendChild(input);
        }

        function send() {
            commit(payload.handle, prop, inputs.map(function (i) { return i.value.trim(); }).join(','));
        }
        for (const input of inputs) {
            input.addEventListener('input', function () {
                inputs.forEach(function (field) { delete field.dataset.committed; });
                if (state.staged[prop.name]) {
                    state.staged[prop.name].value = inputs.map(function (field) { return field.value.trim(); }).join(',');
                }
            });
            input.addEventListener('keydown', function (event) {
                if (event.key === 'Enter') { event.preventDefault(); send(); }
            });
        }
        return host;
    }

    function resourceEditor(prop, payload) {
        const host = document.createElement('div');

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'pfield';
        input.readOnly = true;
        input.value = prop.authoredKey || '';
        input.setAttribute('aria-label', prop.name + ' resource key');
        host.appendChild(input);

        const resolved = document.createElement('div');
        resolved.className = 'pnote';
        const found = state.resources[prop.name];
        // Resource.resolve returns the concrete value, not a key, and a bare object handle for brushes.
        if (found && found.resolved && isResourceAuthored(prop)) {
            const value = /^\\d{10,}$/.test(found.resolved) ? prop.value : found.resolved;
            resolved.textContent = 'currently ' + (prop.authoredKey || found.key) + ' = ' + value;
        }
        host.appendChild(resolved);

        host.appendChild(note('Live resource assignment is not supported. Pick another kind to set a value, or change the key in XAML.'));
        return host;
    }

    /**
     * Shows the live binding read-only. The RPC has no way to install a
     * binding, so writing markup would only set the literal text.
     */
    function bindingEditor(prop, payload) {
        const host = document.createElement('div');

        host.appendChild(caption('PATH'));
        const path = document.createElement('input');
        path.type = 'text';
        path.className = 'pfield';
        path.readOnly = true;
        path.value = authoredPath(prop);
        path.setAttribute('aria-label', prop.name + ' binding path');
        host.appendChild(path);

        host.appendChild(caption('MODE', true));
        const mode = document.createElement('div');
        mode.className = 'pwit-text';
        mode.setAttribute('aria-label', prop.name + ' binding mode');
        // Markup often omits Mode; the live binding then reports the effective one, so both views agree.
        const live = state.bindings[prop.name];
        mode.textContent = authoredMode(prop) || (live && live.mode && live.mode !== 'Default' ? live.mode : '') || 'Default';
        host.appendChild(mode);

        host.appendChild(note('Live binding changes are not supported. Change the binding in XAML and restart the app.'));
        return host;
    }

    /**
     * x:Bind is compiled, so it cannot be rewritten at runtime. The RPC cannot
     * install a runtime {Binding} either, so the expression is read-only.
     */
    function xbindEditor(prop, payload) {
        const host = document.createElement('div');

        const expr = document.createElement('div');
        expr.className = 'pwit-text';
        expr.textContent = prop.binding || prop.authored || prop.value;
        host.appendChild(expr);

        host.appendChild(note('x:Bind is compiled into the app, so DevTools cannot change it here. Pick Text to try a literal value.'));
        return host;
    }

    /** Enum-like properties render as a dropdown; booleans are treated as one. */
    function enumOptionsFor(prop) {
        if (prop.enumValues && prop.enumValues.length) { return prop.enumValues; }
        const type = (prop.valueType || '').toLowerCase();
        if (type.indexOf('boolean') !== -1) { return ['True', 'False']; }
        return null;
    }

    function commit(handle, prop, value, opts) {
        const staged = state.properties && state.properties.handle === handle && state.staged[prop.name];
        if (staged && !(opts && opts.apply)) {
            staged.value = String(value);
            return;
        }
        const key = editKey(handle, prop.name);
        if (opts && opts.restore) {
            delete state.edited[key];
        } else {
            // Captured before the write so "Restore original" has somewhere to
            // go back to; the engine does not keep this for us.
            recordOriginal(handle, prop);
        }
        if (staged) {
            state.applied[prop.name] = staged.kind;
            delete state.staged[prop.name];
        }
        for (const box of Array.from(el.propsViewport.querySelectorAll('[data-draft]'))) {
            if ((box.dataset.draftGroup || box.dataset.draft) === prop.name) { box.dataset.committed = '1'; }
        }
        vscode.postMessage({
            type: 'setProperty',
            handle: handle,
            name: prop.name,
            value: String(value),
            // The engine wants the writable type ("Double"), not the full
            // runtime type name reported in valueType.
            writeType: prop.writeType || prop.valueType,
        });
        // Reflect the edit immediately; the host round-trip only confirms it.
        renderProperties();
    }`;
