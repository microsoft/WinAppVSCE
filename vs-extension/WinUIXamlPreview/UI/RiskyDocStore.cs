#nullable enable

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;

namespace WinUIXamlPreview.UI
{
    /// <summary>
    /// Remembers, across VS sessions, the documents whose edits crashed the preview process. Their edits render on
    /// the warm spare (unparented) instead of in place, so a repeat crash can't freeze VS's input. Entries expire so a
    /// page that has since been fixed goes back to fast in-place edits. Best effort: I/O failures are ignored.
    /// File format: one "<utc ticks>\t<path>" per line.
    /// </summary>
    internal sealed class RiskyDocStore
    {
        internal static readonly TimeSpan Expiry = TimeSpan.FromDays(14);
        internal const int MaxEntries = 200;

        public static readonly RiskyDocStore Shared = new RiskyDocStore(DefaultFile());

        private readonly string? _file;
        private readonly Func<DateTime> _utcNow;
        private readonly object _gate = new object();
        private Dictionary<string, DateTime>? _entries;

        public RiskyDocStore(string? file, Func<DateTime>? utcNow = null)
        {
            _file = file;
            _utcNow = utcNow ?? (() => DateTime.UtcNow);
        }

        public bool Contains(string path)
        {
            lock (_gate)
            {
                _entries ??= Read();
                return _entries.TryGetValue(path, out var at) && !Expired(at);
            }
        }

        /// <summary>Forgets every entry (integration tests start each case from a clean slate).</summary>
        public void Clear()
        {
            lock (_gate)
            {
                _entries = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
                if (_file != null)
                {
                    try { File.Delete(_file); } catch { }
                }
            }
        }

        public void Add(string path)
        {
            lock (_gate)
            {
                // Re-read so another VS instance's entries aren't dropped by this write.
                var entries = Read();
                entries[path] = _utcNow();
                foreach (var stale in entries.OrderByDescending(e => e.Value).Skip(MaxEntries).Select(e => e.Key).ToList())
                {
                    entries.Remove(stale);
                }

                _entries = entries;
                Write(entries);
            }
        }

        private bool Expired(DateTime at) => _utcNow() - at > Expiry;

        private Dictionary<string, DateTime> Read()
        {
            var entries = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
            try
            {
                if (_file == null || !File.Exists(_file))
                {
                    return entries;
                }

                foreach (var line in File.ReadAllLines(_file))
                {
                    var tab = line.IndexOf('\t');
                    if (tab <= 0
                        || !long.TryParse(line.Substring(0, tab), NumberStyles.Integer, CultureInfo.InvariantCulture, out var ticks)
                        || ticks < DateTime.MinValue.Ticks || ticks > DateTime.MaxValue.Ticks)
                    {
                        continue;
                    }

                    var at = new DateTime(ticks, DateTimeKind.Utc);
                    var path = line.Substring(tab + 1);
                    if (path.Length > 0 && !Expired(at))
                    {
                        entries[path] = at;
                    }
                }
            }
            catch
            {
            }

            return entries;
        }

        private void Write(Dictionary<string, DateTime> entries)
        {
            if (_file == null)
            {
                return;
            }

            var tmp = _file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
                File.WriteAllLines(tmp, entries.Select(e => e.Value.Ticks.ToString(CultureInfo.InvariantCulture) + "\t" + e.Key));
                if (File.Exists(_file))
                {
                    File.Replace(tmp, _file, null);
                }
                else
                {
                    File.Move(tmp, _file);
                }
            }
            catch
            {
                try { File.Delete(tmp); } catch { }
            }
        }

        private static string? DefaultFile()
        {
            try
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "WinUIXamlPreview",
                    "risky-docs.txt");
            }
            catch
            {
                return null;
            }
        }
    }
}
