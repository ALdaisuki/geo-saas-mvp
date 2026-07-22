[CmdletBinding()]
param(
  [switch]$NoBuild,
  [string]$CdpEndpoint = "http://host.docker.internal:10005",
  [string]$CtripBrowserExecutable = "",
  [string]$CtripBrowserProfile = "",
  [ValidateRange(10000, 65535)]
  [int]$CtripBrowserDebugPort = 10015,
  [string]$DockerCdpRemoteAddress = "192.168.65.0/24",
  [switch]$NoSupervisor,
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

$launcher = Join-Path $PSScriptRoot "start-customer-demo.ps1"
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "The customer demo launcher was not found at $launcher."
}

$arguments = @{
  CtripMode = "browser_unattended"
  LaunchCtripBrowser = $true
  AgentMode = "real"
  CdpEndpoint = $CdpEndpoint
  CtripBrowserDebugPort = $CtripBrowserDebugPort
  DockerCdpRemoteAddress = $DockerCdpRemoteAddress
}
if ($NoBuild) { $arguments.NoBuild = $true }
if (-not [string]::IsNullOrWhiteSpace($CtripBrowserExecutable)) {
  $arguments.CtripBrowserExecutable = $CtripBrowserExecutable
}
if (-not [string]::IsNullOrWhiteSpace($CtripBrowserProfile)) {
  $arguments.CtripBrowserProfile = $CtripBrowserProfile
}
if (-not [string]::IsNullOrWhiteSpace($AgentProvider)) {
  $arguments.AgentProvider = $AgentProvider
}
if (-not [string]::IsNullOrWhiteSpace($AgentModel)) {
  $arguments.AgentModel = $AgentModel
}
if (-not [string]::IsNullOrWhiteSpace($AgentApi)) {
  $arguments.AgentApi = $AgentApi
}
if (-not [string]::IsNullOrWhiteSpace($AgentBaseUrl)) {
  $arguments.AgentBaseUrl = $AgentBaseUrl
}
if (-not [string]::IsNullOrWhiteSpace($AgentReasoningEffort)) {
  $arguments.AgentReasoningEffort = $AgentReasoningEffort
}
if (-not [string]::IsNullOrWhiteSpace($PlasticPromiseMcpUrl)) {
  $arguments.PlasticPromiseMcpUrl = $PlasticPromiseMcpUrl
}
if (-not [string]::IsNullOrWhiteSpace($PlasticPromiseSourceRoot)) {
  $arguments.PlasticPromiseSourceRoot = $PlasticPromiseSourceRoot
}

& $launcher @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not $NoSupervisor) {
  $supervisor = Join-Path $PSScriptRoot "ctrip-host-supervisor.ps1"
  & $supervisor -Action Install -CdpProxyPort ([Uri]$CdpEndpoint).Port -EdgeDebugPort $CtripBrowserDebugPort -DockerRemoteAddress $DockerCdpRemoteAddress
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
exit 0
