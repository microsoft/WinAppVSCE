#nullable enable

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace WinUIXamlPreview.Protocol
{
    /// <summary>
    /// A per-host-process Windows job with KILL_ON_JOB_CLOSE. Children added here (surfaces, the provisioner and
    /// whatever they spawn) are terminated by Windows when this process exits for any reason, including a crash
    /// or a kill from Task Manager, so they can't outlive Visual Studio. The handle is intentionally never closed.
    /// </summary>
    internal static class ChildProcessJob
    {
        private static readonly object s_gate = new object();
        private static IntPtr s_job;
        private static bool s_failed;

        /// <summary>Puts <paramref name="process"/> in the job. Best effort: failures are logged, never thrown.</summary>
        internal static bool TryAdd(Process process, Action<string>? log = null)
        {
            try
            {
                var job = GetJob(log);
                if (job == IntPtr.Zero)
                {
                    return false;
                }

                if (AssignProcessToJobObject(job, process.Handle))
                {
                    return true;
                }

                log?.Invoke($"Could not add pid {process.Id} to the cleanup job (error {Marshal.GetLastWin32Error()}).");
            }
            catch (Exception ex)
            {
                log?.Invoke("Could not add a child process to the cleanup job: " + ex.Message);
            }

            return false;
        }

        private static IntPtr GetJob(Action<string>? log)
        {
            lock (s_gate)
            {
                if (s_job != IntPtr.Zero || s_failed)
                {
                    return s_job;
                }

                var job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero)
                {
                    s_failed = true;
                    log?.Invoke($"CreateJobObject failed (error {Marshal.GetLastWin32Error()}).");
                    return IntPtr.Zero;
                }

                var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                var ptr = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(info, ptr, false);
                    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)size))
                    {
                        s_failed = true;
                        log?.Invoke($"SetInformationJobObject failed (error {Marshal.GetLastWin32Error()}).");
                        CloseHandle(job);
                        return IntPtr.Zero;
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(ptr);
                }

                s_job = job;
                return s_job;
            }
        }

        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);
    }
}
