/*
 * Sticker Drawer desktop app. Plans drawings with the shared engine (vendor/engine.js, vendor/worker.js) and
 * drives the phone through the Rust commands: screenshot, screen_dpi, start_job, pause_job, stop_job, ...
 */
(function () {
  'use strict';

  var E = window.StickerEngine;
  var TAURI = window.__TAURI__;
  var invoke = TAURI ? TAURI.core.invoke : function () { return Promise.reject(new Error('Open this in the Sticker Drawer app.')); };
  var listen = TAURI ? TAURI.event.listen : function () { return Promise.resolve(); };
  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fmtN(n) { return Math.round(n).toLocaleString('en-US'); }
  function fmtT(s) { s = Math.max(0, Math.round(s)); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? h + 'h ' + (m < 10 ? '0' : '') + m + 'm' : m ? m + ' min' : s + ' s'; }

  /* ---------- presets ---------- */

  var BUILT_IN = [
    { id: 'best', name: 'Best match', auto: true, P: { mode: 'z' } },
    { id: 'detail', name: 'Fine detail', auto: true, P: { mode: 'z', lc: 80, tn: 4 } },
    { id: 'bold', name: 'Bold two-tone', auto: true, P: { mode: 'w' } },
    { id: 'lines', name: 'Line drawing', auto: false, P: { mode: 'e', sen: 60 } }
  ];
  // what a preset keeps (and what Save as preset stores)
  var PRESET_KEYS = ['mode', 'br', 'co', 'gm', 'lc', 'ps', 'tn', 'thr', 'sen', 'sm', 'inv', 'dth', 'hl'];
  var SLIDERS = [
    { k: 'br', label: 'Brightness', min: -100, max: 100 },
    { k: 'co', label: 'Contrast', min: -100, max: 100 },
    { k: 'gm', label: 'Midtones', min: 40, max: 250 },
    { k: 'lc', label: 'Local contrast', min: 0, max: 100 },
    { k: 'ps', label: 'Passes', min: 1, max: 20, hint: 'More passes bring back finer detail, and take longer.' },
    { k: 'tn', label: 'Tiles', min: 1, max: 8, hint: 'Drawn tile by tile from the top left.' }
  ];

  /* ---------- state ---------- */

  var S = { items: [], presets: [], selected: null, lastPreset: 'best', lineup: null, settings: { adb: '' } };
  var device = null, adbOk = false;
  var run = { active: false, state: 'idle', itemId: null, pm: 0, left: 0, tool: 'brush', strokes: '', stopReq: false, skip: false, lastWord: '', endWait: null };

  function presets() { return BUILT_IN.concat(S.presets); }
  function presetOf(item) { return presets().filter(function (p) { return p.id === item.presetId; })[0] || BUILT_IN[0]; }
  function itemById(id) { return S.items.filter(function (i) { return i.id === id; })[0] || null; }
  function selected() { return itemById(S.selected); }
  // the canvas the drawing is planned for: the lined-up one, else HeyTea's on a 1440 x 3200 phone
  function physical() {
    var Ph = S.lineup && S.lineup.Ph;
    return Ph ? { rw: Ph.rw, rh: Ph.rh, pen: Ph.pen, esz: Ph.esz } : { rw: 1015, rh: 1428, pen: 10.5, esz: 10.5 };
  }

  var saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var items = S.items.map(function (i) { var o = {}; for (var k in i) if (k[0] !== '_') o[k] = i[k]; return o; });
      invoke('save_state', { json: JSON.stringify({ v: 1, items: items, presets: S.presets, selected: S.selected, lastPreset: S.lastPreset, lineup: S.lineup, settings: S.settings }) }).catch(function () {});
    }, 300);
  }

  /* ---------- planning (in the shared worker) ---------- */

  var worker = null, wseq = 0;
  function call(msg, transfer, onProgress) {
    if (!worker) worker = new Worker('vendor/worker.js');
    return new Promise(function (resolve, reject) {
      var id = ++wseq;
      function h(e) {
        var m = e.data;
        if (m.id !== id) return;
        if (m.type === 'progress' || m.type === 'trying') { if (onProgress) onProgress(m); return; }
        worker.removeEventListener('message', h);
        if (m.type === 'error') reject(new Error(m.message)); else resolve(m);
      }
      worker.addEventListener('message', h);
      msg.id = id;
      worker.postMessage(msg, transfer || []);
    });
  }
  function bitmapOf(item) { return fetch(item.img).then(function (r) { return r.blob(); }).then(createImageBitmap); }

  function base(item) {
    var pre = presetOf(item), P = E.withDefaults({});
    PRESET_KEYS.forEach(function (k) { if (pre.P[k] !== undefined) P[k] = pre.P[k]; });
    var ph = physical(); for (var k in ph) P[k] = ph[k];
    P.fit = item.fit || 'cover';
    return P;
  }
  function matchKey(item) { var ph = physical(); return [item.id, item.presetId, item.fit, ph.rw, ph.rh, ph.pen].join('|'); }
  // the settings an item is drawn with: preset (or its auto-match), then the item's own adjustments
  function effective(item) {
    var P = base(item), pre = presetOf(item);
    if (pre.auto && item.match && item.match.key === matchKey(item)) {
      var M = item.match.P;
      ['br', 'co', 'gm', 'ps', 'thr', 'dth', 'sen', 'lc'].forEach(function (k) { if (M[k] !== undefined) P[k] = M[k]; });
    }
    for (var k in (item.adj || {})) P[k] = item.adj[k];
    return P;
  }
  function needsMatch(item) { return presetOf(item).auto && !(item.match && item.match.key === matchKey(item)); }
  function planKey(item) { return matchKey(item) + '|' + JSON.stringify(effective(item)); }
  function planned(item) { return item._plan && item._plan.key === planKey(item) ? item._plan : null; }

  var planning = null;
  // plan whatever needs it, the selected picture first, one at a time
  function planLoop() {
    if (planning) return planning;
    planning = (async function () {
      for (;;) {
        var sel = selected(), next = sel && !planned(sel) ? sel : S.items.filter(function (i) { return !planned(i) && i.status !== 'done'; })[0];
        if (!next) break;
        try { await planItem(next); } catch (e) { next._error = e.message; next._plan = { key: planKey(next), failed: true }; toast('Could not plan ' + next.name + ': ' + e.message); }
        render();
      }
      planning = null;
    })();
    return planning;
  }
  async function planItem(item) {
    item._busy = needsMatch(item) ? 'Finding the best settings… 0%' : 'Planning…';
    render();
    var bmp = await bitmapOf(item);
    await call({ type: 'image', bitmap: bmp }, [bmp]);
    if (needsMatch(item)) {
      var key = matchKey(item);
      var r = await call({ type: 'match', P: base(item), modes: [base(item).mode] }, [], function (m) {
        if (m.type === 'progress') { item._busy = 'Finding the best settings… ' + m.pct + '%'; if (S.selected === item.id) $('#plan-busy-text').textContent = item._busy; }
      });
      item.match = { key: key, P: r.result.P, score: r.result.match };
      save();
      item._busy = 'Planning…'; render();
    }
    var key2 = planKey(item), P = effective(item);
    var res = (await call({ type: 'plan', P: P })).result;
    item._plan = { key: key2, P: P, res: res, est: estimateFor(res, P) };
    item._busy = null;
  }
  function strokesOf(res) { return res.strokes.map(function (s) { var p = s.p.slice(); if (s.er) p.er = 1; return p; }); }
  function phoneSettings() {
    var Ph = S.lineup && S.lineup.Ph ? Object.assign({}, S.lineup.Ph) : Object.assign({}, E.PHONE_DEFAULTS, { rx: 213, ry: 509, rw: 1015, rh: 1428, scw: 1440, sch: 3200, pen: 10.5, esz: 10.5, tx: 561, ty: 2657, ex: 879, ey: 2657 });
    Ph.method = 'mo';
    return Ph;
  }
  function scriptFor(item) { var p = item._plan; return E.script(strokesOf(p.res), p.res.W, p.res.H, phoneSettings()); }
  function estimateFor(res) { return E.estimate(E.script(strokesOf(res), res.W, res.H, phoneSettings())).sec; }

  /* ---------- phone ---------- */

  async function pollDevice() {
    try {
      var list = await invoke('devices');
      var ready = list.filter(function (d) { return d.state === 'device'; })[0];
      device = ready || null;
      var dot = $('#phone-dot'), text = $('#phone-text');
      dot.className = 'chip__dot';
      if (ready) {
        dot.classList.add('is-on');
        text.textContent = (ready.model || ready.serial) + (S.lineup && S.lineup.serial === ready.serial ? ' · lined up' : '');
      } else if (list.length) {
        dot.classList.add('is-warn');
        text.textContent = list[0].state === 'unauthorized' ? 'Allow USB debugging on the phone' : 'Phone ' + list[0].state;
      } else text.textContent = 'No phone connected';
    } catch (e) {
      device = null;
      $('#phone-dot').className = 'chip__dot is-warn';
      $('#phone-text').textContent = adbOk ? 'Phone not reachable' : 'adb not found';
    }
    renderBar();
  }
  // find the canvas, the tool buttons and the brush size on the phone's screen right now
  async function lookAtPhone() {
    var b64 = await invoke('screenshot', { serial: device.serial });
    var img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    var W = img.naturalWidth, H = img.naturalHeight, c = document.createElement('canvas');
    c.width = W; c.height = H;
    var x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    var data = x.getImageData(0, 0, W, H).data, f = E.findCanvas(data, W, H), tools = f ? E.findTools(data, W, H, f.y + f.h) : null;
    var ink = 0;
    if (f) for (var y = f.y + 6; y < f.y + f.h - 6; y += 2) for (var X = f.x + 6; X < f.x + f.w - 6; X += 2) if (data[(y * W + X) * 4] < 128) ink++;
    return { W: W, H: H, f: f, tools: tools, empty: ink < 20 };
  }
  async function lineUp(look) {
    var dpi = await invoke('screen_dpi', { serial: device.serial }).catch(function () { return 0; });
    var f = look.f, t = look.tools, size = E.toolSize(f.w, dpi);
    S.lineup = {
      serial: device.serial, at: Date.now(),
      Ph: Object.assign({}, E.PHONE_DEFAULTS, { rx: f.x, ry: f.y, rw: f.w, rh: f.h, scw: look.W, sch: look.H, tx: t.pen[0], ty: t.pen[1], ex: t.eraser[0], ey: t.eraser[1], pen: size, esz: size, method: 'mo' })
    };
    save();
    renderLineupNote();
  }

  /* ---------- drawing ---------- */

  function pending() { return S.items.filter(function (i) { return i.status !== 'done'; }); }
  async function start() {
    if (run.active) return;
    if (!device) { toast('Connect the phone by USB with USB debugging on.'); return; }
    run.active = true; run.stopReq = false; run.state = 'starting'; renderBar();
    try {
      for (;;) {
        if (run.stopReq) break;
        var item = pending()[0];
        if (!item) break;
        select(item.id);
        // 1. the sticker canvas must be open with the Brush picked
        var look;
        for (;;) {
          if (run.stopReq) throw 'stop';
          run.state = 'looking'; renderBar();
          look = await lookAtPhone();
          if (look.f && look.tools) break;
          run.state = 'need-canvas'; renderBar();
          await waitOrStop(3000);
        }
        await lineUp(look);
        // 2. carry on where it stopped, or start on an empty canvas
        run.state = 'preparing'; renderBar();
        await planLoop();
        while (!planned(item)) { await planLoop(); }
        if (item._plan.failed) throw new Error('could not plan ' + item.name);
        var script = scriptFor(item), id = (/^ID=(\S+)/m.exec(script) || [])[1];
        var onPhone = await invoke('phone_progress', { serial: device.serial }).catch(function () { return ''; });
        var resume = !!id && onPhone.split(' ')[0] === id;
        if (!resume && !look.empty) {
          run.skip = false;
          for (;;) {
            run.state = 'need-empty'; renderBar();
            await waitOrStop(3000);
            if (run.stopReq) throw 'stop';
            if (run.skip) break;
            var l2 = await lookAtPhone();
            if (l2.f && l2.tools && l2.empty) { await lineUp(l2); break; }
          }
          if (!planned(item)) { await planLoop(); while (!planned(item)) await planLoop(); }
          script = scriptFor(item);
        }
        // 3. draw it
        item.status = 'drawing'; run.itemId = item.id; run.pm = resume ? +onPhone.split(' ')[2] || 0 : 0; run.left = item._plan.est; run.lastWord = '';
        run.state = 'drawing'; render(); save();
        var code = await drawJob(script, resume);
        if (run.lastWord === 'DONE') { item.status = 'done'; item.pm = 1000; toast(item.name + ' is done.'); }
        else { item.status = 'stopped'; item.pm = run.pm; save(); render(); break; }
        save(); render();
        void code;
      }
    } catch (e) {
      if (e !== 'stop') toast(e && e.message ? e.message : String(e));
    }
    run.active = false; run.state = 'idle'; run.itemId = null;
    S.items.forEach(function (i) { if (i.status === 'drawing') i.status = 'stopped'; });
    save(); render();
  }
  function waitOrStop(ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function tick() { if (run.stopReq || run.skip || Date.now() - t0 >= ms) resolve(); else setTimeout(tick, 150); })();
    });
  }
  function drawJob(script, resume) {
    return new Promise(function (resolve, reject) {
      run.endWait = resolve;
      invoke('start_job', { serial: device.serial, script: script, resume: resume }).catch(function (e) { run.endWait = null; reject(new Error(e)); });
    });
  }
  listen('job-line', function (ev) {
    var parts = String(ev.payload).slice(1).split(' '), word = parts[0];
    run.lastWord = word;
    if (word === 'P') {
      run.pm = +parts[1]; run.left = +parts[2]; run.tool = parts[4]; run.strokes = parts.slice(5).join(' ');
      if (run.state !== 'pausing') run.state = 'drawing';
      var it = itemById(run.itemId); if (it) it.pm = run.pm;
    } else if (word === 'PAUSED') run.state = 'paused';
    else if (word === 'WAIT') run.state = 'away';
    else if (word === 'RUN') run.state = 'drawing';
    else if (word === 'DONE') run.pm = 1000;
    render();
  });
  listen('job-end', function (ev) { var f = run.endWait; run.endWait = null; if (f) f(ev.payload); });

  async function pauseOrResume() {
    if (!device) return;
    if (run.state === 'paused' || run.state === 'pausing') { await invoke('pause_job', { serial: device.serial, on: false }); run.state = 'resuming'; }
    else { await invoke('pause_job', { serial: device.serial, on: true }); run.state = 'pausing'; }
    renderBar();
  }
  async function stop() {
    run.stopReq = true;
    if (run.endWait && device) { run.state = 'stopping'; renderBar(); await invoke('stop_job', { serial: device.serial }).catch(function () {}); }
    renderBar();
  }

  /* ---------- adding pictures ---------- */

  function addFiles(files) {
    var list = Array.prototype.filter.call(files, function (f) { return /^image\//.test(f.type); });
    if (!list.length) return;
    Promise.all(list.map(readImage)).then(function (imgs) {
      var first = null;
      imgs.forEach(function (o) {
        var item = { id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: o.name, img: o.url, presetId: S.lastPreset, fit: 'cover', adj: {}, status: 'ready' };
        S.items.push(item);
        if (!first) first = item;
      });
      select(first.id);
      save(); render(); planLoop();
    });
  }
  // keep a copy no bigger than 1400 px: plenty for a 1015 px canvas, and small enough to save
  function readImage(file) {
    return createImageBitmap(file).then(function (bmp) {
      var s = Math.min(1, 1400 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
      return { name: file.name.replace(/\.[^.]+$/, ''), url: c.toDataURL('image/jpeg', 0.92) };
    });
  }
  ['#file-input', '#file-input-2'].forEach(function (s) { $(s).addEventListener('change', function () { addFiles(this.files); this.value = ''; }); });
  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) { dragDepth++; document.body.classList.add('is-dropping'); } });
  window.addEventListener('dragleave', function () { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('is-dropping'); } });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); dragDepth = 0; document.body.classList.remove('is-dropping'); if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

  /* ---------- rendering ---------- */

  function select(id) { S.selected = id; save(); render(); planLoop(); }
  function itemStatus(item) {
    if (item.status === 'done') return ['Done', 'is-done'];
    if (item.status === 'drawing') return [Math.floor((item.pm || 0) / 10) + '%', 'is-active'];
    if (item.status === 'stopped') return ['Stopped ' + Math.floor((item.pm || 0) / 10) + '%', 'is-stopped'];
    return null;
  }
  function itemSub(item) {
    var pre = presetOf(item).name, p = planned(item);
    if (item._busy) return pre + ' · ' + (needsMatch(item) ? 'matching…' : 'planning…');
    if (p && !p.failed) return pre + ' · about ' + fmtT(p.est);
    return pre;
  }
  function renderQueue() {
    var ol = $('#queue-list');
    ol.innerHTML = S.items.map(function (i) {
      var st = itemStatus(i);
      return '<li class="q' + (i.id === S.selected ? ' is-selected' : '') + '" draggable="true" data-id="' + i.id + '">' +
        '<span class="q__thumb" style="background-image:url(' + i.img + ')"></span>' +
        '<span><div class="q__name">' + esc(i.name) + '</div><div class="q__sub">' + esc(itemSub(i)) + '</div></span>' +
        (st ? '<span class="q__state ' + st[1] + '">' + st[0] + '</span>' : '<span></span>') +
        (i.status === 'drawing' ? '<i class="q__progress" style="transform:scaleX(' + (i.pm || 0) / 1000 + ')"></i>' : '') + '</li>';
    }).join('');
    var left = pending().length;
    $('#queue-count').textContent = S.items.length ? (left ? left + ' to draw' : 'all drawn') : '';
  }
  $('#queue-list').addEventListener('click', function (e) { var li = e.target.closest('.q'); if (li) select(li.dataset.id); });
  // drag to reorder
  var dragId = null;
  $('#queue-list').addEventListener('dragstart', function (e) { var li = e.target.closest('.q'); if (!li) return; dragId = li.dataset.id; li.classList.add('is-dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
  $('#queue-list').addEventListener('dragend', function () { dragId = null; renderQueue(); });
  $('#queue-list').addEventListener('dragover', function (e) {
    if (!dragId) return;
    e.preventDefault();
    var li = e.target.closest('.q'); if (!li || li.dataset.id === dragId) return;
    var from = S.items.findIndex(function (i) { return i.id === dragId; }), to = S.items.findIndex(function (i) { return i.id === li.dataset.id; });
    var r = li.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2, moved = S.items.splice(from, 1)[0];
    to = S.items.findIndex(function (i) { return i.id === li.dataset.id; }) + (after ? 1 : 0);
    S.items.splice(to, 0, moved); save(); renderQueue();
    $$('.q').forEach(function (q) { q.classList.toggle('is-dragging', q.dataset.id === dragId); });
  });

  function renderItem() {
    var item = selected();
    $('#empty').hidden = !!item;
    $('#item').hidden = !item;
    if (!item) return;
    if (document.activeElement !== $('#item-name')) $('#item-name').value = item.name;
    var ph = physical();
    $('.previews').style.setProperty('--ar', ph.rw / ph.rh);
    drawPicture(item, ph);
    // presets
    var sel = $('#preset');
    sel.innerHTML = '<optgroup label="Presets">' + BUILT_IN.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join('') + '</optgroup>' +
      (S.presets.length ? '<optgroup label="Your presets">' + S.presets.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join('') + '</optgroup>' : '');
    sel.value = presetOf(item).id;
    $('#delete-preset').hidden = !S.presets.some(function (p) { return p.id === item.presetId; });
    $$('[data-fit]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.fit === (item.fit || 'cover'))); });
    // sliders show the settings in use
    var P = effective(item);
    SLIDERS.forEach(function (s) {
      var el = $('#s-' + s.k); if (!el) return;
      if (document.activeElement !== el) el.value = P[s.k];
      $('#o-' + s.k).textContent = P[s.k];
    });
    $('#adjust-note').textContent = Object.keys(item.adj || {}).length ? '· changed' : '';
    // the drawing
    var p = planned(item), busy = $('#plan-busy');
    busy.hidden = !item._busy && !!p;
    $('#plan-busy-text').textContent = item._busy || 'Waiting to plan…';
    if (p && !p.failed) {
      $('#plan-meta').textContent = '· ' + Math.round(p.res.match) + '% match · ' + fmtN(p.res.strokes.length) + ' strokes · about ' + fmtT(p.est);
      drawPreview(p);
    } else $('#plan-meta').textContent = p && p.failed ? '· could not plan this picture' : '';
  }
  // the picture as it will be fitted onto the sticker: cropped to fill it, or inside it on paper
  var pictureKey = '', images = {};
  function drawPicture(item, ph) {
    var key = item.id + '|' + item.fit + '|' + ph.rw + 'x' + ph.rh;
    if (key === pictureKey) return;
    var im = images[item.id];
    if (!im) { im = images[item.id] = new Image(); im.onload = function () { pictureKey = ''; renderItem(); }; im.src = item.img; }
    if (!im.complete || !im.naturalWidth) return;
    pictureKey = key;
    var cv = $('#pic'), H = 900, W = Math.round(H * ph.rw / ph.rh), x = cv.getContext('2d');
    cv.width = W; cv.height = H;
    x.fillStyle = '#f3f3f3'; x.fillRect(0, 0, W, H);
    var s = (item.fit || 'cover') === 'cover' ? Math.max(W / im.naturalWidth, H / im.naturalHeight) : Math.min(W / im.naturalWidth, H / im.naturalHeight);
    x.imageSmoothingQuality = 'high';
    x.drawImage(im, (W - im.naturalWidth * s) / 2, (H - im.naturalHeight * s) / 2, im.naturalWidth * s, im.naturalHeight * s);
  }
  var drawn = null;
  function drawPreview(p) {
    if (drawn === p) return;
    drawn = p;
    var cv = $('#draw-preview'), res = p.res, P = p.P, sc = Math.max(1, Math.round(900 / Math.max(res.W, res.H)));
    cv.width = res.W * sc; cv.height = res.H * sc;
    var x = cv.getContext('2d'), cur = -1;
    x.fillStyle = '#f3f3f3'; x.fillRect(0, 0, cv.width, cv.height);
    x.lineCap = x.lineJoin = 'round';
    x.beginPath();
    res.strokes.forEach(function (s) {
      if (s.er !== cur) {
        if (cur !== -1) { x.stroke(); x.beginPath(); }
        x.strokeStyle = s.er ? '#f3f3f3' : '#111';
        x.lineWidth = E.px(P, res.W, s.er ? P.esz : P.pen) * sc;
        cur = s.er;
      }
      var q = s.p;
      x.moveTo((q[0][0] + 0.5) * sc, (q[0][1] + 0.5) * sc);
      for (var j = 1; j < q.length; j++) x.lineTo((q[j][0] + 0.5) * sc, (q[j][1] + 0.5) * sc);
      if (q.length === 1) x.lineTo((q[0][0] + 0.5) * sc + 0.01, (q[0][1] + 0.5) * sc);
    });
    x.stroke();
  }

  function renderBar() {
    var main = $('#status-main'), sub = $('#status-sub'), fill = $('#bar-fill');
    var startB = $('#start-btn'), pauseB = $('#pause-btn'), stopB = $('#stop-btn'), skipB = $('#skip-btn');
    var left = pending(), item = itemById(run.itemId) || selected();
    var total = left.reduce(function (s, i) { var p = planned(i); return s + (p && !p.failed ? p.est : 0); }, 0);
    startB.hidden = run.active; pauseB.hidden = true; stopB.hidden = !run.active; skipB.hidden = true;
    fill.style.width = '0%';
    if (!run.active) {
      startB.disabled = !left.length || !device;
      var stopped = left[0] && left[0].status === 'stopped';
      startB.textContent = stopped ? 'Resume' : 'Start';
      if (!S.items.length) { main.textContent = 'Add pictures to start'; sub.textContent = ''; }
      else if (!left.length) { main.textContent = 'Everything is drawn'; sub.textContent = 'Add more pictures to keep going.'; }
      else {
        main.textContent = (stopped ? 'Resume ' + left[0].name : 'Ready to draw ' + (left.length === 1 ? left[0].name : left.length + ' pictures'));
        sub.textContent = device ? (total ? 'about ' + fmtT(total) + ' · ' : '') + 'open the sticker canvas in HeyTea and pick the Brush, then press ' + startB.textContent : 'Connect the phone by USB with USB debugging on.';
      }
      return;
    }
    var n = S.items.indexOf(item) + 1, of = S.items.length, name = item ? item.name : '';
    switch (run.state) {
      case 'starting': case 'looking': main.textContent = 'Looking at the phone…'; sub.textContent = ''; break;
      case 'need-canvas': main.textContent = 'Open the sticker canvas in HeyTea and pick the Brush'; sub.textContent = 'Drawing starts as soon as it is on screen.'; break;
      case 'preparing': main.textContent = 'Getting ' + name + ' ready…'; sub.textContent = item && item._busy ? item._busy : ''; break;
      case 'need-empty': main.textContent = 'Waiting for an empty canvas'; sub.textContent = 'Save the last sticker in HeyTea, then start a new one with the Brush picked. Drawing starts by itself.'; skipB.hidden = false; break;
      case 'stopping': main.textContent = 'Stopping…'; sub.textContent = ''; break;
      default:
        fill.style.width = (run.pm / 10) + '%';
        pauseB.hidden = false;
        pauseB.textContent = run.state === 'paused' || run.state === 'pausing' ? 'Resume' : 'Pause';
        var head = run.state === 'paused' ? 'Paused' : run.state === 'pausing' ? 'Pausing…' : run.state === 'away' ? 'Waiting for HeyTea to come back' : 'Drawing ' + name;
        main.textContent = head + (of > 1 ? '  ·  ' + n + ' of ' + of : '');
        sub.textContent = Math.floor(run.pm / 10) + '%  ·  ' + fmtT(run.left) + ' left  ·  ' + (run.tool === 'eraser' ? 'eraser' : 'brush') + (run.strokes ? '  ·  ' + run.strokes + ' strokes' : '');
    }
  }
  function render() { renderQueue(); renderItem(); renderBar(); }

  /* ---------- controls ---------- */

  $('#sliders').innerHTML = SLIDERS.map(function (s) {
    return '<div class="slider" title="' + esc(s.hint || '') + '"><label for="s-' + s.k + '">' + s.label + '</label><output id="o-' + s.k + '"></output>' +
      '<input type="range" id="s-' + s.k + '" min="' + s.min + '" max="' + s.max + '" step="1"></div>';
  }).join('');
  var adjustTimer = 0;
  SLIDERS.forEach(function (s) {
    $('#s-' + s.k).addEventListener('input', function () {
      var item = selected(); if (!item) return;
      item.adj = item.adj || {}; item.adj[s.k] = +this.value;
      $('#o-' + s.k).textContent = this.value;
      clearTimeout(adjustTimer);
      adjustTimer = setTimeout(function () { save(); render(); planLoop(); }, 250);
    });
  });
  $('#reset-adjust').addEventListener('click', function () { var item = selected(); if (!item) return; item.adj = {}; save(); render(); planLoop(); });
  $('#preset').addEventListener('change', function () {
    var item = selected(); if (!item) return;
    item.presetId = this.value; item.adj = {}; S.lastPreset = this.value;
    save(); render(); planLoop();
  });
  $$('[data-fit]').forEach(function (b) {
    b.addEventListener('click', function () { var item = selected(); if (!item) return; item.fit = b.dataset.fit; save(); render(); planLoop(); });
  });
  $('#item-name').addEventListener('input', function () { var item = selected(); if (!item) return; item.name = this.value || 'Untitled'; save(); renderQueue(); });
  $('#remove-item').addEventListener('click', function () {
    var item = selected(); if (!item) return;
    if (item.status === 'drawing') { toast('Stop the drawing first.'); return; }
    var i = S.items.indexOf(item); S.items.splice(i, 1);
    S.selected = (S.items[i] || S.items[i - 1] || {}).id || null;
    save(); render();
  });
  $('#save-preset').addEventListener('click', function () {
    var item = selected(); if (!item) return;
    $('#preset-name').value = presetOf(item).name + ' (mine)';
    $('#preset-dialog').showModal();
    $('#preset-name').select();
  });
  $('#preset-dialog').addEventListener('close', function () {
    if (this.returnValue !== 'save') return;
    var item = selected(); if (!item) return;
    var P = effective(item), keep = {};
    PRESET_KEYS.forEach(function (k) { if (P[k] !== undefined) keep[k] = P[k]; });
    var pre = { id: 'c' + Date.now().toString(36), name: $('#preset-name').value.trim() || 'My preset', auto: false, P: keep };
    S.presets.push(pre);
    item.presetId = pre.id; item.adj = {}; S.lastPreset = pre.id;
    save(); render(); toast('Saved "' + pre.name + '"');
  });
  $('#delete-preset').addEventListener('click', function () {
    var item = selected(); if (!item) return;
    var id = item.presetId, pre = presetOf(item);
    S.presets = S.presets.filter(function (p) { return p.id !== id; });
    S.items.forEach(function (i) { if (i.presetId === id) { i.presetId = 'best'; i.adj = {}; } });
    if (S.lastPreset === id) S.lastPreset = 'best';
    save(); render(); planLoop(); toast('Deleted "' + pre.name + '"');
  });

  $('#start-btn').addEventListener('click', start);
  $('#pause-btn').addEventListener('click', pauseOrResume);
  $('#stop-btn').addEventListener('click', stop);
  $('#skip-btn').addEventListener('click', function () { run.skip = true; });

  // settings
  $('#settings-btn').addEventListener('click', openSettings);
  $('#phone-chip').addEventListener('click', openSettings);
  function openSettings() { $('#adb-path').value = S.settings.adb || ''; renderLineupNote(); $('#settings').showModal(); }
  $('#adb-path').addEventListener('change', function () { S.settings.adb = this.value.trim(); save(); initAdb(); });
  $('#lineup-btn').addEventListener('click', async function () {
    if (!device) { toast('Connect the phone first.'); return; }
    var btn = this; btn.disabled = true; btn.textContent = 'Looking…';
    try {
      var look = await lookAtPhone();
      if (!look.f || !look.tools) toast('Open the sticker canvas in HeyTea and pick the Brush, then try again.');
      else { await lineUp(look); S.items.forEach(function (i) { i._plan = null; }); render(); planLoop(); toast('Lined up'); }
    } catch (e) { toast(String(e.message || e)); }
    btn.disabled = false; btn.textContent = 'Line up now';
  });
  function renderLineupNote() {
    var L = S.lineup && S.lineup.Ph;
    $('#lineup-note').textContent = L ? 'Canvas ' + L.rw + ' × ' + L.rh + ' at ' + L.rx + ', ' + L.ry + ' · brush ' + L.pen + ' px · Brush and Eraser buttons found. It lines up again each time you press Start.' :
      'Not lined up yet. It lines up by itself when you press Start.';
  }
  async function initAdb() {
    try { var a = await invoke('set_adb', { custom: S.settings.adb || '' }); adbOk = true; $('#adb-note').textContent = 'Using ' + a; }
    catch (e) { adbOk = false; $('#adb-note').textContent = String(e) + ' Install Android Platform-Tools, or enter the path to adb.exe.'; }
    pollDevice();
  }

  var toastT = 0;
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.classList.add('is-on'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('is-on'); }, 3200); }

  // for inspecting the app from the WebView2 devtools (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=...)
  window.__sd = { S: S, run: run, planLoop: planLoop, planned: planned, planKey: planKey, effective: effective, get planning() { return planning; }, get device() { return device; } };

  /* ---------- start up ---------- */

  invoke('load_state').then(function (txt) {
    try {
      var o = JSON.parse(txt || '{}');
      if (o.items) S.items = o.items.map(function (i) { if (i.status === 'drawing') i.status = 'stopped'; return i; });
      S.presets = o.presets || []; S.selected = o.selected || (S.items[0] || {}).id || null;
      S.lastPreset = o.lastPreset || 'best'; S.lineup = o.lineup || null; S.settings = o.settings || { adb: '' };
    } catch (e) { /* first run */ }
  }).catch(function () {}).then(function () {
    render(); initAdb(); planLoop();
    setInterval(function () { if (!run.active) pollDevice(); }, 3000);
  });
})();
