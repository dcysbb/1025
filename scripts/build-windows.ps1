$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$frontendDist = Join-Path $root 'frontend\dist'
if (-not (Test-Path (Join-Path $frontendDist 'index.html'))) {
    throw '找不到 frontend/dist/index.html。请先运行 npm --prefix frontend ci 和 npm --prefix frontend run build。'
}

Push-Location (Join-Path $root 'backend')
try {
    if (-not (Test-Path '.venv-build\Scripts\python.exe')) {
        py -3.12 -m venv .venv-build
    }
    & '.venv-build\Scripts\python.exe' -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw 'pip 更新失败' }
    & '.venv-build\Scripts\python.exe' -m pip install -r requirements-dev.txt
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
    & '.venv-build\Scripts\python.exe' -m PyInstaller --clean --noconfirm --onedir --name VacuumInterlock --collect-all uvicorn --collect-all fastapi --collect-all cryptography --collect-all thorlabs_xa --hidden-import serial.tools.list_ports --add-data '..\frontend\dist;frontend\dist' run.py
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller 失败，退出码 $LASTEXITCODE" }
    & '.venv-build\Scripts\python.exe' -m PyInstaller --clean --noconfirm --onedir --name VacuumInterlockService --collect-all uvicorn --collect-all fastapi --collect-all cryptography --collect-all thorlabs_xa --hidden-import serial.tools.list_ports --hidden-import win32timezone --add-data '..\frontend\dist;frontend\dist' windows_service.py
    if ($LASTEXITCODE -ne 0) { throw "Windows service 打包失败，退出码 $LASTEXITCODE" }
    $launcherDir = Join-Path (Get-Location) 'dist\VacuumInterlock\scripts'
    New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'open-control-panel.ps1') -Destination $launcherDir
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-console-shortcut.ps1') -Destination $launcherDir
    Write-Host "打包完成：$(Join-Path (Get-Location) 'dist\VacuumInterlock')"
} finally {
    Pop-Location
}
