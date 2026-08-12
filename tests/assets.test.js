'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const runBuild = (output) => spawnSync(process.execPath, ['scripts/build-site.js', output], {
  cwd: root,
  encoding: 'utf8',
});

test('HTML is a small asset-backed shell with no inline styling', () => {
  const html = read('plateloader.html');
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.match(html, /<link rel="stylesheet" href="plateloader\.css"\/>/);
  assert.match(html, /<script src="algo\.js" defer><\/script>\s*<script src="state\.js" defer><\/script>\s*<script src="plateloader\.js" defer><\/script>/);
  assert.match(html, /id="startRemove"[^>]*disabled/);
  assert.match(html, /use Remove outermost on touch/);
  assert.match(html, /id="summaryPanel" hidden/);
  assert.ok(Buffer.byteLength(html) < 10_000, 'HTML should remain a small document shell');
  assert.ok(Buffer.byteLength(read('plateloader.css')) > 20_000, 'extracted stylesheet appears incomplete');
});

test('the optimiser worker is a real file rather than a generated Blob', () => {
  const app = read('plateloader.js');
  const worker = read('algo-worker.js');
  assert.match(app, /new Worker\('algo-worker\.js'\)/);
  assert.doesNotMatch(app, /ALGO_WORKER_SOURCE|createObjectURL|new Blob|buildAlgoLib\.toString/);
  assert.match(worker, /importScripts\('algo\.js'\)/);
  assert.match(worker, /algoLib\.optimize/);
});

test('UI regressions remain fixed without changing optimiser complexity', () => {
  const app = read('plateloader.js');
  assert.match(app, /stateLib\.stateFromHash\(hash, DEFAULT_STATE\)/);
  assert.match(app, /userSetCount = Math\.max\(0, results\.length - \(hasStart \? 1 : 0\)\)/);
  assert.match(app, /userSetCount !== validSets/);
  assert.match(app, /encodeURIComponent\(input\)/);
  assert.match(app, /\+\+currentReqId;\s*\/\/ invalidate any result already in flight before the debounce fires/);
  assert.match(app, /inflightReqs\.size > 0\) disposeAlgoWorker\(true\)/);
  assert.match(app, /animateChanges: !isStartingState/);
  assert.match(app, /function closeWarmupDialog\(\)/);
  assert.match(app, /warmupDialog\.removeAttribute\('open'\)/);
  assert.match(app, /document\.execCommand\('copy'\) === true/);
  assert.match(app, /attemptId !== copyAttemptId/);
  assert.match(app, /showShareFeedback\(copied \? 'Copied!' : 'Copy failed'/);
  assert.match(app, /Remove outermost \(\$\{PLATES\[/);
  assert.doesNotMatch(app, /beforeunload/);
});

test('the app shell and manifest omit obsolete deployment entries', () => {
  const serviceWorker = read('sw.js');
  const manifest = JSON.parse(read('manifest.json'));

  for (const asset of ['index.html', 'plateloader.css', 'state.js', 'algo-worker.js']) {
    assert.match(serviceWorker, new RegExp(`'${asset.replace('.', '\\.')}'`));
  }
  assert.doesNotMatch(serviceWorker, /plateloader-test|plateloader\.html/);
  assert.match(serviceWorker, /name\.startsWith\(CACHE_PREFIX\)/);
  assert.match(serviceWorker, /event\.waitUntil\(refreshPromise\)/);
  assert.equal('orientation' in manifest, false);
  assert.equal(manifest.icons.some((icon) => icon.src.endsWith('180.png')), false);
  assert.equal(manifest.icons.some((icon) => icon.purpose === 'any'), false);
  assert.ok(fs.existsSync(path.join(root, 'icons', 'plateloader-180.png')), 'Apple touch icon must remain');
  assert.equal(fs.existsSync(path.join(root, 'plateloader-test.html')), false);
});

test('the build emits one HTML document and every required app asset', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plateloader-build-'));
  const output = path.join(tempRoot, 'site');
  const result = runBuild(output);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const expectedFiles = [
    'index.html',
    'plateloader.css',
    'plateloader.js',
    'state.js',
    'algo.js',
    'algo-worker.js',
    'manifest.json',
    'sw.js',
  ];
  for (const file of expectedFiles) assert.ok(fs.existsSync(path.join(output, file)), file);
  assert.equal(fs.existsSync(path.join(output, 'plateloader.html')), false);
  assert.ok(fs.existsSync(path.join(output, 'fonts', 'Inter-500.woff2')));
  assert.ok(fs.existsSync(path.join(output, 'fonts', 'Inter-600.woff2')));
  assert.ok(fs.existsSync(path.join(output, 'fonts', 'JetBrainsMono-700.woff2')));

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('the build refuses unsafe or mixed-content output directories', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plateloader-build-safety-'));
  const mixed = path.join(tempRoot, 'mixed');
  fs.mkdirSync(mixed);
  fs.writeFileSync(path.join(mixed, 'keep.txt'), 'do not delete');
  const mixedResult = runBuild(mixed);
  assert.notEqual(mixedResult.status, 0);
  assert.equal(fs.readFileSync(path.join(mixed, 'keep.txt'), 'utf8'), 'do not delete');

  const wrongType = path.join(tempRoot, 'wrong-type');
  fs.mkdirSync(path.join(wrongType, 'index.html'), { recursive: true });
  const wrongTypeResult = runBuild(wrongType);
  assert.notEqual(wrongTypeResult.status, 0);
  assert.ok(fs.statSync(path.join(wrongType, 'index.html')).isDirectory());

  if (process.platform !== 'win32') {
    const repoLink = path.join(tempRoot, 'repo-link');
    fs.symlinkSync(root, repoLink, 'dir');
    const linkedResult = runBuild(path.join(repoLink, 'scripts'));
    assert.notEqual(linkedResult.status, 0);
    assert.ok(fs.existsSync(path.join(root, 'scripts', 'build-site.js')));
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('the deliberately duplicated font files are retained unchanged', () => {
  const inter400 = fs.readFileSync(path.join(root, 'fonts', 'Inter-400.woff2'));
  const inter500 = fs.readFileSync(path.join(root, 'fonts', 'Inter-500.woff2'));
  const inter600 = fs.readFileSync(path.join(root, 'fonts', 'Inter-600.woff2'));
  const mono400 = fs.readFileSync(path.join(root, 'fonts', 'JetBrainsMono-400.woff2'));
  const mono700 = fs.readFileSync(path.join(root, 'fonts', 'JetBrainsMono-700.woff2'));
  assert.deepEqual(inter500, inter400);
  assert.deepEqual(inter600, inter400);
  assert.deepEqual(mono700, mono400);
});

test('CI tests pull requests and deploys only the main branch', () => {
  const workflow = read('.github/workflows/pages.yml');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /\n  test:\n/);
  assert.match(workflow, /needs: test/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github\.event_name != 'pull_request'/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /timeout-minutes: 10/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /run: npm run build/);
});

test('all JavaScript files parse under Node', () => {
  for (const file of ['algo.js', 'state.js', 'plateloader.js', 'algo-worker.js', 'sw.js', 'scripts/build-site.js']) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});
