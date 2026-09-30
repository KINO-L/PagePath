'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const context = vm.createContext({ CompressionStream, DecompressionStream, ReadableStream, TextEncoder, atob, btoa });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content/mapCodec.js'), 'utf8'), context);
const codec = context.__PAGEPATH__.MapCodec;

function fixture(width = 17, height = 13) {
  const pixels = width * height;
  const obstacleMask = new Uint8Array(pixels), walkableMask = new Uint8Array(pixels);
  const distanceMap = new Float32Array(pixels), componentLabels = new Int32Array(pixels);
  let area = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    obstacleMask[i] = x % 113 >= 50 && x % 113 < 55 && y % 81 < 44 ? 1 : 0;
    const border = Math.min(x + 0.5, y + 0.5, width - x - 0.5, height - y - 0.5);
    distanceMap[i] = obstacleMask[i] ? 0 : Math.min(border, 23.5 + (x % 19) * 0.25);
    walkableMask[i] = distanceMap[i] > 2.707107 ? 1 : 0;
    componentLabels[i] = walkableMask[i]; area += walkableMask[i];
  }
  const segments = Float32Array.from([3, 3, width - 3, 3, width - 3, 3, width - 3, height - 3,
    width - 3, height - 3, 3, height - 3, 3, height - 3, 3, 3]);
  return { kind: 'pixel-mask', width, height, maskWidth: width, maskHeight: height,
    obstacleMask, walkableMask, distanceMap, componentLabels,
    components: [{ id: 1, area, left: 3, top: 3, width: width - 6, height: height - 6 }],
    contours: { segments, bucketSize: 64, buckets: { discarded: [99] } },
    stats: { obstacleRatio: 0.12, walkablePixels: area, clearance: 2, walkableThreshold: 2.707107 } };
}

test('gzip map roundtrip survives Chrome JSON serialization with exact typed-array values and odd pixel alignment', async () => {
  const source = fixture();
  const packet = JSON.parse(JSON.stringify(await codec.encode(source)));
  assert.equal(packet.format, 'pagepath-pixel-map');
  assert.equal(packet.encoding, 'gzip-base64');
  assert.equal(typeof packet.payload, 'string');
  const decoded = await codec.decode(packet);
  for (const field of ['obstacleMask', 'walkableMask', 'distanceMap', 'componentLabels']) {
    assert.deepEqual(Array.from(decoded[field]), Array.from(source[field]), field);
  }
  assert.deepEqual(Array.from(decoded.contours.segments), Array.from(source.contours.segments));
  assert.deepEqual(JSON.parse(JSON.stringify(decoded.components)), source.components);
  assert.deepEqual(JSON.parse(JSON.stringify(decoded.stats)), source.stats);
  assert.equal(decoded.width, source.width);
  assert.equal(decoded.maskWidth, source.width);
  assert.equal(decoded.walkableMask.buffer, decoded.distanceMap.buffer, 'decoded views share one owned binary allocation');
  assert.equal(Object.getPrototypeOf(decoded.contours.buckets), null);
  assert.equal(decoded.contours.buckets.discarded, undefined, 'bucket cache must be rebuilt, not sent through JSON');
  assert.deepEqual(Array.from(decoded.contours.buckets['0,0']), [0, 1, 2, 3]);
});

test('invalid packet headers, lengths and damaged gzip fail before a usable map is returned', async () => {
  const packet = await codec.encode(fixture());
  for (const change of [
    { format: 'other' }, { version: 2 }, { encoding: 'raw' }, { width: -1 }, { width: 9000, height: 1000 },
    { height: 1.5 }, { segmentValues: 3 }, { segmentValues: 100000000 },
    { byteLength: packet.byteLength + 1 }, { payload: '' }, { payload: '!!!!' },
    { metadata: { ...packet.metadata, bucketSize: 0 } }, { metadata: { ...packet.metadata, components: null } },
  ]) {
    await assert.rejects(codec.decode({ ...packet, ...change }), /地图传输失败/);
  }
  const corrupt = packet.payload.slice(0, 12) + 'AAAA' + packet.payload.slice(16);
  await assert.rejects(codec.decode({ ...packet, payload: corrupt }), /地图传输失败/);
  const truncated = Buffer.from(Buffer.from(packet.payload, 'base64').subarray(0, 8)).toString('base64');
  await assert.rejects(codec.decode({ ...packet, payload: truncated }), /地图传输失败/);
});

test('decompression is bounded by the validated declared map length, including highly compressible payloads', async () => {
  const large = await codec.encode(fixture(1024, 1024));
  const small = await codec.encode(fixture());
  await assert.rejects(codec.decode({ ...small, payload: large.payload }), /超过安全上限/);
});

test('wrong input buffers and invalid reconstructed pixels or contours are rejected', async () => {
  const source = fixture();
  await assert.rejects(codec.encode({ ...source, obstacleMask: new Uint8Array(1) }), /像素数据长度/);
  await assert.rejects(codec.encode({ ...source, kind: 'dom' }), /只能传输截图/);
  await assert.rejects(codec.encode({ ...source, stats: { note: '墨'.repeat(1100000) } }), /区域信息过多/,
    'the JSON budget must count UTF-8 bytes, not just JavaScript string length');
  const corrupt = fixture();
  corrupt.distanceMap[8] = NaN;
  await assert.rejects(codec.decode(await codec.encode(corrupt)), /像素内容无效/);
  const badContour = fixture();
  badContour.contours.segments[0] = -1;
  await assert.rejects(codec.decode(await codec.encode(badContour)), /轮廓坐标无效/);
  const overlap = fixture();
  overlap.obstacleMask[80] = 1; overlap.walkableMask[80] = 1; overlap.componentLabels[80] = 1;
  await assert.rejects(codec.decode(await codec.encode(overlap)), /像素内容无效/);
});

test('a 4K viewport stays under the Chrome JSON message budget and reconstructs the complete masks', async t => {
  const source = fixture(3840, 2160);
  const started = performance.now();
  const packet = await codec.encode(source);
  const json = JSON.stringify(packet);
  assert.ok(Buffer.byteLength(json, 'utf8') < 60 * 1024 * 1024, 'the runtime message must remain below Chrome\'s 64MiB ceiling');
  assert.ok(packet.byteLength > 80 * 1024 * 1024 - 2 * 1024 * 1024, 'test must cover the full-sized raw float and label maps');
  const decoded = await codec.decode(JSON.parse(json));
  for (const field of ['obstacleMask', 'walkableMask', 'distanceMap', 'componentLabels']) {
    assert.equal(decoded[field].length, source[field].length);
    assert.deepEqual(Buffer.from(decoded[field].buffer, decoded[field].byteOffset, decoded[field].byteLength),
      Buffer.from(source[field].buffer, source[field].byteOffset, source[field].byteLength), field);
  }
  t.diagnostic(`4K binary ${(packet.byteLength / 1024 / 1024).toFixed(1)}MiB -> JSON ${(Buffer.byteLength(json) / 1024 / 1024).toFixed(2)}MiB; roundtrip ${Math.round(performance.now() - started)}ms`);
});
