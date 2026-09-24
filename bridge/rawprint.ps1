# Hallmark Tag Bridge — send a file's raw bytes (TSPL) straight to a Windows
# printer through the print spooler, without a network share.
# Used by bridge-server.js when "copy /b \\localhost\<share>" is refused
# (e.g. "Access is denied" on a new PC).
#   powershell -NoProfile -ExecutionPolicy Bypass -File rawprint.ps1 -Printer "TSC TE244" -Path "C:\...\tag.tspl"
param(
  [Parameter(Mandatory = $true)][string]$Printer,   # printer name OR its share name
  [Parameter(Mandatory = $true)][string]$Path
)
$ErrorActionPreference = 'Stop'

# printer.txt holds the SHARE name; the spooler needs the printer NAME.
try {
  $p = Get-Printer -ErrorAction Stop | Where-Object { $_.Name -eq $Printer -or $_.ShareName -eq $Printer } | Select-Object -First 1
  if ($p) { $Printer = $p.Name }
} catch { }

if (-not ('HallmarkRawPrint' -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class HallmarkRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);

  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      throw new Exception("printer '" + printer + "' not found (error " + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = "Hallmark Tag";
      di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0)
        throw new Exception("StartDocPrinter failed (error " + Marshal.GetLastWin32Error() + ")");
      try {
        StartPagePrinter(h);
        int written;
        if (!WritePrinter(h, data, data.Length, out written) || written != data.Length)
          throw new Exception("WritePrinter failed (error " + Marshal.GetLastWin32Error() + ")");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
}

[HallmarkRawPrint]::Send($Printer, [System.IO.File]::ReadAllBytes($Path))
Write-Output "sent to $Printer"
