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
    const hasStart = algoLib.hasPinnedStart(data.weights, data.startStack, results);
    self.postMessage({ reqId: data.reqId, hasStart, results });
  } catch (error) {
    self.postMessage({
      reqId: event.data?.reqId ?? -1,
      error: String((error && error.message) || error),
    });
  }
};
