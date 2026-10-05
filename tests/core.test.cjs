const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  path = require('path'),
  os = require('os');
const {
  roots,
  openStore,
  blankLibrary,
  scan,
  candidateGroups,
  completeImport,
  updatePhotos,
  signature,
  photoPath,
} = require('../desktop/store.cjs');
const { isTheme, migrate } = require('../scripts/migrate.cjs');
const { desiredLinks, syncLinks } = require('../desktop/shortcuts.cjs');
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'photoatlas-core-'));
  const p = roots(path.join(base, 'PhotoAtlas'));
  fs.mkdirSync(p.photos);
  const store = openStore(p);
  return { base, p, store };
}
function row(id, status = 'pending') {
  return {
    id,
    relativePath: `${id}.jpg`,
    fileName: `${id}.jpg`,
    status,
    year: 2024,
    yearStatus: 'known',
    location: { country: '中国', city: '北京' },
    themeId: null,
    tagIds: [],
    fileSignature: '1:1',
    fingerprint: { sha256: id, signature: '1:1' },
  };
}

test('undo restores exact batch metadata across restart, preserves caches and syncs shortcuts', async () => {
  const f = fixture();
  f.store.data.photos = [
    row('a', 'library'),
    row('b', 'library'),
    row('c', 'library'),
  ];
  f.store.data.themes = [{ id: 'trip', name: '旅行专题' }];
  f.store.data.tags = [{ id: 'plant', name: '植物' }];
  for (const p of f.store.data.photos)
    fs.writeFileSync(path.join(f.p.photos, p.relativePath), 'original');
  f.store.save();
  const before = structuredClone(f.store.data.photos);
  const writer = (dest, target) => {
    fs.writeFileSync(dest, target);
    return true;
  };
  await syncLinks(f.store, writer);
  f.store.transaction('批量修改信息', () =>
    updatePhotos(f.store, ['a', 'b'], {
      year: 2023,
      country: '中国',
      city: '厦门',
      themeId: 'trip',
      addTagIds: ['plant'],
    }),
  );
  await syncLinks(f.store, writer);
  f.store.transaction('修改标签', () =>
    updatePhotos(f.store, ['a'], { removeTagIds: ['plant'] }),
  );
  assert.equal(f.store.undoInfo().steps, 2);
  const reopened = openStore(f.p);
  assert.equal(reopened.undo().label, '修改标签');
  assert.deepEqual(reopened.data.photos[0].tagIds, ['plant']);
  assert.equal(reopened.undo().label, '批量修改信息');
  await syncLinks(reopened, writer);
  for (let i = 0; i < 2; i++) {
    const { updatedAt, ...rest } = reopened.data.photos[i];
    assert.deepEqual(rest, before[i]);
  }
  assert.deepEqual(reopened.data.photos[2], before[2]);
  assert.equal(reopened.undoInfo().available, false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.p.data, 'shortcuts-v2.json'))),
    desiredLinks(reopened.data, f.p),
  );
  for (const p of reopened.data.photos)
    assert.equal(
      fs.readFileSync(path.join(f.p.photos, p.relativePath), 'utf8'),
      'original',
    );
});

test('undo restores deleted definitions and assignments; failed and conflicting edits do not lose data', () => {
  const f = fixture();
  f.store.data.photos = [{ ...row('a', 'library'), tagIds: ['plant'] }];
  f.store.data.tags = [{ id: 'plant', name: '植物' }];
  f.store.save();
  f.store.transaction('删除标签', () => {
    f.store.data.tags = [];
    f.store.data.photos[0].tagIds = [];
  });
  f.store.undo();
  assert.deepEqual(f.store.data.tags, [{ id: 'plant', name: '植物' }]);
  assert.deepEqual(f.store.data.photos[0].tagIds, ['plant']);
  const saved = fs.readFileSync(f.store.file, 'utf8');
  assert.throws(
    () =>
      f.store.transaction('无效编辑', () => {
        f.store.data.photos[0].year = 1900;
        f.store.data.photos[0].tagIds = ['missing'];
        f.store.save();
      }),
    /标签不存在/,
  );
  assert.equal(fs.readFileSync(f.store.file, 'utf8'), saved);
  assert.equal(f.store.data.photos[0].year, 2024);
  f.store.transaction('编辑年份', () =>
    updatePhotos(f.store, ['a'], { year: 2023 }),
  );
  f.store.data.photos[0].year = 1999;
  const conflict = JSON.stringify(f.store.data);
  assert.throws(() => f.store.undo(), /无法安全撤销/);
  assert.equal(JSON.stringify(f.store.data), conflict);
  f.store.clearUndo('原文件已永久删除');
  f.store.save();
  assert.throws(() => openStore(f.p).undo(), /永久删除/);
});

test('undo history is bounded and a scan forms a boundary; sync saves do not add steps', () => {
  const f = fixture();
  f.store.data.photos = [row('a', 'library')];
  fs.writeFileSync(path.join(f.p.photos, 'a.jpg'), 'original');
  f.store.save();
  for (let i = 0; i < 25; i++) {
    f.store.transaction('编辑年份', () =>
      updatePhotos(f.store, ['a'], { year: 1900 + i }),
    );
    f.store.save();
  }
  assert.equal(f.store.undoInfo().steps, 20);
  scan(f.store);
  assert.equal(f.store.undoInfo().available, false);
  assert.match(f.store.undoInfo().reason, /扫描/);
});
test('theme migration follows corrected rule and preserves names, IDs and multiple tags', () => {
  assert.equal(isTheme('2024莫干山专题'), true);
  assert.equal(isTheme('2024澳洲行'), true);
  assert.equal(isTheme('2023厦门花境师'), false);
  assert.equal(isTheme('家庭'), false);
  const f = fixture();
  fs.writeFileSync(path.join(f.p.photos, 'a.jpg'), 'photo');
  const categories = [
    { id: 'trip', name: '2024莫干山专题' },
    { id: 'plant', name: '植物' },
    { id: 'family', name: '家庭' },
  ];
  const legacy = {
    stores: {
      settings: [
        {
          key: 'settings',
          value: { aiProvider: { customCategories: categories } },
        },
      ],
      images: [
        {
          id: 'stable',
          uri: 'photos://a.jpg',
          categories: '["trip","plant","family"]',
          takenAt: Date.UTC(2024, 2, 1),
          city: 'loc',
          latitude: 0,
          longitude: 0,
        },
      ],
    },
  };
  const before = JSON.stringify(legacy);
  const { data } = migrate(
    legacy,
    [
      {
        stores: {
          location_details: [
            { location_id: 'loc', country_code: 'CN', admin2_zh: '北京' },
          ],
        },
      },
    ],
    f.p.photos,
    path.join(f.base, 'assets'),
  );
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(data.photos[0].id, 'stable');
  assert.equal(data.photos[0].themeId, 'trip');
  assert.deepEqual(data.photos[0].tagIds, ['plant', 'family']);
  assert.equal(data.photos[0].year, 2024);
  assert.equal(data.photos[0].location.city, '北京');
  assert.equal(data.photos[0].status, 'pending');
  assert.equal(data.photos[0].location.gps.latitude, 0);
});

test('migration maps an explicitly supplied old root and honours year-boundary timezone', () => {
  const f = fixture();
  const legacyRoot = path.join(f.base, 'OldPhotos');
  fs.writeFileSync(path.join(f.p.photos, 'a.jpg'), 'photo');
  const legacy = {
    stores: {
      settings: [],
      images: [
        {
          id: 'boundary',
          uri: path.join(legacyRoot, 'a.jpg'),
          takenAt: Date.UTC(2023, 11, 31, 20),
          categories: '[]',
        },
      ],
    },
  };
  assert.throws(() => migrate(legacy, [], f.p.photos, f.base), /--old-photos/);
  const utc = migrate(legacy, [], f.p.photos, f.base, {
    legacyPhotosRoot: legacyRoot,
    timeZone: 'UTC',
  });
  const china = migrate(legacy, [], f.p.photos, f.base, {
    legacyPhotosRoot: legacyRoot,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(utc.data.photos[0].year, 2023);
  assert.equal(china.data.photos[0].year, 2024);
  assert.equal(china.data.photos[0].relativePath, 'a.jpg');
  assert.equal(china.data.photos[0].id, 'boundary');
  assert.equal(china.data.photos[0].missing, false);
  assert.throws(
    () =>
      migrate(legacy, [], f.p.photos, f.base, {
        legacyPhotosRoot: path.join(f.base, 'WrongPhotos'),
      }),
    /超出指定/,
  );
  assert.throws(
    () =>
      migrate(legacy, [], f.p.photos, f.base, {
        legacyPhotosRoot: legacyRoot,
        timeZone: 'Invalid/Timezone',
      }),
    RangeError,
  );
});

test('shortcut sync resumes after partial creation and refuses unowned files', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.p.photos, 'a.jpg'), 'original');
  f.store.data.photos = [row('a', 'library')];
  let writes = 0;
  await assert.rejects(
    syncLinks(f.store, (dest, target) => {
      if (++writes === 2) throw Error('simulated interruption');
      fs.writeFileSync(dest, target);
      return true;
    }),
    /interruption/,
  );
  assert.ok(fs.existsSync(path.join(f.p.data, 'shortcut-sync-job.json')));
  const writer = (dest, target) => {
    fs.writeFileSync(dest, target);
    return true;
  };
  const resumed = await syncLinks(f.store, writer);
  assert.equal(resumed.total, 2);
  assert.equal(
    fs.existsSync(path.join(f.p.data, 'shortcut-sync-job.json')),
    false,
  );
  assert.equal(
    fs.readFileSync(path.join(f.p.photos, 'a.jpg'), 'utf8'),
    'original',
  );
  const relocated = path.join(f.base, 'RelocatedPhotos');
  fs.mkdirSync(relocated);
  fs.copyFileSync(
    path.join(f.p.photos, 'a.jpg'),
    path.join(relocated, 'a.jpg'),
  );
  f.store.paths.photos = relocated;
  writes = 0;
  await assert.rejects(
    syncLinks(f.store, (dest, target) => {
      if (++writes === 2) throw Error('retarget interrupted');
      fs.writeFileSync(dest, target);
      return true;
    }),
    /interrupted/,
  );
  await syncLinks(f.store, writer);
  for (const relative of Object.keys(desiredLinks(f.store.data, f.p)))
    assert.equal(
      fs.readFileSync(path.join(f.p.library, relative), 'utf8'),
      path.join(relocated, 'a.jpg'),
    );
  const second = fixture();
  fs.writeFileSync(path.join(second.p.photos, 'a.jpg'), 'other original');
  second.store.data.photos = [row('a', 'library')];
  const relative = Object.keys(desiredLinks(second.store.data, second.p))[0],
    dest = path.join(second.p.library, relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'external file');
  await assert.rejects(syncLinks(second.store, writer), /未登记/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'external file');
  assert.equal(
    fs.existsSync(path.join(second.p.data, 'shortcut-sync-job.json')),
    false,
  );
});
test('A-B and B-C merge transitively, stale and deleted edges do not create ghosts', () => {
  const data = blankLibrary();
  data.photos = ['a', 'b', 'c'].map((x) => row(x));
  data.analysis = {
    edges: [
      { a: 'a', b: 'b', aHash: 'a', bHash: 'b' },
      { a: 'b', b: 'c', aHash: 'b', bHash: 'c' },
    ],
  };
  assert.equal(candidateGroups(data).length, 1);
  assert.equal(candidateGroups(data)[0].count, 3);
  data.photos[1].missing = true;
  assert.equal(candidateGroups(data).length, 0);
  data.photos[1].missing = false;
  data.photos[1].fileSignature = 'changed';
  assert.equal(candidateGroups(data).length, 0);
});
test('import confirmation checks whole selection before commit and requires reviewed candidates', () => {
  const f = fixture();
  for (const id of ['a', 'b']) {
    fs.writeFileSync(path.join(f.p.photos, `${id}.jpg`), id);
    const p = row(id);
    p.fileSignature = signature(fs.statSync(photoPath(f.p, p)));
    p.fingerprint.signature = p.fileSignature;
    f.store.data.photos.push(p);
  }
  f.store.data.analysis = {
    status: 'complete',
    edges: [{ a: 'a', b: 'b', aHash: 'a', bHash: 'b' }],
  };
  assert.throws(() => completeImport(f.store, ['a', 'b']), /尚未确认/);
  assert.equal(f.store.data.photos[0].status, 'pending');
  const g = candidateGroups(f.store.data)[0];
  f.store.data.reviewedGroups[g.id] = {};
  fs.writeFileSync(path.join(f.p.photos, 'b.jpg'), 'changed');
  assert.throws(() => completeImport(f.store, ['a', 'b']), /变化/);
  assert.equal(f.store.data.photos[0].status, 'pending');
  const b = f.store.data.photos[1];
  b.fileSignature = signature(fs.statSync(photoPath(f.p, b)));
  b.fingerprint.signature = b.fileSignature;
  assert.equal(completeImport(f.store, ['a', 'b']), 2);
});
test('rescan preserves manual metadata and stable IDs; missing root does not erase data', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.p.photos, 'a.jpg'), 'test');
  scan(f.store);
  const p = f.store.data.photos[0],
    id = p.id;
  updatePhotos(f.store, [id], {
    year: 1999,
    country: '澳大利亚',
    city: '悉尼',
  });
  p.status = 'library';
  scan(f.store);
  assert.equal(f.store.data.photos[0].id, id);
  assert.equal(p.year, 1999);
  assert.equal(p.location.city, '悉尼');
  assert.throws(() =>
    updatePhotos(f.store, [id], { year: 2000, locationStatus: 'bad' }),
  );
  assert.equal(p.year, 1999);
  fs.renameSync(f.p.photos, f.p.photos + '-offline');
  assert.throws(() => scan(f.store), /无法访问/);
  assert.equal(f.store.data.photos.length, 1);
});
test('four shortcut dimensions share originals, pending city uses 待补充, sync removes links only', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.p.photos, 'a.jpg'), 'original');
  const p = row('a', 'library');
  p.location.city = null;
  p.themeId = 'trip';
  p.tagIds = ['plant', 'family'];
  f.store.data.photos = [p];
  f.store.data.themes = [{ id: 'trip', name: '旅行' }];
  f.store.data.tags = [
    { id: 'plant', name: '植物' },
    { id: 'family', name: '家庭' },
  ];
  const links = desiredLinks(f.store.data, f.p);
  assert.equal(Object.keys(links).length, 5);
  assert.ok(
    Object.keys(links).some((x) =>
      x.includes(path.join('地点', '中国', '待补充')),
    ),
  );
  assert.equal(new Set(Object.values(links).map((x) => x.target)).size, 1);
  const writer = (dest, target) => {
    fs.writeFileSync(dest, target);
    return true;
  };
  await syncLinks(f.store, writer);
  p.tagIds = ['plant'];
  const result = await syncLinks(f.store, writer);
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(path.join(f.p.library, '标签', '家庭')), false);
  assert.equal(
    fs.readFileSync(path.join(f.p.photos, 'a.jpg'), 'utf8'),
    'original',
  );
  assert.throws(
    () => photoPath(f.p, { relativePath: '../outside.jpg' }),
    /超出/,
  );
});
test('sync prunes obsolete nested categories, preserves files, roots and junctions', async () => {
  const f = fixture(),
    p = row('a', 'library');
  fs.writeFileSync(path.join(f.p.photos, 'a.jpg'), 'original');
  p.location = { country: '澳大利亚', city: '墨尔本' };
  p.tagIds = ['old'];
  f.store.data.photos = [p];
  f.store.data.tags = [{ id: 'old', name: '2023厦门花境师' }];
  const writer = (dest, target) => {
    fs.writeFileSync(dest, target);
    return true;
  };
  await syncLinks(f.store, writer);
  p.location = { country: 'Australia', city: 'Melbourne' };
  p.tagIds = [];
  f.store.data.tags = [];
  const protectedDirectory = path.join(f.p.library, '标签', '手工文件');
  fs.mkdirSync(protectedDirectory);
  fs.writeFileSync(path.join(protectedDirectory, 'note.txt'), 'keep');
  const stale = path.join(f.p.library, '主题', '旧空目录', '子目录');
  fs.mkdirSync(stale, { recursive: true });
  const external = path.join(f.base, 'External');
  fs.mkdirSync(path.join(external, 'empty'), { recursive: true });
  const junction = path.join(f.p.library, '地点', 'External');
  fs.symlinkSync(
    external,
    junction,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const result = await syncLinks(f.store, writer);
  assert.equal(result.removedDirectories, 5);
  assert.equal(
    fs.existsSync(path.join(f.p.library, '地点', '澳大利亚')),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(f.p.library, '标签', '2023厦门花境师')),
    false,
  );
  assert.equal(fs.existsSync(path.dirname(stale)), false);
  assert.ok(
    fs.existsSync(path.join(f.p.library, '地点', 'Australia', 'Melbourne')),
  );
  for (const name of ['时间', '地点', '主题', '标签'])
    assert.ok(fs.existsSync(path.join(f.p.library, name)));
  assert.equal(
    fs.readFileSync(path.join(protectedDirectory, 'note.txt'), 'utf8'),
    'keep',
  );
  assert.ok(fs.lstatSync(junction).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(external, 'empty')));
  assert.equal(
    fs.readFileSync(path.join(f.p.photos, 'a.jpg'), 'utf8'),
    'original',
  );
  assert.equal((await syncLinks(f.store, writer)).removedDirectories, 0);
});
