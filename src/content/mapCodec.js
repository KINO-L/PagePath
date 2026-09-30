(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const MiB = 1024 * 1024;
  const LIMITS = Object.freeze({ maxPixels: 8500000, maxRawBytes: 128 * MiB,
    maxCompressedBytes: 42 * MiB, maxMetadataBytes: 3 * MiB, maxPacketChars: 60 * MiB });
  const FORMAT = 'pagepath-pixel-map';
  const fail = reason => new Error(`地图传输失败：${reason}`);

  function layout(width, height, segmentValues) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        !Number.isSafeInteger(width * height) || width * height > LIMITS.maxPixels ||
        !Number.isInteger(segmentValues) || segmentValues < 0 || segmentValues % 4) {
      throw fail('截图尺寸或轮廓长度无效');
    }
    const pixels = width * height;
    const distance = Math.ceil(pixels * 2 / 4) * 4;
    const labels = distance + pixels * 4;
    const segments = labels + pixels * 4;
    const byteLength = segments + segmentValues * 4;
    if (!Number.isSafeInteger(byteLength) || byteLength > LIMITS.maxRawBytes) {
      throw fail('地图数据过大，请缩小浏览器窗口后重试');
    }
    return { pixels, distance, labels, segments, byteLength };
  }

  function metadata(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.components) ||
        !value.stats || typeof value.stats !== 'object' || Array.isArray(value.stats) ||
        !Number.isInteger(value.bucketSize) || value.bucketSize < 8 || value.bucketSize > 4096) {
      throw fail('地图区域信息无效');
    }
    let json;
    try { json = JSON.stringify(value); } catch { throw fail('地图区域信息无法编码'); }
    if (!json || json.length > LIMITS.maxMetadataBytes) throw fail('地图区域信息过多，请换一个页面位置');
    const length = new TextEncoder().encode(json).byteLength;
    if (length > LIMITS.maxMetadataBytes) throw fail('地图区域信息过多，请换一个页面位置');
    return { value: JSON.parse(json), length };
  }

  function readable(bytes) {
    return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  }

  async function readBounded(stream, maximum) {
    const reader = stream.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maximum) {
          await reader.cancel();
          throw fail('压缩数据超过安全上限，请缩小浏览器窗口');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }

  function toBase64(bytes) {
    // A multiple of three avoids padding in the middle of the combined string.
    const pieces = [], chunkSize = 24576;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      pieces.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))));
    }
    return pieces.join('');
  }

  function fromBase64(text) {
    if (typeof text !== 'string' || !text.length || text.length % 4 ||
        text.length > Math.ceil(LIMITS.maxCompressedBytes / 3) * 4) throw fail('压缩地图长度无效');
    let binary;
    try { binary = atob(text); } catch { throw fail('压缩地图编码无效'); }
    if (binary.length > LIMITS.maxCompressedBytes) throw fail('压缩地图超过传输上限');
    const result = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
    return result;
  }

  function requireStreams() {
    if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function' ||
        typeof ReadableStream !== 'function') throw fail('当前浏览器不支持地图压缩，请更新浏览器');
  }

  function copyBytes(destination, offset, source, length, bytesPerElement) {
    if (!ArrayBuffer.isView(source) || source.length !== length || source.BYTES_PER_ELEMENT !== bytesPerElement ||
        source.byteLength !== length * bytesPerElement) throw fail('地图像素数据长度无效');
    destination.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength), offset);
  }

  async function encode(map) {
    requireStreams();
    if (map?.kind !== 'pixel-mask' || map.width !== map.maskWidth || map.height !== map.maskHeight) {
      throw fail('只能传输截图像素地图');
    }
    const segmentValues = map.contours?.segments?.length;
    const format = layout(map.width, map.height, segmentValues);
    const meta = metadata({ components: map.components, stats: map.stats,
      bucketSize: map.contours.bucketSize ?? 64 });
    let raw = new Uint8Array(format.byteLength);
    copyBytes(raw, 0, map.obstacleMask, format.pixels, 1);
    copyBytes(raw, format.pixels, map.walkableMask, format.pixels, 1);
    copyBytes(raw, format.distance, map.distanceMap, format.pixels, 4);
    copyBytes(raw, format.labels, map.componentLabels, format.pixels, 4);
    copyBytes(raw, format.segments, map.contours.segments, segmentValues, 4);
    let compressed;
    try { compressed = await readBounded(readable(raw).pipeThrough(new CompressionStream('gzip')), LIMITS.maxCompressedBytes); }
    catch (error) { throw error?.message?.startsWith('地图传输失败') ? error : fail('地图压缩未完成'); }
    raw = null; // Do not retain the uncompressed duplicate while creating base64.
    const payload = toBase64(compressed);
    compressed = null;
    if (payload.length + meta.length + 1024 > LIMITS.maxPacketChars) throw fail('地图超过浏览器消息大小上限');
    return { format: FORMAT, version: 1, encoding: 'gzip-base64', width: map.width, height: map.height,
      segmentValues, byteLength: format.byteLength, metadata: meta.value, payload };
  }

  function rebuildContours(segments, width, height, bucketSize) {
    const buckets = Object.create(null);
    let entries = 0;
    for (let i = 0; i < segments.length; i += 4) {
      const x1 = segments[i], y1 = segments[i + 1], x2 = segments[i + 2], y2 = segments[i + 3];
      if (![x1, y1, x2, y2].every(Number.isFinite) ||
          Math.min(x1, x2) < 0 || Math.min(y1, y2) < 0 || Math.max(x1, x2) > width || Math.max(y1, y2) > height ||
          (x1 === x2) === (y1 === y2)) throw fail('地图轮廓坐标无效');
      const left = Math.floor(Math.min(x1, x2) / bucketSize), right = Math.floor(Math.max(x1, x2) / bucketSize);
      const top = Math.floor(Math.min(y1, y2) / bucketSize), bottom = Math.floor(Math.max(y1, y2) / bucketSize);
      entries += (right - left + 1) * (bottom - top + 1);
      if (entries > 8000000) throw fail('地图轮廓过于复杂，请换一个页面位置');
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        (buckets[`${x},${y}`] ||= []).push(i / 4);
      }
    }
    return { segments, bucketSize, buckets };
  }

  async function decode(packet) {
    requireStreams();
    if (!packet || packet.format !== FORMAT || packet.version !== 1 || packet.encoding !== 'gzip-base64') {
      throw fail('地图数据格式或版本无效');
    }
    const format = layout(packet.width, packet.height, packet.segmentValues);
    if (packet.byteLength !== format.byteLength) throw fail('地图数据长度与尺寸不符');
    const meta = metadata(packet.metadata);
    if (typeof packet.payload !== 'string' || packet.payload.length + meta.length + 1024 > LIMITS.maxPacketChars) {
      throw fail('地图超过浏览器消息大小上限');
    }
    let compressed = fromBase64(packet.payload), raw;
    try { raw = await readBounded(readable(compressed).pipeThrough(new DecompressionStream('gzip')), format.byteLength); }
    catch (error) { throw error?.message?.startsWith('地图传输失败') ? error : fail('压缩地图已损坏'); }
    compressed = null;
    if (raw.byteLength !== format.byteLength) throw fail('解压后的地图长度不符');
    // All views share one owned buffer, avoiding another full-sized map copy.
    const buffer = raw.buffer;
    const obstacleMask = new Uint8Array(buffer, 0, format.pixels);
    const walkableMask = new Uint8Array(buffer, format.pixels, format.pixels);
    const distanceMap = new Float32Array(buffer, format.distance, format.pixels);
    const componentLabels = new Int32Array(buffer, format.labels, format.pixels);
    const segments = new Float32Array(buffer, format.segments, packet.segmentValues);
    for (let i = 0; i < format.pixels; i++) {
      if (obstacleMask[i] > 1 || walkableMask[i] > 1 || !Number.isFinite(distanceMap[i]) || distanceMap[i] < 0 ||
          componentLabels[i] < 0 || (walkableMask[i] && (!componentLabels[i] || obstacleMask[i]))) {
        throw fail('地图像素内容无效');
      }
    }
    const contours = rebuildContours(segments, packet.width, packet.height, meta.value.bucketSize);
    return { kind: 'pixel-mask', width: packet.width, height: packet.height,
      maskWidth: packet.width, maskHeight: packet.height, obstacleMask, walkableMask,
      distanceMap, componentLabels, contours, components: meta.value.components, stats: meta.value.stats };
  }

  P.MapCodec = Object.freeze({ encode, decode, limits: LIMITS });
})();
