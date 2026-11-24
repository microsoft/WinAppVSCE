#nullable enable

using System;
using System.Collections.Generic;

namespace WinUIXamlPreview.UI
{
    /// <summary>
    /// A small keyed, capacity-bounded holding area (keys compare case-insensitively, as document paths do).
    /// Newest entries win: parking under an existing key replaces it, and going over capacity drops the oldest.
    /// Dropped entries are returned to the caller, which owns disposing them. Not thread-safe (UI thread only).
    /// </summary>
    internal sealed class ParkingLot<T> where T : class
    {
        private readonly int _capacity;
        private readonly List<KeyValuePair<string, T>> _items = new List<KeyValuePair<string, T>>();

        public ParkingLot(int capacity) => _capacity = Math.Max(1, capacity);

        public int Count => _items.Count;

        /// <summary>Park <paramref name="item"/> under <paramref name="key"/>; returns the entries it displaced.</summary>
        public List<T> Park(string key, T item)
        {
            var dropped = new List<T>();
            for (int i = _items.Count - 1; i >= 0; i--)
            {
                if (string.Equals(_items[i].Key, key, StringComparison.OrdinalIgnoreCase))
                {
                    dropped.Add(_items[i].Value);
                    _items.RemoveAt(i);
                }
            }

            _items.Add(new KeyValuePair<string, T>(key, item));
            while (_items.Count > _capacity)
            {
                dropped.Add(_items[0].Value);
                _items.RemoveAt(0);
            }

            return dropped;
        }

        /// <summary>Remove and return the entry parked under <paramref name="key"/> if <paramref name="usable"/> accepts it.</summary>
        public T? TryTake(string key, Func<T, bool> usable)
        {
            for (int i = _items.Count - 1; i >= 0; i--)
            {
                if (string.Equals(_items[i].Key, key, StringComparison.OrdinalIgnoreCase) && usable(_items[i].Value))
                {
                    var item = _items[i].Value;
                    _items.RemoveAt(i);
                    return item;
                }
            }

            return null;
        }

        /// <summary>Remove a specific entry (expired or died while parked). False if it was already gone.</summary>
        public bool Remove(T item)
        {
            for (int i = 0; i < _items.Count; i++)
            {
                if (ReferenceEquals(_items[i].Value, item))
                {
                    _items.RemoveAt(i);
                    return true;
                }
            }

            return false;
        }

        /// <summary>Remove and return everything.</summary>
        public List<T> Clear()
        {
            var all = new List<T>(_items.Count);
            foreach (var kv in _items)
            {
                all.Add(kv.Value);
            }

            _items.Clear();
            return all;
        }
    }
}
