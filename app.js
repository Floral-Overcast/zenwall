/*
 * Zenwall app — wires the UI to the engine and the two sources.
 * No build step, no modules. Depends on globals: Zenwall, Arena.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var IMAGE_EXT = /\.(jpe?g|png|webp|bmp|gif|avif)$/i;
  var MAX_ARENA = 200;

  // ── State ──
  var state = {
    images: [],        // loaded HTMLImageElement[]
    objectUrls: [],    // to revoke on reload
    seed: (Math.random() * 0xffffffff) >>> 0,
    label: ''          // source name, for filenames
  };

  var canvas = $('canvas');

  // ── Resolution ──
  function targetSize() {
    var v = $('res').value;
    if (v === 'screen') {
      var dpr = window.devicePixelRatio || 1;
      return {
        w: Math.round(screen.width * dpr),
        h: Math.round(screen.height * dpr)
      };
    }
    if (v === 'custom') {
      return {
        w: Math.max(320, parseInt($('res-w').value, 10) || 1920),
        h: Math.max(320, parseInt($('res-h').value, 10) || 1080)
      };
    }
    var p = v.split('x');
    return { w: parseInt(p[0], 10), h: parseInt(p[1], 10) };
  }

  function opts(seed, extra) {
    var size = targetSize();
    var o = {
      width: size.w,
      height: size.h,
      cols: parseInt($('cols').value, 10),
      gap: parseInt($('gap').value, 10),
      bg: $('bg').value,
      arrange: $('arrange') ? $('arrange').value : 'color',
      seed: seed
    };
    if (extra) for (var k in extra) o[k] = extra[k];
    return o;
  }

  // ── Render ──
  function render() {
    if (!state.images.length) return;
    var res = Zenwall.render(canvas, state.images, opts(state.seed));
    $('stage-empty').classList.add('is-hidden');
    var size = targetSize();
    $('stage-meta').textContent =
      size.w + ' × ' + size.h + '  ·  ' + res.cols + '×' + res.rows + ' grid  ·  ' +
      res.placed + ' of ' + state.images.length + ' images placed  ·  seed ' + res.seed;
  }

  function reroll() {
    state.seed = (Math.random() * 0xffffffff) >>> 0;
    render();
  }

  function setReady(ready) {
    ['reroll', 'download', 'pack'].forEach(function (id) { $(id).disabled = !ready; });
  }

  // ── Image loading ──
  function loadImage(src, useCors) {
    return new Promise(function (resolve) {
      var img = new Image();
      if (useCors) img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  function busy(on, text) {
    $('stage-busy').classList.toggle('is-hidden', !on);
    if (text) $('busy-text').textContent = text;
  }

  function revokeUrls() {
    state.objectUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    state.objectUrls = [];
  }

  // Load a batch of sources (object URLs or remote URLs) into state.images.
  function ingest(sources, useCors, label) {
    busy(true, 'Loading images…');
    setReady(false);
    var loaded = [];
    var done = 0;
    return Promise.all(sources.map(function (src) {
      return loadImage(src, useCors).then(function (img) {
        done++;
        if (img && img.naturalWidth) {
          // Color signature, computed once, used for composed (color) ordering.
          if (window.Palette) img._col = window.Palette.analyze(img);
          loaded.push(img);
        }
        $('busy-text').textContent = 'Loading images… ' + done + '/' + sources.length;
      });
    })).then(function () {
      revokeUrls();
      state.images = loaded;
      state.label = label;
      busy(false);
      var status = $('source-status');
      if (!loaded.length) {
        status.textContent = 'None of those images could be loaded.';
        status.className = 'source-status is-error';
        return;
      }
      status.textContent = loaded.length + ' image' + (loaded.length === 1 ? '' : 's') + ' ready.';
      status.className = 'source-status is-ok';
      setReady(true);
      state.seed = (Math.random() * 0xffffffff) >>> 0;
      render();
    });
  }

  // ── Source: local folder ──
  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList).filter(function (f) {
      return IMAGE_EXT.test(f.name) || (f.type && f.type.indexOf('image/') === 0);
    });
    if (!files.length) {
      var s = $('source-status');
      s.textContent = 'No images found in that selection.';
      s.className = 'source-status is-error';
      return;
    }
    var urls = files.map(function (f) {
      var u = URL.createObjectURL(f);
      state.objectUrls.push(u);
      return u;
    });
    var label = files[0].webkitRelativePath
      ? files[0].webkitRelativePath.split('/')[0]
      : 'photos';
    ingest(urls, false, label);
  }

  // ── Source: are.na ──
  function loadArena(input) {
    var status = $('source-status');
    status.textContent = 'Fetching channel…';
    status.className = 'source-status';
    Arena.fetchChannel(input, {
      limit: MAX_ARENA,
      onPage: function (n) { status.textContent = 'Found ' + n + ' images…'; }
    }).then(function (result) {
      status.textContent = 'Loading ' + result.urls.length + ' images from “' + result.title + '”…';
      return ingest(result.urls, true, Arena.slugFromInput(input) || 'arena');
    }).catch(function (err) {
      status.textContent = err.message || 'Could not load that channel.';
      status.className = 'source-status is-error';
    });
  }

  // ── Export: single PNG ──
  function filename(seed) {
    var base = (state.label || 'zenwall').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
    return 'zenwall-' + base + '-' + seed + '.png';
  }

  function download() {
    var countEl = $('download-count');
    var n = Math.max(1, Math.min(50, parseInt(countEl && countEl.value, 10) || 1));
    if (n === 1) {
      canvas.toBlob(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename(state.seed);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      }, 'image/png');
      return;
    }
    downloadMany(n);
  }

  function downloadMany(count) {
    var statusEl = $('pack-status');
    var i = 0;
    var prevSig = null;
    function next() {
      if (i >= count) {
        statusEl.textContent = 'Saved ' + count + ' wallpapers to your downloads.';
        return;
      }
      i++;
      statusEl.textContent = 'Saving ' + i + '/' + count + '…';
      prevSig = renderPackFrame(i - 1, count, prevSig);
      canvasToBlob().then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'zenwall-' + String(i).padStart(2, '0') + '.png';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); next(); }, 250);
      });
    }
    next();
  }

  // ── Export: rotation pack (N distinct variants) ──
  var PACK_COUNT = 10;
  var PACK_MIN_DISTANCE = 14;  // min mean per-channel diff between consecutive frames

  function canvasToBlob() {
    return new Promise(function (resolve) {
      canvas.toBlob(function (b) { resolve(b); }, 'image/png');
    });
  }

  // Render one pack frame: rotate the palette so it differs from its neighbours,
  // and (in color mode) re-roll if it's still too close to the previous frame —
  // so the OLED gets something genuinely distinct on every flip.
  function renderPackFrame(i, count, prevSig) {
    var hueShift = (i / count) % 1;
    var sig = null;
    var attempts = 0;
    do {
      var seed = (Math.random() * 0xffffffff) >>> 0;
      Zenwall.render(canvas, state.images, opts(seed, { hueShift: hueShift }));
      sig = window.Palette ? window.Palette.canvasSignature(canvas, 8) : null;
      attempts++;
    } while (
      prevSig && sig &&
      window.Palette.signatureDistance(prevSig, sig) < PACK_MIN_DISTANCE &&
      attempts < 5
    );
    return sig;
  }

  function exportPack() {
    var statusEl = $('pack-status');
    if (window.showDirectoryPicker) {
      packToFolder(statusEl);
    } else {
      packAsDownloads(statusEl);
    }
  }

  // Chromium: write straight into a folder the user picks.
  function packToFolder(statusEl) {
    window.showDirectoryPicker({ mode: 'readwrite' }).then(function (dir) {
      var i = 0;
      var prevSig = null;
      function step() {
        if (i >= PACK_COUNT) {
          statusEl.textContent = 'Wrote ' + PACK_COUNT + ' wallpapers. Point your OS slideshow here.';
          render();
          return;
        }
        i++;
        statusEl.textContent = 'Rendering ' + i + '/' + PACK_COUNT + '…';
        prevSig = renderPackFrame(i - 1, PACK_COUNT, prevSig);
        canvasToBlob().then(function (blob) {
          return dir.getFileHandle('zenwall-' + String(i).padStart(2, '0') + '.png', { create: true })
            .then(function (fh) { return fh.createWritable(); })
            .then(function (w) { return w.write(blob).then(function () { return w.close(); }); });
        }).then(function () { setTimeout(step, 0); });
      }
      step();
    }).catch(function (err) {
      if (err && err.name === 'AbortError') { statusEl.textContent = ''; return; }
      statusEl.textContent = 'Could not write the pack.';
    });
  }

  // Firefox/Safari: fall back to sequential downloads.
  function packAsDownloads(statusEl) {
    var i = 0;
    var prevSig = null;
    function step() {
      if (i >= PACK_COUNT) {
        statusEl.textContent = 'Saved ' + PACK_COUNT + ' wallpapers to your downloads.';
        render();
        return;
      }
      i++;
      statusEl.textContent = 'Saving ' + i + '/' + PACK_COUNT + '…';
      prevSig = renderPackFrame(i - 1, PACK_COUNT, prevSig);
      canvasToBlob().then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'zenwall-' + String(i).padStart(2, '0') + '.png';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); step(); }, 350);
      });
    }
    step();
  }

  // ── Wire up ──
  function init() {
    // Tabs
    function selectTab(which) {
      var photos = which === 'photos';
      $('tab-photos').classList.toggle('is-active', photos);
      $('tab-arena').classList.toggle('is-active', !photos);
      $('tab-photos').setAttribute('aria-selected', photos);
      $('tab-arena').setAttribute('aria-selected', !photos);
      $('panel-photos').classList.toggle('is-hidden', !photos);
      $('panel-arena').classList.toggle('is-hidden', photos);
    }
    $('tab-photos').addEventListener('click', function () { selectTab('photos'); });
    $('tab-arena').addEventListener('click', function () { selectTab('arena'); });

    // Folder input
    $('folder-input').addEventListener('change', function (e) { handleFiles(e.target.files); });

    // Drag & drop
    var dz = $('dropzone');
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('is-drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('is-drag'); });
    });
    dz.addEventListener('drop', function (e) {
      if (!e.dataTransfer) return;
      var items = e.dataTransfer.items;
      var hasEntries = items && items.length && typeof items[0].webkitGetAsEntry === 'function';
      if (hasEntries) {
        var entries = [];
        for (var i = 0; i < items.length; i++) {
          var ent = items[i].webkitGetAsEntry();
          if (ent) entries.push(ent);
        }
        collectEntryFiles(entries).then(function (files) {
          if (files.length) handleFiles(files);
          else if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
        });
      } else if (e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
      }
    });

    function collectEntryFiles(entries) {
      var out = [];
      function walk(entry) {
        return new Promise(function (resolve) {
          if (entry.isFile) {
            entry.file(function (f) { out.push(f); resolve(); }, function () { resolve(); });
          } else if (entry.isDirectory) {
            var reader = entry.createReader();
            var all = [];
            (function readBatch() {
              reader.readEntries(function (batch) {
                if (!batch.length) {
                  Promise.all(all.map(walk)).then(function () { resolve(); });
                } else {
                  all = all.concat(batch);
                  readBatch();
                }
              }, function () { resolve(); });
            })();
          } else {
            resolve();
          }
        });
      }
      return Promise.all(entries.map(walk)).then(function () { return out; });
    }

    // are.na
    $('arena-load').addEventListener('click', function () {
      var v = $('arena-url').value.trim();
      if (v) loadArena(v);
    });
    $('arena-url').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('arena-load').click();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) {
      c.addEventListener('click', function () {
        $('arena-url').value = c.getAttribute('data-arena');
        loadArena(c.getAttribute('data-arena'));
      });
    });

    // Controls
    $('cols').addEventListener('input', function () {
      $('cols-val').textContent = $('cols').value;
      render();
    });
    $('gap').addEventListener('input', function () {
      $('gap-val').textContent = $('gap').value + 'px';
      render();
    });
    $('bg').addEventListener('change', render);
    $('arrange').addEventListener('change', render);
    $('res').addEventListener('change', function () {
      $('custom-res').classList.toggle('is-hidden', $('res').value !== 'custom');
      render();
    });
    $('res-w').addEventListener('input', render);
    $('res-h').addEventListener('input', render);

    // Actions
    $('reroll').addEventListener('click', reroll);
    $('download').addEventListener('click', download);
    $('pack').addEventListener('click', exportPack);

    // OLED dialog
    var dlg = $('oled-dialog');
    $('oled-info').addEventListener('click', function () { dlg.showModal(); });
    $('oled-close').addEventListener('click', function () { dlg.close(); });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
