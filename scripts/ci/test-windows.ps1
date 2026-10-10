param([switch]$ReuseApp)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$app = Join-Path $repo 'apps/readest-app'
$artifacts = Join-Path $repo '.v2-artifacts'
New-Item -ItemType Directory -Force $artifacts | Out-Null
$ownedProcesses = @()

function Wait-Endpoint([string]$Url, [Diagnostics.Process]$Process, [int]$Seconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process -and $Process.HasExited) { throw "Test service exited; inspect $artifacts" }
        try { Invoke-WebRequest $Url -TimeoutSec 3 | Out-Null; return } catch { Start-Sleep -Seconds 2 }
    }
    throw "Timed out waiting for $Url; inspect $artifacts"
}

try {
    Push-Location $app
    if (-not $ReuseApp) {
        if (Get-NetTCPConnection -State Listen -LocalPort 3000,4445 -ErrorAction SilentlyContinue) {
            throw 'Ports 3000/4445 are in use. Stop the owner or explicitly use -ReuseApp.'
        }
        $env:NEXT_PUBLIC_APP_PLATFORM = 'tauri'
        $env:READEST_NEXT_DIST_DIR = '.next-v2-ci-native'
        $env:DBUS_ID = 'io.github.wenhe233.readestremote.v2.ci'
        $node = (Get-Command node).Source
        $next = Start-Process $node -ArgumentList 'node_modules/next/dist/bin/next dev --hostname 127.0.0.1' `
            -WorkingDirectory $app -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $artifacts 'ci-next.log') `
            -RedirectStandardError (Join-Path $artifacts 'ci-next-error.log')
        $ownedProcesses += $next
        Wait-Endpoint 'http://127.0.0.1:3000' $next 300
        $config = Join-Path $artifacts 'ci-tauri.json'
        @{
            identifier = 'io.github.wenhe233.readestremote.v2.ci'
            plugins = @{ 'deep-link' = @{ desktop = @{ schemes = @('readest-remote-v2-ci') } } }
            build = @{ beforeDevCommand = 'node -e ""'; devUrl = 'http://127.0.0.1:3000' }
            app = @{ security = @{ capabilities = @('default','desktop-capability','webdriver-remote','webdriver-testing') } }
        } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $config
        $tauri = Start-Process $node -ArgumentList "node_modules/@tauri-apps/cli/tauri.js dev --features webdriver --no-watch --config `"$config`"" `
            -WorkingDirectory $app -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $artifacts 'ci-tauri.log') `
            -RedirectStandardError (Join-Path $artifacts 'ci-tauri-error.log')
        $ownedProcesses += $tauri
        Wait-Endpoint 'http://127.0.0.1:4445/status' $tauri 1800
    } else {
        Wait-Endpoint 'http://127.0.0.1:4445/status' $null 10
    }
    & pnpm exec vitest run --config vitest.tauri.config.mts
    if ($LASTEXITCODE -ne 0) { throw 'Upstream native tests failed' }
    $env:READEST_NATIVE_TEST = '1'
    $env:READEST_PLUGIN_TEST_NO_SERVERS = '1'
    $env:READEST_PLUGIN_TEST_REPOSITORY = Join-Path $artifacts 'ci-repository'
    & pnpm exec vitest run --config vitest.plugins.config.mts lifecycle.plugin.test.ts cache.plugin.test.ts isolation-native.plugin.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Native external plugin tests failed' }
} finally {
    foreach ($process in $ownedProcesses) {
        if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
    }
    Pop-Location
}
