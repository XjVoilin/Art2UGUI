param([switch]$RunPhotoshop)
$ErrorActionPreference = 'Stop'
$project = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$output = Join-Path $project '.tmp/photoshop-image-bounds-test'
if ($RunPhotoshop) {
    $ps = New-Object -ComObject Photoshop.Application
    $ps.DoJavaScriptFile((Join-Path $PSScriptRoot 'photoshop-image-bounds.test.jsx')) | Out-Null
}
$report = Get-Content -LiteralPath (Join-Path $output 'report.txt') -Raw
if ($report -match '(?m)^FAIL' -or ([regex]::Matches($report, '(?m)^PASS AdBoundsCase')).Count -ne 3) {
    throw "Native Photoshop regression failed: $report"
}
Add-Type -AssemblyName System.Drawing
for ($index = 0; $index -lt 3; $index++) {
    $actual = [System.Drawing.Bitmap]::new((Join-Path $output "AdBoundsCase$index/Common/img_ad_01.png"))
    $expected = [System.Drawing.Bitmap]::new((Join-Path $output "expected-AdBoundsCase$index.png"))
    try {
        if ($actual.Size -ne $expected.Size) { throw "Case $index image sizes differ" }
        for ($y = 0; $y -lt $actual.Height; $y++) {
            for ($x = 0; $x -lt $actual.Width; $x++) {
                if ($actual.GetPixel($x, $y).ToArgb() -ne $expected.GetPixel($x, $y).ToArgb()) {
                    throw "Case $index pixel mismatch at ($x,$y)"
                }
            }
        }
        "PASS AdBoundsCase$index pixels match full-composite reference ($($actual.Width)x$($actual.Height))"
    } finally { $actual.Dispose(); $expected.Dispose() }
}
$report
