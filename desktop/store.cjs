'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
  '.avif',
  '.tif',
  '.tiff',
  '.bmp',
  '.gif',
]);
function atomicJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
function inside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)
  );
}
function roots(project) {
  const base = path.dirname(path.resolve(project));
  return {
    project: path.resolve(project),
    photos: path.join(base, 'Photos'),
    library: path.join(base, 'Library'),
    data: path.join(project, 'data'),
  };
}
function photoPath(p, photo) {
  if (!photo || typeof photo.relativePath !== 'string')
    throw Error('照片路径无效');
  const file = path.resolve(p.photos, photo.relativePath);
  if (!inside(p.photos, file)) throw Error('照片路径超出原图目录');
  // A directory junction must not redirect managed operations outside Photos.
  if (
    fs.existsSync(file) &&
    !inside(fs.realpathSync(p.photos), fs.realpathSync(file))
  )
    throw Error('照片实际路径超出原图目录');
  return file;
}
function signature(stat) {
  return `${stat.size}:${stat.mtimeMs}`;
}
function blankLibrary() {
  return {
    version: 2,
    revision: 0,
    photos: [],
    themes: [],
    tags: [],
    reviewedGroups: {},
    analysis: null,
    createdAt: new Date().toISOString(),
  };
}
function validate(data) {
  if (
    data?.version !== 2 ||
    !Array.isArray(data.photos) ||
    !Array.isArray(data.themes) ||
    !Array.isArray(data.tags)
  )
    throw Error('照片库格式不受支持');
  const ids = new Set();
  for (const photo of data.photos) {
    if (
      !photo.id ||
      ids.has(photo.id) ||
      typeof photo.relativePath !== 'string'
    )
      throw Error('照片编号或路径无效');
    if (
      !['pending', 'library'].includes(photo.status) ||
      !Array.isArray(photo.tagIds)
    )
      throw Error('照片状态或标签无效');
    if (photo.themeId && !data.themes.some((x) => x.id === photo.themeId))
      throw Error('照片引用的主题不存在');
    if (photo.tagIds.some((id) => !data.tags.some((x) => x.id === id)))
      throw Error('照片引用的标签不存在');
    ids.add(photo.id);
  }
  return data;
}
function openStore(p) {
  fs.mkdirSync(p.data, { recursive: true });
  const file = path.join(p.data, 'library-v2.json');
  let data = fs.existsSync(file)
    ? validate(JSON.parse(fs.readFileSync(file, 'utf8')))
    : blankLibrary();
  function save() {
    validate(data);
    data.revision++;
    data.savedAt = new Date().toISOString();
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.previous`);
    atomicJSON(file, data);
    const day = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
    }).format(new Date());
    const daily = path.join(p.data, 'backups', `${day}.json`);
    if (!fs.existsSync(daily)) atomicJSON(daily, data);
  }
  return {
    get data() {
      return data;
    },
    save,
    replace(next) {
      data = validate(next);
      save();
    },
    paths: p,
    file,
  };
}
function scan(store) {
  const p = store.paths;
  if (!fs.existsSync(p.photos) || !fs.statSync(p.photos).isDirectory())
    throw Error('原图目录无法访问；没有移除任何记录');
  const found = new Set(),
    byPath = new Map(
      store.data.photos.map((x) => [x.relativePath.toLowerCase(), x]),
    );
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        walk(file);
        continue;
      }
      if (!IMAGE_EXTENSIONS.has(path.extname(ent.name).toLowerCase())) continue;
      const relativePath = path
          .relative(p.photos, file)
          .split(path.sep)
          .join('/'),
        stat = fs.statSync(file);
      const key = relativePath.toLowerCase();
      found.add(key);
      let photo = byPath.get(key);
      if (!photo) {
        photo = {
          id: `photo_${crypto.randomUUID()}`,
          relativePath,
          fileName: ent.name,
          status: 'pending',
          year: null,
          yearStatus: 'pending',
          location: { country: null, city: null, status: 'pending' },
          themeId: null,
          tagIds: [],
          addedAt: new Date().toISOString(),
        };
        store.data.photos.push(photo);
        byPath.set(key, photo);
      }
      photo.missing = false;
      photo.size = stat.size;
      photo.fileSignature = signature(stat);
      if (photo.fingerprint?.signature !== photo.fileSignature) {
        photo.needsRecheck = true;
        photo.readError = null;
      }
    }
  }
  walk(p.photos);
  for (const photo of store.data.photos)
    if (!found.has(photo.relativePath.toLowerCase())) photo.missing = true;
  store.save();
  return {
    total: store.data.photos.length,
    pending: store.data.photos.filter((x) => x.status === 'pending').length,
    missing: store.data.photos.filter((x) => x.missing).length,
  };
}
function groupKey(members) {
  return crypto
    .createHash('sha256')
    .update(
      members
        .map((x) => `${x.id}:${x.fingerprint?.sha256 || ''}`)
        .sort()
        .join('\n'),
    )
    .digest('hex');
}
function candidateGroups(data) {
  const byId = new Map(
    data.photos.filter((x) => !x.missing).map((x) => [x.id, x]),
  );
  const parent = new Map();
  function find(id) {
    if (!parent.has(id)) parent.set(id, id);
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== id) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  }
  for (const edge of data.analysis?.edges || []) {
    const a = byId.get(edge.a),
      b = byId.get(edge.b);
    if (
      !a ||
      !b ||
      a.fingerprint?.sha256 !== edge.aHash ||
      b.fingerprint?.sha256 !== edge.bHash ||
      a.fileSignature !== a.fingerprint?.signature ||
      b.fileSignature !== b.fingerprint?.signature
    )
      continue;
    parent.set(find(a.id), find(b.id));
  }
  const components = new Map();
  for (const id of parent.keys()) {
    const key = find(id);
    if (!components.has(key)) components.set(key, []);
    components.get(key).push(byId.get(id));
  }
  return [...components.values()]
    .filter((x) => x.length > 1)
    .map((members) => {
      const id = groupKey(members);
      return {
        id,
        photoIds: members.map((x) => x.id),
        reviewed: !!data.reviewedGroups[id],
        count: members.length,
      };
    });
}
function completeImport(store, ids) {
  if (store.data.analysis?.status !== 'complete')
    throw Error('请先完成本机版本比对');
  const selected = new Set(ids),
    groups = candidateGroups(store.data);
  if (
    groups.some((g) => !g.reviewed && g.photoIds.some((id) => selected.has(id)))
  )
    throw Error('选中的照片仍有候选组尚未确认');
  const photos = store.data.photos.filter((x) => selected.has(x.id));
  if (photos.length !== selected.size) throw Error('照片记录已变化，请刷新');
  for (const photo of photos) {
    const stat = fs.statSync(photoPath(store.paths, photo));
    if (
      photo.readError ||
      photo.missing ||
      photo.fingerprint?.signature !== signature(stat)
    )
      throw Error(`照片尚未检查或内容已变化：${photo.fileName}`);
  }
  for (const photo of photos) {
    photo.status = 'library';
    photo.needsRecheck = false;
    photo.confirmedAt = new Date().toISOString();
  }
  store.save();
  return photos.length;
}
function updatePhotos(store, ids, patch) {
  const photos = store.data.photos.filter((x) => ids.includes(x.id));
  if (photos.length !== new Set(ids).size) throw Error('照片记录已变化');
  const allowed = new Set([
    'year',
    'yearStatus',
    'country',
    'city',
    'locationStatus',
    'themeId',
    'addTagIds',
    'removeTagIds',
  ]);
  for (const key of Object.keys(patch))
    if (!allowed.has(key)) throw Error('不支持的修改');
  for (const key of ['addTagIds', 'removeTagIds'])
    if (key in patch && !Array.isArray(patch[key])) throw Error('标签列表无效');
  if (
    'yearStatus' in patch &&
    !['known', 'pending', 'unknown'].includes(patch.yearStatus)
  )
    throw Error('年份状态无效');
  if (
    'locationStatus' in patch &&
    !['known', 'pending', 'unknown'].includes(patch.locationStatus)
  )
    throw Error('地点状态无效');
  if (
    'year' in patch &&
    patch.year !== null &&
    (!Number.isInteger(patch.year) || patch.year < 1 || patch.year > 9999)
  )
    throw Error('年份必须是 1 至 9999 的整数');
  if (patch.themeId && !store.data.themes.some((x) => x.id === patch.themeId))
    throw Error('主题不存在');
  for (const id of [...(patch.addTagIds || []), ...(patch.removeTagIds || [])])
    if (!store.data.tags.some((x) => x.id === id)) throw Error('标签不存在');
  for (const key of ['country', 'city'])
    if (
      key in patch &&
      patch[key] !== null &&
      (typeof patch[key] !== 'string' || patch[key].length > 120)
    )
      throw Error('地点名称无效');
  for (const photo of photos) {
    if ('year' in patch) {
      photo.year = patch.year;
      photo.yearSource = 'manual';
      photo.yearStatus = patch.year === null ? 'pending' : 'known';
    }
    if ('yearStatus' in patch) {
      photo.yearStatus = patch.yearStatus;
      photo.yearSource = 'manual';
      if (patch.yearStatus !== 'known') photo.year = null;
    }
    photo.location ||= {};
    for (const key of ['country', 'city'])
      if (key in patch) {
        photo.location[key] = patch[key]?.trim() || null;
        photo.location.source = 'manual';
      }
    if ('country' in patch || 'city' in patch)
      photo.location.status =
        photo.location.country && photo.location.city ? 'known' : 'pending';
    if ('locationStatus' in patch) {
      photo.location.status = patch.locationStatus;
      photo.location.source = 'manual';
    }
    if ('themeId' in patch) photo.themeId = patch.themeId || null;
    photo.tagIds = [
      ...new Set([...(photo.tagIds || []), ...(patch.addTagIds || [])]),
    ].filter((x) => !(patch.removeTagIds || []).includes(x));
    photo.updatedAt = new Date().toISOString();
  }
  store.save();
  return photos.length;
}
module.exports = {
  atomicJSON,
  inside,
  roots,
  photoPath,
  signature,
  blankLibrary,
  openStore,
  scan,
  groupKey,
  candidateGroups,
  completeImport,
  updatePhotos,
};
