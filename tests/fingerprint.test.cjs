const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  path = require('path'),
  os = require('os'),
  sharp = require('sharp');
const {
  fingerprint,
  coarse,
  detail,
  ssim,
  distance,
} = require('../desktop/fingerprint.cjs');
test('resized JPEG recompression is detected but changed spatial structure is rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photoatlas-fp-'));
  const svg =
    '<svg width="900" height="600"><rect width="900" height="600" fill="#81bace"/><rect x="40" y="40" width="320" height="180" fill="#d54529"/><circle cx="650" cy="390" r="150" fill="#204b17"/><path d="M0 520 L900 470 L900 600 L0 600" fill="#c4ac69"/></svg>';
  const a = path.join(dir, 'original.jpg'),
    b = path.join(dir, 'compressed.jpg'),
    c = path.join(dir, 'different.jpg');
  await sharp(Buffer.from(svg)).jpeg({ quality: 96 }).toFile(a);
  await sharp(a).resize(450, 300).jpeg({ quality: 70 }).toFile(b);
  await sharp(
    Buffer.from(
      svg.replace('x="40"', 'x="450"').replace('cx="650"', 'cx="220"'),
    ),
  )
    .jpeg()
    .toFile(c);
  const fa = await fingerprint(a),
    fb = await fingerprint(b),
    fc = await fingerprint(c);
  assert.notEqual(fa.sha256, fb.sha256);
  assert.ok(coarse(fa, fb));
  assert.ok(ssim(await detail(a), await detail(b)) >= 0.985);
  assert.equal(coarse(fa, fc), false);
  assert.equal(distance(fa.pHash, fa.pHash), 0);
});
