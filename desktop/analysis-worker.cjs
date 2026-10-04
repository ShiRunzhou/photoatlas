const { parentPort, workerData } = require('worker_threads');
const fs = require('fs'),
  path = require('path'),
  exifr = require('exifr'),
  sharp = require('sharp');
const { atomicJSON, signature } = require('./store.cjs');
const {
  VERSION,
  fingerprint,
  coarse,
  ssim,
  detail,
} = require('./fingerprint.cjs');
const { nearest } = require('./location.cjs');
sharp.concurrency(1);
sharp.cache(false);
const { photos, paths, initialEdges = [] } = workerData;
const send = (x) => parentPort.postMessage(x);
const memoFile = path.join(paths.data, 'comparison-cache.json');
let memo = {};
try {
  memo = JSON.parse(fs.readFileSync(memoFile, 'utf8'));
} catch {}
const grayCache = new Map();
async function gray(photo) {
  if (grayCache.has(photo.id)) {
    const data = grayCache.get(photo.id);
    grayCache.delete(photo.id);
    grayCache.set(photo.id, data);
    return data;
  }
  const data = await detail(path.join(paths.photos, photo.relativePath));
  grayCache.set(photo.id, data);
  if (grayCache.size > 48) grayCache.delete(grayCache.keys().next().value);
  return data;
}
async function run() {
  const ready = [];
  let computed = 0,
    cached = 0,
    failed = 0;
  fs.mkdirSync(path.join(paths.data, 'fingerprints'), { recursive: true });
  fs.mkdirSync(path.join(paths.data, 'thumbnails'), { recursive: true });
  let cursor = 0,
    done = 0;
  async function processPhoto(photo) {
    const file = path.join(paths.photos, photo.relativePath),
      cache = path.join(
        paths.data,
        'fingerprints',
        `${require('crypto').createHash('sha256').update(photo.id).digest('hex')}.json`,
      );
    try {
      const before = signature(fs.statSync(file));
      let fp = photo.fingerprint;
      if (photo.forceRehash) fp = null;
      if (
        !photo.forceRehash &&
        (!fp || fp.version !== VERSION || fp.signature !== before)
      ) {
        try {
          fp = JSON.parse(fs.readFileSync(cache, 'utf8'));
        } catch {
          fp = null;
        }
      }
      let extracted = null;
      if (!fp || fp.version !== VERSION || fp.signature !== before) {
        const input = fs.readFileSync(file);
        fp = { ...(await fingerprint(input)), signature: before };
        try {
          const exif = await exifr.parse(input, {
            gps: true,
            tiff: true,
            exif: true,
          });
          if (exif) {
            const date = exif.DateTimeOriginal || exif.CreateDate;
            extracted = {
              takenAt: date instanceof Date ? date.getTime() : null,
              year: date instanceof Date ? date.getUTCFullYear() : null,
              gps:
                Number.isFinite(exif.latitude) &&
                Number.isFinite(exif.longitude)
                  ? { latitude: exif.latitude, longitude: exif.longitude }
                  : null,
            };
            if (extracted.gps)
              extracted.location = nearest(
                extracted.gps.latitude,
                extracted.gps.longitude,
                path.join(paths.project, 'assets'),
              );
          }
        } catch {}
        await sharp(input, { limitInputPixels: 160000000 })
          .rotate()
          .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 78 })
          .toFile(
            path.join(
              paths.data,
              'thumbnails',
              `${require('crypto').createHash('sha256').update(photo.id).digest('hex')}.webp`,
            ),
          );
        if (signature(fs.statSync(file)) !== before)
          throw Error('读取期间文件发生变化，请重新分析');
        fp.extracted = extracted;
        atomicJSON(cache, fp);
        computed++;
      } else cached++;
      if (
        !fs.existsSync(
          path.join(
            paths.data,
            'thumbnails',
            `${require('crypto').createHash('sha256').update(photo.id).digest('hex')}.webp`,
          ),
        )
      )
        await sharp(fs.readFileSync(file))
          .rotate()
          .resize(320, 320, { fit: 'inside' })
          .webp({ quality: 78 })
          .toFile(
            path.join(
              paths.data,
              'thumbnails',
              `${require('crypto').createHash('sha256').update(photo.id).digest('hex')}.webp`,
            ),
          );
      photo.fingerprint = fp;
      photo.fileSignature = before;
      ready.push(photo);
      send({
        type: 'photo',
        id: photo.id,
        fingerprint: fp,
        extracted: fp.extracted || extracted,
      });
    } catch (error) {
      failed++;
      send({ type: 'error-photo', id: photo.id, message: error.message });
    }
    send({
      type: 'progress',
      phase: 'fingerprints',
      done: ++done,
      total: photos.length,
      computed,
      cached,
      failed,
    });
  }
  // Limit simultaneous decodes instead of allowing the whole collection to
  // accumulate buffers. Native image work can use several CPU cores.
  await Promise.all(
    Array.from(
      { length: Math.min(4, require('os').cpus().length, photos.length) },
      async () => {
        while (cursor < photos.length) {
          const photo = photos[cursor++];
          await processPhoto(photo);
        }
      },
    ),
  );
  const order = new Map(photos.map((p, i) => [p.id, i]));
  ready.sort((a, b) => order.get(a.id) - order.get(b.id));
  const byId = new Map(ready.map((p) => [p.id, p]));
  const edges = initialEdges.filter(
      (e) =>
        byId.get(e.a)?.fingerprint.sha256 === e.aHash &&
        byId.get(e.b)?.fingerprint.sha256 === e.bHash,
    ),
    known = new Set(edges.map((x) => [x.a, x.b].sort().join(':')));
  let coarsePairs = 0,
    details = 0;
  const total = (ready.length * (ready.length - 1)) / 2;
  let visited = 0;
  for (let i = 0; i < ready.length; i++) {
    for (let j = i + 1; j < ready.length; j++) {
      visited++;
      const a = ready[i],
        b = ready[j];
      if (
        a.status === 'library' &&
        !a.needsRecheck &&
        b.status === 'library' &&
        !b.needsRecheck
      )
        continue;
      if (!coarse(a.fingerprint, b.fingerprint)) continue;
      coarsePairs++;
      const key = [a.fingerprint.sha256, b.fingerprint.sha256].sort().join(':');
      let score;
      if (a.fingerprint.sha256 === b.fingerprint.sha256) score = 1;
      else if (key in memo) score = memo[key];
      else {
        try {
          score = ssim(await gray(a), await gray(b));
          memo[key] = score;
          details++;
          if (details % 50 === 0) atomicJSON(memoFile, memo);
        } catch (error) {
          failed++;
          for (const photo of [a, b])
            send({
              type: 'error-photo',
              id: photo.id,
              message: `细节比对失败：${error.message}`,
            });
          continue;
        }
      }
      const edgeKey = [a.id, b.id].sort().join(':');
      if (score >= 0.985 && !known.has(edgeKey)) {
        edges.push({
          a: a.id,
          b: b.id,
          aHash: a.fingerprint.sha256,
          bHash: b.fingerprint.sha256,
          score,
          exact: a.fingerprint.sha256 === b.fingerprint.sha256,
        });
        known.add(edgeKey);
      }
    }
    if (i % 25 === 0) {
      atomicJSON(path.join(paths.data, 'analysis-checkpoint.json'), {
        phase: 'compare',
        visited,
        total,
        edges,
        computed,
        cached,
        failed,
      });
      send({
        type: 'progress',
        phase: 'compare',
        done: visited,
        total,
        coarsePairs,
        details,
      });
    }
  }
  const result = {
    type: 'complete',
    edges,
    computed,
    cached,
    failed,
    coarsePairs,
    details,
    total,
    completedAt: new Date().toISOString(),
  };
  atomicJSON(memoFile, memo);
  atomicJSON(path.join(paths.data, 'analysis-checkpoint.json'), result);
  send(result);
}
run().catch((error) =>
  send({ type: 'fatal', message: error.stack || error.message }),
);
