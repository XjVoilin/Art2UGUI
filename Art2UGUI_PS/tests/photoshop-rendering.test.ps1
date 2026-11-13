param([string]$PsdPath)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Path $PSScriptRoot -Parent
$root = Split-Path -Path $project -Parent
$fixture = Join-Path $root '.tmp/ClippingBusiness.psd'
if ($PsdPath) {
    $inputPath = (Resolve-Path -LiteralPath $PsdPath).Path
    if ($inputPath -ne [IO.Path]::GetFullPath($fixture)) {
        New-Item -ItemType Directory -Path (Split-Path -Path $fixture -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $inputPath -Destination $fixture -Force
    }
}
if (-not (Test-Path -LiteralPath $fixture)) { throw 'Supply -PsdPath with a saved PSD containing img_Copy.' }
$photoshop = New-Object -ComObject Photoshop.Application
$photoshop.DoJavaScriptFile((Join-Path $PSScriptRoot 'photoshop-rendering.test.jsx')) | Out-Null
$output = Join-Path $root '.tmp/photoshop-rendering-test'
$report = Get-Content -LiteralPath (Join-Path $output 'report.txt') -Encoding UTF8 -Raw
if ($report -match '(?m)^FAIL:' -or $report -notmatch '(?m)^PASS:') { throw $report }

Add-Type -AssemblyName System.Drawing
$expected = [System.Drawing.Bitmap]::new((Join-Path $output 'expected.png'))
$actual = [System.Drawing.Bitmap]::new((Join-Path $output 'RenderingCase/img_Copy.png'))
try {
    if ($actual.Size -ne $expected.Size) { throw 'Export dimensions differ from the flat reference.' }
    $different = 0
    for ($y = 0; $y -lt $actual.Height; $y++) {
        for ($x = 0; $x -lt $actual.Width; $x++) {
            if ($actual.GetPixel($x, $y).ToArgb() -ne $expected.GetPixel($x, $y).ToArgb()) { $different++ }
        }
    }
    if ($different -ne 0) { throw "Export differs from the original render at $different pixels." }
    "PASS: $($actual.Width)x$($actual.Height), pixel-for-pixel match with original render; transparent border preserved."
}
finally {
    $expected.Dispose()
    $actual.Dispose()
}
