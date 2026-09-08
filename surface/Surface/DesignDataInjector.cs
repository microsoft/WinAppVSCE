using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Surface;

/// <summary>
/// §51 M3 — OPPORTUNISTIC REFLECTION FALLBACK for design-time data (opt-in, best-effort, LIVE MODE ONLY),
/// HARDENED (defect <c>dtd-reflect-overreach</c>) to be tightly scoped and side-effect-free.
///
/// <para>
/// This is the zero-config accelerator, explicitly NOT the foundation. The foundation is the M1
/// <c>d:DesignData</c> path (for <c>{Binding}</c>) and the M2 DesignMode contract (for <c>{x:Bind}</c>,
/// where the app cooperates). This fallback is for pages that do NOT opt into either — after the host
/// live-activates the real compiled control (so <c>InitializeComponent()/Connect()</c> ran and the x:Bind
/// connectors exist), it tries to make an otherwise-BLANK page show sample content using ONE generic,
/// source-agnostic mechanism with no per-page or per-app knowledge.
/// </para>
///
/// <para>
/// The original M3 injector fired on every empty <c>ICollection&lt;T&gt;</c> field of every live-OK page and
/// unconditionally re-ran <c>Bindings.Update()</c> + forced a "loaded" VisualState. That over-reached across
/// the whole corpus and — on two model-backed pages (HuggingFace add-model, Whisper) — the injection +
/// state-force kicked off real async/model work and hung the render. Three levers close that:
/// <list type="number">
///   <item><b>(a) SCOPE</b> — only fabricate into an EMPTY collection that is the <c>ItemsSource</c> of a real
///     items host (ItemsControl / ListView / ItemsView / ItemsRepeater, …) present in the live tree. A page
///     with no empty bound items host is a clean no-op — no more global reach into non-UI collections.</item>
///   <item><b>(b) EXCLUDE non-constructible element types</b> — only fabricate element types that are cleanly
///     constructible (public parameterless ctor, no <c>required</c> members). Element types that need typed
///     required ctor params (the model-domain records — HuggingFace/Whisper/Foundry) are skipped ENTIRELY
///     (no partial/null fill): they fabricate to blank anyway (§50g), and it is exactly these that drive the
///     hang.</item>
///   <item><b>(c) SIDE-EFFECT-FREE state force</b> — re-run <c>Bindings.Update()</c> only when something was
///     actually filled/set, and force a "loaded" VisualState ONLY when a fill added visible items, always with
///     <c>useTransitions:false</c> (no transition storyboards / async work). Never force a state on a page
///     where nothing was filled — that removes the trigger that hung the two model pages.</item>
/// </list>
/// </para>
///
/// <para>
/// HARD GUARDRAILS (unchanged): live-mode + explicit opt-in only (env <c>SURFACE_DTD_REFLECT=1</c>) — can
/// NEVER run on the certified default parse path; over-population guard (only <c>Count == 0</c> collections,
/// capped at <see cref="MaxSampleItems"/>); never throws (every reflective step is wrapped). A page that the
/// injector chooses to leave alone logs <c>DTD-SKIP</c> (not <c>DTD-INJECT</c>) so the <c>DTD-INJECT</c> token
/// count reflects genuine reach and leg A (opt-in off) still emits zero.
/// </para>
/// </summary>
internal static class DesignDataInjector
{
    /// <summary>Upper bound on fabricated sample items per empty collection (the over-population cap).</summary>
    private const int MaxSampleItems = 3;

    /// <summary>Cap on visual-tree nodes walked when discovering items hosts (defensive bound).</summary>
    private const int MaxTreeNodes = 5000;

    // Common "content is ready" VisualState names harvested from real pages. Forcing a loaded state is
    // inherently NOT generic (the name is authored per control) — we try a union and log which one hit. It is
    // only ever attempted when a fill actually added visible items (lever c), and always transition-free.
    private static readonly string[] CandidateLoadedStates =
    {
        "ShowModels", "Loaded", "ModelsLoaded", "DataLoaded", "Available", "ShowContent",
        "Content", "ShowData", "Normal", "WideLayout", "Default", "Ready", "Populated",
    };

    // Framework base types whose (inherited) string properties are NOT app-authored "shell text" and must not
    // be seeded — e.g. FrameworkElement.Name / .Language. DP-text only touches string DPs declared on the
    // control's own (app) type below these bases.
    private static readonly HashSet<Type> FrameworkBases = new()
    {
        typeof(FrameworkElement), typeof(Control), typeof(ContentControl),
        typeof(UserControl), typeof(Page), typeof(UIElement), typeof(DependencyObject),
    };

    /// <summary>
    /// Best-effort populate the live-activated <paramref name="fe"/> with a bounded fabricated sample dataset,
    /// scoped to empty items-host collections of cleanly-constructible element types and to the control's own
    /// empty string dependency properties. Never throws; logs a one-line summary for diagnosability. Emits a
    /// <c>DTD-INJECT</c> line only when it actually changed something, otherwise <c>DTD-SKIP</c>.
    /// </summary>
    internal static void TryPopulate(FrameworkElement fe)
    {
        var sb = new StringBuilder();
        var t = fe.GetType();
        sb.Append(t.FullName).Append(' ');
        int filledCollections = 0, skippedHosts = 0, setDps = 0, samplesMade = 0, samplesFailed = 0, hostCount = 0;
        bool addedVisibleItems = false;

        try
        {
            // ---- Levers (a)+(b): fill ONLY empty ItemsSource collections bound to a real items host present
            //      in the live tree, and ONLY when the element type is cleanly constructible. ----
            var hosts = EnumerateItemsHosts(fe);
            hostCount = hosts.Count;

            // x:Bind OneTime targets (e.g. ItemsControl.ItemsSource) are NOT applied at injection time — they
            // land only once the control loads or Bindings.Update() runs. So when there is at least one items
            // host to consider, apply the bindings first to populate their ItemsSource for discovery (this only
            // re-reads binds; it forces no state). A page with NO items host is a pure clean no-op: no binding
            // touch, no state force. That is both the safest behaviour and the bulk of the lever-(a) reduction.
            if (hostCount > 0)
            {
                TryUpdateBindings(fe, sb, "pre");

                foreach (var host in hosts)
                {
                    object? src = GetItemsSource(host);
                    if (src is not ICollection existing) { sb.Append($"[hostNoColl {HostName(host)}:{(src?.GetType().Name ?? "null")}] "); continue; }   // no bound collection / not a countable collection
                    if (existing.Count > 0) continue;                 // real data already present — never disturb it
                    if (!IsPopulatableCollection(src.GetType(), out var elem)) { sb.Append($"[hostNotGen {HostName(host)}:{src.GetType().Name}] "); continue; }

                    // (b) skip the WHOLE collection when its element type is not cleanly constructible (model-domain
                    //     records with required/typed ctor params). No partial or null fill — those hang / blank.
                    if (!IsCleanlyConstructible(elem))
                    {
                        skippedHosts++;
                        sb.Append($"[skip {HostName(host)}:{elem.Name}(non-constructible)] ");
                        continue;
                    }

                    var add = src.GetType().GetMethod("Add", new[] { elem })
                              ?? src.GetType().GetMethod("Add", new[] { typeof(object) });
                    if (add is null) continue;

                    int added = 0;
                    for (int i = 0; i < MaxSampleItems; i++)
                    {
                        var sample = TryMakeSample(elem);
                        if (sample is null) { samplesFailed++; break; }
                        try { add.Invoke(src, new[] { sample }); added++; samplesMade++; }
                        catch { samplesFailed++; break; }
                    }

                    if (added > 0)
                    {
                        filledCollections++;
                        addedVisibleItems = true;
                        sb.Append($"[+{added} {HostName(host)}:{elem.Name}] ");
                    }
                }
            }

            // ---- DP-shell text: set the control's OWN empty string DEPENDENCY properties (e.g. a header
            //      control's Title/Description) to sample text. Restricted to app-declared string DPs so it no
            //      longer reaches into inherited framework string properties. ----
            foreach (var p in EnumerateOwnStringDps(t))
            {
                try
                {
                    if (string.IsNullOrEmpty(p.GetValue(fe) as string))
                    {
                        p.SetValue(fe, "Sample " + p.Name);
                        setDps++;
                        sb.Append($"[dp {p.Name}] ");
                    }
                }
                catch { /* not a settable DP wrapper */ }
            }

            bool changed = filledCollections > 0 || setDps > 0;

            // ---- (c) Re-read the generated x:Bind connector ONLY if we changed something, so downstream OneTime
            //      string binds (e.g. an item-count label) pick up the fill. A page we left untouched gets no
            //      post-update. ----
            if (changed)
            {
                TryUpdateBindings(fe, sb, "post");
            }

            // ---- (c) Force a common loaded/populated VisualState ONLY when a fill added visible items, and
            //      always transition-free. Never force a state on a page where nothing was filled — that is
            //      what kicked off async/model work on the two model-backed pages. ----
            if (addedVisibleItems)
            {
                TryForceLoadedState(fe, sb);
            }
        }
        catch (Exception ex)
        {
            sb.Append($"THREW {ex.GetType().Name}:{ex.Message} ");
        }

        // Over-reach accounting: emit the DTD-INJECT token ONLY when we actually injected something. A page we
        // left alone emits DTD-SKIP so the cert's inject-count reflects genuine reach; leg A (injector never
        // runs) still has zero DTD-INJECT.
        bool injected = filledCollections > 0 || setDps > 0;
        sb.Insert(0, injected ? "DTD-INJECT " : "DTD-SKIP ");
        sb.Append(injected
            ? $"=> collections+{filledCollections} dps:{setDps} samples:{samplesMade}ok/{samplesFailed}fail stateForced:{addedVisibleItems}"
            : $"=> no-op (hosts:{hostCount} skipped:{skippedHosts})");
        App.Log(sb.ToString());
    }

    /// <summary>
    /// (a) Walk the live tree of <paramref name="root"/> and return every element that exposes an
    /// <c>ItemsSource</c> (an items host). Uses BOTH a content/logical traversal (Panel.Children, Border.Child,
    /// ContentControl/UserControl/ContentPresenter/ScrollViewer content) AND <see cref="VisualTreeHelper"/>, so
    /// hosts are found whether or not the element has been laid out yet — at injection time (right after
    /// activation) the element is InitializeComponent-built but not necessarily arranged, and picker item hosts
    /// live inside a <c>Collapsed</c> container that a visual-tree-only walk can miss.
    /// </summary>
    private static List<FrameworkElement> EnumerateItemsHosts(DependencyObject root)
    {
        var hosts = new List<FrameworkElement>();
        var seen = new HashSet<DependencyObject>();
        var stack = new Stack<DependencyObject>();
        stack.Push(root);
        int visited = 0;

        while (stack.Count > 0 && visited < MaxTreeNodes)
        {
            var node = stack.Pop();
            if (node is null || !seen.Add(node)) continue;
            visited++;

            if (node is FrameworkElement fe && ExposesItemsSource(fe))
            {
                hosts.Add(fe);
            }

            foreach (var child in ContentChildren(node)) stack.Push(child);

            int n = 0;
            try { n = VisualTreeHelper.GetChildrenCount(node); } catch { }
            for (int i = 0; i < n; i++)
            {
                DependencyObject? c = null;
                try { c = VisualTreeHelper.GetChild(node, i); } catch { }
                if (c is not null) stack.Push(c);
            }
        }

        return hosts;
    }

    /// <summary>Realization-independent children: the XAML-defined content of the common container types.</summary>
    private static List<DependencyObject> ContentChildren(DependencyObject node)
    {
        var list = new List<DependencyObject>();
        try
        {
            switch (node)
            {
                case Panel p:
                    foreach (var c in p.Children) if (c is DependencyObject d) list.Add(d);
                    break;
                case Border b:
                    if (b.Child is DependencyObject bd) list.Add(bd);
                    break;
                case UserControl uc:
                    if (uc.Content is DependencyObject ud) list.Add(ud);
                    break;
                case ContentPresenter cp:
                    if (cp.Content is DependencyObject pd) list.Add(pd);
                    break;
                case ScrollViewer sv:
                    if (sv.Content is DependencyObject sd) list.Add(sd);
                    break;
                case ContentControl cc:
                    if (cc.Content is DependencyObject cd) list.Add(cd);
                    break;
            }
        }
        catch { /* best-effort structural walk */ }
        return list;
    }

    private static bool ExposesItemsSource(FrameworkElement fe)
    {
        if (fe is ItemsControl) return true;
        try
        {
            var p = fe.GetType().GetProperty("ItemsSource", BindingFlags.Public | BindingFlags.Instance);
            return p is not null && p.CanRead;
        }
        catch { return false; }
    }

    private static object? GetItemsSource(FrameworkElement host)
    {
        try
        {
            if (host is ItemsControl ic) return ic.ItemsSource;
            var p = host.GetType().GetProperty("ItemsSource", BindingFlags.Public | BindingFlags.Instance);
            return p is not null && p.CanRead ? p.GetValue(host) : null;
        }
        catch { return null; }
    }

    private static string HostName(FrameworkElement host)
        => string.IsNullOrEmpty(host.Name) ? host.GetType().Name : host.Name;

    private static bool IsPopulatableCollection(Type t, out Type elem)
    {
        elem = typeof(object);
        if (t == typeof(string) || t.IsPrimitive) return false;
        foreach (var it in Enumerable.Repeat(t, 1).Concat(t.GetInterfaces()))
        {
            if (it.IsGenericType && it.GetGenericTypeDefinition() == typeof(ICollection<>))
            {
                elem = it.GetGenericArguments()[0];
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// (b) A type is cleanly constructible when we can fabricate a sample of it via reflection WITHOUT
    /// supplying typed/domain ctor arguments: trivially-fabricatable leaf types, or a reference type with a
    /// public parameterless ctor AND no <c>required</c> members. Types that require typed/required ctor params
    /// (model-domain records — HuggingFace/Whisper/Foundry) are NOT cleanly constructible; the injector skips
    /// their collections entirely rather than null-filling them (which blanks anyway and can drive model work).
    /// </summary>
    private static bool IsCleanlyConstructible(Type t)
    {
        if (t == typeof(string) || t.IsPrimitive || t.IsEnum) return true;
        if (t == typeof(Uri) || t == typeof(DateTime) || t == typeof(DateTimeOffset) || t == typeof(decimal)) return true;
        if (Nullable.GetUnderlyingType(t) is Type u) return IsCleanlyConstructible(u);
        if (t.IsAbstract || t.IsInterface) return false;

        if (HasRequiredMembers(t)) return false;

        try
        {
            var ctor = t.GetConstructor(
                BindingFlags.Public | BindingFlags.Instance, binder: null, Type.EmptyTypes, modifiers: null);
            return ctor is not null;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// True when <paramref name="t"/> (or any base) declares <c>required</c> members. The C# compiler marks
    /// such a type with <c>System.Runtime.CompilerServices.RequiredMemberAttribute</c>; a reflective
    /// parameterless construction would bypass <c>required</c> and leave those members null (the fragile / hang
    /// case), so we treat the type as non-constructible. Matched by attribute simple-name to avoid a hard
    /// reference / assembly-identity coupling.
    /// </summary>
    private static bool HasRequiredMembers(Type t)
    {
        for (var cur = t; cur is not null && cur != typeof(object); cur = cur.BaseType)
        {
            try
            {
                foreach (var a in cur.GetCustomAttributes(inherit: false))
                {
                    if (a.GetType().Name == "RequiredMemberAttribute") return true;
                }
            }
            catch { /* ignore and continue up the hierarchy */ }
        }
        return false;
    }

    /// <summary>
    /// Fabricate a plausible sample value of <paramref name="t"/> using ONLY reflection: primitives/strings and
    /// a few simple value types directly, otherwise a parameterless construction (the type is pre-gated by
    /// <see cref="IsCleanlyConstructible"/>) with sample text seeded into public writable string properties. No
    /// ctor-argument fabrication — that is precisely the reach (into domain-typed ctor params) the hardening
    /// removes. Returns null when it cannot construct one (the collection is then left untouched).
    /// </summary>
    private static object? TryMakeSample(Type t)
    {
        if (t == typeof(string)) return "Sample Text";
        if (t == typeof(bool)) return true;
        if (t == typeof(int) || t == typeof(long) || t == typeof(short) || t == typeof(byte)) return Convert.ChangeType(1, t);
        if (t == typeof(double) || t == typeof(float) || t == typeof(decimal)) return Convert.ChangeType(1, t);
        if (t == typeof(Uri)) return new Uri("https://example.com/sample");
        if (t == typeof(DateTime)) return DateTime.Now;
        if (t == typeof(DateTimeOffset)) return DateTimeOffset.Now;
        if (t.IsEnum) { var vs = Enum.GetValues(t); return vs.Length > 0 ? vs.GetValue(0) : null; }
        if (Nullable.GetUnderlyingType(t) is Type u) return TryMakeSample(u);

        try
        {
            var obj = Activator.CreateInstance(t);
            if (obj is null) return null;
            foreach (var pr in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (pr.CanWrite && pr.PropertyType == typeof(string))
                {
                    try { if (string.IsNullOrEmpty(pr.GetValue(obj) as string)) pr.SetValue(obj, "Sample " + pr.Name); }
                    catch { }
                }
            }
            return obj;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Enumerate the control's OWN (app-declared) settable string dependency properties.</summary>
    private static List<PropertyInfo> EnumerateOwnStringDps(Type t)
    {
        var result = new List<PropertyInfo>();
        PropertyInfo[] props;
        try { props = t.GetProperties(BindingFlags.Instance | BindingFlags.Public); }
        catch { return result; }

        foreach (var p in props)
        {
            if (p.PropertyType != typeof(string) || !p.CanRead || !p.CanWrite) continue;

            var declaring = p.DeclaringType;
            if (declaring is null || FrameworkBases.Contains(declaring)) continue; // skip inherited framework props

            FieldInfo? dp = null;
            try
            {
                dp = declaring.GetField(
                    p.Name + "Property",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.FlattenHierarchy);
            }
            catch { }
            if (dp is null) continue; // must be backed by a real DependencyProperty

            result.Add(p);
        }
        return result;
    }

    private static void TryUpdateBindings(FrameworkElement fe, StringBuilder sb, string tag = "")
    {
        var t = fe.GetType();
        object? bindings = null;
        var bf = t.GetField("Bindings", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
        if (bf is not null) { try { bindings = bf.GetValue(fe); } catch { } }
        if (bindings is null)
        {
            var bp = t.GetProperty("Bindings", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
            if (bp is not null) { try { bindings = bp.GetValue(fe); } catch { } }
        }
        if (bindings is null) { sb.Append("[noBindings] "); return; }

        // "pre" applies OneTime x:Bind targets so an items host's ItemsSource is populated for discovery; only
        // Update is needed then (Initialize would re-seed and is redundant). "post" re-reads after a fill.
        var methods = tag == "pre" ? new[] { "Update" } : new[] { "Update", "Initialize" };
        foreach (var mn in methods)
        {
            var m = bindings.GetType().GetMethod(mn, Type.EmptyTypes);
            if (m is null) continue;
            try { m.Invoke(bindings, null); sb.Append($"[{tag}{mn}] "); }
            catch (Exception e) { sb.Append($"[{tag}{mn}!{e.InnerException?.GetType().Name ?? e.GetType().Name}] "); }
        }
    }

    private static void TryForceLoadedState(FrameworkElement fe, StringBuilder sb)
    {
        if (fe is not Control c) { sb.Append("[notControl] "); return; }
        foreach (var name in CandidateLoadedStates)
        {
            bool ok;
            try { ok = VisualStateManager.GoToState(c, name, false); } // transition-free (lever c)
            catch { ok = false; }
            if (ok) { sb.Append($"[vs:{name}] "); return; }
        }
    }
}
