param([string]$Pythonw)
$ErrorActionPreference = 'Stop'

$packageRoot = Split-Path -Parent $PSScriptRoot
$icon = Join-Path $packageRoot 'VacuumInterlock.exe'
if (-not (Test-Path -LiteralPath $icon)) {
    $icon = Join-Path $packageRoot 'backend\dist\VacuumInterlockDesktop\VacuumInterlockDesktop.exe'
    if (-not (Test-Path -LiteralPath $icon)) {
        $icon = Join-Path $packageRoot 'backend\dist\VacuumInterlock\VacuumInterlock.exe'
    }
}
$target = $icon
$arguments = '--open-browser'
$workingDirectory = $packageRoot
if ($Pythonw -or -not (Test-Path -LiteralPath $target)) {
    $backend = Join-Path $packageRoot 'backend'
    if (-not $Pythonw) {
        $Pythonw = 'C:\VacuumInterlock-venv\Scripts\pythonw.exe'
        if (-not (Test-Path -LiteralPath $Pythonw)) {
            $Pythonw = Join-Path $backend '.venv\Scripts\pythonw.exe'
        }
    }
    $runner = Join-Path $backend 'run.py'
    if (-not (Test-Path -LiteralPath $Pythonw -PathType Leaf)) { throw '找不到控制台运行环境，请通过 -Pythonw 指定 pythonw.exe。' }
    if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw '找不到控制台启动程序 backend\run.py。' }
    $target = (Resolve-Path -LiteralPath $Pythonw).Path
    $arguments = '"' + $runner + '" --open-browser'
    $workingDirectory = $backend
}
$shell = New-Object -ComObject WScript.Shell
$shortcutFolders = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('Programs')
)
foreach ($folder in $shortcutFolders) {
    $path = Join-Path $folder '1025控制台.lnk'
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = $target
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $workingDirectory
    $shortcut.Description = '启动后台并打开1025控制台；不会自动启用联锁。'
    $shortcut.WindowStyle = 7
    if (Test-Path -LiteralPath $icon) { $shortcut.IconLocation = $icon + ',0' }
    $shortcut.Save()
    Write-Output $path
}
