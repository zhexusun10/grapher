param([Parameter(Mandatory = $true)][string] $CleanupScript)
$ErrorActionPreference = 'Stop'
. $CleanupScript -InstallDirectory ([System.IO.Path]::GetTempPath())

$script:processPaths = @{}
$script:queryFailures = @{}
function Get-CimInstance {
    param([string] $ClassName, [string] $Filter, [string] $ErrorAction)
    $processId = [int] ($Filter -replace '^ProcessId = ', '')
    if ($script:queryFailures.ContainsKey($processId)) { throw 'Process query unavailable' }
    [pscustomobject] @{ ExecutablePath = $script:processPaths[$processId] }
}
function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}
function New-TestProcess([int] $Id, [string] $ImagePath) {
    $script:processPaths[$Id] = $ImagePath
    $process = [pscustomobject] @{
        Id = $Id; Handle = $Id; HasExited = $false; Killed = $false
        Disposed = $false; KillFailure = $false; WaitTimeout = $false; ExitRace = $false
    }
    $process | Add-Member ScriptMethod Kill {
        if ($this.ExitRace) { $this.HasExited = $true; throw 'Process already exited' }
        if ($this.KillFailure) { throw 'Access denied' }
        $this.Killed = $true
        $this.HasExited = -not $this.WaitTimeout
    }
    $process | Add-Member ScriptMethod WaitForExit { param([int] $Milliseconds) return (-not $this.WaitTimeout) }
    $process | Add-Member ScriptMethod Dispose { $this.Disposed = $true }
    return $process
}

$install = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ("Grapher user's & workspace " + [char] 0x6d4b + [char] 0x8bd5))
$target = [System.IO.Path]::Combine($install, 'runtime', 'grapher.exe')
$ours = New-TestProcess 1 $target.ToUpperInvariant()
$cli = New-TestProcess 2 ([System.IO.Path]::Combine($install, 'cli', 'grapher.exe'))
$gui = New-TestProcess 3 ([System.IO.Path]::Combine($install, 'Grapher.exe'))
$other = New-TestProcess 4 ([System.IO.Path]::Combine(($install + '-other'), 'runtime', 'grapher.exe'))
$unknown = New-TestProcess 5 ''
Stop-GrapherInstallationRuntime -InstallDirectory ([System.IO.Path]::Combine($install, '.')) -Processes @($ours, $cli, $gui, $other, $unknown)
Assert-True $ours.Killed 'The matching installation runtime must be stopped, including case differences'
foreach ($process in @($cli, $gui, $other, $unknown)) {
    Assert-True (-not $process.Killed) 'A CLI, GUI, other installation or unknown image must remain alive'
    Assert-True $process.Disposed 'Inspection handles must be released'
}
Assert-True $ours.Disposed 'The terminated process handle must be released'

$gone = New-TestProcess 6 $target
$gone.ExitRace = $true
Stop-GrapherInstallationRuntime -InstallDirectory $install -Processes @($gone)
Assert-True $gone.Disposed 'Concurrent exit must release its inspection handle'

foreach ($failure in @('KillFailure', 'WaitTimeout', 'QueryFailure')) {
    $process = New-TestProcess 7 $target
    if ($failure -eq 'QueryFailure') { $script:queryFailures[7] = $true }
    else { $process.$failure = $true }
    $failed = $false
    try { Stop-GrapherInstallationRuntime -InstallDirectory $install -Processes @($process) }
    catch { $failed = $true }
    Assert-True $failed "$failure must stop the upgrade instead of allowing stale files to survive"
    Assert-True $process.Disposed "$failure must release its inspection handle"
}
Write-Output 'Scoped cleanup policy checks passed.'
