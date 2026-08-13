'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const runBuild = (...args) => spawnSync(process.execPath, ['scripts/build-site.js', ...args], {
  cwd: root,
  encoding: 'utf8',
});
const textAssets = [
  'index.html', 'plateloader.css', 'plateloader.js', 'state.js',
  'algo.js', 'algo-worker.js', 'sw.js', 'manifest.json',
];

function fileTreeHashes(directory) {
  const output = new Map();
  const visit = (current, relativeRoot = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const relative = path.join(relativeRoot, entry.name);
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else output.set(relative, sha256(fs.readFileSync(absolute)));
    }
  };
  visit(directory);
  return output;
}

function listFiles(directory, relativeRoot = directory) {
  const files = [];
  const visit = (current, relative) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const absolute = path.join(current, entry.name);
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(absolute, childRelative);
      else files.push(childRelative);
    }
  };
  visit(path.join(root, directory), relativeRoot);
  return files;
}

function expectedBuildId() {
  const hash = crypto.createHash('sha256');
  const files = [
    ...textAssets,
    ...listFiles('fonts'),
    ...listFiles('icons'),
  ].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  for (const file of files) {
    hash.update(file.split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

function pngDimensions(file) {
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test('HTML copy, optimisation semantics and accessibility match the application behavior', () => {
  const html = read('index.html');
  assert.equal(fs.existsSync(path.join(root, 'plateloader.html')), false);
  assert.doesNotMatch(html, /<style\b|\sstyle=/i);
  assert.match(html, /id="outputStatus"[^>]*role="status"/);
  assert.match(html, /Sublinear: discounts heavier plates[^<]*fewer larger plates/);
  assert.match(html, /Valid sets are globally optimised[^<]*invalid entries are skipped/);
  assert.match(html, /<link rel="canonical" href="https:\/\/senegrom\.github\.io\/plateloader\/"\/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/senegrom\.github\.io\/plateloader\/"\/>/);
  assert.match(html, /<meta name="twitter:card" content="summary"\/>/);
  assert.match(html, /<main class="wrap">/);
  assert.doesNotMatch(html, /<script src="algo\.js"/);
  assert.match(html, /data-mode="count"[^>]*tabindex="0"/);
  assert.equal((html.match(/tabindex="-1"/g) || []).length, 2);

  const summary = html.match(/<summary>[\s\S]*?<\/summary>/)?.[0];
  assert.ok(summary, 'starting-stack summary missing');
  assert.doesNotMatch(summary, /startClear/);
  assert.match(html, /id="startClear"[^>]*>Clear starting stack<\/button>/);
  assert.match(html, /id="startTotal"[^>]*>20 kg bar only<\/span>/);
  assert.match(html, /id="monotonicToggle"[^>]*aria-describedby="constraintNotice"/);
  assert.match(html, /id="constraintNotice"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /at or below 50%, 70%, 85% and 95%, plus the exact 100% target/);
});

test('CSS retains required behavior, safe areas and no unused text-input selectors', () => {
  const css = read('plateloader.css');
  for (const selector of [
    '.disclosure-icon', '#startDetails[open] .disclosure-icon', '.plate.added-right',
    'body.compact .set', '@media print', '@media (prefers-reduced-motion: reduce)',
    '.update-toast', '.visually-hidden', '.invalid-msg .skip-note', '.constraint-notice',
  ]) assert.match(css, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(css, /input\[type=text\]/);
  assert.match(css, /env\(safe-area-inset-top\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /color-scheme:\s*dark/);
});

test('UI source covers lifecycle persistence, compact worker state and stock-aware warm-ups', () => {
  const app = read('plateloader.js');
  const worker = read('algo-worker.js');
  assert.match(app, /this entry does not change the bar, so valid sets remain optimised together/);
  assert.match(app, /const moveLabel = \(n\) => `\$\{n\} move/);
  assert.match(app, /BAR === 0 \? 'No plates · 0 kg'/);
  assert.match(app, /const emptyLoadLabel = \(\) => BAR === 0 \? 'no plates' : 'bar only'/);
  assert.match(app, /stateLib\.minTotalWeight/);
  assert.match(app, /stateLib\.maxTotalWeight/);
  assert.match(app, /effectivePlateMax/);
  assert.match(app, /updateWarmupConstraints\(\);[\s\S]*return changed/);
  assert.match(app, /window\.addEventListener\('pagehide', flushPersistence\)/);
  assert.match(app, /const schedulePersist = \(\) =>/);
  assert.match(app, /let inflightReqId = null/);
  assert.doesNotMatch(app, /inflightReqs|indicatorTimers/);
  assert.match(app, /document\.createDocumentFragment\(\)/);
  assert.match(app, /out\.replaceChildren\(fragment\)/);
  assert.match(app, /warmupTarget\.reportValidity\(\)/);
  assert.match(app, /maxTotalWeight\([\s\S]*MAX_TOTAL_KG/);
  assert.ok(app.includes('<span role="status">New version available.</span>'));
  assert.doesNotMatch(app, /toast\.setAttribute\('role', 'status'\)/);
  assert.match(app, /one final unload after every user row/);
  assert.match(app, /stateLib\.isMonotonicStack/);
  assert.match(app, /function renderComputeError\(error\)/);
  assert.match(app, /function ensureSyncAlgoLib\(\)/);
  assert.match(app, /error \|\| !Array\.isArray\(results\)/);
  assert.match(app, /if \(location\.hash\) return/);
  assert.match(app, /worker\.postMessage\([\s\S]*catch \(error\)/);
  assert.match(app, /results\.length === weights\.length \+ 1/);
  assert.doesNotMatch(app, /startStack\.sort|startStack = startStack\.slice\(\)\.sort/);
  assert.doesNotMatch(app, /removedIdx|addedIdx|r\.counts|r\.isStart/);
  assert.match(worker, /const hasStart = Boolean/);
  assert.match(worker, /results\.length === requestedCount \+ 1/);
});

test('the optimiser uses collision-free compact state and exact branch pruning', () => {
  const algorithm = read('algo.js');
  assert.match(algorithm, /const feasibilityCache = new Map\(\)/);
  assert.match(algorithm, /const multipliers = new Array\(NP\)/);
  assert.match(algorithm, /function createMembership\(\)/);
  assert.match(algorithm, /new Uint32Array/);
  assert.match(algorithm, /const suffixMaximumUnits/);
  assert.match(algorithm, /const suffixDenominationGcd/);
  assert.match(algorithm, /const packMemoKey = numericMemoKeys/);
  assert.match(algorithm, /prefixKey \+ multipliers\[plateIndex\]/);
  assert.match(algorithm, /maximumTargetUnits/);
  assert.match(algorithm, /Compute the downward closure once/);
  assert.match(algorithm, /function evaluate\(start, end, prefixKey, prefixUnits, recordChoices\)/);
  assert.match(algorithm, /Monotonic starting stack must be ordered heaviest to lightest/);
  assert.match(algorithm, /const userSetOffset = startStack \? 1 : 0/);
  assert.doesNotMatch(algorithm, /memoChoices|const fKey|combos:|comboKeys/);
  assert.doesNotMatch(algorithm, /c\[0\]<<24|four-bit-per-count limit/);
  assert.doesNotMatch(algorithm, /removedIdx|addedIdx|perSideMoves:|isEnd|isStart:/);
});

test('the builder removes the CodeQL finding and produces deterministic source-faithful output', () => {
  const builder = read('scripts/build-site.js');
  assert.doesNotMatch(builder, /minifyHtml|minifyCss|minifyJavaScript/);
  assert.doesNotMatch(builder, /package\.json/);
  assert.doesNotMatch(builder, /<!--\(\?!|\[\\s\\S\]\*\?/);
  assert.match(builder, /BUILD_PLACEHOLDER/);
  assert.match(builder, /renameBuildPath\(temporaryOutput, output\)/);
  assert.match(builder, /RENAME_RETRY_CODES/);
  assert.match(builder, /_site\.lock/);
  assert.match(builder, /owner\.runId !== runId/);
  assert.match(builder, /recoverInterruptedBuild/);

  const staleTemp = path.join(root, '_site.tmp-stale-test');
  const staleOld = path.join(root, '_site.old-stale-test');
  fs.mkdirSync(staleTemp, { recursive: true });
  fs.mkdirSync(staleOld, { recursive: true });
  const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(staleTemp, staleDate, staleDate);
  fs.utimesSync(staleOld, staleDate, staleDate);

  let result = runBuild();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(staleTemp), false);
  assert.equal(fs.existsSync(staleOld), false);
  const first = fileTreeHashes(path.join(root, '_site'));

  result = runBuild();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const second = fileTreeHashes(path.join(root, '_site'));
  assert.deepEqual(second, first);

  for (const file of textAssets) assert.ok(first.has(file), file);
  for (const file of textAssets.filter((file) => file !== 'sw.js')) {
    assert.deepEqual(
      fs.readFileSync(path.join(root, '_site', file)),
      fs.readFileSync(path.join(root, file)),
      `${file} should be copied without semantic rewriting`,
    );
  }

  const builtWorker = fs.readFileSync(path.join(root, '_site', 'sw.js'), 'utf8');
  assert.doesNotMatch(builtWorker, /__PLATELOADER_BUILD_ID__/);
  assert.match(builtWorker, new RegExp(`const BUILD_ID = '${expectedBuildId()}'`));
});

test('the builder refuses custom output paths and symlinked _site targets', () => {
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
      assert.match(linked.stderr, /invalid build output/);
    } finally {
      fs.rmSync(site, { force: true });
      if (fs.existsSync(backup)) fs.renameSync(backup, site);
    }
  }
});

test('the builder serializes writers and restores an interrupted backup before validation', () => {
  const lock = path.join(root, '_site.lock');
  fs.rmSync(lock, { recursive: true, force: true });
  fs.mkdirSync(lock);
  let result = runBuild();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Another build appears to be running/);
  fs.rmSync(lock, { recursive: true, force: true });

  fs.mkdirSync(lock);
  const staleLockDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(lock, staleLockDate, staleLockDate);
  result = runBuild();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(lock), false);

  const site = path.join(root, '_site');
  const interruptedBackup = path.join(root, '_site.old-recovery-test');
  const manifest = path.join(root, 'manifest.json');
  const heldManifest = path.join(root, 'manifest.json.recovery-test');
  fs.rmSync(interruptedBackup, { recursive: true, force: true });
  fs.rmSync(heldManifest, { force: true });
  const before = fileTreeHashes(site);
  fs.renameSync(site, interruptedBackup);
  fs.renameSync(manifest, heldManifest);
  try {
    result = runBuild();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid build source file/);
    assert.equal(fs.existsSync(site), true, 'last good site should be restored');
    assert.deepEqual(fileTreeHashes(site), before);
  } finally {
    if (fs.existsSync(heldManifest)) fs.renameSync(heldManifest, manifest);
    fs.rmSync(interruptedBackup, { recursive: true, force: true });
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test('committed icons retain their compressed hashes and declared dimensions', () => {
  const expected = {
    'plateloader-180.png': [180, 180, '18afefdc2daa895e4be35685d3d81e422f093ab1109d4fb70a41a03426b229f1'],
    'plateloader-192.png': [192, 192, '0b18bb505333ad69fb8a0746d91471715270ad2d93db35ceb9e2da5fa038c105'],
    'plateloader-512-maskable.png': [512, 512, '2e388bd6f4494ed105a0c5a9b2ef8a0d2c618559431697bf3b7f32801ec212e9'],
    'plateloader-512.png': [512, 512, 'abe366adbf6e874f40b0ef092c15b6b32fa49bee2264203c1821d7ae75057c5d'],
  };
  for (const [name, [width, height, hash]] of Object.entries(expected)) {
    const file = path.join(root, 'icons', name);
    assert.deepEqual(pngDimensions(file), [width, height]);
    assert.equal(sha256(fs.readFileSync(file)), hash, name);
  }
});

test('font assets contain one copy of each payload', () => {
  const expected = {
    'BebasNeue-400.woff2': 'a7c90c89240c134f7fdd33d40c000ec90b79d675ea53e8cc5a6d423c073de412',
    'Inter-400.woff2': '3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62',
    'JetBrainsMono-400.woff2': '83c005d49d8a6a50474c73a5a36ac0468076e9c4a29da7bdb14995d80560a5be',
  };
  assert.deepEqual(fs.readdirSync(path.join(root, 'fonts')).sort(), Object.keys(expected).sort());
  assert.equal(new Set(Object.values(expected)).size, Object.keys(expected).length);
  for (const [name, hash] of Object.entries(expected)) {
    assert.equal(sha256(fs.readFileSync(path.join(root, 'fonts', name))), hash, name);
  }
});

test('CI builds once, deploys the tested artifact and keeps the deploy job lean', () => {
  const workflow = read('.github/workflows/pages.yml').replace(/\r\n?/g, '\n');
  assert.equal((workflow.match(/actions\/checkout@/g) || []).length, 1);
  assert.equal((workflow.match(/actions\/setup-node@/g) || []).length, 1);
  assert.match(workflow, /\n  build:\n/);
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /Run regression tests[\s\S]*Prepare static site[\s\S]*Upload GitHub Pages artifact/);
  const deployBlock = workflow.split('\n  deploy:\n')[1];
  assert.doesNotMatch(deployBlock, /checkout|setup-node|npm run build/);
  assert.match(deployBlock, /actions\/deploy-pages@v4/);
});

test('package metadata and documentation describe the exact optimiser', () => {
  const packageJson = JSON.parse(read('package.json'));
  const readme = read('README.md');
  assert.equal(packageJson.version, '1.3.1');
  assert.match(readme, /Invalid entries remain visible but are skipped as physical states/);
  assert.match(readme, /does not use a heuristic or complexity guard/);
  assert.match(readme, /Σ√kg moved/);
  assert.match(readme, /collision-free mixed-radix state encoding/);
  assert.match(readme, /crash-recoverable/);
  assert.match(readme, /immutable and isolated/);
  assert.match(readme, /projected downward/);
  assert.match(readme, /rejected rather than silently rearranged/);
  assert.equal(JSON.parse(read('manifest.json')).id, './');
});

test('all source and built JavaScript parses under Node', () => {
  let result = runBuild();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const file of [
    'algo.js', 'state.js', 'plateloader.js', 'algo-worker.js', 'sw.js', 'scripts/build-site.js',
  ]) {
    result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
  for (const file of ['algo.js', 'state.js', 'plateloader.js', 'algo-worker.js', 'sw.js']) {
    result = spawnSync(process.execPath, ['--check', path.join('_site', file)], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `_site/${file}: ${result.stderr}`);
  }
});
