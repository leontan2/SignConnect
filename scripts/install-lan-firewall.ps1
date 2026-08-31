[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 3000,
    [Parameter(Mandatory)]
    [string]$RemoteSubnet,
    [string]$RuleName = 'SignConnect LAN HTTP'
)

$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator access is required to configure the SignConnect LAN firewall rule.'
}

$existingRules = @(Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)
if ($existingRules) {
    $existingRules | Remove-NetFirewallRule
}

New-NetFirewallRule `
    -DisplayName $RuleName `
    -Group 'SignConnect' `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -RemoteAddress $RemoteSubnet `
    -Profile Any | Out-Null

Write-Output "Firewall rule '$RuleName' allows $RemoteSubnet on TCP $Port."
