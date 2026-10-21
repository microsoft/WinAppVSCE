#nullable enable

using System;
using System.Collections.Generic;

namespace WinUIXamlPreview.UI
{
    internal enum SpareFailedAction { None, RestartForTheme, RenderHeldEditInPlace }

    internal enum SpareReadyAction { Discard, Keep, CompleteThemeSwap, DrainHeldEdit }

    internal enum HoldDecision { RenderNow, Held, AlreadyHeld }

    internal enum ActiveDeathAction { Ignore, ProtocolMismatch, Recover, GiveUp }

    internal enum FullFidelityToggleAction { None, StopUpgrade, RelaunchBundled, StartUpgrade }

    /// <summary>
    /// The preview pane's session bookkeeping, separated from the processes, WPF and dispatcher so the
    /// orderings that matter (stale spares, held edits, theme swaps, upgrades superseded by a doc switch,
    /// the auto-restart budget) are unit-testable. The control owns the <c>SurfaceClient</c>s, timers and
    /// UI; it asks this class what to do and reports what happened. UI thread only.
    /// </summary>
    internal sealed class PreviewSessionState
    {
        private readonly HashSet<string> _riskyDocs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        private bool _themeSwapPending;
        private int _themeSwapGen;

        private bool _editAwaiting;
        private int _editAwaitGen;
        private int _editAwaitSeq;

        // ---- warm spare -----------------------------------------------------

        /// <summary>Bumped whenever the spare's launch config goes stale (doc switch, theme, upgrade, dispose).</summary>
        public int SpareGeneration { get; private set; }

        public bool SpareWarming { get; private set; }

        /// <summary>Starts a warm if none is ready or warming. Returns the generation to tag it with, or null.</summary>
        public int? TryBeginSpareWarm(bool hasSpare, bool hasLaunchConfig, bool disposed)
        {
            if (disposed || hasSpare || SpareWarming || !hasLaunchConfig)
            {
                return null;
            }

            SpareWarming = true;
            return SpareGeneration;
        }

        /// <summary>Any ready or warming spare is now for a stale config.</summary>
        public void InvalidateSpare()
        {
            SpareGeneration++;
            SpareWarming = false;
        }

        public SpareFailedAction OnSpareStartFailed(int gen)
        {
            if (gen == SpareGeneration)
            {
                SpareWarming = false; // a stale warm must not clear the flag for a newer one
            }

            if (ThemeSwapPendingFor(gen))
            {
                return SpareFailedAction.RestartForTheme;
            }

            return gen == SpareGeneration && EditAwaitingSpare
                ? SpareFailedAction.RenderHeldEditInPlace
                : SpareFailedAction.None;
        }

        /// <summary>The warm finished. Unless <see cref="SpareReadyAction.Discard"/>, install the spare then act.</summary>
        public SpareReadyAction OnSpareReady(int gen, bool disposed)
        {
            if (disposed || gen != SpareGeneration)
            {
                return SpareReadyAction.Discard;
            }

            SpareWarming = false;
            if (ThemeSwapPendingFor(gen))
            {
                return SpareReadyAction.CompleteThemeSwap; // also satisfies any held edit
            }

            return EditAwaitingSpare ? SpareReadyAction.DrainHeldEdit : SpareReadyAction.Keep;
        }

        // ---- theme swap (P6) --------------------------------------------------

        public bool ThemeSwapPending => _themeSwapPending;

        public bool ThemeSwapPendingFor(int gen) => _themeSwapPending && _themeSwapGen == gen && gen == SpareGeneration;

        /// <summary>A fidelity upgrade in flight would promote the old theme, so it blocks a warm swap.</summary>
        public bool CanThemeSwap(bool hasClient, bool hasPath, bool hasSurfaceExe) =>
            hasClient && hasPath && hasSurfaceExe && !UpgradeInProgress;

        /// <summary>Drops the old-theme spare's generation and arms the swap for the next one.</summary>
        public void BeginThemeSwap()
        {
            InvalidateSpare();
            _themeSwapPending = true;
            _themeSwapGen = SpareGeneration;
        }

        public void ClearThemeSwap() => _themeSwapPending = false;

        // ---- held edit (risky doc waiting for a spare) -----------------------

        public bool EditAwaitingSpare => _editAwaiting && _editAwaitGen == SpareGeneration;

        /// <summary>
        /// An isolated edit found no ready spare. Hold it if a spare is on its way; <paramref name="startSpare"/>
        /// tries to start one and returns whether one is now warming. <paramref name="seq"/> identifies the hold
        /// for its timeout.
        /// </summary>
        public HoldDecision TryHoldEdit(Func<bool> startSpare, out int seq)
        {
            seq = _editAwaitSeq;

            // A promoted render in flight warms the next spare when it paints. Otherwise a process that has not
            // rendered yet is still fresh and can take the edit directly.
            if (!PromotedRenderPending)
            {
                if (!ActiveProcessRendered || !startSpare())
                {
                    return HoldDecision.RenderNow;
                }
            }

            if (EditAwaitingSpare)
            {
                return HoldDecision.AlreadyHeld;
            }

            _editAwaiting = true;
            _editAwaitGen = SpareGeneration;
            seq = ++_editAwaitSeq;
            return HoldDecision.Held;
        }

        /// <summary>The hold's time limit elapsed: true only if this exact hold is still waiting.</summary>
        public bool HoldTimedOut(int seq, bool disposed) => !disposed && seq == _editAwaitSeq && EditAwaitingSpare;

        public void EndHold() => _editAwaiting = false;

        // ---- active client / render lifecycle ---------------------------------

        /// <summary>A promoted spare's first render is in flight; the next spare is warmed once it paints.</summary>
        public bool PromotedRenderPending { get; private set; }

        /// <summary>The active process has produced a frame; a later crash is a 2nd-render case.</summary>
        public bool ActiveProcessRendered { get; private set; }

        /// <summary>Set while we tear a client down on purpose, so its Closed can't trigger a restart.</summary>
        public bool SuppressAutoRestart { get; private set; }

        public RestartPolicy Restarts { get; } = new RestartPolicy();

        /// <summary>A fresh client is now active (cold start, spare promotion, matched upgrade).</summary>
        public void OnNewActiveClient()
        {
            ActiveProcessRendered = false;
            SuppressAutoRestart = false;
        }

        /// <summary>The spare was promoted and sent the latest text, which satisfies any held edit.</summary>
        public void OnSparePromoted()
        {
            _editAwaiting = false;
            PromotedRenderPending = true;
        }

        public void OnRenderSucceeded()
        {
            Restarts.Reset();
            ActiveProcessRendered = true;
            PromotedRenderPending = false;
        }

        /// <summary>
        /// The active surface answered with an error. True means a held edit should render in place now: the
        /// promoted spare never rendered, so it is still fresh.
        /// </summary>
        public bool OnRenderError()
        {
            if (!PromotedRenderPending)
            {
                return false;
            }

            PromotedRenderPending = false;
            return EditAwaitingSpare && !ActiveProcessRendered;
        }

        // ---- surface death -----------------------------------------------------

        public bool IsRisky(string? path) => !string.IsNullOrEmpty(path) && _riskyDocs.Contains(path!);

        public void MarkRisky(string path) => _riskyDocs.Add(path);

        /// <summary>The active surface died. Recover spends one restart attempt.</summary>
        public ActiveDeathAction OnActiveDied(string? path, bool disposed, bool protocolMismatch)
        {
            if (disposed || SuppressAutoRestart)
            {
                return ActiveDeathAction.Ignore;
            }

            if (protocolMismatch)
            {
                return ActiveDeathAction.ProtocolMismatch; // restarting the same exe can't fix it
            }

            if (string.IsNullOrEmpty(path))
            {
                return ActiveDeathAction.GiveUp;
            }

            // Nearly always the §36 2nd-render fail-fast: future edits of this doc recycle proactively.
            MarkRisky(path!);
            return Restarts.TryBeginRestart() ? ActiveDeathAction.Recover : ActiveDeathAction.GiveUp;
        }

        /// <summary>The user clicked Reload: a fresh restart budget and restarts allowed again.</summary>
        public void OnUserReload()
        {
            Restarts.Reset();
            SuppressAutoRestart = false;
        }

        // ---- version-matched fidelity upgrade ----------------------------------

        public int UpgradeGeneration { get; private set; }

        public bool UpgradeInProgress { get; private set; }

        /// <summary>The user cancelled the upgrade for the current document.</summary>
        public bool FullFidelityCancelled { get; private set; }

        public bool CanStartUpgrade => !FullFidelityCancelled && !UpgradeInProgress;

        public int BeginUpgrade()
        {
            UpgradeInProgress = true;
            return UpgradeGeneration;
        }

        /// <summary>The upgrade couldn't start after <see cref="BeginUpgrade"/> (e.g. no .NET SDK).</summary>
        public void AbortUpgradeStart() => UpgradeInProgress = false;

        public bool IsUpgradeCurrent(int gen) => gen == UpgradeGeneration;

        /// <summary>Don't spend a Surface.exe on an upgrade the user cancelled or a doc switch superseded.</summary>
        public bool UpgradeSuperseded(int gen, bool disposed) => disposed || gen != UpgradeGeneration || FullFidelityCancelled;

        /// <summary>True when <paramref name="gen"/> is current and the upgrade is now finished.</summary>
        public bool EndUpgrade(int gen)
        {
            if (gen != UpgradeGeneration)
            {
                return false;
            }

            UpgradeInProgress = false;
            return true;
        }

        /// <summary>Supersede any in-flight upgrade. <paramref name="byUser"/> also stops it re-arming for this doc.</summary>
        public void CancelUpgrade(bool byUser)
        {
            if (byUser)
            {
                FullFidelityCancelled = true;
            }

            UpgradeGeneration++;
            UpgradeInProgress = false;
        }

        /// <summary>A new document is opening: a cancel for the previous one doesn't carry over.</summary>
        public void OnNewDocument() => FullFidelityCancelled = false;

        /// <summary>
        /// The user flipped the "Full fidelity" toggle. Off supersedes any in-flight upgrade and leaves a
        /// version-matched host for the bundled one; on starts an upgrade (clearing an earlier banner cancel)
        /// when the document could have one and isn't already on its matched host.
        /// </summary>
        public FullFidelityToggleAction OnFullFidelityToggled(bool on, bool live, bool onMatchedHost, bool upgradable)
        {
            if (!live)
            {
                return FullFidelityToggleAction.None;
            }

            if (!on)
            {
                CancelUpgrade(byUser: false);
                return onMatchedHost ? FullFidelityToggleAction.RelaunchBundled : FullFidelityToggleAction.StopUpgrade;
            }

            if (onMatchedHost || !upgradable)
            {
                return FullFidelityToggleAction.None;
            }

            FullFidelityCancelled = false;
            return FullFidelityToggleAction.StartUpgrade;
        }

        // ---- teardown ------------------------------------------------------------

        /// <summary>The active client is being torn down on purpose (dispose / document switch).</summary>
        public void OnTeardown()
        {
            SuppressAutoRestart = true;
            CancelUpgrade(byUser: false);
            InvalidateSpare();
            PromotedRenderPending = false;
        }
    }
}
