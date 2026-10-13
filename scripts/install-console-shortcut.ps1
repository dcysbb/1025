$ErrorActionPreference = 'Stop'

$launcher = Join-Path $PSScriptRoot 'open-control-panel.ps1'
if (-not (Test-Path -LiteralPath $launcher)) {
    throw '找不到控制台启动脚本。'
}
$packageRoot = Split-Path -Parent $PSScriptRoot
$icon = Join-Path $packageRoot 'VacuumInterlock.exe'
if (-not (Test-Path -LiteralPath $icon)) {
    $icon = Join-Path $packageRoot 'backend\dist\VacuumInterlock\VacuumInterlock.exe'
}
$shell = New-Object -ComObject WScript.Shell
$shortcutFolders = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('Programs')
)
foreach ($folder in $shortcutFolders) {
    $path = Join-Path $folder '真空联锁控制台.lnk'
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = '-NoProfile -WindowStyle Hidden -File "' + $launcher + '"'
    $shortcut.WorkingDirectory = $packageRoot
    $shortcut.Description = '启动后台并打开真空联锁控制台；不会自动启用联锁。'
    $shortcut.WindowStyle = 7
    if (Test-Path -LiteralPath $icon) { $shortcut.IconLocation = $icon + ',0' }
    $shortcut.Save()
    Write-Output $path
}
