param(
    [string]$JavaHome = $env:JAVA_HOME
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path $PSScriptRoot -Parent
$isWindowsHost = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
$javaExecutableName = if ($isWindowsHost) { "java.exe" } else { "java" }
$mavenWrapperName = if ($isWindowsHost) { "mvnw.cmd" } else { "mvnw" }

if ([string]::IsNullOrWhiteSpace($JavaHome)) {
    if (-not (Get-Command $javaExecutableName -ErrorAction SilentlyContinue)) {
        throw "A compatible JDK 21 was not found via JAVA_HOME or PATH. Pass its location with -JavaHome."
    }
} else {
    $javaExecutable = Join-Path (Join-Path $JavaHome "bin") $javaExecutableName
    if (-not (Test-Path -LiteralPath $javaExecutable -PathType Leaf)) {
        throw "JAVA_HOME does not contain $javaExecutableName. Pass a compatible JDK 21 location with -JavaHome."
    }
    $env:JAVA_HOME = $JavaHome
}

$env:PLAYWRIGHT_HTML_OPEN = "never"

# Enumerate the process environment so case variants are removed on hosts where
# environment variable names are case-sensitive. Local Spring config/logging and
# JVM/Node debug hooks must not alter or disclose data during the repository gate.
$blockedEnvironmentNames = @(
    "SERVER_PORT",
    "SIGN_MODEL_RESOURCE",
    "SIGN_MODEL_LABELS_RESOURCE",
    "SIGN_MODEL_INPUT_NAME",
    "SIGN_MODEL_OUTPUT_NAME",
    "SIGN_MODEL_EXPECTED_VERSION",
    "SIGN_MODEL_ALLOW_MOCK_MODEL",
    "SIGN_INFERENCE_URL",
    "SIGN_INFERENCE_TIMEOUT",
    "SIGN_RECOGNITION_WINDOW_FRAMES",
    "SIGN_RECOGNITION_STRIDE_FRAMES",
    "SIGN_RECOGNITION_INPUT_MODE",
    "SIGN_RECOGNITION_CONFIDENCE_THRESHOLD",
    "SIGN_RECOGNITION_STABLE_ACTIVE_EVALUATIONS",
    "SIGN_RECOGNITION_IDLE_EVALUATIONS",
    "SIGN_RECOGNITION_DUPLICATE_COOLDOWN",
    "SIGN_RECOGNITION_UNKNOWN_RATE_LIMIT",
    "SIGN_RECOGNITION_TRACKING_TIMEOUT",
    "SIGN_RECOGNITION_MAX_MESSAGE_SIZE",
    "SIGNCONNECT_RECOGNITION_SIMULATOR_ENABLED",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "MAVEN_OPTS",
    "MAVEN_ARGS",
    "NODE_OPTIONS",
    "NODE_DEBUG",
    "NODE_DEBUG_NATIVE",
    "DEBUG",
    "TRACE",
    "PWDEBUG"
)

$processEnvironment = @(Get-ChildItem Env:)
foreach ($environmentEntry in $processEnvironment) {
    $normalizedName = $environmentEntry.Name.ToUpperInvariant()
    $isBlockedName = $blockedEnvironmentNames -contains $normalizedName
    $isSpringOrLoggingOverride = $normalizedName.StartsWith("SPRING_") -or
        $normalizedName.StartsWith("LOGGING_") -or
        $normalizedName.StartsWith("MANAGEMENT_") -or
        $normalizedName.StartsWith("SERVER_")
    $isApplicationOverride = $normalizedName.StartsWith("SIGN_") -or
        $normalizedName.StartsWith("SIGNCONNECT_") -or
        $normalizedName.StartsWith("RECOGNITION_") -or
        $normalizedName.StartsWith("MEETING_") -or
        $normalizedName.StartsWith("REALTIME_")
    if ($isBlockedName -or $isSpringOrLoggingOverride -or $isApplicationOverride) {
        [Environment]::SetEnvironmentVariable($environmentEntry.Name, $null, "Process")
    }
}

$env:RECOGNITION_E2E_FIXTURE_ENABLED = "false"
$env:RECOGNITION_SIMULATOR_ENABLED = "false"

$backendRoot = Join-Path $repositoryRoot "backend"
$mavenWrapper = Join-Path $backendRoot $mavenWrapperName
if (-not (Test-Path -LiteralPath $mavenWrapper -PathType Leaf)) {
    throw "The Maven wrapper was not found at $mavenWrapper."
}

Push-Location $backendRoot
try {
    & $mavenWrapper test
    if ($LASTEXITCODE -ne 0) {
        throw "Backend verification failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

Push-Location $repositoryRoot
try {
    node contracts/sign-recognition-training/v1/validate-fixtures.mjs
    if ($LASTEXITCODE -ne 0) {
        throw "Training contract verification failed with exit code $LASTEXITCODE."
    }

    if (-not (Get-Command "uv" -ErrorAction SilentlyContinue)) {
        throw "uv was not found on PATH. Install uv to verify the reproducible ML environment."
    }
    uv run --project ml/sign-recognition --extra test --frozen pytest -W error
    if ($LASTEXITCODE -ne 0) {
        throw "ML training/export verification failed with exit code $LASTEXITCODE."
    }

    npm test
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend unit and contract verification failed with exit code $LASTEXITCODE."
    }

    npm run typecheck
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend type checking failed with exit code $LASTEXITCODE."
    }

    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend production build failed with exit code $LASTEXITCODE."
    }

    npm run verify:simulator:absent --workspace @signconnect/meeting
    if ($LASTEXITCODE -ne 0) {
        throw "The default Meeting bundle contains development simulator code."
    }

    $meetingDistribution = Join-Path (Join-Path (Join-Path (Join-Path $repositoryRoot "frontend") "apps") "meeting") "dist"
    $fixtureMarker = Get-ChildItem -LiteralPath $meetingDistribution -File -Recurse |
        Select-String -SimpleMatch "Automated E2E fixture capture is active" -List
    if ($fixtureMarker) {
        throw "The default production build contains the compile-time E2E fixture adapter."
    }
} finally {
    Pop-Location
}
