// net472 has no System.Runtime.CompilerServices.IsExternalInit, which the C# compiler requires to
// emit `init`-only property setters (used by the host-resolver record-like types). This is the
// standard, zero-cost polyfill; it is compiled away and never referenced at runtime.
namespace System.Runtime.CompilerServices
{
    using System.ComponentModel;

    [EditorBrowsable(EditorBrowsableState.Never)]
    internal static class IsExternalInit
    {
    }
}
