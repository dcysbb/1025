$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $packageRoot 'VacuumInterlock.exe'
if (-not (Test-Path -LiteralPath $executable)) {
    $executable = Join-Path $packageRoot 'backend\dist\VacuumInterlock\VacuumInterlock.exe'
}
$dataRoot = if ($env:VACUUM_INTERLOCK_DATA_DIR) { $env:VACUUM_INTERLOCK_DATA_DIR } else { Join-Path $env:PROGRAMDATA 'VacuumInterlock' }
$configPath = Join-Path $dataRoot 'config.json'
$config = if (Test-Path -LiteralPath $configPath) { (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).config } else { $null }
$port = if ($env:VACUUM_INTERLOCK_PORT) { [int]$env:VACUUM_INTERLOCK_PORT } else { 8770 }
$scheme = if ($config.allow_lan) { 'https' } else { 'http' }
$connection = New-Object System.Net.Sockets.TcpClient
try { $connection.Connect('127.0.0.1', $port); $running = $true } catch { $running = $false } finally { $connection.Dispose() }
if (-not $running) {
    if (-not (Test-Path -LiteralPath $executable)) { throw '请先运行 build-windows.ps1 生成程序包。' }
    Start-Process -FilePath $executable -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 300
        $connection = New-Object System.Net.Sockets.TcpClient
        try { $connection.Connect('127.0.0.1', $port); $running = $true } catch { $running = $false } finally { $connection.Dispose() }
        if ($running) { break }
    }
    if (-not $running) { throw '后台未能启动，请检查端口和数据目录权限。' }
}
Start-Process "$scheme`://127.0.0.1:$port"
