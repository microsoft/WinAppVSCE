using System.Collections.Generic;

namespace TestUserApp;

#nullable enable

/// <summary>
/// A stand-in "application singleton" that a page constructor dereferences — mirroring a real app static
/// such as <c>App.ModelDownloadQueue</c> (§50g). In a real app this is created at <c>App</c> startup; the
/// preview surface does NOT run the app's <c>App</c> class, so under design mode the page seeds it via
/// <see cref="SeedDesignTime"/> — otherwise the constructor's <see cref="Current"/> dereference throws a
/// NullReferenceException (the construction gate that reflection alone cannot cross).
/// </summary>
public sealed class AppServices
{
    /// <summary>The app-global instance. Null until the app (or, at design time, the page) seeds it.</summary>
    public static AppServices? Current { get; set; }

    /// <summary>A queue the page constructor reads — stands in for a real app-owned collection.</summary>
    public List<string> ModelQueue { get; } = new();

    /// <summary>
    /// Design-time seed: create the singleton with a small sample queue so constructor dereferences of
    /// <see cref="Current"/> succeed under the design-mode contract.
    /// </summary>
    public static void SeedDesignTime()
    {
        var services = new AppServices();
        services.ModelQueue.Add("Phi-Silica");
        services.ModelQueue.Add("Whisper-Tiny");
        Current = services;
    }
}
