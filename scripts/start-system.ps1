param(
    [switch]$CheckOnly,
    [switch]$NoBrowser,
    [switch]$ExitAfterReady
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AppUrl = "http://127.0.0.1:8000"
$HealthUrl = "$AppUrl/api/health"
$BackendProcess = $null

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Require-Command {
    param(
        [string]$Name,
        [string]$InstallHint
    )
    $Command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $Command) {
        throw "Required command '$Name' was not found. $InstallHint"
    }
    return $Command.Source
}

function Invoke-Checked {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$Description
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

function Test-PortOpen {
    param([int]$Port)
    $Client = New-Object System.Net.Sockets.TcpClient
    try {
        $Attempt = $Client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $Attempt.AsyncWaitHandle.WaitOne(300)) {
            return $false
        }
        $Client.EndConnect($Attempt)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $Client.Dispose()
    }
}

function Get-AppHealth {
    try {
        return Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 2
    }
    catch {
        return $null
    }
}

function Get-BackendSourceVersion {
    $SourceDir = Join-Path $ProjectRoot "backend\app"
    $Versions = @(
        Get-ChildItem -LiteralPath $SourceDir -Filter "*.py" -File |
            ForEach-Object { ([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeSeconds() }
    )
    if ($Versions.Count -eq 0) {
        return [long]0
    }
    return [long](($Versions | Measure-Object -Maximum).Maximum)
}

function Get-EnvironmentConfigVersion {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
}

function Get-ListeningProcessId {
    param([int]$Port)
    $Netstat = Join-Path $env:SystemRoot "System32\netstat.exe"
    foreach ($Line in & $Netstat -ano -p TCP) {
        if ($Line -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(?<process>\d+)\s*$") {
            return [int]$Matches.process
        }
    }
    return $null
}

function Test-KnownAppHealth {
    param([object]$Health)
    if ($Health.service_id -eq "bathroom-spatial-studio") {
        return $true
    }
    $LegacyFields = @("ok", "ai_configured", "model", "fallback_model", "ocr_configured")
    $PropertyNames = @($Health.PSObject.Properties.Name)
    return @($LegacyFields | Where-Object { $_ -notin $PropertyNames }).Count -eq 0
}

function Stop-OutdatedAppService {
    param([object]$Health)
    if (-not (Test-KnownAppHealth -Health $Health)) {
        throw "Port 8000 is occupied by a service that does not identify as this project. Stop it manually and run this launcher again."
    }
    $ExistingProcessId = Get-ListeningProcessId -Port 8000
    if (-not $ExistingProcessId) {
        throw "The old application answered health checks, but its process could not be identified. Stop the service on port 8000 and run this launcher again."
    }
    Write-Host "Stopping outdated backend process tree $ExistingProcessId..."
    $TaskKill = Join-Path $env:SystemRoot "System32\taskkill.exe"
    & $TaskKill /PID $ExistingProcessId /T /F *> $null
    for ($Attempt = 1; $Attempt -le 20; $Attempt++) {
        if (-not (Test-PortOpen -Port 8000)) {
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw "The outdated backend did not release port 8000. Stop process $ExistingProcessId manually and run this launcher again."
}

function Normalize-ProcessPathVariable {
    # Some Windows hosts inject both PATH and Path. Start-Process treats them
    # as duplicate dictionary keys even though Windows treats them identically.
    $Variables = [Environment]::GetEnvironmentVariables("Process")
    $PathKeys = @(
        $Variables.Keys |
            ForEach-Object { [string]$_ } |
            Where-Object { $_.ToLowerInvariant() -eq "path" }
    )
    if ($PathKeys.Count -le 1) {
        return
    }
    $PathValue = $env:PATH
    foreach ($PathKey in $PathKeys) {
        [Environment]::SetEnvironmentVariable($PathKey, $null, "Process")
    }
    [Environment]::SetEnvironmentVariable("PATH", $PathValue, "Process")
}

function Open-AppBrowser {
    if ($NoBrowser) {
        return
    }
    try {
        Start-Process $AppUrl | Out-Null
    }
    catch {
        Write-Warning "The browser could not be opened automatically. Open $AppUrl manually."
    }
}

function Show-BackendFailure {
    param(
        [string]$StdoutLog,
        [string]$StderrLog
    )
    foreach ($LogPath in @($StderrLog, $StdoutLog)) {
        if (Test-Path -LiteralPath $LogPath) {
            $Lines = Get-Content -LiteralPath $LogPath -Tail 30
            if ($Lines) {
                Write-Host ""
                Write-Host "Last output from $LogPath" -ForegroundColor Yellow
                $Lines | ForEach-Object { Write-Host $_ }
            }
        }
    }
}

function Stop-BackendTree {
    if (-not $script:BackendProcess -or $script:BackendProcess.HasExited) {
        return
    }
    Write-Host "Stopping backend process tree $($script:BackendProcess.Id)..."
    $TaskKill = Join-Path $env:SystemRoot "System32\taskkill.exe"
    & $TaskKill /PID $script:BackendProcess.Id /T /F *> $null
    if ($LASTEXITCODE -ne 0 -and -not $script:BackendProcess.HasExited) {
        Stop-Process -Id $script:BackendProcess.Id -Force -ErrorAction SilentlyContinue
    }
    $script:BackendProcess.WaitForExit(5000) | Out-Null
}

function Invoke-Startup {
    Set-Location $ProjectRoot
    Write-Host "Bathroom Spatial Studio launcher" -ForegroundColor Green
    Write-Host "Project: $ProjectRoot"

    Write-Step "Checking required tools"
    $Node = Require-Command "node.exe" "Install Node.js 20 or newer from https://nodejs.org/."
    $Npm = Require-Command "npm.cmd" "Reinstall Node.js with npm enabled."
    $Uv = Require-Command "uv.exe" "Install uv from https://docs.astral.sh/uv/."

    $NodeVersionText = (& $Node --version).Trim()
    if ($NodeVersionText -notmatch '^v(?<major>\d+)\.') {
        throw "Unable to parse Node.js version '$NodeVersionText'."
    }
    if ([int]$Matches.major -lt 20) {
        throw "Node.js 20 or newer is required; found $NodeVersionText."
    }
    $NpmVersion = (& $Npm --version).Trim()
    $UvVersion = (& $Uv --version).Trim()
    Write-Host "Node.js $NodeVersionText, npm $NpmVersion, $UvVersion"

    Write-Step "Checking environment configuration"
    $EnvPath = Join-Path $ProjectRoot ".env"
    if (-not (Test-Path -LiteralPath $EnvPath)) {
        Copy-Item -LiteralPath (Join-Path $ProjectRoot ".env.example") -Destination $EnvPath
        Write-Warning "Created .env from .env.example. AI recognition needs OPENAI_BASE_URL, OPENAI_API_KEY, READ_MODEL, and CHAT_MODEL."
    }
    $EnvLines = Get-Content -LiteralPath $EnvPath
    $MissingAiSettings = @()
    foreach ($SettingName in @("OPENAI_BASE_URL", "OPENAI_API_KEY", "READ_MODEL", "CHAT_MODEL")) {
        $Configured = $EnvLines | Where-Object {
            $_ -match "^\s*$SettingName\s*=\s*.+$"
        } | Select-Object -First 1
        if (-not $Configured) {
            $MissingAiSettings += $SettingName
        }
    }
    if ($MissingAiSettings.Count -gt 0) {
        Write-Warning "AI recognition is not fully configured: $($MissingAiSettings -join ', '). The application can still start."
    }
    else {
        Write-Host "AI connection settings are present (values hidden)."
    }

    Write-Step "Checking frontend dependencies"
    $FrontendReady = $false
    if (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules")) {
        & $Npm ls --depth=0 --silent *> $null
        $FrontendReady = $LASTEXITCODE -eq 0
    }
    if (-not $FrontendReady) {
        Write-Host "Frontend packages are missing or incomplete; restoring the locked dependency tree."
        Invoke-Checked -FilePath $Npm -Arguments @("ci", "--no-audit", "--no-fund") -Description "Frontend dependency installation"
    }
    else {
        Write-Host "Frontend packages are ready."
    }

    Write-Step "Checking Python dependencies"
    $env:UV_CACHE_DIR = Join-Path $ProjectRoot ".uv-cache"
    Invoke-Checked -FilePath $Uv -Arguments @("sync", "--dev", "--locked") -Description "Python dependency synchronization"
    $Python = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $Python)) {
        throw "uv completed but $Python was not created."
    }
    $PythonVersion = (& $Python -c "import platform; print(platform.python_version())").Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "The project Python environment could not be executed."
    }
    Write-Host "Python $PythonVersion and locked project packages are ready."

    if ($CheckOnly) {
        Write-Step "Dependency check completed"
        Write-Host "The system is ready to start."
        return
    }

    $ExpectedSourceVersion = Get-BackendSourceVersion
    $ExpectedConfigVersion = Get-EnvironmentConfigVersion -Path $EnvPath
    $ExistingHealth = Get-AppHealth
    if ($ExistingHealth -and $ExistingHealth.ok) {
        $SourceMatches = [long]$ExistingHealth.source_version -eq $ExpectedSourceVersion
        $ConfigMatches = [string]$ExistingHealth.config_version -eq $ExpectedConfigVersion
        if ($SourceMatches -and $ConfigMatches) {
            Write-Step "The current system version is already running"
            Write-Host "Open $AppUrl"
            Open-AppBrowser
            if (-not $ExitAfterReady) {
                Write-Host "This launcher does not own the existing service on port 8000."
                [void](Read-Host "Press Enter to close this terminal")
            }
            return
        }
        Write-Step "Restarting an outdated backend"
        Write-Host "Running source version: $($ExistingHealth.source_version); current source version: $ExpectedSourceVersion"
        if (-not $ConfigMatches) {
            Write-Host "The .env configuration changed; restarting to apply the configured models."
        }
        Stop-OutdatedAppService -Health $ExistingHealth
    }
    if (Test-PortOpen -Port 8000) {
        throw "Port 8000 is already in use by another program. Stop it and run this launcher again."
    }

    Write-Step "Building the frontend"
    Invoke-Checked -FilePath $Npm -Arguments @("run", "build") -Description "Frontend build"

    Write-Step "Starting the system"
    $LogDir = Join-Path $ProjectRoot ".tmp\startup"
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $StdoutLog = Join-Path $LogDir "backend-$Timestamp.stdout.log"
    $StderrLog = Join-Path $LogDir "backend-$Timestamp.stderr.log"
    Normalize-ProcessPathVariable
    $script:BackendProcess = Start-Process `
        -FilePath $Python `
        -ArgumentList @("-m", "uvicorn", "backend.app.main:app", "--host", "127.0.0.1", "--port", "8000") `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $StdoutLog `
        -RedirectStandardError $StderrLog `
        -NoNewWindow `
        -PassThru

    $Health = $null
    for ($Attempt = 1; $Attempt -le 60; $Attempt++) {
        if ($script:BackendProcess.HasExited) {
            Show-BackendFailure -StdoutLog $StdoutLog -StderrLog $StderrLog
            throw "The backend exited before becoming ready (exit code $($script:BackendProcess.ExitCode))."
        }
        $Health = Get-AppHealth
        if ($Health -and $Health.ok) {
            break
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not ($Health -and $Health.ok)) {
        Show-BackendFailure -StdoutLog $StdoutLog -StderrLog $StderrLog
        throw "The backend did not become ready within 30 seconds."
    }
    if ([string]$Health.config_version -ne $ExpectedConfigVersion) {
        throw "The backend started without the current .env configuration. Check the startup logs and try again."
    }

    Write-Step "System is ready"
    Write-Host "URL: $AppUrl" -ForegroundColor Green
    Write-Host "Backend PID: $($script:BackendProcess.Id)"
    Write-Host "Logs: $LogDir"
    if (-not $Health.ai_configured) {
        Write-Warning "The UI is available, but AI recognition remains disabled until .env is configured."
    }
    Open-AppBrowser

    if (-not $ExitAfterReady) {
        Write-Host "Keep this terminal open while using the application."
        Write-Host "Press Enter when finished; the launcher will stop the backend and release port 8000."
        [void](Read-Host "System running")
    }
}

try {
    Invoke-Startup
}
catch {
    Write-Host ""
    Write-Host "STARTUP ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    Stop-BackendTree
}

exit 0
