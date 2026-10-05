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
    win.webContents.setBackgroundThrottling(false);
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
    // Missing-information entries remain usable even in an entirely empty library.
    await js(`window.bucketFixture={photos:data.photos,themes:data.themes,tags:data.tags};
      data.photos=structuredClone(data.photos);
      Object.assign(photo('library2'),{year:null,yearStatus:'pending',location:{country:'中国',city:null,status:'pending'}});
      photo('library1').location={country:null,city:null,status:'unknown'};`);
    for (const [dimension, key, label] of [
      ['year', 'pending', '时间待补充'],
      ['location', 'pending', '地点待补充'],
      ['theme', 'none', '无主题'],
      ['tag', 'none', '无标签'],
    ]) {
      await js(`nav(${JSON.stringify(dimension)})`);
      assert.deepEqual(
        await js(`(() => {const e=document.querySelector('[data-bucket]');return [e.dataset.bucket,e.querySelector('strong').textContent,e.querySelector('span').textContent];})()`),
        [key, label, dimension === 'theme' || dimension === 'tag' ? '1 张已入库' : '1 张照片'],
      );
      await js(`document.querySelector('[data-bucket=${key}]').click()`);
      assert.equal(await js("document.querySelector('#toolbar h1').textContent"), label);
      assert.deepEqual(
        await js("[...document.querySelectorAll('[data-photo]')].map(e=>e.dataset.photo)"),
        ['library2'],
      );
    }
    await js('data.photos=[];data.themes=[];data.tags=[]');
    for (const [dimension, key, label] of [
      ['year', 'pending', '时间待补充'],
      ['location', 'pending', '地点待补充'],
      ['theme', 'none', '无主题'],
      ['tag', 'none', '无标签'],
    ]) {
      await js(`nav(${JSON.stringify(dimension)})`);
      assert.equal(await js("document.querySelectorAll('[data-bucket]').length"), 1);
      assert.deepEqual(
        await js("(() => {const e=document.querySelector('[data-bucket]');return [e.dataset.bucket,e.querySelector('strong').textContent,e.querySelector('span').textContent,e.disabled];})()"),
        [key, label, dimension === 'theme' || dimension === 'tag' ? '0 张已入库' : '0 张照片', false],
      );
      await js(`document.querySelector('[data-bucket=${key}]').click()`);
      assert.equal(await js("document.querySelector('#toolbar h1').textContent"), label);
      assert.equal(await js("document.querySelectorAll('[data-photo]').length"), 0);
    }
    await js('Object.assign(data,window.bucketFixture);delete window.bucketFixture');
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
      await js("document.querySelector('#pagination')===null"),
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
    for (const value of ['0', '4', '1.5', '']) {
      await js(
        `document.querySelector('#page-number').value=${JSON.stringify(value)};document.querySelector('#page-jump-form').requestSubmit()`,
      );
      assert.equal(await js('page'), 0);
      assert.equal(await js('selected.size'), 2);
    }
    await js(
      "document.querySelector('#page-number').value='2';document.querySelector('#page-jump-form button').click();document.querySelector('#select-page').click();document.querySelector('#page-number').value='3';document.querySelector('#page-number').focus()",
    );
    win.webContents.focus();
    await js(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await wait('page===2');
    await js("document.querySelector('[data-select=p200]').click()");
    assert.equal(await js('selected.size'), 102);
    assert.equal(await js("document.querySelector('#page-number').value"), '3');
    assert.equal(
      await js("document.querySelector('#page-next-top').disabled"),
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
        fs.realpathSync.native(
          shell.readShortcutLink(path.join(paths.library, relative)).target,
        ),
        fs.realpathSync.native(link.target),
      );
    assert.equal(fs.readdirSync(paths.photos).length, 204);
    for (const [view, filter] of [
      ['all', null],
      ['year', '2024'],
      ['location', JSON.stringify(['中国', '北京'])],
      ['theme', 'empty'],
      ['tag', 'family'],
    ]) {
      await js(`nav(${JSON.stringify(view)}, ${JSON.stringify(filter)})`);
      assert.equal(await js('selected.size'), 0);
      const first = await js(
        "document.querySelector('[data-select]').dataset.select",
      );
      await js(
        "document.querySelector('[data-select]').click();document.querySelector('#page-next-top').click();document.querySelector('[data-select]').click()",
      );
      assert.equal(await js('selected.size'), 2);
      assert.match(
        await js("document.querySelector('.selection span').textContent"),
        /其他页 1 张/,
      );
      await js("document.querySelector('#page-prev-top').click()");
      assert.equal(
        await js(`document.querySelector('[data-select="${first}"]').checked`),
        true,
      );
      await js("document.querySelector('#select-page').click()");
      assert.equal(await js('selected.size'), 101);
      assert.equal(
        await js("document.querySelectorAll('[data-photo]').length"),
        100,
      );
      await js("document.querySelector('#clear-selection').click()");
      assert.equal(await js('selected.size'), 0);
      assert.equal(
        await js("document.querySelectorAll('[data-select]:checked').length"),
        0,
      );
    }
    // Native mouse events exercise drag selection, click suppression and scrolling.
    await js(
      "nav('all');document.querySelector('#page-next-top').click();document.querySelector('[data-select]').click();document.querySelector('#page-prev-top').click();document.querySelector('main').scrollTop=0",
    );
    const offPageId = (await js('[...selected]'))[0];
    const points = await js(`(() => {
      const images=[...document.querySelectorAll('.image-button')].slice(0,2).map(e=>e.getBoundingClientRect()),
        main=document.querySelector('main').getBoundingClientRect();
      return {start:{x:images[0].left+10,y:images[0].top+10},outside:{x:images[0].left-14,y:images[0].top+10},end:{x:images[1].right-10,y:images[1].bottom-10},top:document.querySelector('#browse-tools').getBoundingClientRect().bottom+3,bottom:main.bottom-3};
    })()`);
    const mouse = (type, point) =>
      win.webContents.sendInputEvent({
        type,
        x: Math.round(point.x),
        y: Math.round(point.y),
        button: 'left',
        clickCount: 1,
        ...(type === 'mouseMove' ? { modifiers: ['leftButtonDown'] } : {}),
      });
    mouse('mouseDown', points.outside);
    mouse('mouseMove', points.end);
    await wait('selected.size===3');
    mouse('mouseUp', points.end);
    await wait("document.querySelector('.selection-box')===null");
    assert.equal(await js("document.querySelector('#viewer').hidden"), true);
    assert.equal(await js('window.getSelection().toString()'), '');
    assert.ok((await js('[...selected]')).includes(offPageId));
    assert.match(
      await js("document.querySelector('#selection-count').textContent"),
      /其他页 1 张/,
    );
    const firstTwoIds = await js(
      "[...document.querySelectorAll('[data-photo]')].slice(0,2).map(e=>e.dataset.photo)",
    );
    const firstEnd = await js(`(() => {const r=document.querySelector('.image-button').getBoundingClientRect();return {x:r.right-10,y:r.bottom-10};})()`);
    // Repeating a drag removes the selected subset while preserving other pages.
    mouse('mouseDown', points.outside);
    mouse('mouseMove', points.end);
    await wait('selected.size===1');
    mouse('mouseUp', points.end);
    await wait("document.querySelector('.selection-box')===null");
    assert.deepEqual(await js('[...selected]'), [offPageId]);
    mouse('mouseDown', points.outside);
    mouse('mouseMove', points.end);
    await wait('selected.size===3');
    mouse('mouseMove', firstEnd);
    await wait('selected.size===2');
    assert.ok(!(await js('[...selected]')).includes(firstTwoIds[1]));
    mouse('mouseMove', points.end);
    await wait('selected.size===3');
    mouse('mouseUp', points.end);
    await wait("document.querySelector('.selection-box')===null");
    // A mixed rectangle deselects the previously selected photo and adds the other.
    mouse('mouseDown', points.start);
    mouse('mouseMove', firstEnd);
    await wait('selected.size===2');
    mouse('mouseUp', firstEnd);
    await wait("document.querySelector('.selection-box')===null");
    assert.deepEqual((await js('[...selected]')).sort(), [offPageId, firstTwoIds[1]].sort());
    mouse('mouseDown', points.outside);
    mouse('mouseMove', points.end);
    await wait(`selected.has(${JSON.stringify(firstTwoIds[0])})&&!selected.has(${JSON.stringify(firstTwoIds[1])})`);
    mouse('mouseUp', points.end);
    await wait("document.querySelector('.selection-box')===null");
    assert.deepEqual((await js('[...selected]')).sort(), [offPageId, firstTwoIds[0]].sort());
    mouse('mouseDown', points.start);
    mouse('mouseMove', { x: points.end.x, y: points.bottom });
    await wait("document.querySelector('main').scrollTop>260");
    const downSelection = await js('selected.size');
    assert.ok(downSelection > 3);
    assert.equal(
      await js(`(() => {
      const tools=document.querySelector('#browse-tools').getBoundingClientRect(), main=document.querySelector('main').getBoundingClientRect();
      return Math.abs(tools.top-main.top)<2 && ['#toolbar','#search','.selection','#page-prev-top','#page-next-top','#page-number','#page-jump-form'].every(s=>{const r=document.querySelector(s).getBoundingClientRect();return r.top>=tools.top&&r.bottom<=tools.bottom;});
    })()`),
      true,
    );
    const upperEdge = await js(
      "document.querySelector('#browse-tools').getBoundingClientRect().bottom+3",
    );
    mouse('mouseMove', { x: points.end.x, y: upperEdge });
    await wait("document.querySelector('main').scrollTop<100");
    mouse('mouseUp', { x: points.end.x, y: upperEdge });
    await wait("document.querySelector('.selection-box')===null");
    assert.equal(
      await js("document.body.classList.contains('selecting-photos')"),
      false,
    );
    await js(
      "document.querySelector('#clear-selection').click();document.querySelector('main').scrollTop=0",
    );
    const clickPoint = await js(
      `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const r=document.querySelector('.image-button').getBoundingClientRect();resolve({x:r.left+10,y:r.top+10});})))`,
    );
    mouse('mouseDown', clickPoint);
    mouse('mouseUp', clickPoint);
    await wait("!document.querySelector('#viewer').hidden");
    await js("document.querySelector('#viewer-close').click()");
    await js(
      "nav('all');document.querySelector('[data-select]').click();document.querySelector('#page-next-top').click();document.querySelector('[data-select]').click()",
    );
    const batchIds = await js('[...selected]');
    await js(
      "document.querySelector('#edit-selected').click();document.querySelector('#field-year').value='1999';document.querySelector('#edit-form').requestSubmit()",
    );
    await wait(
      "!document.querySelector('#scan').disabled && !document.querySelector('#editor').open",
    );
    const edited = await js('window.atlas.state()');
    assert.deepEqual(
      edited.photos
        .filter((p) => p.year === 1999)
        .map((p) => p.id)
        .sort(),
      batchIds.slice().sort(),
    );
    assert.ok(
      edited.photos
        .filter((p) => !batchIds.includes(p.id))
        .every((p) => p.year === 2024),
    );
    let deleteMessage,
      confirmationCount = 0;
    desktop.confirmations.delete = async (options) => {
      confirmationCount++;
      deleteMessage = options.message;
      return { response: 0 };
    };
    const keyDelete = () => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' });
    };
    await js("document.querySelector('#search').focus()");
    keyDelete();
    await js('new Promise(resolve=>setTimeout(resolve,80))');
    assert.equal(confirmationCount, 0);
    await js(
      "document.querySelector('#search').blur();document.querySelector('#edit-selected').click()",
    );
    keyDelete();
    await js('new Promise(resolve=>setTimeout(resolve,80))');
    assert.equal(confirmationCount, 0);
    await js(
      "document.querySelector('#edit-cancel').click();document.activeElement.blur()",
    );
    keyDelete();
    await wait(
      "document.querySelector('#notice').textContent==='已取消删除。' && !document.querySelector('#scan').disabled",
    );
    assert.equal(confirmationCount, 1);
    assert.match(deleteMessage, /2 张原文件/);
    assert.deepEqual(
      (await js('[...selected]')).sort(),
      batchIds.slice().sort(),
    );
    assert.equal(fs.readdirSync(paths.photos).length, 204);
    desktop.confirmations.delete = async (options) => {
      deleteMessage = options.message;
      return { response: 1 };
    };
    keyDelete();
    await wait(
      "!document.querySelector('#scan').disabled && window.atlas.state().then(s=>s.photos.length===202)",
    );
    assert.match(deleteMessage, /2 张原文件/);
    const remaining = await js('window.atlas.state()');
    assert.ok(
      batchIds.every((id) => !remaining.photos.some((p) => p.id === id)),
    );
    for (const p of remaining.photos)
      assert.deepEqual(
        fs.readFileSync(path.join(paths.photos, p.fileName)),
        input,
      );
    assert.equal(fs.readdirSync(paths.photos).length, 202);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        viewSwitches: true,
        locationTitle: '中国 / 北京',
        crossPageImport: 102,
        crossPageLibraryViews: 5,
        crossPageEditAndDelete: 2,
        dragSelectionAndAutoScroll: true,
        dragFromOuterMargin: true,
        dragToggleAndShrink: true,
        emptyDimensionEntries: 4,
        stickyPhotoTools: true,
        keyboardDeleteConfirmation: true,
        pageJumpButtonAndEnter: true,
        remainingOriginalsUntouched: 202,
        fixture: base,
      }),
    );
    app.exit(0);
  })
  .catch((error) => {
    console.error(error.stack);
    app.exit(1);
  });
