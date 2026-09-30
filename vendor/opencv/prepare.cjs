// Reproduce the packaged CSP-safe OpenCV glue from the pinned upstream bundle.
// Usage: node vendor/opencv/prepare.cjs <path-to-original-opencv.js>
// The WebAssembly payload is preserved byte-for-byte. See README.md for sources.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const input = fs.readFileSync(process.argv[2]);
assert.equal(hash(input), 'c7d6967284acc7eb50897eeb4186690444396bbE834aeb7caf7a565285976829'.toLowerCase(), 'Unexpected upstream OpenCV version');
let source = input.toString('utf8');
const wasm = source.match(/data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/)?.[1];
assert.ok(wasm, 'Expected the pinned single-file WebAssembly payload');
function replaceFunction(name, nextMarker, replacement) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, `Missing patch boundary: ${name}`);
  source = source.slice(0, start) + replacement.toString() + source.slice(end);
}

// Emscripten's DYNAMIC_EXECUTION=0 branch (2.0.10 embind/embind.js).
replaceFunction('createNamedFunction', 'function extendError(', function createNamedFunction(name, body) {
  return function() { 'use strict'; return body.apply(this, arguments); };
});
// The legacy dynCall bridge retains its signature/table lookup, changing only
// the generated invocation to the equivalent static closure.
replaceFunction('makeDynCaller', 'var fp;', function makeDynCaller(dynCall) {
  return function() { return dynCall.apply(null, [rawFunction].concat(Array.prototype.slice.call(arguments))); };
});
replaceFunction('craftInvokerFunction', 'function heap32VectorToArray(', function craftInvokerFunction(humanName, argTypes, classType, cppInvokerFunc, cppTargetFunc) {
  var argCount = argTypes.length;
  if (argCount < 2) throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!");
  var isClassMethodFunc = argTypes[1] !== null && classType !== null;
  var needsDestructorStack = argTypes.slice(1).some(function(type) { return type !== null && type.destructorFunction === undefined; });
  var returns = argTypes[0].name !== 'void';
  var expectedArgCount = argCount - 2;
  return function() {
    if (arguments.length !== expectedArgCount) throwBindingError('function ' + humanName + ' called with ' + arguments.length + ' arguments, expected ' + expectedArgCount + ' args!');
    // Call-local arrays also preserve correctness for re-entrant JS callbacks.
    var destructors = [], argsWired = [], invokerFuncArgs = [cppTargetFunc], thisWired;
    if (isClassMethodFunc) {
      thisWired = argTypes[1].toWireType(destructors, this);
      invokerFuncArgs.push(thisWired);
    }
    for (var i = 0; i < expectedArgCount; ++i) {
      argsWired[i] = argTypes[i + 2].toWireType(destructors, arguments[i]);
      invokerFuncArgs.push(argsWired[i]);
    }
    var rv = cppInvokerFunc.apply(null, invokerFuncArgs);
    if (needsDestructorStack) runDestructors(destructors);
    else for (var i = isClassMethodFunc ? 1 : 2; i < argTypes.length; ++i) {
      if (argTypes[i].destructorFunction !== null) argTypes[i].destructorFunction(i === 1 ? thisWired : argsWired[i - 2]);
    }
    if (returns) return argTypes[0].fromWireType(rv);
  };
});
// Emscripten's DYNAMIC_EXECUTION=0 branch (2.0.10 embind/emval.js).
replaceFunction('__emval_get_method_caller', 'function __emval_get_property(', function __emval_get_method_caller(argCount, argTypes) {
  var types = __emval_lookupTypes(argCount, argTypes), retType = types[0];
  var invokerFunction = function(handle, name, destructors, args) {
    var offset = 0, argN = [];
    for (var i = 0; i < argCount - 1; ++i) {
      argN[i] = types[i + 1].readValueFromPointer(args + offset);
      offset += types[i + 1].argPackAdvance;
    }
    var rv = handle[name].apply(handle, argN);
    for (var i = 0; i < argCount - 1; ++i) if (types[i + 1].deleteObject) types[i + 1].deleteObject(argN[i]);
    if (!retType.isVoid) return retType.toWireType(destructors, rv);
  };
  return __emval_addMethodCaller(invokerFunction);
});
assert.doesNotMatch(source, /new Function|new_\(Function|\beval\s*\(/, 'Dynamic JS execution must not remain');
assert.equal(source.match(/data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/)?.[1], wasm);
source = source.replaceAll('root.cv = factory()', 'root.__PAGEPATH_OPENCV__ = factory()');
// Embedded WASM is already available locally. Decode it directly instead of
// asking fetch() for a data URL (which connect-src 'none' correctly rejects).
const fetchGuard = 'if(!wasmBinary&&(ENVIRONMENT_IS_WEB||ENVIRONMENT_IS_WORKER)&&typeof fetch==="function")';
assert.equal(source.split(fetchGuard).length, 2, 'Expected the upstream single-file fetch guard');
source = source.replace(fetchGuard, 'if(!wasmBinary&&!isDataURI(wasmBinaryFile)&&(ENVIRONMENT_IS_WEB||ENVIRONMENT_IS_WORKER)&&typeof fetch==="function")');
// Keep the upstream UMD factory's options local instead of writing global Module.
source = source.replace("if (typeof Module === 'undefined')\n    Module = {};", "if (typeof Module === 'undefined')\n    var Module = {};");
source = `/* OpenCV 4.12.0 — CSP-safe Embind bridge; see vendor/opencv/README.md. */\n(function() {\nif (globalThis.__PAGEPATH_OPENCV__) {\n  if (typeof module === 'object' && module.exports) module.exports = globalThis.__PAGEPATH_OPENCV__;\n  return;\n}\n${source}\nif (typeof module === 'object' && module.exports) globalThis.__PAGEPATH_OPENCV__ = module.exports;\n}).call(globalThis);\n`;
fs.writeFileSync(path.join(__dirname, 'opencv.js'), source);
console.log(JSON.stringify({ upstreamSHA256: hash(input), packagedSHA256: hash(source), wasmSHA256: hash(Buffer.from(wasm, 'base64')), bytes: Buffer.byteLength(source) }, null, 2));
