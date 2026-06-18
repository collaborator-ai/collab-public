$ErrorActionPreference = "Stop"

function Normalize-WindowsPath {
  param([string]$Path)

  if ($null -eq $Path) { return $null }
  if ($Path.StartsWith("\\?\UNC\")) {
    return "\\" + $Path.Substring("\\?\UNC\".Length)
  }
  if ($Path.StartsWith("\\?\")) {
    return $Path.Substring("\\?\".Length)
  }
  return $Path
}

$scriptRoot = Normalize-WindowsPath $PSScriptRoot
$repoDir = [System.IO.Path]::GetFullPath(
  [System.IO.Path]::Combine($scriptRoot, "..")
)
$electronPath = [System.IO.Path]::Combine(
  $repoDir,
  "node_modules",
  "electron",
  "dist",
  "electron.exe"
)
$electronViteScriptPath = [System.IO.Path]::Combine(
  $repoDir,
  "node_modules",
  "electron-vite",
  "bin",
  "electron-vite.js"
)

Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.ExecutablePath -eq $electronPath -and
      $_.CommandLine -notlike "*pty-sidecar.js*"
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -like "*$electronViteScriptPath*" -and
      $_.CommandLine -like "* dev*"
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

$env:COLLAB_DEV_WORKTREE_ROOT = $repoDir

Start-Sleep -Milliseconds 500

& node $electronViteScriptPath dev
exit $LASTEXITCODE
