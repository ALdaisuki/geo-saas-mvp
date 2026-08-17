[CmdletBinding()]
param(
  [ValidateSet("Install", "Run", "RunOnce", "Status", "Uninstall")]
  [string]$Action = "Run",
  [ValidateRange(10000, 65535)]
  [int]$CdpProxyPort = 10005,
  [ValidateRange(10000, 65535)]
  [int]$EdgeDebugPort = 10015,
  [ValidateRange(10000, 65535)]
  [int]$GovernanceProxyPort = 10002,
  [ValidateRange(10000, 65535)]
  [int]$GovernanceLocalPort = 10012,
  [ValidateRange(5, 300)]
  [int]$CheckIntervalSeconds = 15,
  [string]$DockerRemoteAddress = "192.168.65.0/24",
  [string]$EdgeExecutable = "",
  [string]$EdgeProfile = "",
  [string]$GovernanceSourceRoot = "",
  [string]$OllamaExecutable = "",
  [string]$OllamaModelsRoot = "D:\Ollama\models",
  [string]$OllamaEmbeddingModel = "mxbai-embed-large"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$repoDrive = [IO.Path]::GetPathRoot($repoRoot)
$runtimeRoot = Join-Path $repoDrive "GEO\.runtime\geo-saas-customer-demo"
$envFile = Join-Path $runtimeRoot "customer-demo.env"
$statusFile = Join-Path $runtimeRoot "ctrip-host-supervisor-status.json"
$phaseFile = Join-Path $runtimeRoot "ctrip-host-supervisor-phase.json"
$lockFile = Join-Path $runtimeRoot "ctrip-host-supervisor.lock"
$logFile = Join-Path $runtimeRoot "ctrip-host-supervisor.log"
$stopFile = Join-Path $runtimeRoot "ctrip-host-supervisor.stop"
$governanceStdoutLog = Join-Path $runtimeRoot "plastic-promise-mcp.stdout.log"
$governanceStderrLog = Join-Path $runtimeRoot "plastic-promise-mcp.stderr.log"
$ollamaStdoutLog = Join-Path $runtimeRoot "ollama.stdout.log"
$ollamaStderrLog = Join-Path $runtimeRoot "ollama.stderr.log"
$taskName = "GEO Ctrip Host Supervisor"
$composeFile = Join-Path $repoRoot "compose.yaml"
$demoComposeFile = Join-Path $repoRoot "compose.customer-demo.yaml"
$publishUrl = "https://we.ctrip.com/publish/publishPictureText"
$dockerDesktopCandidates = @(
  "D:\Docker\Docker\Docker Desktop.exe",
  "D:\Program Files\Docker\Docker\Docker Desktop.exe",
  "C:\Program Files\Docker\Docker\Docker Desktop.exe"
)

function Write-SupervisorLog([string]$Message) {
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Write-SupervisorStatus([string]$State, [string]$Detail, [bool]$OllamaReady, [bool]$GovernanceReady, [bool]$DockerReady, [bool]$EdgeReady, [bool]$BridgeReady) {
  $document = [ordered]@{
    schemaVersion = "geo.ctrip-host-supervisor.v2"
    state = $State
    detail = $Detail
    ollamaReady = $OllamaReady
    governanceReady = $GovernanceReady
    dockerReady = $DockerReady
    edgeReady = $EdgeReady
    bridgeReady = $BridgeReady
    governanceProxyPort = $GovernanceProxyPort
    governanceLocalPort = $GovernanceLocalPort
    cdpProxyPort = $CdpProxyPort
    edgeDebugPort = $EdgeDebugPort
    checkedAt = [DateTimeOffset]::UtcNow.ToString("o")
  }
  $document | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusFile -Encoding UTF8
}

function Write-RecoveryPhase([string]$Phase) {
  [ordered]@{
    schemaVersion = "geo.ctrip-host-supervisor-phase.v1"
    phase = $Phase
    checkedAt = [DateTimeOffset]::UtcNow.ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath $phaseFile -Encoding UTF8
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

function Test-TcpPort([string]$HostName, [int]$Port, [int]$TimeoutMilliseconds = 1000) {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $pending = $client.ConnectAsync($HostName, $Port)
    return $pending.Wait($TimeoutMilliseconds) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Invoke-JsonProbe([string]$Url, [int]$TimeoutSeconds = 5) {
  try {
    $raw = (& curl.exe -sS --max-time $TimeoutSeconds $Url 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) { return $null }
    return $raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Resolve-GovernanceSourceRoot {
  $configured = $GovernanceSourceRoot
  if ([string]::IsNullOrWhiteSpace($configured)) {
    $values = Read-EnvFile $envFile
    if ($values.ContainsKey("PLASTIC_PROMISE_SOURCE_ROOT")) {
      $configured = $values["PLASTIC_PROMISE_SOURCE_ROOT"]
    }
  }
  if ([string]::IsNullOrWhiteSpace($configured)) {
    throw "PLASTIC_PROMISE_SOURCE_ROOT is not configured for host supervision."
  }
  $resolved = [IO.Path]::GetFullPath($configured)
  if ([IO.Path]::GetPathRoot($resolved).TrimEnd('\').Equals('C:', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Plastic Promise source root must not use drive C:."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $resolved "plastic_promise\__main__.py"))) {
    throw "Plastic Promise source root is not a runnable source checkout."
  }
  return $resolved
}

function Resolve-OllamaExecutable {
  if (-not [string]::IsNullOrWhiteSpace($OllamaExecutable) -and (Test-Path -LiteralPath $OllamaExecutable)) {
    return [IO.Path]::GetFullPath($OllamaExecutable)
  }
  $command = Get-Command ollama -ErrorAction SilentlyContinue
  if ($null -eq $command -or -not (Test-Path -LiteralPath $command.Source)) {
    throw "Ollama executable was not found."
  }
  return $command.Source
}

function Test-OllamaEmbeddingModel {
  $response = Invoke-JsonProbe "http://127.0.0.1:11434/api/tags" 5
  if ($null -eq $response) { return $false }
  return @($response.models) | Where-Object {
    ([string]$_.name -eq $OllamaEmbeddingModel) -or ([string]$_.name -eq "$OllamaEmbeddingModel`:latest")
  } | Select-Object -First 1
}

function Wait-Ollama([int]$Seconds = 60) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if (Test-OllamaEmbeddingModel) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Ensure-Ollama {
  if (Test-OllamaEmbeddingModel) { return }
  $existingListener = Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue
  if ($null -ne $existingListener) {
    throw "Ollama embedding model is unavailable while port 11434 is already occupied."
  }
  $resolvedModelsRoot = [IO.Path]::GetFullPath($OllamaModelsRoot)
  if ([IO.Path]::GetPathRoot($resolvedModelsRoot).TrimEnd('\').Equals('C:', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Ollama models must not use drive C:."
  }
  if (-not (Test-Path -LiteralPath $resolvedModelsRoot)) {
    throw "Ollama models root does not exist."
  }
  $runtimeTmp = Join-Path $runtimeRoot "tmp"
  New-Item -ItemType Directory -Force -Path $runtimeTmp | Out-Null
  $previousHost = $env:OLLAMA_HOST
  $previousModels = $env:OLLAMA_MODELS
  $previousTemp = $env:TEMP
  $previousTmp = $env:TMP
  try {
    $env:OLLAMA_HOST = "127.0.0.1:11434"
    $env:OLLAMA_MODELS = $resolvedModelsRoot
    $env:TEMP = $runtimeTmp
    $env:TMP = $runtimeTmp
    Start-Process -FilePath (Resolve-OllamaExecutable) -ArgumentList @("serve") -WindowStyle Hidden -RedirectStandardOutput $ollamaStdoutLog -RedirectStandardError $ollamaStderrLog | Out-Null
  } finally {
    $env:OLLAMA_HOST = $previousHost
    $env:OLLAMA_MODELS = $previousModels
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
  }
  if (-not (Wait-Ollama)) {
    throw "Ollama embedding model is unavailable after service recovery."
  }
  Write-SupervisorLog "Ollama recovered with the required embedding model."
}

function Test-GovernanceMcp {
  $response = Invoke-JsonProbe "http://127.0.0.1:$GovernanceLocalPort/health" 30
  if ($null -eq $response -or [string]$response.status -ne "ok") { return $false }
  try {
    $expectedRoot = Resolve-GovernanceSourceRoot
    $reportedRoot = [IO.Path]::GetFullPath([string]$response.source_root)
    return $reportedRoot.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

function Get-GovernanceHealthSnapshot {
  $tempResponse = Join-Path $runtimeRoot "governance-health-response.json"
  try {
    $statusCode = & curl.exe -sS --max-time 10 -o $tempResponse -w '%{http_code}' "http://127.0.0.1:$GovernanceLocalPort/health"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tempResponse)) { return $null }
    $body = Get-Content -LiteralPath $tempResponse -Raw | ConvertFrom-Json
    return [pscustomobject]@{ StatusCode = [int]$statusCode; Body = $body }
  } catch {
    return $null
  } finally {
    Remove-Item -LiteralPath $tempResponse -Force -ErrorAction SilentlyContinue
  }
}

function Stop-VerifiedGovernanceProcess {
  $snapshot = Get-GovernanceHealthSnapshot
  $expectedRoot = Resolve-GovernanceSourceRoot
  if ($null -eq $snapshot -or [string]::IsNullOrWhiteSpace([string]$snapshot.Body.source_root)) {
    throw "Refusing to stop an unverified process on the governance local port."
  }
  $reportedRoot = [IO.Path]::GetFullPath([string]$snapshot.Body.source_root)
  if (-not $reportedRoot.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to stop an unverified process from a different governance source root."
  }
  $listener = Get-NetTCPConnection -LocalPort $GovernanceLocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $listener -or [int]$listener.OwningProcess -ne [int]$snapshot.Body.pid) {
    throw "Refusing to stop an unverified process whose listener identity does not match health evidence."
  }
  Stop-Process -Id ([int]$listener.OwningProcess) -Force
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if ($null -eq (Get-NetTCPConnection -LocalPort $GovernanceLocalPort -State Listen -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "Verified Plastic Promise MCP process did not stop cleanly."
}

function Wait-GovernanceMcp([int]$Seconds = 120) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if (Test-GovernanceMcp) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Ensure-GovernanceMcp {
  if (Test-GovernanceMcp) { return }
  $existingListener = Get-NetTCPConnection -LocalPort $GovernanceLocalPort -State Listen -ErrorAction SilentlyContinue
  if ($null -ne $existingListener) {
    Stop-VerifiedGovernanceProcess
  }
  $sourceRoot = Resolve-GovernanceSourceRoot
  $python = Join-Path $sourceRoot ".venv\Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $python)) {
    throw "Plastic Promise virtual-environment Python was not found."
  }
  $runtimeTmp = Join-Path $runtimeRoot "tmp"
  New-Item -ItemType Directory -Force -Path $runtimeTmp | Out-Null
  $previousTemp = $env:TEMP
  $previousTmp = $env:TMP
  $previousRuntimeMode = $env:PLASTIC_RUNTIME_MODE
  try {
    $env:TEMP = $runtimeTmp
    $env:TMP = $runtimeTmp
    $env:PLASTIC_RUNTIME_MODE = "rust-full"
    Start-Process -FilePath $python -ArgumentList @("-m", "plastic_promise", "--streamable-http", "$GovernanceLocalPort") -WorkingDirectory $sourceRoot -WindowStyle Hidden -RedirectStandardOutput $governanceStdoutLog -RedirectStandardError $governanceStderrLog | Out-Null
  } finally {
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
    $env:PLASTIC_RUNTIME_MODE = $previousRuntimeMode
  }
  if (-not (Wait-GovernanceMcp)) {
    throw "Plastic Promise MCP did not become healthy on local port $GovernanceLocalPort."
  }
  Write-SupervisorLog "Plastic Promise MCP recovered on local port $GovernanceLocalPort."
}

function Test-DockerReady {
  & docker info *> $null
  return $LASTEXITCODE -eq 0
}

function Test-ApiReady {
  $values = Read-EnvFile $envFile
  $port = if ($values.ContainsKey("API_HOST_PORT")) { [int]$values["API_HOST_PORT"] } else { 10004 }
  $response = Invoke-JsonProbe "http://127.0.0.1:$port/health/live" 3
  return $null -ne $response -and [string]$response.status -eq "ok"
}

function Wait-DockerReady([int]$Seconds = 180) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if (Test-DockerReady) { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}

function Ensure-DockerDesktop {
  if (Test-ApiReady) { return }
  if (Test-DockerReady) { return }
  $dockerDesktop = $dockerDesktopCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($dockerDesktop)) {
    throw "Docker Desktop executable was not found."
  }
  Start-Process -FilePath $dockerDesktop -WindowStyle Hidden | Out-Null
  if (-not (Wait-DockerReady)) { throw "Docker Desktop did not become ready." }
  Write-SupervisorLog "Docker Desktop recovered."
}

function Resolve-EdgeExecutable {
  if (-not [string]::IsNullOrWhiteSpace($EdgeExecutable) -and (Test-Path -LiteralPath $EdgeExecutable)) {
    return $EdgeExecutable
  }
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path ${env:ProgramFiles} "Microsoft\Edge\Application\msedge.exe")
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_) }
  $resolved = $candidates | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($resolved)) { throw "Microsoft Edge was not found." }
  return $resolved
}

function Test-EdgeCdp {
  try {
    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$EdgeDebugPort/json/version" -TimeoutSec 3
    return -not [string]::IsNullOrWhiteSpace($version.webSocketDebuggerUrl)
  } catch {
    return $false
  }
}

function Ensure-EdgeCdp {
  if (Test-EdgeCdp) { return $false }
  $resolvedProfile = if ([string]::IsNullOrWhiteSpace($EdgeProfile)) {
    Join-Path $runtimeRoot "ctrip-edge-profile"
  } else {
    [IO.Path]::GetFullPath($EdgeProfile)
  }
  if ([IO.Path]::GetPathRoot($resolvedProfile).TrimEnd('\').Equals('C:', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Ctrip Edge profile must not use drive C:."
  }
  New-Item -ItemType Directory -Force -Path $resolvedProfile | Out-Null
  $arguments = @(
    "--remote-debugging-port=$EdgeDebugPort",
    "--user-data-dir=$resolvedProfile",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    $publishUrl
  )
  Start-Process -FilePath (Resolve-EdgeExecutable) -ArgumentList $arguments | Out-Null
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(45)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if (Test-EdgeCdp) {
      Write-SupervisorLog "Dedicated Edge CDP recovered on local port $EdgeDebugPort."
      return $true
    }
    Start-Sleep -Milliseconds 750
  }
  throw "Dedicated Edge CDP did not become ready on port $EdgeDebugPort."
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-CdpProxy([bool]$ForceValidation = $false) {
  if (-not $ForceValidation -and (Test-TcpPort "127.0.0.1" $CdpProxyPort)) { return }
  if (-not (Test-Administrator)) {
    throw "Ctrip CDP proxy maintenance requires an elevated supervisor task."
  }
  $current = (& netsh interface portproxy show v4tov4 | Out-String)
  $expected = "0.0.0.0\s+$CdpProxyPort\s+127.0.0.1\s+$EdgeDebugPort"
  if ($current -notmatch $expected) {
    & netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$CdpProxyPort *> $null
    & netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$CdpProxyPort connectaddress=127.0.0.1 connectport=$EdgeDebugPort | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Ctrip CDP port proxy could not be configured." }
  }
  $displayName = "GEO Ctrip CDP $CdpProxyPort"
  $rule = Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue
  if ($null -eq $rule) {
    $rule = New-NetFirewallRule -DisplayName $displayName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $CdpProxyPort -RemoteAddress $DockerRemoteAddress -Profile Any
  } else {
    $rule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Any | Out-Null
    $rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $CdpProxyPort | Out-Null
    $rule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress $DockerRemoteAddress | Out-Null
  }
}

function Ensure-GovernanceProxy([bool]$ForceValidation = $false) {
  if (-not $ForceValidation -and (Test-TcpPort "127.0.0.1" $GovernanceProxyPort)) { return }
  if (-not (Test-Administrator)) {
    throw "Plastic Promise MCP proxy maintenance requires an elevated supervisor task."
  }
  $current = (& netsh interface portproxy show v4tov4 | Out-String)
  $expected = "0.0.0.0\s+$GovernanceProxyPort\s+127.0.0.1\s+$GovernanceLocalPort"
  if ($current -notmatch $expected) {
    & netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$GovernanceProxyPort *> $null
    & netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$GovernanceProxyPort connectaddress=127.0.0.1 connectport=$GovernanceLocalPort | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Plastic Promise MCP port proxy could not be configured." }
  }
  $ruleName = "GEO Plastic Promise MCP $GovernanceProxyPort"
  $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if ($null -eq $rule) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $GovernanceProxyPort -RemoteAddress $DockerRemoteAddress -Profile Any | Out-Null
  } else {
    $rule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Any | Out-Null
    $rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $GovernanceProxyPort | Out-Null
    $rule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress $DockerRemoteAddress | Out-Null
  }
}

function Compose-Arguments {
  return @(
    "--profile", "customer-demo",
    "--profile", "fixture-seed",
    "--profile", "operator-bootstrap",
    "--profile", "ctrip-browser-unattended",
    "--env-file", $envFile,
    "-f", $composeFile,
    "-f", $demoComposeFile
  )
}

function Test-ContainerRunning([string]$Name) {
  $state = (& docker inspect -f '{{.State.Running}}' $Name 2>$null | Out-String).Trim()
  return $LASTEXITCODE -eq 0 -and $state -eq "true"
}

function Test-ContainerHealthy([string]$Name) {
  $health = (& docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $Name 2>$null | Out-String).Trim()
  return $LASTEXITCODE -eq 0 -and $health -eq "healthy"
}

function Wait-ContainerHealthy([string]$Name, [int]$Seconds = 240) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if (Test-ContainerHealthy $Name) { return $true }
    $state = (& docker inspect -f '{{.State.Status}}' $Name 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $state -eq "exited") { return $false }
    Start-Sleep -Seconds 3
  }
  return $false
}

function Ensure-ComposeStack([bool]$RestartBridge) {
  if (-not (Test-Path -LiteralPath $envFile)) { throw "Customer demo environment is not configured." }
  $compose = Compose-Arguments
  $values = Read-EnvFile $envFile
  $bridgeHostPort = if ($values.ContainsKey("CTRIP_BRIDGE_HOST_PORT")) { [int]$values["CTRIP_BRIDGE_HOST_PORT"] } else { 10006 }
  if ((Test-ApiReady) -and (Test-TcpPort "127.0.0.1" $bridgeHostPort) -and -not $RestartBridge) { return }
  $stackNeedsRecovery = @(
    @(
      "geo-saas-customer-demo-postgres-1",
      "geo-saas-customer-demo-api-1",
      "geo-saas-customer-demo-worker-1",
      "geo-saas-customer-demo-agent-mcp-1",
      "geo-saas-customer-demo-web-1"
    ) | Where-Object { -not (Test-ContainerHealthy $_) }
  )
  if ($stackNeedsRecovery.Count -gt 0) {
    & docker compose @compose up -d --no-build api
    if ($LASTEXITCODE -ne 0) { throw "GEO API dependencies could not be recovered." }
    if (-not (Wait-ContainerHealthy "geo-saas-customer-demo-api-1")) {
      throw "GEO API did not become healthy after dependency recovery."
    }
    & docker compose @compose up -d --no-build
    if ($LASTEXITCODE -ne 0) { throw "GEO customer stack could not be recovered after API health was established." }
  }
  if ($RestartBridge -or -not (Test-ContainerRunning "geo-saas-customer-demo-ctrip-bridge-1")) {
    & docker compose @compose up -d --no-build --no-deps --force-recreate ctrip-bridge
    if ($LASTEXITCODE -ne 0) { throw "Ctrip bridge could not be recovered." }
    Write-SupervisorLog "Ctrip bridge recovered after host dependency check."
  }
  if (-not (Wait-ContainerHealthy "geo-saas-customer-demo-ctrip-bridge-1")) {
    throw "Ctrip bridge did not become healthy after recovery."
  }
}

function Get-BridgeReadiness {
  $values = Read-EnvFile $envFile
  if (-not $values.ContainsKey("CTRIP_BRIDGE_TENANTS_JSON")) { throw "Ctrip bridge credential mapping is missing." }
  if (-not $values.ContainsKey("CTRIP_BRIDGE_HOST_PORT")) { $values["CTRIP_BRIDGE_HOST_PORT"] = "10006" }
  $tenants = $values["CTRIP_BRIDGE_TENANTS_JSON"] | ConvertFrom-Json
  $tenant = @($tenants) | Select-Object -First 1
  if ($null -eq $tenant -or [string]::IsNullOrWhiteSpace($tenant.accessToken)) {
    throw "Ctrip bridge credential mapping is invalid."
  }
  $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$($values['CTRIP_BRIDGE_HOST_PORT'])/health/ready")
  $request.Method = "GET"
  $request.Timeout = 45000
  $request.ReadWriteTimeout = 45000
  $request.Host = "127.0.0.1:9030"
  $request.Headers[[Net.HttpRequestHeader]::Authorization] = "Bearer $($tenant.accessToken)"
  $response = $null
  try {
    try {
      $response = $request.GetResponse()
    } catch [Net.WebException] {
      if ($null -eq $_.Exception.Response) { throw }
      $response = $_.Exception.Response
    }
    $reader = [IO.StreamReader]::new($response.GetResponseStream())
    try { $content = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    $status = [string]$content.status
    $httpStatus = [int]([Net.HttpWebResponse]$response).StatusCode
    $expectedHttpStatus = if ($status -eq "ready") { 200 } else { 503 }
    if ($status -notin @("ready", "session_required", "challenge_required", "unavailable") -or $httpStatus -ne $expectedHttpStatus) {
      throw "Unexpected Ctrip bridge readiness status '$status' with HTTP $httpStatus."
    }
    return [pscustomobject]@{ Status = $status; HttpStatus = $httpStatus }
  } finally {
    if ($null -ne $response) { $response.Dispose() }
  }
}

function Invoke-SupervisorCycle {
  Write-RecoveryPhase "checking_ollama"
  Ensure-Ollama
  Write-RecoveryPhase "checking_governance"
  Ensure-GovernanceMcp
  Write-RecoveryPhase "checking_docker"
  Ensure-DockerDesktop
  Write-RecoveryPhase "checking_governance_proxy"
  Ensure-GovernanceProxy
  Write-RecoveryPhase "checking_edge"
  $edgeRestarted = Ensure-EdgeCdp
  Write-RecoveryPhase "checking_cdp_proxy"
  Ensure-CdpProxy
  Write-RecoveryPhase "checking_compose"
  Ensure-ComposeStack $edgeRestarted
  Write-RecoveryPhase "checking_ctrip_session"
  $readiness = Get-BridgeReadiness
  $bridgeReady = $readiness.Status -eq "ready"
  Write-SupervisorStatus $readiness.Status "Ctrip bridge readiness: $($readiness.Status)" $true $true $true $true $bridgeReady
  return $readiness.Status
}

function Install-Supervisor {
  if (-not (Test-Administrator)) { throw "Install must run in an elevated PowerShell session." }
  if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile -Force }
  Ensure-Ollama
  Ensure-GovernanceMcp
  Ensure-GovernanceProxy $true
  Ensure-CdpProxy $true
  $quotedScript = '"' + $PSCommandPath + '"'
  $quotedGovernanceRoot = '"' + (Resolve-GovernanceSourceRoot) + '"'
  $quotedOllamaModelsRoot = '"' + ([IO.Path]::GetFullPath($OllamaModelsRoot)) + '"'
  $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $quotedScript -Action Run -CdpProxyPort $CdpProxyPort -EdgeDebugPort $EdgeDebugPort -GovernanceProxyPort $GovernanceProxyPort -GovernanceLocalPort $GovernanceLocalPort -GovernanceSourceRoot $quotedGovernanceRoot -OllamaModelsRoot $quotedOllamaModelsRoot -OllamaEmbeddingModel $OllamaEmbeddingModel -CheckIntervalSeconds $CheckIntervalSeconds -DockerRemoteAddress $DockerRemoteAddress"
  $taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $repoRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Write-SupervisorLog "Supervisor scheduled task installed and started."
}

function Uninstall-Supervisor {
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  New-Item -ItemType File -Force -Path $stopFile | Out-Null
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-SupervisorStatus "stopped" "Supervisor is disabled." ([bool](Test-OllamaEmbeddingModel)) (Test-GovernanceMcp) (Test-DockerReady) (Test-EdgeCdp) $false
}

if ($CdpProxyPort -eq $EdgeDebugPort) { throw "Ctrip CDP proxy and Edge debug ports must be different." }
if ($GovernanceProxyPort -eq $GovernanceLocalPort) { throw "Governance proxy and local ports must be different." }
if (@($CdpProxyPort, $EdgeDebugPort, $GovernanceProxyPort, $GovernanceLocalPort) | Group-Object | Where-Object Count -gt 1) {
  throw "Ctrip CDP and governance ports must all be distinct."
}
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

switch ($Action) {
  "Install" { Install-Supervisor; break }
  "Uninstall" { Uninstall-Supervisor; break }
  "Status" {
    if (Test-Path -LiteralPath $statusFile) { Get-Content -LiteralPath $statusFile -Raw }
    else { Write-SupervisorStatus "not_started" "Supervisor has not written status." ([bool](Test-OllamaEmbeddingModel)) (Test-GovernanceMcp) (Test-DockerReady) (Test-EdgeCdp) $false; Get-Content -LiteralPath $statusFile -Raw }
    break
  }
  "RunOnce" {
    try {
      Invoke-SupervisorCycle
    } catch {
      Write-SupervisorLog "RunOnce recovery failed: $($_.Exception.Message)"
      Write-SupervisorStatus "degraded" $_.Exception.Message ([bool](Test-OllamaEmbeddingModel)) (Test-GovernanceMcp) (Test-DockerReady) (Test-EdgeCdp) $false
      throw
    }
    break
  }
  "Run" {
    $lockStream = $null
    try {
      try {
        $lockStream = [IO.File]::Open(
          $lockFile,
          [IO.FileMode]::OpenOrCreate,
          [IO.FileAccess]::ReadWrite,
          [IO.FileShare]::None
        )
      } catch [IO.IOException] {
        exit 0
      }
      while (-not (Test-Path -LiteralPath $stopFile)) {
        try {
          $null = Invoke-SupervisorCycle
        } catch {
          Write-SupervisorLog "Supervisor cycle failed: $($_.Exception.Message)"
          Write-SupervisorStatus "degraded" $_.Exception.Message ([bool](Test-OllamaEmbeddingModel)) (Test-GovernanceMcp) (Test-DockerReady) (Test-EdgeCdp) $false
        }
        Start-Sleep -Seconds $CheckIntervalSeconds
      }
    } finally {
      if ($null -ne $lockStream) { $lockStream.Dispose() }
    }
  }
}
