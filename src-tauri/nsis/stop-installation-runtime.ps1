[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $InstallDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Stop-GrapherInstallationRuntime {
    param(
        [Parameter(Mandatory = $true)]
        [string] $InstallDirectory,
        [object[]] $Processes = @([System.Diagnostics.Process]::GetProcessesByName('grapher'))
    )

    $expectedPath = [System.IO.Path]::GetFullPath(
        [System.IO.Path]::Combine($InstallDirectory, 'runtime', 'grapher.exe')
    )
    foreach ($process in $Processes) {
        try {
            # Hold a process handle through identification and termination, so
            # an exited process's PID cannot identify an unrelated replacement.
            try { $null = $process.Handle } catch { continue }
            if ($process.HasExited) { continue }

            # CIM can inspect a 64-bit backend from the 32-bit PowerShell that
            # a 32-bit NSIS installer may launch. MainModule cannot do that.
            try {
                $details = Get-CimInstance -ClassName Win32_Process -Filter (
                    'ProcessId = {0}' -f [int] $process.Id
                ) -ErrorAction Stop
            } catch {
                if ($process.HasExited) { continue }
                throw
            }
            if ($null -eq $details -or [string]::IsNullOrEmpty($details.ExecutablePath)) {
                continue
            }
            $actualPath = [System.IO.Path]::GetFullPath($details.ExecutablePath)
            if (-not [string]::Equals($actualPath, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
                continue
            }

            try {
                $process.Kill()
                if (-not $process.WaitForExit(5000)) {
                    throw 'The old Grapher runtime did not stop. Close this installation and retry.'
                }
            } catch {
                if (-not $process.HasExited) { throw }
            }
        } finally {
            $process.Dispose()
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Stop-GrapherInstallationRuntime -InstallDirectory $InstallDirectory
    } catch {
        [Console]::Error.WriteLine(('Cannot stop the old Grapher runtime: {0}' -f $_.Exception.Message))
        exit 1
    }
    exit 0
}
