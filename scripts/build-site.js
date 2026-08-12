'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
const defaultOutput = path.join(root, '_site');
const requestedOutput = path.resolve(root, process.argv[2] || '_site');
const files = [
  'plateloader.css',
  'plateloader.js',
  'state.js',
  'algo.js',
  'algo-worker.js',
  'manifest.json',
  'sw.js',
];
const directories = ['fonts', 'icons'];

function resolveRealTarget(target) {
  const tail = [];
  let cursor = target;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    tail.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...tail);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function collectGeneratedPaths() {
  const allowed = new Map([
    ['index.html', 'file'],
    ['plateloader.html', 'file'], // legacy output removed by this build
    ...files.map((file) => [file, 'file']),
    ...directories.map((directory) => [directory, 'directory']),
  ]);
  const addDirectory = (sourceRoot, relativeRoot) => {
    for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to copy symbolic link: ${path.join(relativeRoot, entry.name)}`);
      }
      const relative = path.join(relativeRoot, entry.name);
      allowed.set(relative, entry.isDirectory() ? 'directory' : 'file');
      if (entry.isDirectory()) addDirectory(path.join(sourceRoot, entry.name), relative);
    }
  };
  for (const directory of directories) {
    addDirectory(path.join(root, directory), directory);
  }
  return allowed;
}

function assertSources() {
  for (const file of ['plateloader.html', ...files]) {
    const source = path.join(root, file);
    if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isFile()) {
      throw new Error(`Invalid build source file: ${source}`);
    }
  }
  for (const directory of directories) {
    const source = path.join(root, directory);
    if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isDirectory()) {
      throw new Error(`Invalid build source directory: ${source}`);
    }
  }
}

function assertSafeOutput(output, allowed) {
  if (fs.existsSync(requestedOutput) && fs.lstatSync(requestedOutput).isSymbolicLink()) {
    throw new Error(`Refusing symlinked build output: ${requestedOutput}`);
  }
  if (isWithin(output, root)) {
    throw new Error(`Refusing to replace repository or an ancestor: ${output}`);
  }
  if (isWithin(root, output) && output !== defaultOutput) {
    throw new Error(`Only ${defaultOutput} may be replaced inside the repository.`);
  }
  if (!fs.existsSync(output)) return;
  if (!fs.statSync(output).isDirectory()) {
    throw new Error(`Build output exists and is not a directory: ${output}`);
  }

  const unexpected = [];
  const inspect = (directory, relativeRoot = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = path.join(relativeRoot, entry.name);
      const type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
      if (entry.isSymbolicLink() || allowed.get(relative) !== type) {
        unexpected.push(relative);
        continue;
      }
      if (entry.isDirectory()) inspect(path.join(directory, entry.name), relative);
    }
  };
  inspect(output);
  if (unexpected.length) {
    throw new Error(`Refusing to delete non-build files in ${output}: ${unexpected.join(', ')}`);
  }
}

const output = resolveRealTarget(requestedOutput);
assertSources();
const generatedPaths = collectGeneratedPaths();
assertSafeOutput(output, generatedPaths);
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(root, 'plateloader.html'), path.join(output, 'index.html'));
for (const file of files) fs.copyFileSync(path.join(root, file), path.join(output, file));
for (const directory of directories) {
  fs.cpSync(path.join(root, directory), path.join(output, directory), { recursive: true });
}
