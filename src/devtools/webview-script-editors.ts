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

    function closeDrop() {
        if (!openDrop) { return; }
        openDrop.menu.classList.remove('open');
        openDrop.btn.setAttribute('aria-expanded', 'false');
        openDrop = null;
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
        btn.setAttribute('aria-label', ariaLabel);

        const label = document.createElement('span');
        label.className = 'pdrop-label';
        label.textContent = current ? current.label : (value || '');
        btn.appendChild(label);

        const chev = document.createElement('span');
        chev.className = 'pdrop-chev';
        chev.textContent = '\u25BE';
        chev.setAttribute('aria-hidden', 'true');
        btn.appendChild(chev);
        root.appendChild(btn);

        const menu = document.createElement('div');
        menu.className = 'custom-dropdown-menu';
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-label', ariaLabel);

        const rows = items.map(function (item) {
            const row = document.createElement('div');
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

        const editable = payload.canEdit
            && state.caps.canEdit
            && !prop.redacted
            && !READONLY_EDIT_KINDS.has(prop.editKind || '')
            && !(prop.children && prop.children.length);

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
                    state.staged[prop.name] = { kind: picked };
                    renderProperties();
                },
            ));

            card.appendChild(buildEditor(kind, prop, payload));

            const staged = state.staged[prop.name];
            if (staged) { card.appendChild(buildStaged(prop, staged)); }

            if (isEdited(payload.handle, prop.name)) {
                card.appendChild(caption('EDITED', true));
                const was = document.createElement('div');
                was.className = 'pwit-text';
                was.textContent = 'was ' + state.edited[editKey(payload.handle, prop.name)];
                card.appendChild(was);
            }
        }

        if (prop.binding) { card.appendChild(buildDiagnosis(prop, payload)); }
        return card;
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
        box.appendChild(body);

        const actions = document.createElement('div');
        actions.className = 'prow-actions';

        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'pbtn primary';
        apply.textContent = 'Apply';
        apply.addEventListener('click', function () {
            state.applied[prop.name] = staged.kind;
            delete state.staged[prop.name];
            renderProperties();
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

        const info = state.bindings[prop.name];
        if (!info) {
            host.appendChild(note('Diagnosing...'));
            return host;
        }
        if (info.unavailable) {
            host.appendChild(note(info.message || 'Binding diagnosis is not available for this app.'));
            return host;
        }

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
                + ', not just this property. Press again to go ahead.'));
        } else {
            host.appendChild(note('Re-applies every x:Bind on this page.'));
        }
        return host;
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
        input.type = 'text';
        input.className = 'pfield';
        input.value = prop.value;
        // 'number' is a distinct engine editKind; keep the text box but ask
        // touch keyboards for digits.
        if (prop.editKind === 'number') { input.inputMode = 'decimal'; }
        input.setAttribute('aria-label', prop.name);
        input.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                commit(payload.handle, prop, input.value);
            } else if (event.key === 'Escape') {
                input.value = prop.value;
                input.blur();
            }
        });
        input.addEventListener('blur', function () {
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
        swatch.setAttribute('aria-label', prop.name + ' colour');
        if (hex) { swatch.value = hex; }
        host.appendChild(swatch);

        const text = document.createElement('input');
        text.type = 'text';
        text.className = 'pfield';
        text.value = prop.value;
        text.setAttribute('aria-label', prop.name);
        host.appendChild(text);

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
        return host;
    }

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
            input.title = names[i];
            inputs.push(input);
            host.appendChild(input);
        }

        function send() {
            commit(payload.handle, prop, inputs.map(function (i) { return i.value.trim(); }).join(','));
        }
        for (const input of inputs) {
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
        input.placeholder = 'type a key';
        // The engine already knows the authored key when the app used one.
        if (prop.authoredKind === 'staticResource' || prop.authoredKind === 'themeResource') {
            input.value = prop.authoredKey || '';
        }
        input.setAttribute('aria-label', prop.name + ' resource key');
        host.appendChild(input);

        const resolved = document.createElement('div');
        resolved.className = 'pnote';
        const found = state.resources[prop.name];
        if (found) {
            resolved.textContent = found.resolved
                ? 'currently ' + found.key + ' = ' + found.resolved
                : 'This value does not come from a resource.';
        }
        host.appendChild(resolved);

        input.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter') { return; }
            event.preventDefault();
            const key = input.value.trim();
            if (key) { commit(payload.handle, prop, '{StaticResource ' + key + '}'); }
        });

        host.appendChild(note('the key, as text. The resolved value is on the row above.'));
        return host;
    }

    function bindingEditor(prop, payload) {
        const host = document.createElement('div');

        host.appendChild(caption('PATH'));
        const path = document.createElement('input');
        path.type = 'text';
        path.className = 'pfield';
        path.placeholder = 'a path on the DataContext';
        path.value = authoredPath(prop);
        path.setAttribute('aria-label', prop.name + ' binding path');
        host.appendChild(path);

        host.appendChild(caption('MODE', true));
        let mode = authoredMode(prop);
        host.appendChild(dropdown(
            ['OneTime', 'OneWay', 'TwoWay'],
            mode,
            prop.name + ' binding mode',
            function (picked) { mode = picked; },
        ));

        const actions = document.createElement('div');
        actions.className = 'prow-actions';
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'pbtn primary';
        apply.textContent = 'Apply binding';
        apply.addEventListener('click', function () {
            commit(payload.handle, prop, '{Binding ' + path.value.trim() + ', Mode=' + mode + '}');
        });
        actions.appendChild(apply);
        host.appendChild(actions);

        host.appendChild(note('applied to the running app only. Your .xaml is not changed.'));
        return host;
    }

    /**
     * x:Bind is compiled, so it cannot be rewritten at runtime. The native
     * window shows the expression read-only and offers the one escape hatch:
     * replace it with a runtime {Binding}.
     */
    function xbindEditor(prop, payload) {
        const host = document.createElement('div');

        const expr = document.createElement('div');
        expr.className = 'pwit-text';
        expr.textContent = prop.binding || prop.value;
        host.appendChild(expr);

        host.appendChild(note('x:Bind is compiled into the app, so DevTools cannot change it here.'));

        const actions = document.createElement('div');
        actions.className = 'prow-actions';
        const exit = document.createElement('button');
        exit.type = 'button';
        exit.className = 'pbtn';
        exit.textContent = 'Switch to {Binding}...';
        exit.addEventListener('click', function () {
            state.staged[prop.name] = { kind: 'binding' };
            renderProperties();
        });
        actions.appendChild(exit);
        host.appendChild(actions);
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
        const key = editKey(handle, prop.name);
        if (opts && opts.restore) {
            delete state.edited[key];
        } else if (!Object.prototype.hasOwnProperty.call(state.edited, key)) {
            // Captured before the write so "Restore original" has somewhere to
            // go back to; the engine does not keep this for us.
            state.edited[key] = prop.value;
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
