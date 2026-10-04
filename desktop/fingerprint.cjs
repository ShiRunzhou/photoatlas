'use strict';
const sharp = require('sharp');
const crypto = require('crypto');
const VERSION = 1;
const cos = Array.from({ length: 8 }, (_, u) =>
  Array.from({ length: 32 }, (_, x) =>
    Math.cos(((2 * x + 1) * u * Math.PI) / 64),
  ),
);
function packed(bits) {
  const words = [0, 0];
  for (let i = 0; i < 64; i++)
    if (bits[i]) words[i >>> 5] = (words[i >>> 5] | (1 << (i & 31))) >>> 0;
  return words;
}
function pHash(gray) {
  const rows = Array.from({ length: 32 }, () => new Float64Array(8));
  for (let y = 0; y < 32; y++)
    for (let u = 0; u < 8; u++)
      for (let x = 0; x < 32; x++) rows[y][u] += gray[y * 32 + x] * cos[u][x];
  const dct = [];
  for (let v = 0; v < 8; v++)
    for (let u = 0; u < 8; u++) {
      let n = 0;
      for (let y = 0; y < 32; y++) n += rows[y][u] * cos[v][y];
      dct.push(n);
    }
  const sorted = dct.slice(1).sort((a, b) => a - b),
    median = sorted[31];
  return packed(dct.map((n, i) => i > 0 && n > median));
}
function dHash(gray) {
  const bits = [];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++)
      bits.push(gray[y * 9 + x] > gray[y * 9 + x + 1]);
  return packed(bits);
}
function pop(n) {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
function distance(a, b) {
  return pop(a[0] ^ b[0]) + pop(a[1] ^ b[1]);
}
async function fingerprint(file) {
  const input = Buffer.isBuffer(file) ? file : require('fs').readFileSync(file),
    image = sharp(input, { limitInputPixels: 160000000 })
      .rotate()
      .flatten({ background: '#fff' });
  const meta = await image.metadata();
  const gray = await image
    .clone()
    .resize(32, 32, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();
  const diff = await image
    .clone()
    .resize(9, 8, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();
  const rgb = await image
    .clone()
    .resize(4, 4, { fit: 'fill' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer();
  const rotated = [5, 6, 7, 8].includes(meta.orientation);
  return {
    version: VERSION,
    sha256: crypto.createHash('sha256').update(input).digest('hex'),
    pHash: pHash(gray),
    dHash: dHash(diff),
    colors: Array.from(rgb),
    width: rotated ? meta.height : meta.width,
    height: rotated ? meta.width : meta.height,
  };
}
function coarse(a, b) {
  if (a.sha256 === b.sha256) return true;
  if (Math.abs(a.width / a.height - b.width / b.height) > 0.015) return false;
  if (distance(a.pHash, b.pHash) > 8 || distance(a.dHash, b.dHash) > 10)
    return false;
  let error = 0;
  for (let i = 0; i < a.colors.length; i++)
    error += Math.abs(a.colors[i] - b.colors[i]);
  return error / a.colors.length <= 12;
}
function ssim(a, b, width = 128) {
  let score = 0,
    blocks = 0;
  for (let by = 0; by < width; by += 8)
    for (let bx = 0; bx < width; bx += 8) {
      let ma = 0,
        mb = 0;
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const i = (by + y) * width + bx + x;
          ma += a[i];
          mb += b[i];
        }
      ma /= 64;
      mb /= 64;
      let va = 0,
        vb = 0,
        cov = 0;
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const i = (by + y) * width + bx + x,
            da = a[i] - ma,
            db = b[i] - mb;
          va += da * da;
          vb += db * db;
          cov += da * db;
        }
      va /= 63;
      vb /= 63;
      cov /= 63;
      score +=
        ((2 * ma * mb + 6.5025) * (2 * cov + 58.5225)) /
        ((ma * ma + mb * mb + 6.5025) * (va + vb + 58.5225));
      blocks++;
    }
  return score / blocks;
}
async function detail(file) {
  return sharp(require('fs').readFileSync(file), {
    limitInputPixels: 160000000,
  })
    .rotate()
    .flatten({ background: '#fff' })
    .resize(128, 128, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();
}
module.exports = {
  VERSION,
  pHash,
  dHash,
  distance,
  fingerprint,
  coarse,
  ssim,
  detail,
};
