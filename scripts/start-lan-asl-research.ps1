[CmdletBinding()]
param(
    [string]$LanHost = '',
    [string]$JavaHome = '',
    [switch]$DryRun,
    [switch]$SkipFirewallSetup
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeScript = Join-Path $PSScriptRoot 'lan-runtime.mjs'
$firewallScript = Join-Path $PSScriptRoot 'install-lan-firewall.ps1'
$lanStateRoot = Join-Path $workspaceRoot '.run\lan-access'
$firewallState = Join-Path $lanStateRoot 'firewall-ready.json'

function Find-PrivateLanConnection([string]$RequestedHost) {
    $interfaces = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        Where-Object {
            $_.OperationalStatus -eq [System.Net.NetworkInformation.OperationalStatus]::Up -and
            $_.NetworkInterfaceType -ne [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback
        }

    foreach ($interface in $interfaces) {
        $properties = $interface.GetIPProperties()
        if (-not ($properties.GatewayAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' })) {
            continue
        }
        foreach ($unicast in $properties.UnicastAddresses) {
            if ($unicast.Address.AddressFamily -ne 'InterNetwork' -or -not $unicast.IPv4Mask) { continue }
            $candidate = $unicast.Address.IPAddressToString
            if ($RequestedHost -and $candidate -ne $RequestedHost) { continue }
            $parts = $candidate.Split('.')
            if ($parts.Count -ne 4) { continue }
        $first = [int]$parts[0]
        $second = [int]$parts[1]
            $isPrivate = $first -eq 10 -or
            ($first -eq 172 -and $second -ge 16 -and $second -le 31) -or
                ($first -eq 192 -and $second -eq 168)
            if (-not $isPrivate) { continue }

            $addressBytes = $unicast.Address.GetAddressBytes()
            $maskBytes = $unicast.IPv4Mask.GetAddressBytes()
            $networkBytes = for ($index = 0; $index -lt 4; $index++) {
                $addressBytes[$index] -band $maskBytes[$index]
            }
            $networkAddress = [System.Net.IPAddress]::new([byte[]]$networkBytes).IPAddressToString
            $prefixLength = ($maskBytes | ForEach-Object {
                ([Convert]::ToString($_, 2).ToCharArray() | Where-Object { $_ -eq '1' }).Count
            } | Measure-Object -Sum).Sum
            return [pscustomobject]@{
                address = $candidate
                remoteSubnet = "$networkAddress/$prefixLength"
            }
        }
    }
    if ($RequestedHost) {
        throw "The requested LAN host $RequestedHost is not assigned to an active private network adapter."
    }
    throw 'No active private IPv4 network with a default gateway was found.'
}

function Ensure-LanFirewall {
    if ($SkipFirewallSetup) { return }
    if (Test-Path -LiteralPath $firewallState -PathType Leaf) {
        $recordedFirewall = Get-Content -LiteralPath $firewallState -Raw | ConvertFrom-Json
        if ($recordedFirewall.host -eq $LanHost -and $recordedFirewall.remoteSubnet -eq $RemoteSubnet) {
            return
        }
    }

    New-Item -ItemType Directory -Force -Path $lanStateRoot | Out-Null
    $argumentList = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', "`"$firewallScript`"",
        '-Port', '3000',
        '-RemoteSubnet', $RemoteSubnet
    )
    $firewallProcess = Start-Process `
        -FilePath 'powershell.exe' `
        -ArgumentList $argumentList `
        -Verb RunAs `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
    if ($firewallProcess.ExitCode -ne 0) {
        throw 'The SignConnect Private-network firewall setup was cancelled or failed.'
    }

    [pscustomobject]@{
        ruleName = 'SignConnect LAN HTTP'
        host = $LanHost
        remoteSubnet = $RemoteSubnet
        port = 3000
    } | ConvertTo-Json | Set-Content -LiteralPath $firewallState -Encoding UTF8
}

$connection = Find-PrivateLanConnection $LanHost
$LanHost = $connection.address
$RemoteSubnet = $connection.remoteSubnet

$runtimeJson = & node $runtimeScript describe --host $LanHost
if ($LASTEXITCODE -ne 0) {
    throw "Unable to describe the SignConnect LAN runtime for $LanHost."
}

if ($DryRun) {
    Write-Output ($runtimeJson -join [Environment]::NewLine)
    exit 0
}

Ensure-LanFirewall
$startArguments = @{
    AccessMode = 'Lan'
    LanHost = $LanHost
}
if ($JavaHome) { $startArguments.JavaHome = $JavaHome }

& (Join-Path $PSScriptRoot 'start-local-asl-research.ps1') @startArguments
if ($LASTEXITCODE -ne 0) { throw 'The SignConnect LAN stack failed to start.' }

Write-Host "On the other laptop, use .\scripts\open-signconnect-lan-client.ps1 -ServerAddress $LanHost"
