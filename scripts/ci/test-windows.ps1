param([switch]$ReuseApp, [switch]$RealLibraryAcceptance)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$app = Join-Path $repo 'apps/readest-app'
$artifacts = Join-Path $repo '.v2-artifacts'
$node = (Get-Command node).Source
New-Item -ItemType Directory -Force $artifacts | Out-Null
$ownedProcesses = @()
$appConfig = Get-Content -LiteralPath (Join-Path $app 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$isExperimental = $appConfig.identifier.EndsWith('.experimental')
$profileSuffix = '.ci' + [Guid]::NewGuid().ToString('N')
$ciIdentifier = $appConfig.identifier + $profileSuffix
$ciProfile = Join-Path ([Environment]::GetFolderPath('ApplicationData')) $ciIdentifier
$ciLocalProfile = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) $ciIdentifier
$stableFixtureIdentifier = 'io.github.wenhe233.readestremote' + $profileSuffix
$stableFixture = Join-Path ([Environment]::GetFolderPath('ApplicationData')) $stableFixtureIdentifier

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
        $env:DBUS_ID = $ciIdentifier
        if (Test-Path -LiteralPath $ciProfile) { throw 'CI profile must be newly owned by this run' }
        $legacyRoot = if ($isExperimental) { $stableFixture } else { $ciProfile }
        $legacyBook = Join-Path $legacyRoot 'Readest/Books/legacy-upgrade-fixture'
        New-Item -ItemType Directory -Path $legacyBook -Force | Out-Null
        '{"migrationVersion":1,"kavita":{"enabled":true}}' | Set-Content -LiteralPath (Join-Path $legacyRoot 'settings.json') -Encoding utf8
        'preserved-original' | Set-Content -LiteralPath (Join-Path $legacyBook 'book.epub') -Encoding utf8
        '{"notes":[{"text":"preserved annotation"}]}' | Set-Content -LiteralPath (Join-Path $legacyBook 'config.json') -Encoding utf8
        # bincode's two empty Vec<String> fields form a valid persisted scope.
        $legacyScope = [byte[]]::new(16)
        [IO.File]::WriteAllBytes((Join-Path $legacyRoot '.persisted-scope'), $legacyScope)
        $next = Start-Process $node -ArgumentList 'node_modules/next/dist/bin/next dev --hostname 127.0.0.1' `
            -WorkingDirectory $app -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $artifacts 'ci-next.log') `
            -RedirectStandardError (Join-Path $artifacts 'ci-next-error.log')
        $ownedProcesses += $next
        Wait-Endpoint 'http://127.0.0.1:3000' $next 300
        $config = Join-Path $artifacts 'ci-tauri.json'
        @{
            identifier = $ciIdentifier
            plugins = @{ 'deep-link' = @{ desktop = @{ schemes = @('readest-remote-ci') } } }
            build = @{ beforeDevCommand = 'node -e ""'; devUrl = 'http://127.0.0.1:3000' }
            app = @{ security = @{ capabilities = @('default','desktop-capability','webdriver-remote','webdriver-testing') + $(if ($isExperimental) { @('source-http') } else { @() }) } }
        } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $config
        $tauri = Start-Process $node -ArgumentList "node_modules/@tauri-apps/cli/tauri.js dev --features webdriver --no-watch --config `"$config`"" `
            -WorkingDirectory $app -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $artifacts 'ci-tauri.log') `
            -RedirectStandardError (Join-Path $artifacts 'ci-tauri-error.log')
        $ownedProcesses += $tauri
        Wait-Endpoint 'http://127.0.0.1:4445/status' $tauri 1800
        if ($isExperimental) {
            if (Test-Path -LiteralPath (Join-Path $ciProfile 'ReadestRemoteBackups')) { throw 'Experimental startup must not migrate profiles' }
            if (Test-Path -LiteralPath (Join-Path $ciProfile '.readest-remote-generation')) { throw 'Experimental startup must not initialize a legacy generation' }
            if ((Get-Content -LiteralPath (Join-Path $legacyBook 'book.epub') -Raw).Trim() -ne 'preserved-original') { throw 'Stable profile was modified' }
            if ((Get-Content -LiteralPath (Join-Path $legacyBook 'config.json') -Raw) -notmatch 'preserved annotation') { throw 'Stable annotations were modified' }
            $savedScope = [IO.File]::ReadAllBytes((Join-Path $stableFixture '.persisted-scope'))
            if ([Convert]::ToBase64String($savedScope) -ne [Convert]::ToBase64String($legacyScope)) { throw 'Stable file permissions were modified' }
            Write-Output 'Experimental startup: separate profile initialized; stable fixture remains intact.'
        } else {
            $backups = @(Get-ChildItem -LiteralPath (Join-Path $ciProfile 'ReadestRemoteBackups') -Directory)
            if ($backups.Count -ne 1) { throw 'Expected one V1 profile backup at first startup' }
            $savedBook = Join-Path $backups[0].FullName 'root-0/Readest/Books/legacy-upgrade-fixture'
            if ((Get-Content -LiteralPath (Join-Path $savedBook 'book.epub') -Raw).Trim() -ne 'preserved-original') { throw 'Original book backup mismatch' }
            if ((Get-Content -LiteralPath (Join-Path $savedBook 'config.json') -Raw) -notmatch 'preserved annotation') { throw 'Annotation backup mismatch' }
            $savedScope = [IO.File]::ReadAllBytes((Join-Path $backups[0].FullName 'root-0/.persisted-scope'))
            if ([Convert]::ToBase64String($savedScope) -ne [Convert]::ToBase64String($legacyScope)) { throw 'File access permissions were modified before backup' }
            if (Test-Path -LiteralPath $legacyBook) { throw 'Old shelf must not be loaded into the fresh profile' }
            if ((Get-Content -LiteralPath (Join-Path $ciProfile '.readest-remote-generation') -Raw).Trim() -ne '2') { throw 'Profile initialization did not commit' }
            Write-Output 'V1 upgrade startup: original book, annotation and file permissions backed up; fresh profile committed.'
        }
    } else {
        Wait-Endpoint 'http://127.0.0.1:4445/status' $null 10
    }
    $env:READEST_NATIVE_TEST = '1'
    $env:READEST_REAL_LIBRARY_ACCEPTANCE = if ($RealLibraryAcceptance) { '1' } else { '0' }
    $env:READEST_PLUGIN_TEST_NO_SERVERS = '1'
    $env:READEST_PLUGIN_TEST_REPOSITORY = Join-Path $artifacts 'ci-repository'
    if ($RealLibraryAcceptance) {
        $env:READEST_PLUGIN_TEST_NO_SERVERS = '0'
        $env:READEST_PLUGIN_TEST_REPOSITORY = Join-Path $artifacts 'repository'
        $env:READEST_PLUGIN_TEST_REPOSITORY_URL = 'https://wenhe233.github.io/readest-remote-plugins/repo.json'
    }
    # Run the installed CLI directly: package-manager shell shims can lose output/exit status here.
    Write-Output 'Running native WebView2 and signed-plugin regression tests.'
    & $node (Join-Path $app 'node_modules/vitest/vitest.mjs') run --config (Join-Path $app 'vitest.native-ci.config.mts')
    if ($LASTEXITCODE -ne 0) { throw 'Windows native and external plugin tests failed' }
} finally {
    foreach ($process in $ownedProcesses) {
        if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
    }
    if (-not $ReuseApp) {
        foreach ($profile in @($ciProfile, $ciLocalProfile, $stableFixture) | Select-Object -Unique) {
            if (Test-Path -LiteralPath $profile) {
                $resolvedProfile = (Resolve-Path -LiteralPath $profile).Path
                $allowedParents = @([Environment]::GetFolderPath('ApplicationData'), [Environment]::GetFolderPath('LocalApplicationData'))
                if ((Split-Path -Leaf $resolvedProfile) -notin @($ciIdentifier, $stableFixtureIdentifier) -or (Split-Path -Parent $resolvedProfile) -notin $allowedParents) { throw 'Refusing cleanup outside the test-owned CI profile' }
                Remove-Item -LiteralPath $resolvedProfile -Recurse -Force
            }
        }
    }
    Pop-Location
}
