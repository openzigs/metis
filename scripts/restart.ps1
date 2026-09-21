#Requires -Version 5.1
<#
.SYNOPSIS
  METIS Restart Script (Windows / PowerShell port of scripts/restart.sh).

.DESCRIPTION
  Stops any running instances of the METIS dev stack (server, UI, and any
  spawned MCP stdio sidecar children) and restarts `pnpm dev` from a clean
  slate.

  Sidecars: server/src/lib/mcp/stdio-transport.ts spawns MCP child processes.
  They are children of the server; `taskkill /T` tears down the whole tree, and
  we also sweep for orphans by port and known argv patterns.

  This script ONLY targets dev processes. Production deployments should use
  `docker compose down && docker compose up -d` instead.

.PARAMETER StopOnly
  Only stop the stack; do not restart.

.PARAMETER Detached
  Restart in the background, logging to ./logs/dev.log (+ dev.err.log).

.ENVIRONMENT
  SERVER_PORT      default 4000 - kill anything bound here
  UI_PORT          default 3000 - kill anything bound here
  STOP_GRACE_SECS  default 5    - graceful close grace before force-kill

.EXAMPLE
  ./scripts/restart.ps1              # stop + restart in foreground
  ./scripts/restart.ps1 -StopOnly    # only stop
  ./scripts/restart.ps1 -Detached    # restart in background
#>
[CmdletBinding()]
param(
  [switch]$StopOnly,
  [switch]$Detached
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $RepoRoot

if ($env:SERVER_PORT) { $ServerPort = [int]$env:SERVER_PORT } else { $ServerPort = 4000 }
if ($env:UI_PORT) { $UiPort = [int]$env:UI_PORT } else { $UiPort = 3000 }
if ($env:STOP_GRACE_SECS) { $StopGraceSecs = [int]$env:STOP_GRACE_SECS } else { $StopGraceSecs = 5 }

function Write-Log([string]$m) { Write-Host "[restart] $m" }

# --- PIDs listening on a TCP port ------------------------------------------
function Get-PidsOnPort([int]$Port) {
  try {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique
  } catch {
    @()
  }
}

# --- PIDs whose command line matches a regex -------------------------------
function Get-PidsMatching([string]$Pattern) {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match $Pattern) } |
    Select-Object -ExpandProperty ProcessId
}

# --- taskkill helper: graceful (close) or forced, always tree (/T) ---------
function Stop-Tree([int]$ProcessId, [switch]$Force) {
  $args = @('/PID', $ProcessId, '/T')
  if ($Force) { $args = @('/F') + $args }
  & taskkill.exe @args 2>$null | Out-Null
}

function Test-Alive([int]$ProcessId) {
  return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Stop-Stack {
  Write-Log 'stopping running METIS dev processes...'

  $argvPatterns = @(
    'tsx[^/]* (watch )?src/index\.ts',
    'next-server.*\(dev\)',
    'next dev',
    'pnpm.*--filter ./server.*dev',
    'pnpm.*--filter ./ui.*dev',
    'metis.*pnpm dev',
    'modelcontextprotocol|@modelcontextprotocol|mcp-server-'
  )

  $raw = New-Object System.Collections.Generic.List[int]
  foreach ($p in (Get-PidsOnPort $ServerPort)) { $raw.Add([int]$p) }
  foreach ($p in (Get-PidsOnPort $UiPort)) { $raw.Add([int]$p) }
  foreach ($pat in $argvPatterns) {
    foreach ($p in (Get-PidsMatching $pat)) { $raw.Add([int]$p) }
  }

  # Exclude this script's own process + its parent shell, then de-dup.
  $selfPid = $PID
  $parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$selfPid" -ErrorAction SilentlyContinue).ParentProcessId
  $pids = $raw |
    Where-Object { $_ -and $_ -ne $selfPid -and $_ -ne $parentPid } |
    Select-Object -Unique

  if (-not $pids -or @($pids).Count -eq 0) {
    Write-Log 'no running METIS processes found'
    return
  }

  Write-Log "sending graceful close to: $($pids -join ' ')"
  foreach ($procId in $pids) { Stop-Tree -ProcessId $procId }

  # Grace window.
  $elapsed = 0
  while ($elapsed -lt $StopGraceSecs) {
    $alive = $false
    foreach ($procId in $pids) { if (Test-Alive $procId) { $alive = $true } }
    if (-not $alive) { break }
    Start-Sleep -Seconds 1
    $elapsed++
  }

  # Force-kill stragglers.
  $survivors = @($pids | Where-Object { Test-Alive $_ })
  if ($survivors.Count -gt 0) {
    Write-Log "force-killing stragglers: $($survivors -join ' ')"
    foreach ($procId in $survivors) { Stop-Tree -ProcessId $procId -Force }
  }

  # Re-check ports.
  foreach ($port in @($ServerPort, $UiPort)) {
    $still = Get-PidsOnPort $port
    if ($still -and @($still).Count -gt 0) {
      Write-Log "WARN: port $port still bound by: $($still -join ' ')"
    }
  }

  Write-Log 'stop complete'
}

function Wait-ForServer {
  $timeout = 30
  $elapsed = 0
  Write-Log "waiting for server on port $ServerPort..."
  while ($elapsed -lt $timeout) {
    try {
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 `
        -Uri "http://localhost:$ServerPort/healthz" | Out-Null
      Write-Log 'server is up'
      return $true
    } catch {
      Start-Sleep -Seconds 1
      $elapsed++
    }
  }
  Write-Log "WARN: server did not respond to /healthz within ${timeout}s"
  return $false
}

function Invoke-SmokeTest {
  Write-Log 'running chat smoke test...'
  $base = "http://localhost:$ServerPort"
  try {
    $login = Invoke-RestMethod -Method Post -Uri "$base/api/auth/login" `
      -ContentType 'application/json' `
      -Body (@{ username = 'admin'; password = 'password' } | ConvertTo-Json)
    $token = $login.data.accessToken
    if (-not $token) { throw 'no token' }
  } catch {
    Write-Log 'WARN: smoke test - login failed (check AUTH_MODE in .env)'
    return $false
  }

  $headers = @{ Authorization = "Bearer $token" }
  try {
    $session = Invoke-RestMethod -Method Post -Uri "$base/api/ai/sessions" `
      -Headers $headers -ContentType 'application/json' -Body '{}'
    $sessionId = $session.data.session.id
    if (-not $sessionId) { throw 'no session id' }
  } catch {
    Write-Log 'WARN: smoke test - session creation failed'
    return $false
  }

  try {
    $body = @{
      sessionId = $sessionId
      messages  = @(@{ role = 'user'; content = 'hi' })
    } | ConvertTo-Json -Depth 6
    $chat = Invoke-RestMethod -Method Post -Uri "$base/api/ai/chat" `
      -Headers $headers -ContentType 'application/json' -Body $body
    $content = $chat.data.response.content
  } catch {
    Write-Log 'WARN: smoke test - chat request failed'
    return $false
  }

  if (-not $content) {
    Write-Log 'WARN: smoke test - got empty response (provider may be unreachable)'
    return $false
  }
  $preview = $content.Substring(0, [Math]::Min(80, $content.Length))
  Write-Log "smoke test PASSED - `"$preview`""
  return $true
}

function Start-Stack {
  if (-not (Test-Path -LiteralPath 'node_modules' -PathType Container)) {
    Write-Log 'node_modules missing - running pnpm install --frozen-lockfile'
    & pnpm install --frozen-lockfile
  }

  if ($Detached) {
    New-Item -ItemType Directory -Force -Path 'logs' | Out-Null
    $logFile = 'logs/dev.log'
    $errFile = 'logs/dev.err.log'
    Write-Log "starting pnpm dev in background (logs: $logFile)"
    $proc = Start-Process -FilePath 'pnpm' -ArgumentList 'dev' `
      -RedirectStandardOutput $logFile -RedirectStandardError $errFile `
      -WindowStyle Hidden -PassThru
    Write-Log "started (pid=$($proc.Id))"
    Write-Log "tail with: Get-Content -Wait $logFile"
    if (Wait-ForServer) {
      if (-not (Invoke-SmokeTest)) { Write-Log "smoke test failed - check $logFile for details" }
    }
  } else {
    Write-Log 'starting pnpm dev (Ctrl-C to stop)'
    & pnpm dev
  }
}

# --- main -------------------------------------------------------------------
Stop-Stack
if ($StopOnly) { exit 0 }
Start-Stack
