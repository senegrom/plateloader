'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
if (process.argv.length > 2) {
  throw new Error('The build output is fixed at _site; custom output paths are not supported.');
}

const output = path.join(root, '_site');
const temporaryOutput = `${output}.tmp-${process.pid}`;
const backupOutput = `${output}.old-${process.pid}`;
const BUILD_PLACEHOLDER = '__PLATELOADER_BUILD_ID__';
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

function buildId() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const hash = crypto.createHash('sha256');
  const files = [
    ...textAssets,
    ...assetDirectories.flatMap((directory) => listFiles(directory)),
  ].sort();

  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, file)));
    hash.update('\0');
  }
  return `v${packageJson.version}-${hash.digest('hex').slice(0, 12)}`;
}

function cleanStaleBuildDirectories() {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!/^_site\.(?:tmp|old)-/.test(entry.name)) continue;
    fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
  }
}

function writeSite() {
  for (const file of textAssets) assertRegularFile(file);
  for (const directory of assetDirectories) assertDirectory(directory);

  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) {
    throw new Error(`Refusing symlinked build output: ${output}`);
  }

  cleanStaleBuildDirectories();
  fs.mkdirSync(temporaryOutput, { recursive: true });
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
      fs.renameSync(output, backupOutput);
      backedUp = true;
    }

    try {
      fs.renameSync(temporaryOutput, output);
    } catch (error) {
      if (backedUp && !fs.existsSync(output)) fs.renameSync(backupOutput, output);
      throw error;
    }

    if (backedUp) fs.rmSync(backupOutput, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(temporaryOutput, { recursive: true, force: true });
    if (fs.existsSync(backupOutput) && !fs.existsSync(output)) {
      fs.renameSync(backupOutput, output);
    }
    throw error;
  }
}

writeSite();
