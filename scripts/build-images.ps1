#Requires -Version 5.1
<#
.SYNOPSIS
  Build all three METIS Docker images locally with the same tags that
  verify-image-size expects. Windows / PowerShell port of build-images.sh.

.PARAMETER WithWrappers
  Also build the MCP wrapper image set (#271).

.EXAMPLE
  ./scripts/build-images.ps1                  # build core images only
  ./scripts/build-images.ps1 -WithWrappers    # also build MCP wrapper set
#>
[CmdletBinding()]
param(
  [switch]$WithWrappers
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $RootDir

function Invoke-DockerBuild([string]$Dockerfile, [string]$Tag) {
  Write-Host "==> Building $Tag"
  & docker build -f $Dockerfile -t $Tag .
  if ($LASTEXITCODE -ne 0) { Write-Error "docker build failed for $Tag (exit $LASTEXITCODE)" }
}

Invoke-DockerBuild 'Dockerfile.server'     'metis-server:test'
Invoke-DockerBuild 'Dockerfile.ui'         'metis-ui:test'
Invoke-DockerBuild 'Dockerfile.embeddings' 'metis-embeddings:test'

if ($WithWrappers) {
  Write-Host '==> Building MCP wrapper images (#271)'
  # The wrapper build orchestrator (images/mcp-wrappers/build.sh) has not been
  # ported; invoke it via Git Bash when available (it only drives `docker build`).
  $bash = Get-Command bash -ErrorAction SilentlyContinue
  if ($bash) {
    & $bash.Source 'images/mcp-wrappers/build.sh'
    if ($LASTEXITCODE -ne 0) { Write-Error "wrapper build failed (exit $LASTEXITCODE)" }
  } else {
    Write-Error 'bash not found - install Git Bash to build MCP wrapper images, or run images/mcp-wrappers/build.sh manually.'
  }
}

Write-Host '==> Done. Run `pnpm verify:image-size -- --no-build` to check the budget.'
