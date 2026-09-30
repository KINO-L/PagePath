(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  if (P.OpenCV) return;
  let pending;
  const aborted = () => new DOMException('OpenCV initialization cancelled.', 'AbortError');

  function initialize() {
    return new Promise((resolve, reject) => {
      const runtime = globalThis.__PAGEPATH_OPENCV__;
      if (!runtime) return reject(new Error('The packaged OpenCV runtime was not loaded.'));
      const timeout = setTimeout(() => reject(new Error('OpenCV initialization timed out.')), 30000);
      const finish = () => {
        clearTimeout(timeout);
        if (!runtime.Mat || !runtime.cvtColor || !runtime.distanceTransform || !runtime.connectedComponentsWithStats) {
          reject(new Error('The packaged OpenCV runtime is missing required image-analysis functions.'));
          return;
        }
        // This Emscripten build implements a self-returning legacy thenable.
        // Remove it after initialization so Promise resolution does not recurse.
        delete runtime.then;
        resolve(runtime);
      };
      if (runtime.Mat && runtime.calledRun) return finish();
      const previousAbort = runtime.onAbort;
      runtime.onAbort = reason => {
        clearTimeout(timeout);
        try { previousAbort?.(reason); }
        finally { reject(new Error(`OpenCV initialization failed: ${String(reason)}`)); }
      };
      if (typeof runtime.then === 'function') runtime.then(finish);
      else {
        const previousReady = runtime.onRuntimeInitialized;
        runtime.onRuntimeInitialized = () => { previousReady?.(); finish(); };
      }
    });
  }

  P.OpenCV = Object.freeze({
    ready({ signal } = {}) {
      if (signal?.aborted) return Promise.reject(aborted());
      pending ||= initialize();
      if (!signal) return pending;
      // Cancellation stops this generation request, never the shared WASM runtime.
      return new Promise((resolve, reject) => {
        const cancel = () => { cleanup(); reject(aborted()); };
        const cleanup = () => signal.removeEventListener('abort', cancel);
        signal.addEventListener('abort', cancel, { once: true });
        pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      });
    },
  });
})();
