# Generate PWA icons for Mian (AI murder-mystery) with System.Drawing.
# ASCII only on purpose: PowerShell 5.1 mangles non-BOM UTF-8 scripts.
# Run: powershell -ExecutionPolicy Bypass -File scripts/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot '..\public\icons'
New-Item -ItemType Directory -Force $out | Out-Null
$root = Resolve-Path (Join-Path $PSScriptRoot '..')

function New-Icon {
  param([int]$Size, [string]$File, [double]$Pad = 0.0, [bool]$Rounded = $true)

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  # --- background: ink black, rounded corners ---
  $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 11, 13, 20))
  if ($Rounded) {
    $r = [Math]::Max(2, [int]($Size * 0.22))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($Size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($Size - $d, $Size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $Size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $g.FillPath($bg, $path)
    $path.Dispose()
  } else {
    $g.FillRectangle($bg, 0, 0, $Size, $Size)
  }

  # --- soft amber glow behind the glass ---
  $glow = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gr = [int]($Size * 0.62)
  $glow.AddEllipse([int]($Size / 2 - $gr / 2), [int]($Size / 2 - $gr / 2), $gr, $gr)
  $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($glow)
  $pgb.CenterColor = [System.Drawing.Color]::FromArgb(56, 232, 192, 122)
  $pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 232, 192, 122))
  $g.FillPath($pgb, $glow)
  $pgb.Dispose(); $glow.Dispose()

  # --- geometry (all scaled by the safe padding) ---
  $s = $Size * (1.0 - $Pad * 2)
  $o = $Size * $Pad
  $cx = $o + $s * 0.44
  $cy = $o + $s * 0.44
  $ringR = $s * 0.26
  $ringW = [Math]::Max(2, $s * 0.066)

  # --- tilted case file behind the lens ---
  $cardState = $g.Save()
  $g.TranslateTransform([single]($o + $s * 0.47), [single]($o + $s * 0.48))
  $g.RotateTransform(-8)
  $cardW = $s * 0.53
  $cardH = $s * 0.61
  $cardX = -$cardW * 0.52
  $cardY = -$cardH * 0.47
  $cardR = [Math]::Max(2, [int]($s * 0.055))
  $card = New-Object System.Drawing.Drawing2D.GraphicsPath
  $cd = $cardR * 2
  $card.AddArc($cardX, $cardY, $cd, $cd, 180, 90)
  $card.AddArc($cardX + $cardW - $cd, $cardY, $cd, $cd, 270, 90)
  $card.AddArc($cardX + $cardW - $cd, $cardY + $cardH - $cd, $cd, $cd, 0, 90)
  $card.AddArc($cardX, $cardY + $cardH - $cd, $cd, $cd, 90, 90)
  $card.CloseFigure()
  $cardBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(22, 232, 192, 122))
  $cardPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(62, 232, 192, 122), [Math]::Max(1, $s * 0.008))
  $g.FillPath($cardBrush, $card)
  $g.DrawPath($cardPen, $card)
  $linePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(34, 255, 236, 205), [Math]::Max(1, $s * 0.009))
  $g.DrawLine($linePen, [single]($cardX + $cardW * 0.2), [single]($cardY + $cardH * 0.52), [single]($cardX + $cardW * 0.78), [single]($cardY + $cardH * 0.47))
  $g.DrawLine($linePen, [single]($cardX + $cardW * 0.2), [single]($cardY + $cardH * 0.64), [single]($cardX + $cardW * 0.65), [single]($cardY + $cardH * 0.6))
  $linePen.Dispose(); $cardPen.Dispose(); $cardBrush.Dispose(); $card.Dispose()
  $g.Restore($cardState)

  # --- magnifier ring: gold with a darker inner edge ---
  $gold = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 232, 192, 122), $ringW)
  $gold.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Center
  $g.DrawEllipse($gold, [single]($cx - $ringR), [single]($cy - $ringR), [single]($ringR * 2), [single]($ringR * 2))

  # --- glass (slightly lighter fill so it reads as a lens) ---
  $lens = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(38, 255, 236, 205))
  $g.FillEllipse($lens, [single]($cx - $ringR + $ringW), [single]($cy - $ringR + $ringW), [single](($ringR - $ringW) * 2), [single](($ringR - $ringW) * 2))
  $lens.Dispose()

  # --- highlight arc inside the lens ---
  $hl = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, 255, 244, 224), [Math]::Max(1, $s * 0.022))
  $hl.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $hl.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawArc($hl, [single]($cx - $ringR * 0.62), [single]($cy - $ringR * 0.62), [single]($ringR * 1.24), [single]($ringR * 1.24), 195, 75)
  $hl.Dispose()

  # --- blood drop inside the glass ---
  $blood = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 178, 42, 48))
  $dropR = $ringR * 0.30
  $g.FillEllipse($blood, [single]($cx - $dropR), [single]($cy - $dropR * 1.05), [single]($dropR * 2), [single]($dropR * 2))
  $tip = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tip.AddPolygon(@(
    (New-Object System.Drawing.PointF([single]$cx, [single]($cy - $dropR * 2.35))),
    (New-Object System.Drawing.PointF([single]($cx - $dropR * 0.78), [single]($cy - $dropR * 0.55))),
    (New-Object System.Drawing.PointF([single]($cx + $dropR * 0.78), [single]($cy - $dropR * 0.55)))
  ))
  $g.FillPath($blood, $tip)
  $tip.Dispose()
  $blood.Dispose()

  # --- handle (gold, rounded) ---
  $handle = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 232, 192, 122), [Math]::Max(2, $s * 0.088))
  $handle.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $handle.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $hx1 = $cx + $ringR * 0.72
  $hy1 = $cy + $ringR * 0.72
  $hx2 = $cx + $ringR * 1.62
  $hy2 = $cy + $ringR * 1.62
  $g.DrawLine($handle, [single]$hx1, [single]$hy1, [single]$hx2, [single]$hy2)
  $handle.Dispose()
  $gold.Dispose()

  # --- small evidence seal: makes the mark read as a game badge ---
  $sealX = $o + $s * 0.81
  $sealY = $o + $s * 0.2
  $sealR = $s * 0.105
  $sealBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(54, 232, 192, 122))
  $sealPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(178, 232, 192, 122), [Math]::Max(1, $s * 0.012))
  $g.FillEllipse($sealBrush, [single]($sealX - $sealR), [single]($sealY - $sealR), [single]($sealR * 2), [single]($sealR * 2))
  $g.DrawEllipse($sealPen, [single]($sealX - $sealR), [single]($sealY - $sealR), [single]($sealR * 2), [single]($sealR * 2))
  $checkPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 255, 236, 205), [Math]::Max(1, $s * 0.018))
  $checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawLines($checkPen, @(
    (New-Object System.Drawing.PointF([single]($sealX - $sealR * 0.45), [single]$sealY)),
    (New-Object System.Drawing.PointF([single]($sealX - $sealR * 0.08), [single]($sealY + $sealR * 0.34))),
    (New-Object System.Drawing.PointF([single]($sealX + $sealR * 0.52), [single]($sealY - $sealR * 0.4)))
  ))
  $checkPen.Dispose(); $sealPen.Dispose(); $sealBrush.Dispose()

  $g.Dispose()
  $full = Join-Path $root $File
  New-Item -ItemType Directory -Force (Split-Path $full -Parent) | Out-Null
  $bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $len = (Get-Item $full).Length
  Write-Host ("  {0,-40} {1,4}x{2,-4} {3,6} bytes" -f $File, $Size, $Size, $len)
}

Write-Host 'Generating PWA icons:'
New-Icon -Size 512 -File 'public\icons\icon-512.png' -Pad 0.06
New-Icon -Size 192 -File 'public\icons\icon-192.png' -Pad 0.06
# maskable: art must stay inside the centre 80% safe zone
New-Icon -Size 512 -File 'public\icons\icon-maskable-512.png' -Pad 0.155
# iOS home screen icon (no transparency, rounded corners are applied by iOS itself)
New-Icon -Size 180 -File 'public\icons\apple-touch-icon.png' -Pad 0.06 -Rounded $false
New-Icon -Size 64  -File 'public\icons\favicon-64.png' -Pad 0.06
New-Icon -Size 32  -File 'public\favicon.png' -Pad 0.06
New-Icon -Size 512 -File 'public\icons\icon-any-512.png' -Pad 0.06 -Rounded $false
Write-Host 'Done.'
# --- ICO 用的尺寸（打包桌面 App 时用，不进 dist） ---
Write-Host 'ICO sizes:'
New-Icon -Size 256 -File 'scripts\app\icons\ico-256.png' -Pad 0.06
New-Icon -Size 128 -File 'scripts\app\icons\ico-128.png' -Pad 0.06
New-Icon -Size 48  -File 'scripts\app\icons\ico-48.png'  -Pad 0.06
New-Icon -Size 32  -File 'scripts\app\icons\ico-32.png'  -Pad 0.06
New-Icon -Size 16  -File 'scripts\app\icons\ico-16.png'  -Pad 0.06
