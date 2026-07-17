[CmdletBinding()]
param(
  [switch]$NoBuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function New-RandomSecret([int]$Bytes = 36) {
  $buffer = New-Object byte[] $Bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  return [Convert]::ToBase64String($buffer).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Read-EnvFile([string]$Path) {
  $values = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $values }
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line.Split('=', 2)
    $values[$parts[0]] = $parts[1]
  }
  return $values
}

function Existing-OrRandom($Values, [string]$Name, [int]$Bytes = 36) {
  if ($Values.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace($Values[$Name])) {
    return $Values[$Name]
  }
  return New-RandomSecret $Bytes
}

function Wait-ForUrl([string]$Url, [int]$Seconds = 240) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { return }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  throw "The customer console did not become ready within $Seconds seconds."
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$repoDrive = [IO.Path]::GetPathRoot($repoRoot)
if ($repoDrive.TrimEnd('\').Equals('C:', [StringComparison]::OrdinalIgnoreCase)) {
  throw "Customer runtime files cannot be created on drive C:. Move the release to drive D: or another data drive."
}

$runtimeRoot = Join-Path $repoDrive "GEO\.runtime\geo-saas-customer-demo"
$envFile = Join-Path $runtimeRoot "customer-demo.env"
$loginFile = Join-Path $runtimeRoot "customer-login.txt"
$composeFile = Join-Path $repoRoot "compose.yaml"
$demoComposeFile = Join-Path $repoRoot "compose.customer-demo.yaml"
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

if ($null -eq (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker Desktop is required. Install Docker Desktop, start it, then double-click the launcher again."
}
& docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker Desktop is installed but its engine is not running. Start Docker Desktop and try again."
}
& docker compose version *> $null
if ($LASTEXITCODE -ne 0) { throw "Docker Compose is unavailable in this Docker installation." }

$existing = Read-EnvFile $envFile
$adminPassword = Existing-OrRandom $existing "POSTGRES_ADMIN_PASSWORD"
$apiPassword = Existing-OrRandom $existing "GEO_API_DB_PASSWORD"
$workerPassword = Existing-OrRandom $existing "GEO_WORKER_DB_PASSWORD"
$identityPassword = Existing-OrRandom $existing "GEO_IDENTITY_DB_PASSWORD"
$sessionSecret = Existing-OrRandom $existing "SESSION_SECRET" 48
$operatorPassword = Existing-OrRandom $existing "GEO_BOOTSTRAP_PASSWORD"
$agentToken = Existing-OrRandom $existing "GEO_CUSTOMER_AGENT_TOKEN"
$bridgeToken = Existing-OrRandom $existing "GEO_CUSTOMER_CTRIP_BRIDGE_TOKEN"
$evidenceExpiresAt = [DateTimeOffset]::UtcNow.AddHours(24).ToString("o")

$tenantId = "10000000-0000-4000-8000-000000000001"
$workerPrincipalId = "10000000-0000-4000-8000-000000000102"
$syntheticTenantId = "20000000-0000-4000-8000-000000000001"
$syntheticWorkerPrincipalId = "20000000-0000-4000-8000-000000000102"
$ctripAccountId = "10000000-0000-4000-8000-000000000703"
$ctripBridgePrincipalId = "10000000-0000-4000-8000-000000000103"
$operatorEmail = "demo@geo.localhost"
$tenantSlug = "zhongtong-international-travel"

$mcpPrincipals = ConvertTo-Json -Compress -InputObject @(@{
  accessToken = $agentToken
  clientId = "geo-customer-demo"
  email = $operatorEmail
  password = $operatorPassword
  tenantSlug = $tenantSlug
})
$agentCredentials = ConvertTo-Json -Compress -InputObject @(@{
  tenantId = $tenantId
  accessToken = $agentToken
})
$workerActors = ConvertTo-Json -Compress -InputObject @{
  $tenantId = $workerPrincipalId
  $syntheticTenantId = $syntheticWorkerPrincipalId
}
$assistedAccounts = ConvertTo-Json -Compress -InputObject @(@{
  tenantId = $tenantId
  channelAccountId = $ctripAccountId
  bridgePrincipalId = $ctripBridgePrincipalId
  adapterVersion = "ctrip-community-simulator-v1"
  evidenceExpiresAt = $evidenceExpiresAt
  handoffTtlSeconds = 900
})
$bridgeCredentials = ConvertTo-Json -Compress -InputObject @(@{
  tenantId = $tenantId
  accessToken = $bridgeToken
})
$bridgeTenants = ConvertTo-Json -Compress -InputObject @(@{
  tenantId = $tenantId
  bridgePrincipalId = $ctripBridgePrincipalId
  accessToken = $bridgeToken
})

$lines = @(
  "COMPOSE_PROJECT_NAME=geo-saas-customer-demo"
  "GEO_IMAGE_PREFIX=geo-saas-customer-demo"
  "GEO_IMAGE_TAG=local"
  "BIND_ADDRESS=127.0.0.1"
  "POSTGRES_DB=geo_saas"
  "POSTGRES_ADMIN_USER=geo_admin"
  "POSTGRES_ADMIN_PASSWORD=$adminPassword"
  "GEO_API_DB_USER=geo_api"
  "GEO_API_DB_PASSWORD=$apiPassword"
  "GEO_WORKER_DB_USER=geo_worker"
  "GEO_WORKER_DB_PASSWORD=$workerPassword"
  "GEO_IDENTITY_DB_USER=geo_identity_login"
  "GEO_IDENTITY_DB_PASSWORD=$identityPassword"
  "API_PORT=4100"
  "WEB_PORT=4173"
  "MCP_PORT=9021"
  "SESSION_SECRET=$sessionSecret"
  "APP_ORIGIN=http://127.0.0.1:4173"
  "GEO_DEPLOYMENT_PROFILE=customer_demo"
  "GEO_GOVERNANCE_MODE=demo_fixture"
  "PLASTIC_PROMISE_MCP_URL="
  "WORKER_TENANT_ACTORS_JSON=$workerActors"
  "CTRIP_ASSISTED_ACCOUNTS_JSON=$assistedAccounts"
  "CTRIP_BRIDGE_GATEWAY_URL=http://127.0.0.1:9030"
  "CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON=$bridgeCredentials"
  "CTRIP_BRIDGE_TENANTS_JSON=$bridgeTenants"
  "AGENT_PROVIDER=fixture"
  "AGENT_MODEL=fixture-geo-writer-v1"
  "AGENT_GATEWAY_CREDENTIALS_JSON=$agentCredentials"
  "AUTOMATION_PRODUCER_ENABLED=true"
  "GEO_MEDIA_PROVIDER=fixture"
  "DOUBAO_ADAPTER=fixture"
  "QWEN_ADAPTER=fixture"
  "MCP_ALLOWED_HOSTS=127.0.0.1:9021,localhost:9021"
  "MCP_ALLOWED_ORIGINS=http://127.0.0.1:4173"
  "MCP_PRINCIPALS_JSON=$mcpPrincipals"
  "GEO_BOOTSTRAP_TENANT_SLUG=$tenantSlug"
  "GEO_BOOTSTRAP_EMAIL=$operatorEmail"
  'GEO_BOOTSTRAP_DISPLAY_NAME="Customer Demo Owner"'
  "GEO_BOOTSTRAP_PASSWORD=$operatorPassword"
  "GEO_CUSTOMER_AGENT_TOKEN=$agentToken"
  "GEO_CUSTOMER_CTRIP_BRIDGE_TOKEN=$bridgeToken"
)
[IO.File]::WriteAllLines($envFile, $lines, [Text.UTF8Encoding]::new($false))

Write-Host "Starting the GEO customer demo. The first build can take several minutes..."
$composeArguments = @(
  '--env-file', $envFile,
  '-f', $composeFile,
  '-f', $demoComposeFile,
  '--profile', 'fixture-seed',
  '--profile', 'operator-bootstrap',
  '--profile', 'customer-demo',
  '--profile', 'ctrip-simulator',
  'up', '-d'
)
if ($NoBuild) {
  $composeArguments += '--no-build'
} else {
  $composeArguments += '--build'
}
& docker compose @composeArguments
if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed to start the customer demo." }

Wait-ForUrl "http://127.0.0.1:4173/healthz"
[IO.File]::WriteAllLines(
  $loginFile,
  @(
    "GEO customer demo"
    "URL: http://127.0.0.1:4173"
    "Email: $operatorEmail"
    "Password: $operatorPassword"
    ""
    "This profile creates previews and Ctrip simulations only. It cannot publish externally."
  ),
  [Text.UTF8Encoding]::new($false)
)

Write-Host "Customer demo is ready: http://127.0.0.1:4173"
Write-Host "Login details: $loginFile"
Start-Process "http://127.0.0.1:4173"
Start-Process notepad.exe -ArgumentList $loginFile
