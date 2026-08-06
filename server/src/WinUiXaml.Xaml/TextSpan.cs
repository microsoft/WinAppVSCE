using System;

namespace WinUiXaml.Xaml
{
    /// <summary>
    /// An immutable half-open text range <c>[Start, End)</c> measured in UTF-16 code units.
    /// Never has negative length; construction clamps defensively so the tolerant parser can
    /// synthesize spans from partial input without throwing.
    /// </summary>
    public readonly struct TextSpan : IEquatable<TextSpan>
    {
        public TextSpan(int start, int end)
        {
            if (start < 0) start = 0;
            if (end < start) end = start;
            Start = start;
            End = end;
        }

        public static TextSpan FromBounds(int start, int end) => new TextSpan(start, end);

        public static TextSpan Empty(int position) => new TextSpan(position, position);

        /// <summary>Inclusive start offset.</summary>
        public int Start { get; }

        /// <summary>Exclusive end offset.</summary>
        public int End { get; }

        public int Length => End - Start;

        public bool IsEmpty => End == Start;

        /// <summary>True when <paramref name="position"/> lies in <c>[Start, End)</c>.</summary>
        public bool Contains(int position) => position >= Start && position < End;

        /// <summary>True when <paramref name="position"/> lies in <c>[Start, End]</c> (used for caret mapping).</summary>
        public bool ContainsInclusive(int position) => position >= Start && position <= End;

        public bool Equals(TextSpan other) => Start == other.Start && End == other.End;

        public override bool Equals(object? obj) => obj is TextSpan s && Equals(s);

        public override int GetHashCode() => unchecked((Start * 397) ^ End);

        public override string ToString() => $"[{Start}..{End})";
    }
}
