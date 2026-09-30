# OpenCV.js 4.12.0 (offline, CSP-compatible)

`opencv.js` contains OpenCV's actual WebAssembly implementation, including Lab
color conversion, morphology, distance transform and connected components. No
runtime download or CDN is used. Size: **10,871,732 bytes** before ZIP compression.

## Source and integrity

The original file is `4.12.0/opencv.js` inside the official release archive:

- [OpenCV 4.12.0 documentation archive](https://github.com/opencv/opencv/releases/download/4.12.0/opencv-4.12.0-docs.zip)
- [OpenCV.js build documentation](https://docs.opencv.org/4.12.0/d4/da1/tutorial_js_setup.html)
- [OpenCV 4.12.0 source and Apache-2.0 license](https://github.com/opencv/opencv/tree/4.12.0)

SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| Official original `opencv.js` | `c7d6967284acc7eb50897eeb4186690444396bbe834aeb7caf7a565285976829` |
| Packaged `opencv.js` | `504349c22df7aae41a96f80cf3c68820b43fc0a61a08ac2bca6a5a33948ac1dd` |
| Embedded decoded WASM | `8e7b0a2f1fa7e2c319b249ccc121a69bf0cd5e415b7927abca0e961ccd5f4000` |

## CSP adaptation

The original Emscripten glue creates JavaScript functions dynamically. Manifest V3
prohibits this. PagePath uses static closure implementations of four glue functions:
`createNamedFunction`, `makeDynCaller`, `craftInvokerFunction`, and
`__emval_get_method_caller`. The replacements follow Emscripten's official
`DYNAMIC_EXECUTION=0` branches; this is a reproducible JavaScript glue patch, not a
claim that the original binary was rebuilt with that flag. Call-local argument
arrays preserve correctness for re-entrant callbacks. The legacy `dynCall` lookup
and all native OpenCV operations remain intact.

References and license for those bridge implementations:

- [Emscripten 2.0.10 embind.js](https://github.com/emscripten-core/emscripten/blob/2.0.10/src/embind/embind.js)
- [Emscripten 2.0.10 emval.js](https://github.com/emscripten-core/emscripten/blob/2.0.10/src/embind/emval.js)
- [Emscripten dynamic execution setting](https://emscripten.org/docs/tools_reference/settings_reference.html#dynamic-execution)
- `LICENSE.emscripten` contains its MIT / University of Illinois-NCSA license.

The UMD factory's configuration is made local and the export is stored at
`globalThis.__PAGEPATH_OPENCV__`. A guard avoids allocating a second WASM runtime
on reinjection. The WASM payload is byte-for-byte identical to the official file.
No JavaScript `eval()` or `new Function()` is used, and no `unsafe-eval` permission
is added.

The single-file loader decodes its embedded data directly instead of passing the
data URL to `fetch()`. This keeps the extension's `connect-src 'none'` policy intact.
OpenCV runs in the extension service worker with the narrowly scoped
`wasm-unsafe-eval` CSP token. Strict webpage CSP therefore cannot prevent analysis,
and the webpage/content script receives cached masks rather than the WASM runtime.

## Reproduce

Download and extract the original official release file, then run from the project
root:

```powershell
node vendor/opencv/prepare.cjs C:/path/to/original/4.12.0/opencv.js
```

The script refuses an unexpected input hash, checks that the embedded WASM did not
change, rejects dynamic code generation, and prints the resulting hashes.

`src/content/opencvRuntime.js` provides one cached initialization promise and
per-request cancellation. Its `ready()` method removes the upstream runtime's
legacy self-returning `then` method after startup to prevent Promise assimilation
loops. OpenCV matrices must still be released with `.delete()` by each caller.
