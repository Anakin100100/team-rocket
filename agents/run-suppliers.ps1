# Start the BOM supplier agents (ted:604012-2026) in parallel and wait for them.
# Usage (from anywhere): powershell -File agents\run-suppliers.ps1
# Then, within ~60 s, sign in as the buyer and post the demo_bom.csv demands.
$ErrorActionPreference = "Stop"

$Personas = @("supplier-POL-5240203283", "supplier-POL-5741002058")
$Prompt = "Trade now: run the loop in CLAUDE.md until it ends."
$LogDir = Join-Path $env:TEMP "team-rocket-logs"
New-Item -ItemType Directory -Force $LogDir | Out-Null

$jobs = foreach ($name in $Personas) {
    $dir = Join-Path $PSScriptRoot $name
    $log = Join-Path $LogDir "$name.log"
    Write-Host "Starting $name -> $log"
    Start-Job -Name $name -ArgumentList $dir, $Prompt, $log -ScriptBlock {
        param($dir, $prompt, $log)
        Set-Location $dir
        claude -p $prompt --model claude-opus-5-5 --effort high `
            --mcp-config .mcp.json --strict-mcp-config `
            --setting-sources project,local `
            --allowedTools "mcp__market__*" --max-turns 60 *> $log
    }
}

Write-Host "Suppliers running. Post the buyer demands now (they stop after ~60 s idle)."
Wait-Job $jobs | Out-Null
foreach ($job in $jobs) {
    Write-Host "== $($job.Name): $($job.State)"
    Get-Content (Join-Path $LogDir "$($job.Name).log") -Tail 15
}
Remove-Job $jobs
