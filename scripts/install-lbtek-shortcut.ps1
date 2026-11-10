param([string]$Pythonw = 'C:\VacuumInterlock-venv\Scripts\pythonw.exe')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
if (-not (Test-Path -LiteralPath $Pythonw)) { $Pythonw = Join-Path $backend '.venv\Scripts\pythonw.exe' }
if (-not (Test-Path -LiteralPath $Pythonw)) { throw '找不到 Pythonw，请通过 -Pythonw 指定运行环境。' }
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) '1025 LBTEK位移台.lnk'))
$link.TargetPath = $Pythonw
$link.Arguments = '"' + (Join-Path $backend 'lbtek_run.py') + '" --open-browser'
$link.WorkingDirectory = $backend
$link.Description = '1025控制台 · LBTEK EM-CS5-3 独立控制面板'
$link.WindowStyle = 7
$link.Save()
