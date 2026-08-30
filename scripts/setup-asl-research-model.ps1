[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$mlRoot = Join-Path $workspaceRoot 'ml\sign-recognition'
$downloadRoot = Join-Path $workspaceRoot 'downloads\openhands-wlasl'
$sourceRoot = Join-Path $workspaceRoot 'downloads\openhands-source'
$candidateRoot = Join-Path $downloadRoot 'candidates\slgcn'
$metadataRoot = Join-Path $downloadRoot 'metadata'
$outputRoot = Join-Path $workspaceRoot 'runtime-models\asl-research'

$sourceRevision = 'fc4599d2c6a9e68d002bb2e1832a835e9b8b512d'
$checkpointArchiveSha256 = 'b37b8412d2577e30956fb8deb939091d493cad80c2936f8770b0f1cb9714eaf7'
$checkpointSha256 = 'e765c49adae1adc817a8f00331bf7561775e033e58d2cc28cabcd9ee1402bc7c'
$metadataArchiveSha256 = '4828ae6b9a630a0169feabc6ab14668e40ea95d477b842b37175e4bd8a16932a'
$checkpointArchive = Join-Path $downloadRoot 'wlasl_slgcn.zip'
$metadataArchive = Join-Path $downloadRoot 'wlasl_metadata.zip'
$checkpointPath = Join-Path $candidateRoot 'wlasl\sl_gcn\epoch=169-step=75819.ckpt'
$vocabularyPath = Join-Path $metadataRoot 'splits\asl2000.json'

function Assert-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found on PATH."
    }
}

function Assert-Hash([string]$Path, [string]$Expected) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required file is missing: $Path"
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected) {
        throw "SHA-256 verification failed for $Path."
    }
}

function Receive-VerifiedArchive([string]$Uri, [string]$Path, [string]$ExpectedHash) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        try {
            Assert-Hash $Path $ExpectedHash
            return
        } catch {
            Remove-Item -LiteralPath $Path -Force
        }
    }
    Invoke-WebRequest -Uri $Uri -OutFile $Path -UseBasicParsing
    Assert-Hash $Path $ExpectedHash
}

Assert-Command 'git'
Assert-Command 'uv'
New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null

Receive-VerifiedArchive `
    'https://github.com/AI4Bharat/OpenHands/releases/download/checkpoints_v1/wlasl_slgcn.zip' `
    $checkpointArchive `
    $checkpointArchiveSha256
Receive-VerifiedArchive `
    'https://github.com/AI4Bharat/OpenHands/releases/download/checkpoints_v1/wlasl_metadata.zip' `
    $metadataArchive `
    $metadataArchiveSha256

if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot '.git') -PathType Container)) {
    git clone --filter=blob:none --no-checkout https://github.com/AI4Bharat/OpenHands.git $sourceRoot
    if ($LASTEXITCODE -ne 0) { throw 'Unable to clone the OpenHands source.' }
}
git -C $sourceRoot fetch --depth 1 origin $sourceRevision
if ($LASTEXITCODE -ne 0) { throw 'Unable to fetch the pinned OpenHands revision.' }
git -C $sourceRoot checkout --detach $sourceRevision
if ($LASTEXITCODE -ne 0) { throw 'Unable to select the pinned OpenHands revision.' }
$actualRevision = (git -C $sourceRoot rev-parse HEAD).Trim()
if ($actualRevision -ne $sourceRevision) { throw 'OpenHands source revision verification failed.' }

if (-not (Test-Path -LiteralPath $checkpointPath -PathType Leaf)) {
    New-Item -ItemType Directory -Force -Path $candidateRoot | Out-Null
    Expand-Archive -LiteralPath $checkpointArchive -DestinationPath $candidateRoot -Force
}
if (-not (Test-Path -LiteralPath $vocabularyPath -PathType Leaf)) {
    New-Item -ItemType Directory -Force -Path $metadataRoot | Out-Null
    Expand-Archive -LiteralPath $metadataArchive -DestinationPath $metadataRoot -Force
}
Assert-Hash $checkpointPath $checkpointSha256

uv sync --project $mlRoot --extra test --extra asl-research --frozen
if ($LASTEXITCODE -ne 0) { throw 'Unable to create the locked model environment.' }
uv run --project $mlRoot --extra asl-research --frozen python -m signconnect_ml.cli `
    prepare-asl-research `
    --source-root $sourceRoot `
    --checkpoint $checkpointPath `
    --vocabulary $vocabularyPath `
    --output-directory $outputRoot
if ($LASTEXITCODE -ne 0) { throw 'Unable to export the local ASL research model.' }

Write-Host "ASL research model ready in $outputRoot"
