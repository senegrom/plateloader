'use strict';

importScripts('algo.js');

const algoLib = buildAlgoLib();

self.onmessage = function (event) {
  try {
    const data = event.data;
    const results = algoLib.optimize(
      data.weights,
      data.mode,
      data.plateMax,
      data.plateKg,
      data.BAR,
      data.startStack,
      data.monotonic,
      data.sided,
    );
    const requestedCount = Array.isArray(data.weights) ? data.weights.length : 0;
    const hasStart = Boolean(
      Array.isArray(data.startStack) &&
      data.startStack.length &&
      results.length === requestedCount + 1
    );
    self.postMessage({ reqId: data.reqId, hasStart, results });
  } catch (error) {
    self.postMessage({
      reqId: event.data?.reqId ?? -1,
      error: String((error && error.message) || error),
    });
  }
};
