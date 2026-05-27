$ErrorActionPreference = "Stop"

$workspace = "D:\Android\dual-agent-orchestrator"
$port = 9898
$serveLog = Join-Path $workspace "runtime\serve.log"

function Get-ListeningProcessId([int]$TargetPort) {
  $connection = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $connection) {
    return $null
  }
  return $connection.OwningProcess
}

function Stop-PortProcess([int]$TargetPort) {
  $processId = Get-ListeningProcessId $TargetPort
  if ($null -eq $processId) {
    Write-Host "No listener found on port $TargetPort."
    return
  }

  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
  if ($null -eq $process) {
    Write-Host "Port $TargetPort is held by PID $processId, but the process could not be resolved."
    return
  }

  if ($process.Name -ne "node.exe" -or $process.CommandLine -notlike "*dist/index.js serve*") {
    throw "Refusing to stop PID $processId on port $TargetPort because it is not the expected local serve process. CommandLine=$($process.CommandLine)"
  }

  Stop-Process -Id $processId -Force
  Write-Host "Stopped local serve process PID $processId on port $TargetPort."
}

function Wait-ForHealth([string]$Url, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 2
      if ($response.status -eq "ok" -or $response.status -eq "degraded") {
        return $true
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)

  return $false
}

Stop-PortProcess -TargetPort $port

Start-Process cmd.exe `
  -ArgumentList '/c', 'npm run serve > runtime\serve.log 2>&1' `
  -WorkingDirectory $workspace `
  -WindowStyle Hidden

if (-not (Wait-ForHealth -Url "http://127.0.0.1:$port/health" -TimeoutSeconds 30)) {
  throw "Local serve process did not become healthy on port $port within 30 seconds. Check $serveLog"
}

Write-Host "Local serve process is healthy on http://127.0.0.1:$port"
