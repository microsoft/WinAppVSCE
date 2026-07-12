using System;
using Microsoft.Build.Locator;

namespace WinUiXaml.Workspace
{
    /// <summary>
    /// Registers the installed .NET SDK's MSBuild with <see cref="MSBuildLocator"/> exactly once.
    /// This must run before any <c>Microsoft.Build.*</c> assembly is loaded, i.e. before the first
    /// use of <c>MSBuildWorkspace</c>.
    /// </summary>
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
                        MSBuildLocator.RegisterDefaults();
                    }
                }

                _registered = true;
            }
        }
    }
}
