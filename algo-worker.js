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
      data.PLATES,
      data.BAR,
      data.startStack,
      data.monotonic,
      data.sided,
    );
    self.postMessage({ reqId: data.reqId, hasStart: data.hasStart, results });
  } catch (error) {
    self.postMessage({
      reqId: event.data?.reqId ?? -1,
      error: String((error && error.message) || error),
    });
  }
};
