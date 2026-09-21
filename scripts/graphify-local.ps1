#Requires -Version 5.1
<#
.SYNOPSIS
  Build, verify, or clean the codebase knowledge graph WITHOUT a GitHub Actions
  runner. Windows / PowerShell port of graphify-local.sh.

.DESCRIPTION
  The only way the graph gets built: graphify-out/ is gitignored and there is no
  graphify CI workflow (#1152). Runs entirely on your machine. AST-only: no LLM
  calls, no API keys, $0 cost. Output is never committed.

.PARAMETER Command
  build   Build/refresh graphify-out/ and KEEP it (default).
  verify  Build, validate the output, then DELETE graphify-out/ again if it
          did not already exist (leaves no artifacts behind).
  clean   Delete the repo's root-level scratch files (UI-vision / walkthrough /
          retest screenshots, console logs, coverage dumps). Tracked files are
          removed via `git rm`.
  help    Show this message.

.EXAMPLE
  ./scripts/graphify-local.ps1 build
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('build', 'verify', 'clean', 'help')]
  [string]$Command = 'build'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $RepoRoot

$OutDir = 'graphify-out'
$BuildScript = 'scripts/graphify-ast-build.py'
$GraphifyVersion = '0.5.6'

function Write-Log([string]$m) { Write-Host "[graphify-local] $m" -ForegroundColor Cyan }
function Write-Warn([string]$m) { Write-Warning "[graphify-local] $m" }
function Stop-Die([string]$m) { Write-Error "[graphify-local] $m" }

# Root-level scratch file globs - throwaway artifacts from UI Vision / retest
# walkthroughs and ad-hoc coverage runs.
$ScratchGlobs = @(
  'uv-*.png', 'uv-*.md', 'uv-*.yml', 'uv-*.log',
  'retest-*.png', 'retest-*.md', 'retest-*.yml', 'retest-*.txt', 'retest-console-*.txt',
  'metis-retest-*.png', 'metis-retest-*.yml',
  'walkthrough-*.png', 'step*.png', 'project-overview-*.png',
  'mcp-settings-*.png', 'projects-page.png', '0[0-9]-*.png',
  'tmp-ui-vision-*.md',
  'coverage_output*.txt', 'coverage_full*.txt', 'issues_output.txt',
  'run_log.txt', 'server_coverage.txt', 'test_output.txt',
  'ui_test_output.txt', 'test_results.log', 'get_summary.py'
)

# Resolve a Python interpreter that can import the `graphify` package.
function Get-PythonExe {
  foreach ($name in @('python3', 'python')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  return $null
}

# Returns the argv array used to run the AST build script, or $null if graphify
# is not yet available. Preference: uv (isolated) -> importable python.
function Get-GraphifyRunner {
  if (Get-Command uv -ErrorAction SilentlyContinue) {
    return @('uv', 'tool', 'run', '--from', "graphifyy==$GraphifyVersion", 'python', '-u')
  }
  $py = Get-PythonExe
  if ($py) {
    & $py -c 'import graphify' 2>$null
    if ($LASTEXITCODE -eq 0) { return @($py, '-u') }
  }
  return $null
}

function Confirm-Graphify {
  if (Get-GraphifyRunner) { return }
  Write-Warn 'graphify not available - attempting install...'
  if (Get-Command uv -ErrorAction SilentlyContinue) {
    & uv tool install "graphifyy==$GraphifyVersion"
  } elseif (Get-Command pipx -ErrorAction SilentlyContinue) {
    & pipx install "graphifyy==$GraphifyVersion"
  } elseif (Get-Command pip -ErrorAction SilentlyContinue) {
    & pip install "graphifyy==$GraphifyVersion"
  } else {
    Stop-Die 'No uv, pipx, or pip found. Install one, or see https://github.com/safishamsi/graphify.'
  }
}

function Invoke-Build {
  Confirm-Graphify
  $runner = Get-GraphifyRunner
  if (-not $runner) { Stop-Die 'graphify still unavailable after install.' }
  Write-Log "building graph via: $($runner -join ' ') $BuildScript"
  & $runner[0] @($runner[1..($runner.Length - 1)] + $BuildScript)
  if ($LASTEXITCODE -ne 0) { Stop-Die "graph build failed (exit $LASTEXITCODE)" }
  Write-Log "graph written to $OutDir/ (graph.json + GRAPH_REPORT.md)"
}

function Test-Output {
  $graphJson = Join-Path $OutDir 'graph.json'
  $report = Join-Path $OutDir 'GRAPH_REPORT.md'
  if (-not (Test-Path -LiteralPath $graphJson)) { Stop-Die "missing $graphJson" }
  if (-not (Test-Path -LiteralPath $report)) { Stop-Die "missing $report" }
  $size = (Get-Item -LiteralPath $graphJson).Length
  if ($size -le 1000) { Stop-Die "graph.json is suspiciously small ($size bytes)" }
  if (-not (Select-String -LiteralPath $graphJson -Pattern '"nodes"' -Quiet)) {
    Stop-Die 'graph.json has no nodes array'
  }
  Write-Log "validation PASS - graph.json=$size bytes, report present"
}

function Invoke-Verify {
  $preexisting = Test-Path -LiteralPath $OutDir
  Invoke-Build
  Test-Output
  if ($preexisting) {
    Write-Warn 'graphify-out/ existed before verify; leaving it in place to avoid clobbering a real graph.'
  } else {
    Write-Log "verify mode - removing test-only $OutDir/"
    Remove-Item -LiteralPath $OutDir -Recurse -Force
  }
  Write-Log 'VERIFY OK'
}

function Invoke-Clean {
  $removed = 0
  foreach ($glob in $ScratchGlobs) {
    # Root-level only - never descend into source dirs.
    Get-ChildItem -LiteralPath $RepoRoot -Filter $glob -File -ErrorAction SilentlyContinue | ForEach-Object {
      $rel = $_.Name
      & git ls-files --error-unmatch $rel 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) {
        & git rm -q -f $rel
      } else {
        Remove-Item -LiteralPath $_.FullName -Force
      }
      $removed++
    }
  }
  Write-Log "removed $removed root-level scratch file(s)"
  if ($removed -gt 0) { Write-Warn 'tracked deletions are staged; commit them to finalize.' }
}

switch ($Command) {
  'build' { Invoke-Build }
  'verify' { Invoke-Verify }
  'clean' { Invoke-Clean }
  'help' { Get-Help $MyInvocation.MyCommand.Path -Detailed }
}
