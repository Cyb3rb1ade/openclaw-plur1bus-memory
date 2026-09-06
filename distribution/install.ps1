# Shared installer, not a second Windows-specific implementation.
# Does not alter ExecutionPolicy, request elevation, or target WSL implicitly.
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'installer.py'
$forwardArgs = @($args)
if ($forwardArgs.Count -eq 0) { $forwardArgs = @('--interactive') }
$hermesRoot = if ($env:HERMES_HOME) { $env:HERMES_HOME } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'hermes' } else { Join-Path $HOME '.hermes' }
$candidate = Join-Path $hermesRoot 'hermes-agent\venv\Scripts\python.exe'
if ($env:PLUR1BUS_PYTHON) {
    & $env:PLUR1BUS_PYTHON $installer --bundle $PSScriptRoot @forwardArgs
} elseif (Test-Path -LiteralPath $candidate -PathType Leaf) {
    & $candidate $installer --bundle $PSScriptRoot @forwardArgs
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 $installer --bundle $PSScriptRoot @forwardArgs
} else {
    & python $installer --bundle $PSScriptRoot @forwardArgs
}
exit $LASTEXITCODE
