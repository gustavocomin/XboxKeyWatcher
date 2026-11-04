param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [ValidateSet('Chrome', 'Edge')]
    [string]$Browser = 'Chrome'
)

$ErrorActionPreference = 'Stop'
$name = 'com.xboxkeywatcher.bridge'
$dist = Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\win-x64'
$exe = (Resolve-Path -LiteralPath (Join-Path $dist 'XboxKeyWatcher.NativeHost.exe')).Path
$manifest = Join-Path $dist "$name-$Browser.json"
@{
    name = $name
    description = 'Ponte local do XboxKeyWatcher'
    path = $exe
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding ascii
$vendor = if ($Browser -eq 'Chrome') { 'Google\Chrome' } else { 'Microsoft\Edge' }
$registry = "HKCU:\Software\$vendor\NativeMessagingHosts\$name"
New-Item -Path $registry -Force | Out-Null
Set-Item -LiteralPath $registry -Value $manifest
Write-Output "Host registrado para $Browser ($ExtensionId)."
