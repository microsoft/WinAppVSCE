#nullable enable

using System;
using WinUIXamlPreview.UI;

namespace WinUIXamlPreview.UnitTests;

// PreviewSessionState / RestartPolicy / PreviewErrorText: the preview pane's lifecycle decisions, driven through
// the orderings that are hard to hit by hand (stale spares, holds racing a spare, superseded upgrades).
internal static partial class Program
{
    private static void SessionTests()
    {
        // ---- spare warming / staleness ----
        {
            var s = new PreviewSessionState();
            Eq("warm: no launch config", null, s.TryBeginSpareWarm(hasSpare: false, hasLaunchConfig: false, disposed: false));
            Eq("warm: spare already present", null, s.TryBeginSpareWarm(true, true, false));
            Eq("warm: disposed", null, s.TryBeginSpareWarm(false, true, true));
            var gen = s.TryBeginSpareWarm(false, true, false);
            Eq("warm: starts at current gen", (int?)0, gen);
            Check("warm: warming", s.SpareWarming);
            Eq("warm: only one at a time", null, s.TryBeginSpareWarm(false, true, false));
            Eq("ready: current gen kept", SpareReadyAction.Keep, s.OnSpareReady(gen!.Value, disposed: false));
            Check("ready: warming cleared", !s.SpareWarming);
        }

        {
            var s = new PreviewSessionState();
            var gen = s.TryBeginSpareWarm(false, true, false)!.Value;
            s.OnTeardown(); // doc switch while warming
            Eq("ready after doc switch: discarded", SpareReadyAction.Discard, s.OnSpareReady(gen, false));
            Eq("failed after doc switch: nothing", SpareFailedAction.None, s.OnSpareStartFailed(gen));
            var gen2 = s.TryBeginSpareWarm(false, true, false)!.Value;
            Eq("stale failure doesn't clear the newer warm", SpareFailedAction.None, s.OnSpareStartFailed(gen));
            Check("newer warm still warming", s.SpareWarming);
            Eq("newer warm becomes ready", SpareReadyAction.Keep, s.OnSpareReady(gen2, false));
        }

        {
            var s = new PreviewSessionState();
            var gen = s.TryBeginSpareWarm(false, true, false)!.Value;
            Eq("ready after dispose: discarded", SpareReadyAction.Discard, s.OnSpareReady(gen, disposed: true));
        }

        // ---- theme swap ----
        {
            var s = new PreviewSessionState();
            Check("theme: needs a client", !s.CanThemeSwap(false, true, true));
            Check("theme: needs a path", !s.CanThemeSwap(true, false, true));
            Check("theme: needs an exe", !s.CanThemeSwap(true, true, false));
            Check("theme: allowed", s.CanThemeSwap(true, true, true));
            s.BeginUpgrade();
            Check("theme: blocked during upgrade", !s.CanThemeSwap(true, true, true));
        }

        // ---- hold render errors while a full-fidelity upgrade is in flight ----
        {
            var s = new PreviewSessionState();
            Check("held error: no upgrade → show", !s.ShouldHoldError(false, false, false));
            var gen = s.BeginUpgrade();
            Check("held error: bundled error during upgrade → hold", s.ShouldHoldError(false, false, false));
            Check("held error: not-designable → show", !s.ShouldHoldError(true, false, false));
            Check("held error: has a render → banner, not held", !s.ShouldHoldError(false, true, false));
            Check("held error: matched host's own error → show", !s.ShouldHoldError(false, false, true));
            s.AbortUpgradeStart();
            Check("held error: upgrade aborted → show", !s.ShouldHoldError(false, false, false));
            s.BeginUpgrade();
            s.CancelUpgrade(byUser: true);
            Check("held error: cancelled → show", !s.ShouldHoldError(false, false, false));
        }

        {
            var s = new PreviewSessionState();
            var oldGen = s.TryBeginSpareWarm(false, true, false)!.Value; // old-theme spare warming
            s.BeginThemeSwap();
            Check("theme: old warm invalidated", !s.SpareWarming);
            var gen = s.TryBeginSpareWarm(false, true, false)!.Value;
            Check("theme: pending for new gen", s.ThemeSwapPendingFor(gen));
            Check("theme: not pending for old gen", !s.ThemeSwapPendingFor(oldGen));
            Eq("theme: old-theme spare ready → discarded", SpareReadyAction.Discard, s.OnSpareReady(oldGen, false));
            Eq("theme: new spare ready → swap", SpareReadyAction.CompleteThemeSwap, s.OnSpareReady(gen, false));
        }

        {
            var s = new PreviewSessionState();
            s.BeginThemeSwap();
            var gen = s.TryBeginSpareWarm(false, true, false)!.Value;
            Eq("theme: spare fails → cold restart", SpareFailedAction.RestartForTheme, s.OnSpareStartFailed(gen));
        }

        {
            var s = new PreviewSessionState();
            s.BeginThemeSwap();
            var gen = s.TryBeginSpareWarm(false, true, false)!.Value;
            s.OnTeardown(); // doc switch mid swap
            Check("theme: doc switch cancels the swap", !s.ThemeSwapPendingFor(gen));
            Eq("theme: then spare failure is ignored", SpareFailedAction.None, s.OnSpareStartFailed(gen));
        }

        {
            var s = new PreviewSessionState();
            s.BeginThemeSwap();
            var gen = s.TryBeginSpareWarm(false, true, false)!.Value;
            HoldAfterRender(s, out _);
            Eq("theme + held edit: swap wins (it renders the latest text)", SpareReadyAction.CompleteThemeSwap, s.OnSpareReady(gen, false));
        }

        // ---- held edit ----
        {
            var s = new PreviewSessionState();
            s.OnNewActiveClient();
            Eq("hold: fresh process renders now", HoldDecision.RenderNow, s.TryHoldEdit(() => throw new Exception("must not warm"), out _));
        }

        {
            var s = new PreviewSessionState();
            s.OnRenderSucceeded();
            Eq("hold: nothing coming → render now", HoldDecision.RenderNow, s.TryHoldEdit(() => false, out _));
            Check("hold: not held", !s.EditAwaitingSpare);
        }

        {
            var s = new PreviewSessionState();
            var gen = HoldAfterRender(s, out var seq);
            Check("hold: held", s.EditAwaitingSpare);
            Eq("hold: second edit joins", HoldDecision.AlreadyHeld, s.TryHoldEdit(() => true, out _));
            Eq("hold: spare ready → drain", SpareReadyAction.DrainHeldEdit, s.OnSpareReady(gen, false));
            s.EndHold();
            Check("hold: timeout after drain is a no-op", !s.HoldTimedOut(seq, false));
        }

        {
            var s = new PreviewSessionState();
            var gen = HoldAfterRender(s, out var seq);
            Check("hold: timeout fires while waiting", s.HoldTimedOut(seq, false));
            Check("hold: timeout ignored after dispose", !s.HoldTimedOut(seq, true));
            Eq("hold: spare fails → render in place", SpareFailedAction.RenderHeldEditInPlace, s.OnSpareStartFailed(gen));
        }

        {
            var s = new PreviewSessionState();
            HoldAfterRender(s, out var seq1);
            s.EndHold();
            s.InvalidateSpare();
            HoldAfterRender(s, out var seq2);
            Check("hold: a newer hold gets a new seq", seq2 != seq1);
            Check("hold: the old hold's timeout is a no-op", !s.HoldTimedOut(seq1, false));
            Check("hold: the newer hold's timeout fires", s.HoldTimedOut(seq2, false));
        }

        {
            var s = new PreviewSessionState();
            HoldAfterRender(s, out var seq);
            s.OnTeardown(); // doc switch while held
            Check("hold: doc switch drops the hold", !s.EditAwaitingSpare);
            Check("hold: its timeout is a no-op", !s.HoldTimedOut(seq, false));
        }

        {
            var s = new PreviewSessionState();
            s.OnRenderSucceeded();
            s.OnSparePromoted();
            s.OnNewActiveClient();
            Check("promote: render pending", s.PromotedRenderPending);
            Eq("hold: promoted render in flight → hold without warming",
                HoldDecision.Held, s.TryHoldEdit(() => throw new Exception("must not warm"), out _));
            Check("error on fresh promoted spare → render held edit now", s.OnRenderError());
            Check("error: pending cleared", !s.PromotedRenderPending);
            Check("error: second error doesn't re-render", !s.OnRenderError());
        }

        {
            var s = new PreviewSessionState();
            Check("error without promotion → nothing", !s.OnRenderError());
            s.OnSparePromoted();
            Check("error after promotion, nothing held → nothing", !s.OnRenderError());
        }

        {
            var s = new PreviewSessionState();
            HoldAfterRender(s, out _);
            s.OnSparePromoted();
            Check("promote satisfies the held edit", !s.EditAwaitingSpare);
        }

        // ---- surface death / restart budget ----
        {
            var s = new PreviewSessionState();
            Check("risky: unknown doc", !s.IsRisky(@"C:\a\Page.xaml"));
            Check("risky: null path", !s.IsRisky(null));
            Eq("death: recover", ActiveDeathAction.Recover, s.OnActiveDied(@"C:\a\Page.xaml", false, false));
            Check("death: doc learned risky (case-insensitive)", s.IsRisky(@"c:\A\page.XAML"));
            Eq("death: recover 2", ActiveDeathAction.Recover, s.OnActiveDied(@"C:\a\Page.xaml", false, false));
            Eq("death: recover 3", ActiveDeathAction.Recover, s.OnActiveDied(@"C:\a\Page.xaml", false, false));
            Eq("death: budget spent → give up", ActiveDeathAction.GiveUp, s.OnActiveDied(@"C:\a\Page.xaml", false, false));
            Check("death: exhausted", s.Restarts.Exhausted);
            Eq("disconnected detail: gave up", "Auto-restart gave up after 3 attempts. boom",
                PreviewErrorText.DisconnectedDetail("boom", s.Restarts.Exhausted, s.Restarts.MaxAttempts));
            s.OnUserReload();
            Eq("reload refunds the budget", 0, s.Restarts.Attempts);
            Eq("death: recovers again after reload", ActiveDeathAction.Recover, s.OnActiveDied(@"C:\a\Page.xaml", false, false));
        }

        {
            var s = new PreviewSessionState();
            s.OnActiveDied("p", false, false);
            s.OnActiveDied("p", false, false);
            s.OnRenderSucceeded();
            Eq("a successful render refunds the budget", 0, s.Restarts.Attempts);
        }

        {
            var s = new PreviewSessionState();
            s.OnTeardown();
            Eq("death we caused: ignored", ActiveDeathAction.Ignore, s.OnActiveDied("p", false, false));
            Check("ignored death doesn't mark risky", !s.IsRisky("p"));
            s.OnNewActiveClient();
            Eq("new client: deaths count again", ActiveDeathAction.Recover, s.OnActiveDied("p", false, false));
            s.OnTeardown();
            s.OnUserReload();
            Eq("reload re-allows restarts", ActiveDeathAction.Recover, s.OnActiveDied("p", false, false));
        }

        {
            var s = new PreviewSessionState();
            Eq("death after dispose: ignored", ActiveDeathAction.Ignore, s.OnActiveDied("p", true, false));
            Eq("protocol mismatch: no restart", ActiveDeathAction.ProtocolMismatch, s.OnActiveDied("p", false, true));
            Eq("protocol mismatch: budget untouched", 0, s.Restarts.Attempts);
            Check("protocol mismatch: not marked risky", !s.IsRisky("p"));
            Eq("no document: give up", ActiveDeathAction.GiveUp, s.OnActiveDied(null, false, false));
            Eq("no document: budget untouched", 0, s.Restarts.Attempts);
            Eq("disconnected detail: plain reason", "boom", PreviewErrorText.DisconnectedDetail("boom", s.Restarts.Exhausted, s.Restarts.MaxAttempts));
        }

        {
            var r = new RestartPolicy(maxAttempts: 1);
            Check("policy(1): first restart", r.TryBeginRestart());
            Check("policy(1): exhausted", r.Exhausted && !r.TryBeginRestart());
            Eq("policy(1): attempts don't overrun", 1, r.Attempts);
        }

        // ---- fidelity upgrade ----
        {
            var s = new PreviewSessionState();
            Check("upgrade: can start", s.CanStartUpgrade);
            var gen = s.BeginUpgrade();
            Check("upgrade: one at a time", !s.CanStartUpgrade);
            Check("upgrade: current", s.IsUpgradeCurrent(gen) && !s.UpgradeSuperseded(gen, false));
            Check("upgrade: superseded by dispose", s.UpgradeSuperseded(gen, true));
            Check("upgrade: ends", s.EndUpgrade(gen) && !s.UpgradeInProgress);
            Check("upgrade: can start again", s.CanStartUpgrade);
        }

        {
            var s = new PreviewSessionState();
            var gen = s.BeginUpgrade();
            s.OnTeardown(); // doc switch mid build
            Check("upgrade: doc switch supersedes", s.UpgradeSuperseded(gen, false) && !s.IsUpgradeCurrent(gen));
            Check("upgrade: late finish rejected", !s.EndUpgrade(gen));
            Check("upgrade: new doc may upgrade", s.CanStartUpgrade);
        }

        {
            var s = new PreviewSessionState();
            var gen = s.BeginUpgrade();
            s.CancelUpgrade(byUser: true);
            Check("upgrade: user cancel supersedes", s.UpgradeSuperseded(gen, false));
            Check("upgrade: late finish after cancel rejected", !s.EndUpgrade(gen));
            Check("upgrade: not re-armed for this doc", !s.CanStartUpgrade);
            Check("upgrade: still cancelled after teardown", s.FullFidelityCancelled);
            s.OnNewDocument();
            Check("upgrade: new document re-arms", s.CanStartUpgrade);
        }

        {
            var s = new PreviewSessionState();
            var gen = s.BeginUpgrade();
            s.AbortUpgradeStart();
            Check("upgrade: aborted start frees the slot", s.CanStartUpgrade && s.IsUpgradeCurrent(gen));
        }

        // ---- full fidelity toggle ----
        {
            var s = new PreviewSessionState();
            Eq("fidelity: no live preview → nothing (off)", FullFidelityToggleAction.None, s.OnFullFidelityToggled(false, live: false, onMatchedHost: true, upgradable: true));
            Eq("fidelity: no live preview → nothing (on)", FullFidelityToggleAction.None, s.OnFullFidelityToggled(true, false, false, true));
            Eq("fidelity: on, bundled-version project → nothing", FullFidelityToggleAction.None, s.OnFullFidelityToggled(true, true, false, upgradable: false));
            Eq("fidelity: on, already on matched host → nothing", FullFidelityToggleAction.None, s.OnFullFidelityToggled(true, true, onMatchedHost: true, upgradable: true));
            Eq("fidelity: on, upgradable → start", FullFidelityToggleAction.StartUpgrade, s.OnFullFidelityToggled(true, true, false, true));
        }

        {
            var s = new PreviewSessionState();
            var gen = s.BeginUpgrade();
            Eq("fidelity: off mid-build → stop", FullFidelityToggleAction.StopUpgrade, s.OnFullFidelityToggled(false, true, false, true));
            Check("fidelity: off supersedes the build", s.UpgradeSuperseded(gen, false) && !s.EndUpgrade(gen));
            Check("fidelity: off frees the slot (not a user cancel)", s.CanStartUpgrade && !s.FullFidelityCancelled);
        }

        {
            var s = new PreviewSessionState();
            Eq("fidelity: off on matched host → relaunch bundled", FullFidelityToggleAction.RelaunchBundled, s.OnFullFidelityToggled(false, true, onMatchedHost: true, upgradable: true));
        }

        {
            var s = new PreviewSessionState();
            s.BeginUpgrade();
            s.CancelUpgrade(byUser: true); // banner Cancel
            Check("fidelity: banner cancel blocks re-arm", !s.CanStartUpgrade);
            Eq("fidelity: explicit on → start", FullFidelityToggleAction.StartUpgrade, s.OnFullFidelityToggled(true, true, false, true));
            Check("fidelity: explicit on clears the banner cancel", s.CanStartUpgrade && !s.FullFidelityCancelled);
        }

        // ---- error presentation ----
        Eq("classify: not designable wins", ErrorDisplay.NotDesignable, PreviewErrorText.Classify(true, true));
        Eq("classify: banner over render", ErrorDisplay.BannerOverLastRender, PreviewErrorText.Classify(false, true));
        Eq("classify: status card", ErrorDisplay.StatusCard, PreviewErrorText.Classify(false, false));
        Eq("not designable: default reason", "This file has no designable page root.", PreviewErrorText.NotDesignableReason("  "));
        Eq("not designable: surface reason", "A ResourceDictionary", PreviewErrorText.NotDesignableReason("A ResourceDictionary"));
        Eq("format: line + col", "Line 3, col 5 — Bad tag",
            PreviewErrorText.FormatXamlError("Bad tag", 3, 5));
        Eq("format: strips placeholder, suffix, newlines", "Line 2, col 1 — Unknown type 'Foo'.",
            PreviewErrorText.FormatXamlError(
                "The text associated with this error code could not be found.\r\n\r\nUnknown type 'Foo'.\n [Line: 2 Position: 1]", 2, 1));
        Eq("format: no line", "Oops", PreviewErrorText.FormatXamlError("  Oops  ", null, null));
        Eq("format: empty → fallback", "The XAML could not be loaded.", PreviewErrorText.FormatXamlError(null, null, null));
        Eq("format: only placeholder → fallback", "Line 1, col 1 — The XAML could not be loaded.",
            PreviewErrorText.FormatXamlError("The text associated with this error code could not be found.", 1, 1));

        // ---- unbuilt-project build hint ----
        var someKeys = new[] { "PillCornerRadius", "AccentBrush" };
        var someTypes = new[] { "Contoso.Controls.StatusPill", "Contoso.Controls.StatusPill", "Contoso.Controls.Gauge" };
        Check("build hint: built project → none", BuildHint.Describe(false, someKeys, someTypes) == null);
        Check("build hint: unbuilt but nothing lost → none", BuildHint.Describe(true, new string[0], null) == null);
        Eq("build hint: types + keys",
            "Parts of this page can't be previewed yet: 2 custom controls shown as placeholders (StatusPill, Gauge); " +
            "2 app styles or resources not found. Build the project for a complete preview — it refreshes automatically when the build finishes.",
            BuildHint.Describe(true, someKeys, someTypes));
        Eq("build hint: single key only",
            "Parts of this page can't be previewed yet: 1 app style or resource not found. Build the project for a complete preview — it refreshes automatically when the build finishes.",
            BuildHint.Describe(true, new[] { "K" }, null));
        Check("build hint: caps named types",
            BuildHint.Describe(true, null, new[] { "A.T1", "A.T2", "A.T3", "A.T4", "A.T5" })!
                .Contains("5 custom controls shown as placeholders (T1, T2, T3, +2 more)"));

        // ---- WinUI types newer than the bundled host ----
        Check("newer types: none → no hint", NewerTypesHint.Describe(new string[0], "2.2.0", "2.2.2", false, false) == null);
        Check("newer types: null → no hint", NewerTypesHint.Describe(null, "2.2.0", "2.2.2", false, false) == null);
        Eq("newer types: off → suggests Full fidelity",
            "FlowLayout isn't in the preview's bundled WinAppSDK 2.2.0, so it's left out. Turn on Full fidelity to preview with WinAppSDK 2.2.2-experimental9.",
            NewerTypesHint.Describe(new[] { "FlowLayout" }, "2.2.0", "2.2.2-experimental9", false, false));
        Eq("newer types: on → explanation only",
            "FlowLayout, TitleBar aren't in the preview's bundled WinAppSDK 2.2.0, so they're left out.",
            NewerTypesHint.Describe(new[] { "FlowLayout", "TitleBar", "FlowLayout" }, "2.2.0", "2.3.0", true, false));
        Eq("newer types: build failed → points at the log",
            "FlowLayout isn't in the preview's bundled WinAppSDK 2.2.0, so it's left out. A WinAppSDK 2.3.0 preview host couldn't be built; details are in preview.log.",
            NewerTypesHint.Describe(new[] { "FlowLayout" }, "2.2.0", "2.3.0", true, true));
        Eq("newer types: unknown versions",
            "A, B, C, +1 more aren't in the preview's bundled WinAppSDK, so they're left out. Turn on Full fidelity to preview with your project's WinAppSDK.",
            NewerTypesHint.Describe(new[] { "A", "B", " ", "C", "D" }, null, null, false, false));
    }

    /// <summary>Puts <paramref name="s"/> in "rendered once, spare warming, edit held". Returns the warm's gen.</summary>
    private static int HoldAfterRender(PreviewSessionState s, out int seq)
    {
        s.OnRenderSucceeded();
        int gen = -1;
        var d = s.TryHoldEdit(() =>
        {
            gen = s.TryBeginSpareWarm(false, true, false) ?? s.SpareGeneration;
            return s.SpareWarming;
        }, out seq);
        Eq("hold setup: held", HoldDecision.Held, d);
        return gen;
    }
}
