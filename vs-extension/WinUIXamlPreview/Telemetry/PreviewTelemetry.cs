// Copyright (c) Microsoft Corporation and Contributors. All rights reserved.
// Licensed under the MIT License.

#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics.Tracing;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Diagnostics.Telemetry;
using WinUIXamlPreview.Telemetry.Events;

namespace WinUIXamlPreview.Telemetry
{
    /// <summary>
    /// Previewer telemetry, ported from the WinApp CLI's <c>Telemetry</c> class: same provider, privacy product
    /// and opt-out variable, with <c>Caller = "vs-xaml-previewer"</c> on every event. Dev and CI builds compile the
    /// <see cref="TelemetryEventSource"/> stub, which only writes local ETW; the release pipeline runs
    /// <c>Unstub-Telemetry.ps1</c> to join the Microsoft provider group so Critical events upload. Opting out (the
    /// env var, or the VS Customer Experience Improvement Program) downgrades every event to local-only.
    /// Never throws into callers.
    /// </summary>
    internal static class PreviewTelemetry
    {
        internal const string OptOutEnvironmentVariable = "WINAPP_CLI_TELEMETRY_OPTOUT";
        internal const string ProviderName = "Microsoft.Windows.WinAppDevCLI";
        internal const string ExceptionThrownEventName = "ExceptionThrown";

        private static readonly EventSourceOptions LocalOption = new EventSourceOptions { Level = EventLevel.Verbose };
        private static readonly EventSourceOptions LocalErrorOption = new EventSourceOptions { Level = EventLevel.Error };
        private static readonly EventSourceOptions CriticalDataOption = new EventSourceOptions { Keywords = TelemetryEventSource.CriticalDataKeyword };
        private static readonly EventSourceOptions CriticalDataErrorOption = new EventSourceOptions { Level = EventLevel.Error, Keywords = TelemetryEventSource.CriticalDataKeyword };

        private static readonly bool EnvOptOut = Environment.GetEnvironmentVariable(OptOutEnvironmentVariable) == "1";

        // Correlates every event from one VS session.
        private static Guid _activityId = Guid.NewGuid();

        // Drive-rooted, UNC and file:/// paths. Directory segments may contain spaces ("Program Files\"); the
        // final segment ends at whitespace. Over-redacting a trailing sentence is acceptable; leaking is not.
        private static readonly Regex PathPattern = new Regex(
            @"file:///[^\s""'<>|]+|(?:(?<![A-Za-z])[A-Za-z]:[\\/]|\\\\)(?:[^\\/\r\n""'<>|*?:]*[\\/])*[^\s""'<>|*?\\/:]*",
            RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(200));

        private static readonly Lazy<List<KeyValuePair<string, string>>> SensitiveStrings =
            new Lazy<List<KeyValuePair<string, string>>>(BuildSensitiveStrings);

        /// <summary>Set by the package: true when the user opted out of the VS Customer Experience Improvement Program.</summary>
        internal static Func<bool>? HostOptedOut { get; set; }

        /// <summary>Optional trace sink (the previewer log) so emitted events are visible while debugging.</summary>
        internal static Action<string>? Trace { get; set; }

        /// <summary>True when events may leave the machine (official builds only); otherwise they stay local ETW.</summary>
        internal static bool IsTelemetryOn
        {
            get
            {
                if (EnvOptOut)
                {
                    return false;
                }

                try { return !(HostOptedOut?.Invoke() ?? false); }
                catch { return false; }
            }
        }

        public static void Log<T>(string eventName, T data) where T : EventBase => Write(eventName, data, isError: false);

        public static void LogError<T>(string eventName, T data) where T : EventBase => Write(eventName, data, isError: true);

        /// <summary>Report an exception the previewer caught. Messages and stacks are scrubbed of paths and user/machine names.</summary>
        public static void LogException(string action, Exception? e)
        {
            if (e == null)
            {
                return;
            }

            try
            {
                LogError(ExceptionThrownEventName, new ExceptionThrownEvent(action, e));
            }
            catch
            {
                // Never let telemetry throw into caller paths.
            }
        }

        /// <summary>
        /// Removes file paths and user/machine names. Paths go first so "C:\Users\me\repos\Contoso\Page.xaml"
        /// becomes "&lt;Path&gt;" rather than leaking the project folder after the profile is replaced.
        /// </summary>
        internal static string Scrub(string? message)
        {
            if (string.IsNullOrEmpty(message))
            {
                return message ?? string.Empty;
            }

            string text;
            try
            {
                text = PathPattern.Replace(message!, "<Path>");
            }
            catch (RegexMatchTimeoutException)
            {
                return "<Redacted>";
            }

            foreach (var pair in SensitiveStrings.Value)
            {
                text = ReplaceIgnoreCase(text, pair.Key, pair.Value);
            }

            return text;
        }

        private static void Write<T>(string eventName, T data, bool isError) where T : EventBase
        {
            try
            {
                data.ReplaceSensitiveStrings(Scrub);
                var upload = IsTelemetryOn;
                var options = upload
                    ? (isError ? CriticalDataErrorOption : CriticalDataOption)
                    : (isError ? LocalErrorOption : LocalOption);
                var related = Guid.Empty;
                SourceHolder.TelemetryEventSourceInstance.Write(eventName, ref options, ref _activityId, ref related, ref data);
                Trace?.Invoke($"Telemetry: {eventName}{(upload ? string.Empty : " (local only)")}");
            }
            catch
            {
                // Never let telemetry throw into caller paths.
            }
        }

        private static List<KeyValuePair<string, string>> BuildSensitiveStrings()
        {
            var list = new List<KeyValuePair<string, string>>();
            void Add(string? value, string replaceWith)
            {
                // Short values ("a") would replace every occurrence of a common letter run.
                if (!string.IsNullOrWhiteSpace(value) && value!.Length > 3 && !list.Exists(p => string.Equals(p.Key, value, StringComparison.Ordinal)))
                {
                    list.Add(new KeyValuePair<string, string>(value, replaceWith));
                }
            }

            try { Add(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "<UserDirectory>"); } catch { }
            try { Add(Environment.UserName, "<UserName>"); } catch { }
            try
            {
                var name = System.Security.Principal.WindowsIdentity.GetCurrent().Name;
                var slash = name.LastIndexOf('\\');
                Add(slash >= 0 ? name.Substring(slash + 1) : name, "<CurrentUserName>");
            }
            catch { }
            try { Add(Environment.MachineName, "<MachineName>"); } catch { }
            try { Add(Environment.CurrentDirectory, "<CurrentDirectory>"); } catch { }
            return list;
        }

        // Non-regex, case-insensitive replace (user-provided strings must never become a regex).
        private static string ReplaceIgnoreCase(string message, string find, string replaceWith)
        {
            var sb = new StringBuilder();
            var i = 0;
            while (true)
            {
                var found = message.IndexOf(find, i, StringComparison.OrdinalIgnoreCase);
                if (found < 0)
                {
                    sb.Append(message, i, message.Length - i);
                    return sb.ToString();
                }

                sb.Append(message, i, found - i);
                sb.Append(replaceWith);
                i = found + find.Length;
            }
        }

        // Isolated so a provider construction failure only disables telemetry instead of breaking the outer type.
        private static class SourceHolder
        {
            // One EventSource per provider per process. Unstub-Telemetry.ps1 rewrites this line for official builds.
            internal static readonly EventSource TelemetryEventSourceInstance = new TelemetryEventSource(ProviderName);
        }
    }
}
