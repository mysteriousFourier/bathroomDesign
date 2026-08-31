param(
    [string]$SourceDirectory,
    [string]$TargetDirectory,
    [switch]$SkipHashValidation
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TargetRoot = if ($TargetDirectory) {
    [System.IO.Path]::GetFullPath($TargetDirectory)
} else {
    Join-Path $ProjectRoot "public\model-library\models"
}
$ManifestPath = Join-Path $ProjectRoot "public\model-library\manifest.json"
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "Model library manifest is missing: $ManifestPath"
}

$SearchRoots = if ($SourceDirectory) {
    @([System.IO.Path]::GetFullPath($SourceDirectory))
} else {
    @($ProjectRoot, (Split-Path -Parent $ProjectRoot))
}
$ArchivePaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$ExtractedRoots = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($SearchRoot in $SearchRoots) {
    if (-not (Test-Path -LiteralPath $SearchRoot -PathType Container)) {
        continue
    }
    foreach ($Archive in Get-ChildItem -LiteralPath $SearchRoot -File -Filter "bathroom-model-assets-v*.zip") {
        [void]$ArchivePaths.Add($Archive.FullName)
    }
    foreach ($Directory in Get-ChildItem -LiteralPath $SearchRoot -Directory -Filter "bathroom-model-assets-v*") {
        [void]$ExtractedRoots.Add($Directory.FullName)
    }
}

if ($ArchivePaths.Count -eq 0 -and $ExtractedRoots.Count -eq 0) {
    throw "No model asset package was found. Place all bathroom-model-assets-v*.zip files beside the extracted application directory and try again."
}

$TempRoot = Join-Path $ProjectRoot ".tmp\model-assets-install"
if (Test-Path -LiteralPath $TempRoot) {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null

try {
    $ArchiveNumber = 0
    foreach ($ArchivePath in @($ArchivePaths | Sort-Object)) {
        $ArchiveNumber++
        $ExtractRoot = Join-Path $TempRoot ("part-{0:D2}" -f $ArchiveNumber)
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractRoot -Force
        [void]$ExtractedRoots.Add($ExtractRoot)
        Write-Host "Extracted: $ArchivePath"
    }

    $SourceModelRoots = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($ExtractedRoot in $ExtractedRoots) {
        if ((Split-Path -Leaf $ExtractedRoot) -eq "models") {
            [void]$SourceModelRoots.Add($ExtractedRoot)
        }
        foreach ($ModelsDirectory in Get-ChildItem -LiteralPath $ExtractedRoot -Directory -Recurse | Where-Object { $_.Name -eq "models" }) {
            [void]$SourceModelRoots.Add($ModelsDirectory.FullName)
        }
    }
    if ($SourceModelRoots.Count -eq 0) {
        throw "The located model packages do not contain a models directory."
    }

    foreach ($SourceModelRoot in $SourceModelRoots) {
        foreach ($Item in Get-ChildItem -LiteralPath $SourceModelRoot -Force) {
            Copy-Item -LiteralPath $Item.FullName -Destination $TargetRoot -Recurse -Force
        }
    }

    $Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $Missing = [System.Collections.ArrayList]::new()
    $HashFailures = [System.Collections.ArrayList]::new()
    foreach ($Asset in $Manifest.assets) {
        $DecodedSource = [System.Uri]::UnescapeDataString([string]$Asset.src)
        if (-not $DecodedSource.StartsWith('/model-library/models/', [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        $RelativePath = $DecodedSource -replace '^/model-library/models/', ''
        $AssetPath = Join-Path $TargetRoot ($RelativePath -replace '/', [System.IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path -LiteralPath $AssetPath -PathType Leaf)) {
            [void]$Missing.Add($RelativePath)
            continue
        }
        if (-not $SkipHashValidation -and $Asset.sha256) {
            $ActualHash = (Get-FileHash -LiteralPath $AssetPath -Algorithm SHA256).Hash
            if ($ActualHash -ne [string]$Asset.sha256) {
                [void]$HashFailures.Add($RelativePath)
            }
        }
    }
    if ($Missing.Count -gt 0) {
        throw "Model installation is incomplete. Missing manifest assets: $($Missing -join ', ')"
    }
    if ($HashFailures.Count -gt 0) {
        throw "Model installation failed integrity checks: $($HashFailures -join ', ')"
    }

    $InstalledFiles = @(Get-ChildItem -LiteralPath $TargetRoot -File -Recurse)
    Write-Host "Model library installed successfully."
    Write-Host "Target: $TargetRoot"
    Write-Host "Files:  $($InstalledFiles.Count)"
}
finally {
    if (Test-Path -LiteralPath $TempRoot) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force
    }
}
