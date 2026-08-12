'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const runBuild = (...args) => spawnSync(process.execPath, ['scripts/build-site.js', ...args], {
  cwd: root,
  encoding: 'utf8',
});

function fileTreeHashes(directory) {
  const output = new Map();
  const visit = (current, relativeRoot = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.join(relativeRoot, entry.name);
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else output.set(relative, sha256(fs.readFileSync(absolute)));
    }
  };
  visit(directory);
  return output;
}

function decodeIndexedPng(file) {
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  let palette = Buffer.alloc(0);
  let transparency = Buffer.alloc(0);
  const idat = [];

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') transparency = Buffer.from(data);
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }

  assert.equal(bitDepth, 8, 'test decoder expects 8-bit PNGs');
  assert.equal(colorType, 3, 'test decoder expects indexed PNGs');
  assert.equal(interlace, 0, 'test decoder expects non-interlaced PNGs');
  const filtered = zlib.inflateSync(Buffer.concat(idat));
  const stride = width;
  const pixels = Buffer.alloc(width * height);
  let inputOffset = 0;
  let previous = Buffer.alloc(stride);

  const paeth = (a, b, c) => {
    const prediction = a + b - c;
    const pa = Math.abs(prediction - a);
    const pb = Math.abs(prediction - b);
    const pc = Math.abs(prediction - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < height; y++) {
    const filter = filtered[inputOffset++];
    const row = Buffer.from(filtered.subarray(inputOffset, inputOffset + stride));
    inputOffset += stride;
    for (let x = 0; x < stride; x++) {
      const left = x > 0 ? row[x - 1] : 0;
      const up = previous[x];
      const upLeft = x > 0 ? previous[x - 1] : 0;
      if (filter === 1) row[x] = (row[x] + left) & 0xff;
      else if (filter === 2) row[x] = (row[x] + up) & 0xff;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) row[x] = (row[x] + paeth(left, up, upLeft)) & 0xff;
      else assert.equal(filter, 0, `unsupported PNG filter ${filter}`);
    }
    row.copy(pixels, y * stride);
    previous = row;
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < pixels.length; index++) {
    const paletteIndex = pixels[index];
    rgba[index * 4] = palette[paletteIndex * 3];
    rgba[index * 4 + 1] = palette[paletteIndex * 3 + 1];
    rgba[index * 4 + 2] = palette[paletteIndex * 3 + 2];
    rgba[index * 4 + 3] = paletteIndex < transparency.length ? transparency[paletteIndex] : 255;
  }
  return { width, height, rgba };
}

test('the source tree uses index.html directly and exposes concise live status', () => {
  const html = read('index.html');
  assert.equal(fs.existsSync(path.join(root, 'plateloader.html')), false);
  assert.doesNotMatch(html, /<style\b|\sstyle=/i);
  assert.match(html, /<span class="disclosure-icon" aria-hidden="true"><\/span>/);
  assert.match(html, /id="outputStatus"[^>]*role="status"/);
  assert.match(html, /<div class="sets" id="output"><\/div>/);
  assert.doesNotMatch(html, /id="output"[^>]*aria-live/);
});

test('CSS keeps required behavior without a generated disclosure character or size floor', () => {
  const css = read('plateloader.css');
  for (const selector of [
    '.disclosure-icon', '#startDetails[open] .disclosure-icon', '.plate.added-right',
    'body.compact .set', '@media print', '@media (prefers-reduced-motion: reduce)',
    '.update-toast', '.visually-hidden',
  ]) assert.match(css, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(css, /#startDetails\s+summary::before/);
});

test('UI source contains every follow-up fix', () => {
  const app = read('plateloader.js');
  const state = read('state.js');
  assert.match(state, /state\.input = String\(params\.w\)\.replace\(\/\\r\\n\?\/g, '\\n'\);/);
  assert.doesNotMatch(state, /replace\(\/,\/g, '\\n'\)/);
  assert.match(app, /stateLib\.clampInteger\(value, 0, STOCK_MAX, DEFAULT_STOCK\)/);
  assert.doesNotMatch(app, /\bn\s*\|\s*0\b/);
  assert.match(app, /startDetails\.open = Boolean\(startStack && startStack\.length\)/);
  assert.match(app, /stateLib\.generateWarmup/);
  assert.match(app, /stateLib\.describeBar/);
  assert.match(app, /warmupDialog\.open \|\| warmupDialog\.hasAttribute\('open'\)/);
  assert.match(app, /announceStatus\(`Results updated:/);
});

test('service worker waits for explicit update activation', () => {
  const sw = read('sw.js');
  assert.match(sw, /CACHE_VERSION = `\$\{CACHE_PREFIX\}v13`/);
  const installBlock = sw.match(/self\.addEventListener\('install',[\s\S]*?\n\}\);/)[0];
  assert.doesNotMatch(installBlock, /skipWaiting/);
  assert.match(sw, /event\.data\.type === 'SKIP_WAITING'/);
});

test('losslessly recompressed icons retain exact RGBA pixels and dimensions', () => {
  const expected = {
    'plateloader-180.png': [180, 180, '4155e7a5bb36573a1ee5a6f514b3e59707fc66e903fb0d6cb835a2c1c383f1d8', 3168],
    'plateloader-192.png': [192, 192, '5620a7bdc79b2e931a96dfe789e2c456e78a1bb1896c960c2d0060d56b0d15f8', 3341],
    'plateloader-512-maskable.png': [512, 512, 'ce2bfc8c57d6731e7d5ee4b06b6d627c3025a8c35bfeb8c868be28390107fc3d', 9004],
    'plateloader-512.png': [512, 512, '14c4ec12dc8c3760f8f1f066b65889db0b4a586bbf7c36236374adbaf541942a', 9008],
  };
  for (const [name, [width, height, pixelHash, oldSize]] of Object.entries(expected)) {
    const file = path.join(root, 'icons', name);
    const decoded = decodeIndexedPng(file);
    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    assert.equal(sha256(decoded.rgba), pixelHash);
    assert.ok(fs.statSync(file).size < oldSize, `${name} was not reduced`);
  }
});

test('all deliberately duplicated font files remain byte-for-byte unchanged', () => {
  const expected = {
    'BebasNeue-400.woff2': 'a7c90c89240c134f7fdd33d40c000ec90b79d675ea53e8cc5a6d423c073de412',
    'Inter-400.woff2': '3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62',
    'Inter-500.woff2': '3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62',
    'Inter-600.woff2': '3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62',
    'JetBrainsMono-400.woff2': '83c005d49d8a6a50474c73a5a36ac0468076e9c4a29da7bdb14995d80560a5be',
    'JetBrainsMono-700.woff2': '83c005d49d8a6a50474c73a5a36ac0468076e9c4a29da7bdb14995d80560a5be',
  };
  for (const [name, hash] of Object.entries(expected)) {
    assert.equal(sha256(fs.readFileSync(path.join(root, 'fonts', name))), hash, name);
  }
});

test('fixed-output production build is deterministic, minified and complete', () => {
  let result = runBuild();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const first = fileTreeHashes(path.join(root, '_site'));
  result = runBuild();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const second = fileTreeHashes(path.join(root, '_site'));
  assert.deepEqual(second, first);

  const expectedFiles = [
    'index.html', 'plateloader.css', 'plateloader.js', 'state.js', 'algo.js',
    'algo-worker.js', 'manifest.json', 'sw.js',
  ];
  for (const file of expectedFiles) assert.ok(first.has(file), file);
  assert.equal(first.has('plateloader.html'), false);

  for (const file of expectedFiles) {
    const sourceSize = fs.statSync(path.join(root, file)).size;
    const builtSize = fs.statSync(path.join(root, '_site', file)).size;
    assert.ok(builtSize < sourceSize, `${file}: ${builtSize} is not smaller than ${sourceSize}`);
  }

  for (const file of ['plateloader.js', 'state.js', 'algo.js', 'algo-worker.js', 'sw.js']) {
    const parsed = spawnSync(process.execPath, ['--check', path.join('_site', file)], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(parsed.status, 0, `${file}: ${parsed.stderr}`);
  }
});

test('builder refuses custom output paths and symlinked _site targets', () => {
  const custom = runBuild('somewhere-else');
  assert.notEqual(custom.status, 0);
  assert.match(custom.stderr, /fixed at _site/);

  if (process.platform !== 'win32') {
    const site = path.join(root, '_site');
    const backup = path.join(root, '_site-test-backup');
    fs.rmSync(backup, { recursive: true, force: true });
    if (fs.existsSync(site)) fs.renameSync(site, backup);
    try {
      fs.symlinkSync(root, site, 'dir');
      const linked = runBuild();
      assert.notEqual(linked.status, 0);
      assert.match(linked.stderr, /symlinked build output/);
    } finally {
      fs.rmSync(site, { force: true });
      if (fs.existsSync(backup)) fs.renameSync(backup, site);
    }
  }
});

test('all source JavaScript parses under Node', () => {
  for (const file of [
    'algo.js', 'state.js', 'plateloader.js', 'algo-worker.js', 'sw.js', 'scripts/build-site.js',
  ]) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});
