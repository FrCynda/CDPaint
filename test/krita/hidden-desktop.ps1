# Runs one program on a private, invisible Windows desktop and waits for it.
#   powershell -File hidden-desktop.ps1 -Exe <path> -ExeArgs "<args>" -TimeoutSec 180
# A window on another desktop is never shown on the user's screen and can
# never take their keyboard focus, which Qt's offscreen platform would have
# given us for free if Krita did not crash on it. Environment variables pass
# through from the caller. Exit code: the program's, or 124 on timeout.
param([string]$Exe, [string]$ExeArgs = "", [int]$TimeoutSec = 180)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class HiddenDesktop {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr mode, int flags, uint access, IntPtr sa);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
        IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    public static int Run(string exe, string args, int timeoutSec) {
        string name = "cdp-krita-" + Guid.NewGuid().ToString("N");
        IntPtr desk = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000 /* GENERIC_ALL */, IntPtr.Zero);
        if (desk == IntPtr.Zero) throw new Exception("CreateDesktop failed: " + Marshal.GetLastWin32Error());
        try {
            var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.lpDesktop = name;
            PROCESS_INFORMATION pi;
            if (!CreateProcess(exe, "\"" + exe + "\" " + args, IntPtr.Zero, IntPtr.Zero, false, 0,
                               IntPtr.Zero, null, ref si, out pi))
                throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
            try {
                if (WaitForSingleObject(pi.hProcess, (uint)timeoutSec * 1000) != 0) {
                    TerminateProcess(pi.hProcess, 124); WaitForSingleObject(pi.hProcess, 10000); return 124;
                }
                uint code; GetExitCodeProcess(pi.hProcess, out code); return (int)code;
            } finally { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); }
        } finally { CloseDesktop(desk); }
    }
}
"@
exit [HiddenDesktop]::Run($Exe, $ExeArgs, $TimeoutSec)
