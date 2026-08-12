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
const DEFAULT_BAR = 20;
let BAR = DEFAULT_BAR;
let plateMax = PLATES.map(() => 2);

// Algorithm: buildAlgoLib is defined in algo.js, loaded before this file.

const algoLib = buildAlgoLib();
const stateLib = buildStateLib();

// ---------- Web Worker for off-main-thread optimisation ----------
// Cancellation is by reqId: stale results are discarded silently.
// Sync fallback if Worker creation fails or the worker errors.
let algoWorker = null;
let workerInitTried = false;
let workerEverSucceeded = false;
let currentReqId = 0;
const inflightReqs = new Set();
const indicatorTimers = new Map();      // reqId → timeoutId
const INDICATOR_DELAY_MS = 150;

function clearIndicator(reqId) {
  if (!indicatorTimers.has(reqId)) return;
  clearTimeout(indicatorTimers.get(reqId));
  indicatorTimers.delete(reqId);
}

function disposeAlgoWorker(allowRetry) {
  if (algoWorker) {
    algoWorker.onmessage = null;
    algoWorker.onerror = null;
    try { algoWorker.terminate(); } catch (_) {}
  }
  algoWorker = null;
  workerInitTried = !allowRetry;
  for (const reqId of inflightReqs) clearIndicator(reqId);
  inflightReqs.clear();
}

function ensureAlgoWorker() {
  if (algoWorker || workerInitTried) return algoWorker;
  workerInitTried = true;
  if (typeof Worker === 'undefined') return null;

  try {
    const worker = new Worker('algo-worker.js');
    worker.onmessage = (event) => {
      const { reqId, results, error, hasStart } = event.data;
      inflightReqs.delete(reqId);
      clearIndicator(reqId);
      if (reqId !== currentReqId) return;
      if (error) {
        console.warn('[plate-loader] worker error, retrying sync:', error);
        disposeAlgoWorker(false);
        compute(true);
        return;
      }
      workerEverSucceeded = true;
      renderResults(results, hasStart);
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
      const hadInflight = inflightReqs.size > 0;
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
const readInput = () => stateLib.parseWeightInput(inputEl.value, {
  maxSets: MAX_SETS,
  maxKg: MAX_TOTAL_KG,
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

function renderInputErrors(errors) {
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

function renderPlate(plateIdx, opts) {
  const p = PLATES[plateIdx];
  const dark = [25, 20, 10, 2.5, 1.25].includes(p.kg) ? ' dark' : '';
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

function plateChips(counts) {
  const parts = [];
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > 0) {
      const n = counts[i], lbl = PLATES[i].label;
      const scope = oneSided ? '' : ' per side';
      parts.push(`<span class="chip" aria-label="${n} ${lbl} kilogram plate${n !== 1 ? 's' : ''}${scope}">${n}× ${lbl} kg</span>`);
    }
  }
  return parts.length ? parts.join(' ') : '<span class="chip">bar only</span>';
}

const deltaClass = (n) => n === 0 ? 'zero' : n <= 4 ? 'few' : 'many';

// toFixed(2) ensures a decimal, then strip trailing zeros AND the dangling
// decimal point. A one-liner regex would eat legit trailing zeros from
// whole numbers (280 → "28", 10 → "1", 0 → "").
const fmtKg = (x) => x.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');

function changeText(r, mode) {
  const kgDetail = (mode === 'kg' || mode === 'sqrt')
    ? ` <span class="kg-detail">${fmtKg(r.bothSidesKg)} kg</span>` : '';
  if (r.isStart) {
    return `<span class="delta ${deltaClass(r.bothSidesMoves)}">load ${r.bothSidesMoves} plate${r.bothSidesMoves !== 1 ? 's' : ''}</span>${kgDetail}`;
  }
  if (r.bothSidesMoves === 0) return `<span class="delta zero">no change</span>`;
  const bits = [];
  if (r.removedIdx.length) bits.push(`−${r.removedIdx.length}`);
  if (r.addedIdx.length)   bits.push(`+${r.addedIdx.length}`);
  return `<span class="delta ${deltaClass(r.bothSidesMoves)}">${bits.join(' ')}${oneSided ? '' : '/side'} · ${r.bothSidesMoves} moves</span>${kgDetail}`;
}

function renderResults(results, hasStart) {
  const out = $('output');
  const summaryPanel = $('summaryPanel');

  out.innerHTML = '';
  let totalMoves = 0, totalKg = 0, totalSqrt = 0, validSets = 0;
  const userSetCount = Math.max(0, results.length - (hasStart ? 1 : 0));
  let prevStack = [];
  let setNum = 0;  // 1-based count of "real" sets (excludes the starting state)

  results.forEach((r, idx) => {
    const isStartingState = hasStart && idx === 0;
    const card = document.createElement('div');
    card.className = 'set' + (r.valid ? '' : ' invalid') + (isStartingState ? ' starting' : '');
    if (!r.valid) {
      const label = isStartingState ? 'START' : `<span class="n">${++setNum}</span>SET`;
      card.innerHTML = `
        <div class="set-head">
          <div class="set-num">${label}</div>
          <div class="set-total">${r.total}<span class="unit">kg</span></div>
          <div class="set-changes"><span class="delta many">invalid</span></div>
        </div>
        <div class="invalid-msg">${esc(r.reason)}</div>`;
      out.appendChild(card);
      prevStack = [];
      return;
    }

    if (!isStartingState) {
      setNum++;
      validSets++;
      totalMoves += r.bothSidesMoves;
      totalKg    += r.bothSidesKg;
      totalSqrt  += r.bothSidesSqrtKg;
    }

    const numLabel = isStartingState
      ? '<span class="n start-label">▶</span>START'
      : `<span class="n">${setNum}</span>SET`;
    const changes = isStartingState
      ? `<span class="delta zero">already loaded</span>`
      : changeText(r, CURRENT_MODE);

    card.innerHTML = `
      <div class="set-head">
        <div class="set-num">${numLabel}</div>
        <div class="set-total">${r.total}<span class="unit">kg</span></div>
        <div class="set-changes">${changes}</div>
      </div>
      ${renderBar(r.stack, isStartingState ? [] : (r.isStart ? [] : prevStack), { animateChanges: !isStartingState })}
      <div class="plate-list">${plateChips(r.counts)}${oneSided ? '' : ' <span class="scope-note">· per side</span>'}</div>`;
    out.appendChild(card);
    prevStack = r.stack;

    // Cleanup row at end of run (skip if nothing to unload).
    if (r.cleanup && r.cleanup.bothSidesMoves > 0) {
      totalMoves += r.cleanup.bothSidesMoves;
      totalKg    += r.cleanup.bothSidesKg;
      totalSqrt  += r.cleanup.bothSidesSqrtKg;
      const cleanup = document.createElement('div');
      cleanup.className = 'set cleanup';
      const kgDetail = (CURRENT_MODE === 'kg' || CURRENT_MODE === 'sqrt')
        ? ` <span class="kg-detail">${fmtKg(r.cleanup.bothSidesKg)} kg</span>` : '';
      cleanup.innerHTML = `
        <div class="set-head">
          <div class="set-num">UNLOAD</div>
          <div class="set-total">→ bar only</div>
          <div class="set-changes"><span class="delta ${deltaClass(r.cleanup.bothSidesMoves)}">−${r.cleanup.removedIdx.length}${oneSided ? '' : '/side'} · ${r.cleanup.bothSidesMoves} moves</span>${kgDetail}</div>
        </div>
        ${renderBar([], r.stack)}`;
      out.appendChild(cleanup);
      prevStack = [];
    }
  });

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
const DEFAULT_STATE = Object.freeze({
  input: '',
  mode: DEFAULT_MODE,
  stock: DEFAULT_STOCK,
  bar: DEFAULT_BAR,
  startStack: null,
  monotonic: false,
  oneSided: false,
  compact: false,
});

// startStack is an ORDERED list of plate indices, innermost → outermost.
// Validates and clamps an array; returns null if empty / invalid.
// Caps: the DP encodes per-type counts in 4-bit nibbles (max 15), so an
// unbounded stack (e.g. a crafted #i= hash) would corrupt memo keys; 8 per
// type / 24 total is far beyond any real bar and keeps the encoding safe.
const START_MAX_PER_TYPE = 8;
const START_MAX_TOTAL    = 24;
function normaliseStack(arr) {
  if (!Array.isArray(arr) || arr.length === 0 || arr.length > START_MAX_TOTAL) return null;
  const out = [];
  const counts = new Array(PLATES.length).fill(0);
  for (const v of arr) {
    const n = Number(v);
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
    startTotalEl.textContent = 'empty';
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

function updateStartControls() {
  const hasStack = !!(startStack && startStack.length);
  startClearBtn.disabled = !hasStack;
  startRemoveBtn.disabled = !hasStack;
  startRemoveBtn.textContent = hasStack
    ? `Remove outermost (${PLATES[startStack[startStack.length - 1]].label} kg)`
    : 'Remove outermost';
}

function setStartStack(arr) {
  startStack = normaliseStack(arr);
  if (monotonic && startStack) startStack.sort((a, b) => a - b);  // non-decreasing idx = weight non-increasing
  updateStartControls();
  updateStartTotalDisplay();
  renderStartViz();
}

function setMonotonic(on) {
  monotonic = !!on;
  monotonicToggle.checked = monotonic;
  if (monotonic && startStack) {  // re-sort existing start stack
    startStack = startStack.slice().sort((a, b) => a - b);
    updateStartControls();
    renderStartViz();
  }
}

function setOneSided(on) {
  oneSided = !!on;
  oneSidedToggle.checked = oneSided;
  // Keep the static two-sided-worded copy honest in one-sided mode.
  const stockLbl = $('stockScopeLabel');
  if (stockLbl) stockLbl.textContent = oneSided ? 'max of each' : 'max per side';
  const loadLbl = $('loadScopeLabel');
  if (loadLbl) loadLbl.textContent = oneSided ? 'on one side only' : 'symmetrically';
  updateWarmupNote();
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
  if (!normaliseStack(arr)) return;  // at cap — ignore click (setStartStack would clear all)
  setStartStack(arr);
  finishStartChange();
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
  if (subEl) subEl.textContent = `Deadlift · ${kg} kg bar`;
  if (startTotalEl) updateStartTotalDisplay();  // start total includes BAR
  if (startVizEl) renderStartViz();              // accessible description includes BAR
}

function setMode(m) {
  if (!['count', 'kg', 'sqrt'].includes(m)) return;
  CURRENT_MODE = m;
  document.querySelectorAll('.mode-btn').forEach(b => {
    const on = b.dataset.mode === m;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    // ARIA radio pattern: only the active radio is in the tab order.
    b.tabIndex = on ? 0 : -1;
  });
}

function setStock(value) {
  const stock = stateLib.clampInteger(value, 0, STOCK_MAX, DEFAULT_STOCK);
  const changed = stock !== plateMax[0];
  stockSlider.style.setProperty('--fill', (stock * 100 / STOCK_MAX) + '%');
  stockSlider.value = String(stock);
  stockValue.textContent = String(stock);
  plateMax.fill(stock);
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
  if (!forceSync && inflightReqs.size > 0) disposeAlgoWorker(true);
  // Skip while tab is hidden, but invalidate any in-flight request so its
  // stale result doesn't render after the user types more.
  if (document.visibilityState === 'hidden') {
    ++currentReqId;
    pendingCompute = true;
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
    out.innerHTML = '<div class="panel empty-state">Enter some weights above.</div>';
    summaryPanel.hidden = true;
    announceStatus('No sets entered.');
    return;
  }

  // Starting stack: the algorithm prepends a pinned "starting state" set
  // when startStack is non-null. renderResults marks it differently and
  // skips its loading cost in totals.
  const hasStart = (startStack !== null);

  const showIndicator = () => {
    if (currentReqId !== reqId) return;
    out.innerHTML = '<div class="panel computing-indicator">Computing…</div>';
    summaryPanel.hidden = true;
    announceStatus('Computing plate sequence.');
  };

  const worker = forceSync ? null : ensureAlgoWorker();
  if (worker) {
    inflightReqs.add(reqId);
    indicatorTimers.set(reqId, setTimeout(showIndicator, INDICATOR_DELAY_MS));
    worker.postMessage({ reqId, weights, mode: CURRENT_MODE, plateMax: plateMax.slice(), PLATES, BAR, startStack, hasStart, monotonic, sided: sided() });
    return;
  }

  // Sync path: yield twice via rAF so the indicator paints BEFORE optimize()
  // blocks the main thread. Otherwise the user sees a frozen UI for slow
  // computes (the 150ms timer can't fire mid-block).
  requestAnimationFrame(() => {
    if (currentReqId !== reqId) return;
    showIndicator();
    requestAnimationFrame(() => {
      if (currentReqId !== reqId) return;
      renderResults(algoLib.optimize(weights, CURRENT_MODE, plateMax, PLATES, BAR, startStack, monotonic, sided()), hasStart);
    });
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pendingCompute) {
    pendingCompute = false;
    compute();
  }
});

// ---------- warmup generator ----------
// 50/70/85/95/100%, rounded to the smallest achievable total increment.
const warmupIncrement = () => sided() * 1.25;

function updateWarmupNote() {
  const note = $('warmupNote');
  if (!note) return;
  note.textContent = `Will create sets at 50%, 70%, 85%, 95% and 100% (rounded to ${fmtKg(warmupIncrement())} kg).`;
}

const generateWarmup = (targetKg) => stateLib.generateWarmup(targetKg, {
  bar: BAR,
  sided: sided(),
});

// ---------- state persistence (localStorage + URL hash) ----------
const snapshotState = () => ({
  input:      inputEl.value,
  mode:       CURRENT_MODE,
  stock:      parseInt(stockSlider.value, 10),
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
  inputEl.value = typeof next.input === 'string' ? next.input : DEFAULT_STATE.input;
  setMode(['count', 'kg', 'sqrt'].includes(next.mode) ? next.mode : DEFAULT_MODE);
  setStock(next.stock);
  setBar(Number.isFinite(next.bar) ? next.bar : DEFAULT_BAR);
  setMonotonic(next.monotonic === true);
  setOneSided(next.oneSided === true);
  setStartStack(Array.isArray(next.startStack) ? next.startStack : null);
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
  const input = inputEl.value.replace(/\r\n?/g, '\n');
  const parts = [];
  if (input) parts.push('w=' + encodeURIComponent(input));
  if (CURRENT_MODE !== DEFAULT_MODE) parts.push('m=' + CURRENT_MODE);
  const stock = parseInt(stockSlider.value, 10);
  if (stock !== DEFAULT_STOCK) parts.push('s=' + stock);
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
const debouncedPersist = debounce(persist, 300);
const scheduleCompute = () => {
  ++currentReqId;  // invalidate any result already in flight before the debounce fires
  if (inflightReqs.size > 0) disposeAlgoWorker(true);
  else for (const reqId of [...indicatorTimers.keys()]) clearIndicator(reqId);
  debouncedCompute();
};

// ---------- event wire-up ----------
stockSlider.addEventListener('input', () => {
  if (!setStock(parseInt(stockSlider.value, 10))) return;
  debouncedPersist();
  if (inputEl.value.trim()) scheduleCompute();
});

barSelect.addEventListener('change', () => { setBar(barSelect.value); persistAndRecompute(); });

monotonicToggle.addEventListener('change', () => {
  setMonotonic(monotonicToggle.checked);
  persistAndRecompute();
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
startClearBtn.addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation();
  setStartStack(null);
  persistAndRecompute();
});

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => { setMode(btn.dataset.mode); persistAndRecompute(); });
});

// Arrow-key navigation within the radio group (ARIA pattern).
$('modes').addEventListener('keydown', (e) => {
  const keys = ['ArrowRight','ArrowLeft','ArrowUp','ArrowDown','Home','End'];
  if (!keys.includes(e.key)) return;
  const btns = Array.from(document.querySelectorAll('.mode-btn'));
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
  debouncedPersist();
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

function closeWarmupDialog() {
  if (typeof warmupDialog.close === 'function') warmupDialog.close();
  else warmupDialog.removeAttribute('open');
}

$('warmup').addEventListener('click', () => {
  if (inputEl.value.trim() && !confirm('Replace current sets with a generated warmup?')) return;
  warmupTarget.value = '140';
  if (typeof warmupDialog.showModal === 'function') warmupDialog.showModal();
  else warmupDialog.setAttribute('open', '');
  requestAnimationFrame(() => { warmupTarget.focus(); warmupTarget.select(); });
});

warmupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const kg = Number(warmupTarget.value);
  closeWarmupDialog();
  if (!Number.isFinite(kg) || kg <= 0 || kg > MAX_TOTAL_KG) return;
  inputEl.value = generateWarmup(kg).join('\n');
  updateComputeBtn();
  persist();
  compute();
  inputEl.focus();
});

$('warmupCancel').addEventListener('click', closeWarmupDialog);

// Copy shareable link
const shareBtn = $('shareBtn');
const SHARE_DEFAULT_LABEL = shareBtn.textContent;
let shareFeedbackTimer = null;
let copyAttemptId = 0;

function showShareFeedback(label, className) {
  if (shareFeedbackTimer !== null) clearTimeout(shareFeedbackTimer);
  shareBtn.textContent = label;
  shareBtn.classList.remove('copied', 'copy-failed');
  shareBtn.classList.add(className);
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
  showShareFeedback(copied ? 'Copied!' : 'Copy failed', copied ? 'copied' : 'copy-failed');
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
  toast.setAttribute('role', 'status');
  toast.innerHTML = '<span>New version available.</span> <button type="button" id="updateReload">Reload</button>';
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
