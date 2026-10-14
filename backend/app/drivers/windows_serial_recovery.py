"""Restart only the configured USB serial device, never a hub or another COM port."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import re
import subprocess


# Arguments travel in a private child environment, never interpolated as code.
_SCRIPT = r'''
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    $port = $env:VACUUM_RECOVERY_PORT
    $protected = $env:VACUUM_RECOVERY_PROTECTED_PORT
    if ($port -notmatch '^COM[1-9][0-9]*$' -or $port -ieq $protected) { throw '禁止重启真空规串口或无效串口' }
    $suffix = '\(' + [regex]::Escape($port) + '\)$'
    $targets = @(Get-CimInstance Win32_PnPEntity -Filter "PNPClass='Ports'" | Where-Object { $_.Name -match $suffix })
    if ($targets.Count -eq 0) { throw "DAM 串口 $port 未被 Windows 识别；无法通过串口复位不存在的设备" }
    if ($targets.Count -ne 1) { throw '未找到唯一的 DAM 串口设备' }
    $target = $targets[0]
    $id = [string]$target.PNPDeviceID
    if ($id -notmatch '^(USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\|USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}&MI_[0-9A-F]{2}\\|FTDIBUS\\)') { throw '配置的串口不是受支持的 USB 串口设备' }
    $log = & "$env:WINDIR\System32\pnputil.exe" /restart-device $id 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("USB 设备重启失败，退出码 $LASTEXITCODE；" + ($log -join ' ')) }
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    $stable = 0
    while ([DateTime]::UtcNow -lt $deadline) {
        $current = @(Get-CimInstance Win32_PnPEntity -Filter "PNPClass='Ports'" | Where-Object { $_.PNPDeviceID -ieq $id -and $_.Name -match $suffix -and $_.Status -eq 'OK' -and $_.Present })
        if ($current.Count -eq 1) { $stable++ } else { $stable = 0 }
        if ($stable -ge 3) { break }
        Start-Sleep -Milliseconds 500
    }
    if ($stable -lt 3) { throw "USB 重启命令已完成，但 $port 尚未重新识别；请检查 USB 连接与供电" }
    @{ok=$true; port=$port; device_id=$id} | ConvertTo-Json -Compress
} catch {
    @{ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress
    exit 1
}
'''


def _restart(port: str, protected_port: str) -> dict:
    if os.name != 'nt':
        return {'ok': False, 'error': '当前系统不支持 Windows USB 设备重启'}
    port, protected_port = port.strip().upper(), protected_port.strip().upper()
    if not re.fullmatch(r'COM[1-9][0-9]*', port) or port == protected_port:
        return {'ok': False, 'error': '禁止重启真空规串口或无效串口'}
    env = os.environ.copy()
    env.update(VACUUM_RECOVERY_PORT=port, VACUUM_RECOVERY_PROTECTED_PORT=protected_port)
    shell = Path(env.get('WINDIR', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    try:
        result = subprocess.run([str(shell), '-NoProfile', '-NonInteractive', '-Command', _SCRIPT],
                                env=env, capture_output=True, encoding='utf-8', errors='replace',
                                timeout=12, creationflags=subprocess.CREATE_NO_WINDOW)
        payload = json.loads(result.stdout.strip())
        if result.returncode != 0 or payload.get('ok') is not True:
            return {'ok': False, 'error': payload.get('error') or 'USB 重启失败（需要管理员权限）'}
        if payload.get('port', '').upper() != port or not payload.get('device_id'):
            return {'ok': False, 'error': 'USB 重启结果与配置的串口不一致'}
        return payload
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError, AttributeError) as exc:
        return {'ok': False, 'error': f'USB 设备重启失败：{exc}'}


async def restart_usb_serial(port: str, protected_port: str) -> dict:
    worker = asyncio.create_task(asyncio.to_thread(_restart, port, protected_port))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        # Do not reopen the device while the OS restart is still in progress.
        await worker
        raise
