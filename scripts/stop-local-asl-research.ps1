[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runRoot = Join-Path $workspaceRoot '.run\asl-research'
$processFile = Join-Path $runRoot 'processes.json'

if (-not (Test-Path -LiteralPath $processFile -PathType Leaf)) {
    Write-Host 'No SignConnect ASL research process record was found.'
    return
}

$entries = @(Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json)
foreach ($entry in $entries) {
    $process = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    # PowerShell 7 may deserialize an ISO timestamp directly to DateTime and
    # then stringify it using the current locale. Casting handles either the
    # original ISO string or the already-typed DateTime without locale parsing.
    $recorded = ([DateTimeOffset]$entry.startedAt).UtcDateTime
    if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $recorded).TotalSeconds) -gt 5) {
        Write-Warning "Skipped reused PID $($entry.pid) for $($entry.name)."
        continue
    }
    taskkill /PID $entry.pid /T /F | Out-Null
}

Remove-Item -LiteralPath $processFile -Force
Write-Host 'Stopped the SignConnect ASL research stack.'
