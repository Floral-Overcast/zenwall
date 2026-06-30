/*
 * Color analysis + ordering for composed (non-random) layouts.
 *
 * The mosaic looks random when images of unrelated colors land next to each
 * other. We fix that by giving each image a color signature, then ordering the
 * pool with a "step sort" (hue-banded, gray-aware) so similar colors sit
 * together and the wallpaper reads as color fields. A per-render hue rotation
 * lets every layout (and every frame in a rotation pack) start the spectrum at
 * a different place, so frames stay distinct.
 *
 * Attaches a single global `Palette`.
 */
(function (global) {
  'use strict';

  // Average color of an image, sampled from a tiny downscale. Cheap, runs once
  // per image on load. Returns {r,g,b,h,s,v,lum} or null if the canvas is tainted.
  function analyze(img) {
    var n = 24;
    var c = document.createElement('canvas');
    c.width = n; c.height = n;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    try {
      ctx.drawImage(img, 0, 0, n, n);
      var d = ctx.getImageData(0, 0, n, n).data;
      var r = 0, g = 0, b = 0, count = 0;
      for (var i = 0; i < d.length; i += 4) {
        var a = d[i + 3];
        if (a < 16) continue;            // skip near-transparent pixels
        r += d[i]; g += d[i + 1]; b += d[i + 2]; count++;
      }
      if (!count) return null;
      r /= count; g /= count; b /= count;
      var hsv = rgbToHsv(r / 255, g / 255, b / 255);
      var lum = Math.sqrt(0.241 * (r / 255) + 0.691 * (g / 255) + 0.068 * (b / 255));
      return { r: r, g: g, b: b, h: hsv.h, s: hsv.s, v: hsv.v, lum: lum };
    } catch (e) {
      return null;                       // tainted (shouldn't happen with CORS-clean images)
    }
  }

  function rgbToHsv(r, g, b) {
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6; if (h < 0) h += 1;
    }
    return { h: h, s: max === 0 ? 0 : d / max, v: max };
  }

  // Step-sort key (after Aldo Cortesi's color sorting). Grays go in a leading
  // band ordered by luminance; colors are hue-banded with a serpentine
  // luminance/value flip so each band flows smoothly into the next. `hueShift`
  // (0..1) rotates the spectrum so different colors lead.
  function sortKey(col, reps, hueShift) {
    if (!col) return [9, 0, 0, 0];       // unknown color -> trailing band
    if (col.s < 0.12) {                  // desaturated -> gray band, by luminance
      return [0, 0, Math.round(col.lum * reps * 4), 0];
    }
    var h = (col.h + (hueShift || 0)) % 1; if (h < 0) h += 1;
    var h2 = Math.round(h * reps);
    var lum2 = Math.round(col.lum * reps);
    var v2 = Math.round(col.v * reps);
    if (h2 % 2 === 1) { v2 = reps - v2; lum2 = reps - lum2; }
    return [1, h2, lum2, v2];
  }

  function cmpKey(a, b) {
    for (var i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }

  // Return a new array of items ordered for a composed layout.
  // `getColor(item)` yields the item's color signature (or null).
  function compose(items, getColor, opts) {
    opts = opts || {};
    var reps = opts.reps || 8;
    var hueShift = opts.hueShift || 0;
    return items
      .map(function (it) { return { it: it, key: sortKey(getColor(it), reps, hueShift) }; })
      .sort(function (a, b) { return cmpKey(a.key, b.key); })
      .map(function (x) { return x.it; });
  }

  // Coarse signature of a rendered canvas (downsampled grid of average colors),
  // used to check that two wallpapers differ enough for OLED rotation.
  function canvasSignature(canvas, grid) {
    grid = grid || 8;
    var c = document.createElement('canvas');
    c.width = grid; c.height = grid;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, grid, grid);
    return ctx.getImageData(0, 0, grid, grid).data;
  }

  // Mean per-channel difference between two signatures (0..255).
  function signatureDistance(a, b) {
    if (!a || !b || a.length !== b.length) return 255;
    var sum = 0, n = 0;
    for (var i = 0; i < a.length; i += 4) {
      sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      n += 3;
    }
    return sum / n;
  }

  global.Palette = {
    analyze: analyze,
    sortKey: sortKey,
    compose: compose,
    canvasSignature: canvasSignature,
    signatureDistance: signatureDistance
  };
})(window);
