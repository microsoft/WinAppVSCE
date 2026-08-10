using System;
using Microsoft.Build.Locator;

namespace WinUiXaml.Workspace
{
    public sealed class MsBuildUnavailableException : InvalidOperationException
    {
        public MsBuildUnavailableException(Exception innerException)
            : base(
                "Project-aware XAML features require the MSBuild toolset from Visual Studio, " +
                "Visual Studio Build Tools, or a compatible .NET SDK.",
                innerException)
        {
        }
    }

    /// <summary>Registers an available MSBuild with MSBuildLocator exactly once, immediately before project evaluation.</summary>
    public static class MsBuildRegistrar
    {
        private static readonly object Gate = new object();
        private static bool _registered;

        /// <summary>The <see cref="VisualStudioInstance"/> that was registered, if any.</summary>
        public static VisualStudioInstance? Registered { get; private set; }

        public static void EnsureRegistered()
        {
            if (_registered)
            {
                return;
            }

            lock (Gate)
            {
                if (_registered)
                {
                    return;
                }

                if (!MSBuildLocator.IsRegistered)
                {
                    // Prefer the newest .NET SDK instance available on the machine.
                    var instances = MSBuildLocator.QueryVisualStudioInstances();
                    VisualStudioInstance? best = null;
                    foreach (var instance in instances)
                    {
                        if (best == null || instance.Version > best.Version)
                        {
                            best = instance;
                        }
                    }

                    if (best != null)
                    {
                        MSBuildLocator.RegisterInstance(best);
                        Registered = best;
                    }
                    else
                    {
                        try
                        {
                            MSBuildLocator.RegisterDefaults();
                        }
                        catch (InvalidOperationException ex)
                        {
                            throw new MsBuildUnavailableException(ex);
                        }
                    }
                }

                _registered = true;
            }
        }
    }
}
