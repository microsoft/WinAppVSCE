/**
 * Webview script fragment: constants, shared state, element handles,
 * persistence and the status line.
 *
 * Part of the DevTools webview script. Every fragment in this set is a verbatim
 * slice of one IIFE body and is concatenated by getDevToolsScript, so they all
 * share a single closure over the state and el objects declared here. This
 * fragment declares them and therefore must be emitted first.
 *
 * The strings are template literals that end up inside another template
 * literal, so they must not contain a backtick or a dollar-brace sequence.
 */

export const CORE_FRAGMENT = `
    const vscode = acquireVsCodeApi();

    const ROW_HEIGHT = 22;
    const OVERSCAN = 8;
    const INDENT_PX = 14;

    /** Coalescing window for caption reads while the tree is being scrolled. */
    const PREVIEW_DEBOUNCE_MS = 90;

    /** Editors are suppressed for these kinds regardless of mutation posture. */
    const READONLY_EDIT_KINDS = new Set(['', 'none', 'readonly', 'readOnly']);

    /* ── Property curation ──────────────────────────────────────────────
       These three tables are ports of the native DevTools window, so the two
       surfaces agree on what "the properties" means. Changing them here
       without changing them there is how the panels drift apart.

       Native: DevToolsRead.cpp DevToolsRead_IsCoreProp, and
       DevToolsWindow.PropsLayout.inc PropGroupIndex / PropRowIsRendered. */

    /** Shown by default even when untouched. Deliberately NOT the union of the
        group tables below — the native core list is its own, shorter set. */
    const CORE_PROPS = new Set([
        'Text', 'Content', 'Foreground', 'Background', 'Visibility',
        'HorizontalAlignment', 'VerticalAlignment', 'Margin', 'Padding',
        'Opacity', 'Width', 'Height', 'FontSize',
        'IsEnabled',
        'DataContext',
        'MinWidth', 'MaxWidth', 'MinHeight', 'MaxHeight', 'BorderThickness',
        'RenderTransform',
    ]);

    const PROP_GROUPS = [
        { title: 'Layout', names: new Set(['Width', 'Height', 'Margin', 'Padding', 'HorizontalAlignment',
            'VerticalAlignment', 'MinWidth', 'MinHeight', 'MaxWidth', 'MaxHeight', 'Grid.Row', 'Grid.Column']) },
        { title: 'Appearance', names: new Set(['Foreground', 'Background', 'BorderBrush', 'BorderThickness',
            'Opacity', 'Visibility', 'CornerRadius', 'Fill', 'Stroke']) },
        { title: 'Text', names: new Set(['Text', 'Content', 'FontSize', 'FontFamily', 'FontWeight',
            'FontStyle', 'CharacterSpacing', 'TextWrapping']) },
        // Behavior is its own open group because "Other" is collapsed by
        // default, and IsEnabled — the curated set's one boolean — would
        // otherwise be unreachable without expanding a section called "Other".
        { title: 'Behavior', names: new Set(['IsEnabled', 'IsChecked', 'IsReadOnly', 'IsTabStop',
            'IsHitTestVisible']) },
        { title: 'Other', names: new Set() },
    ];

    const SET_VIEW_GROUPS = ['Authored on this element', 'From a style'];

    /** Groups closed on first paint. Everything else starts open. */

    const STYLE_SOURCES = new Set(['Style', 'Built-in style']);

    const state = {
        roots: [],
        /** Handles of expanded nodes. */
        expanded: new Set(),
        /** Flattened visible rows: { node, depth, hasChildren }. */
        rows: [],
        /**
         * Row captions keyed by handle, filled in lazily for visible rows.
         * A caption is a live read of the element, so the tree asks only for
         * what is on screen rather than for every node it knows about.
         */
        previews: Object.create(null),
        /** Handles already asked for, so scrolling does not re-ask. */
        previewsAsked: new Set(),
        selected: null,
        focused: null,
        filter: '',
        authored: true,
        picking: false,
        focusTracking: false,
        layoutOn: false,
        view: 'tree',
        caps: { canEdit: false, canPick: false, canHighlight: false },
        properties: null,
        /** Property names whose expansion card is open. */
        openProps: new Set(),
        /** 'computed' shows resolved values; 'set' shows only what was written. */
        propView: 'computed',
        /** Escape hatch past the curated subset. */
        propShowAll: false,
        /** Free-text filter over property name, value and authored markup. */
        propFilter: '',
        /** Handle the breadcrumb expansion belongs to, and whether it is open. */
        crumbFor: null,
        crumbOpen: false,
        /** Staged-but-unapplied edits, keyed by property name. */
        staged: Object.create(null),
        /** Applied editor kind, keyed by property name. */
        applied: Object.create(null),
        /** Original values for session edits, keyed by handle|name. */
        edited: Object.create(null),
        /** Binding diagnoses, keyed by property name. */
        bindings: Object.create(null),
        /** Resource-key suggestions, keyed by property name. */
        resources: Object.create(null),
        comments: [],
        surfaces: [],
        layout: null,
        restoreConfirm: null,
        restoreConfirmScope: '',
    };

    const el = {
        status: document.getElementById('status'),
        pick: document.getElementById('btn-pick'),
        focusBtn: document.getElementById('btn-focus'),
        layoutBtn: document.getElementById('btn-layout'),
        jmx: document.getElementById('btn-jmx'),
        tabTree: document.getElementById('tab-tree'),
        tabComments: document.getElementById('tab-comments'),
        commentsBadge: document.getElementById('comments-badge'),
        surface: document.getElementById('surface'),
        focusNotice: document.getElementById('focus-notice'),
        filter: document.getElementById('filter'),
        treeHeader: document.getElementById('tree-header'),
        treeViewport: document.getElementById('tree-viewport'),
        treeControls: document.getElementById('tree-controls'),
        treeSizer: document.getElementById('tree-sizer'),
        treePane: document.getElementById('tree-pane'),
        commentsViewport: document.getElementById('comments-viewport'),
        commentsHost: document.getElementById('comments-host'),
        composeTarget: document.getElementById('compose-target'),
        composeText: document.getElementById('compose-text'),
        composeAdd: document.getElementById('compose-add'),
        composeError: document.getElementById('compose-error'),
        propsViewport: document.getElementById('props-viewport'),
        propsHeader: document.getElementById('props-header'),
        propsControls: document.getElementById('props-controls'),
        pviewComputed: document.getElementById('pview-computed'),
        pviewSet: document.getElementById('pview-set'),
        propFilter: document.getElementById('prop-filter'),
        propCount: document.getElementById('prop-count'),
    };

    // ───────────────────────── persistence ─────────────────────────

    const persisted = vscode.getState();
    if (persisted) {
        state.expanded = new Set(persisted.expanded || []);
        state.filter = persisted.filter || '';
        state.authored = persisted.authored !== false;
        state.propView = persisted.propView === 'set' ? 'set' : 'computed';
        state.propShowAll = persisted.propShowAll === true;
        el.filter.value = state.filter;
    }
    setPressed(el.jmx, state.authored);

    function persist() {
        vscode.setState({
            expanded: Array.from(state.expanded),
            filter: state.filter,
            authored: state.authored,
            propView: state.propView,
            propShowAll: state.propShowAll,
        });
    }

    function setPressed(button, on) {
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        button.classList.toggle('active', !!on);
    }

    // ───────────────────────── status ─────────────────────────

    function setStatus(text, kind) {
        if (!text) {
            el.status.className = 'status hidden';
            el.status.textContent = '';
            return;
        }
        el.status.className = 'status ' + (kind || 'info');
        el.status.textContent = text;
    }
`;
