[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$repoDrive = [IO.Path]::GetPathRoot($repoRoot)
$runtimeRoot = Join-Path $repoDrive "GEO\.runtime\geo-saas-customer-demo"
$envFile = Join-Path $runtimeRoot "customer-demo.env"
$supervisor = Join-Path $PSScriptRoot "ctrip-host-supervisor.ps1"
if (Test-Path -LiteralPath $supervisor) {
  & $supervisor -Action Uninstall
}
if (-not (Test-Path -LiteralPath $envFile)) {
  Write-Host "The GEO customer demo has not been configured on this drive."
  exit 0
}

& docker compose --env-file $envFile `
  -f (Join-Path $repoRoot "compose.yaml") `
  -f (Join-Path $repoRoot "compose.customer-demo.yaml") `
  --profile fixture-seed --profile operator-bootstrap --profile customer-demo `
  --profile ctrip-simulator down
if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed to stop the customer demo." }
Write-Host "The GEO customer demo is stopped. Its data is preserved for the next start."
