param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$studioRoot = $PSScriptRoot
$runtimeConfig = Join-Path $studioRoot 'runtime.json'
$pythonExe = if (Test-Path -LiteralPath $runtimeConfig) { (Get-Content -LiteralPath $runtimeConfig -Raw | ConvertFrom-Json).python } else { (Get-Command python).Source }
if (-not (Test-Path -LiteralPath (Join-Path $studioRoot 'dist/index.html'))) { throw 'The interface has not been built.' }
$port = 8768
$running = $false
while ($port -lt 8800) {
    try {
        $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/status" -TimeoutSec 1
        if ($status.app -eq 'expression-studio') { $running = $true; break }
        $port++
    } catch {
        $probe = New-Object System.Net.Sockets.TcpClient
        try { $probe.Connect('127.0.0.1', $port); $port++ } catch { break } finally { $probe.Dispose() }
    }
}
if ($port -ge 8800) { throw 'No available local port.' }
if (-not $running) {
    $serverScript = Join-Path $studioRoot 'run_background.py'
    # WMI creates the server outside the launching terminal's process tree.
    # Break away from the provider job as well, without opening a console.
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
        ShowWindow = [uint16]0
        CreateFlags = [uint32]0x01000408
        EnvironmentVariables = [string[]]@(Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" })
    }
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = "`"$pythonExe`" -u `"$serverScript`" --port $port"
        CurrentDirectory = $studioRoot
        ProcessStartupInformation = $startup
    }
    if ($created.ReturnValue -ne 0) { throw "Background launch failed (Windows code $($created.ReturnValue))." }
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 500
        try { $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/status" -TimeoutSec 1; if ($status.app -eq 'expression-studio') { $running = $true; break } } catch {}
    }
    if (-not $running) { throw 'Could not start. See studio/server-error.log.' }
}
$url = "http://127.0.0.1:$port"
Set-Content -LiteralPath (Join-Path $studioRoot 'running-url.txt') -Value $url -Encoding UTF8
if (-not $NoBrowser) { Start-Process $url }
Write-Output $url
