#!/usr/bin/env node
/*
 * Serves the web UI locally: node serve.js [port]  (or npm start). No dependencies.
 * The page needs http:// rather than file://, because browsers won't start its Web Worker from a file.
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');

var ROOT = __dirname;
var PORT = +(process.argv[2] || process.env.PORT || 8000);
var TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json'
};
// only the page's own files: not the CLI, node_modules or the repo itself
var HIDDEN = /^(node_modules|cli|\.git)(\/|$)|^(package(-lock)?\.json|serve\.js)$|(^|\/)\./;

http.createServer(function (req, res) {
  var rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''); } catch (e) { rel = '\0'; }
  if (rel === '' || rel.slice(-1) === '/') rel += 'index.html';
  var file = path.resolve(ROOT, rel);
  if (rel.indexOf('\0') >= 0 || file.indexOf(ROOT + path.sep) !== 0 || HIDDEN.test(rel)) return send(res, 404, 'not found');
  fs.readFile(file, function (err, body) {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  });
}).on('error', function (e) {
  console.error(e.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is in use. Try: node serve.js ' + (PORT + 1) : e.message);
  process.exit(1);
}).listen(PORT, '127.0.0.1', function () {
  console.log('Sticker drawer running at http://localhost:' + PORT + '  (Ctrl+C to stop)');
});

function send(res, code, text) { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(text); }
