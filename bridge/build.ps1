param(
  [Parameter(Mandatory = $true)] [string]$Practice,
  [Parameter(Mandatory = $true)] [string]$AquaCore,
  [string]$Output = (Join-Path $PSScriptRoot 'build/MicetSiteBridge.jar')
)
$ErrorActionPreference = 'Stop'
$classes = Join-Path $PSScriptRoot 'build/classes'
New-Item -ItemType Directory -Force -Path $classes | Out-Null
$dependencies = @(
  (Join-Path $Practice 'target/MicetPvP-3.1.jar'),
  (Join-Path $Practice 'lib/mspigot.jar'),
  (Join-Path $Practice 'lib/mspigotapi.jar'),
  $AquaCore
)
$classpath = ($dependencies | ForEach-Object { (Resolve-Path -LiteralPath $_).Path }) -join [IO.Path]::PathSeparator
$sources = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src/main/java') -Filter '*.java' -Recurse
& javac '-J-Dfile.encoding=UTF-8' --release 8 -proc:none '-Xlint:-options' -encoding UTF-8 -cp $classpath -d $classes @($sources.FullName)
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& jar --create --file $Output -C $classes . -C (Join-Path $PSScriptRoot 'src/main/resources') .
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Get-Item -LiteralPath $Output | Select-Object Name,Length
