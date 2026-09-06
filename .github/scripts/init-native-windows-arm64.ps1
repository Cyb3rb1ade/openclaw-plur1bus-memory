$ErrorActionPreference = 'Stop'
# Select the native target explicitly; a successful x64-emulated build is not acceptance.
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ne 'Arm64') {
    throw 'Native Windows ARM64 runner required'
}
$qaVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $qaVswhere)) {
    $qaVswhere = Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe'
}
$qaVisualStudio = & $qaVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.ARM64 -property installationPath
if ($LASTEXITCODE -or -not $qaVisualStudio) { throw 'ARM64 MSVC tools not installed' }
$qaVcvars = Join-Path $qaVisualStudio 'VC\Auxiliary\Build\vcvarsall.bat'
$qaEnvironment = & cmd.exe /d /s /c "`"$qaVcvars`" arm64 >nul && set"
if ($LASTEXITCODE) { throw 'Unable to initialize ARM64 compiler environment' }
foreach ($qaLine in $qaEnvironment) {
    if ($qaLine -match '^([^=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
}
if ($env:VSCMD_ARG_TGT_ARCH -ne 'arm64') { throw 'Compiler selected a non-ARM target' }
& cl.exe 2>&1 | Write-Output
# cl without a source file returns a usage error; initialization above is the gate.
$global:LASTEXITCODE = 0
