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
  assert.equal(
    fs.readFileSync(path.join(f.p.photos, 'a.jpg'), 'utf8'),
    'original',
  );
  assert.throws(
    () => photoPath(f.p, { relativePath: '../outside.jpg' }),
    /超出/,
  );
});
