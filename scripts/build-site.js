'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
if (process.argv.length > 2) {
  throw new Error('The build output is fixed at _site; custom output paths are not supported.');
}

const output = path.join(root, '_site');
const runId = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const temporaryOutput = `${output}.tmp-${runId}`;
const backupOutput = `${output}.old-${runId}`;
const lockDirectory = path.join(root, '_site.lock');
const LOCK_STALE_MS = 60 * 60 * 1000;
const BUILD_STALE_MS = 24 * 60 * 60 * 1000;
const BUILD_PLACEHOLDER = '__PLATELOADER_BUILD_ID__';
const RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 250];
const RENAME_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const textAssets = [
  'index.html',
  'plateloader.css',
  'plateloader.js',
  'state.js',
  'algo.js',
  'algo-worker.js',
  'sw.js',
  'manifest.json',
];
const assetDirectories = ['fonts', 'icons'];

function assertRegularFile(file) {
  const source = path.join(root, file);
  if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isFile()) {
    throw new Error(`Invalid build source file: ${source}`);
  }
}

function assertDirectory(directory) {
  const source = path.join(root, directory);
  if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isDirectory()) {
    throw new Error(`Invalid build source directory: ${source}`);
  }
  const inspect = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing to copy symbolic link: ${target}`);
      if (entry.isDirectory()) inspect(target);
      else if (!entry.isFile()) throw new Error(`Unsupported build source entry: ${target}`);
    }
  };
  inspect(source);
}

function assertOutputDirectory() {
  if (!fs.existsSync(output)) return;
  const stat = fs.lstatSync(output);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing invalid build output: ${output}`);
  }
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

function buildId() {
  const hash = crypto.createHash('sha256');
  const files = [
    ...textAssets,
    ...assetDirectories.flatMap((directory) => listFiles(directory)),
  ].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

  for (const file of files) {
    hash.update(file.split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

function removeBuildPath(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) fs.unlinkSync(target);
  else fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function renameBuildPath(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      if (!RENAME_RETRY_CODES.has(error && error.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        throw error;
      }
      Atomics.wait(RENAME_WAIT_ARRAY, 0, 0, RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function acquireBuildLock() {
  const tryAcquire = () => {
    fs.mkdirSync(lockDirectory);
    try {
      fs.writeFileSync(path.join(lockDirectory, 'owner.json'), JSON.stringify({
        runId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }));
    } catch (error) {
      removeBuildPath(lockDirectory);
      throw error;
    }
  };

  try {
    tryAcquire();
    return;
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }

  const lockStat = fs.lstatSync(lockDirectory);
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
    throw new Error(`Refusing invalid build lock: ${lockDirectory}`);
  }
  if (Date.now() - lockStat.mtimeMs <= LOCK_STALE_MS) {
    throw new Error(`Another build appears to be running: ${lockDirectory}`);
  }

  removeBuildPath(lockDirectory);
  tryAcquire();
}

function releaseBuildLock() {
  try {
    const owner = JSON.parse(
      fs.readFileSync(path.join(lockDirectory, 'owner.json'), 'utf8'),
    );
    if (!owner || owner.runId !== runId) return;
  } catch (_) {
    return;
  }
  removeBuildPath(lockDirectory);
}

function matchingBuildDirectories(kind) {
  const pattern = new RegExp(`^_site\\.${kind}-`);
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => pattern.test(entry.name))
    .map((entry) => {
      const target = path.join(root, entry.name);
      return { target, stat: fs.lstatSync(target) };
    });
}

function recoverInterruptedBuild() {
  if (fs.existsSync(output)) return;
  const backups = matchingBuildDirectories('old')
    .filter(({ stat }) => !stat.isSymbolicLink() && stat.isDirectory())
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  if (backups.length > 0) renameBuildPath(backups[0].target, output);
}

function pruneStaleBuildDirectories() {
  const cutoff = Date.now() - BUILD_STALE_MS;
  for (const kind of ['tmp', 'old']) {
    for (const { target, stat } of matchingBuildDirectories(kind)) {
      if (stat.mtimeMs < cutoff) removeBuildPath(target);
    }
  }
}

function writeSite() {
  acquireBuildLock();
  try {
    recoverInterruptedBuild();
    assertOutputDirectory();

    for (const file of textAssets) assertRegularFile(file);
    for (const directory of assetDirectories) assertDirectory(directory);
    fs.mkdirSync(temporaryOutput);
    const id = buildId();

    try {
      for (const file of textAssets) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        let outputText = source;
        if (file === 'sw.js') {
          const occurrences = source.split(BUILD_PLACEHOLDER).length - 1;
          if (occurrences !== 1) {
            throw new Error(`Expected one ${BUILD_PLACEHOLDER} marker in sw.js; found ${occurrences}.`);
          }
          outputText = source.replace(BUILD_PLACEHOLDER, id);
        }
        fs.writeFileSync(path.join(temporaryOutput, file), outputText);
      }

      for (const directory of assetDirectories) {
        fs.cpSync(path.join(root, directory), path.join(temporaryOutput, directory), { recursive: true });
      }

      let backedUp = false;
      if (fs.existsSync(output)) {
        renameBuildPath(output, backupOutput);
        backedUp = true;
      }

      try {
        renameBuildPath(temporaryOutput, output);
      } catch (error) {
        if (backedUp && !fs.existsSync(output)) renameBuildPath(backupOutput, output);
        throw error;
      }

      if (backedUp) removeBuildPath(backupOutput);
      pruneStaleBuildDirectories();
    } catch (error) {
      removeBuildPath(temporaryOutput);
      if (fs.existsSync(backupOutput) && !fs.existsSync(output)) {
        renameBuildPath(backupOutput, output);
      }
      throw error;
    }
  } finally {
    releaseBuildLock();
  }
}

writeSite();
