#nullable enable

namespace WinUIXamlPreview.UI
{
    /// <summary>
    /// Bounded self-healing after an unexpected surface death. Each recovery spends one attempt; any successful
    /// render (or a user Reload) refunds the budget, so ordinary edit-triggered crashes recover indefinitely and
    /// only a document that dies on its very first render (or a broken surface exe) can exhaust it.
    /// </summary>
    internal sealed class RestartPolicy
    {
        public const int DefaultMaxAttempts = 3;

        public RestartPolicy(int maxAttempts = DefaultMaxAttempts) => MaxAttempts = maxAttempts;

        public int MaxAttempts { get; }

        public int Attempts { get; private set; }

        public bool Exhausted => Attempts >= MaxAttempts;

        /// <summary>Spends one attempt if any remain. False means give up and show the Reload card.</summary>
        public bool TryBeginRestart()
        {
            if (Exhausted)
            {
                return false;
            }

            Attempts++;
            return true;
        }

        public void Reset() => Attempts = 0;
    }
}
