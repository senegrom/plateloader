'use strict';

const $ = (id) => document.getElementById(id);

// ---------- plate definitions ----------
const PLATES = [
  { kg: 25,   cls: 'w-25',   label: '25'   },
  { kg: 20,   cls: 'w-20',   label: '20'   },
  { kg: 15,   cls: 'w-15',   label: '15'   },
  { kg: 10,   cls: 'w-10',   label: '10'   },
  { kg: 5,    cls: 'w-5',    label: '5'    },
  { kg: 2.5,  cls: 'w-2_5',  label: '2.5'  },
  { kg: 1.25, cls: 'w-1_25', label: '1.25' },
];
const PLATE_KG = PLATES.map((plate) => plate.kg);
const DARK_PLATE_KG = new Set([25, 20, 10, 2.5, 1.25]);
const DEFAULT_BAR = 20;
let BAR = DEFAULT_BAR;
let plateMax = PLATES.map(() => 2);

const stateLib = buildStateLib();
let algoLib = null;
let algoLibPromise = null;

// The normal path runs the exact optimiser in a worker, so avoid parsing its
// 600-line implementation on the main thread as well. Load it here only when
// workers are unavailable or fail.
function ensureSyncAlgoLib() {
  if (algoLib) return Promise.resolve(algoLib);
  if (algoLibPromise) return algoLibPromise;

  algoLibPromise = new Promise((resolve, reject) => {
    const initialise = () => {
      try {
        if (typeof buildAlgoLib !== 'function') throw new Error('Optimiser did not initialise.');
        algoLib = buildAlgoLib();
        resolve(algoLib);
      } catch (error) {
        reject(error);
      }
    };

    if (typeof buildAlgoLib === 'function') {
      initialise();
      return;
    }

    const script = document.createElement('script');
    script.src = 'algo.js';
    script.async = true;
    script.addEventListener('load', () => {
      script.remove();
      initialise();
    }, { once: true });
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error('Could not load the optimiser.'));
    }, { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    algoLibPromise = null;
    throw error;
  });

  return algoLibPromise;
}

// ---------- Web Worker for off-main-thread optimisation ----------
// Cancellation is by reqId: stale results are discarded silently.
// Sync fallback if Worker creation fails or the worker errors.
let algoWorker = null;
let workerInitTried = false;
let workerEverSucceeded = false;
let currentReqId = 0;
let inflightReqId = null;
let indicatorTimer = null;
let indicatorReqId = null;
const INDICATOR_DELAY_MS = 150;

function clearIndicator(reqId = null) {
  if (indicatorTimer === null || (reqId !== null && reqId !== indicatorReqId)) return;
  clearTimeout(indicatorTimer);
  indicatorTimer = null;
  indicatorReqId = null;
}

function disposeAlgoWorker(allowRetry) {
  if (algoWorker) {
    algoWorker.onmessage = null;
    algoWorker.onerror = null;
    try { algoWorker.terminate(); } catch (_) {}
  }
  algoWorker = null;
  workerInitTried = !allowRetry;
  clearIndicator();
  inflightReqId = null;
}

function ensureAlgoWorker() {
  if (algoWorker || workerInitTried) return algoWorker;
  workerInitTried = true;
  if (typeof Worker === 'undefined') return null;

  try {
    const worker = new Worker('algo-worker.js');
    worker.onmessage = (event) => {
      const { reqId, results, error, hasStart } = event.data || {};
      if (inflightReqId === reqId) inflightReqId = null;
      clearIndicator(reqId);
      if (reqId !== currentReqId) return;
      if (error || !Array.isArray(results)) {
        console.warn('[plate-loader] worker error, retrying sync:', error || 'invalid result');
        disposeAlgoWorker(false);
        compute(true);
        return;
      }
      workerEverSucceeded = true;
      try {
        renderResults(results, hasStart === true);
      } catch (renderError) {
        renderComputeError(renderError);
      }
    };
    worker.onerror = (event) => {
      // Quiet on first failure (usually a worker-policy restriction); log if
      // it happens after the worker has already completed useful work.
      if (workerEverSucceeded) {
        console.warn('[plate-loader] worker died, using sync fallback:', {
          message: event.message || '(empty)',
          filename: event.filename,
          lineno: event.lineno,
        });
      }
      const hadInflight = inflightReqId !== null;
      disposeAlgoWorker(false);
      if (hadInflight) compute(true);
    };
    algoWorker = worker;
    return algoWorker;
  } catch (error) {
    console.warn('[plate-loader] worker init failed, using sync:', error && error.message);
    return null;
  }
}

// ---------- rendering ----------
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const MAX_TOTAL_KG = 1000;
const MAX_SETS = 50;
const MAX_INPUT_CHARS = 4096;
const readInput = () => stateLib.parseWeightInput(inputEl.value, {
  maxSets: MAX_SETS,
  maxKg: MAX_TOTAL_KG,
  maxChars: MAX_INPUT_CHARS,
});
const outputStatusEl = $('outputStatus');
let statusAnnouncementId = 0;

function announceStatus(message) {
  const announcementId = ++statusAnnouncementId;
  outputStatusEl.textContent = '';
  requestAnimationFrame(() => {
    if (announcementId === statusAnnouncementId) outputStatusEl.textContent = message;
  });
}

function setResultsBusy(busy) {
  resultsEl.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function renderInputErrors(errors) {
  setResultsBusy(false);
  const visible = errors.slice(0, 5);
  const remaining = errors.length - visible.length;
  inputEl.setAttribute('aria-invalid', 'true');
  inputEl.setAttribute('aria-errormessage', 'inputErrors');
  $('output').innerHTML = `<div class="panel input-error" id="inputErrors" role="alert">
    <strong>Check the set list.</strong>
    <ul>${visible.map((message) => `<li>${esc(message)}</li>`).join('')}
      ${remaining > 0 ? `<li>…and ${remaining} more.</li>` : ''}</ul>
  </div>`;
  $('summaryPanel').hidden = true;
}

function clearInputErrorState() {
  inputEl.removeAttribute('aria-invalid');
  inputEl.removeAttribute('aria-errormessage');
}

function renderComputeError(error) {
  setResultsBusy(false);
  clearIndicator();
  inflightReqId = null;
  const message = 'Could not compute this sequence. Check the settings and try again.';
  $('summaryPanel').hidden = true;
  $('output').innerHTML = `<div class="panel input-error" role="alert">
    <strong>Computation failed.</strong> ${message}
  </div>`;
  announceStatus(message);
  console.error('[plate-loader] computation failed:', error);
}

function renderPlate(plateIdx, opts) {
  const p = PLATES[plateIdx];
  const dark = DARK_PLATE_KG.has(p.kg) ? ' dark' : '';
  let cls = `plate ${p.cls}${dark}`;
  if (opts) {
    if (opts.added)   cls += opts.side === 'left' ? ' added-left' : ' added-right';
    if (opts.carried) cls += ' carried';
  }
  return `<div class="${cls}" title="${p.kg} kg plate" aria-hidden="true"><span class="plate-label">${p.label}</span></div>`;
}

const barDescription = (stack) => stateLib.describeBar(stack, PLATES, BAR, oneSided);

function renderBarRow(stack, prevStack = [], options = {}) {
  const animateChanges = options.animateChanges !== false;
  let sharedPrefix = 0;
  while (
    sharedPrefix < prevStack.length &&
    sharedPrefix < stack.length &&
    prevStack[sharedPrefix] === stack[sharedPrefix]
  ) sharedPrefix++;

  const plateOptions = (stackIndex, side) => animateChanges
    ? { added: stackIndex >= sharedPrefix, carried: stackIndex < sharedPrefix, side }
    : { side };

  let leftHtml = '';
  let rightHtml = '';
  if (!oneSided) {
    for (let idx = stack.length - 1; idx >= 0; idx--) {
      leftHtml += renderPlate(stack[idx], plateOptions(idx, 'left'));
    }
  }
  for (let idx = 0; idx < stack.length; idx++) {
    rightHtml += renderPlate(stack[idx], plateOptions(idx, 'right'));
  }

  const accessibility = options.label === false
    ? ''
    : ` role="img" aria-label="${barDescription(stack)}"`;
  return `<div class="bar-row"${accessibility}>${leftHtml}<div class="collar"></div><div class="bar"></div><div class="collar"></div>${rightHtml}</div>`;
}

function renderBar(stack, prevStack, options) {
  return `<div class="bar-wrap">${renderBarRow(stack, prevStack, options)}</div>`;
}

function plateChips(stack) {
  const counts = new Array(PLATES.length).fill(0);
  for (const plateIndex of stack) counts[plateIndex]++;
  const parts = [];
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > 0) {
      const n = counts[i], lbl = PLATES[i].label;
      const scope = oneSided ? '' : ' per side';
      parts.push(`<span class="chip" aria-label="${n} ${lbl} kilogram plate${n !== 1 ? 's' : ''}${scope}">${n}× ${lbl} kg</span>`);
    }
  }
  return parts.length ? parts.join(' ') : `<span class="chip">${emptyLoadLabel()}</span>`;
}

const deltaClass = (n) => n === 0 ? 'zero' : n <= 4 ? 'few' : 'many';
const moveLabel = (n) => `${n} move${n === 1 ? '' : 's'}`;
const plateLabel = (n) => `${n} plate${n === 1 ? '' : 's'}`;
const emptyLoadLabel = () => BAR === 0 ? 'no plates' : 'bar only';

// toFixed(2) ensures a decimal, then strip trailing zeros AND the dangling
// decimal point. A one-liner regex would eat legit trailing zeros from
// whole numbers (280 → "28", 10 → "1", 0 → "").
const fmtKg = (x) => x.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');

function changeText(r, mode, isInitialLoad) {
  const kgDetail = (mode === 'kg' || mode === 'sqrt')
    ? ` <span class="kg-detail">${fmtKg(r.bothSidesKg)} kg</span>` : '';
  if (isInitialLoad) {
    return `<span class="delta ${deltaClass(r.bothSidesMoves)}">load ${plateLabel(r.bothSidesMoves)}</span>${kgDetail}`;
  }
  if (r.bothSidesMoves === 0) return `<span class="delta zero">no change</span>`;
  const bits = [];
  if (r.removedCount) bits.push(`−${r.removedCount}`);
  if (r.addedCount) bits.push(`+${r.addedCount}`);
  return `<span class="delta ${deltaClass(r.bothSidesMoves)}">${bits.join(' ')}${oneSided ? '' : '/side'} · ${moveLabel(r.bothSidesMoves)}</span>${kgDetail}`;
}

function renderResults(results, hasStart) {
  const out = $('output');
  const summaryPanel = $('summaryPanel');
  const fragment = document.createDocumentFragment();

  let totalMoves = 0, totalKg = 0, totalSqrt = 0, validSets = 0;
  const userSetCount = Math.max(0, results.length - (hasStart ? 1 : 0));
  let previousStack = [];
  let pendingCleanup = null;
  let physicalIndex = 0;
  let setNum = 0;  // 1-based user-set count; excludes the pinned starting state.

  for (const r of results) {
    const isStartingState = r.valid && hasStart && physicalIndex === 0;
    const card = document.createElement('article');
    card.className = 'set' + (r.valid ? '' : ' invalid') + (isStartingState ? ' starting' : '');

    if (!r.valid) {
      card.innerHTML = `
        <div class="set-head">
          <div class="set-num"><span class="n">${++setNum}</span>SET</div>
          <div class="set-total">${r.total}<span class="unit">kg</span></div>
          <div class="set-changes"><span class="delta many">invalid</span></div>
        </div>
        <div class="invalid-msg">${esc(r.reason)}<span class="skip-note">Skipped; this entry does not change the bar, so valid sets remain optimised together.</span></div>`;
      card.setAttribute('aria-label', `Set ${setNum}: ${r.total} kg, invalid`);
      fragment.appendChild(card);
      continue;
    }

    const isInitialLoad = !hasStart && physicalIndex === 0;
    if (!isStartingState) {
      setNum++;
      validSets++;
      totalMoves += r.bothSidesMoves;
      totalKg += r.bothSidesKg;
      totalSqrt += r.bothSidesSqrtKg;
    }

    const numLabel = isStartingState
      ? '<span class="n start-label" aria-hidden="true">▶</span>START'
      : `<span class="n">${setNum}</span>SET`;
    const changes = isStartingState
      ? '<span class="delta zero">already loaded</span>'
      : changeText(r, CURRENT_MODE, isInitialLoad);
    const fromStack = isStartingState || isInitialLoad ? [] : previousStack;

    card.innerHTML = `
      <div class="set-head">
        <div class="set-num">${numLabel}</div>
        <div class="set-total">${r.total}<span class="unit">kg</span></div>
        <div class="set-changes">${changes}</div>
      </div>
      ${renderBar(r.stack, fromStack, { animateChanges: !isStartingState })}
      <div class="plate-list">${plateChips(r.stack)}${oneSided ? '' : ' <span class="scope-note">· per side</span>'}</div>`;
    card.setAttribute('aria-label', isStartingState
      ? `Starting load: ${r.total} kg`
      : `Set ${setNum}: ${r.total} kg`);
    fragment.appendChild(card);
    previousStack = r.stack;
    physicalIndex++;

    if (r.cleanup && r.cleanup.bothSidesMoves > 0) {
      pendingCleanup = { cleanup: r.cleanup, stack: r.stack };
    }
  }

  // Invalid rows are annotations rather than physical bar states. Render the
  // one final unload after every user row, including trailing invalid entries.
  if (pendingCleanup) {
    const { cleanup: cleanupData, stack } = pendingCleanup;
    totalMoves += cleanupData.bothSidesMoves;
    totalKg += cleanupData.bothSidesKg;
    totalSqrt += cleanupData.bothSidesSqrtKg;
    const cleanup = document.createElement('article');
    cleanup.className = 'set cleanup';
    cleanup.setAttribute('aria-label', 'Unload the bar');
    const kgDetail = (CURRENT_MODE === 'kg' || CURRENT_MODE === 'sqrt')
      ? ` <span class="kg-detail">${fmtKg(cleanupData.bothSidesKg)} kg</span>` : '';
    cleanup.innerHTML = `
      <div class="set-head">
        <div class="set-num">UNLOAD</div>
        <div class="set-total">→ ${emptyLoadLabel()}</div>
        <div class="set-changes"><span class="delta ${deltaClass(cleanupData.bothSidesMoves)}">−${stack.length}${oneSided ? '' : '/side'} · ${moveLabel(cleanupData.bothSidesMoves)}</span>${kgDetail}</div>
      </div>
      ${renderBar([], stack)}`;
    fragment.appendChild(cleanup);
  }

  out.replaceChildren(fragment);

  if (validSets > 0) {
    summaryPanel.hidden = false;
    $('summary').innerHTML = `
      <div><span>Sets</span><b>${validSets}${userSetCount !== validSets ? ` / ${userSetCount}` : ''}</b></div>
      <div><span>Total plate moves</span><b>${totalMoves}</b></div>
      <div><span>Total kg moved</span><b>${fmtKg(totalKg)}</b></div>
      <div><span>Σ√kg moved</span><b>${totalSqrt.toFixed(2)}</b></div>`;
    $('legend').innerHTML = PLATES.map(p =>
      `<span><i class="${p.cls}" aria-hidden="true"></i>${p.label} kg</span>`
    ).join('');
  } else {
    summaryPanel.hidden = true;
  }

  const invalidSets = Math.max(0, userSetCount - validSets);
  const validLabel = `${validSets} valid set${validSets === 1 ? '' : 's'}`;
  const invalidLabel = invalidSets
    ? `; ${invalidSets} invalid set${invalidSets === 1 ? '' : 's'}`
    : '';
  setResultsBusy(false);
  announceStatus(`Results updated: ${validLabel}${invalidLabel}.`);
}

// ---------- wire-up ----------
const debounce = (fn, ms) => {
  let timer = null;
  const wrapped = function (...args) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(this, args); }, ms);
  };
  wrapped.cancel = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  return wrapped;
};

const stockSlider = $('stockSlider'), stockValue = $('stockValue');
const inputEl     = $('input');
const compactBtn  = $('compactToggle'), goBtn = $('go');
const barSelect   = $('barWeight');
const startDetails = $('startDetails');
const startVizEl   = $('startViz');
const startButtonsEl = $('startButtons');
const startTotalEl   = $('startTotal');
const startClearBtn  = $('startClear');
const startRemoveBtn = $('startRemove');
const monotonicToggle = $('monotonicToggle');
const oneSidedToggle  = $('oneSidedToggle');
const constraintNoticeEl = $('constraintNotice');
const customStockDetails = $('customStockDetails');
const customStockToggle = $('customStockToggle');
const customStockInputsEl = $('customStockInputs');
const customStockSummary = $('customStockSummary');
const skipLink = $('skipToResults');
const resultsEl = $('results');
const modesEl = $('modes');
const modeButtons = Array.from(modesEl.querySelectorAll('.mode-btn'));
let monotonic = false;
let oneSided  = false;
const sided = () => oneSided ? 1 : 2;
// startStack = ordered array of plate indices (innermost → outermost),
// e.g. [1, 4, 1] for "20kg, 5kg, 20kg per side". null = empty bar.
let startStack = null;

const STATE_KEY     = 'plateLoader.v1';
const STOCK_MAX     = parseInt(stockSlider.max, 10) || 6;
const DEFAULT_STOCK = parseInt(stockSlider.defaultValue || stockSlider.value, 10);
const DEFAULT_MODE  = 'count';
let CURRENT_MODE = DEFAULT_MODE;
let stockPreset = DEFAULT_STOCK;
let customStock = null;
let customStockInputEls = [];
const DEFAULT_STATE = Object.freeze({
  input: '',
  mode: DEFAULT_MODE,
  stock: DEFAULT_STOCK,
  bar: DEFAULT_BAR,
  startStack: null,
  monotonic: false,
  oneSided: false,
  compact: false,
  customStock: null,
});

function buildCustomStockInputs() {
  customStockInputsEl.innerHTML = PLATES.map((plate, index) => `
    <label class="custom-stock-item" for="customStock-${index}">
      <span class="swatch ${plate.cls}" aria-hidden="true"></span>
      <span>${plate.label} kg</span>
      <input type="number" id="customStock-${index}" data-stock-index="${index}"
        min="0" max="${STOCK_MAX}" step="1" inputmode="numeric" value="${stockPreset}" />
    </label>`).join('');
  customStockInputEls = Array.from(customStockInputsEl.querySelectorAll('input'));
}

function sameStockVector(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((count, index) => count === right[index]);
}

function updateCustomStockControls() {
  const enabled = Array.isArray(customStock);
  customStockToggle.checked = enabled;
  stockSlider.disabled = enabled;
  customStockInputsEl.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  customStockInputEls.forEach((input, index) => {
    input.disabled = !enabled;
    input.value = String(enabled ? customStock[index] : stockPreset);
  });
  customStockSummary.textContent = enabled ? 'On' : 'Off';
  if (enabled) customStockDetails.open = true;
}

function setCustomStock(value) {
  const next = stateLib.parseStockVector(value, PLATES.length, STOCK_MAX);
  const changed = !sameStockVector(next, customStock);
  customStock = next;
  plateMax = next ? next.slice() : new Array(PLATES.length).fill(stockPreset);
  updateCustomStockControls();
  updateWarmupConstraints();
  return changed;
}

function updateCustomStockCount(index, value) {
  if (!customStock || !Number.isInteger(index) || index < 0 || index >= customStock.length) {
    return false;
  }
  const source = String(value ?? '').trim();
  const count = /^\d+$/.test(source)
    ? stateLib.clampInteger(source, 0, STOCK_MAX, customStock[index])
    : customStock[index];
  if (customStock[index] === count) return false;
  const next = customStock.slice();
  next[index] = count;
  customStock = next;
  plateMax = customStock.slice();
  updateWarmupConstraints();
  return true;
}

// startStack is an ORDERED list of plate indices, innermost → outermost.
// Validates an array and keeps crafted URL/local-storage values within a
// physically meaningful bar length. The exact optimiser itself has no hidden
// four-bit count limit.
const START_MAX_PER_TYPE = 8;
const START_MAX_TOTAL    = 24;
function normaliseStack(arr) {
  if (!Array.isArray(arr) || arr.length === 0 || arr.length > START_MAX_TOTAL) return null;
  const out = [];
  const counts = new Array(PLATES.length).fill(0);
  for (const n of arr) {
    if (!Number.isInteger(n) || n < 0 || n >= PLATES.length) return null;
    if (++counts[n] > START_MAX_PER_TYPE) return null;
    out.push(n);
  }
  return out.length ? out : null;
}

function startStackTotalKg() {
  let kg = BAR;
  if (startStack) for (const i of startStack) kg += sided() * PLATES[i].kg;
  return kg;
}

function updateStartTotalDisplay() {
  if (!startStack || startStack.length === 0) {
    startTotalEl.textContent = BAR === 0 ? 'No plates · 0 kg' : `${fmtKg(BAR)} kg bar only`;
  } else {
    startTotalEl.textContent = `${fmtKg(startStackTotalKg())} kg`;
  }
}

function renderStartViz() {
  if (!startStack || startStack.length === 0) {
    startVizEl.innerHTML = '';
    startVizEl.setAttribute('aria-label', barDescription([]));
    return;
  }
  startVizEl.setAttribute('aria-label', barDescription(startStack));
  startVizEl.innerHTML = renderBarRow(startStack, [], { animateChanges: false, label: false });
}

function showConstraintNotice(message) {
  constraintNoticeEl.textContent = message;
  constraintNoticeEl.hidden = !message;
}

function clearConstraintNotice() {
  showConstraintNotice('');
}

function updateStartControls() {
  const hasStack = !!(startStack && startStack.length);
  startClearBtn.disabled = !hasStack;
  startRemoveBtn.disabled = !hasStack;
  startRemoveBtn.textContent = hasStack
    ? `Remove outermost (${PLATES[startStack[startStack.length - 1]].label} kg)`
    : 'Remove outermost';
}

function setStartStack(arr) {
  const nextStack = normaliseStack(arr);
  if (monotonic && nextStack && !stateLib.isMonotonicStack(nextStack)) {
    showConstraintNotice(
      'Monotonic mode preserves the declared order: add plates from heaviest to lightest.',
    );
    return false;
  }

  startStack = nextStack;
  clearConstraintNotice();
  updateStartControls();
  updateStartTotalDisplay();
  renderStartViz();
  updateWarmupConstraints();
  return true;
}

function setMonotonic(on) {
  const requested = !!on;
  if (requested && startStack && !stateLib.isMonotonicStack(startStack)) {
    monotonic = false;
    monotonicToggle.checked = false;
    showConstraintNotice(
      'Monotonic mode was not enabled because the starting stack is not ordered heaviest to lightest.',
    );
    return false;
  }

  monotonic = requested;
  monotonicToggle.checked = monotonic;
  clearConstraintNotice();
  return true;
}

function setOneSided(on) {
  oneSided = !!on;
  oneSidedToggle.checked = oneSided;
  // Keep the static two-sided-worded copy honest in one-sided mode.
  const stockLbl = $('stockScopeLabel');
  if (stockLbl) stockLbl.textContent = oneSided ? 'total of each' : 'max per side';
  const loadLbl = $('loadScopeLabel');
  if (loadLbl) loadLbl.textContent = oneSided ? 'on one side only' : 'symmetrically';
  updateWarmupConstraints();
  updateStartTotalDisplay();
  renderStartViz();
}

function buildStartButtons() {
  startButtonsEl.innerHTML = PLATES.map((p, i) =>
    `<button type="button" class="start-btn" data-plate-idx="${i}"
       aria-label="Add a ${p.label} kg plate. Shift-click, Delete, or right-click removes the outermost ${p.label} kg plate.">
       <span class="swatch ${p.cls}" aria-hidden="true"></span>${p.label}
     </button>`
  ).join('');
}

function finishStartChange() {
  persist();
  if (inputEl.value.trim()) scheduleCompute();
}

function removeStartPlate(plateIdx = null) {
  if (!startStack || startStack.length === 0) return false;
  const arr = startStack.slice();
  if (plateIdx === null) {
    arr.pop();
  } else {
    const index = arr.lastIndexOf(plateIdx);
    if (index < 0) return false;
    arr.splice(index, 1);
  }
  setStartStack(arr.length ? arr : null);
  finishStartChange();
  return true;
}

// Click or Enter adds to the outer end. Shift-click, Delete, or the context
// menu removes the outermost occurrence of that plate type.
function onStartButtonClick(e) {
  const btn = e.target.closest('.start-btn');
  if (!btn) return;
  e.preventDefault();
  const idx = parseInt(btn.dataset.plateIdx, 10);
  if (e.shiftKey) {
    removeStartPlate(idx);
    return;
  }
  const arr = startStack ? startStack.slice() : [];
  arr.push(idx);
  if (!normaliseStack(arr)) {
    showConstraintNotice('Starting stack limit reached. Remove a plate before adding another.');
    return;
  }
  if (monotonic && !stateLib.isMonotonicStack(arr)) {
    const outer = startStack && startStack.length
      ? PLATES[startStack[startStack.length - 1]].label
      : null;
    showConstraintNotice(
      outer
        ? `Monotonic mode requires the next plate to be ${outer} kg or lighter.`
        : 'Monotonic mode requires plates to be added heaviest to lightest.',
    );
    return;
  }
  if (setStartStack(arr)) finishStartChange();
}

function onStartButtonContextMenu(e) {
  const btn = e.target.closest('.start-btn');
  if (!btn) return;
  e.preventDefault();
  removeStartPlate(parseInt(btn.dataset.plateIdx, 10));
}

function onStartButtonKeyDown(e) {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const btn = e.target.closest('.start-btn');
  if (!btn) return;
  e.preventDefault();
  removeStartPlate(parseInt(btn.dataset.plateIdx, 10));
}

function setBar(kg) {
  kg = Number(kg);
  if (![0, 10, 15, 20, 25].includes(kg)) kg = DEFAULT_BAR;
  BAR = kg;
  barSelect.value = String(kg);
  const subEl = $('barSub');
  if (subEl) subEl.textContent = kg === 0 ? 'Deadlift · plates only' : `Deadlift · ${kg} kg bar`;
  if (startTotalEl) updateStartTotalDisplay();  // start total includes BAR
  if (startVizEl) renderStartViz();              // accessible description includes BAR
  updateWarmupConstraints();
}

function setMode(m) {
  if (!['count', 'kg', 'sqrt'].includes(m)) return false;
  const changed = CURRENT_MODE !== m;
  CURRENT_MODE = m;
  modeButtons.forEach(b => {
    const on = b.dataset.mode === m;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    // ARIA radio pattern: only the active radio is in the tab order.
    b.tabIndex = on ? 0 : -1;
  });
  return changed;
}

function setStock(value) {
  const stock = stateLib.clampInteger(value, 0, STOCK_MAX, DEFAULT_STOCK);
  const changed = stock !== stockPreset;
  stockPreset = stock;
  stockSlider.dataset.stock = String(stock);
  stockSlider.value = String(stock);
  stockValue.textContent = String(stock);
  if (!customStock) plateMax.fill(stock);
  updateCustomStockControls();
  updateWarmupConstraints();
  return changed;
}

function setCompact(on) {
  on = !!on;
  document.body.classList.toggle('compact', on);
  compactBtn.classList.toggle('active', on);
  compactBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  compactBtn.textContent = on ? 'Full view' : 'Compact view';
}

const updateComputeBtn = () => { goBtn.disabled = inputEl.value.trim().length === 0; };

// "Computing…" indicator is shown only if a compute is still in flight after
// INDICATOR_DELAY_MS — fast computes don't flash. Every call bumps
// currentReqId so older responses (worker or sync) are silently discarded
// on arrival, even for empty-input or fallback paths.
let pendingCompute = false;
function compute(forceSync) {
  debouncedCompute.cancel();
  if (!forceSync && inflightReqId !== null) disposeAlgoWorker(true);
  // Skip while tab is hidden, but invalidate any in-flight request so its
  // stale result doesn't render after the user types more.
  if (document.visibilityState === 'hidden') {
    ++currentReqId;
    pendingCompute = true;
    setResultsBusy(false);
    return;
  }
  const reqId = ++currentReqId;
  const { weights, errors } = readInput();
  const out = $('output');
  const summaryPanel = $('summaryPanel');
  if (errors.length) {
    renderInputErrors(errors);
    announceStatus(`Set list has ${errors.length} error${errors.length === 1 ? '' : 's'}.`);
    return;
  }
  clearInputErrorState();
  if (weights.length === 0) {
    setResultsBusy(false);
    out.innerHTML = '<div class="panel empty-state">Enter some weights above.</div>';
    summaryPanel.hidden = true;
    announceStatus('No sets entered.');
    return;
  }

  setResultsBusy(true);
  const showIndicator = () => {
    if (currentReqId !== reqId) return;
    out.innerHTML = '<div class="panel computing-indicator">Computing…</div>';
    summaryPanel.hidden = true;
    announceStatus('Computing plate sequence.');
  };

  const requestedStartStack = startStack ? startStack.slice() : null;
  const worker = forceSync ? null : ensureAlgoWorker();
  if (worker) {
    inflightReqId = reqId;
    indicatorReqId = reqId;
    indicatorTimer = setTimeout(showIndicator, INDICATOR_DELAY_MS);
    try {
      worker.postMessage({
        reqId,
        weights,
        mode: CURRENT_MODE,
        plateMax: plateMax.slice(),
        plateKg: PLATE_KG,
        BAR,
        startStack: requestedStartStack,
        monotonic,
        sided: sided(),
      });
      return;
    } catch (error) {
      console.warn('[plate-loader] worker message failed, retrying sync:', error);
      disposeAlgoWorker(false);
      compute(true);
      return;
    }
  }

  // Sync fallback: load the optimiser on demand, then yield via rAF so the
  // indicator paints before optimize() blocks the main thread.
  requestAnimationFrame(() => {
    if (currentReqId !== reqId) return;
    showIndicator();
    ensureSyncAlgoLib().then((library) => {
      if (currentReqId !== reqId) return;
      requestAnimationFrame(() => {
        if (currentReqId !== reqId) return;
        try {
          const results = library.optimize(
            weights, CURRENT_MODE, plateMax, PLATE_KG, BAR,
            requestedStartStack, monotonic, sided(),
          );
          const resultHasStart = Boolean(
            requestedStartStack && results.length === weights.length + 1
          );
          renderResults(results, resultHasStart);
        } catch (error) {
          if (currentReqId === reqId) renderComputeError(error);
        }
      });
    }).catch((error) => {
      if (currentReqId === reqId) renderComputeError(error);
    });
  });
}

// ---------- warmup generator ----------
// 50/70/85/95/100%, projected onto weights achievable with current stock.
const warmupIncrement = () => stateLib.totalIncrement(PLATES, sided(), effectivePlateMax());

function effectivePlateMax() {
  const maxima = plateMax.slice();
  if (!startStack) return maxima;
  const startingCounts = new Array(PLATES.length).fill(0);
  for (const plateIndex of startStack) startingCounts[plateIndex]++;
  return maxima.map((maximum, plateIndex) => Math.max(maximum, startingCounts[plateIndex]));
}

const warmupOptions = () => ({
  bar: BAR,
  sided: sided(),
  plates: PLATES,
  maxima: effectivePlateMax(),
});
const warmupMinimum = () => stateLib.minTotalWeight(
  PLATES, effectivePlateMax(), BAR, sided(),
);
const warmupMaximum = () => stateLib.maxTotalWeight(
  PLATES, effectivePlateMax(), BAR, sided(), MAX_TOTAL_KG,
);

function updateWarmupConstraints() {
  const note = $('warmupNote');
  const target = $('warmupTarget');
  const button = $('warmup');
  const minimum = warmupMinimum();
  const maximum = warmupMaximum();
  const enabled = Number.isFinite(minimum) && maximum >= minimum;

  if (target) {
    target.min = enabled ? fmtKg(minimum) : '0';
    target.max = enabled ? fmtKg(maximum) : '';
    target.setCustomValidity('');
  }
  if (button) button.disabled = !enabled;
  if (note) {
    const increment = warmupIncrement();
    const step = increment > 0 ? `${fmtKg(increment)} kg` : 'no additional plates';
    note.textContent = enabled
      ? `Will create loadable sets at or below 50%, 70%, 85% and 95%, plus the exact 100% target (available denominations use ${step} total increments; maximum ${fmtKg(maximum)} kg).`
      : 'No positive load is possible with the selected bar and available plates.';
  }
}

const generateWarmup = (targetKg) => stateLib.generateWarmup(targetKg, warmupOptions());

// ---------- state persistence (localStorage + URL hash) ----------
const sharedInput = () => stateLib
  .normaliseSharedText(inputEl.value, MAX_INPUT_CHARS)
  .replace(/\r\n?/g, '\n');

const snapshotState = () => ({
  input:      sharedInput(),
  mode:       CURRENT_MODE,
  stock:      stockPreset,
  customStock: customStock ? customStock.slice() : null,
  bar:        BAR,
  startStack: startStack,
  monotonic:  monotonic,
  oneSided:   oneSided,
  compact:    document.body.classList.contains('compact'),
});

const saveState = () => {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(snapshotState())); } catch (_) {}
};

function applyState(state) {
  const next = state && typeof state === 'object' ? state : DEFAULT_STATE;
  const input = typeof next.input === 'string' ? next.input : DEFAULT_STATE.input;
  // Preserve crafted state long enough for the input validator to report it;
  // persistence and sharing still cap the stored value.
  inputEl.value = input;
  setMode(['count', 'kg', 'sqrt'].includes(next.mode) ? next.mode : DEFAULT_MODE);
  setStock(Number.isInteger(next.stock) ? next.stock : DEFAULT_STOCK);
  setCustomStock(next.customStock);
  setBar(Number.isFinite(next.bar) ? next.bar : DEFAULT_BAR);
  setOneSided(next.oneSided === true);
  setMonotonic(false);  // clear the previous state's constraint before restoring order
  setStartStack(Array.isArray(next.startStack) ? next.startStack : null);
  setMonotonic(next.monotonic === true);
  setCompact(next.compact === true);
  startDetails.open = Boolean(startStack && startStack.length);
}

function loadStateFromStorage() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (_) {}
  if (!saved || typeof saved !== 'object') return false;
  applyState({ ...DEFAULT_STATE, ...saved });
  return true;
}

function serializeHash() {
  const input = sharedInput();
  const parts = [];
  if (input) parts.push('w=' + encodeURIComponent(input));
  if (CURRENT_MODE !== DEFAULT_MODE) parts.push('m=' + CURRENT_MODE);
  if (stockPreset !== DEFAULT_STOCK) parts.push('s=' + stockPreset);
  if (customStock) parts.push('p=' + customStock.join('.'));
  if (BAR !== DEFAULT_BAR) parts.push('b=' + BAR);
  // Starting stack: list of plate indices, e.g. i=1.4.1 for 20kg,5kg,20kg.
  if (startStack && startStack.length) parts.push('i=' + startStack.join('.'));
  if (monotonic) parts.push('o=1');
  if (oneSided)  parts.push('x=1');
  if (document.body.classList.contains('compact')) parts.push('c=1');
  return parts.length ? '#' + parts.join('&') : '';
}

function applyHash(hash = location.hash) {
  const state = stateLib.stateFromHash(hash, DEFAULT_STATE);
  if (!state) return false;
  applyState(state);
  return true;
}

function updateHash() {
  const next = serializeHash();
  if (next === location.hash || (next === '' && location.hash === '')) return;
  try { history.replaceState(null, '', location.pathname + location.search + next); } catch (_) {}
}

const persist = () => { saveState(); updateHash(); };
const persistAndRecompute = (force) => { persist(); if (force || inputEl.value.trim()) compute(); };
const debouncedCompute = debounce(compute, 250);
const debouncedSaveState = debounce(saveState, 300);
const schedulePersist = () => {
  // URL state is cheap and should survive an immediate reload; localStorage is
  // coalesced while typing, then synchronously flushed when the page hides.
  updateHash();
  debouncedSaveState();
};
const scheduleCompute = () => {
  ++currentReqId;  // invalidate any result already in flight before the debounce fires
  if (inflightReqId !== null) disposeAlgoWorker(true);
  else clearIndicator();
  debouncedCompute();
};

function flushPersistence() {
  debouncedSaveState.cancel();
  persist();
}

window.addEventListener('pagehide', flushPersistence);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushPersistence();
    return;
  }
  if (pendingCompute) {
    pendingCompute = false;
    compute();
  }
});

// ---------- event wire-up ----------
stockSlider.addEventListener('input', () => {
  if (!setStock(parseInt(stockSlider.value, 10))) return;
  schedulePersist();
  if (inputEl.value.trim()) scheduleCompute();
});

customStockToggle.addEventListener('change', () => {
  const values = customStockToggle.checked
    ? customStockInputEls.map((input) => input.value)
    : null;
  if (setCustomStock(values)) persistAndRecompute();
});

customStockInputsEl.addEventListener('input', (event) => {
  const input = event.target.closest('[data-stock-index]');
  if (!input || !customStock || input.value === '' || !/^\d+$/.test(input.value)) return;
  const index = Number(input.dataset.stockIndex);
  if (!updateCustomStockCount(index, input.value)) return;
  input.value = String(customStock[index]);
  schedulePersist();
  if (inputEl.value.trim()) scheduleCompute();
});
customStockInputsEl.addEventListener('change', (event) => {
  const input = event.target.closest('[data-stock-index]');
  if (!input || !customStock) return;
  const index = Number(input.dataset.stockIndex);
  const changed = updateCustomStockCount(index, input.value);
  input.value = String(customStock[index]);
  if (changed) persistAndRecompute();
});

barSelect.addEventListener('change', () => { setBar(barSelect.value); persistAndRecompute(); });

monotonicToggle.addEventListener('change', () => {
  if (setMonotonic(monotonicToggle.checked)) persistAndRecompute();
  else persist();
});

oneSidedToggle.addEventListener('change', () => {
  setOneSided(oneSidedToggle.checked);
  persistAndRecompute();
});

// Click interface for the starting stack (event delegation).
startButtonsEl.addEventListener('click', onStartButtonClick);
startButtonsEl.addEventListener('contextmenu', onStartButtonContextMenu);
startButtonsEl.addEventListener('keydown', onStartButtonKeyDown);
startRemoveBtn.addEventListener('click', () => removeStartPlate());
startClearBtn.addEventListener('click', () => {
  setStartStack(null);
  persistAndRecompute();
});

modeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (setMode(btn.dataset.mode)) persistAndRecompute();
  });
});

// Arrow-key navigation within the radio group (ARIA pattern).
modesEl.addEventListener('keydown', (e) => {
  const keys = ['ArrowRight','ArrowLeft','ArrowUp','ArrowDown','Home','End'];
  if (!keys.includes(e.key)) return;
  const btns = modeButtons;
  const curr = btns.findIndex(b => b.classList.contains('active'));
  let next = curr;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (curr + 1) % btns.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (curr - 1 + btns.length) % btns.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End')  next = btns.length - 1;
  if (next === curr) return;
  e.preventDefault();
  btns[next].click();
  btns[next].focus();
});

inputEl.addEventListener('input', () => {
  clearInputErrorState();
  updateComputeBtn();
  schedulePersist();
  scheduleCompute();
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); compute(); }
});

goBtn.addEventListener('click', () => compute());
$('example').addEventListener('click', () => {
  inputEl.value = '60\n80\n100\n120\n140';
  updateComputeBtn();
  persistAndRecompute(true);
});
$('clear').addEventListener('click', () => {
  inputEl.value = '';
  setStartStack(null);  // also clear starting load
  updateComputeBtn();
  persistAndRecompute(true);
});
compactBtn.addEventListener('click', () => {
  setCompact(!document.body.classList.contains('compact'));
  persist();
});

// Warmup dialog
const warmupDialog = $('warmupDialog'), warmupTarget = $('warmupTarget'), warmupForm = $('warmupForm');
const warmupBtn = $('warmup');

function closeWarmupDialog() {
  if (typeof warmupDialog.close === 'function') warmupDialog.close();
  else warmupDialog.removeAttribute('open');
}

warmupBtn.addEventListener('click', () => {
  if (inputEl.value.trim() && !confirm('Replace current sets with a generated warmup?')) return;
  updateWarmupConstraints();
  const minimum = warmupMinimum();
  const maximum = warmupMaximum();
  warmupTarget.value = fmtKg(Math.min(maximum, Math.max(minimum, 140)));
  if (typeof warmupDialog.showModal === 'function') warmupDialog.showModal();
  else warmupDialog.setAttribute('open', '');
  requestAnimationFrame(() => { warmupTarget.focus(); warmupTarget.select(); });
});

warmupTarget.addEventListener('input', () => warmupTarget.setCustomValidity(''));

warmupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const kg = Number(warmupTarget.value);
  const minimum = warmupMinimum();
  const maximum = warmupMaximum();
  const options = warmupOptions();
  warmupTarget.setCustomValidity('');
  if (!Number.isFinite(kg) || kg < minimum || kg > maximum) {
    warmupTarget.setCustomValidity(
      `Enter a target between ${fmtKg(minimum)} and ${fmtKg(maximum)} kg for the selected bar and stock.`,
    );
    warmupTarget.reportValidity();
    return;
  }
  if (!stateLib.isAchievableTotal(kg, options)) {
    warmupTarget.setCustomValidity('That target cannot be loaded with the selected plates and stock.');
    warmupTarget.reportValidity();
    return;
  }

  const generated = generateWarmup(kg);
  if (generated.length === 0) {
    warmupTarget.setCustomValidity('No achievable warm-up sequence was found.');
    warmupTarget.reportValidity();
    return;
  }

  closeWarmupDialog();
  inputEl.value = generated.join('\n');
  updateComputeBtn();
  persist();
  compute();
  inputEl.focus();
});

$('warmupCancel').addEventListener('click', closeWarmupDialog);

// Copy shareable link
const shareBtn = $('shareBtn');
const shareStatusEl = $('shareStatus');
const SHARE_DEFAULT_LABEL = shareBtn.textContent;
let shareFeedbackTimer = null;
let copyAttemptId = 0;
let shareAnnouncementId = 0;

function showShareFeedback(label, className, announcement) {
  if (shareFeedbackTimer !== null) clearTimeout(shareFeedbackTimer);
  shareBtn.textContent = label;
  shareBtn.classList.remove('copied', 'copy-failed');
  shareBtn.classList.add(className);
  const announcementId = ++shareAnnouncementId;
  shareStatusEl.textContent = '';
  requestAnimationFrame(() => {
    if (announcementId === shareAnnouncementId) shareStatusEl.textContent = announcement;
  });
  shareFeedbackTimer = setTimeout(() => {
    shareBtn.textContent = SHARE_DEFAULT_LABEL;
    shareBtn.classList.remove('copied', 'copy-failed');
    shareFeedbackTimer = null;
  }, 1400);
}

function legacyCopy(text) {
  const previousFocus = document.activeElement;
  const proxy = document.createElement('textarea');
  proxy.className = 'clipboard-proxy';
  proxy.value = text;
  proxy.setAttribute('readonly', '');
  document.body.appendChild(proxy);
  proxy.focus();
  proxy.select();

  let copied = false;
  try { copied = document.execCommand('copy') === true; } catch (_) {}
  document.body.removeChild(proxy);
  if (previousFocus && typeof previousFocus.focus === 'function') {
    try {
      previousFocus.focus({ preventScroll: true });
    } catch (_) {
      try { previousFocus.focus(); } catch (__) {}
    }
  }
  return copied;
}

async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {}
  }
  try { return legacyCopy(text); } catch (_) { return false; }
}

shareBtn.addEventListener('click', async () => {
  const attemptId = ++copyAttemptId;
  persist();
  const shareUrl = new URL(location.href);
  shareUrl.hash = serializeHash() || '#w=';  // explicit defaults; never inherit recipient storage
  const copied = await copyText(shareUrl.href);
  if (attemptId !== copyAttemptId) return;
  showShareFeedback(
    copied ? 'Copied!' : 'Copy failed',
    copied ? 'copied' : 'copy-failed',
    copied ? 'Shareable link copied.' : 'Could not copy the shareable link.',
  );
});

skipLink.addEventListener('click', (event) => {
  event.preventDefault();
  try { resultsEl.focus({ preventScroll: true }); } catch (_) { resultsEl.focus(); }
  resultsEl.scrollIntoView({ block: 'start' });
});

// Platform-correct keyboard shortcut labels
const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || /Mac/.test(navigator.userAgent || '');
const kbd = $('shortcutKbd'); if (kbd) kbd.textContent = isMac ? '⌘+Enter' : 'Ctrl+Enter';
const kbdFocus = $('shortcutFocusKbd'); if (kbdFocus) kbdFocus.textContent = isMac ? '⌘+K' : 'Ctrl+K';

// Cmd/Ctrl+K focuses the input, except while the modal dialog owns focus.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'k' || (!e.ctrlKey && !e.metaKey) || e.shiftKey || e.altKey) return;
  if (warmupDialog.open || warmupDialog.hasAttribute('open')) return;
  e.preventDefault();
  inputEl.focus();
  inputEl.select();
});

// Build dynamic UI before restoring state.
buildCustomStockInputs();
buildStartButtons();
renderStartViz();
updateStartTotalDisplay();

// A URL hash is a complete, deterministic state. Saved browser state is
// consulted only when the URL carries no recognised Plate Loader state.
applyState(DEFAULT_STATE);
if (!applyHash(location.hash)) loadStateFromStorage();
updateComputeBtn();
if (inputEl.value.trim()) compute();

window.addEventListener('hashchange', () => {
  if (!applyHash(location.hash)) {
    // Non-state anchors belong to the document and must not overwrite the
    // live calculator state. An empty hash deliberately restores saved state.
    if (location.hash) return;
    applyState(DEFAULT_STATE);
    loadStateFromStorage();
  }
  updateComputeBtn();
  compute();
});

// ---------- Service worker registration (PWA / offline) ----------
let pendingUpdateWorker = null;
let updateReloading = false;

function reloadForUpdate() {
  if (updateReloading) return;
  updateReloading = true;
  persist();
  location.reload();
}

function showUpdateToast(worker = null) {
  if (worker) pendingUpdateWorker = worker;
  let toast = $('updateToast');
  if (toast) return;

  toast = document.createElement('div');
  toast.id = 'updateToast';
  toast.className = 'update-toast';
  toast.innerHTML = '<span role="status">New version available.</span> <button type="button" id="updateReload">Reload</button>';
  document.body.appendChild(toast);

  $('updateReload').addEventListener('click', () => {
    const workerToActivate = pendingUpdateWorker;
    if (!workerToActivate || workerToActivate.state === 'activated' || workerToActivate.state === 'redundant') {
      reloadForUpdate();
      return;
    }

    navigator.serviceWorker.addEventListener('controllerchange', reloadForUpdate, { once: true });
    try {
      workerToActivate.postMessage({ type: 'SKIP_WAITING' });
      setTimeout(reloadForUpdate, 1500);
    } catch (_) {
      reloadForUpdate();
    }
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    let hasController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const isUpdate = hasController;
      hasController = true;
      pendingUpdateWorker = null;
      if (isUpdate && !updateReloading) showUpdateToast();
    });

    navigator.serviceWorker.register('sw.js', {
      scope: './',
      updateViaCache: 'none',
    }).then((registration) => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        showUpdateToast(registration.waiting);
      }
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (
            newWorker.state === 'installed' &&
            navigator.serviceWorker.controller &&
            registration.waiting
          ) showUpdateToast(registration.waiting);
        });
      });
    }).catch(() => {});
  });
}
