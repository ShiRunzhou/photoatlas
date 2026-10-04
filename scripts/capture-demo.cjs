'use strict';
// Documentation screenshots use generated illustrations in an isolated library.
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  crypto = require('crypto');
function scene(seed) {
  const x = 90 + seed * 53;
  return `<svg width="1080" height="720" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#7eb8d1"/><stop offset="1" stop-color="#ebeee1"/></linearGradient></defs>
    <rect width="1080" height="720" fill="url(#sky)"/><circle cx="${740 - seed * 41}" cy="140" r="54" fill="#f4dc9f"/>
    <path d="M0 440 L250 160 L450 375 L650 225 L1080 510 Z" fill="#7b9b96"/>
    <path d="M0 520 L310 330 L620 540 L910 280 L1080 430 L1080 720 L0 720 Z" fill="#486e63"/>
    <path d="M0 575 Q350 455 680 580 T1080 560 L1080 720 L0 720 Z" fill="#93bfbd"/>
    <path d="M0 640 Q220 540 430 610 L600 720 L0 720 Z" fill="#8b9e6d"/>
    <path d="M${x} 550 L${x} 680" stroke="#655641" stroke-width="18"/>
    <path d="M${x - 70} 590 L${x} 425 L${x + 70} 590 Z" fill="#254d41"/>
    <rect x="${700 + seed * 12}" y="480" width="120" height="95" rx="2" fill="#e4d0ac"/>
    <path d="M${680 + seed * 12} 480 L${760 + seed * 12} 420 L${840 + seed * 12} 480 Z" fill="#a96751"/>
    <rect x="${745 + seed * 12}" y="520" width="28" height="55" fill="#765f48"/>
    <path d="M85 700 Q340 565 425 690" fill="none" stroke="#d7c5a1" stroke-width="25"/>
  </svg>`;
}
async function fixture(base) {
  const sharp = require('sharp');
  const {
    roots,
    blankLibrary,
    signature,
    atomicJSON,
  } = require('../desktop/store.cjs');
  const { fingerprint, ssim, detail } = require('../desktop/fingerprint.cjs');
  const paths = roots(path.join(base, 'PhotoAtlas')),
    data = blankLibrary();
  fs.mkdirSync(paths.photos, { recursive: true });
  fs.mkdirSync(path.join(paths.data, 'thumbnails'), { recursive: true });
  data.themes = [{ id: 'weekend', name: '周末出游' }];
  data.tags = [
    { id: 'landscape', name: '风景' },
    { id: 'plant', name: '植物' },
    { id: 'building', name: '建筑' },
  ];
  for (let i = 0; i < 8; i++) {
    const id = `demo-${i}`,
      pending = i >= 6,
      fileName = pending
        ? i === 6
          ? '山间清晨_原图.jpg'
          : '山间清晨_压缩版.jpg'
        : `周末散步_${String(i + 1).padStart(2, '0')}.jpg`,
      file = path.join(paths.photos, fileName);
    let image = sharp(Buffer.from(scene(pending ? 0 : i)));
    if (i === 7) image = image.resize(540, 360);
    await image.jpeg({ quality: i === 7 ? 72 : 96 }).toFile(file);
    const input = fs.readFileSync(file),
      stat = fs.statSync(file),
      fp = await fingerprint(input);
    await sharp(input)
      .resize(320, 320, { fit: 'inside' })
      .webp()
      .toFile(
        path.join(
          paths.data,
          'thumbnails',
          crypto.createHash('sha256').update(id).digest('hex') + '.webp',
        ),
      );
    data.photos.push({
      id,
      fileName,
      relativePath: fileName,
      status: pending ? 'pending' : 'library',
      year: 2024,
      yearStatus: 'known',
      location: {
        country: '中国',
        city: '杭州',
        status: 'known',
        source: 'manual',
      },
      themeId: 'weekend',
      tagIds: i % 2 ? ['landscape', 'plant'] : ['landscape', 'building'],
      size: stat.size,
      fileSignature: signature(stat),
      fingerprint: { ...fp, signature: signature(stat) },
      needsRecheck: pending,
    });
  }
  const [a, b] = data.photos.slice(6),
    score = ssim(
      await detail(path.join(paths.photos, a.fileName)),
      await detail(path.join(paths.photos, b.fileName)),
    );
  if (score < 0.985) throw Error('示例版本未通过实际画面比对');
  data.analysis = {
    status: 'complete',
    edges: [
      {
        a: a.id,
        b: b.id,
        aHash: a.fingerprint.sha256,
        bHash: b.fingerprint.sha256,
        score,
      },
    ],
  };
  atomicJSON(path.join(paths.data, 'library-v2.json'), data);
}
async function capture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'photoatlas-docs-'));
  require('child_process').execFileSync(
    'node',
    [__filename, '--fixture', base],
    { cwd: path.resolve(__dirname, '..'), windowsHide: true },
  );
  process.env.PHOTOATLAS_PROJECT = path.join(base, 'PhotoAtlas');
  process.env.PHOTOATLAS_TEST_MODE = '1';
  const { app, BrowserWindow } = require('electron'),
    desktop = require('../desktop/main.cjs');
  await desktop.ready;
  const win = BrowserWindow.getAllWindows()[0],
    js = (code) => win.webContents.executeJavaScript(code);
  win.setContentSize(1400, 960);
  const wait = async (code) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error('示例界面未加载');
  };
  await wait("document.querySelectorAll('[data-photo]').length===2");
  const out = path.join(__dirname, '../docs/images');
  fs.mkdirSync(out, { recursive: true });
  for (const [file, command] of [
    ['library.png', "nav('tag','landscape')"],
    ['versions.png', "nav('groups', data.groups[0].id)"],
  ]) {
    await js(command);
    await wait(
      "[...document.querySelectorAll('.grid img')].length>0 && [...document.querySelectorAll('.grid img')].every(i=>i.complete&&i.naturalWidth>0)",
    );
    await js(
      "document.querySelector('.path').textContent=" +
        JSON.stringify(
          '原图：示例工作目录 / Photos\n\n快捷方式：示例工作目录 / Library',
        ),
    );
    await js(
      'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,100))))',
    );
    fs.writeFileSync(
      path.join(out, file),
      (await win.webContents.capturePage()).toPNG(),
    );
  }
  console.log('已生成仅含示例图片的 README 截图：' + out);
  app.exit(0);
}
if (process.argv[2] === '--fixture')
  fixture(process.argv[3]).catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
else
  capture().catch((error) => {
    console.error(error.stack);
    require('electron').app.exit(1);
  });
