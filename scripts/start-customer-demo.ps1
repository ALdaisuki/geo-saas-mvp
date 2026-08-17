[CmdletBinding()]
param(
  [switch]$NoBuild,
  [ValidateSet("simulator", "browser_supervised", "browser_unattended")]
  [string]$CtripMode = "simulator",
  [switch]$LaunchCtripBrowser,
  [string]$CtripBrowserExecutable = "",
  [string]$CtripBrowserProfile = "",
  [string]$CdpEndpoint = "http://host.docker.internal:10005",
  [ValidateRange(10000, 65535)]
  [int]$CtripBrowserDebugPort = 10015,
  [string]$DockerCdpRemoteAddress = "192.168.65.0/24",
  [ValidateSet("fixture", "real")]
  [string]$AgentMode = "fixture",
  [string]$AgentProvider = "",
  [string]$AgentModel = "",
  [ValidateSet("", "openai-responses", "openai-completions")]
  [string]$AgentApi = "",
  [string]$AgentBaseUrl = "",
  [ValidateSet("", "off", "minimal", "low", "medium", "high", "xhigh")]
  [string]$AgentReasoningEffort = "",
  [string]$PlasticPromiseMcpUrl = "",
  [string]$PlasticPromiseSourceRoot = ""
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

function Configured-Value($Values, [string]$Name, [string]$Default = "") {
  if ($Values.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace($Values[$Name])) {
    return $Values[$Name]
  }
  $processValue = [Environment]::GetEnvironmentVariable($Name, "Process")
  if (-not [string]::IsNullOrWhiteSpace($processValue)) {
    return $processValue
  }
  return $Default
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

function Select-AvailableHostPort([int]$PreferredPort, [int[]]$ReservedPorts = @(), [int]$Attempts = 100) {
  for ($offset = 0; $offset -lt $Attempts; $offset++) {
    $candidate = $PreferredPort + $offset
    if ($ReservedPorts -contains $candidate) { continue }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse("127.0.0.1"), $candidate)
    try {
      $listener.Start()
      return $candidate
    } catch {
      continue
    } finally {
      $listener.Stop()
    }
  }
  throw "No available host port was found from $PreferredPort through $($PreferredPort + $Attempts - 1)."
}

function Resolve-HostPort($Values, [string]$Name, [int]$PreferredPort, [int[]]$ReservedPorts = @()) {
  $configured = Configured-Value $Values $Name
  $parsed = 0
  if ([int]::TryParse($configured, [ref]$parsed)) {
    if ($parsed -ge 10001 -and $parsed -le 65535) {
      if ($ReservedPorts -contains $parsed) {
        throw "$Name ($parsed) conflicts with another configured host port."
      }
      return $parsed
    }
  }
  return Select-AvailableHostPort -PreferredPort $PreferredPort -ReservedPorts $ReservedPorts
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
$bridgeRuntimeRoot = Join-Path $runtimeRoot "ctrip-bridge"
$bridgeRuntimeTmpRoot = Join-Path $bridgeRuntimeRoot "tmp"
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
New-Item -ItemType Directory -Force -Path $bridgeRuntimeTmpRoot | Out-Null
$existing = Read-EnvFile $envFile
$agentRunTimeoutMs = 0
if (-not [int]::TryParse((Configured-Value $existing "AGENT_RUN_TIMEOUT_MS" "120000"), [ref]$agentRunTimeoutMs) -or
    $agentRunTimeoutMs -lt 1000 -or $agentRunTimeoutMs -gt 900000) {
  throw "AGENT_RUN_TIMEOUT_MS must be an integer between 1000 and 900000."
}
$agentGatewayRunTimeoutMs = $agentRunTimeoutMs + 10000
$mcpHostPort = Resolve-HostPort $existing "MCP_PORT" 10001
$webHostPort = Resolve-HostPort $existing "WEB_PORT" 10003 @($mcpHostPort)
$apiHostPort = Resolve-HostPort $existing "API_HOST_PORT" 10004 @($mcpHostPort, $webHostPort)
$bridgeHostPort = Resolve-HostPort $existing "CTRIP_BRIDGE_HOST_PORT" 10006 @($mcpHostPort, $webHostPort, $apiHostPort)

$isCtripBrowser = $CtripMode -in @("browser_supervised", "browser_unattended")
$isCtripSupervised = $isCtripBrowser
$ctripCdpPort = $null
if ($isCtripSupervised) {
  $parsedCdpEndpoint = [Uri]$CdpEndpoint
  $ctripCdpPort = $parsedCdpEndpoint.Port
  if ($LaunchCtripBrowser) {
    if ($CdpEndpoint -notmatch '^http://host\.docker\.internal:\d{1,5}/?$') {
      throw "Launching the Ctrip browser requires a credential-free http://host.docker.internal:<port> CDP endpoint."
    }
    if ($ctripCdpPort -eq $CtripBrowserDebugPort) {
      throw "Docker Ctrip CDP proxy port and local Edge debug port must be different."
    }
    if ([string]::IsNullOrWhiteSpace($CtripBrowserProfile)) {
      $CtripBrowserProfile = Join-Path $runtimeRoot "ctrip-edge-profile"
    }
    $browserProfileRoot = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($CtripBrowserProfile))
    if ($browserProfileRoot.TrimEnd('\').Equals('C:', [StringComparison]::OrdinalIgnoreCase)) {
      throw "Ctrip browser profile must be stored on drive D: or another data drive."
    }
    if ([string]::IsNullOrWhiteSpace($CtripBrowserExecutable)) {
      $edgeCandidates = @(
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path ${env:ProgramFiles} "Microsoft\Edge\Application\msedge.exe")
      ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_) }
      $CtripBrowserExecutable = $edgeCandidates | Select-Object -First 1
    }
    if ([string]::IsNullOrWhiteSpace($CtripBrowserExecutable) -or -not (Test-Path -LiteralPath $CtripBrowserExecutable)) {
      throw "Microsoft Edge was not found. Pass -CtripBrowserExecutable with the Edge executable path."
    }
    New-Item -ItemType Directory -Force -Path $CtripBrowserProfile | Out-Null
    $browserArguments = @(
      "--remote-debugging-port=$CtripBrowserDebugPort",
      "--user-data-dir=$CtripBrowserProfile",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "https://we.ctrip.com/publish/publishPictureText"
    )
    Start-Process -FilePath $CtripBrowserExecutable -ArgumentList $browserArguments | Out-Null
    $cdpDeadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
    while ([DateTimeOffset]::UtcNow -lt $cdpDeadline) {
      try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$CtripBrowserDebugPort/json/version" -TimeoutSec 3
        break
      } catch {
        Start-Sleep -Milliseconds 500
      }
    }
    if ([DateTimeOffset]::UtcNow -ge $cdpDeadline) {
      throw "Edge CDP did not become available on http://127.0.0.1:$CtripBrowserDebugPort."
    }
    & netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$ctripCdpPort *> $null
    & netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ctripCdpPort connectaddress=127.0.0.1 connectport=$CtripBrowserDebugPort | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Ctrip CDP port proxy could not be configured." }
    $firewallName = "GEO Ctrip CDP $ctripCdpPort"
    $firewallRule = Get-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue
    if ($null -eq $firewallRule) {
      $firewallRule = New-NetFirewallRule -DisplayName $firewallName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $ctripCdpPort -RemoteAddress $DockerCdpRemoteAddress -Profile Any
    } else {
      $firewallRule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Any | Out-Null
      $firewallRule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $ctripCdpPort | Out-Null
      $firewallRule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress $DockerCdpRemoteAddress | Out-Null
    }
    Write-Host "Dedicated Edge profile started at $CtripBrowserProfile. Complete Ctrip login in that window before continuing."
  }
}
$ctripAdapterVersion = if ($CtripMode -eq "browser_unattended") {
  "ctrip-community-browser-unattended-v1"
} elseif ($isCtripSupervised) {
  "ctrip-community-browser-supervised-v1"
} else {
  "ctrip-community-simulator-v1"
}
$ctripProfile = if ($CtripMode -eq "browser_unattended") {
  "ctrip-browser-unattended"
} elseif ($isCtripSupervised) {
  "ctrip-browser-supervised"
} else {
  "ctrip-simulator"
}
if ($isCtripSupervised) {
  if ($CdpEndpoint -notmatch '^http://host\.docker\.internal:\d{1,5}/?$') {
    throw "Supervised Ctrip mode requires a credential-free http://host.docker.internal:<port> CDP endpoint."
  }
  $cdpUri = [Uri]$CdpEndpoint
  if ($cdpUri.Port -lt 1 -or $cdpUri.Port -gt 65535) {
    throw "The supervised Ctrip CDP port is invalid."
  }
  $hostCdpBase = "http://127.0.0.1:$CtripBrowserDebugPort"
  try {
    $targets = @(Invoke-RestMethod -Uri "$hostCdpBase/json/list" -TimeoutSec 5)
  } catch {
    throw "Edge CDP is not reachable on $hostCdpBase. Start the reviewed Edge session first."
  }
  $publishTargets = @(
    $targets | Where-Object { $_.type -eq "page" -and $_.url -eq "https://we.ctrip.com/publish/publishPictureText" }
  )
  if ($publishTargets.Count -ne 1) {
    throw "Supervised Ctrip mode requires exactly one open Ctrip picture-text publish page; found $($publishTargets.Count)."
  }
  $CdpEndpoint = $CdpEndpoint.TrimEnd('/')
}

if ($null -eq (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker Desktop is required. Install Docker Desktop, start it, then double-click the launcher again."
}
& docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker Desktop is installed but its engine is not running. Start Docker Desktop and try again."
}
& docker compose version *> $null
if ($LASTEXITCODE -ne 0) { throw "Docker Compose is unavailable in this Docker installation." }

$configuredAgentProvider = if ([string]::IsNullOrWhiteSpace($AgentProvider)) {
  Configured-Value $existing "AGENT_PROVIDER" "fixture"
} else { $AgentProvider }
$configuredAgentModel = if ([string]::IsNullOrWhiteSpace($AgentModel)) {
  Configured-Value $existing "AGENT_MODEL" "fixture-geo-writer-v1"
} else { $AgentModel }
$configuredAgentApi = if ([string]::IsNullOrWhiteSpace($AgentApi)) {
  Configured-Value $existing "AGENT_API"
} else { $AgentApi }
$configuredMcpUrl = if ([string]::IsNullOrWhiteSpace($PlasticPromiseMcpUrl)) {
  Configured-Value $existing "PLASTIC_PROMISE_MCP_URL"
} else { $PlasticPromiseMcpUrl }
$configuredMcpSourceRoot = if ([string]::IsNullOrWhiteSpace($PlasticPromiseSourceRoot)) {
  Configured-Value $existing "PLASTIC_PROMISE_SOURCE_ROOT"
} else { [IO.Path]::GetFullPath($PlasticPromiseSourceRoot) }
$configuredAgentBaseUrl = if ([string]::IsNullOrWhiteSpace($AgentBaseUrl)) {
  Configured-Value $existing "AGENT_BASE_URL"
} else { $AgentBaseUrl }
$configuredAgentReasoningEffort = if ([string]::IsNullOrWhiteSpace($AgentReasoningEffort)) {
  Configured-Value $existing "AGENT_REASONING_EFFORT" "off"
} else { $AgentReasoningEffort }
$configuredAgentApiKey = Configured-Value $existing "AGENT_API_KEY"
$governanceMode = if ($AgentMode -eq "real") { "external" } else { "demo_fixture" }
$mediaProvider = if ($governanceMode -eq "external") { "disabled" } else { "fixture" }
$mediaSearchProvider = if ($governanceMode -eq "external") { "wikimedia_commons" } else { "disabled" }
if ($AgentMode -eq "fixture") {
  $configuredAgentProvider = "fixture"
  $configuredAgentModel = if ([string]::IsNullOrWhiteSpace($AgentModel)) { "fixture-geo-writer-v1" } else { $AgentModel }
  $configuredAgentBaseUrl = ""
  $configuredAgentApi = ""
}
if ($AgentMode -eq "real") {
  if ($configuredAgentProvider -eq "fixture") {
    throw "Real AgentMode requires AGENT_PROVIDER to be a registered Pi provider or openai-compatible."
  }
  if ($configuredAgentModel -eq "fixture-geo-writer-v1") {
    throw "Real AgentMode requires AGENT_MODEL for the selected Pi provider."
  }
  if ([string]::IsNullOrWhiteSpace($configuredAgentApiKey)) {
    throw "Real AgentMode requires AGENT_API_KEY in the existing customer-demo.env or the secret environment."
  }
  if ([string]::IsNullOrWhiteSpace($configuredMcpUrl)) {
    throw "Real AgentMode requires PlasticPromiseMcpUrl or PLASTIC_PROMISE_MCP_URL in customer-demo.env."
  }
}
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
$tenantSlug = "sample-travel"

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
  adapterVersion = $ctripAdapterVersion
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
  "API_HOST_PORT=$apiHostPort"
  "WEB_PORT=$webHostPort"
  "MCP_PORT=$mcpHostPort"
  "CTRIP_BRIDGE_HOST_PORT=$bridgeHostPort"
  "SESSION_SECRET=$sessionSecret"
  "APP_ORIGIN=http://127.0.0.1:$webHostPort"
  "GEO_DEPLOYMENT_PROFILE=customer_demo"
  "GEO_GOVERNANCE_MODE=$governanceMode"
  "PLASTIC_PROMISE_MCP_URL=$configuredMcpUrl"
  "PLASTIC_PROMISE_SOURCE_ROOT=$configuredMcpSourceRoot"
  "WORKER_TENANT_ACTORS_JSON=$workerActors"
  "CTRIP_ASSISTED_ACCOUNTS_JSON=$assistedAccounts"
  "CTRIP_CUSTOMER_ADAPTER_VERSION=$ctripAdapterVersion"
  "CTRIP_BRIDGE_GATEWAY_URL=http://ctrip-bridge:9030"
  "CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON=$bridgeCredentials"
  "CTRIP_BRIDGE_TENANTS_JSON=$bridgeTenants"
  "CTRIP_BRIDGE_MODE=$CtripMode"
  "CTRIP_REVIEW_CDP_ENDPOINT=$CdpEndpoint"
  "GEO_RUNTIME_TMP_ROOT=/var/lib/geo/runtime/tmp"
  "GEO_CTRIP_RUNTIME_ROOT=$bridgeRuntimeRoot"
  "AGENT_PROVIDER=$configuredAgentProvider"
  "AGENT_MODEL=$configuredAgentModel"
  "AGENT_API=$configuredAgentApi"
  "AGENT_BASE_URL=$configuredAgentBaseUrl"
  "AGENT_REASONING_EFFORT=$configuredAgentReasoningEffort"
  "AGENT_API_KEY=$configuredAgentApiKey"
  "AGENT_RUN_TIMEOUT_MS=$agentRunTimeoutMs"
  "AGENT_GATEWAY_RUN_TIMEOUT_MS=$agentGatewayRunTimeoutMs"
  "AGENT_GATEWAY_CREDENTIALS_JSON=$agentCredentials"
  "AUTOMATION_PRODUCER_ENABLED=true"
  "GEO_MEDIA_PROVIDER=$mediaProvider"
  "GEO_MEDIA_SEARCH_PROVIDER=$mediaSearchProvider"
  "DOUBAO_ADAPTER=fixture"
  "QWEN_ADAPTER=fixture"
  "MCP_ALLOWED_HOSTS=127.0.0.1:9021,localhost:9021,127.0.0.1:$mcpHostPort,localhost:$mcpHostPort"
  "MCP_ALLOWED_ORIGINS=http://127.0.0.1:$webHostPort"
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
  '--profile', $ctripProfile,
  'up', '-d'
)
if ($NoBuild) {
  $composeArguments += '--no-build'
} else {
  $composeArguments += '--build'
}
& docker compose @composeArguments
if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed to start the customer demo." }

Wait-ForUrl "http://127.0.0.1:$webHostPort/healthz"
[IO.File]::WriteAllLines(
  $loginFile,
  @(
    "GEO customer demo"
    "URL: http://127.0.0.1:$webHostPort"
    "Email: $operatorEmail"
    "Password: $operatorPassword"
    ""
    $(if ($CtripMode -eq "browser_unattended") {
      "Ctrip unattended browser mode is active. Preparation, one-time submit and public readback are automatic; challenges and ambiguous results stop in needs_review."
    } elseif ($isCtripSupervised) {
      "Ctrip supervised mode is active. Draft preparation is automatic; final submit requires explicit approval in this GEO console."
    } else {
      "This profile creates previews and Ctrip simulations only. It cannot publish externally."
    })
  ),
  [Text.UTF8Encoding]::new($false)
)

Write-Host "Customer demo is ready in Ctrip $CtripMode mode: http://127.0.0.1:$webHostPort"
Write-Host "Agent MCP host port: $mcpHostPort (container port remains 9021)"
Write-Host "API host port: $apiHostPort (container port remains 4100)"
Write-Host "Ctrip Bridge host port: $bridgeHostPort (container port remains 9030)"
Write-Host "Login details: $loginFile"
Start-Process "http://127.0.0.1:$webHostPort"
Start-Process notepad.exe -ArgumentList $loginFile
