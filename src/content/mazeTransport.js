(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};
  const FORMAT = 'pagepath-maze', MAX_BYTES = 60 * 1024 * 1024, MAX_METADATA_BYTES = 8 * 1024 * 1024;
  const omitted = new Set(['analysis', 'obstacleIndex', 'mazeOriginalAnalysis', 'mazeSourceAnalysis']);
  const fail = () => new Error('地图暂未准备好，请刷新后重试');
  const abort = signal => {
    if (signal?.aborted) throw Object.assign(new Error('地图生成已取消'), { name: 'AbortError' });
  };
  const point = (value, width, height) => value && Number.isFinite(value.x) && Number.isFinite(value.y) &&
    value.x >= 0 && value.y >= 0 && value.x < width && value.y < height;

  // Count payload strings directly: serializing a whole multi-map message just
  // to measure it would temporarily duplicate tens of megabytes on the UI thread.
  function jsonBytes(value, maximum = MAX_METADATA_BYTES) {
    let json;
    try { json = JSON.stringify(value); } catch { throw fail(); }
    if (typeof json !== 'string' || json.length > maximum) throw fail();
    const size = new TextEncoder().encode(json).byteLength;
    if (size > maximum) throw fail();
    return { json, size };
  }

  function mapBytes(packet, width, height) {
    if (!packet || typeof packet !== 'object' || packet.width !== width || packet.height !== height ||
        typeof packet.payload !== 'string' || packet.payload.length > MAX_BYTES) throw fail();
    const { payload, ...header } = packet;
    // A MapCodec base64 payload contains no characters needing JSON escaping.
    // Header validation remains MapCodec's responsibility.
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) throw fail();
    return payload.length + jsonBytes(header).size + 32;
  }

  function validateMetadata(metadata, width, height) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
        [...omitted].some(key => Object.hasOwn(metadata, key)) ||
        metadata.unlimitedInk !== true || metadata.maxInk !== null ||
        !Number.isInteger(metadata.difficulty) || metadata.difficulty < 0 || metadata.difficulty > 100 ||
        metadata.stars !== P.Difficulty.stars(metadata.difficulty) ||
        !Number.isFinite(metadata.referenceLength) || metadata.referenceLength <= 0 ||
        !Array.isArray(metadata.nodes) || metadata.nodes.length !== 2 ||
        metadata.nodes[0]?.kind !== 'start' || metadata.nodes[1]?.kind !== 'finish' ||
        !metadata.nodes.every(node => point(node, width, height)) ||
        !Array.isArray(metadata.referencePath) || metadata.referencePath.length < 2 ||
        metadata.referencePath.length > width * height || !metadata.referencePath.every(node => point(node, width, height))) throw fail();
    for (const [node, routePoint] of [[metadata.nodes[0], metadata.referencePath[0]],
      [metadata.nodes[1], metadata.referencePath.at(-1)]]) {
      if (node.x !== routePoint.x || node.y !== routePoint.y) throw fail();
    }
    if (!Array.isArray(metadata.collectibles) || metadata.collectibles.length > 64 ||
        !metadata.collectibles.every(item => point(item, width, height) && typeof item.id === 'string' &&
          ['xp', 'multiplier'].includes(item.kind) && Number.isFinite(item.value) && item.value > 0 &&
          Number.isFinite(item.radius) && item.radius > 0)) throw fail();
  }

  function budget(packet) {
    const { width, height, metadata, analysis, base } = packet;
    if (packet.format !== FORMAT || packet.version !== 1 || !Number.isInteger(width) || !Number.isInteger(height) ||
        width < 1 || height < 1 || width * height > P.MapCodec.limits.maxPixels ||
        Object.keys(packet).some(key => !['format', 'version', 'width', 'height', 'metadata', 'analysis', 'base'].includes(key))) throw fail();
    const size = jsonBytes(metadata).size + mapBytes(analysis, width, height) +
      (base === 'source' || base === 'final' ? 8 : mapBytes(base, width, height)) + 1024;
    if (size > MAX_BYTES) throw fail();
    validateMetadata(metadata, width, height);
  }

  async function encode(level) {
    if (!level?.analysis || !level.mazeOriginalAnalysis || !level.mazeSourceAnalysis) throw fail();
    const { width, height } = level.analysis;
    const values = Object.fromEntries(Object.entries(level).filter(([key]) => !omitted.has(key)));
    if (values.maxInk !== Infinity) throw fail();
    values.maxInk = null; // Chrome runtime messages use JSON, which cannot retain Infinity.
    const metadata = JSON.parse(jsonBytes(values).json);
    validateMetadata(metadata, width, height);
    const analysis = await P.MapCodec.encode(level.analysis);
    const base = level.mazeSourceAnalysis === level.mazeOriginalAnalysis ? 'source' :
      level.mazeSourceAnalysis === level.analysis ? 'final' : await P.MapCodec.encode(level.mazeSourceAnalysis);
    const packet = { format: FORMAT, version: 1, width, height, analysis, base, metadata };
    budget(packet);
    return packet;
  }

  async function decode(packet, source, { signal } = {}) {
    abort(signal);
    if (!packet || !source || source.kind !== 'pixel-mask' || source.width !== packet.width || source.height !== packet.height) throw fail();
    budget(packet);
    const analysis = await P.MapCodec.decode(packet.analysis, { signal, cooperative: true });
    abort(signal);
    const base = packet.base === 'source' ? source : packet.base === 'final' ? analysis :
      await P.MapCodec.decode(packet.base, { signal, cooperative: true });
    abort(signal);
    const metadata = packet.metadata;
    for (const node of metadata.nodes) {
      if (!analysis.walkableMask[Math.floor(node.y) * analysis.width + Math.floor(node.x)]) throw fail();
    }
    return { ...metadata, maxInk: Infinity, analysis, obstacleIndex: P.Collision.createMaskIndex(analysis),
      mazeOriginalAnalysis: source, mazeSourceAnalysis: base };
  }

  function random(seed) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw fail();
    return () => {
      seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  P.MazeTransport = Object.freeze({ encode, decode, random, maxBytes: MAX_BYTES });
})();
