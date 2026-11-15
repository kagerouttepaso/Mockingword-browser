# 使い方：計測と並べて別の PowerShell で回す。例：pwsh tools/sample-util.ps1 -Seconds 120 -Out $env:TEMP\util.csv
# 2秒前後ごとに1行。docs/09「GPU の使用率が上がらない理由」の数字はこれで取った。
param([int]$Seconds = 150, [string]$Out)
# GPU（エンジン種別ごとの使用率。タスクマネージャーと同じカウンター）と CPU（全体・論理コアの最大・Brave の各プロセス）を1秒ごとに記録する。
$cores = [Environment]::ProcessorCount
"time,gpu3d,gpuCompute,gpuCopy,cpuTotal,cpuMaxCore,braveTop" | Out-File $Out -Encoding utf8
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  $c = Get-Counter -Counter @('\GPU Engine(*)\Utilization Percentage', '\Processor(*)\% Processor Time', '\Process(brave*)\% Processor Time') -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue
  $s = $c.CounterSamples
  $g = $s | Where-Object Path -like '*gpu engine*'
  $sum = { param($t) [math]::Round((($g | Where-Object InstanceName -like "*engtype_$t*" | Measure-Object CookedValue -Sum).Sum), 1) }
  $proc = $s | Where-Object { $_.Path -like '*\processor(*' }
  $total = [math]::Round(($proc | Where-Object InstanceName -eq '_total').CookedValue, 1)
  $maxc = [math]::Round(($proc | Where-Object InstanceName -ne '_total' | Measure-Object CookedValue -Maximum).Maximum, 1)
  $br = $s | Where-Object { $_.Path -like '*\process(brave*' } | Sort-Object CookedValue -Descending | Select-Object -First 3 | ForEach-Object { "$($_.InstanceName)=$([math]::Round($_.CookedValue / $cores,1))" }
  "$(Get-Date -Format HH:mm:ss),$(& $sum '3D'),$(& $sum 'Compute'),$(& $sum 'Copy'),$total,$maxc,$($br -join ' ')" | Out-File $Out -Append -Encoding utf8
}
