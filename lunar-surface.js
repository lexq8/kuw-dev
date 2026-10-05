import * as THREE from './three.module.js';
import { GLTFLoader } from './GLTFLoader.js';

const WORK_BATCH = 131072;
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Lunar surface loading was cancelled.', 'AbortError');
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function emit(callback, value) {
  try { callback?.(value); } catch (error) { console.error('Lunar surface callback failed:', error); }
}

function colorLayout(color) {
  const { width, height, columns, rows, tileSize, gutter, format } = color ?? {};
  if (![width, height, columns, rows, tileSize].every(value => Number.isSafeInteger(value) && value > 0)
    || !Number.isSafeInteger(gutter) || gutter < 0
    || width !== columns * tileSize || height !== rows * tileSize || format !== 'png') {
    throw new Error('The lunar color manifest has an invalid native tile layout.');
  }
  return { width, height, columns, rows, tileSize, gutter, format, dimension: tileSize + 2 * gutter };
}

function createResourceOwner() {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const closedImages = new Set();
  const disposed = new WeakSet();
  function disposeTexture(texture) {
    if (!texture?.isTexture || disposed.has(texture)) return;
    disposed.add(texture);
    textures.delete(texture);
    texture.dispose();
    for (const image of [texture.image].flat()) {
      if (image && typeof image.close === 'function' && !closedImages.has(image)) {
        closedImages.add(image);
        image.close();
      }
    }
  }
  function disposeMaterial(material) {
    if (!material || disposed.has(material)) return;
    disposed.add(material);
    materials.delete(material);
    for (const key of Object.keys(material)) if (material[key]?.isTexture) material[key] = null;
    material.dispose();
  }
  function addMesh(mesh) {
    if (mesh.geometry) geometries.add(mesh.geometry);
    for (const material of [mesh.material].flat()) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  }
  return {
    geometries, materials, textures, addMesh, disposeTexture, disposeMaterial,
    dispose() {
      for (const geometry of geometries) {
        if (!disposed.has(geometry)) { disposed.add(geometry); geometry.dispose(); }
      }
      geometries.clear();
      for (const material of [...materials]) disposeMaterial(material);
      for (const texture of [...textures]) disposeTexture(texture);
    }
  };
}

// Reorders only the index buffer. The NASA position, normal, and UV buffers stay shared.
async function prepareGeometry(geometry, layout, signal, onProgress) {
  const position = geometry?.getAttribute('position');
  const normal = geometry?.getAttribute('normal');
  const uv = geometry?.getAttribute('uv');
  const index = geometry?.getIndex();
  if (!position || !normal || !uv || !index || !position.count || index.count % 3
    || normal.count !== position.count || uv.count !== position.count) {
    throw new Error('The lunar model requires indexed positions, normals, and UVs.');
  }
  const minimum = new THREE.Vector3(Infinity, Infinity, Infinity);
  const maximum = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  let radiusSum = 0;
  let maxRadius = 0;
  for (let start = 0; start < position.count; start += WORK_BATCH) {
    checkAbort(signal);
    const end = Math.min(position.count, start + WORK_BATCH);
    for (let vertex = start; vertex < end; vertex++) {
      const x = position.getX(vertex), y = position.getY(vertex), z = position.getZ(vertex);
      const radius = Math.sqrt(x * x + y * y + z * z);
      if (!Number.isFinite(radius)) throw new Error('The lunar model contains invalid vertex coordinates.');
      radiusSum += radius;
      maxRadius = Math.max(maxRadius, radius);
      minimum.x = Math.min(minimum.x, x); minimum.y = Math.min(minimum.y, y); minimum.z = Math.min(minimum.z, z);
      maximum.x = Math.max(maximum.x, x); maximum.y = Math.max(maximum.y, y); maximum.z = Math.max(maximum.z, z);
    }
    if (end < position.count) await yieldTask();
  }
  const meanRadius = radiusSum / position.count;
  if (!(meanRadius > 0)) throw new Error('The lunar model has no measurable radius.');
  const scale = 1 / meanRadius;
  for (let start = 0; start < position.count; start += WORK_BATCH) {
    checkAbort(signal);
    const end = Math.min(position.count, start + WORK_BATCH);
    for (let vertex = start; vertex < end; vertex++) {
      position.setXYZ(vertex, position.getX(vertex) * scale, position.getY(vertex) * scale, position.getZ(vertex) * scale);
    }
    if (end < position.count) await yieldTask();
  }
  position.needsUpdate = true;
  geometry.boundingBox = new THREE.Box3(minimum.multiplyScalar(scale), maximum.multiplyScalar(scale));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), maxRadius * scale);

  const triangleCount = index.count / 3;
  const tileCount = layout.columns * layout.rows;
  const assignments = new Uint8Array(triangleCount);
  const counts = new Uint32Array(tileCount);
  for (let start = 0; start < triangleCount; start += WORK_BATCH) {
    checkAbort(signal);
    const end = Math.min(triangleCount, start + WORK_BATCH);
    for (let triangle = start; triangle < end; triangle++) {
      const a = index.getX(triangle * 3), b = index.getX(triangle * 3 + 1), c = index.getX(triangle * 3 + 2);
      if (a >= position.count || b >= position.count || c >= position.count) throw new Error('The lunar model contains an invalid triangle index.');
      const u = (uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3;
      const v = (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3;
      if (!Number.isFinite(u) || !Number.isFinite(v)) throw new Error('The lunar model contains invalid UV coordinates.');
      // glTF has separate seam vertices at u=0 and u=1; clamp small exporter rounding errors.
      const column = Math.max(0, Math.min(layout.columns - 1, Math.floor(u * layout.columns)));
      const row = Math.max(0, Math.min(layout.rows - 1, Math.floor(v * layout.rows)));
      const tile = row * layout.columns + column;
      assignments[triangle] = tile;
      counts[tile] += 3;
    }
    emit(onProgress, { stage: 'geometry', phase: 'prepare', loaded: end, total: triangleCount });
    if (end < triangleCount) await yieldTask();
  }
  const offsets = new Uint32Array(tileCount);
  const reordered = new index.array.constructor(index.count);
  geometry.clearGroups();
  let cursor = 0;
  for (let tile = 0; tile < tileCount; tile++) {
    offsets[tile] = cursor;
    if (counts[tile]) geometry.addGroup(cursor, counts[tile], tile);
    cursor += counts[tile];
  }
  for (let start = 0; start < triangleCount; start += WORK_BATCH) {
    checkAbort(signal);
    const end = Math.min(triangleCount, start + WORK_BATCH);
    for (let triangle = start; triangle < end; triangle++) {
      const target = offsets[assignments[triangle]];
      reordered[target] = index.getX(triangle * 3);
      reordered[target + 1] = index.getX(triangle * 3 + 1);
      reordered[target + 2] = index.getX(triangle * 3 + 2);
      offsets[assignments[triangle]] += 3;
    }
    if (end < triangleCount) await yieldTask();
  }
  geometry.setIndex(new THREE.BufferAttribute(reordered, 1));
  return meanRadius;
}

function uploadTexture(renderer, texture) {
  // CPU-only adapters prepare materials without uploads. An actual uploader must expose GL status.
  if (typeof renderer?.initTexture !== 'function') return;
  const context = renderer.getContext?.();
  if (!context || typeof context.getError !== 'function' || typeof context.isContextLost !== 'function') {
    throw new Error('The WebGL context cannot verify the lunar texture upload.');
  }
  if (context.isContextLost()) throw new Error('The WebGL context was lost before the lunar texture upload.');
  const noError = context.NO_ERROR ?? 0;
  const contextLost = context.CONTEXT_LOST_WEBGL ?? 0x9242;
  let clean = false;
  // Clear unrelated error flags first, with a fixed upper bound for broken contexts or adapters.
  for (let read = 0; read < 8; read++) {
    const error = context.getError();
    if (error === contextLost) throw new Error('The WebGL context was lost before the lunar texture upload.');
    if (error === noError) { clean = true; break; }
  }
  if (!clean) throw new Error('Existing WebGL errors could not be cleared before the lunar texture upload.');
  renderer.initTexture(texture);
  const error = context.getError();
  if (context.isContextLost() || error !== noError) {
    throw new Error(`The lunar texture upload failed (WebGL error ${error}).`);
  }
}

/**
 * Takes ownership of a single NASA mesh and prepares its shared-buffer native tile materials.
 * The returned dispose() owns the mesh, its source resources, and textures supplied to setTileTexture().
 */
export async function createLunarSurface(sourceMesh, renderer, { color, signal, onProgress, onQuality } = {}) {
  const layout = colorLayout(color);
  const owner = createResourceOwner();
  owner.addMesh(sourceMesh);
  const sourceMaterials = [sourceMesh.material].flat();
  const fallback = sourceMaterials[0]?.map ?? null;
  const maxTextureSize = renderer?.capabilities?.maxTextureSize ?? 0;
  const nativeAllowed = maxTextureSize >= layout.dimension;
  const anisotropy = Math.max(1, Math.min(renderer?.capabilities?.getMaxAnisotropy?.() ?? 1, 16));
  let disposed = false;
  let mesh;
  let loadedTiles = 0;
  let quality;
  const installed = new Set();
  const fallbackWidth = Math.min(fallback?.image?.width ?? 0, maxTextureSize);
  const fallbackHeight = fallback?.image?.width ? Math.round(fallback.image.height * fallbackWidth / fallback.image.width) : 0;
  const reportQuality = () => {
    quality = Object.freeze({
      quality: loadedTiles === layout.columns * layout.rows ? `native-${layout.width}` : loadedTiles ? 'native-partial' : 'embedded-8k',
      loadedTiles, totalTiles: layout.columns * layout.rows,
      width: loadedTiles === layout.columns * layout.rows ? layout.width : fallbackWidth,
      height: loadedTiles === layout.columns * layout.rows ? layout.height : fallbackHeight,
      smoothNormals: sourceMesh.userData?.smoothLunarNormals === true,
      ...(sourceMesh.userData?.lunarNormalsReason ? { normalsReason: sourceMesh.userData.lunarNormalsReason, reason: sourceMesh.userData.lunarNormalsReason } : {}),
      ...(!nativeAllowed ? { reason: 'texture-limit' } : {})
    });
    emit(onQuality, quality);
    return quality;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', dispose);
    mesh?.removeFromParent();
    owner.dispose();
  };
  signal?.addEventListener('abort', dispose, { once: true });
  try {
    checkAbort(signal);
    const meanRadius = await prepareGeometry(sourceMesh.geometry, layout, signal, onProgress);
    checkAbort(signal);
    if (fallback) {
      fallback.colorSpace = THREE.SRGBColorSpace;
      fallback.flipY = false;
      fallback.anisotropy = anisotropy;
      fallback.needsUpdate = true;
    }
    const materials = Array.from({ length: layout.columns * layout.rows }, () => new THREE.MeshStandardMaterial({
      map: fallback, roughness: 1, metalness: 0, side: sourceMaterials[0]?.side ?? THREE.FrontSide
    }));
    mesh = new THREE.Mesh(sourceMesh.geometry, materials);
    mesh.name = 'NASA LRO lunar topography';
    mesh.userData.lunarSource = 'NASA / LRO';
    mesh.userData.smoothLunarNormals = sourceMesh.userData?.smoothLunarNormals === true;
    if (sourceMesh.userData?.lunarNormalsReason) mesh.userData.lunarNormalsReason = sourceMesh.userData.lunarNormalsReason;
    owner.addMesh(mesh);
    sourceMesh.removeFromParent();
    for (const material of sourceMaterials) owner.disposeMaterial(material);
    for (const texture of [...owner.textures]) if (texture !== fallback) owner.disposeTexture(texture);
    reportQuality();
    return {
      mesh, meanRadius, nativeAllowed,
      get quality() { return quality; },
      get disposed() { return disposed; },
      update() {},
      dispose,
      setTileTexture(row, column, texture) {
        if (!texture?.isTexture) throw new TypeError('A native lunar tile must be a Three.js texture.');
        owner.textures.add(texture);
        if (disposed || !nativeAllowed) { owner.disposeTexture(texture); return false; }
        if (!Number.isInteger(row) || row < 0 || row >= layout.rows || !Number.isInteger(column) || column < 0 || column >= layout.columns
          || texture.image?.width !== layout.dimension || texture.image?.height !== layout.dimension) {
          owner.disposeTexture(texture);
          throw new Error('A native lunar tile does not match the manifest dimensions or tile position.');
        }
        const tile = row * layout.columns + column;
        const material = materials[tile];
        if (material.map === texture) return true;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = false;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.anisotropy = anisotropy;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = true;
        const interior = layout.tileSize / layout.dimension;
        texture.repeat.set(layout.columns * interior, layout.rows * interior);
        texture.offset.set((layout.gutter - column * layout.tileSize) / layout.dimension, (layout.gutter - row * layout.tileSize) / layout.dimension);
        texture.updateMatrix();
        texture.needsUpdate = true;
        try { uploadTexture(renderer, texture); } catch (error) { owner.disposeTexture(texture); throw error; }
        const previous = material.map;
        material.map = texture;
        material.needsUpdate = true;
        if (previous && previous !== fallback) owner.disposeTexture(previous);
        if (!installed.has(tile)) { installed.add(tile); loadedTiles++; }
        if (loadedTiles === layout.columns * layout.rows) owner.disposeTexture(fallback);
        reportQuality();
        return true;
      }
    };
  } catch (error) {
    dispose();
    throw error;
  }
}


function validateChunks(metadata) {
  const { chunks, bytes } = metadata;
  if (!Array.isArray(chunks) || !chunks.length || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error('The lunar asset has invalid chunk count or total size.');
  }
  let total = 0;
  for (const chunk of chunks) {
    if (!chunk || typeof chunk.file !== 'string' || !chunk.file || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0
      || typeof chunk.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(chunk.sha256)) {
      throw new Error('The lunar asset has invalid chunk metadata or checksum.');
    }
    total += chunk.bytes;
    if (!Number.isSafeInteger(total) || total > bytes) throw new Error('The lunar asset chunk sizes exceed the declared total size.');
  }
  if (total !== bytes) throw new Error('The lunar asset chunk sizes do not match its declared total size.');
  if (!globalThis.crypto?.subtle) throw new Error('This browser cannot verify lunar asset chunk checksums.');
}

async function cancelResponse(response) {
  try { await response.body?.cancel(); } catch { /* A failed or aborted Fetch body is already closed. */ }
}

async function readResponseInto(response, target, signal, onBytes) {
  if (!response.ok) { await cancelResponse(response); throw new Error(`The lunar asset request failed (${response.status}).`); }
  const encoding = response.headers.get('content-encoding');
  const lengthHeader = encoding && encoding.toLowerCase() !== 'identity' ? null : response.headers.get('content-length');
  if (lengthHeader !== null && Number(lengthHeader) !== target.byteLength) {
    await cancelResponse(response);
    throw new Error('The lunar asset response size does not match its declared byte length.');
  }
  if (!response.body?.getReader) {
    const data = new Uint8Array(await response.arrayBuffer());
    checkAbort(signal);
    if (data.byteLength !== target.byteLength) throw new Error('The lunar asset response size does not match its declared byte length.');
    target.set(data);
    onBytes?.(data.byteLength);
    return;
  }
  const reader = response.body.getReader();
  let loaded = 0;
  try {
    while (true) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.byteLength > target.byteLength) throw new Error('The lunar asset stream exceeds its declared byte length.');
      target.set(value, loaded);
      loaded += value.byteLength;
      onBytes?.(loaded);
    }
    checkAbort(signal);
    if (loaded !== target.byteLength) throw new Error('The lunar asset download is incomplete.');
  } catch (error) {
    try { await reader.cancel(); } catch { /* The aborted Fetch stream is already closed. */ }
    throw error;
  } finally { reader.releaseLock(); }
}

async function verifyChunk(bytes, expected, signal) {
  checkAbort(signal);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  checkAbort(signal);
  const actual = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (actual !== expected.toLowerCase()) throw new Error('The lunar asset chunk checksum does not match its manifest.');
}

/** Downloads unchanged asset bytes from one file or an ordered, checksum-verified chunk list. */
export async function loadLunarAsset(metadata, baseURL, {
  signal, onProgress, stage = 'geometry', phase = 'download', asBlob = false, mimeType = 'application/octet-stream'
} = {}) {
  checkAbort(signal);
  if (!metadata || typeof metadata !== 'object') throw new Error('The lunar asset metadata is missing.');
  const progress = (loaded, total) => emit(onProgress, { stage, phase, loaded, total });
  if (metadata.chunks !== undefined) {
    validateChunks(metadata);
    const destination = asBlob ? null : new Uint8Array(metadata.bytes);
    const parts = [];
    let offset = 0;
    progress(0, metadata.bytes);
    for (const chunk of metadata.chunks) {
      checkAbort(signal);
      // Geometry and normals share one allocation; image parts become immutable Blob segments.
      const target = destination ? destination.subarray(offset, offset + chunk.bytes) : new Uint8Array(chunk.bytes);
      const response = await fetch(new URL(chunk.file, baseURL), { signal });
      await readResponseInto(response, target, signal, loaded => progress(offset + loaded, metadata.bytes));
      await verifyChunk(target, chunk.sha256, signal);
      if (asBlob) parts.push(new Blob([target]));
      offset += chunk.bytes;
    }
    checkAbort(signal);
    return asBlob ? new Blob(parts, { type: mimeType }) : destination.buffer;
  }
  if (typeof metadata.file !== 'string' || !metadata.file) throw new Error('The lunar asset filename is missing.');
  if (metadata.bytes !== undefined && (!Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0)) {
    throw new Error('The lunar asset has an invalid declared size.');
  }
  const response = await fetch(new URL(metadata.file, baseURL), { signal });
  if (!response.ok) { await cancelResponse(response); throw new Error(`The lunar asset request failed (${response.status}).`); }
  const encoding = response.headers.get('content-encoding');
  const contentLength = encoding && encoding.toLowerCase() !== 'identity' ? 0 : Number(response.headers.get('content-length'));
  const total = metadata.bytes ?? (Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : 0);
  progress(0, total);
  if (asBlob && metadata.bytes === undefined) {
    const blob = await response.blob();
    checkAbort(signal);
    progress(blob.size, blob.size);
    return new Blob([blob], { type: mimeType });
  }
  if (!total) {
    const data = await response.arrayBuffer();
    checkAbort(signal);
    progress(data.byteLength, data.byteLength);
    return asBlob ? new Blob([data], { type: mimeType }) : data;
  }
  const bytes = new Uint8Array(total);
  await readResponseInto(response, bytes, signal, loaded => progress(loaded, total));
  return asBlob ? new Blob([bytes], { type: mimeType }) : bytes.buffer;
}

async function installSmoothNormals(mesh, metadata, baseURL, signal, onProgress) {
  mesh.userData.smoothLunarNormals = false;
  if (!metadata) return;
  try {
    const count = mesh.geometry.getAttribute('position').count;
    const expectedBytes = count * 3 * Float32Array.BYTES_PER_ELEMENT;
    if ((metadata.chunks === undefined && (typeof metadata.file !== 'string' || !metadata.file)) || metadata.count !== count
      || metadata.itemSize !== 3 || metadata.componentType !== 'float32' || metadata.endianness !== 'little'
      || metadata.bytes !== expectedBytes || !Number.isSafeInteger(expectedBytes)
      || new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
      throw new Error('The lunar smooth-normal sidecar has an unsupported layout.');
    }
    const data = await loadLunarAsset(metadata, baseURL, { signal, onProgress, phase: 'normals' });
    checkAbort(signal);
    if (data.byteLength !== expectedBytes) throw new Error('The lunar smooth-normal sidecar is incomplete.');
    const normals = new Float32Array(data);
    // The offline preparation verifies every normal. Sample across the whole buffer in the browser.
    const samples = Math.min(count, 1024);
    for (let sample = 0; sample < samples; sample++) {
      const vertex = samples === 1 ? 0 : Math.floor(sample * (count - 1) / (samples - 1));
      const offset = vertex * 3;
      const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
      if (!Number.isFinite(length) || Math.abs(length - 1) > .005) {
        throw new Error('The lunar smooth-normal sidecar contains an invalid normal.');
      }
    }
    mesh.geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    mesh.userData.smoothLunarNormals = true;
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    mesh.userData.lunarNormalsReason = 'smooth-normals-unavailable';
    emit(onProgress, { stage: 'geometry', phase: 'normals', loaded: 0, total: metadata.bytes ?? 0, failed: true });
  }
}

function disposeObject(root) {
  if (!root) return;
  const owner = createResourceOwner();
  root.traverse(object => { if (object.isMesh) owner.addMesh(object); });
  owner.dispose();
}

function parseModel(data, baseURL, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const cancel = () => { cancelled = true; reject(abortError(signal)); };
    signal.addEventListener('abort', cancel, { once: true });
    const loader = new GLTFLoader();
    loader.parseAsync(data, baseURL).then(result => {
      signal.removeEventListener('abort', cancel);
      if (cancelled || signal.aborted) {
        // GLTF image decoding cannot be interrupted. Release a result that arrives after cancellation.
        disposeObject(result.scene);
        reject(abortError(signal));
      } else resolve(result);
    }, error => {
      signal.removeEventListener('abort', cancel);
      reject(error);
    });
  });
}

async function decodeTile(metadata, baseURL, signal) {
  const blob = await loadLunarAsset(metadata, baseURL, { signal, asBlob: true, mimeType: 'image/png' });
  checkAbort(signal);
  let image;
  if (typeof createImageBitmap === 'function') {
    image = await createImageBitmap(blob, {
      imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none'
    });
  } else {
    if (typeof Image !== 'function') throw new Error('This browser cannot decode native lunar color tiles.');
    const objectURL = URL.createObjectURL(blob);
    try {
      image = await new Promise((resolve, reject) => {
        const element = new Image();
        const cancel = () => { element.src = ''; reject(abortError(signal)); };
        signal.addEventListener('abort', cancel, { once: true });
        const complete = callback => value => {
          signal.removeEventListener('abort', cancel);
          element.onload = null;
          element.onerror = null;
          callback(value);
        };
        element.onload = complete(() => resolve(element));
        element.onerror = complete(() => reject(new Error('A native lunar color tile could not be decoded.')));
        element.src = objectURL;
      });
    } finally { URL.revokeObjectURL(objectURL); }
  }
  if (signal.aborted) { image.close?.(); throw abortError(signal); }
  return new THREE.Texture(image);
}

async function loadNativeColor(surface, color, baseURL, signal, onProgress, onQuality) {
  if (!surface.nativeAllowed) return surface.quality;
  let failedTiles = 0;
  let attempted = 0;
  const total = color.columns * color.rows;
  emit(onProgress, { stage: 'color', loaded: 0, total, loadedTiles: 0 });
  for (let row = 0; row < color.rows; row++) {
    for (let column = 0; column < color.columns; column++) {
      if (signal.aborted || surface.disposed) return surface.quality;
      const entry = color.tiles?.find(tile => tile.row === row && tile.column === column);
      const filename = entry?.file ?? `color-r${row}-c${column}.png`;
      try {
        const texture = await decodeTile({ ...entry, file: filename }, baseURL, signal);
        surface.setTileTexture(row, column, texture);
      } catch (error) {
        if (signal.aborted || surface.disposed) return surface.quality;
        failedTiles++;
      }
      attempted++;
      emit(onProgress, { stage: 'color', loaded: attempted, total, loadedTiles: surface.quality.loadedTiles, failedTiles, row, column });
      // Network transfer, decode, and upload are serialized; let controls draw before the next tile.
      await yieldTask();
    }
  }
  const quality = failedTiles ? Object.freeze({ ...surface.quality, reason: 'native-color-incomplete', failedTiles }) : surface.quality;
  if (failedTiles && !surface.disposed) emit(onQuality, quality);
  return quality;
}

/**
 * Loads the original NASA topography locally, then upgrades embedded color with lossless native PNG tiles.
 * Resolves after geometry preparation; colorReady settles after sequential tile attempts.
 * All resources are owned by dispose(), the caller's signal, and non-persisted pagehide.
 */
export async function loadLunarSurface(renderer, { onProgress, onQuality, signal, assetBaseURL } = {}) {
  checkAbort(signal);
  const lifecycle = new AbortController();
  const abort = () => lifecycle.abort(signal?.reason);
  const onPageHide = event => { if (!event.persisted) lifecycle.abort(); };
  const cleanupListeners = () => {
    signal?.removeEventListener('abort', abort);
    globalThis.removeEventListener?.('pagehide', onPageHide);
  };
  signal?.addEventListener('abort', abort, { once: true });
  globalThis.addEventListener?.('pagehide', onPageHide);
  lifecycle.signal.addEventListener('abort', cleanupListeners, { once: true });
  const baseURL = new URL(assetBaseURL ?? './', import.meta.url);
  if (!baseURL.pathname.endsWith('/')) baseURL.pathname += '/';
  let sourceRoot;
  let surface;
  let factoryOwnsResources = false;
  try {
    emit(onProgress, { stage: 'manifest', loaded: 0, total: 1 });
    const response = await fetch(new URL('manifest.json', baseURL), { signal: lifecycle.signal });
    if (!response.ok) throw new Error(`The lunar asset manifest failed (${response.status}).`);
    const manifest = await response.json();
    checkAbort(lifecycle.signal);
    colorLayout(manifest.color);
    emit(onProgress, { stage: 'manifest', loaded: 1, total: 1 });
    let bytes = await loadLunarAsset({ ...manifest.model, file: manifest.model?.file ?? 'moon-topography.glb',
      bytes: manifest.model?.bytes ?? manifest.model?.byteLength ?? 313433084 }, baseURL, { signal: lifecycle.signal, onProgress });
    let gltf = await parseModel(bytes, baseURL.href, lifecycle.signal);
    bytes = null;
    sourceRoot = gltf.scene;
    const meshes = [];
    sourceRoot.traverse(object => { if (object.isMesh) meshes.push(object); });
    if (meshes.length !== 1 || meshes[0].isSkinnedMesh || meshes[0].isInstancedMesh) {
      throw new Error('The lunar asset must contain one static indexed mesh.');
    }
    const sourceMesh = meshes[0];
    sourceMesh.updateWorldMatrix(true, false);
    if (!sourceMesh.matrixWorld.equals(new THREE.Matrix4())) throw new Error('The lunar asset has unexpected node transforms.');
    // The parser holds copies of the large binary chunks; the prepared mesh owns only its used buffers.
    gltf = null;
    await installSmoothNormals(sourceMesh, manifest.model?.normals, baseURL, lifecycle.signal, onProgress);
    checkAbort(lifecycle.signal);
    factoryOwnsResources = true;
    surface = await createLunarSurface(sourceMesh, renderer, {
      color: manifest.color, signal: lifecycle.signal, onProgress, onQuality
    });
    sourceRoot = null;
    const dispose = surface.dispose;
    surface.dispose = () => { lifecycle.abort(); dispose(); cleanupListeners(); };
    checkAbort(lifecycle.signal);
    surface.colorReady = loadNativeColor(surface, manifest.color, baseURL, lifecycle.signal, onProgress, onQuality);
    return surface;
  } catch (error) {
    lifecycle.abort();
    cleanupListeners();
    if (surface) surface.dispose();
    else if (!factoryOwnsResources) disposeObject(sourceRoot);
    throw error;
  }
}
