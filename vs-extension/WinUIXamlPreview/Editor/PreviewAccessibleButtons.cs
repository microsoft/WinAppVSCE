#nullable enable

using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Controls;

namespace WinUIXamlPreview.Editor
{
    /// <summary>
    /// BB-064: a flat toolbar button that is an on/off switch (Select, Sample data, Full fidelity). Screen readers
    /// see the UIA Toggle pattern and its state, not just a plain button whose name happens to contain "On".
    /// </summary>
    internal sealed class PreviewToggleButton : Button
    {
        private readonly Func<bool> _isOn;
        private bool _lastOn;

        public PreviewToggleButton(Func<bool> isOn)
        {
            _isOn = isOn;
            _lastOn = isOn();
        }

        internal bool IsOn => _isOn();

        /// <summary>Raises the UIA ToggleState change when the underlying setting flipped since the last call.</summary>
        internal void RefreshState()
        {
            var on = IsOn;
            if (on == _lastOn)
            {
                return;
            }

            _lastOn = on;
            UIElementAutomationPeer.FromElement(this)?.RaisePropertyChangedEvent(
                TogglePatternIdentifiers.ToggleStateProperty,
                on ? ToggleState.Off : ToggleState.On,
                on ? ToggleState.On : ToggleState.Off);
        }

        protected override AutomationPeer OnCreateAutomationPeer() => new Peer(this);

        private sealed class Peer : ButtonAutomationPeer, IToggleProvider
        {
            public Peer(PreviewToggleButton owner) : base(owner) { }

            private PreviewToggleButton Button => (PreviewToggleButton)Owner;

            public ToggleState ToggleState => Button.IsOn ? ToggleState.On : ToggleState.Off;

            public void Toggle()
            {
                if (!IsEnabled())
                {
                    throw new ElementNotEnabledException();
                }

                ((IInvokeProvider)this).Invoke();
            }

            public override object GetPattern(PatternInterface patternInterface) =>
                patternInterface == PatternInterface.Toggle ? this : base.GetPattern(patternInterface);
        }
    }

    /// <summary>
    /// BB-064: a flat toolbar button that opens a picker menu (Theme, Size). Screen readers see the UIA
    /// ExpandCollapse pattern and hear when the menu opens and closes.
    /// </summary>
    internal sealed class PreviewMenuButton : Button
    {
        internal bool IsMenuOpen => ContextMenu?.IsOpen == true;

        /// <summary>Attaches <paramref name="menu"/> below the button and reports its open/closed state to UIA.</summary>
        internal void AttachMenu(ContextMenu menu)
        {
            menu.PlacementTarget = this;
            menu.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
            menu.Opened += (s, e) => RaiseState(ExpandCollapseState.Collapsed, ExpandCollapseState.Expanded);
            menu.Closed += (s, e) => RaiseState(ExpandCollapseState.Expanded, ExpandCollapseState.Collapsed);
            ContextMenu = menu;
        }

        internal void OpenMenu()
        {
            if (ContextMenu != null)
            {
                ContextMenu.PlacementTarget = this;
                ContextMenu.IsOpen = true;
            }
        }

        private void RaiseState(ExpandCollapseState from, ExpandCollapseState to) =>
            UIElementAutomationPeer.FromElement(this)?.RaisePropertyChangedEvent(
                ExpandCollapsePatternIdentifiers.ExpandCollapseStateProperty, from, to);

        protected override AutomationPeer OnCreateAutomationPeer() => new Peer(this);

        private sealed class Peer : ButtonAutomationPeer, IExpandCollapseProvider
        {
            public Peer(PreviewMenuButton owner) : base(owner) { }

            private PreviewMenuButton Button => (PreviewMenuButton)Owner;

            public ExpandCollapseState ExpandCollapseState =>
                Button.IsMenuOpen ? ExpandCollapseState.Expanded : ExpandCollapseState.Collapsed;

            public void Expand()
            {
                if (!IsEnabled())
                {
                    throw new ElementNotEnabledException();
                }

                Button.OpenMenu();
            }

            public void Collapse()
            {
                if (Button.ContextMenu != null)
                {
                    Button.ContextMenu.IsOpen = false;
                }
            }

            public override object GetPattern(PatternInterface patternInterface) =>
                patternInterface == PatternInterface.ExpandCollapse ? this : base.GetPattern(patternInterface);
        }
    }
}
