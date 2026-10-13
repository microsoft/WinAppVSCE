/**
 * Form-control styling shared by the extension's webviews.
 *
 * The manifest editor and the DevTools panel are separate documents, so they
 * cannot share a stylesheet at runtime — but they should not drift visually
 * either. This module is the single definition of the control primitives; each
 * webview inlines it and passes the selectors its own markup happens to use.
 *
 * Callers pass aliases rather than adopting new class names so that existing
 * markup keeps working: the generated rule simply lists every selector that
 * should receive the shared declarations.
 */

export interface SharedControlOptions {
    /** Selectors styled as a text input / select / textarea. */
    fieldSelectors?: string[];
    /** Selectors styled as the accent-filled primary button. */
    primaryButtonSelectors?: string[];
    /** Selectors styled as the outlined secondary button. */
    secondaryButtonSelectors?: string[];
    /** Selectors styled as the small colour swatch of a colour-picker row. */
    colorSwatchSelectors?: string[];
    /**
     * Emit the custom dropdown menu. Native `<select>` renders its popup with
     * the OS, which ignores the VS Code theme and shows white-on-white in dark
     * themes, so both webviews build menus out of plain elements instead.
     *
     * Only the popup is shared. The trigger stays with the caller because its
     * role differs: an action menu is an accent button, a value picker should
     * look like the fields beside it.
     */
    includeDropdownMenu?: boolean;
}

function rule(selectors: string[] | undefined, body: string): string {
    if (!selectors || selectors.length === 0) {
        return '';
    }
    return `${selectors.join(',\n')} {${body}}\n`;
}

function suffixed(selectors: string[] | undefined, suffix: string, body: string): string {
    if (!selectors || selectors.length === 0) {
        return '';
    }
    return `${selectors.map((s) => s + suffix).join(',\n')} {${body}}\n`;
}

/**
 * Returns the shared control CSS, with no enclosing `<style>` element so the
 * caller can inline it into its own nonce-bearing stylesheet.
 */
export function getSharedControlStyles(options: SharedControlOptions = {}): string {
    const {
        colorSwatchSelectors,
        includeDropdownMenu,
    } = options;

    // The themed colour picker ships with the swatch, so its own hex field and
    // Done button join the primitives rather than restating them.
    const fieldSelectors = colorSwatchSelectors
        ? [...(options.fieldSelectors ?? []), '.wcp-hex']
        : options.fieldSelectors;
    const primaryButtonSelectors = colorSwatchSelectors
        ? [...(options.primaryButtonSelectors ?? []), '.wcp-done']
        : options.primaryButtonSelectors;
    const secondaryButtonSelectors = options.secondaryButtonSelectors;

    const allButtons = [...(primaryButtonSelectors ?? []), ...(secondaryButtonSelectors ?? [])];

    return [
        '/* ─── Shared controls (src/shared/webview-controls.ts) ─── */\n',

        // Tells the browser engine which palette to render built-in UI with:
        // scrollbars, focus rings, and native form chrome are drawn by the
        // engine, not by our CSS, so without this they stay light while the
        // rest of the webview is dark. VS Code puts the theme kind on <body>,
        // which is why this keys off those classes rather than
        // prefers-color-scheme (that reports the OS, not the chosen theme).
        //
        // Note this does NOT reach `input[type=color]`: on Windows its popup
        // is OS chrome and is always light. That one is replaced outright by
        // the themed picker below.
        `
body.vscode-light { color-scheme: light; }
body.vscode-dark { color-scheme: dark; }
body.vscode-high-contrast { color-scheme: dark; }
body.vscode-high-contrast-light { color-scheme: light; }
`,

        // Text-entry surfaces. `--vscode-input-background` is the load-bearing
        // declaration: without it the control falls back to the user agent's
        // white, which is unreadable in dark and high-contrast themes.
        rule(fieldSelectors, `
    padding: 4px 8px;
    font-family: inherit;
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    outline: none;
`),
        suffixed(fieldSelectors, ':focus', `
    border-color: var(--vscode-focusBorder, #007acc);
`),
        suffixed(fieldSelectors, '::placeholder', `
    color: var(--vscode-input-placeholderForeground);
    opacity: 1;
`),

        rule(allButtons, `
    padding: 4px 12px;
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
`),
        suffixed(allButtons, ':focus-visible', `
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
`),
        suffixed(allButtons, ':disabled', `
    opacity: 0.4;
    cursor: default;
`),

        rule(primaryButtonSelectors, `
    border: none;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
`),
        suffixed(primaryButtonSelectors, ':hover:not(:disabled)', `
    background: var(--vscode-button-hoverBackground);
`),

        rule(secondaryButtonSelectors, `
    border: 1px solid var(--vscode-button-border, transparent);
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
`),
        suffixed(secondaryButtonSelectors, ':hover:not(:disabled)', `
    background: var(--vscode-button-secondaryHoverBackground);
`),

        // The swatch sits beside a text field showing the same colour, so it
        // is sized to the field's height rather than made square.
        rule(colorSwatchSelectors, `
    width: 32px;
    height: 28px;
    padding: 2px;
    flex-shrink: 0;
    cursor: pointer;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    background: var(--vscode-input-background);
`),

        includeDropdownMenu ? `
.custom-dropdown { position: relative; display: inline-block; }
.custom-dropdown-menu {
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 4px;
    min-width: 180px;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    z-index: 20;
    padding: 4px;
}
.custom-dropdown-menu.open { display: block; }
.custom-dropdown-item {
    padding: 6px 12px;
    cursor: pointer;
    font-size: 12px;
    color: var(--vscode-foreground);
    border-radius: 4px;
}
.custom-dropdown-item:hover,
.custom-dropdown-item.focused {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
}
/* Marks the value a picker currently holds. Action menus never set it. */
.custom-dropdown-item.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
}
` : '',

        colorSwatchSelectors ? COLOR_PICKER_STYLES : '',
    ].join('');
}

/**
 * Popup chrome for the themed colour picker. See `getSharedColorPickerScript`
 * for why the native control is not used.
 */
const COLOR_PICKER_STYLES = `
.wcp-pop {
    position: fixed;
    z-index: 9999;
    width: 196px;
    padding: 8px;
    box-sizing: content-box;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.36);
    user-select: none;
}
.wcp-sv {
    position: relative;
    width: 196px;
    height: 116px;
    border-radius: 4px;
    cursor: crosshair;
    touch-action: none;
}
.wcp-hue {
    position: relative;
    width: 196px;
    height: 12px;
    margin-top: 8px;
    border-radius: 6px;
    cursor: ew-resize;
    touch-action: none;
    background: linear-gradient(to right,
        #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%);
}
.wcp-dot {
    position: absolute;
    width: 10px;
    height: 10px;
    margin: -5px 0 0 -5px;
    border: 2px solid #fff;
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
    pointer-events: none;
}
.wcp-presets {
    display: grid;
    grid-template-columns: repeat(10, 1fr);
    gap: 3px;
    margin-top: 8px;
}
.wcp-preset {
    height: 16px;
    padding: 0;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    cursor: pointer;
}
.wcp-row {
    display: flex;
    gap: 6px;
    margin-top: 8px;
}
.wcp-hex {
    flex: 1;
    min-width: 0;
    font-family: var(--vscode-editor-font-family, monospace);
}
`;

/**
 * Client-side JavaScript for the themed colour picker, with no enclosing
 * `<script>` element so each webview can inline it into its own IIFE.
 *
 * `input[type="color"]` is kept in the markup — it stays the value holder and
 * keeps firing `input`/`change`, so call sites and tests are untouched — but
 * its popup is suppressed. On Windows that popup is drawn by the OS, which
 * ignores both the page's `color-scheme` and the VS Code theme, so it renders
 * light even in a dark theme. This replaces it with an in-document popup.
 */
export function getSharedColorPickerScript(): string {
    return `
    /* ─── Themed colour picker (src/shared/webview-controls.ts) ─── */
    (function () {
        const PRESETS = [
            '#000000', '#ffffff', '#767676', '#e81123', '#ff8c00',
            '#fff100', '#107c10', '#0078d4', '#5c2d91', '#b4009e',
        ];
        let pop = null;
        let target = null;
        let original = '';
        let hsv = { h: 0, s: 0, v: 0 };

        function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

        function parseHex(value) {
            const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim());
            if (!match) { return null; }
            let digits = match[1];
            if (digits.length === 3) {
                digits = digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2];
            }
            return {
                r: parseInt(digits.slice(0, 2), 16),
                g: parseInt(digits.slice(2, 4), 16),
                b: parseInt(digits.slice(4, 6), 16),
            };
        }

        function toHex(rgb) {
            function part(n) { return ('0' + clamp(Math.round(n), 0, 255).toString(16)).slice(-2); }
            return '#' + part(rgb.r) + part(rgb.g) + part(rgb.b);
        }

        function rgbToHsv(rgb) {
            const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
            let h = 0;
            if (d !== 0) {
                if (max === r) { h = ((g - b) / d + (g < b ? 6 : 0)) / 6; }
                else if (max === g) { h = ((b - r) / d + 2) / 6; }
                else { h = ((r - g) / d + 4) / 6; }
            }
            return { h: h, s: max === 0 ? 0 : d / max, v: max };
        }

        function hsvToRgb(c) {
            const i = Math.floor(c.h * 6);
            const f = c.h * 6 - i;
            const p = c.v * (1 - c.s);
            const q = c.v * (1 - f * c.s);
            const t = c.v * (1 - (1 - f) * c.s);
            const table = [
                [c.v, t, p], [q, c.v, p], [p, c.v, t],
                [p, q, c.v], [t, p, c.v], [c.v, p, q],
            ][i % 6];
            return { r: table[0] * 255, g: table[1] * 255, b: table[2] * 255 };
        }

        function currentHex() { return toHex(hsvToRgb(hsv)); }

        /** Pushes the working colour onto the input and lets the page react live. */
        function apply(syncHexField) {
            if (!target) { return; }
            const hex = currentHex();
            target.value = hex;
            paint(syncHexField, hex);
            target.dispatchEvent(new Event('input', { bubbles: true }));
        }

        function paint(syncHexField, hex) {
            if (!pop) { return; }
            const hue = toHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 }));
            pop.sv.style.background =
                'linear-gradient(to top, #000, rgba(0,0,0,0)),' +
                'linear-gradient(to right, #fff, ' + hue + ')';
            pop.svDot.style.left = (hsv.s * 100) + '%';
            pop.svDot.style.top = ((1 - hsv.v) * 100) + '%';
            pop.hueDot.style.left = (hsv.h * 100) + '%';
            pop.hueDot.style.top = '50%';
            if (syncHexField) { pop.hex.value = hex; }
        }

        function drag(surface, onMove) {
            surface.addEventListener('pointerdown', function (event) {
                event.preventDefault();
                surface.setPointerCapture(event.pointerId);
                const rect = surface.getBoundingClientRect();
                function handle(e) {
                    onMove(
                        rect.width ? clamp((e.clientX - rect.left) / rect.width, 0, 1) : 0,
                        rect.height ? clamp((e.clientY - rect.top) / rect.height, 0, 1) : 0,
                    );
                    apply(true);
                }
                function up(e) {
                    surface.removeEventListener('pointermove', handle);
                    surface.removeEventListener('pointerup', up);
                    if (surface.hasPointerCapture(e.pointerId)) {
                        surface.releasePointerCapture(e.pointerId);
                    }
                }
                surface.addEventListener('pointermove', handle);
                surface.addEventListener('pointerup', up);
                handle(event);
            });
        }

        function build() {
            const root = document.createElement('div');
            root.className = 'wcp-pop';
            root.setAttribute('role', 'dialog');
            root.setAttribute('aria-label', 'Colour picker');

            const sv = document.createElement('div');
            sv.className = 'wcp-sv';
            const svDot = document.createElement('div');
            svDot.className = 'wcp-dot';
            sv.appendChild(svDot);

            const hue = document.createElement('div');
            hue.className = 'wcp-hue';
            const hueDot = document.createElement('div');
            hueDot.className = 'wcp-dot';
            hue.appendChild(hueDot);

            const presets = document.createElement('div');
            presets.className = 'wcp-presets';
            PRESETS.forEach(function (value) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'wcp-preset';
                button.style.background = value;
                button.title = value;
                button.setAttribute('aria-label', value);
                button.addEventListener('click', function () {
                    hsv = rgbToHsv(parseHex(value));
                    apply(true);
                });
                presets.appendChild(button);
            });

            const row = document.createElement('div');
            row.className = 'wcp-row';
            const hex = document.createElement('input');
            hex.type = 'text';
            hex.className = 'wcp-hex';
            hex.setAttribute('aria-label', 'Hex colour');
            hex.setAttribute('spellcheck', 'false');
            hex.addEventListener('input', function () {
                const rgb = parseHex(hex.value);
                if (rgb) { hsv = rgbToHsv(rgb); apply(false); }
            });
            const done = document.createElement('button');
            done.type = 'button';
            done.className = 'wcp-done';
            done.textContent = 'Done';
            done.addEventListener('click', function () { close(true); });
            row.appendChild(hex);
            row.appendChild(done);

            root.appendChild(sv);
            root.appendChild(hue);
            root.appendChild(presets);
            root.appendChild(row);

            drag(sv, function (x, y) { hsv.s = x; hsv.v = 1 - y; });
            drag(hue, function (x) { hsv.h = x; });

            return { root: root, sv: sv, svDot: svDot, hueDot: hueDot, hex: hex };
        }

        function place(input) {
            const rect = input.getBoundingClientRect();
            const size = pop.root.getBoundingClientRect();
            let top = rect.bottom + 4;
            if (top + size.height > window.innerHeight - 4) {
                top = Math.max(4, rect.top - size.height - 4);
            }
            const left = clamp(rect.left, 4, Math.max(4, window.innerWidth - size.width - 4));
            pop.root.style.top = top + 'px';
            pop.root.style.left = left + 'px';
        }

        /**
         * @param commit true to keep the picked colour and fire \`change\`;
         *   false to restore the value the input had when the popup opened,
         *   matching the native dialog's Cancel.
         */
        function close(commit) {
            if (!target) { return; }
            const input = target;
            const popup = pop;
            target = null;
            pop = null;
            if (popup && popup.root.parentNode) { popup.root.parentNode.removeChild(popup.root); }
            if (commit) {
                input.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (input.value !== original) {
                input.value = original;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }

        function open(input) {
            close(false);
            target = input;
            original = input.value;
            hsv = rgbToHsv(parseHex(input.value) || { r: 0, g: 0, b: 0 });
            pop = build();
            document.body.appendChild(pop.root);
            place(input);
            paint(true, currentHex());
            pop.hex.focus();
            pop.hex.select();
        }

        function isSwatch(node) {
            return node
                && node.tagName === 'INPUT'
                && String(node.getAttribute('type')).toLowerCase() === 'color'
                && !node.disabled
                && !node.readOnly;
        }

        // Capture phase, because suppressing the OS dialog means stopping the
        // event before the control's own default action runs.
        document.addEventListener('mousedown', function (event) {
            const node = event.target;
            if (pop && pop.root.contains(node)) { return; }
            if (isSwatch(node)) {
                event.preventDefault();
                node.focus();
                open(node);
                return;
            }
            if (pop) { close(true); }
        }, true);

        document.addEventListener('click', function (event) {
            if (isSwatch(event.target)) { event.preventDefault(); }
        }, true);

        document.addEventListener('keydown', function (event) {
            if (isSwatch(event.target) && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                open(event.target);
                return;
            }
            if (!pop) { return; }
            if (event.key === 'Escape') { event.preventDefault(); close(false); }
            else if (event.key === 'Enter' && event.target === pop.hex) {
                event.preventDefault();
                close(true);
            }
        }, true);

        window.addEventListener('blur', function () { close(true); });
    })();
`;
}
