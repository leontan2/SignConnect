[CmdletBinding()]
param(
    [string]$JavaHome = ''
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backendRoot = Join-Path $workspaceRoot 'backend'
$runRoot = Join-Path $workspaceRoot '.run\asl-research'
$modelPath = Join-Path $workspaceRoot 'runtime-models\asl-research\models\openhands-wlasl-slgcn-core-v2.onnx'
$metadataPath = "$modelPath.metadata.json"
$requiredPorts = 3000, 3001, 8081, 8082, 8083

if (-not (Test-Path -LiteralPath $modelPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
    throw 'The ASL research model is missing. Run .\scripts\setup-asl-research-model.ps1 first.'
}
foreach ($port in $requiredPorts) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        throw "Port $port is already in use. Stop the existing SignConnect stack first."
    }
}
if ($JavaHome) {
    $resolvedJavaHome = (Resolve-Path -LiteralPath $JavaHome).Path
    $env:JAVA_HOME = $resolvedJavaHome
    $env:Path = "$(Join-Path $resolvedJavaHome 'bin');$env:Path"
}
if (Test-Path -LiteralPath 'C:\jtmp' -PathType Container) {
    $env:TEMP = 'C:\jtmp'
    $env:TMP = 'C:\jtmp'
}

New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
$started = @()

function Start-LoggedProcess(
    [string]$Name,
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory
) {
    $process = Start-Process `
        -FilePath $FilePath `
        -ArgumentList $ArgumentList `
        -WorkingDirectory $WorkingDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runRoot "$Name.out.log") `
        -RedirectStandardError (Join-Path $runRoot "$Name.err.log") `
        -PassThru
    $script:started += [pscustomobject]@{
        name = $Name
        pid = $process.Id
        startedAt = $process.StartTime.ToUniversalTime().ToString('o')
    }
}

function Wait-Endpoint([string]$Name, [string]$Uri, [int]$TimeoutSeconds = 180) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { return }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Name did not become ready at $Uri."
}

try {
    $env:SERVER_ADDRESS = '127.0.0.1'
    Start-LoggedProcess 'meeting-service' 'cmd.exe' `
        @('/d', '/s', '/c', 'mvnw.cmd -pl meeting-service spring-boot:run') $backendRoot

    $env:SPRING_PROFILES_ACTIVE = 'local'
    $env:SIGN_MODEL_RESOURCE = "file:$($modelPath.Replace('\', '/'))"
    $env:SIGN_MODEL_LABELS_RESOURCE = "file:$($metadataPath.Replace('\', '/'))"
    $env:SIGN_MODEL_EXPECTED_VERSION = 'asl-wlasl-slgcn-core-v2'
    $env:SIGN_MODEL_ALLOW_MOCK_MODEL = 'false'
    Start-LoggedProcess 'sign-inference-service' 'cmd.exe' `
        @('/d', '/s', '/c', 'mvnw.cmd -pl sign-inference-service spring-boot:run') $backendRoot

    $env:SIGN_INFERENCE_URL = 'http://127.0.0.1:8083'
    Start-LoggedProcess 'realtime-service' 'cmd.exe' `
        @('/d', '/s', '/c', 'mvnw.cmd -pl realtime-service spring-boot:run') $backendRoot

    $env:MEETING_API_URL = 'http://127.0.0.1:8081'
    $env:REALTIME_WS_URL = 'ws://127.0.0.1:8082'
    $env:MEETING_REMOTE_URL = 'http://127.0.0.1:3001/remoteEntry.js'
    $env:ROOM_PREVIEW_TOOLS_ENABLED = 'true'
    Start-LoggedProcess 'frontend' 'cmd.exe' @('/d', '/s', '/c', 'npm run dev') $workspaceRoot

    $started | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'processes.json') -Encoding UTF8
    Wait-Endpoint 'Meeting service' 'http://127.0.0.1:8081/actuator/health'
    Wait-Endpoint 'Inference model' 'http://127.0.0.1:8083/actuator/health/readiness'
    Wait-Endpoint 'Realtime service' 'http://127.0.0.1:8082/actuator/health'
    Wait-Endpoint 'Meeting frontend' 'http://127.0.0.1:3001/remoteEntry.js'
    Wait-Endpoint 'SignConnect shell' 'http://127.0.0.1:3000/'
} catch {
    foreach ($entry in $started) {
        taskkill /PID $entry.pid /T /F 2>$null | Out-Null
    }
    throw
}

Write-Host 'SignConnect is ready at http://127.0.0.1:3000/'
Write-Host 'Use .\scripts\stop-local-asl-research.ps1 to stop all started processes.'
