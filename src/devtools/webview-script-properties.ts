/**
 * Webview script fragment: the property grid.
 *
 * Covers curation into categories, the identity header and ancestor
 * breadcrumb, the margin/padding/content layout box and the rendering of
 * individual property rows. The editors those rows host live in the editors
 * fragment.
 */

export const PROPERTIES_FRAGMENT = `
    // ───────────────────────── property grid ─────────────────────────

    /* ── Curation helpers (ports of the native predicates) ── */

    function isCoreProp(name) { return CORE_PROPS.has(name); }

    /** Native SourceIsSetHere: written on this element, not inherited. */
    function sourceIsSetHere(source) {
        return source === 'Local' || source === 'Binding';
    }

    function isAuthored(prop) {
        return !!(prop.authoredKind && String(prop.authoredKind).length > 0);
    }

    /** Native OnlySetKeeps: a no-op outside the Set view. */
    function onlySetKeeps(prop) {
        if (state.propView !== 'set') { return true; }
        return sourceIsSetHere(prop.valueSource) || isAuthored(prop)
            || STYLE_SOURCES.has(prop.valueSource);
    }

    /** Native PropRowIsRendered. Order of the clauses is load-bearing. */
    function propRowIsRendered(prop) {
        if (!onlySetKeeps(prop)) { return false; }
        if (state.propView === 'set' || state.propShowAll || state.propFilter) { return true; }
        return isCoreProp(prop.name) || sourceIsSetHere(prop.valueSource) || isAuthored(prop);
    }

    /** The haystack the property filter searches: name, value and authored text. */
    function propLabel(prop) {
        return (String(prop.name || '') + ' ' + String(prop.value || '') + ' '
            + String(prop.authored || '')).toLowerCase();
    }

    function propMatchesFilter(prop) {
        if (!state.propFilter) { return true; }
        return propLabel(prop).indexOf(state.propFilter) !== -1;
    }

    /** Native PropGroupIndex. Unknown names, including attached properties
        such as AutomationProperties.*, fall through to "Other". */
    function propGroupIndex(prop) {
        if (state.propView === 'set') {
            return STYLE_SOURCES.has(prop.valueSource) && !isAuthored(prop) ? 1 : 0;
        }
        for (let i = 0; i < PROP_GROUPS.length - 1; i++) {
            if (PROP_GROUPS[i].names.has(prop.name)) { return i; }
        }
        return PROP_GROUPS.length - 1;
    }

    function groupTitle(index) {
        if (state.propView === 'set') { return SET_VIEW_GROUPS[index]; }
        return PROP_GROUPS[index].title;
    }

    function groupCount() { return state.propView === 'set' ? 2 : PROP_GROUPS.length; }

    /** Core first, then alphabetical within each partition. */
    function compareProps(a, b) {
        const ca = isCoreProp(a.name);
        const cb = isCoreProp(b.name);
        if (ca !== cb) { return ca ? -1 : 1; }
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    }

    function renderProperties() {
        el.propsHeader.textContent = '';
        el.propsViewport.textContent = '';
        const payload = state.properties;

        if (!payload || payload.error) {
            el.propsControls.classList.add('hidden');
            const empty = document.createElement('div');
            empty.className = 'props-empty';
            empty.textContent = payload && payload.error
                ? payload.error
                : 'Select an element to inspect its properties.';
            el.propsViewport.appendChild(empty);
            return;
        }

        el.propsHeader.appendChild(buildPropsIdentity());

        if (payload.source && payload.source.file) {
            el.propsHeader.appendChild(buildSourceLink(payload.source));
        }

        // The adorner itself is drawn over the live app; this is the numeric
        // half of it, which the in-app overlay cannot show without covering
        // the very layout it is describing.
        if (state.layoutOn && state.layout && state.layout.handle === state.selected) {
            el.propsHeader.appendChild(buildLayoutBox(state.layout, payload));
        }

        const all = payload.props || [];
        if (all.length === 0) {
            el.propsControls.classList.add('hidden');
            const empty = document.createElement('div');
            empty.className = 'props-empty';
            empty.textContent = 'This element reported no properties.';
            el.propsViewport.appendChild(empty);
            return;
        }

        el.propsControls.classList.remove('hidden');
        syncPropControls();

        let shown = 0;
        for (let g = 0; g < groupCount(); g++) {
            const members = all.filter(function (prop) {
                return propGroupIndex(prop) === g
                    && propMatchesFilter(prop)
                    && propRowIsRendered(prop);
            });
            if (members.length === 0) { continue; }
            members.sort(compareProps);
            shown += members.length;
            el.propsViewport.appendChild(buildPropGroup(groupTitle(g), members, payload));
        }

        if (shown === 0) {
            const empty = document.createElement('div');
            empty.className = 'props-empty';
            empty.textContent = state.propFilter
                ? 'No property matches this filter.'
                : 'Nothing is set on this element.';
            el.propsViewport.appendChild(empty);
        }

        el.propCount.textContent = shown + (shown === 1 ? ' property' : ' properties');
        el.propsViewport.appendChild(buildShowAllLink(all.length));
    }

    /** A collapsible group header plus its rows. */
    /**
     * Category headings are labels, not expanders. Every category stays open:
     * with a caret on each property row as well, a second level of carets read
     * as clutter without buying anything — the categories are short and the
     * filter already narrows the list.
     */
    function buildPropGroup(title, members, payload) {
        const section = document.createElement('div');
        section.className = 'pgroup-section';

        const head = document.createElement('div');
        head.className = 'pgroup';
        head.setAttribute('role', 'heading');
        head.setAttribute('aria-level', '3');

        const label = document.createElement('span');
        label.textContent = title;
        head.appendChild(label);

        const count = document.createElement('span');
        count.className = 'pgroup-count';
        count.textContent = String(members.length);
        head.appendChild(count);

        section.appendChild(head);

        const body = document.createElement('div');
        body.className = 'pgroup-body';
        for (const prop of members) {
            const rows = [];
            flattenProps([prop], 0, rows);
            for (const entry of rows) {
                body.appendChild(buildPropRow(entry.prop, entry.depth, payload));
            }
        }
        section.appendChild(body);

        return section;
    }

    /** The native's "Show all N properties" / "Show common properties only". */
    function buildShowAllLink(total) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'plink';
        link.textContent = state.propShowAll
            ? 'Show common properties only'
            : 'Show all ' + total + ' properties';
        link.addEventListener('click', function () {
            state.propShowAll = !state.propShowAll;
            persist();
            renderProperties();
        });
        return link;
    }

    function syncPropControls() {
        const set = state.propView === 'set';
        el.pviewComputed.setAttribute('aria-pressed', set ? 'false' : 'true');
        el.pviewSet.setAttribute('aria-pressed', set ? 'true' : 'false');
        el.pviewComputed.classList.toggle('active', !set);
        el.pviewSet.classList.toggle('active', set);
    }

    function setPropView(view) {
        if (state.propView === view) { return; }
        state.propView = view;
        persist();
        renderProperties();
    }

    function flattenProps(props, depth, out) {
        for (const prop of props) {
            out.push({ prop: prop, depth: depth });
            if (prop.children && prop.children.length) {
                flattenProps(prop.children, depth + 1, out);
            }
        }
    }

    function size(value) {
        if (!value) { return '-'; }
        return num(value.w) + ' \\u00D7 ' + num(value.h);
    }

    function point(value) {
        if (!value) { return '-'; }
        return num(value.x) + ', ' + num(value.y);
    }

    function num(value) {
        if (value === undefined || value === null) { return '-'; }
        return String(Math.round(value * 100) / 100);
    }

    /**
     * Box model, named and measured the way the in-app adorner draws it:
     * an outer margin rect, the element's own border box, and the content
     * rect left after padding is taken off.
     *
     * Layout.get reports sizes and offsets but carries no margin or padding
     * of its own (only the *parent's* padding), so those two come from the
     * element's Margin/Padding properties, which is the same pair the native
     * adorner reads before mapping its rects.
     */
    function buildLayoutBox(layout, payload) {
        const box = document.createElement('div');
        box.className = 'lay-box';

        const margin = thicknessOf(payload, 'Margin');
        const padding = thicknessOf(payload, 'Padding');
        const border = layout.actual || layout.render || null;

        const marginRing = ring('margin', margin);
        const paddingRing = ring('padding', padding);

        const core = document.createElement('div');
        core.className = 'lay-core';
        const content = border
            ? { w: border.w - padding[0] - padding[2], h: border.h - padding[1] - padding[3] }
            : null;
        const contentLabel = content ? size(content) : '-';
        core.textContent = 'content ' + contentLabel;
        core.setAttribute('aria-label', 'Content size ' + contentLabel);

        paddingRing.appendChild(core);
        marginRing.appendChild(paddingRing);
        box.appendChild(marginRing);

        const facts = document.createElement('dl');
        facts.className = 'lay-facts';
        if (border) { fact(facts, 'Border box', size(border)); }
        fact(facts, 'Desired', size(layout.desired));
        fact(facts, 'Offset', point(layout.offset));
        if (layout.parent) {
            const p = layout.parent;
            fact(facts, 'Parent', shortTypeName(p.type) + ' ' + size({ w: p.w, h: p.h }));
            if (p.orientation) { fact(facts, 'Orientation', p.orientation); }
            if (p.spacing) { fact(facts, 'Spacing', p.spacing); }
            if (p.padding) { fact(facts, 'Parent padding', p.padding); }
            if (p.childCount !== undefined) {
                fact(facts, 'Child', (Number(p.childIndex) + 1) + ' of ' + p.childCount);
            }
        }
        if (layout.grid) {
            const g = layout.grid;
            fact(facts, 'Grid cell', 'row ' + (g.row || '0') + ', column ' + (g.column || '0'));
            if (g.rowSpan || g.columnSpan) {
                fact(facts, 'Grid span', (g.rowSpan || '1') + ' \\u00D7 ' + (g.columnSpan || '1'));
            }
        }
        box.appendChild(facts);
        return box;
    }

    /** One labelled rect of the box model, with its four edge values. */
    function ring(name, edges) {
        const node = document.createElement('div');
        node.className = 'lay-ring ' + name;

        const label = document.createElement('div');
        label.className = 'lay-tag';
        label.textContent = name;
        node.appendChild(label);

        const sides = ['top', 'right', 'bottom', 'left'];
        // thickness order is left, top, right, bottom.
        const bySide = [edges[1], edges[2], edges[3], edges[0]];
        for (let i = 0; i < sides.length; i++) {
            const edge = document.createElement('div');
            edge.className = 'lay-edge ' + sides[i];
            edge.textContent = num(bySide[i]);
            edge.setAttribute('aria-label', name + ' ' + sides[i] + ' ' + num(bySide[i]));
            node.appendChild(edge);
        }
        return node;
    }

    /**
     * XAML thickness, as left, top, right, bottom. Accepts the one-, two- and
     * four-number forms; anything unparseable reads as zero so the diagram
     * still renders rather than collapsing.
     */
    function parseThickness(value) {
        const parts = String(value === undefined || value === null ? '' : value)
            .split(',')
            .map(function (p) { return Number(p.trim()); })
            .filter(function (n) { return isFinite(n); });
        if (parts.length === 1) { return [parts[0], parts[0], parts[0], parts[0]]; }
        if (parts.length === 2) { return [parts[0], parts[1], parts[0], parts[1]]; }
        if (parts.length === 4) { return parts; }
        return [0, 0, 0, 0];
    }

    function thicknessOf(payload, name) {
        const props = (payload && payload.props) || [];
        for (const prop of props) {
            if (prop.name === name) { return parseThickness(prop.value); }
        }
        return [0, 0, 0, 0];
    }

    /**
     * Who you are looking at: the element's type, its name when it has one,
     * and the chain of ancestors that leads to it. The native window puts this
     * above the list because a property grid on its own is ambiguous -- half a
     * dozen Borders in a page look identical until you can see their parents.
     */
    function buildPropsIdentity() {
        const host = document.createElement('div');
        host.className = 'props-identity';

        const node = nodeForHandle(state.selected);
        if (!node) { return host; }

        const badge = document.createElement('div');
        badge.className = 'props-badge';

        const type = document.createElement('span');
        type.className = 'props-type';
        type.textContent = shortTypeName(node.type);
        badge.appendChild(type);

        if (node.name) {
            const name = document.createElement('span');
            name.className = 'props-name';
            name.textContent = '#' + node.name;
            badge.appendChild(name);
        }
        host.appendChild(badge);

        const path = ancestorPath(state.selected);
        if (path.length) { host.appendChild(buildBreadcrumb(path)); }
        return host;
    }

    /** Ancestors of a handle, outermost first, excluding the element itself. */
    function ancestorPath(handle) {
        let found = null;

        function walk(node, trail) {
            if (found) { return; }
            if (node.handle === handle) { found = trail; return; }
            const next = trail.concat(node);
            for (const child of node.children || []) { walk(child, next); }
        }

        for (const root of state.roots) { walk(root, []); }
        return found || [];
    }

    function crumbLabel(node) {
        return shortTypeName(node.type) + (node.name ? ' #' + node.name : '');
    }

    /**
     * Long chains are elided to first, last two. The full path is one click
     * away rather than permanently eating the top of the pane.
     */
    function buildBreadcrumb(path) {
        const host = document.createElement('div');
        host.className = 'props-crumbs';

        const expanded = state.crumbFor === state.selected && state.crumbOpen;
        const visible = (expanded || path.length <= 4)
            ? path.map(crumbLabel)
            : [crumbLabel(path[0]), '\\u2026',
                crumbLabel(path[path.length - 2]), crumbLabel(path[path.length - 1])];

        const trail = document.createElement('span');
        trail.className = 'props-crumb-trail';
        trail.textContent = visible.join(' \\u203A ');
        trail.title = path.map(crumbLabel).join(' \\u203A ');
        host.appendChild(trail);

        if (path.length > 4) {
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'props-crumb-toggle';
            toggle.textContent = expanded
                ? 'Show less'
                : 'Show all ' + path.length + ' ancestors';
            toggle.addEventListener('click', function () {
                state.crumbFor = state.selected;
                state.crumbOpen = !expanded;
                renderProperties();
            });
            host.appendChild(toggle);
        }
        return host;
    }

    function fact(list, label, value) {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        list.appendChild(dt);
        list.appendChild(dd);
    }

    function buildSourceLink(source) {        const wrapper = document.createElement('div');
        wrapper.className = 'prop-source';

        const label = document.createElement('span');
        label.textContent = 'Declared in ';
        wrapper.appendChild(label);

        const link = document.createElement('button');
        link.className = 'link';
        link.type = 'button';
        link.textContent = fileLabel(source.file) + (source.line ? ':' + source.line : '');
        link.title = source.file;
        link.addEventListener('click', function () {
            vscode.postMessage({
                type: 'goToSource',
                file: source.file,
                line: source.line,
                column: source.column,
            });
        });
        wrapper.appendChild(link);
        return wrapper;
    }

    /**
     * One property row, matching the native window's 14/126/star grid. The name
     * column is deliberately fixed-width so every value starts on the same
     * vertical edge; letting it reflow is the defect that width was chosen to
     * fix. The expansion card below the row carries everything else.
     */
    function buildPropRow(prop, depth, payload) {
        const wrap = document.createElement('div');
        wrap.className = 'prow';
        wrap.dataset.prop = prop.name;

        const line = document.createElement('div');
        line.className = 'prow-line';
        line.style.paddingLeft = (4 + depth * INDENT_PX) + 'px';

        const open = state.openProps.has(prop.name);

        const chevron = document.createElement('button');
        chevron.type = 'button';
        chevron.className = 'pchevron' + (open ? ' open' : '');
        chevron.textContent = '\\uE76C';
        chevron.setAttribute('aria-expanded', open ? 'true' : 'false');
        chevron.setAttribute('aria-label', 'Details for ' + prop.name);
        chevron.addEventListener('click', function () { togglePropExpand(prop, payload); });
        line.appendChild(chevron);

        const name = document.createElement('span');
        name.className = 'pname';
        name.title = prop.name;
        name.textContent = prop.name;
        if (prop.binding) {
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = 'binding';
            badge.title = prop.binding;
            name.appendChild(badge);
        }
        line.appendChild(name);

        const cell = document.createElement('div');
        cell.className = 'pvalue-cell';

        // The changed marker is a sibling of the button, never inside it, so
        // assistive tech does not read status as part of the action.
        const dot = document.createElement('span');
        dot.className = 'pdot';
        dot.textContent = '\\u25CF';
        dot.setAttribute('aria-hidden', 'true');
        if (!isEdited(payload.handle, prop.name)) { dot.classList.add('hidden'); }
        cell.appendChild(dot);

        const value = document.createElement('button');
        value.type = 'button';
        value.className = 'pvalue';
        if (prop.redacted) {
            value.classList.add('redacted');
            value.textContent = '(value hidden)';
        } else {
            value.textContent = prop.value;
            value.title = prop.value;
        }
        value.addEventListener('click', function () { togglePropExpand(prop, payload); });
        cell.appendChild(value);
        line.appendChild(cell);

        wrap.appendChild(line);

        if (open) { wrap.appendChild(buildExpansion(prop, payload)); }
        return wrap;
    }

    function editKey(handle, name) { return String(handle) + '|' + name; }

    function isEdited(handle, name) {
        return Object.prototype.hasOwnProperty.call(state.edited, editKey(handle, name));
    }

    function togglePropExpand(prop, payload) {
        if (state.openProps.has(prop.name)) {
            state.openProps.delete(prop.name);
        } else {
            state.openProps.add(prop.name);
            // Binding diagnosis is expensive and needs the managed agent, so it
            // is requested only when the card is actually opened.
            if (prop.binding && !state.bindings[prop.name]) {
                vscode.postMessage({
                    type: 'diagnoseBinding',
                    handle: payload.handle,
                    name: prop.name,
                });
            }
            if (!state.resources[prop.name]) {
                vscode.postMessage({
                    type: 'resolveResource',
                    handle: payload.handle,
                    name: prop.name,
                });
            }
        }
        renderProperties();
    }

    /** The kinds the native KIND dropdown can offer for a given property. */
    function kindsFor(prop) {
        const kinds = [];
        const type = (prop.valueType || prop.writeType || '').toLowerCase();
        // The engine names the authored markup, so trust it rather than
        // guessing a binding from the value type.
        if (prop.authoredKind === 'xBind') { kinds.push('xbind'); }
        if (prop.enumValues && prop.enumValues.length) { kinds.push('enum'); }
        if (type.indexOf('boolean') !== -1) { kinds.push('bool'); }
        if (type.indexOf('brush') !== -1 || type.indexOf('color') !== -1) { kinds.push('color'); }
        if (fieldNamesFor(prop)) { kinds.push('fields'); }
        kinds.push('text');
        kinds.push('resource');
        kinds.push('binding');
        return kinds;
    }

    /** The markup the app authored, parsed back into path and mode. */
    function authoredPath(prop) {
        return prop.authoredKey || '';
    }

    function authoredMode(prop) {
        const match = /Mode\s*=\s*([A-Za-z]+)/.exec(prop.authored || '');
        return match ? match[1] : '';
    }

    const KIND_LABELS = {
        text: 'Text',
        bool: 'True / False',
        enum: 'One of a set',
        color: 'Colour',
        fields: 'Separate fields',
        resource: 'A resource key',
        binding: 'A binding',
        xbind: 'An x:Bind expression',
    };

    /** Comma-grouped values (Thickness, Point, GridLength) get per-field boxes. */
    function fieldNamesFor(prop) {
        if (prop.fields && prop.fields.length) { return prop.fields; }
        const type = (prop.valueType || '').toLowerCase();
        if (type.indexOf('thickness') !== -1) { return ['Left', 'Top', 'Right', 'Bottom']; }
        if (type.indexOf('cornerradius') !== -1) { return ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft']; }
        if (type.indexOf('point') !== -1 || type.indexOf('size') !== -1) { return ['X', 'Y']; }
        return null;
    }

    function activeKind(prop) {
        const staged = state.staged[prop.name];
        if (staged) { return staged.kind; }
        if (state.applied[prop.name]) { return state.applied[prop.name]; }
        return kindsFor(prop)[0];
    }

    function caption(text, spaced) {
        const div = document.createElement('div');
        div.className = 'pcap' + (spaced ? ' spaced' : '');
        div.textContent = text;
        return div;
    }

    function note(text) {
        const div = document.createElement('div');
        div.className = 'pnote';
        div.textContent = text;
        return div;
    }
`;
