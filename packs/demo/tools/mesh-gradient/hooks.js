/* global host */
/**
 * Mesh Gradient hooks.
 *
 * Builds the whole SVG as a string (qr-code pattern) — stacked radial
 * gradients over a base fill, with optional blur/grain via an SVG filter and
 * optional CSS-keyframe drift for video exports. Gradients use
 * gradientUnits="userSpaceOnUse" so the template script can move a point live
 * during a drag by setting cx/cy on its <radialGradient>, and drift animates
 * the wrapping <g> (a CSS transform on the group carries the gradient with it
 * — the frame-by-frame video capture reads computed styles, so CSS keyframes
 * are the one animation mechanism that survives export; SMIL freezes at t=0).
 */

var VBW = 1600;
var VBH = 900;

// Brand-agnostic fallbacks for when a semantic token alias doesn't resolve
// (an unresolved alias flattens to '') — one per colour slot.
var FALLBACK = ['#6d5bd8', '#e0679f', '#2fb6a3', '#f6f1e7', '#f2a65a', '#5b8def'];
var DEF_POS = [[14, 20], [85, 18], [80, 82], [18, 78], [52, 10], [50, 88]];

// Drift = one closed orbit per blob, passing through its set position.
// Everything derives deterministically from the blob index (golden-angle
// rotation, alternating spin, 3–10% amplitude) — no Math.random, so the memo
// key stays honest and video restarts / URL renders land identical poses.
var GOLDEN = 137.508;

// mix-blend-mode whitelist for the colour blobs (the "blend" select).
var BLOB_BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light', 'lighten', 'darken', 'luminosity'];

function _num(v, d) { var n = Number(v); return Number.isFinite(n) ? n : d; }
function _clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

// Colour values land raw inside the SVG string (and can arrive via URL
// params), so allow only colour-function characters — never markup.
function _safeColor(v, fb) {
  v = (v == null ? '' : String(v)).trim();
  return v && /^[#a-zA-Z0-9(),.%\s\/-]+$/.test(v) ? v : fb;
}

// A vector input's value is an { x, y } object everywhere (URL mode uses
// per-field params — pos1.x= / pos1.y= — never a packed string).
function _pos(v, d) {
  var x = d[0], y = d[1];
  if (v && typeof v === 'object') { x = _num(v.x, x); y = _num(v.y, y); }
  return { x: _clamp(x, 0, 100), y: _clamp(y, 0, 100) };
}

function _filterDef(blur, grain, blend) {
  if (!(blur > 0) && !(grain > 0)) return '';
  var f = '<filter id="mg-f" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">';
  var base = 'SourceGraphic';
  if (blur > 0) {
    f += '<feGaussianBlur in="SourceGraphic" stdDeviation="' + (blur * 3) + '" result="mgb"/>';
    base = 'mgb';
  }
  if (grain > 0) {
    f += '<feTurbulence type="fractalNoise" baseFrequency="0.66" numOctaves="2" seed="7" stitchTiles="stitch" result="mgn0"/>'
      + '<feColorMatrix in="mgn0" type="saturate" values="0" result="mgn1"/>'
      + '<feComponentTransfer in="mgn1" result="mgn2"><feFuncA type="linear" slope="' + (grain / 100 * 0.55).toFixed(3) + '" intercept="0"/></feComponentTransfer>'
      + '<feBlend in="mgn2" in2="' + base + '" mode="' + blend + '"/>';
  }
  return f + '</filter>';
}

function _animCss(count, speed, distancePct) {
  var css = '';
  var STEPS = 8; // waypoints per orbit — smooth with linear timing
  var distanceScale = distancePct / 100;
  for (var i = 0; i < count; i++) {
    // Orbit rotated by the golden angle so no two blobs ever drift the same
    // way; alternating spin direction; amplitude (max displacement, = the
    // orbit diameter) spans 3–10% of the frame per blob at the default 100%
    // float distance — the "distance" input scales that range up or down.
    var theta = (i * GOLDEN + 23) * Math.PI / 180;
    var ampPct = (3 + ((i * 53) % 71) / 10) * distanceScale;
    var dir = i % 2 === 0 ? 1 : -1;
    var rx = ampPct / 200 * VBW;
    var ry = ampPct / 200 * VBH;
    var ox = rx * Math.cos(theta), oy = ry * Math.sin(theta); // orbit centre
    var frames = '';
    for (var s = 0; s <= STEPS; s++) {
      var t = s / STEPS;
      // Phase chosen so t=0 sits exactly on the set position (translate 0,0)
      // — static exports freeze there and restarts are clean.
      var a = theta + Math.PI + dir * 2 * Math.PI * t;
      frames += (t * 100).toFixed(1) + '%{transform:translate('
        + (ox + rx * Math.cos(a)).toFixed(1) + 'px,' + (oy + ry * Math.sin(a)).toFixed(1) + 'px)}';
    }
    css += '@keyframes mg-d' + (i + 1) + '{' + frames + '}';
    // Linear timing = constant orbital speed (continuous float, not
    // ease pulses); negative delays desync the blobs while keeping one
    // seamless loop of `speed` seconds — and stop every blob crossing its
    // set position at the same instant.
    css += '.mg-blob-' + (i + 1) + '{animation:mg-d' + (i + 1) + ' ' + speed + 's linear infinite;'
      + 'animation-delay:' + (-(speed * i) / count).toFixed(2) + 's}';
  }
  css += '.mg-frozen .mg-blob{animation:none!important}';
  // Reduce-motion calms the LIVE canvas only; an explicit webm/mp4 export
  // still animates (beforeExport adds .mg-export for the capture window) —
  // otherwise those users would silently get an all-identical-frames video.
  css += '@media (prefers-reduced-motion:reduce){svg.mg-svg:not(.mg-export) .mg-blob{animation:none}}';
  return '<style>' + css + '</style>';
}

// Module state beforeExport/afterExport need: whether the current render
// drifts and its loop length (mirrors digi-ad's _animated/_totalDuration).
var _animate = false;
var _speed = 12;
var _distance = 100;

var _memoKey = null;
var _memoResult = null;

function compute(model) {
  var a = Object.fromEntries(model.map(function (i) { return [i.id, i.value]; }));

  var count = _clamp(Math.round(_num(a.count, 5)), 2, 6); // fallback = the manifest default; clamp ceiling = the declared color1–6/pos1–6 inputs
  var pts = [];
  for (var i = 0; i < count; i++) {
    var p = _pos(a['pos' + (i + 1)], DEF_POS[i]);
    pts.push({ color: _safeColor(a['color' + (i + 1)], FALLBACK[i]), x: p.x, y: p.y });
  }
  var spread = _clamp(_num(a.spread, 75), 30, 140);
  var blur = _clamp(_num(a.blur, 0), 0, 40);
  var grain = _clamp(_num(a.grain, 0), 0, 100);
  var blend = ['soft-light', 'overlay', 'luminosity'].indexOf(a.grainBlend) >= 0 ? a.grainBlend : 'soft-light';
  var blobBlend = BLOB_BLENDS.indexOf(a.blend) >= 0 ? a.blend : 'normal';
  _animate = Boolean(a.animate);
  _speed = _clamp(Math.round(_num(a.speed, 12)), 4, 24);
  _distance = _clamp(Math.round(_num(a.distance, 100)), 0, 200);

  var key = JSON.stringify([pts, spread, blur, grain, blend, blobBlend, _animate, _speed, _distance]);
  if (key === _memoKey) return _memoResult;

  var R = spread / 100 * VBH;
  var defs = '<defs>';
  var blobs = [];
  pts.forEach(function (pt, idx) {
    var n = idx + 1;
    defs += '<radialGradient id="mg-g' + n + '" gradientUnits="userSpaceOnUse"'
      + ' cx="' + (pt.x * VBW / 100).toFixed(1) + '" cy="' + (pt.y * VBH / 100).toFixed(1) + '" r="' + R.toFixed(1) + '">'
      + '<stop offset="0" stop-color="' + pt.color + '"/>'
      + '<stop offset="0.5" stop-color="' + pt.color + '" stop-opacity="0.55"/>'
      + '<stop offset="1" stop-color="' + pt.color + '" stop-opacity="0"/>'
      + '</radialGradient>';
    blobs.push('<g class="mg-blob mg-blob-' + n + '"' + (blobBlend !== 'normal' ? ' style="mix-blend-mode:' + blobBlend + '"' : '') + '>'
      + '<rect x="-400" y="-500" width="2400" height="1900" fill="url(#mg-g' + n + ')"/></g>');
  });
  // Blob 1 paints LAST: over the opaque colour-1 base it would otherwise be a
  // pixel-perfect no-op (colour over itself), leaving pos1 a dead control.
  // On top it re-asserts the base colour into the mix, so dot 1 means something.
  var body = blobs.slice(1).join('') + blobs[0];
  var filter = _filterDef(blur, grain, blend);
  defs += filter + '</defs>';

  // Rects overscan the viewBox so drift and blur never pull in bare edges;
  // preserveAspectRatio="none" keeps every point visible at any export size.
  var svg = '<svg class="mg-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + VBW + ' ' + VBH + '"'
    + ' width="100%" height="100%" preserveAspectRatio="none">'
    + (_animate ? _animCss(count, _speed, _distance) : '')
    + defs
    + '<g' + (filter ? ' filter="url(#mg-f)"' : '') + '>'
    + '<rect x="-400" y="-500" width="2400" height="1900" fill="' + pts[0].color + '"/>'
    + body
    + '</g></svg>';

  _memoKey = key;
  _memoResult = {
    svgContent: svg,
    dotsJson: JSON.stringify(pts.map(function (pt) { return { x: pt.x, y: pt.y, color: pt.color }; })),
  };
  return _memoResult;
}

// Brand palette for the canvas "shuffle colours" button — the same swatch set
// the colour picker offers (host.tokens.colors()), fetched once. The shuffle
// itself writes concrete hex values into the colour inputs, so a shuffled
// state stays deterministic / URL-expressible.
var _paletteJson = JSON.stringify(FALLBACK);
var _paletteLoaded = false;

async function _loadPalette(h) {
  if (_paletteLoaded) return;
  _paletteLoaded = true;
  try {
    if (h && h.tokens && h.tokens.colors) {
      var sw = await h.tokens.colors();
      var hex = [];
      (sw || []).forEach(function (s) {
        var v = String((s && s.value) || '').trim().toLowerCase();
        if (/^#[0-9a-f]{6}$/.test(v) && hex.indexOf(v) < 0) hex.push(v);
      });
      if (hex.length >= 2) _paletteJson = JSON.stringify(hex.slice(0, 32));
    }
  } catch (e) { /* keep the literal fallback palette */ }
}

async function onInit(ctx) {
  await _loadPalette((ctx && ctx.host) || (typeof host !== 'undefined' ? host : null));
  return Object.assign({}, compute(ctx.model), { paletteJson: _paletteJson });
}
function onInput(ctx) {
  return Object.assign({}, compute(ctx.model), { paletteJson: _paletteJson });
}

// Video formats play the drift; every other format freezes the base pose so a
// mid-loop transform never bakes into a "static" SVG/PNG.
var ANIMATED_FORMATS = { webm: 1, mp4: 1 };
var _exportSvg = null;

function beforeExport(ctx) {
  var node = ctx.node;
  if (!_animate || !node || !node.querySelector) return;
  var svg = node.querySelector('svg.mg-svg');
  if (!svg) return;
  _exportSvg = svg;
  if (ANIMATED_FORMATS[ctx.format]) {
    // .mg-export lets the drift run during capture even under
    // prefers-reduced-motion (an explicit video export should move), then a
    // deterministic restart at t=0 (freeze → reflow → unfreeze) so the clip
    // opens at the loop origin. 595 = the bridge's fps-aware frame ceiling
    // (digi-ad precedent).
    svg.classList.add('mg-export');
    svg.classList.add('mg-frozen'); void node.offsetWidth;
    svg.classList.remove('mg-frozen'); void node.offsetWidth;
    ctx.opts.wait = 0;
    var fps = ctx.opts.fps > 0 ? ctx.opts.fps : 24;
    var cap = Math.floor(595 / fps);
    ctx.opts.duration = Math.min(_speed, cap);
    if (cap < _speed && typeof host !== 'undefined' && host && host.log) {
      // Frame budget can't fit a whole loop at this fps — say so instead of
      // silently shipping a clip that pops at the seam.
      try {
        (host.log.warn || host.log.info || function () {}).call(
          host.log,
          '[mesh-gradient] ' + _speed + 's loop shortened to ' + cap + 's at ' + fps + ' fps (frame budget) — the loop seam will jump; lower the fps or the loop length for a seamless clip.'
        );
      } catch (e) { /* logging must never break an export */ }
    }
  } else {
    svg.classList.add('mg-frozen');
  }
}

function afterExport() {
  if (_exportSvg) {
    _exportSvg.classList.remove('mg-frozen');
    _exportSvg.classList.remove('mg-export');
    _exportSvg = null;
  }
}
