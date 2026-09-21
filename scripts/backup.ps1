#Requires -Version 5.1
<#
.SYNOPSIS
  METIS Backup Script (Windows / PowerShell port of scripts/backup.sh).

.DESCRIPTION
  Creates a timestamped tarball containing:
    - Database dump (sqlite copy or pg_dump custom format)
    - server/data/uploads/   (user-uploaded documents)
    - server/data/lancedb/   (vector store, if present)

.PARAMETER OutDir
  Output directory. Defaults to $env:BACKUP_DIR, then ./backups.

.ENVIRONMENT
  DATABASE_URL          (required) - Prisma connection string
  DATABASE_PROVIDER     sqlite | postgresql (default sqlite)
  BACKUP_DIR            output dir override (default ./backups)
  BACKUP_RETENTION_DAYS prune backups older than N days (default 30, 0 disables)

.EXAMPLE
  ./scripts/backup.ps1
  ./scripts/backup.ps1 D:\path\to\dir

  Restore with: ./scripts/restore.ps1 <tarball>
#>
[CmdletBinding()]
param(
  [string]$OutDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) { Write-Host "[backup] $Message" }

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $RepoRoot

if (-not $OutDir -or $OutDir.Trim().Length -eq 0) {
  if ($env:BACKUP_DIR) { $OutDir = $env:BACKUP_DIR } else { $OutDir = './backups' }
}

$Timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("metis-backup-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))

if ($env:DATABASE_PROVIDER) { $Provider = $env:DATABASE_PROVIDER } else { $Provider = 'sqlite' }
if ($env:DATABASE_URL) { $DatabaseUrl = $env:DATABASE_URL } else { $DatabaseUrl = 'file:./dev.db' }
if ($env:BACKUP_RETENTION_DAYS) { $RetentionDays = [int]$env:BACKUP_RETENTION_DAYS } else { $RetentionDays = 30 }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $WorkDir 'db') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $WorkDir 'data') | Out-Null

try {
  Write-Log "timestamp=$Timestamp provider=$Provider out=$OutDir"

  # ----- Database dump ------------------------------------------------------
  switch -Regex ($Provider) {
    '^sqlite$' {
      # Strip "file:" prefix if present. A RELATIVE file: path resolves against
      # server/ — the app's CWD at runtime (the better-sqlite3 adapter opens a
      # relative file: URL relative to process.cwd(), and the server runs from
      # server/), so `file:./dev.db` is server/dev.db, NOT server/prisma/dev.db.
      # ABSOLUTE file:/... paths are used verbatim.
      $SqlitePath = $DatabaseUrl -replace '^file:', ''
      if (-not [System.IO.Path]::IsPathRooted($SqlitePath)) {
        $SqlitePath = Join-Path (Join-Path $RepoRoot 'server') $SqlitePath
      }
      Write-Log "sqlite source: $SqlitePath"
      if (-not (Test-Path -LiteralPath $SqlitePath -PathType Leaf)) {
        Write-Error "[backup] ERROR: sqlite db not found at $SqlitePath"
      }
      # Empty-DB guard: 0 tables almost always means the wrong path was resolved
      # (or the DB was never migrated). Warn LOUDLY but do not fail.
      if (Get-Command sqlite3 -ErrorAction SilentlyContinue) {
        $tableCount = (& sqlite3 $SqlitePath "SELECT count(*) FROM sqlite_master WHERE type='table'" 2>$null)
        if ("$tableCount".Trim() -eq '0') {
          $banner = @(
            '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
            '!!! [backup] WARNING: sqlite database appears EMPTY (0 tables)',
            "!!! path: $SqlitePath",
            '!!! This backup may be USELESS. Verify DATABASE_URL resolves to the',
            '!!! real database (relative file: paths resolve against server/).',
            '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
          )
          [Console]::Error.WriteLine(($banner -join [Environment]::NewLine))
        }
      } else {
        [Console]::Error.WriteLine('[backup] note: sqlite3 CLI unavailable - skipping empty-DB table count check')
      }
      $dest = Join-Path $WorkDir 'db/metis.sqlite'
      if (Get-Command sqlite3 -ErrorAction SilentlyContinue) {
        & sqlite3 $SqlitePath ".backup '$dest'"
      } else {
        Write-Log 'sqlite3 CLI not found - falling back to file copy'
        Copy-Item -LiteralPath $SqlitePath -Destination $dest
      }
    }
    '^(postgresql|postgres)$' {
      if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
        Write-Error '[backup] ERROR: pg_dump not in PATH'
      }
      & pg_dump --format=custom --no-owner --no-privileges `
        --file=(Join-Path $WorkDir 'db/metis.dump') $DatabaseUrl
    }
    default {
      Write-Error "[backup] ERROR: unsupported DATABASE_PROVIDER=$Provider"
    }
  }

  # ----- Application data ---------------------------------------------------
  # Honor $env:UPLOAD_DIR / $env:LANCEDB_PATH when set; otherwise use the in-repo
  # defaults. The tarball ALWAYS stores them under data/uploads and data/lancedb
  # (stable internal layout — restore copies back out to the env-configured dirs).
  if ($env:UPLOAD_DIR) { $uploads = $env:UPLOAD_DIR } else { $uploads = Join-Path $RepoRoot 'server/data/uploads' }
  if (Test-Path -LiteralPath $uploads -PathType Container) {
    Copy-Item -LiteralPath $uploads -Destination (Join-Path $WorkDir 'data/uploads') -Recurse
  }
  if ($env:LANCEDB_PATH) { $lancedb = $env:LANCEDB_PATH } else { $lancedb = Join-Path $RepoRoot 'server/data/lancedb' }
  if (Test-Path -LiteralPath $lancedb -PathType Container) {
    Copy-Item -LiteralPath $lancedb -Destination (Join-Path $WorkDir 'data/lancedb') -Recurse
  }

  # ----- Manifest -----------------------------------------------------------
  $pkg = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'package.json') | ConvertFrom-Json
  $manifest = [ordered]@{
    timestamp     = $Timestamp
    provider      = $Provider
    schemaVersion = $pkg.version
    host          = [System.Net.Dns]::GetHostName()
  }
  ($manifest | ConvertTo-Json) | Set-Content -Encoding utf8 -LiteralPath (Join-Path $WorkDir 'MANIFEST.json')

  # ----- Tarball + integrity checksum --------------------------------------
  # tar.exe (bsdtar) ships with Windows 10 1803+ and handles gzip via -z.
  $Tarball = Join-Path $OutDir ("metis-backup-$Timestamp.tar.gz")
  & tar -czf $Tarball -C $WorkDir .
  if ($LASTEXITCODE -ne 0) { Write-Error "[backup] ERROR: tar failed (exit $LASTEXITCODE)" }

  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Tarball).Hash.ToLower()
  $sidecar = "$Tarball.sha256"
  # Match the `shasum -a 256` sidecar format: "<hash>  <filename>".
  "$hash  $(Split-Path -Leaf $Tarball)" | Set-Content -Encoding ascii -LiteralPath $sidecar

  Write-Log "wrote $Tarball"
  Write-Log "sha256 $(Get-Content -LiteralPath $sidecar)"

  # ----- Retention pruning --------------------------------------------------
  if ($RetentionDays -gt 0) {
    $cutoff = (Get-Date).AddDays(-$RetentionDays)
    foreach ($pattern in @('metis-backup-*.tar.gz', 'metis-backup-*.tar.gz.sha256')) {
      Get-ChildItem -LiteralPath $OutDir -Filter $pattern -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        ForEach-Object {
          Write-Log "pruning $($_.FullName)"
          Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
        }
    }
  }

  Write-Log 'done'
}
finally {
  if (Test-Path -LiteralPath $WorkDir) {
    Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
