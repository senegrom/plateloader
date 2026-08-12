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

function listFiles(directory, relativeRoot = directory) {
  const files = [];
  const visit = (current, relative) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
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
  const version = JSON.parse(read('package.json')).version;
  const hash = crypto.createHash('sha256');
  const files = [
    ...textAssets,
    ...listFiles('fonts'),
    ...listFiles('icons'),
  ].sort();
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, file)));
    hash.update('\0');
  }
  return `v${version}-${hash.digest('hex').slice(0, 12)}`;
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

  const summary = html.match(/<summary>[\s\S]*?<\/summary>/)?.[0];
  assert.ok(summary, 'starting-stack summary missing');
  assert.doesNotMatch(summary, /startClear/);
  assert.match(html, /id="startClear"[^>]*>Clear starting stack<\/button>/);
  assert.match(html, /id="startTotal"[^>]*>20 kg bar only<\/span>/);
});

test('CSS retains required behavior, safe areas and no unused text-input selectors', () => {
  const css = read('plateloader.css');
  for (const selector of [
    '.disclosure-icon', '#startDetails[open] .disclosure-icon', '.plate.added-right',
    'body.compact .set', '@media print', '@media (prefers-reduced-motion: reduce)',
    '.update-toast', '.visually-hidden', '.invalid-msg .skip-note',
  ]) assert.match(css, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(css, /input\[type=text\]/);
  assert.match(css, /env\(safe-area-inset-top\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});

test('UI source covers skipped invalid rows, singular moves and warm-up validation', () => {
  const app = read('plateloader.js');
  assert.match(app, /surrounding valid sets remain globally optimised together/);
  assert.match(app, /const moveLabel = \(n\) => `\$\{n\} move/);
  assert.match(app, /startTotalEl\.textContent = `\$\{fmtKg\(BAR\)\} kg bar only`/);
  assert.match(app, /stateLib\.totalIncrement\(PLATES, sided\(\)\)/);
  assert.match(app, /warmupTarget\.reportValidity\(\)/);
  assert.match(app, /kg < minimum/);
  assert.match(app, /let pendingCleanup = null/);
  assert.match(app, /one final unload after every user row/);
  assert.doesNotMatch(app, /removedIdx|addedIdx|r\.counts/);
});

test('the optimiser shares feasibility data and uses compact numeric memo state', () => {
  const algorithm = read('algo.js');
  assert.match(algorithm, /const feasibilityCache = new Map\(\)/);
  assert.match(algorithm, /const packMemoKey =/);
  assert.match(algorithm, /prefixKey \* PREFIX_BASE/);
  assert.doesNotMatch(algorithm, /memoChoices|const fKey|combos:/);
  assert.doesNotMatch(algorithm, /\+\s*'\|'/);
  assert.match(algorithm, /removedCount/);
  assert.doesNotMatch(algorithm, /removedIdx|addedIdx|perSideMoves:|isEnd/);
});

test('the builder removes the CodeQL finding and produces deterministic source-faithful output', () => {
  const builder = read('scripts/build-site.js');
  assert.doesNotMatch(builder, /minifyHtml|minifyCss|minifyJavaScript/);
  assert.doesNotMatch(builder, /<!--\(\?!|\[\\s\\S\]\*\?/);
  assert.match(builder, /BUILD_PLACEHOLDER/);
  assert.match(builder, /renameSync\(temporaryOutput, output\)/);

  const staleTemp = path.join(root, '_site.tmp-stale-test');
  const staleOld = path.join(root, '_site.old-stale-test');
  fs.mkdirSync(staleTemp, { recursive: true });
  fs.mkdirSync(staleOld, { recursive: true });

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
      assert.match(linked.stderr, /symlinked build output/);
    } finally {
      fs.rmSync(site, { force: true });
      if (fs.existsSync(backup)) fs.renameSync(backup, site);
    }
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

test('CI builds once, deploys the tested artifact and keeps the deploy job lean', () => {
  const workflow = read('.github/workflows/pages.yml');
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
  assert.equal(packageJson.version, '1.2.0');
  assert.match(readme, /Invalid entries remain visible but are skipped as physical states/);
  assert.match(readme, /does not use a heuristic or complexity guard/);
  assert.match(readme, /Σ√kg moved/);
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
