'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
if (process.argv.length > 2) {
  throw new Error('The build output is fixed at _site; custom output paths are not supported.');
}
const output = path.join(root, '_site');
const temporaryOutput = `${output}.tmp-${process.pid}`;
const textAssets = [
  ['index.html', minifyHtml],
  ['plateloader.css', minifyCss],
  ['plateloader.js', minifyJavaScript],
  ['state.js', minifyJavaScript],
  ['algo.js', minifyJavaScript],
  ['algo-worker.js', minifyJavaScript],
  ['sw.js', minifyJavaScript],
  ['manifest.json', minifyJson],
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

function minifyHtml(source) {
  return source
    .replace(/<!--(?!\[if)[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function minifyCss(source) {
  let outputText = '';
  let quote = null;
  let escaped = false;
  let comment = false;
  let pendingSpace = false;
  const punctuation = new Set(['{', '}', ':', ';', ',', '>', '+', '~', '(', ')']);

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];

    if (comment) {
      if (character === '*' && next === '/') {
        comment = false;
        index++;
      }
      continue;
    }

    if (quote) {
      outputText += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }

    if (character === '/' && next === '*') {
      comment = true;
      index++;
      continue;
    }

    if (character === '"' || character === "'") {
      if (pendingSpace) {
        const previous = outputText.at(-1);
        if (previous && !punctuation.has(previous)) outputText += ' ';
        pendingSpace = false;
      }
      quote = character;
      outputText += character;
      continue;
    }

    if (/\s/.test(character)) {
      pendingSpace = true;
      continue;
    }

    if (pendingSpace) {
      const previous = outputText.at(-1);
      if (previous && !punctuation.has(previous) && !punctuation.has(character)) outputText += ' ';
      pendingSpace = false;
    }

    if (punctuation.has(character) && outputText.endsWith(' ')) outputText = outputText.slice(0, -1);
    outputText += character;
  }

  if (comment || quote) throw new Error('Unterminated CSS comment or string.');
  return outputText.replace(/;}/g, '}').trim();
}

function minifyJavaScript(source) {
  const outputLines = [];
  let inTemplate = false;

  for (const originalLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = originalLine.trim();
    if (!inTemplate && (trimmed === '' || trimmed.startsWith('//'))) continue;

    const line = inTemplate ? originalLine.replace(/[ \t]+$/g, '') : trimmed;
    outputLines.push(line);

    let escaped = false;
    for (let index = 0; index < originalLine.length; index++) {
      const character = originalLine[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '`') inTemplate = !inTemplate;
    }
  }

  if (inTemplate) throw new Error('Unterminated JavaScript template literal.');
  return outputLines.join('\n').trim();
}

function minifyJson(source) {
  return JSON.stringify(JSON.parse(source));
}

function build() {
  for (const [file] of textAssets) assertRegularFile(file);
  for (const directory of assetDirectories) assertDirectory(directory);

  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) {
    throw new Error(`Refusing symlinked build output: ${output}`);
  }
  if (fs.existsSync(temporaryOutput)) fs.rmSync(temporaryOutput, { recursive: true, force: true });
  fs.mkdirSync(temporaryOutput, { recursive: true });

  try {
    for (const [file, transform] of textAssets) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      fs.writeFileSync(path.join(temporaryOutput, file), transform(source));
    }
    for (const directory of assetDirectories) {
      fs.cpSync(path.join(root, directory), path.join(temporaryOutput, directory), { recursive: true });
    }

    fs.rmSync(output, { recursive: true, force: true });
    fs.renameSync(temporaryOutput, output);
  } catch (error) {
    fs.rmSync(temporaryOutput, { recursive: true, force: true });
    throw error;
  }
}

build();
