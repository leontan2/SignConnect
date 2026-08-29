param(
    [string]$JavaHome = "C:\Program Files\Java\jdk-21"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path $PSScriptRoot -Parent

if (-not (Test-Path (Join-Path $JavaHome "bin\java.exe"))) {
    throw "JDK 21 was not found at '$JavaHome'. Pass its location with -JavaHome."
}

$env:JAVA_HOME = $JavaHome

Push-Location (Join-Path $repositoryRoot "backend")
try {
    & .\mvnw.cmd test
    if ($LASTEXITCODE -ne 0) {
        throw "Backend verification failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

Push-Location $repositoryRoot
try {
    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend verification failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}