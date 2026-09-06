'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const runBuild = (...args) => spawnSync(process.execPath, ['scripts/build-site.js', ...args], {
  cwd: root,
  encoding: 'utf8',
});
const runtimeFiles = [
  'index.html', 'plateloader.css', 'plateloader.js', 'state.js',
  'algo.js', 'algo-worker.js', 'sw.js', 'manifest.json',
];

function fileTree(directory) {
  const output = new Map();
  const visit = (current, relativeRoot = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = path.join(relativeRoot, entry.name);
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else output.set(relative, sha256(fs.readFileSync(absolute)));
    }
  };
  visit(directory);
  return output;
}

function pngDimensions(file) {
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test('document structure is external-only, share-safe and accessible', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /<style\b|\sstyle=/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /unsafe-inline/);
  assert.match(html, /id="skipToResults"[^>]*href="#results"/);
  assert.match(html, /<main class="wrap" id="mainContent">/);
  assert.match(html, /<section id="results"[^>]*aria-labelledby="resultsHeading"[^>]*aria-busy="false"[^>]*tabindex="-1"/);
  assert.match(html, /id="stockSlider"[^>]*data-stock="2"/);
  assert.match(html, /id="shareStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /id="shareBtn"[^>]*aria-live=/);
  assert.match(html, /id="customStockToggle"[^>]*aria-controls="customStockInputs"/);
  assert.match(html, /id="customStockInputs"[^>]*role="group"/);
  assert.match(html, /id="input"[^>]*maxlength="4096"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/senegrom\.github\.io\/plateloader\/"\/>/);
});

test('build is deterministic, source-faithful and contains only runtime assets', () => {
  let result = runBuild();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const first = fileTree(path.join(root, '_site'));

  result = runBuild();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(fileTree(path.join(root, '_site')), first);

  const rootFiles = fs.readdirSync(path.join(root, '_site'), { withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  assert.deepEqual(rootFiles, runtimeFiles.slice().sort());
  for (const file of runtimeFiles.filter((name) => name !== 'sw.js')) {
    assert.deepEqual(
      fs.readFileSync(path.join(root, '_site', file)),
      fs.readFileSync(path.join(root, file)),
      file,
    );
  }
  assert.doesNotMatch(read('_site/sw.js'), /__PLATELOADER_BUILD_ID__/);
  assert.match(read('_site/sw.js'), /const BUILD_ID = '[a-f0-9]{16}';/);
});

test('builder rejects unsafe targets and recovers the last good site', () => {
  const custom = runBuild('elsewhere');
  assert.notEqual(custom.status, 0);
  assert.match(custom.stderr, /fixed at _site/);

  const lock = path.join(root, '_site.lock');
  fs.rmSync(lock, { recursive: true, force: true });
  fs.mkdirSync(lock);
  let result = runBuild();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Another build appears to be running/);
  fs.rmSync(lock, { recursive: true, force: true });

  fs.mkdirSync(lock);
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(lock, stale, stale);
  result = runBuild();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(lock), false);

  const site = path.join(root, '_site');
  const backup = path.join(root, '_site.old-recovery-test');
  const manifest = path.join(root, 'manifest.json');
  const heldManifest = path.join(root, 'manifest.json.recovery-test');
  fs.rmSync(backup, { recursive: true, force: true });
  fs.rmSync(heldManifest, { force: true });
  const before = fileTree(site);
  fs.renameSync(site, backup);
  fs.renameSync(manifest, heldManifest);
  try {
    result = runBuild();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid build source file/);
    assert.deepEqual(fileTree(site), before);
  } finally {
    if (fs.existsSync(heldManifest)) fs.renameSync(heldManifest, manifest);
    fs.rmSync(backup, { recursive: true, force: true });
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test('builder refuses a symlinked output where the platform permits it', () => {
  if (process.platform === 'win32') return;
  const site = path.join(root, '_site');
  const backup = path.join(root, '_site-test-backup');
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(site)) fs.renameSync(site, backup);
  try {
    fs.symlinkSync(root, site, 'dir');
    const result = runBuild();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid build output/);
  } finally {
    fs.rmSync(site, { force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, site);
  }
});

test('assets stay compact without pinning replaceable byte hashes', () => {
  const icons = {
    'plateloader-180.png': [180, 180],
    'plateloader-192.png': [192, 192],
    'plateloader-512-maskable.png': [512, 512],
    'plateloader-512.png': [512, 512],
  };
  let iconBytes = 0;
  for (const [name, dimensions] of Object.entries(icons)) {
    const file = path.join(root, 'icons', name);
    assert.deepEqual(pngDimensions(file), dimensions, name);
    iconBytes += fs.statSync(file).size;
  }
  assert.ok(iconBytes < 20_000, `icon payload is ${iconBytes} bytes`);

  const fontNames = fs.readdirSync(path.join(root, 'fonts')).sort();
  assert.deepEqual(fontNames, [
    'BebasNeue-400.woff2', 'Inter-400.woff2', 'JetBrainsMono-400.woff2',
  ]);
  const fontPayloads = fontNames.map((name) => fs.readFileSync(path.join(root, 'fonts', name)));
  assert.equal(new Set(fontPayloads.map(sha256)).size, fontPayloads.length);
  assert.ok(fontPayloads.reduce((sum, bytes) => sum + bytes.length, 0) < 100_000);

  const css = read('plateloader.css');
  assert.equal((css.match(/@font-face\s*\{[^}]*font-family: 'Inter'/g) || []).length, 1);
  assert.equal((css.match(/@font-face\s*\{[^}]*font-family: 'JetBrains Mono'/g) || []).length, 1);
});

test('CI tests both desktop platforms, builds once and deploys that artifact', () => {
  const workflow = read('.github/workflows/pages.yml').replace(/\r\n?/g, '\n');
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest\]/);
  assert.match(workflow, /Browser, PWA and Pages build/);
  assert.match(workflow, /npm ci --ignore-scripts[^\n]*--no-audit[^\n]*--no-fund/);
  assert.match(workflow, /npm run test:browser/);
  assert.equal((workflow.match(/npm run build/g) || []).length, 0);
  assert.match(workflow, /needs: \[unit, browser\]/);
  const deploy = workflow.split('\n  deploy:\n')[1];
  assert.ok(deploy);
  assert.doesNotMatch(deploy, /checkout|setup-node|npm run build/);
  assert.match(deploy, /actions\/deploy-pages@v\d+/);
});

test('metadata documents the shipped behavior', () => {
  const packageJson = JSON.parse(read('package.json'));
  const readme = read('README.md');
  assert.equal(packageJson.version, '1.6.1');
  assert.equal(packageJson.scripts['test:browser'], 'npm run build && playwright test');
  // Exact pin, no range: Dependabot may move the number, not the style.
  assert.match(packageJson.devDependencies['@playwright/test'], /^\d+\.\d+\.\d+$/);
  assert.match(readme, /optional custom-stock panel/);
  assert.match(readme, /Unit tests run on both Ubuntu and Windows/);
  assert.match(readme, /exact `\/plateloader\/` project path/);
  assert.match(readme, /does not use a heuristic or complexity guard/);
  assert.match(readme, /4,096 input characters/);
  assert.match(readme, /content-security policy/);
});

test('committed text uses LF and all JavaScript parses under Node', () => {
  const textFiles = [
    '.gitattributes', '.github/dependabot.yml', '.github/workflows/pages.yml', '.gitignore', 'README.md',
    'index.html', 'manifest.json', 'package.json', 'plateloader.css',
    'plateloader.js', 'playwright.config.js', 'state.js', 'algo.js',
    'algo-worker.js', 'sw.js', 'scripts/build-site.js', 'tests/browser.spec.js',
    'tests/mobile.spec.js', 'tests/review.test.js', 'tests/serve-site.js',
  ];
  for (const file of textFiles) {
    assert.equal(fs.readFileSync(path.join(root, file)).includes(13), false, file);
  }
  for (const file of textFiles.filter((name) => name.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});
