# Generates N test images with NEW fictitious Xbox-format keys in the style of the
# channel posts (white bold text with black outline over an illustration).
# Usage: pwsh make-test-images.ps1 -Background <image> [-Count 3]
param([Parameter(Mandatory)][string]$Background, [int]$Count = 3)
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot 'test-images'
New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem $out -Filter 'teste-*.jpg' | ForEach-Object { $_.Delete() }
$alpha = 'BCDFGHJKMPQRTVWXY2346789'.ToCharArray()
$rnd = [Random]::new()
foreach ($n in 1..$Count) {
    $img = [Drawing.Bitmap]::FromFile($Background)
    $g = [Drawing.Graphics]::FromImage($img); $g.SmoothingMode = 'AntiAlias'
    $key = (1..5 | ForEach-Object { -join (1..5 | ForEach-Object { $alpha[$rnd.Next($alpha.Length)] }) }) -join '-'
    $path = [Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddString($key, [Drawing.FontFamily]::new('Segoe UI'), [int][Drawing.FontStyle]::Bold, 100, [Drawing.PointF]::new(0, 0), [Drawing.StringFormat]::GenericTypographic)
    $b = $path.GetBounds(); $target = $img.Width * 0.94; $s = $target / $b.Width
    $m = [Drawing.Drawing2D.Matrix]::new()
    $m.Translate(($img.Width - $target) / 2, $img.Height * (0.45 + 0.1 * $rnd.NextDouble()))
    $m.Scale($s, $s); $m.Translate(-$b.X, -$b.Y); $path.Transform($m)
    $pen = [Drawing.Pen]::new([Drawing.Color]::Black, [Math]::Max(6, $img.Width / 120)); $pen.LineJoin = 'Round'
    $g.DrawPath($pen, $path); $g.FillPath([Drawing.Brushes]::White, $path); $g.Dispose()
    $img.Save((Join-Path $out "teste-$n.jpg"), [Drawing.Imaging.ImageFormat]::Jpeg); $img.Dispose()
}
"$Count imagens novas em $out"
