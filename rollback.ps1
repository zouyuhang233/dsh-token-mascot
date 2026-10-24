# 卸载 dsh-token-mascot：跑 install.ps1 -Uninstall（幂等，只删链接本体不碰插件目录）
# 用法：双击 rollback.cmd，或
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\rollback.ps1

$ErrorActionPreference = 'Stop'
$root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

Write-Host ''
Write-Host '卸载 dsh-token-mascot' -ForegroundColor Cyan
Write-Host ''

& (Join-Path $root 'install.ps1') -Uninstall
exit $LASTEXITCODE
