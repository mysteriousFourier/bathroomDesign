param(
    [string]$Version,
    [string]$OutputDirectory = "release",
    [switch]$SkipBuild,
    [switch]$WithoutModelAssets
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Package = Get-Content -LiteralPath (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json
if (-not $Version) {
    $Version = [string]$Package.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
    throw "Version '$Version' is not a supported semantic version."
}
if ([string]$Package.version -ne $Version) {
    throw "Requested version $Version does not match package.json version $($Package.version)."
}

Set-Location $ProjectRoot
$GitStatus = @(& git status --porcelain --untracked-files=normal)
if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect the Git worktree."
}
if ($GitStatus.Count -gt 0) {
    throw "Refusing to package a worktree with uncommitted changes. Commit or stash them first."
}

if (-not $SkipBuild) {
    & npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend build failed."
    }
}
$DistIndex = Join-Path $ProjectRoot "dist\index.html"
if (-not (Test-Path -LiteralPath $DistIndex -PathType Leaf)) {
    throw "dist/index.html is missing. Run the frontend build before packaging."
}

$ModelAssets = Join-Path $ProjectRoot "public\model-library\models"
if (-not $WithoutModelAssets -and -not (Test-Path -LiteralPath $ModelAssets -PathType Container)) {
    throw "Built-in model assets are missing. Use -WithoutModelAssets only for a source-only package."
}

$OutputRoot = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
    [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $OutputDirectory))
}
$TempRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot ".tmp\release-package"))
$ExpectedTempPrefix = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot ".tmp")) + [System.IO.Path]::DirectorySeparatorChar
if (-not $TempRoot.StartsWith($ExpectedTempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Resolved staging directory is outside the project temporary directory."
}

if (Test-Path -LiteralPath $TempRoot) {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $TempRoot | Out-Null
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

$BundleName = "bathroom-spatial-studio-v$Version"
$BundleRoot = Join-Path $TempRoot $BundleName
New-Item -ItemType Directory -Path $BundleRoot | Out-Null

try {
    $TrackedFiles = @(& git -c core.quotepath=false ls-files)
    if ($LASTEXITCODE -ne 0 -or $TrackedFiles.Count -eq 0) {
        throw "Unable to enumerate tracked release files."
    }
    foreach ($RelativePath in $TrackedFiles) {
        $Source = Join-Path $ProjectRoot $RelativePath
        if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
            throw "Tracked file is missing: $RelativePath"
        }
        $Destination = Join-Path $BundleRoot $RelativePath
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
        Copy-Item -LiteralPath $Source -Destination $Destination
    }

    Copy-Item -LiteralPath (Join-Path $ProjectRoot "dist") -Destination $BundleRoot -Recurse
    if (-not $WithoutModelAssets) {
        $PackagedModelDirectory = Join-Path $BundleRoot "public\model-library\models"
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PackagedModelDirectory) | Out-Null
        Copy-Item -LiteralPath $ModelAssets -Destination $PackagedModelDirectory -Recurse
        if (@(Get-ChildItem -LiteralPath $PackagedModelDirectory -Recurse -File).Count -eq 0) {
            throw "The built-in model asset directory is empty."
        }
    }

    $Commit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to resolve the release commit."
    }
    $PackagedFiles = @(Get-ChildItem -LiteralPath $BundleRoot -Recurse -File)
    $Manifest = [ordered]@{
        product = "Bathroom Spatial Studio"
        version = $Version
        commit = $Commit
        built_at_utc = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
        model_assets_included = -not [bool]$WithoutModelAssets
        payload_file_count = $PackagedFiles.Count
        payload_uncompressed_bytes = [long](($PackagedFiles | Measure-Object -Property Length -Sum).Sum)
    }
    $Manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $BundleRoot "RELEASE-MANIFEST.json") -Encoding utf8

    $ArchivePath = Join-Path $OutputRoot "$BundleName.zip"
    if (Test-Path -LiteralPath $ArchivePath) {
        Remove-Item -LiteralPath $ArchivePath -Force
    }
    Compress-Archive -LiteralPath $BundleRoot -DestinationPath $ArchivePath -CompressionLevel Optimal

    $Hash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $ChecksumPath = Join-Path $OutputRoot "$BundleName.sha256"
    Set-Content -LiteralPath $ChecksumPath -Value "$Hash  $BundleName.zip" -Encoding ascii

    Write-Host "Release archive: $ArchivePath"
    Write-Host "SHA-256:        $Hash"
    Write-Host "Checksum file:  $ChecksumPath"
}
finally {
    if (Test-Path -LiteralPath $TempRoot) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force
    }
}
