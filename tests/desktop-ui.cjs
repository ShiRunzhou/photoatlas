const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  assert = require('assert/strict'),
  sharp = require('sharp');
const { app, BrowserWindow, dialog } = require('electron');
const { roots, openStore, signature } = require('../desktop/store.cjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'photoatlas-v2-ui-')),
  project = path.join(base, 'PhotoAtlas');
process.env.PHOTOATLAS_PROJECT = project;
process.env.PHOTOATLAS_TEST_MODE = '1';
const paths = roots(project);
fs.mkdirSync(paths.photos, { recursive: true });
const svg =
  '<svg width="900" height="600"><rect width="900" height="600" fill="#81bace"/><rect x="40" y="40" width="320" height="180" fill="#d54529"/><circle cx="650" cy="390" r="150" fill="#204b17"/><path d="M0 520 L900 470 L900 600 L0 600" fill="#c4ac69"/></svg>';
async function setup() {
  // Build fixtures synchronously in an external Node process so Electron's
  // scheme registration and userData setup still happen before app readiness.
  require('child_process').execFileSync(
    'node',
    [
      '-e',
      `const sharp=require('sharp'),path=require('path');const svg=${JSON.stringify(svg)},dir=${JSON.stringify(paths.photos)};(async()=>{await sharp(Buffer.from(svg)).jpeg({quality:96}).toFile(path.join(dir,'a-original.jpg'));await sharp(path.join(dir,'a-original.jpg')).resize(450,300).jpeg({quality:70}).toFile(path.join(dir,'b-compressed.jpg'));await sharp(Buffer.from(svg.replace('x="40"','x="450"').replace('cx="650"','cx="220"'))).jpeg().toFile(path.join(dir,'c-other.jpg'));})().catch(e=>{console.error(e);process.exit(1);});`,
    ],
    { cwd: path.resolve(__dirname, '..'), windowsHide: true },
  );
  const store = openStore(paths);
  store.data.themes = [{ id: 'trip', name: '2024测试专题' }];
  store.data.tags = [
    { id: 'plant', name: '植物' },
    { id: 'family', name: '家庭' },
  ];
  for (const [i, name] of [
    'a-original.jpg',
    'b-compressed.jpg',
    'c-other.jpg',
  ].entries())
    store.data.photos.push({
      id: `p${i}`,
      relativePath: name,
      fileName: name,
      status: 'pending',
      year: 2024,
      yearStatus: 'known',
      yearSource: 'legacy',
      location: { country: '中国', city: '北京', status: 'known' },
      themeId: 'trip',
      tagIds: i === 1 ? ['family'] : ['plant'],
      fileSignature: signature(fs.statSync(path.join(paths.photos, name))),
      size: fs.statSync(path.join(paths.photos, name)).size,
      needsRecheck: true,
    });
  store.save();
  const before = fs.readFileSync(path.join(paths.photos, 'a-original.jpg'));
  console.log('UI fixture ready: ' + base);
  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) console.log('Renderer: ' + message);
    });
    win.webContents.once('did-finish-load', () => {
      console.log('UI loaded');
      run(win, before).catch((error) => {
        console.error(error.stack);
        app.exit(1);
      });
    });
  });
  require('../desktop/main.cjs');
}
async function run(win, before) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = async (code) => {
    const end = Date.now() + 40000;
    while (Date.now() < end) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    console.error(
      await js(
        `JSON.stringify({notice:document.querySelector('#notice').textContent,selection:document.querySelector('.selection')?.textContent,deleteDisabled:document.querySelector('#delete-selected')?.disabled})`,
      ),
    );
    throw Error(`UI timeout: ${code}`);
  };
  await wait(`document.querySelector('#analyze')!==null`);
  console.log('Analyze button ready');
  await js(`document.querySelector('#analyze').click()`);
  await wait(`window.atlas.state().then(s=>s.analysis?.status==='complete')`);
  let state = await js(`window.atlas.state()`);
  assert.equal(
    state.analysis.failed,
    0,
    JSON.stringify(state.photos.map((x) => x.readError)),
  );
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].count, 2);
  console.log('Analysis passed');
  await js(
    `document.querySelector('[data-nav="groups"]').click();document.querySelector('[data-group]').click();document.querySelector('[data-view="p0"]').click()`,
  );
  await wait(`document.querySelector('#large-image').naturalWidth>0`);
  assert.match(
    await js(`document.querySelector('#viewer-title').textContent`),
    /a-original/,
  );
  await js(`document.querySelector('#next').click()`);
  await wait(
    `document.querySelector('#viewer-title').textContent.includes('b-compressed')`,
  );
  await js(
    `document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft'}))`,
  );
  assert.match(
    await js(`document.querySelector('#viewer-title').textContent`),
    /a-original/,
  );
  await js(`document.querySelector('#zoom-in').click()`);
  assert.ok(
    await js(`parseInt(document.querySelector('#zoom-label').textContent)>0`),
  );
  await js(`document.querySelector('#viewer-close').click()`);
  require('../desktop/main.cjs').confirmations.delete = async () => {
    console.log('Delete confirmation stub called');
    return { response: 1 };
  };
  console.log('Viewer passed');
  console.log(
    'Before selection',
    await js(
      `JSON.stringify({busy,scanDisabled:document.querySelector('#scan').disabled,notice:document.querySelector('#notice').textContent})`,
    ),
  );
  await wait(`!document.querySelector('#scan').disabled`);
  console.log('Scan enabled');
  await js(`document.querySelector('[data-select="p1"]').click()`);
  console.log(
    'Selected',
    await js(
      `JSON.stringify({selected:[...selected],disabled:document.querySelector('#delete-selected').disabled})`,
    ),
  );
  await wait(`!document.querySelector('#delete-selected').disabled`);
  await js(`document.querySelector('#delete-selected').click()`);
  console.log('Delete clicked');
  await wait(`window.atlas.state().then(s=>s.photos.length===2)`);
  state = await js(`window.atlas.state()`);
  assert.deepEqual(state.photos.find((x) => x.id === 'p0').tagIds.sort(), [
    'family',
    'plant',
  ]);
  assert.equal(
    fs.existsSync(path.join(paths.photos, 'b-compressed.jpg')),
    false,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(paths.photos, 'a-original.jpg')),
    before,
  );
  await wait(`!document.querySelector('#scan').disabled`);
  await js(
    `document.querySelector('[data-nav="pending"]').click();document.querySelector('#confirm-ready').click()`,
  );
  await wait(
    `window.atlas.state().then(s=>s.photos.every(p=>p.status==='library'))`,
  );
  await wait(`!document.querySelector('#scan').disabled`);
  await js(
    `document.querySelector('[data-nav="year"]').click();document.querySelector('[data-bucket="2024"]').click();document.querySelector('[data-select="p0"]').click();document.querySelector('#edit-selected').click()`,
  );
  await js(
    `document.querySelector('#field-year').value='1999';document.querySelector('#field-country').value='澳大利亚';document.querySelector('#field-city').value='悉尼';document.querySelector('#edit-form').requestSubmit()`,
  );
  await wait(
    `window.atlas.state().then(s=>s.photos.find(p=>p.id==='p0').year===1999)`,
  );
  await wait(`!document.querySelector('#scan').disabled`);
  await js(
    `document.querySelector('[data-nav="all"]').click();document.querySelector('[data-view="p0"]').click()`,
  );
  await wait(`document.querySelector('#large-image').naturalWidth>0`);
  assert.match(
    await js(`document.querySelector('#viewer-info').textContent`),
    /1999年/,
  );
  assert.equal(
    await js(`document.querySelector('#viewer-edit').disabled`),
    false,
  );
  assert.equal(
    await js(
      `document.querySelector('#viewer-delete').getBoundingClientRect().top>document.querySelector('#viewer-title').getBoundingClientRect().bottom`,
    ),
    true,
  );
  await js(`document.querySelector('#viewer-close').click()`);
  fs.writeFileSync(
    path.join(base, '界面.png'),
    (await win.webContents.capturePage()).toPNG(),
  );
  const links = JSON.parse(
    fs.readFileSync(path.join(paths.data, 'shortcuts-v2.json'), 'utf8'),
  );
  assert.ok(Object.keys(links).some((x) => x.includes('1999')));
  assert.ok(Object.keys(links).some((x) => x.includes('悉尼')));
  for (const [rel, item] of Object.entries(links))
    assert.equal(
      fs.realpathSync.native(
        require('electron').shell.readShortcutLink(path.join(paths.library, rel))
          .target,
      ),
      fs.realpathSync.native(item.target),
    );
  assert.deepEqual(
    fs.readFileSync(path.join(paths.photos, 'a-original.jpg')),
    before,
  );
  console.log(
    JSON.stringify({
      passed: true,
      fixture: base,
      links: Object.keys(links).length,
      versions: process.versions,
    }),
  );
  app.exit(0);
}
setup().catch((error) => {
  console.error(error.stack);
  app.exit(1);
});
