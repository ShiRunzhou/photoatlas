const fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');
const { inside, photoPath, atomicJSON } = require('./store.cjs');
function short(id) {
  return crypto
    .createHash('sha256')
    .update(String(id))
    .digest('hex')
    .slice(0, 10);
}
function safe(value) {
  let s = String(value)
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!s || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))
    s = `_${s || '未设置'}`;
  return s.length > 45 ? `${s.slice(0, 34)}_${short(value)}` : s;
}
function names(defs) {
  const out = new Map(),
    seen = new Map();
  for (const def of defs) {
    let name = safe(def.name);
    const key = name.toLowerCase();
    if (seen.has(key)) name += `_${short(def.id)}`;
    else seen.set(key, def.id);
    out.set(def.id, name);
  }
  return out;
}
function desiredLinks(data, p) {
  const themes = names(data.themes),
    tags = names(data.tags),
    links = {};
  for (const photo of data.photos) {
    if (photo.status !== 'library' || photo.missing) continue;
    const file = photoPath(p, photo);
    if (!fs.existsSync(file)) continue;
    const dirs = [
      [
        '时间',
        photo.yearStatus === 'unknown'
          ? '无法确定'
          : photo.year
            ? String(photo.year)
            : '待补充',
      ],
    ];
    if (photo.location?.status === 'unknown') dirs.push(['地点', '无法确定']);
    else if (!photo.location?.country) dirs.push(['地点', '待补充']);
    else
      dirs.push([
        '地点',
        safe(photo.location.country),
        photo.location.city ? safe(photo.location.city) : '待补充',
      ]);
    if (photo.themeId && themes.has(photo.themeId))
      dirs.push(['主题', themes.get(photo.themeId)]);
    for (const tag of photo.tagIds || [])
      if (tags.has(tag)) dirs.push(['标签', tags.get(tag)]);
    const filename = `${safe(photo.fileName || path.basename(file))}_${short(photo.id)}.lnk`;
    for (const parts of dirs) {
      const relative = path.join(...parts, filename);
      links[relative] = { target: file, id: photo.id };
    }
  }
  return links;
}
function pruneEmptyDirectories(library) {
  const root = fs.realpathSync(library);
  let removed = 0;
  function visit(directory, keep) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    if (!inside(root, fs.realpathSync(directory))) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory() && !entry.isSymbolicLink())
        visit(path.join(directory, entry.name), false);
    if (keep || fs.readdirSync(directory).length) return;
    try {
      // Non-recursive removal also protects files created during this sync.
      fs.rmdirSync(directory);
      removed++;
    } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error;
    }
  }
  for (const name of ['时间', '地点', '主题', '标签']) {
    const directory = path.join(library, name);
    if (fs.existsSync(directory)) visit(directory, true);
  }
  return removed;
}
async function syncLinks(store, writeShortcut, progress = () => {}) {
  const p = store.paths;
  fs.mkdirSync(p.library, { recursive: true });
  for (const name of ['时间', '地点', '主题', '标签'])
    fs.mkdirSync(path.join(p.library, name), { recursive: true });
  const file = path.join(p.data, 'shortcuts-v2.json'),
    journal = path.join(p.data, 'shortcut-sync-job.json');
  let previous = {};
  if (fs.existsSync(file)) previous = JSON.parse(fs.readFileSync(file, 'utf8'));
  const recovering = fs.existsSync(journal);
  // Persist ownership before creating files so interrupted runs can resume.
  if (recovering)
    previous = { ...previous, ...JSON.parse(fs.readFileSync(journal, 'utf8')) };
  const next = desiredLinks(store.data, p),
    entries = Object.entries(next);
  let written = 0,
    removed = 0;
  for (const [relative, link] of entries) {
    const dest = path.resolve(p.library, relative);
    if (!inside(p.library, dest) || path.extname(dest).toLowerCase() !== '.lnk')
      throw Error('快捷方式路径无效');
    if (fs.existsSync(dest) && !previous[relative])
      throw Error(`存在未登记的同名快捷方式：${relative}`);
  }
  atomicJSON(journal, { ...previous, ...next });
  for (let i = 0; i < entries.length; i++) {
    const [relative, link] = entries[i],
      dest = path.resolve(p.library, relative);
    if (!inside(p.library, dest)) throw Error('快捷方式路径无效');
    if (
      recovering ||
      previous[relative]?.target !== link.target ||
      !fs.existsSync(dest)
    ) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (
        !inside(fs.realpathSync(p.library), fs.realpathSync(path.dirname(dest)))
      )
        throw Error('Library 子目录指向了外部位置');
      if (fs.existsSync(dest) && !previous[relative])
        throw Error(`存在未登记的同名快捷方式：${relative}`);
      if (!writeShortcut(dest, link.target))
        throw Error(`创建快捷方式失败：${relative}`);
      written++;
    }
    if (i % 100 === 0) {
      progress({ done: i, total: entries.length });
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  for (const relative of Object.keys(previous))
    if (!next[relative]) {
      const dest = path.resolve(p.library, relative);
      if (
        !inside(p.library, dest) ||
        path.extname(dest).toLowerCase() !== '.lnk'
      )
        throw Error('旧快捷方式登记无效');
      if (fs.existsSync(dest)) {
        if (
          !inside(
            fs.realpathSync(p.library),
            fs.realpathSync(path.dirname(dest)),
          )
        )
          throw Error('旧快捷方式目录指向了外部位置');
        fs.unlinkSync(dest);
        removed++;
      }
    }
  const removedDirectories = pruneEmptyDirectories(p.library);
  atomicJSON(file, next);
  fs.unlinkSync(journal);
  progress({ done: entries.length, total: entries.length });
  return { total: entries.length, written, removed, removedDirectories };
}
module.exports = {
  safe,
  names,
  desiredLinks,
  syncLinks,
  pruneEmptyDirectories,
};
