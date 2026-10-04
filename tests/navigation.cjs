'use strict';
// Exercise real DOM navigation and cross-page import in an isolated library.
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  crypto = require('crypto'),
  assert = require('assert/strict');
const { app, BrowserWindow, shell } = require('electron');
const { roots, openStore, signature } = require('../desktop/store.cjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'photoatlas-navigation-'));
process.env.PHOTOATLAS_PROJECT = path.join(base, 'PhotoAtlas');
process.env.PHOTOATLAS_TEST_MODE = '1';
const paths = roots(process.env.PHOTOATLAS_PROJECT);
fs.mkdirSync(paths.photos, { recursive: true });
fs.mkdirSync(path.join(paths.data, 'thumbnails'), { recursive: true });
require('child_process').execFileSync(
  'node',
  [
    '-e',
    `const sharp=require('sharp'),fs=require('fs');sharp({create:{width:90,height:60,channels:3,background:'#7899b2'}}).jpeg().toBuffer().then(b=>fs.writeFileSync(${JSON.stringify(path.join(base, 'fixture.jpg'))},b));`,
  ],
  { cwd: path.resolve(__dirname, '..'), windowsHide: true },
);
const input = fs.readFileSync(path.join(base, 'fixture.jpg')),
  sha = crypto.createHash('sha256').update(input).digest('hex');
const store = openStore(paths);
store.data.themes = [
  { id: 'trip', name: '2024澳洲行专题' },
  { id: 'empty', name: '2024莫干山专题' },
];
store.data.tags = [
  { id: 'plant', name: '植物' },
  { id: 'family', name: '家庭' },
  { id: 'unused', name: '建筑' },
];
for (let i = 0; i < 204; i++) {
  const pending = i >= 3,
    id = pending ? `p${String(i - 3).padStart(3, '0')}` : `library${i}`,
    fileName = `${id}.jpg`,
    file = path.join(paths.photos, fileName);
  fs.writeFileSync(file, input);
  const sig = signature(fs.statSync(file));
  store.data.photos.push({
    id,
    relativePath: fileName,
    fileName,
    status: pending ? 'pending' : 'library',
    year: 2024,
    yearStatus: 'known',
    location:
      i === 1
        ? { country: '澳大利亚', city: '悉尼', status: 'known' }
        : i === 2
          ? { country: null, city: null, status: 'pending' }
          : { country: '中国', city: '北京', status: 'known' },
    themeId: pending ? 'empty' : i === 2 ? null : 'trip',
    tagIds: pending
      ? ['family']
      : i === 0
        ? ['plant']
        : i === 1
          ? ['family']
          : [],
    size: input.length,
    fileSignature: sig,
    fingerprint: {
      version: 1,
      signature: sig,
      sha256: sha,
      width: 90,
      height: 60,
    },
    needsRecheck: pending,
  });
  // JPEG bytes are sufficient here; protocol consumers inspect the DOM rather
  // than image formats. Full decoding is covered by desktop-ui.cjs.
  fs.writeFileSync(
    path.join(
      paths.data,
      'thumbnails',
      `${crypto.createHash('sha256').update(id).digest('hex')}.webp`,
    ),
    input,
  );
}
store.data.analysis = {
  status: 'complete',
  edges: [],
  completedAt: new Date().toISOString(),
};
store.save();
const desktop = require('../desktop/main.cjs');
desktop.ready
  .then(async () => {
    const win = BrowserWindow.getAllWindows()[0],
      errors = [];
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) errors.push(message);
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const wait = async (code) => {
      const end = Date.now() + 40000;
      while (Date.now() < end) {
        if (await js(code)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error('导航测试超时：' + code);
    };
    await wait("document.querySelector('[data-nav=location]')!==null");
    await js("document.querySelector('[data-nav=location]').click()");
    const key = await js(
      "[...document.querySelectorAll('[data-bucket]')].find(e=>e.textContent.includes('中国 / 北京')).dataset.bucket",
    );
    assert.deepEqual(JSON.parse(key), ['中国', '北京']);
    assert.equal(key.includes('\0'), false);
    await js(
      "[...document.querySelectorAll('[data-bucket]')].find(e=>e.textContent.includes('中国 / 北京')).click()",
    );
    assert.equal(
      await js("document.querySelector('#toolbar h1').textContent"),
      '中国 / 北京',
    );
    assert.deepEqual(
      await js(
        "[...document.querySelectorAll('[data-photo]')].map(e=>e.dataset.photo)",
      ),
      ['library0'],
    );
    await js(
      "document.querySelector('[data-nav=location]').click();document.querySelector('[data-nav=theme]').click()",
    );
    assert.equal(
      await js("document.querySelector('#toolbar h1').textContent"),
      '按主题',
    );
    let content = await js("document.querySelector('#content').textContent");
    assert.ok(content.includes('2024澳洲行专题'));
    assert.ok(content.includes('2024莫干山专题'));
    assert.ok(content.includes('201 张待导入'));
    assert.ok(!content.includes('中国 / 北京'));
    await js("document.querySelector('[data-bucket=trip]').click()");
    assert.equal(
      await js("document.querySelectorAll('[data-photo]').length"),
      2,
    );
    await js("document.querySelector('[data-nav=tag]').click()");
    content = await js("document.querySelector('#content').textContent");
    for (const name of ['植物', '家庭', '建筑'])
      assert.ok(content.includes(name));
    assert.ok(!content.includes('2024澳洲行专题'));
    await js("document.querySelector('[data-bucket=plant]').click()");
    assert.deepEqual(
      await js(
        "[...document.querySelectorAll('[data-photo]')].map(e=>e.dataset.photo)",
      ),
      ['library0'],
    );
    await js(
      "document.querySelector('[data-nav=theme]').click();document.querySelector('[data-nav=location]').click();document.querySelector('[data-nav=tag]').click()",
    );
    assert.ok(
      !(await js("document.querySelector('#content').textContent")).includes(
        '中国 / 北京',
      ),
    );
    await js(
      "document.querySelector('[data-nav=pending]').click();document.querySelector('[data-select=p000]').click()",
    );
    assert.equal(
      await js("document.querySelector('#page-prev-top').disabled"),
      true,
    );
    await js(
      "document.querySelector('#page-next-top').click();document.querySelector('[data-select=p100]').click()",
    );
    assert.equal(
      await js(
        "document.querySelector('#pagination-top span').textContent===document.querySelector('#pagination span').textContent",
      ),
      true,
    );
    assert.equal(
      await js("document.querySelector('#page-prev-top').disabled"),
      false,
    );
    assert.equal(await js('selected.size'), 2);
    assert.match(
      await js("document.querySelector('.selection span').textContent"),
      /其他页 1 张/,
    );
    await js("document.querySelector('#page-prev-top').click()");
    assert.equal(
      await js("document.querySelector('[data-select=p000]').checked"),
      true,
    );
    assert.equal(await js('selected.size'), 2);
    await js(
      "document.querySelector('#page-next').click();document.querySelector('#select-page').click();document.querySelector('#page-next').click();document.querySelector('[data-select=p200]').click()",
    );
    assert.equal(await js('selected.size'), 102);
    assert.equal(
      await js("document.querySelector('#page-next-top').disabled"),
      true,
    );
    assert.equal(
      await js("document.querySelector('#page-next').disabled"),
      true,
    );
    assert.equal(
      await js("document.querySelectorAll('[data-photo]').length"),
      1,
    );
    await js("document.querySelector('#confirm-selected').click()");
    await wait(
      "window.atlas.state().then(s=>s.photos.filter(p=>p.status==='library').length===105)",
    );
    await wait("!document.querySelector('#scan').disabled");
    assert.equal(await js('selected.size'), 0);
    const state = await js('window.atlas.state()');
    assert.equal(state.photos.find((p) => p.id === 'p001').status, 'pending');
    for (const id of ['p000', 'p100', 'p199', 'p200'])
      assert.equal(state.photos.find((p) => p.id === id).status, 'library');
    assert.equal(state.photos.find((p) => p.id === 'p000').themeId, 'empty');
    assert.deepEqual(state.photos.find((p) => p.id === 'p000').tagIds, [
      'family',
    ]);
    const links = JSON.parse(
      fs.readFileSync(path.join(paths.data, 'shortcuts-v2.json')),
    );
    assert.equal(Object.keys(links).length, 418);
    for (const [relative, link] of Object.entries(links).slice(0, 4))
      assert.equal(
        shell.readShortcutLink(path.join(paths.library, relative)).target,
        link.target,
      );
    assert.equal(fs.readdirSync(paths.photos).length, 204);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        viewSwitches: true,
        locationTitle: '中国 / 北京',
        crossPageImport: 102,
        originalsUntouched: 204,
        fixture: base,
      }),
    );
    app.exit(0);
  })
  .catch((error) => {
    console.error(error.stack);
    app.exit(1);
  });
