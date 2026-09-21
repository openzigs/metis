#Requires -Version 5.1
<#
.SYNOPSIS
  METIS Restore Script (Windows / PowerShell port of scripts/restore.sh).

.DESCRIPTION
  Restores a backup tarball produced by scripts/backup.ps1 (or backup.sh):
    - Verifies sha256 if a .sha256 sidecar is present.
    - Restores DB to the path/connection from $env:DATABASE_URL.
    - Restores server/data/uploads/ and server/data/lancedb/.

.PARAMETER Tarball
  Path to the backup .tar.gz to restore.

.EXAMPLE
  ./scripts/restore.ps1 ./backups/metis-backup-YYYYMMDDTHHMMSSZ.tar.gz

  WARNING: this overwrites the live database. Stop the server first.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Tarball
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) { Write-Host "[restore] $Message" }

# Blast-radius guard: a misconfigured UPLOAD_DIR/LANCEDB_PATH (empty, drive root,
# or $HOME) would make Remove-Item -Recurse below delete the wrong tree. Refuse those.
function Assert-SafeDest([string]$Label, [string]$Dest) {
  $home = $env:USERPROFILE
  if ([string]::IsNullOrWhiteSpace($Dest) -or
      -not [System.IO.Path]::IsPathRooted($Dest) -or
      [System.IO.Path]::GetPathRoot($Dest) -eq $Dest -or
      ($home -and ($Dest.TrimEnd('\','/') -eq $home.TrimEnd('\','/')))) {
    Write-Error "[restore] ERROR: refusing to delete $Label destination '$Dest' - must be an absolute path and not a drive root or `$HOME"
  }
}

if (-not $Tarball -or $Tarball.Trim().Length -eq 0) {
  Write-Error "Usage: restore.ps1 <tarball>"
  exit 2
}
if (-not (Test-Path -LiteralPath $Tarball -PathType Leaf)) {
  Write-Error "[restore] ERROR: tarball not found: $Tarball"
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $RepoRoot

if ($env:DATABASE_PROVIDER) { $Provider = $env:DATABASE_PROVIDER } else { $Provider = 'sqlite' }
if ($env:DATABASE_URL) { $DatabaseUrl = $env:DATABASE_URL } else { $DatabaseUrl = 'file:./dev.db' }

$Tarball = (Resolve-Path -LiteralPath $Tarball).Path
$WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("metis-restore-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

try {
  # ----- Integrity check ----------------------------------------------------
  $sidecar = "$Tarball.sha256"
  if (Test-Path -LiteralPath $sidecar -PathType Leaf) {
    Write-Log 'verifying sha256'
    $expected = ((Get-Content -LiteralPath $sidecar -Raw).Trim() -split '\s+')[0].ToLower()
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Tarball).Hash.ToLower()
    if ($expected -ne $actual) {
      Write-Error "[restore] ERROR: sha256 mismatch (expected $expected, got $actual)"
    }
    Write-Log 'sha256 OK'
  }

  # ----- Extract ------------------------------------------------------------
  & tar -xzf $Tarball -C $WorkDir
  if ($LASTEXITCODE -ne 0) { Write-Error "[restore] ERROR: tar extract failed (exit $LASTEXITCODE)" }

  $manifestPath = Join-Path $WorkDir 'MANIFEST.json'
  if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    Write-Log 'manifest:'
    Get-Content -LiteralPath $manifestPath | Write-Host
  }

  # ----- Database restore ---------------------------------------------------
  switch -Regex ($Provider) {
    '^sqlite$' {
      # A RELATIVE file: path resolves against server/ — the app's CWD at runtime
      # (so `file:./dev.db` is server/dev.db, NOT server/prisma/dev.db). ABSOLUTE
      # file:/... paths are used verbatim.
      $SqlitePath = $DatabaseUrl -replace '^file:', ''
      if (-not [System.IO.Path]::IsPathRooted($SqlitePath)) {
        $SqlitePath = Join-Path (Join-Path $RepoRoot 'server') $SqlitePath
      }
      $src = Join-Path $WorkDir 'db/metis.sqlite'
      if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
        Write-Error '[restore] ERROR: db/metis.sqlite not in tarball'
      }
      Write-Log "sqlite target: $SqlitePath"
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SqlitePath) | Out-Null
      Copy-Item -LiteralPath $src -Destination $SqlitePath -Force
      Write-Log "sqlite restored to $SqlitePath"
    }
    '^(postgresql|postgres)$' {
      if (-not (Get-Command pg_restore -ErrorAction SilentlyContinue)) {
        Write-Error '[restore] ERROR: pg_restore not in PATH'
      }
      $src = Join-Path $WorkDir 'db/metis.dump'
      if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
        Write-Error '[restore] ERROR: db/metis.dump not in tarball'
      }
      & pg_restore --clean --if-exists --no-owner --no-privileges `
        --dbname=$DatabaseUrl $src
      if ($LASTEXITCODE -ne 0) { Write-Error "[restore] ERROR: pg_restore failed (exit $LASTEXITCODE)" }
      Write-Log 'postgres restored'
    }
    default {
      Write-Error "[restore] ERROR: unsupported DATABASE_PROVIDER=$Provider"
    }
  }

  # ----- Application data ----------------------------------------------------
  # Honor $env:UPLOAD_DIR / $env:LANCEDB_PATH when set; otherwise use the in-repo
  # defaults. The tarball's internal layout (data/uploads, data/lancedb) is fixed;
  # copy it back OUT to the env-configured destinations, creating parents as needed.
  $uploadsSrc = Join-Path $WorkDir 'data/uploads'
  if (Test-Path -LiteralPath $uploadsSrc -PathType Container) {
    # Use the default only when UPLOAD_DIR is UNSET; an explicitly-set-but-empty
    # value falls through to Assert-SafeDest and is refused.
    if (Test-Path env:UPLOAD_DIR) { $uploadsDst = $env:UPLOAD_DIR } else { $uploadsDst = Join-Path $RepoRoot 'server/data/uploads' }
    Assert-SafeDest 'uploads' $uploadsDst
    if (Test-Path -LiteralPath $uploadsDst) { Remove-Item -LiteralPath $uploadsDst -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $uploadsDst) | Out-Null
    Copy-Item -LiteralPath $uploadsSrc -Destination $uploadsDst -Recurse
    Write-Log "uploads restored to $uploadsDst"
  }
  $lancedbSrc = Join-Path $WorkDir 'data/lancedb'
  if (Test-Path -LiteralPath $lancedbSrc -PathType Container) {
    if (Test-Path env:LANCEDB_PATH) { $lancedbDst = $env:LANCEDB_PATH } else { $lancedbDst = Join-Path $RepoRoot 'server/data/lancedb' }
    Assert-SafeDest 'lancedb' $lancedbDst
    if (Test-Path -LiteralPath $lancedbDst) { Remove-Item -LiteralPath $lancedbDst -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lancedbDst) | Out-Null
    Copy-Item -LiteralPath $lancedbSrc -Destination $lancedbDst -Recurse
    Write-Log "lancedb restored to $lancedbDst"
  }

  Write-Log 'done - restart the server'
}
finally {
  if (Test-Path -LiteralPath $WorkDir) {
    Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
