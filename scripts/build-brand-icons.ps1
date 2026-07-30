param(
    [string]$Source = (Join-Path $PSScriptRoot "..\docs\brand\draft-goblin-master-chroma.png"),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\extension\icons")
)

Add-Type -AssemblyName System.Drawing
$sourceImage = [System.Drawing.Bitmap]::new((Resolve-Path $Source).Path)

try {
    foreach ($size in @(16, 32, 48, 128, 1024)) {
        $canvas = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($canvas)
        try {
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $graphics.InterpolationMode = if ($size -le 32) { [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear } else { [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic }
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.Clear([System.Drawing.Color]::FromArgb(7, 23, 18))
            $attributes = [System.Drawing.Imaging.ImageAttributes]::new()
            try {
                $attributes.SetColorKey([System.Drawing.Color]::FromArgb(225, 0, 205), [System.Drawing.Color]::FromArgb(255, 55, 255))
                $destination = [System.Drawing.Rectangle]::new(0, 0, $size, $size)
                $graphics.DrawImage($sourceImage, $destination, 0, 0, $sourceImage.Width, $sourceImage.Height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
            } finally { $attributes.Dispose() }
        } finally { $graphics.Dispose() }

        $path = Join-Path $OutputDirectory "icon-$size.png"
        $canvas.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $canvas.Dispose()
        Write-Host "Built $path"
    }
} finally { $sourceImage.Dispose() }
