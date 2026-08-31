param(
    [string]$Version,
    [string]$OutputDirectory = "release",
    [long]$MaxPartPayloadBytes = 180MB
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
if ($MaxPartPayloadBytes -le 0 -or $MaxPartPayloadBytes -ge 200MB) {
    throw "MaxPartPayloadBytes must be greater than zero and less than 200 MiB."
}

Set-Location $ProjectRoot
$GitStatus = @(& git status --porcelain --untracked-files=normal)
if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect the Git worktree."
}
if ($GitStatus.Count -gt 0) {
    throw "Refusing to package a worktree with uncommitted changes. Commit or stash them first."
}

$ModelRoot = Join-Path $ProjectRoot "public\model-library\models"
if (-not (Test-Path -LiteralPath $ModelRoot -PathType Container)) {
    throw "Built-in model assets are missing: $ModelRoot"
}

$ModelDirectories = @(Get-ChildItem -LiteralPath $ModelRoot -Directory | ForEach-Object {
    $Files = @(Get-ChildItem -LiteralPath $_.FullName -File -Recurse)
    [PSCustomObject]@{
        Directory = $_
        Bytes = [long](($Files | Measure-Object -Property Length -Sum).Sum)
        FileCount = $Files.Count
    }
} | Sort-Object -Property Bytes -Descending)
if ($ModelDirectories.Count -eq 0) {
    throw "The built-in model asset directory is empty."
}

$Bins = [System.Collections.ArrayList]::new()
foreach ($ModelDirectory in $ModelDirectories) {
    if ($ModelDirectory.Bytes -gt $MaxPartPayloadBytes) {
        throw "Model directory '$($ModelDirectory.Directory.Name)' exceeds the per-part payload limit."
    }
    $TargetBin = $null
    foreach ($Bin in $Bins) {
        if (($Bin.Bytes + $ModelDirectory.Bytes) -le $MaxPartPayloadBytes) {
            $TargetBin = $Bin
            break
        }
    }
    if ($null -eq $TargetBin) {
        $TargetBin = [PSCustomObject]@{
            Directories = [System.Collections.ArrayList]::new()
            Bytes = [long]0
            FileCount = 0
        }
        [void]$Bins.Add($TargetBin)
    }
    [void]$TargetBin.Directories.Add($ModelDirectory.Directory)
    $TargetBin.Bytes += $ModelDirectory.Bytes
    $TargetBin.FileCount += $ModelDirectory.FileCount
}

$OutputRoot = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
    [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $OutputDirectory))
}
$TempRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot ".tmp\model-assets-package"))
$ExpectedTempPrefix = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot ".tmp")) + [System.IO.Path]::DirectorySeparatorChar
if (-not $TempRoot.StartsWith($ExpectedTempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Resolved staging directory is outside the project temporary directory."
}

if (Test-Path -LiteralPath $TempRoot) {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $TempRoot | Out-Null
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

$PartResults = [System.Collections.ArrayList]::new()
try {
    for ($Index = 0; $Index -lt $Bins.Count; $Index++) {
        $PartNumber = $Index + 1
        $PartLabel = "{0:D2}-of-{1:D2}" -f $PartNumber, $Bins.Count
        $BundleName = "bathroom-model-assets-v$Version-part$PartLabel"
        $BundleRoot = Join-Path $TempRoot $BundleName
        $BundleModelRoot = Join-Path $BundleRoot "models"
        New-Item -ItemType Directory -Path $BundleModelRoot -Force | Out-Null

        foreach ($Directory in $Bins[$Index].Directories) {
            Copy-Item -LiteralPath $Directory.FullName -Destination $BundleModelRoot -Recurse
        }

        $Manifest = [ordered]@{
            product = "Bathroom Spatial Studio model assets"
            version = $Version
            part = $PartNumber
            part_count = $Bins.Count
            model_directories = @($Bins[$Index].Directories | ForEach-Object { $_.Name })
            payload_file_count = $Bins[$Index].FileCount
            payload_uncompressed_bytes = $Bins[$Index].Bytes
        }
        $Manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $BundleRoot "MODEL-ASSETS-PART.json") -Encoding utf8

        $ArchivePath = Join-Path $OutputRoot "$BundleName.zip"
        if (Test-Path -LiteralPath $ArchivePath) {
            Remove-Item -LiteralPath $ArchivePath -Force
        }
        Compress-Archive -Path (Join-Path $BundleRoot "*") -DestinationPath $ArchivePath -CompressionLevel Optimal
        $Archive = Get-Item -LiteralPath $ArchivePath
        if ($Archive.Length -ge 200MB) {
            throw "Generated archive '$($Archive.Name)' is not below 200 MiB."
        }

        $Hash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        $ChecksumPath = Join-Path $OutputRoot "$BundleName.sha256"
        Set-Content -LiteralPath $ChecksumPath -Value "$Hash  $BundleName.zip" -Encoding ascii
        [void]$PartResults.Add([ordered]@{
            file = $Archive.Name
            sha256 = $Hash
            archive_bytes = $Archive.Length
            payload_uncompressed_bytes = $Bins[$Index].Bytes
            model_directory_count = $Bins[$Index].Directories.Count
            payload_file_count = $Bins[$Index].FileCount
        })

        Write-Host "Model archive: $ArchivePath"
        Write-Host "SHA-256:      $Hash"
    }

    $IndexPath = Join-Path $OutputRoot "bathroom-model-assets-v$Version.json"
    [ordered]@{
        product = "Bathroom Spatial Studio model assets"
        version = $Version
        part_count = $PartResults.Count
        install = "Place all part ZIP files beside the extracted application directory, then run install-model-assets.bat."
        parts = @($PartResults)
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $IndexPath -Encoding utf8
    Write-Host "Model index:   $IndexPath"
}
finally {
    if (Test-Path -LiteralPath $TempRoot) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force
    }
}
