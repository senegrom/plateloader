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

// ---------- Web Worker for off-main-thread optimisation ----------
// Cancellation is by reqId: stale results are discarded silently.
// Sync fallback if Worker creation fails or the worker errors.
const ALGO_WORKER_SOURCE = `
"use strict";
${buildAlgoLib.toString()}
const algoLib = buildAlgoLib();
self.onmessage = function(e) {
  try {
    const d = e.data;
    self.postMessage({ reqId: d.reqId, hasStart: d.hasStart, results: algoLib.optimize(d.weights, d.mode, d.plateMax, d.PLATES, d.BAR, d.startStack, d.monotonic, d.sided) });
  } catch (err) {
    self.postMessage({ reqId: (e.data && e.data.reqId) || -1, error: String((err && err.message) || err) });
  }
};
`;

let algoWorker = null;
let workerInitTried = false;
let workerEverSucceeded = false;
let workerBlobUrl = null;
let currentReqId = 0;
const inflightReqs = new Set();
const indicatorTimers = new Map();      // reqId → timeoutId
const INDICATOR_DELAY_MS = 150;

function clearIndicator(reqId) {
  const t = indicatorTimers.get(reqId);
  if (t) { clearTimeout(t); indicatorTimers.delete(reqId); }
}

function ensureAlgoWorker() {
  if (algoWorker || workerInitTried) return algoWorker;
  workerInitTried = true;
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || !URL.createObjectURL) return null;
  try {
    workerBlobUrl = URL.createObjectURL(new Blob([ALGO_WORKER_SOURCE], { type: 'text/javascript' }));
    const w = new Worker(workerBlobUrl);
    w.onmessage = (e) => {
      workerEverSucceeded = true;
      const { reqId, results, error, hasStart } = e.data;
      inflightReqs.delete(reqId);
      clearIndicator(reqId);
      if (reqId !== currentReqId) return;
      if (error) { console.warn('[plate-loader] worker error, retrying sync:', error); compute(true); return; }
      renderResults(results, hasStart);
    };
    w.onerror = (e) => {
      // Quiet on first failure (likely env restriction like CSP); log if it
      // happens after a successful run.
      if (workerEverSucceeded) {
        console.warn('[plate-loader] worker died, using sync fallback:',
          { message: e.message || '(empty)', filename: e.filename, lineno: e.lineno });
      }
      try { w.terminate(); } catch (_) {}
      if (workerBlobUrl) { try { URL.revokeObjectURL(workerBlobUrl); } catch (_) {} workerBlobUrl = null; }
      algoWorker = null;
      const hadInflight = inflightReqs.size > 0;
      inflightReqs.clear();
      if (hadInflight) compute(true);
    };
    return algoWorker = w;
  } catch (e) {
    console.warn('[plate-loader] worker init failed, using sync:', e && e.message);
    return null;
  }
}

window.addEventListener('beforeunload', () => {
  if (algoWorker) { try { algoWorker.terminate(); } catch (_) {} algoWorker = null; }
  if (workerBlobUrl) { try { URL.revokeObjectURL(workerBlobUrl); } catch (_) {} workerBlobUrl = null; }
});

// ---------- rendering ----------
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const MAX_TOTAL_KG = 1000;
const MAX_SETS = 50;
const parseInput = (text) => text.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
  .map(Number)
  .filter(n => Number.isFinite(n) && n >= 0 && n <= MAX_TOTAL_KG)
  .slice(0, MAX_SETS);

function renderPlate(plateIdx, opts) {
  const p = PLATES[plateIdx];
  const dark = [20, 10, 2.5, 1.25].includes(p.kg) ? ' dark' : '';
  let cls = `plate ${p.cls}${dark}`;
  if (opts) {
    if (opts.added)   cls += opts.side === 'left' ? ' added-left' : ' added-right';
    if (opts.carried) cls += ' carried';
  }
  return `<div class="${cls}" title="${p.kg} kg plate" aria-hidden="true"><span class="plate-label">${p.label}</span></div>`;
}

function renderBar(stack, prevStack) {
  let i = 0;
  while (i < prevStack.length && i < stack.length && prevStack[i] === stack[i]) i++;
  const newFromIdx = i;

  let leftHtml = '', rightHtml = '';
  if (!oneSided) {
    for (let k = stack.length - 1; k >= 0; k--) leftHtml += renderPlate(stack[k], { added: k >= newFromIdx, carried: k < newFromIdx, side: 'left'  });
  }
  for (let k = 0; k < stack.length; k++)      rightHtml += renderPlate(stack[k], { added: k >= newFromIdx, carried: k < newFromIdx, side: 'right' });

  const counts = {};
  for (const i of stack) counts[PLATES[i].label] = (counts[PLATES[i].label] || 0) + 1;
  const sideText = oneSided ? '' : ' per side';
  const desc = Object.keys(counts).length
    ? Object.entries(counts).map(([k, v]) => `${v} times ${k} kg`).join(', ') + sideText
    : 'bar only';

  return `<div class="bar-wrap"><div class="bar-row" role="img" aria-label="${BAR} kg bar with ${desc}">
    ${leftHtml}<div class="collar"></div><div class="bar"></div><div class="collar"></div>${rightHtml}
  </div></div>`;
}

function plateChips(counts) {
  const parts = [];
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > 0) {
      const n = counts[i], lbl = PLATES[i].label;
      parts.push(`<span class="chip" aria-label="${n} ${lbl} kilogram plate${n !== 1 ? 's' : ''}">${n}× ${lbl} kg</span>`);
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
    ? ` <span style="opacity:0.7">${fmtKg(r.bothSidesKg)} kg</span>` : '';
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
      ${renderBar(r.stack, isStartingState ? [] : (r.isStart ? [] : prevStack))}
      <div class="plate-list">${plateChips(r.counts)}${oneSided ? '' : ' <span style="opacity:0.6">· per side</span>'}</div>`;
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
        ? ` <span style="opacity:0.7">${fmtKg(r.cleanup.bothSidesKg)} kg</span>` : '';
      cleanup.innerHTML = `
        <div class="set-head">
          <div class="set-num">UNLOAD</div>
          <div class="set-total" style="color:var(--ink-dim);">→ bar only</div>
          <div class="set-changes"><span class="delta ${deltaClass(r.cleanup.bothSidesMoves)}">−${r.cleanup.removedIdx.length}${oneSided ? '' : '/side'} · ${r.cleanup.bothSidesMoves} moves</span>${kgDetail}</div>
        </div>
        ${renderBar([], r.stack)}`;
      out.appendChild(cleanup);
      prevStack = [];
    }
  });

  if (validSets > 0) {
    summaryPanel.style.display = '';
    $('summary').innerHTML = `
      <div><span>Sets</span><b>${validSets}${results.length !== validSets ? ` / ${results.length}` : ''}</b></div>
      <div><span>Total plate moves</span><b>${totalMoves}</b></div>
      <div><span>Total kg moved</span><b>${fmtKg(totalKg)}</b></div>
      <div><span>Σ√kg moved</span><b>${totalSqrt.toFixed(2)}</b></div>`;
    $('legend').innerHTML = PLATES.map(p =>
      `<span><i style="background:var(--p-${p.label.replace('.', '_')})"></i>${p.label} kg</span>`
    ).join('');
  } else {
    summaryPanel.style.display = 'none';
  }
}

// ---------- wire-up ----------
const debounce = (fn, ms) => {
  let t = null;
  return function (...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
  };
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
let CURRENT_MODE = 'count';

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
    return;
  }
  // Reuse the same bar visualization style as result cards.
  // For starting state, all plates are "carried" — none animated.
  let leftHtml = '', rightHtml = '';
  if (!oneSided) {
    for (let k = startStack.length - 1; k >= 0; k--) leftHtml += renderPlate(startStack[k], { carried: false, side: 'left' });
  }
  for (let k = 0; k < startStack.length; k++)      rightHtml += renderPlate(startStack[k], { carried: false, side: 'right' });
  startVizEl.innerHTML = `<div class="bar-row">${leftHtml}<div class="collar"></div><div class="bar"></div><div class="collar"></div>${rightHtml}</div>`;
}

function setStartStack(arr) {
  startStack = normaliseStack(arr);
  if (monotonic && startStack) startStack.sort((a, b) => a - b);  // non-decreasing idx = weight non-increasing
  updateStartTotalDisplay();
  renderStartViz();
}

function setMonotonic(on) {
  monotonic = !!on;
  monotonicToggle.checked = monotonic;
  if (monotonic && startStack) {  // re-sort existing start stack
    startStack = startStack.slice().sort((a, b) => a - b);
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
  updateStartTotalDisplay();
  renderStartViz();
}

function buildStartButtons() {
  startButtonsEl.innerHTML = PLATES.map((p, i) =>
    `<button type="button" class="start-btn" data-plate-idx="${i}"
       aria-label="Add a ${p.label} kg plate. Right-click to remove the outermost ${p.label} kg.">
       <span class="swatch" style="background:var(--p-${p.label.replace('.', '_')})"></span>${p.label}
     </button>`
  ).join('');
}

// Click button → push plate to outer end. Right-click → remove the outermost
// occurrence of that type (last index in the array since outermost is last).
function onStartButtonClick(e) {
  const btn = e.target.closest('.start-btn');
  if (!btn) return;
  e.preventDefault();
  const idx = parseInt(btn.dataset.plateIdx, 10);
  const arr = startStack ? startStack.slice() : [];
  arr.push(idx);
  if (!normaliseStack(arr)) return;  // at cap — ignore click (setStartStack would clear all)
  setStartStack(arr);
  persist();
  if (inputEl.value.trim()) debouncedCompute();
}
function onStartButtonContextMenu(e) {
  const btn = e.target.closest('.start-btn');
  if (!btn) return;
  e.preventDefault();
  if (!startStack || startStack.length === 0) return;
  const idx = parseInt(btn.dataset.plateIdx, 10);
  // Find outermost occurrence (last in array) of this plate type.
  for (let i = startStack.length - 1; i >= 0; i--) {
    if (startStack[i] === idx) {
      const arr = startStack.slice();
      arr.splice(i, 1);
      setStartStack(arr.length ? arr : null);
      persist();
      if (inputEl.value.trim()) debouncedCompute();
      return;
    }
  }
}

function setBar(kg) {
  kg = Number(kg);
  if (![0, 10, 15, 20, 25].includes(kg)) kg = DEFAULT_BAR;
  BAR = kg;
  barSelect.value = String(kg);
  const subEl = $('barSub');
  if (subEl) subEl.textContent = `Deadlift · ${kg} kg bar`;
  if (startTotalEl) updateStartTotalDisplay();  // start total includes BAR
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

function setStock(n) {
  n = Math.max(0, Math.min(STOCK_MAX, n | 0));
  stockSlider.style.setProperty('--fill', (n * 100 / STOCK_MAX) + '%');
  if (n === plateMax[0]) return false;
  stockSlider.value = String(n);
  stockValue.textContent = String(n);
  plateMax.fill(n);
  return true;
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
  // Skip while tab is hidden, but invalidate any in-flight request so its
  // stale result doesn't render after the user types more.
  if (document.visibilityState === 'hidden') {
    ++currentReqId;
    pendingCompute = true;
    return;
  }
  const reqId = ++currentReqId;
  const weights = parseInput(inputEl.value);
  const out = $('output');
  const summaryPanel = $('summaryPanel');
  if (weights.length === 0) {
    out.innerHTML = '<div class="panel" style="text-align:center;color:var(--ink-dim);">Enter some weights above.</div>';
    summaryPanel.style.display = 'none';
    return;
  }

  // Starting stack: the algorithm prepends a pinned "starting state" set
  // when startStack is non-null. renderResults marks it differently and
  // skips its loading cost in totals.
  const hasStart = (startStack !== null);

  const showIndicator = () => {
    if (currentReqId !== reqId) return;
    out.innerHTML = '<div class="panel computing-indicator">Computing…</div>';
    summaryPanel.style.display = 'none';
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
// 50/70/85/95/100% rounded to nearest 2.5 kg, deduplicated, ≥ BAR.
function generateWarmup(targetKg) {
  const seen = new Set();
  const out = [];
  for (const pct of [0.50, 0.70, 0.85, 0.95, 1.00]) {
    let w = Math.round((targetKg * pct) / 2.5) * 2.5;
    if (w < BAR) w = BAR;
    if (!seen.has(w)) { seen.add(w); out.push(w); }
  }
  return out;
}

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

const saveState = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify(snapshotState())); } catch (_) {} };

function loadStateFromStorage() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (_) {}
  if (!s) return;
  if (typeof s.input === 'string') inputEl.value = s.input;
  if (s.mode) setMode(s.mode);
  if (Number.isFinite(s.stock)) setStock(s.stock);
  if (Number.isFinite(s.bar)) setBar(s.bar);
  if (typeof s.monotonic === 'boolean') setMonotonic(s.monotonic);
  if (typeof s.oneSided === 'boolean')  setOneSided(s.oneSided);
  if (Array.isArray(s.startStack)) setStartStack(s.startStack);
  if (s.compact) setCompact(true);
}

function serializeHash() {
  const weights = parseInput(inputEl.value).join(',');
  const parts = [];
  if (weights) parts.push('w=' + weights);
  if (CURRENT_MODE !== 'count') parts.push('m=' + CURRENT_MODE);
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

function parseHash() {
  const h = location.hash.slice(1);
  if (!h) return null;
  const out = {};
  for (const pair of h.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    try { out[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1)); } catch (_) {}
  }
  return out;
}

function applyHash(h) {
  if (!h) return false;
  let used = false;
  if (h.w) { inputEl.value = h.w.split(',').filter(Boolean).join('\n'); used = true; }
  if (h.m) { setMode(h.m); used = true; }
  if (h.s !== undefined && Number.isFinite(+h.s)) { setStock(+h.s); used = true; }
  if (h.b !== undefined && Number.isFinite(+h.b)) { setBar(+h.b); used = true; }
  if (h.o === '1') { setMonotonic(true); used = true; }
  if (h.x === '1') { setOneSided(true); used = true; }
  if (h.i) {
    const arr = h.i.split('.').map(s => parseInt(s, 10));
    setStartStack(arr);  // normaliseStack rejects invalid entries
    used = true;
  }
  if (h.c === '1') { setCompact(true); used = true; }
  return used;
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

// ---------- event wire-up ----------
stockSlider.addEventListener('input', () => {
  if (!setStock(parseInt(stockSlider.value, 10))) return;
  debouncedPersist();
  if (inputEl.value.trim()) debouncedCompute();
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
  updateComputeBtn();
  debouncedPersist();
  debouncedCompute();
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
  warmupDialog.close();
  if (!Number.isFinite(kg) || kg <= 0 || kg > MAX_TOTAL_KG) return;
  inputEl.value = generateWarmup(kg).join('\n');
  updateComputeBtn();
  persist();
  compute();
  inputEl.focus();
});

$('warmupCancel').addEventListener('click', () => warmupDialog.close());

// Copy shareable link
const shareBtn = $('shareBtn');
shareBtn.addEventListener('click', async () => {
  const url = location.href;
  const flash = () => {
    const orig = shareBtn.textContent;
    shareBtn.textContent = 'Copied!';
    shareBtn.classList.add('copied');
    setTimeout(() => { shareBtn.textContent = orig; shareBtn.classList.remove('copied'); }, 1400);
  };
  try {
    await navigator.clipboard.writeText(url);
    flash();
  } catch (_) {
    // Fallback for older browsers / non-secure contexts.
    const tmp = document.createElement('input');
    tmp.value = url; tmp.style.position = 'fixed'; tmp.style.opacity = '0';
    document.body.appendChild(tmp); tmp.select();
    try { document.execCommand('copy'); flash(); } catch (__) {}
    document.body.removeChild(tmp);
  }
});

// Platform-correct keyboard shortcut labels
const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || /Mac/.test(navigator.userAgent || '');
const kbd = $('shortcutKbd'); if (kbd) kbd.textContent = isMac ? '⌘+Enter' : 'Ctrl+Enter';
const kbdFocus = $('shortcutFocusKbd'); if (kbdFocus) kbdFocus.textContent = isMac ? '⌘+K' : 'Ctrl+K';

// Cmd/Ctrl+K focuses the input from anywhere on the page
document.addEventListener('keydown', (e) => {
  if (e.key === 'k' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    inputEl.focus();
    inputEl.select();
  }
});

// Build dynamic UI before restoring state.
buildStartButtons();
renderStartViz();
updateStartTotalDisplay();

// Restore: storage first, then URL hash overlays its specific fields.
loadStateFromStorage();
applyHash(parseHash());
setStock(parseInt(stockSlider.value, 10));
setBar(BAR);
setMode(CURRENT_MODE);  // ensure tabIndex/aria-checked reflect default on fresh load
updateComputeBtn();
// Auto-expand the start panel if there's a non-empty starting stack.
if (startStack && startStack.length > 0) startDetails.open = true;
if (inputEl.value.trim()) compute();

window.addEventListener('hashchange', () => {
  if (applyHash(parseHash())) { persist(); updateComputeBtn(); compute(); }
});

// ---------- Service worker registration (PWA / offline) ----------
function showUpdateToast() {
  if ($('updateToast')) return;
  const t = document.createElement('div');
  t.id = 'updateToast';
  t.className = 'update-toast';
  t.innerHTML = '<span>New version available.</span> <button type="button" id="updateReload">Reload</button>';
  document.body.appendChild(t);
  $('updateReload').addEventListener('click', () => location.reload());
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then((reg) => {
      // If an update completed before our listener attached (e.g., on tab reopen),
      // catch it now.
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast();
      reg.addEventListener('updatefound', () => {
        const newSw = reg.installing;
        if (!newSw) return;
        newSw.addEventListener('statechange', () => {
          if (newSw.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast();
        });
      });
    }).catch(() => {});
  });
}
