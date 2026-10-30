// Copyright (c) Microsoft Corporation and Contributors. All rights reserved.
// Licensed under the MIT License.

#nullable enable

using System;
using System.Text.RegularExpressions;

namespace WinUIXamlPreview.Telemetry
{
    /// <summary>
    /// Turns free text (error messages, close reasons, versions) into coarse, fixed tokens so telemetry never
    /// carries user content. Pure; unit-tested.
    /// </summary>
    internal static class TelemetryClassifier
    {
        private static readonly Regex TokenPattern = new Regex(@"^[A-Za-z0-9._\-+]{1,64}$", RegexOptions.CultureInvariant);
        private static readonly Regex TypeNamePattern = new Regex(@"^[A-Za-z_][A-Za-z0-9_]{0,63}$", RegexOptions.CultureInvariant);
        private static readonly Regex ExitCodePattern = new Regex(@"code=(?<code>-?(?:0x)?[0-9A-Fa-f]{1,10})\b", RegexOptions.CultureInvariant);
        private static readonly Regex HResultPattern = new Regex(@"0x[0-9A-Fa-f]{8}\b", RegexOptions.CultureInvariant);

        /// <summary>A short token (version, phase, mode) passed through when it looks like one; anything else becomes "other".</summary>
        public static string? Token(string? value)
        {
            if (value == null)
            {
                return null;
            }

            return TokenPattern.IsMatch(value) ? value : "other";
        }

        /// <summary>True for a bare framework type name ("TitleBar"), the only shape NewerTypesLeftOut sends.</summary>
        public static bool IsTypeName(string? value) => value != null && TypeNamePattern.IsMatch(value);

        /// <summary>Coarse category for a surface render error message.</summary>
        public static string RenderErrorCategory(string? message)
        {
            if (string.IsNullOrWhiteSpace(message))
            {
                return "none";
            }

            var m = message!;
            if (Has(m, "Chart styles aren't loaded"))
            {
                return "charts-resources";
            }
            if (Has(m, "couldn't create <") || Has(m, "Cannot create instance") || Has(m, "unknown type") || Has(m, "was not found in namespace")
                || Has(m, "Cannot deserialize XBF") || Has(m, "type was not found"))
            {
                return "unknown-type";
            }
            if (Has(m, "couldn't set ") || (Has(m, "property") && Has(m, "not found")) || Has(m, "Failed to assign to property")
                || Has(m, "Failed to create a '"))
            {
                return "property";
            }
            if (Has(m, "Cannot find a Resource") || Has(m, "Name/Key"))
            {
                return "missing-resource";
            }
            if (Has(m, "didn't report why") || Has(m, "The text associated with this error code could not be found"))
            {
                return "opaque";
            }
            if (Has(m, "Could not load file or assembly") || Has(m, "FileNotFoundException") || Has(m, "BadImageFormat") || Has(m, "FileLoadException"))
            {
                return "assembly-load";
            }
            if (Has(m, "x:Bind") || Has(m, "Binding"))
            {
                return "binding";
            }
            if (Has(m, "timed out") || Has(m, "timeout"))
            {
                return "timeout";
            }
            if (Has(m, "XamlParseException") || Has(m, "[Line:") || Has(m, "is missing the") || Has(m, "XML") || Has(m, "unexpected"))
            {
                return "parse";
            }
            if (Has(m, "Exception"))
            {
                return "exception";
            }

            return "other";
        }

        /// <summary>Coarse category for a <c>SurfaceClient</c> close reason.</summary>
        public static string CloseReason(string? reason)
        {
            if (string.IsNullOrWhiteSpace(reason))
            {
                return "unknown";
            }

            var r = reason!;
            if (Has(r, "stopped responding"))
            {
                return "hung";
            }
            if (Has(r, "process exited"))
            {
                return "exited";
            }
            if (Has(r, "Timed out"))
            {
                return "start-timeout";
            }
            if (Has(r, "Failed to start"))
            {
                return "start-failed";
            }
            if (Has(r, "run-copy"))
            {
                return "runcopy";
            }
            if (Has(r, "connection failed"))
            {
                return "connect";
            }
            if (Has(r, "send failed"))
            {
                return "send";
            }
            if (Has(r, "protocol"))
            {
                return "protocol";
            }
            if (Has(r, "closed") || Has(r, "disconnected") || Has(r, "EOF"))
            {
                return "disconnected";
            }

            return "other";
        }

        /// <summary>The "code=…" value from a close reason ("Surface process exited (code=0xC0000409)."), or null.</summary>
        public static string? ExitCode(string? reason)
        {
            if (string.IsNullOrEmpty(reason))
            {
                return null;
            }

            var match = ExitCodePattern.Match(reason);
            return match.Success ? match.Groups["code"].Value : null;
        }

        /// <summary>The first HRESULT-shaped token ("0x80073CFF") in a failure message, or null.</summary>
        public static string? HResult(string? text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return null;
            }

            var match = HResultPattern.Match(text);
            return match.Success ? match.Value.ToUpperInvariant().Replace("0X", "0x") : null;
        }

        private static bool Has(string text, string part) => text.IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0;
    }
}
