'use strict';
// Verify the first launch without an existing database or photo directory.
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  assert = require('assert/strict');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'photoatlas-startup-'));
process.env.PHOTOATLAS_PROJECT = path.join(base, 'PhotoAtlas');
process.env.PHOTOATLAS_TEST_MODE = '1';
const { app, BrowserWindow } = require('electron'),
  desktop = require('../desktop/main.cjs');
desktop.ready
  .then(async () => {
    const win = BrowserWindow.getAllWindows()[0],
      js = (code) => win.webContents.executeJavaScript(code);
    const wait = async (code) => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (await js(code)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error('首次启动界面超时');
    };
    await wait(
      "document.querySelector('[data-nav=\"pending\"]')?.textContent.includes('0')",
    );
    const state = await js('window.atlas.state()');
    assert.deepEqual(state.photos, []);
    assert.deepEqual(state.themes, []);
    assert.deepEqual(state.tags, []);
    await js("document.querySelector('#scan').click()");
    await wait(
      "document.querySelector('#notice').textContent.includes('无法访问')",
    );
    assert.equal((await js('window.atlas.state()')).photos.length, 0);
    fs.mkdirSync(path.join(base, 'Photos'));
    const result = await js('window.atlas.scan()');
    assert.equal(result.total, 0);
    console.log(
      JSON.stringify({
        passed: true,
        blankStartup: true,
        missingRootHandled: true,
      }),
    );
    app.exit(0);
  })
  .catch((error) => {
    console.error(error.stack);
    app.exit(1);
  });
