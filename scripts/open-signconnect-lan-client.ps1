[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ServerAddress,
    [ValidateRange(1, 65535)]
    [int]$Port = 3000,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$parsedAddress = $null
if (-not [System.Net.IPAddress]::TryParse($ServerAddress, [ref]$parsedAddress) -or
    $parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw 'ServerAddress must be a private IPv4 address.'
}
$addressBytes = $parsedAddress.GetAddressBytes()
$first = [int]$addressBytes[0]
$second = [int]$addressBytes[1]
$isPrivate = $first -eq 10 -or
    ($first -eq 172 -and $second -ge 16 -and $second -le 31) -or
    ($first -eq 192 -and $second -eq 168)
if (-not $isPrivate) {
    throw 'ServerAddress must be a private IPv4 address.'
}

$origin = "http://${ServerAddress}:$Port"
$profileRoot = Join-Path $env:LOCALAPPDATA 'SignConnect\LanBrowserProfile'
$secureOriginSwitch = "--unsafely-treat-insecure-origin-as-secure=$origin"
if ($DryRun) {
    [pscustomobject]@{
        origin = $origin
        profilePath = $profileRoot
        secureOriginSwitch = $secureOriginSwitch
    } | ConvertTo-Json
    exit 0
}

$browserCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
)
$browserPath = $browserCandidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
    Select-Object -First 1
if (-not $browserPath) {
    throw 'Microsoft Edge or Google Chrome is required on the client laptop.'
}

New-Item -ItemType Directory -Force -Path $profileRoot | Out-Null
Start-Process -FilePath $browserPath -ArgumentList @(
    "--user-data-dir=`"$profileRoot`"",
    $secureOriginSwitch,
    '--new-window',
    $origin
)

Write-Host "Opened SignConnect at $origin in an isolated development browser profile."
