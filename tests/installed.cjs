'use strict';
// Read-only verification of the installed collection. Leave the window open.
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { app, BrowserWindow } = require('electron');
const desktop = require('../desktop/main.cjs');
desktop.ready
  .then(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    const js = (code) => win.webContents.executeJavaScript(code);
    const capture = async (file) => {
      await js(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,50))))',
      );
      fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    };
    const wait = async (code) => {
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        if (await js(code)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error('安装界面验证超时：' + code);
    };
    await wait("document.querySelectorAll('[data-photo]').length>0");
    const state = await js('window.atlas.state()');
    assert.equal(state.analysis.status, 'complete');
    assert.equal(
      state.photos.filter((p) => p.readError || p.missing).length,
      0,
    );
    assert.equal(
      await js("document.querySelectorAll('[data-photo]').length"),
      Math.min(100, state.photos.length),
    );
    const ids = await js(
      "[...document.querySelectorAll('[data-view]')].map(e=>e.dataset.view)",
    );
    await js("document.querySelectorAll('[data-view]')[7].click()");
    await wait("document.querySelector('#large-image').naturalWidth>0");
    assert.equal(await js('viewerId'), ids[7]);
    await js("document.querySelector('#next').click()");
    await wait(
      `viewerId===${JSON.stringify(ids[8])}&&document.querySelector('#large-image').naturalWidth>0`,
    );
    await js(
      "document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft'}))",
    );
    assert.equal(await js('viewerId'), ids[7]);
    await js("document.querySelector('#viewer-close').click()");
    const start = Date.now();
    await js("document.querySelector('#page-next-top').click()");
    assert.equal(
      await js("document.querySelectorAll('[data-photo]').length"),
      100,
    );
    assert.notEqual(
      await js("document.querySelector('[data-photo]').dataset.photo"),
      ids[0],
    );
    const pageTimeMs = Date.now() - start;
    await js("document.querySelector('#page-prev-top').click()");
    await js(
      "document.querySelector('[data-select]').click();document.querySelector('#page-next-top').click();document.querySelector('[data-select]').click()",
    );
    assert.equal(await js('selected.size'), 2);
    await js("document.querySelector('#page-prev-top').click()");
    assert.equal(
      await js("document.querySelector('[data-select]').checked"),
      true,
    );
    await js("document.querySelector('#clear-selection').click()");
    await wait(
      "[...document.querySelectorAll('.image-button img')].filter(i=>i.complete&&i.naturalWidth>0).length>5",
    );
    const project = path.resolve(__dirname, '..');
    fs.writeFileSync(
      path.join(project, 'data/新版界面.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    const activeGroups = state.groups.filter((g) =>
      g.photoIds.some(
        (id) =>
          state.photos.find((p) => p.id === id)?.status === 'pending' ||
          state.photos.find((p) => p.id === id)?.needsRecheck,
      ),
    );
    if (activeGroups.length) {
      await js(
        "document.querySelector('[data-nav=groups]').click();document.querySelector('[data-group]').click()",
      );
      await wait(
        "document.querySelectorAll('[data-photo]').length>1&&document.querySelector('.image-button img').naturalWidth>0",
      );
      fs.writeFileSync(
        path.join(project, 'data/版本候选界面.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      await js("document.querySelector('[data-nav=pending]').click()");
    }
    if (state.photos.some((p) => p.status === 'library')) {
      await js(
        "document.querySelector('[data-nav=location]').click();document.querySelector('[data-nav=theme]').click()",
      );
      const themeNames = await js(
        "[...document.querySelectorAll('[data-bucket] strong')].map(e=>e.textContent)",
      );
      for (const theme of state.themes)
        assert.ok(themeNames.includes(theme.name));
      await capture(path.join(project, 'data/主题修复界面.png'));
      await js("document.querySelector('[data-nav=tag]').click()");
      const tagNames = await js(
        "[...document.querySelectorAll('[data-bucket] strong')].map(e=>e.textContent)",
      );
      for (const tag of state.tags) assert.ok(tagNames.includes(tag.name));
      await capture(path.join(project, 'data/标签修复界面.png'));
      await js(
        "document.querySelector('[data-nav=location]').click();[...document.querySelectorAll('[data-bucket]')].find(e=>e.textContent.includes('中国 / 北京')).click()",
      );
      assert.equal(
        await js("document.querySelector('#toolbar h1').textContent"),
        '中国 / 北京',
      );
      assert.ok(await js("document.querySelectorAll('[data-photo]').length>0"));
      await capture(path.join(project, 'data/地点修复界面.png'));
      await js("document.querySelector('[data-nav=pending]').click()");
    }
    const report = {
      passed: true,
      photos: state.photos.length,
      groups: state.groups.length,
      pageTimeMs,
      displayLimit: 100,
      at: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(project, 'data/installed-verification.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    win.show();
    win.focus();
  })
  .catch((error) => {
    console.error(error.stack);
    app.exit(1);
  });
