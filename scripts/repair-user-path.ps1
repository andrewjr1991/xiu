param(
  [Parameter(Mandatory = $true)][string]$NodeDirectory,
  [Parameter(Mandatory = $true)][string]$NpmDirectory,
  [string]$GitDirectory
)
$ErrorActionPreference = 'Stop'
$additions = @($NodeDirectory, $NpmDirectory)
if ($GitDirectory) { $additions += $GitDirectory }
if (!(Test-Path -LiteralPath (Join-Path $NodeDirectory 'node.exe') -PathType Leaf)) { throw 'Node executable not found.' }
if (!(Test-Path -LiteralPath (Join-Path $NpmDirectory 'xiu.ps1') -PathType Leaf)) { throw 'Xiu npm shim not found.' }
if ($GitDirectory -and !(Test-Path -LiteralPath (Join-Path $GitDirectory 'git.exe') -PathType Leaf)) { throw 'Git executable not found.' }
$oldPath = (Get-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path
$entries = @($oldPath -split ';' | Where-Object { $_ })
$missing = @($additions | Where-Object { $entries -notcontains $_ })
if (!$missing.Count) { Write-Output 'User PATH already contains the verified directories.'; exit 0 }
$updated = (@($missing) + @($entries)) -join ';'
$backupDirectory = Join-Path $PSScriptRoot '..\.desktop-build-temp'
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
$backupFile = Join-Path $backupDirectory ('user-path-before-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.clixml')
@{ Path = $oldPath; Added = $missing } | Export-Clixml -LiteralPath $backupFile
Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value $updated
# setx also broadcasts the environment update. Use it only below its truncation
# limit and with no expandable references, then verify exact registry readback.
if ($updated.Length -lt 1024 -and !$updated.Contains('%')) {
  & "$env:SystemRoot\System32\setx.exe" Path $updated | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'PATH was saved, but environment broadcast failed. Restart the sign-in session.' }
}
$readback = (Get-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path).Path
if ($readback -cne $updated) {
  Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value $oldPath
  throw 'PATH readback did not match; the original value has been restored.'
}
Write-Output ('User PATH repaired. Backup: ' + (Resolve-Path -LiteralPath $backupFile).Path)
Write-Output 'Existing PATH entries and the system PATH were preserved. Reopen existing terminals and Xiu.'
