# _engine.ps1 — shared Zenwall collage engine for the PowerShell installer.
# Dot-source this from a generator script:  . "$PSScriptRoot\_engine.ps1"
# It compiles the C# WallpaperEngine once to WallpaperEngine.dll next to itself.
#
# This is the same aspect-aware weighted-tiling engine as the web app, kept here
# so the Windows auto-rotation path needs no browser. Public surface:
#   [WallpaperEngine]::CreateZenWallpaper($wallDir, $outputPath)
#   [WallpaperEngine]::SetWallpaper($path)

$Assemblies = @("System.Drawing", "System.Windows.Forms")
# v2: adds letterbox / solid-bar detection. Bumping the filename forces a
# recompile on existing installs without touching the old artifact.
$DllPath    = Join-Path $PSScriptRoot "WallpaperEngine.v2.dll"

if (Test-Path $DllPath) {
    Add-Type -Path $DllPath
} else {
    Add-Type -ReferencedAssemblies $Assemblies -OutputAssembly $DllPath -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Collections.Generic;
using System.IO;
using System.Linq;

public class WallpaperEngine {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    private const int SPI_SETDESKWALLPAPER = 20;
    private const int SPIF_UPDATEINIFILE = 0x01;
    private const int SPIF_SENDWININICHANGE = 0x02;

    public static void SetWallpaper(string path) {
        SystemParametersInfo(SPI_SETDESKWALLPAPER, 0, path, SPIF_UPDATEINIFILE | SPIF_SENDWININICHANGE);
    }

    public static void CreateZenWallpaper(string wallDir, string outputPath) {
        SetProcessDPIAware();
        int screenWidth = Screen.PrimaryScreen.Bounds.Width;
        int screenHeight = Screen.PrimaryScreen.Bounds.Height;

        if (screenWidth < 1280 || screenHeight < 720) return;

        int gridRows = 7;
        int gridCols = 22;
        int outerPadding = 0;
        int innerPadding = 6;

        int cellWidth  = (screenWidth  - 2 * outerPadding - (gridCols - 1) * innerPadding) / gridCols;
        int cellHeight = (screenHeight - 2 * outerPadding - (gridRows - 1) * innerPadding) / gridRows;

        Bitmap canvas = new Bitmap(screenWidth, screenHeight);
        using (Graphics g = Graphics.FromImage(canvas)) {
            g.Clear(Color.FromArgb(15, 15, 20));
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.SmoothingMode = SmoothingMode.HighQuality;

            bool[,] grid = new bool[gridRows, gridCols];
            string[] extensions = { "*.jpg", "*.jpeg", "*.png", "*.bmp", "*.webp", "*.gif" };
            List<string> imageFiles = new List<string>();
            foreach (string ext in extensions) {
                imageFiles.AddRange(Directory.GetFiles(wallDir, ext));
            }

            if (imageFiles.Count == 0) return;

            Random rnd = new Random();
            imageFiles = imageFiles.OrderBy(x => rnd.Next()).ToList();

            int imageIdx = 0;
            int placementAttempts = 0;
            int maxAttempts = imageFiles.Count * 3;

            while (imageIdx < imageFiles.Count && placementAttempts < maxAttempts) {
                placementAttempts++;
                string imgPath = imageFiles[imageIdx];

                try {
                    using (Image img = Image.FromFile(imgPath)) {
                        Rectangle crop = DetectContentRect(img);
                        float imageAspect = (float)crop.Width / crop.Height;

                        int chunkW, chunkH;
                        if (imageAspect < 0.8f) {
                            int[] ws = { 1, 1, 2 }; int[] hs = { 2, 3, 3 }; int[] weights = { 8, 6, 4 };
                            int i = GetWeightedRandom(weights, rnd);
                            chunkW = ws[i]; chunkH = hs[i];
                        } else if (imageAspect > 1.3f) {
                            int[] ws = { 2, 3, 4, 3 }; int[] hs = { 1, 1, 2, 2 }; int[] weights = { 8, 6, 4, 6 };
                            int i = GetWeightedRandom(weights, rnd);
                            chunkW = ws[i]; chunkH = hs[i];
                        } else {
                            int[] ws = { 1, 2, 2, 1 }; int[] hs = { 1, 2, 1, 2 }; int[] weights = { 5, 8, 4, 4 };
                            int i = GetWeightedRandom(weights, rnd);
                            chunkW = ws[i]; chunkH = hs[i];
                        }

                        var pos = FindBestPosition(grid, chunkW, chunkH, gridRows, gridCols, rnd);

                        if (pos == null) {
                            int[,] fallbacks;
                            if (imageAspect < 0.8f) fallbacks = new int[,] { {1,2}, {1,1}, {2,1} };
                            else if (imageAspect > 1.3f) fallbacks = new int[,] { {2,1}, {1,1}, {1,2} };
                            else fallbacks = new int[,] { {2,2}, {1,1}, {2,1}, {1,2} };

                            for (int f = 0; f < fallbacks.GetLength(0); f++) {
                                pos = FindBestPosition(grid, fallbacks[f,0], fallbacks[f,1], gridRows, gridCols, rnd);
                                if (pos != null) {
                                    chunkW = fallbacks[f,0]; chunkH = fallbacks[f,1];
                                    break;
                                }
                            }
                        }

                        if (pos != null) {
                            int row = pos.Item1;
                            int col = pos.Item2;
                            imageIdx++;

                            int w = chunkW * cellWidth + (chunkW - 1) * innerPadding;
                            int h = chunkH * cellHeight + (chunkH - 1) * innerPadding;

                            float aspectChunk = (float)w / h;
                            int newW, newH, offsetX, offsetY;

                            // Pick the source sub-rect (from the letterbox-cropped
                            // region) that covers the destination cell.
                            float srcSubW, srcSubH, srcSubX, srcSubY;
                            if (imageAspect > aspectChunk) {
                                srcSubH = crop.Height;
                                srcSubW = crop.Height * aspectChunk;
                                srcSubX = crop.X + (crop.Width - srcSubW) / 2f;
                                srcSubY = crop.Y;
                            } else {
                                srcSubW = crop.Width;
                                srcSubH = crop.Width / aspectChunk;
                                srcSubX = crop.X;
                                srcSubY = crop.Y + (crop.Height - srcSubH) / 2f;
                            }
                            offsetX = outerPadding + col * (cellWidth + innerPadding);
                            offsetY = outerPadding + row * (cellHeight + innerPadding);
                            newW = w; newH = h;

                            RectangleF destRect = new RectangleF(offsetX, offsetY, newW, newH);
                            RectangleF srcRect  = new RectangleF(srcSubX, srcSubY, srcSubW, srcSubH);
                            g.SetClip(new Rectangle(offsetX, offsetY, w, h));
                            g.DrawImage(img, destRect, srcRect, GraphicsUnit.Pixel);
                            g.ResetClip();

                            MarkOccupied(grid, chunkW, chunkH, row, col);
                        }
                    }
                } catch { imageIdx++; }
            }
        }
        canvas.Save(outputPath, ImageFormat.Png);
        canvas.Dispose();
    }

    // Detect solid black/white bars baked into a source image (letterboxing).
    // Only strips bars found on opposing edges; caps each side at ~22% so
    // solid-background art passes through untouched. Downscales to a 64px
    // thumbnail first — plenty of resolution to spot a band.
    private static Rectangle DetectContentRect(Image src) {
        int iw = src.Width, ih = src.Height;
        Rectangle full = new Rectangle(0, 0, iw, ih);
        const int MAX = 64;
        const float CAP = 0.22f;
        const double UNIFORM = 10.0;
        const double DARK = 26.0;
        const double LIGHT = 229.0;
        float scale = Math.Min(1f, (float)MAX / Math.Max(iw, ih));
        int w = Math.Max(4, (int)Math.Round(iw * scale));
        int h = Math.Max(4, (int)Math.Round(ih * scale));

        byte[] px;
        int stride;
        using (Bitmap thumb = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
            using (Graphics tg = Graphics.FromImage(thumb)) {
                // Nearest-neighbor keeps bar edges crisp so a couple pixels in
                // reads as pure black/white, not a blended mid-gray.
                tg.InterpolationMode = InterpolationMode.NearestNeighbor;
                tg.PixelOffsetMode = PixelOffsetMode.Half;
                tg.DrawImage(src, new Rectangle(0, 0, w, h));
            }
            BitmapData bd = thumb.LockBits(new Rectangle(0, 0, w, h),
                ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            stride = bd.Stride;
            px = new byte[stride * h];
            Marshal.Copy(bd.Scan0, px, 0, px.Length);
            thumb.UnlockBits(bd);
        }

        // GDI 24bpp is BGR.
        Func<int, bool, double[]> lineStats = (fixedIdx, isRow) => {
            int n = isRow ? w : h;
            double sr = 0, sg = 0, sb = 0;
            for (int k = 0; k < n; k++) {
                int y = isRow ? fixedIdx : k;
                int x = isRow ? k : fixedIdx;
                int i = y * stride + x * 3;
                sb += px[i]; sg += px[i + 1]; sr += px[i + 2];
            }
            double mr = sr / n, mg = sg / n, mb = sb / n;
            double vr = 0, vg = 0, vb = 0;
            for (int k = 0; k < n; k++) {
                int y = isRow ? fixedIdx : k;
                int x = isRow ? k : fixedIdx;
                int i = y * stride + x * 3;
                double dr = px[i + 2] - mr, dg = px[i + 1] - mg, db = px[i] - mb;
                vr += dr * dr; vg += dg * dg; vb += db * db;
            }
            double stdev = Math.Sqrt((vr + vg + vb) / (3.0 * n));
            return new double[] { (mr + mg + mb) / 3.0, stdev };
        };
        Func<double[], bool> isBar = s => s[1] <= UNIFORM && (s[0] <= DARK || s[0] >= LIGHT);

        int capV = (int)(h * CAP);
        int capH = (int)(w * CAP);
        int top = 0, bot = 0, left = 0, right = 0;
        while (top < capV && isBar(lineStats(top, true))) top++;
        while (bot < capV && isBar(lineStats(h - 1 - bot, true))) bot++;
        while (left < capH && isBar(lineStats(left, false))) left++;
        while (right < capH && isBar(lineStats(w - 1 - right, false))) right++;

        if (top == 0 || bot == 0) { top = 0; bot = 0; }
        if (left == 0 || right == 0) { left = 0; right = 0; }
        if (top == 0 && bot == 0 && left == 0 && right == 0) return full;

        int sx = (int)Math.Round((left / (double)w) * iw);
        int sy = (int)Math.Round((top / (double)h) * ih);
        int sw = Math.Max(1, iw - sx - (int)Math.Round((right / (double)w) * iw));
        int sh = Math.Max(1, ih - sy - (int)Math.Round((bot / (double)h) * ih));
        return new Rectangle(sx, sy, sw, sh);
    }

    private static int GetWeightedRandom(int[] weights, Random rnd) {
        int sum = weights.Sum();
        int r = rnd.Next(sum);
        for (int i = 0; i < weights.Length; i++) {
            if (r < weights[i]) return i;
            r -= weights[i];
        }
        return 0;
    }

    private static Tuple<int, int> FindBestPosition(bool[,] grid, int cw, int ch, int rows, int cols, Random rnd) {
        var positions = new List<Tuple<float, int, int>>();
        for (int r = 0; r < rows; r++) {
            for (int c = 0; c < cols; c++) {
                if (Fits(grid, cw, ch, r, c, rows, cols)) {
                    int neighbors = 0;
                    for (int i = Math.Max(0, r - 1); i < Math.Min(rows, r + ch + 1); i++) {
                        for (int j = Math.Max(0, c - 1); j < Math.Min(cols, c + cw + 1); j++) {
                            if (grid[i, j]) neighbors++;
                        }
                    }
                    float score = neighbors - (r * 0.1f) - (c * 0.05f);
                    positions.Add(new Tuple<float, int, int>(score, r, c));
                }
            }
        }

        if (positions.Count > 0) {
            return positions.OrderByDescending(p => p.Item1).Take(5).OrderBy(x => rnd.Next()).Select(p => new Tuple<int, int>(p.Item2, p.Item3)).First();
        }
        return null;
    }

    private static bool Fits(bool[,] grid, int cw, int ch, int r, int c, int rows, int cols) {
        if (r + ch > rows || c + cw > cols) return false;
        for (int i = r; i < r + ch; i++) {
            for (int j = c; j < c + cw; j++) {
                if (grid[i, j]) return false;
            }
        }
        return true;
    }

    private static void MarkOccupied(bool[,] grid, int cw, int ch, int r, int c) {
        for (int i = r; i < r + ch; i++) {
            for (int j = c; j < c + cw; j++) {
                grid[i, j] = true;
            }
        }
    }
}
"@
    Add-Type -Path $DllPath
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
