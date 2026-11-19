#!/usr/bin/env node
/*
 * Command-line HeyTea sticker drawer. Loads an image, runs the same engine as the web page
 * (engine.js: auto-match, stroke planning, ADB script), then writes a PNG preview and/or draws
 * the strokes on a phone over ADB.
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var util = require('util');
var readline = require('readline');

var E = require('../engine.js').StickerEngine;
var VERSION = require('../package.json').version;

/* ---------- settings: CLI flag -> engine key ---------- */

// drawing settings (engine P). `web` is the matching label on the web page.
var DRAW = [
  { flag: 'mode', short: 'm', key: 'mode', type: 'mode', web: 'Style', help: 'drawing style (see --list-styles)', def: 'pixel-sweep' },
  { flag: 'fit', key: 'fit', type: ['cover', 'contain'], web: 'Image fit', help: 'cover = fill the canvas, contain = fit inside' },
  { flag: 'shape', key: 'shape', type: ['rect', 'circle'], web: 'Sticker shape', help: 'rect or circle' },
  { flag: 'brightness', key: 'br', type: 'num', min: -100, max: 100, web: 'Brightness', help: '-100..100' },
  { flag: 'contrast', key: 'co', type: 'num', min: -100, max: 100, web: 'Contrast', help: '-100..100' },
  { flag: 'midtones', key: 'gm', type: 'num', min: 40, max: 250, web: 'Midtones', help: '40..250, higher lifts the shadows' },
  { flag: 'local-contrast', key: 'lc', type: 'num', min: 0, max: 100, web: 'Local contrast', help: '0..100 (CLAHE)' },
  { flag: 'cutoff', key: 'thr', type: 'num', min: 20, max: 235, web: 'Darkness cutoff', help: '20..235, two-tone and line styles' },
  { flag: 'passes', key: 'ps', type: 'num', min: 0, max: 30, web: 'Passes', help: '0..30 brush/eraser rounds, 0 = until it stops helping' },
  { flag: 'tiles', key: 'tn', type: 'num', min: 1, max: 12, web: 'Tiles per side', help: '1..12, drawn tile by tile from the top left' },
  { flag: 'smoothing', key: 'sm', type: 'num', min: 0, max: 4, web: 'Smoothing', help: '0..4 blur before drawing' },
  { flag: 'invert', key: 'inv', type: 'bool', web: 'Invert', help: 'swap ink and paper' }
];
// phone settings (engine Ph)
var PHONE = [
  { flag: 'brush', key: 'pen', type: 'num', min: 1, max: 100, web: 'Brush size (px)', help: 'brush size on the phone in px' },
  { flag: 'eraser', key: 'esz', type: 'num', min: 1, max: 100, web: 'Eraser size (px)', help: 'eraser size on the phone in px' },
  { flag: 'canvas', key: ['rx', 'ry', 'rw', 'rh'], type: 'list', n: 4, arg: 'L,T,W,H|auto', def: 'auto for draw and test, else 100,600,880,880', web: 'Left, Top, Width, Height', help: 'the sticker canvas on screen in px, or auto: find it on a phone screenshot' },
  { flag: 'method', key: 'method', type: { swipe: 'sw', continuous: 'mo', fast: 'fe' }, web: 'How the pen moves', help: 'swipe (any Android), continuous (Android 10+), fast (sendevent)' },
  { flag: 'swipe-ms', key: 'dur', type: 'num', min: 1, max: 5000, web: 'Swipe time (ms)', help: 'time per swipe segment, swipe method' },
  { flag: 'eraser-button', key: ['ex', 'ey'], type: 'list', n: 2, web: 'Eraser X, Y', def: 'found with the canvas, else 0,0 = switch by hand', help: 'X,Y of the eraser button' },
  { flag: 'pen-button', key: ['tx', 'ty'], type: 'list', n: 2, web: 'Pen X, Y', def: 'found with the canvas', help: 'X,Y of the pen button' },
  { flag: 'eraser-taps', key: 'ex2', type: 'str', web: 'Extra taps after eraser', help: '"x,y; x,y" extra taps after picking the eraser' },
  { flag: 'pen-taps', key: 'tx2', type: 'str', web: 'Extra taps after pen', help: '"x,y; x,y" extra taps after picking the pen' },
  { flag: 'switch-wait', key: 'sd', type: 'num', min: 0, max: 60, web: 'Wait after switching (s)', help: 'seconds to wait after a tool switch' },
  { flag: 'press-ms', key: 'pt', type: 'num', min: 0, max: 5000, web: 'Button press (ms)', help: 'press length on tool buttons, 0 = tap' },
  { flag: 'touch-device', key: 'tdev', type: 'str', web: 'Touch device', help: 'fast method: touchscreen device, from getevent -lp' },
  { flag: 'touch-max', key: ['mx', 'my'], type: 'list', n: 2, web: 'Raw max X, Y', help: 'fast method: raw touch range MAX_X,MAX_Y' },
  { flag: 'screen', key: ['scw', 'sch'], type: 'list', n: 2, arg: 'W,H', web: 'Screen width, height', help: 'fast method: screen size WIDTH,HEIGHT in px' },
  { flag: 'combine-events', key: 'mc', type: 'bool', web: 'Combine events', help: 'fast method: one sendevent call per event' }
];
var ALL = DRAW.concat(PHONE);

var STYLE_SLUG = {};
E.STYLES.forEach(function (s) { STYLE_SLUG[s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')] = s.id; });
function styleName(id) { for (var i = 0; i < E.STYLES.length; i++) if (E.STYLES[i].id === id) return E.STYLES[i].name; return id; }
function styleSlug(id) { for (var k in STYLE_SLUG) if (STYLE_SLUG[k] === id) return k; return id; }

/* ---------- output ---------- */

var quiet = false;
function log(s) { if (!quiet) process.stderr.write(s + '\n'); }
function fail(msg, code) { process.stderr.write('heytea-sticker: ' + msg + '\n'); process.exit(code || 1); }
function fmtN(n) { return Math.round(n).toLocaleString('en-US'); }
function fmtTime(sec) { var m = sec / 60; return m < 1.5 ? Math.round(sec) + ' s' : m < 90 ? Math.round(m) + ' min' : (m / 60).toFixed(1) + ' h'; }

var HELP = [
  'heytea-sticker ' + VERSION + ': turn a picture into a HeyTea sticker drawing and draw it over ADB.',
  '',
  'Usage:',
  '  heytea-sticker preview <image> [options]   plan the strokes, write a PNG preview, report the count',
  '  heytea-sticker draw <image> [options]      plan, then draw on the connected phone over ADB',
  '  heytea-sticker script <image> [options]    plan, then write the ADB shell script (draw.sh)',
  '  heytea-sticker test [options]              draw the tool-switch test on the phone',
  '  heytea-sticker detect [screenshot]         find the sticker canvas on the phone screen (or a screenshot)',
  '  heytea-sticker devices                     list ADB devices',
  '',
  'By default the tone settings are auto-matched, exactly like the web page: the pixel sweep is drawn',
  'over and over and scored against the image. Any drawing setting you pass is applied on top of the',
  'match. Pass --no-match to skip the search and use the engine defaults plus your settings.',
  '',
  'Drawing settings:'
].concat(DRAW.map(optLine), [
  '  --no-match                  skip auto-match',
  '  --set KEY=VALUE             any other engine setting, e.g. --set sen=70 (repeatable)',
  '',
  'Phone settings (same fields as step 03 of the web page):'
], PHONE.map(optLine), [
  '',
  'Output:',
  '  -o, --out FILE              preview PNG (preview: default <image>.sticker.png) or script (script:',
  '                              default draw.sh); for draw, also save a preview PNG here; for detect,',
  '                              the screenshot with the canvas outlined',
  '  --script FILE               also save the ADB script here (preview, draw)',
  '  --json                      print the result as JSON on stdout',
  '  -q, --quiet                 no progress output',
  '',
  'ADB:',
  '  --adb PATH                  adb executable (default: $ADB, then adb on PATH)',
  '  -s, --serial SERIAL         device to use when more than one is connected ($ANDROID_SERIAL works too)',
  '  --screenshot FILE           find the canvas on this screenshot instead of the phone screen',
  '  -y, --yes                   start drawing without waiting for Enter',
  '',
  '  --list-styles               list the drawing styles',
  '  -h, --help                  show this help',
  '  -v, --version               show the version',
  '',
  'Examples:',
  '  heytea-sticker preview photo.jpg',
  '  heytea-sticker preview photo.jpg --tiles 6 --passes 8 -o out.png',
  '  heytea-sticker detect -o screen.png',
  '  heytea-sticker draw photo.jpg',
  '  heytea-sticker draw photo.jpg --canvas 213,509,1015,1428 --eraser-button 879,2657 --pen-button 561,2657',
  '  heytea-sticker draw photo.jpg --no-match --brightness 10 --contrast -20 --midtones 130',
  ''
]).join('\n');

function optLine(o) {
  var a = '  ' + (o.short ? '-' + o.short + ', ' : '') + '--' + o.flag + (o.type === 'bool' ? '' : ' ' + argName(o));
  var def = o.def !== undefined ? o.def : defaultText(o);
  return pad(a, 30) + o.help + (def !== '' ? ' [' + def + ']' : '');
}
function argName(o) {
  if (Array.isArray(o.type)) return o.type.join('|');
  if (o.type && typeof o.type === 'object') return Object.keys(o.type).join('|');
  if (o.arg) return o.arg;
  if (o.type === 'list') return o.n === 4 ? 'L,T,W,H' : 'X,Y';
  return o.type === 'num' ? 'N' : o.type === 'mode' ? 'STYLE' : 'TEXT';
}
function defaultText(o) {
  var src = DRAW.indexOf(o) >= 0 ? E.DEFAULTS : E.PHONE_DEFAULTS;
  if (Array.isArray(o.key)) return o.key.map(function (k) { return src[k]; }).join(',');
  var v = src[o.key];
  if (o.type === 'bool') return '';
  if (o.type && typeof o.type === 'object' && !Array.isArray(o.type)) for (var k in o.type) if (o.type[k] === v) return k;
  if (DRAW.indexOf(o) >= 0 && ['br', 'co', 'gm', 'ps'].indexOf(o.key) >= 0) return 'auto';
  return v === '' ? '' : String(v);
}
function pad(s, n) { return s.length >= n - 1 ? s + '\n' + new Array(n + 1).join(' ') : s + new Array(n - s.length + 1).join(' '); }

/* ---------- arguments ---------- */

function parse(argv) {
  var options = {
    'no-match': { type: 'boolean' }, set: { type: 'string', multiple: true },
    out: { type: 'string', short: 'o' }, script: { type: 'string' }, json: { type: 'boolean' }, quiet: { type: 'boolean', short: 'q' },
    adb: { type: 'string' }, screenshot: { type: 'string' }, serial: { type: 'string', short: 's' }, yes: { type: 'boolean', short: 'y' },
    'list-styles': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }
  };
  ALL.forEach(function (o) { options[o.flag] = { type: o.type === 'bool' ? 'boolean' : 'string' }; if (o.short) options[o.flag].short = o.short; });
  // "--contrast -30": a negative number is the flag's value, not another option
  var args = [];
  for (var i = 0; i < argv.length; i++) {
    var f = /^--([a-z-]+)$/.exec(argv[i]);
    if (f && options[f[1]] && options[f[1]].type === 'string' && /^-\d/.test(argv[i + 1] || '')) args.push(argv[i] + '=' + argv[++i]);
    else args.push(argv[i]);
  }
  try { return util.parseArgs({ args: args, options: options, allowPositionals: true }); }
  catch (e) { fail(e.message.replace(/\. To specify.*$/, '') + '\nRun heytea-sticker --help for the options.', 2); }
}

function num(o, s) {
  var v = Number(s);
  if (s === '' || !isFinite(v)) fail('--' + o.flag + ' needs a number, got "' + s + '"', 2);
  if (o.min !== undefined && (v < o.min || v > o.max)) fail('--' + o.flag + ' must be between ' + o.min + ' and ' + o.max + ', got ' + v, 2);
  return v;
}
// apply the flags in `vals` for the given list of settings onto target
function apply(list, vals, target) {
  list.forEach(function (o) {
    var s = vals[o.flag];
    if (s === undefined) return;
    if (o.type === 'bool') target[o.key] = !!s;
    else if (o.type === 'num') target[o.key] = num(o, s);
    else if (o.type === 'str') target[o.key] = s;
    else if (o.type === 'mode') target.mode = parseMode(s);
    else if (o.type === 'list') {
      var parts = String(s).split(/[ ,x]+/).filter(Boolean).map(Number);
      if (parts.length !== o.n || parts.some(function (v) { return !isFinite(v); })) fail('--' + o.flag + ' needs ' + o.n + ' comma-separated numbers (' + argName(o) + '), got "' + s + '"', 2);
      o.key.forEach(function (k, i) { target[k] = parts[i]; });
    } else if (Array.isArray(o.type)) {
      if (o.type.indexOf(s) < 0) fail('--' + o.flag + ' must be one of ' + o.type.join(', ') + ', got "' + s + '"', 2);
      target[o.key] = s;
    } else {
      if (!(s in o.type)) fail('--' + o.flag + ' must be one of ' + Object.keys(o.type).join(', ') + ', got "' + s + '"', 2);
      target[o.key] = o.type[s];
    }
  });
}
function parseMode(s) {
  var k = String(s).toLowerCase();
  if (STYLE_SLUG[k]) return STYLE_SLUG[k];
  for (var i = 0; i < E.STYLES.length; i++) if (E.STYLES[i].id === k) return k;
  fail('unknown style "' + s + '". Styles: ' + Object.keys(STYLE_SLUG).join(', '), 2);
}
function applySet(list, P) {
  (list || []).forEach(function (kv) {
    var m = /^([a-z0-9]+)=(.*)$/i.exec(kv);
    if (!m || !(m[1] in E.DEFAULTS)) fail('--set needs KEY=VALUE with an engine setting (' + Object.keys(E.DEFAULTS).join(', ') + '), got "' + kv + '"', 2);
    var d = E.DEFAULTS[m[1]], v = m[2];
    P[m[1]] = typeof d === 'number' ? Number(v) : typeof d === 'boolean' ? /^(1|true|yes|on)$/i.test(v) : v;
    if (typeof d === 'number' && !isFinite(P[m[1]])) fail('--set ' + m[1] + ' needs a number, got "' + v + '"', 2);
  });
}

/* ---------- canvas (Node) ---------- */

var canvasLib = null;
function canvas() {
  if (canvasLib) return canvasLib;
  try { canvasLib = require('@napi-rs/canvas'); }
  catch (e) { fail('the image library is missing. Run "npm install" in ' + path.resolve(__dirname, '..') + ' first.\n(' + e.message.split('\n')[0] + ')'); }
  return canvasLib;
}
function makeCanvas(w, h) { return canvas().createCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h))); }
function loadImage(file) {
  if (!fs.existsSync(file)) fail('no such image: ' + file, 2);
  return canvas().loadImage(fs.readFileSync(file)).catch(function (e) { fail('could not read ' + file + ' as an image (' + e.message + ')', 2); });
}

/* ---------- planning: the same steps as worker.js ---------- */

function settingsFor(vals) {
  var Ph = E.copy(E.PHONE_DEFAULTS);
  apply(PHONE, vals, Ph);
  var P = E.withDefaults({});
  // the phone's canvas size and tool sizes are the drawing's physical size, as on the web page
  P.rw = +Ph.rw; P.rh = +Ph.rh; P.pen = +Ph.pen; P.esz = +Ph.esz;
  var given = {};
  apply(DRAW, vals, given);
  applySet(vals.set, given);
  // fit, shape and style decide what the search tunes, so they go in before it
  ['mode', 'fit', 'shape'].forEach(function (k) { if (given[k] !== undefined) P[k] = given[k]; });
  return { P: P, Ph: Ph, given: given };
}

function autoMatch(img, P) {
  var t0 = Date.now(), tty = process.stderr.isTTY && !quiet, last = -1, step = 0;
  log('Auto-matching ' + styleName(P.mode) + ' to the image (this takes a little while)…');
  var r = E.autoMatch(img, P, {
    makeCanvas: makeCanvas, modes: [P.mode],
    onProgress: function (pct) {
      if (pct === last) return;
      last = pct;
      if (tty) process.stderr.write('\r  matching ' + pct + '%   ');
      else if (!quiet && pct >= step + 25) { step = pct - pct % 25; log('  matching ' + step + '%'); }
    }
  });
  if (tty) process.stderr.write('\r');
  log('  matched in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s: ' + Math.round(r.match) + '% match');
  var keep = { rw: P.rw, rh: P.rh, pen: P.pen, esz: P.esz, shape: P.shape, fit: P.fit, tn: P.tn };
  var Q = E.withDefaults(r.P);
  for (var k in keep) Q[k] = keep[k];
  return Q;
}

function planFor(img, P) {
  var G = E.grid(P), base = E.luminance(img, G.W, G.H, P.fit, makeCanvas);
  var g = E.adjust(base, G.W, G.H, P), r = E.plan(g, G.W, G.H, P);
  var ink = E.rasterize(r.strokes, G.W, G.H, P, makeCanvas, 2);
  var sc = E.compare(ink, E.inkTarget(base, G.W, G.H, P), G.W, G.H, P);
  if (P.auto) { P.gap = r.gap[0]; P.gap2 = r.gap[1]; }
  return { W: G.W, H: G.H, strokes: r.strokes, match: sc.match };
}

// the drawing as the phone will show it, at the canvas size in phone px (like the web preview)
function renderPNG(res, P, file) {
  var sc = Math.max(1, P.rw) / res.W, c = makeCanvas(res.W * sc, res.H * sc), x = c.getContext('2d'), cur = -1;
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.lineCap = x.lineJoin = 'round';
  x.beginPath();
  res.strokes.forEach(function (p) {
    var er = p.er ? 1 : 0;
    if (er !== cur) {
      if (cur !== -1) { x.stroke(); x.beginPath(); }
      x.strokeStyle = er ? '#fff' : '#111';
      x.lineWidth = E.px(P, res.W, er ? P.esz : P.pen) * sc;
      cur = er;
    }
    x.moveTo((p[0][0] + 0.5) * sc, (p[0][1] + 0.5) * sc);
    for (var j = 1; j < p.length; j++) x.lineTo((p[j][0] + 0.5) * sc, (p[j][1] + 0.5) * sc);
  });
  if (cur !== -1) x.stroke();
  fs.writeFileSync(file, c.toBuffer('image/png'));
}

// the flags that reproduce this drawing without the search
function replayFlags(P) {
  var out = ['--no-match', '--mode ' + styleSlug(P.mode)];
  DRAW.forEach(function (o) {
    if (o.key === 'mode' || o.type === 'bool') { if (o.type === 'bool' && P[o.key]) out.push('--' + o.flag); return; }
    if (P[o.key] !== E.DEFAULTS[o.key]) out.push('--' + o.flag + ' ' + P[o.key]);
  });
  return out.join(' ');
}

function summary(res, P, Ph, scriptText) {
  var est = E.estimate(scriptText), sw = 0, last = 0;
  res.strokes.forEach(function (p) { var e = p.er ? 1 : 0; if (e !== last) { sw++; last = e; } });
  return {
    style: styleName(P.mode), match: Math.round(res.match), strokes: res.strokes.length, toolSwitches: sw,
    seconds: Math.round(est.sec), commands: est.calls, grid: [res.W, res.H],
    settings: { mode: P.mode, br: P.br, co: P.co, gm: P.gm, lc: P.lc, thr: P.thr, ps: P.ps, tn: P.tn, fit: P.fit, shape: P.shape, pen: P.pen, esz: P.esz },
    canvas: [Ph.rx, Ph.ry, Ph.rw, Ph.rh], method: Ph.method,
    flags: replayFlags(P)
  };
}
function report(s, json) {
  if (json) { process.stdout.write(JSON.stringify(s, null, 2) + '\n'); return; }
  log(s.style + ' · ' + s.match + '% match');
  log(fmtN(s.strokes) + ' strokes · ' + s.toolSwitches + ' tool switches · about ' + fmtTime(s.seconds) + ' on the phone (' + fmtN(s.commands) + ' commands, rough estimate)');
  log('settings: ' + s.flags);
}

/* ---------- ADB ---------- */

function adbPath(vals) { return vals.adb || process.env.ADB || 'adb'; }
function runAdb(bin, args, opts) {
  var r = cp.spawnSync(bin, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  if (r.error && r.error.code === 'ENOENT') {
    fail('adb was not found' + (bin === 'adb' ? ' on PATH' : ' at ' + bin) + '.\n' +
      'Install Android SDK Platform-Tools (https://developer.android.com/tools/releases/platform-tools),\n' +
      'then put adb on PATH, set ADB=/path/to/adb, or pass --adb /path/to/adb.');
  }
  if (r.error) fail('could not run adb: ' + r.error.message);
  return r;
}
function devices(bin) {
  var r = runAdb(bin, ['devices', '-l']);
  if (r.status !== 0) fail('adb devices failed:\n' + (r.stderr || r.stdout));
  return r.stdout.split(/\r?\n/).slice(1).map(function (l) { return l.trim(); }).filter(Boolean)
    .filter(function (l) { return !/^\*/.test(l); })
    .map(function (l) { var m = l.split(/\s+/); return { serial: m[0], state: m[1], info: m.slice(2).join(' ') }; });
}
function pickDevice(vals) {
  var bin = adbPath(vals), list = devices(bin), want = vals.serial || process.env.ANDROID_SERIAL;
  if (!list.length) fail('no phone found over ADB. Connect it by USB with USB debugging on (Settings > Developer options),\nthen check that "adb devices" lists it.');
  if (want) {
    var d = list.filter(function (x) { return x.serial === want; })[0];
    if (!d) fail('device ' + want + ' is not connected. Connected: ' + list.map(function (x) { return x.serial; }).join(', '));
    list = [d];
  }
  var ready = list.filter(function (x) { return x.state === 'device'; });
  if (!ready.length) {
    var s = list[0].state;
    fail(s === 'unauthorized' ? 'the phone has not allowed this computer yet. Unlock it and accept the "Allow USB debugging?" prompt.'
      : 'the phone is ' + s + ' over ADB. Reconnect the cable, or run "adb kill-server" and try again.');
  }
  if (ready.length > 1) fail('more than one device is connected; pick one with --serial:\n' + ready.map(function (x) { return '  ' + x.serial + '  ' + x.info; }).join('\n'));
  return { bin: bin, serial: ready[0].serial, info: ready[0].info };
}
function waitForEnter(msg) {
  return new Promise(function (done) {
    var rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(msg, function () { rl.close(); done(); });
  });
}
var READY = 'Open the custom sticker canvas in HeyTea, pick the black pen, keep the screen on, then press Enter (Ctrl+C to stop)… ';
function askReady(vals) { return vals.yes || !process.stdin.isTTY ? Promise.resolve() : waitForEnter(READY); }

/* ---------- finding the canvas on the phone screen ---------- */

function phoneScreen(dev) {
  var r = runAdb(dev.bin, ['-s', dev.serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < 100) fail('could not take a screenshot of the phone (adb exec-out screencap -p).\n' + String(r.stderr || '').trim());
  return r.stdout;
}
// the screenshot (a file, or the phone's screen right now), and the canvas found on it
function screenAndCanvas(vals, dev) {
  var src = vals.screenshot, buf;
  if (src) { if (!fs.existsSync(src)) fail('no such screenshot: ' + src, 2); buf = fs.readFileSync(src); }
  else { log('Taking a screenshot of the phone…'); buf = phoneScreen(dev); }
  return canvas().loadImage(buf).then(function (im) {
    var c = makeCanvas(im.width, im.height), x = c.getContext('2d');
    x.drawImage(im, 0, 0);
    var data = x.getImageData(0, 0, im.width, im.height).data, found = E.findCanvas(data, im.width, im.height);
    return { src: src || 'the phone screen', W: im.width, H: im.height, cv: c, found: found,
      tools: found ? E.findTools(data, im.width, im.height, found.y + found.h) : null };
  }, function (e) { fail('could not read ' + (src || 'the phone screenshot') + ' as an image (' + e.message + ')', 2); });
}
// the screenshot with the canvas outlined, to check what was found
function annotate(d, file) {
  var x = d.cv.getContext('2d'), f = d.found, lw = Math.max(3, Math.round(d.W / 240));
  if (f) {
    x.strokeStyle = '#ff2d55'; x.lineWidth = lw;
    if (f.shape === 'circle') { x.beginPath(); x.ellipse(f.x + f.w / 2, f.y + f.h / 2, f.w / 2, f.h / 2, 0, 0, Math.PI * 2); x.stroke(); }
    else x.strokeRect(f.x - lw / 2, f.y - lw / 2, f.w + lw, f.h + lw);
    var label = f.x + ',' + f.y + '  ' + f.w + ' × ' + f.h, fs2 = Math.round(d.W / 28);
    x.font = 'bold ' + fs2 + 'px sans-serif';
    var tw = x.measureText(label).width, ly = f.y > fs2 * 2 ? f.y - fs2 * 0.6 : f.y + f.h + fs2 * 1.4;
    x.fillStyle = '#ff2d55'; x.fillRect(f.x, ly - fs2 * 1.1, tw + fs2, fs2 * 1.5);
    x.fillStyle = '#fff'; x.fillText(label, f.x + fs2 / 2, ly);
  }
  if (d.tools) [['pen', d.tools.pen], ['eraser', d.tools.eraser]].forEach(function (t) {
    var r = Math.round(d.W / 30);
    x.strokeStyle = '#ff2d55'; x.lineWidth = lw;
    x.beginPath(); x.arc(t[1][0], t[1][1], r, 0, Math.PI * 2); x.stroke();
  });
  fs.writeFileSync(file, d.cv.toBuffer('image/png'));
}
var NOT_FOUND = 'Open Create Sticker in HeyTea so the empty canvas is on screen, or give the edges with --canvas LEFT,TOP,WIDTH,HEIGHT.\n' +
  '"heytea-sticker detect -o screen.png" saves what the phone shows, with what was found outlined.';
// put the found canvas into the phone settings and the drawing's size
// strict (draw, test): without HeyTea's tool panel on screen the canvas sits lower than while drawing, so stop
function useCanvas(d, cfg, vals, strict) {
  if (!d.found) fail("couldn't find the sticker canvas on " + d.src + '.\n' + NOT_FOUND);
  var f = d.found, Ph = cfg.Ph, P = cfg.P, own = vals['eraser-button'] !== undefined || vals['pen-button'] !== undefined;
  if (!d.tools && strict && !own) {
    fail("couldn't find the Brush and Eraser buttons on " + d.src + '.\n' +
      'Pick the Brush in HeyTea so its tool panel opens (the canvas moves up when it does), then run this again,\n' +
      'or give the buttons with --eraser-button X,Y --pen-button X,Y.');
  }
  Ph.rx = f.x; Ph.ry = f.y; Ph.rw = f.w; Ph.rh = f.h; Ph.scw = d.W; Ph.sch = d.H;
  P.rw = f.w; P.rh = f.h;
  if (f.shape === 'circle' && cfg.given.shape === undefined) P.shape = 'circle';
  log('Canvas found: --canvas ' + [f.x, f.y, f.w, f.h].join(',') + ' (' + f.w + ' × ' + f.h + (f.shape === 'circle' ? ', round' : '') + ' on a ' + d.W + ' × ' + d.H + ' screen)');
  if (d.tools && !own) {
    Ph.tx = d.tools.pen[0]; Ph.ty = d.tools.pen[1]; Ph.ex = d.tools.eraser[0]; Ph.ey = d.tools.eraser[1];
    log('Tool buttons found: --pen-button ' + d.tools.pen.join(',') + ' --eraser-button ' + d.tools.eraser.join(',') + ' (the ' + (d.tools.selected === 'pen' ? 'brush' : 'eraser') + ' is picked)');
  } else if (!d.tools && !own) {
    log('No Brush and Eraser buttons on ' + d.src + ': pick the Brush so its panel opens, and look again (the canvas moves up when it does).');
  }
  return f;
}

function drawOnPhone(dev, text, name, vals, asked) {
  var tmp = path.join(os.tmpdir(), 'heytea-' + process.pid + '-' + name);
  fs.writeFileSync(tmp, text);
  var remote = '/sdcard/' + name, s = ['-s', dev.serial];
  log('Sending ' + name + ' to ' + dev.serial + (dev.info ? ' (' + dev.info + ')' : '') + '…');
  var r = runAdb(dev.bin, s.concat(['push', tmp, remote]));
  fs.unlinkSync(tmp);
  if (r.status !== 0) fail('adb push failed:\n' + (r.stderr || r.stdout).trim());
  return (asked ? Promise.resolve() : askReady(vals)).then(function () {
    log('Drawing. Press Ctrl+C to stop.');
    var t0 = Date.now(), p = runAdb(dev.bin, s.concat(['shell', 'sh', remote]), { stdio: 'inherit' });
    if (p.status !== 0) fail('the script stopped with exit code ' + p.status + '.');
    log('Done in ' + fmtTime((Date.now() - t0) / 1000) + '.');
  });
}

/* ---------- commands ---------- */

function main() {
  var a = parse(process.argv.slice(2)), vals = a.values, pos = a.positionals;
  quiet = !!vals.quiet || !!vals.json;
  if (vals.version) { process.stdout.write(VERSION + '\n'); return; }
  if (vals['list-styles']) {
    E.STYLES.forEach(function (s) { process.stdout.write(pad('  ' + styleSlug(s.id), 26) + s.blurb + '\n'); });
    return;
  }
  var cmd = pos[0];
  if (vals.help || !cmd || cmd === 'help') { process.stdout.write(HELP); return; }
  if (['preview', 'draw', 'script', 'test', 'detect', 'devices'].indexOf(cmd) < 0) {
    if (fs.existsSync(cmd)) fail('say what to do with ' + cmd + ': heytea-sticker preview ' + cmd + '  or  heytea-sticker draw ' + cmd, 2);
    fail('unknown command "' + cmd + '". Run heytea-sticker --help.', 2);
  }

  if (cmd === 'devices') {
    var list = devices(adbPath(vals));
    if (!list.length) log('No devices. Connect the phone by USB with USB debugging on.');
    list.forEach(function (d) { process.stdout.write(d.serial + '\t' + d.state + (d.info ? '\t' + d.info : '') + '\n'); });
    return;
  }

  // --canvas auto (the default for draw and test) or --screenshot: find the canvas on the screen
  var auto = vals.canvas === 'auto' || !!vals.screenshot || (vals.canvas === undefined && (cmd === 'draw' || cmd === 'test'));
  if (vals.canvas === 'auto') delete vals.canvas;
  if (cmd === 'detect' && pos[1] && !vals.screenshot) vals.screenshot = pos[1];
  var cfg = settingsFor(vals), P = cfg.P, Ph = cfg.Ph;

  if (cmd === 'detect') {
    return screenAndCanvas(vals, vals.screenshot ? null : pickDevice(vals)).then(function (d) {
      if (vals.out) { annotate(d, vals.out); log('Saved ' + vals.out + (d.found ? ' with the canvas outlined' : '')); }
      if (vals.json) { process.stdout.write(JSON.stringify({ screen: [d.W, d.H], canvas: d.found, tools: d.tools }, null, 2) + '\n'); if (!d.found) process.exit(1); return; }
      var f = useCanvas(d, cfg, vals, false);
      process.stdout.write('--canvas ' + [f.x, f.y, f.w, f.h].join(',') + (d.tools ? ' --pen-button ' + d.tools.pen.join(',') + ' --eraser-button ' + d.tools.eraser.join(',') : '') + '\n');
    });
  }

  if (cmd === 'test') {
    var dv = pickDevice(vals);
    var ready = auto ? (vals.screenshot ? Promise.resolve() : askReady(vals)).then(function () { return screenAndCanvas(vals, dv); }).then(function (d) { useCanvas(d, cfg, vals, true); }) : null;
    return Promise.resolve(ready).then(function () {
      var G = E.grid(P);
      return drawOnPhone(dv, E.testScript(G.W, G.H, Ph), 'switch-test.sh', vals, !!ready);
    });
  }

  var file = pos[1];
  if (!file) fail('give an image: heytea-sticker ' + cmd + ' <image>', 2);
  if (pos.length > 2) fail('one image at a time (got ' + (pos.length - 1) + ')', 2);
  if (!fs.existsSync(file)) fail('no such image: ' + file, 2);
  // look for adb and the phone before the slow part
  var dev = cmd === 'draw' || (auto && !vals.screenshot) ? pickDevice(vals) : null;
  // drawing with the canvas found automatically: wait until it is on screen, look, then plan for its size
  var asked = cmd === 'draw' && auto && !vals.screenshot;
  var located = !auto ? Promise.resolve()
    : (asked ? askReady(vals) : Promise.resolve()).then(function () { return screenAndCanvas(vals, dev); }).then(function (d) { useCanvas(d, cfg, vals, cmd === 'draw'); });

  return located.then(function () { return loadImage(file); }).then(function (img) {
    log('Loaded ' + path.basename(file) + ' · ' + img.width + ' × ' + img.height);
    if (!vals['no-match']) P = autoMatch(img, P);
    for (var k in cfg.given) P[k] = cfg.given[k];
    var t0 = Date.now(), res = planFor(img, P);
    log('Planned in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s.');
    var strokes = res.strokes, text = E.script(strokes, res.W, res.H, Ph), s = summary(res, P, Ph, text);

    var png = cmd === 'preview' ? vals.out || path.basename(file).replace(/\.[^.]+$/, '') + '.sticker.png' : cmd === 'draw' ? vals.out : null;
    if (png) { renderPNG(res, P, png); s.preview = path.resolve(png); log('Preview: ' + png); }
    var sh = cmd === 'script' ? vals.out || 'draw.sh' : vals.script;
    if (sh) { fs.writeFileSync(sh, text); s.script = path.resolve(sh); log('Script: ' + sh + ' (adb push ' + sh + ' /sdcard/ && adb shell sh /sdcard/' + path.basename(sh) + ')'); }
    report(s, vals.json);
    if (cmd === 'draw') return drawOnPhone(dev, text, 'draw.sh', vals, asked);
  });
}

Promise.resolve().then(main).catch(function (e) { fail(e && e.stack || String(e)); });
