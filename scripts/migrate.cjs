'use strict';
const fs = require('fs'),
  path = require('path');
const {
  blankLibrary,
  atomicJSON,
  signature,
  inside,
} = require('../desktop/store.cjs');
const { countryName, nearest } = require('../desktop/location.cjs');
function isTheme(name) {
  return /专题$/.test(name) || /^(?:19|20)\d{2}年?.+行$/.test(name);
}
function migrate(catalog, locationExports, photosRoot, assets, options = {}) {
  const timeZone =
      options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    yearFormatter = new Intl.DateTimeFormat('en', {
      year: 'numeric',
      timeZone,
    });
  const settings =
    catalog.stores.settings.find((x) => x.key === 'settings')?.value || {};
  const defs =
    settings.aiProvider?.customCategories || settings.customCategories || [];
  const data = blankLibrary(),
    byId = new Map(defs.map((x) => [x.id, x]));
  for (const def of defs)
    data[isTheme(def.name) ? 'themes' : 'tags'].push({
      id: def.id,
      name: def.name,
    });
  const themes = new Set(data.themes.map((x) => x.id)),
    locations = new Map();
  // Current development origin takes precedence over older app origins.
  for (const origin of locationExports.slice().reverse())
    for (const row of origin.stores.location_details || [])
      locations.set(row.location_id, row);
  const conflicts = [],
    missing = [],
    inferredCountries = [];
  for (const old of catalog.stores.images) {
    let ids;
    try {
      ids = JSON.parse(old.categories || '[]');
    } catch {
      ids = [];
    }
    if (!Array.isArray(ids)) ids = [];
    if (!ids.length && old.category) ids = [old.category];
    ids = [...new Set(ids)].filter((id) => !['NA', 'NA_video'].includes(id));
    for (const id of ids) if (!byId.has(id)) throw Error(`分类定义缺失：${id}`);
    const topicIds = ids.filter((id) => themes.has(id));
    if (topicIds.length > 1)
      conflicts.push({ imageId: old.id, themeIds: topicIds });
    let relativePath = old.libraryRelativePath;
    if (!relativePath && old.uri?.startsWith('photos://'))
      relativePath = old.uri.slice(9);
    if (!relativePath) {
      if (!options.legacyPhotosRoot || !path.isAbsolute(old.uri || ''))
        throw Error('旧记录使用绝对路径时，需要 --old-photos 指定旧照片根目录');
      if (!inside(options.legacyPhotosRoot, old.uri))
        throw Error('旧照片路径超出指定的旧原图目录');
      relativePath = path.relative(options.legacyPhotosRoot, old.uri);
    }
    const file = path.join(photosRoot, relativePath);
    if (!inside(photosRoot, file)) throw Error('旧照片路径超出原图目录');
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      missing.push(old.id);
    }
    const date = old.takenAt ? new Date(old.takenAt) : null,
      year =
        date && !Number.isNaN(date.getTime())
          ? Number(yearFormatter.format(date))
          : null;
    const detail = locations.get(old.city),
      city =
        detail?.admin2_zh ||
        detail?.admin2_en ||
        old.city?.split('_').slice(2).join('_') ||
        null;
    let country = countryName(detail?.country_code);
    const gps =
      Number.isFinite(old.latitude) && Number.isFinite(old.longitude)
        ? { latitude: old.latitude, longitude: old.longitude }
        : null;
    let countrySource = 'legacy';
    if (!country && gps) {
      const inferred = nearest(gps.latitude, gps.longitude, assets);
      if (inferred) {
        country = inferred.country;
        countrySource = 'gps-estimate';
        inferredCountries.push(old.id);
      }
    }
    data.photos.push({
      id: old.id,
      relativePath: relativePath.replace(/\\/g, '/'),
      fileName: old.fileName || path.basename(file),
      status: 'pending',
      year,
      yearStatus: year ? 'known' : 'pending',
      yearSource: 'legacy',
      originalTakenAt: old.takenAt || null,
      location: {
        country,
        city,
        gps,
        status: country && city ? 'known' : 'pending',
        source: 'legacy',
        countrySource,
      },
      themeId: topicIds[0] || null,
      tagIds: ids.filter((id) => !themes.has(id)),
      size: stat?.size || old.size,
      width: old.width,
      height: old.height,
      fileSignature: stat ? signature(stat) : null,
      missing: !stat,
      needsRecheck: true,
      legacy: {
        categoryIds: ids,
        locationId: old.city || null,
        takenAt: old.takenAt || null,
      },
      addedAt: old.createdAt || new Date().toISOString(),
    });
  }
  if (conflicts.length)
    throw Error(`有 ${conflicts.length} 张照片关联多个主题，尚未写入新数据`);
  return {
    data,
    report: {
      photos: data.photos.length,
      themes: data.themes.length,
      tags: data.tags.length,
      missing,
      inferredCountries: inferredCountries.length,
      timeZone,
      assignments: defs.map((x) => ({
        id: x.id,
        name: x.name,
        dimension: isTheme(x.name) ? '主题' : '标签',
      })),
    },
  };
}
if (require.main === module) {
  const { values, positionals } = require('node:util').parseArgs({
    allowPositionals: true,
    options: {
      'old-photos': { type: 'string' },
      'time-zone': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const usage =
    'node scripts/migrate.cjs <备份目录> <新项目目录> [--old-photos <旧照片根目录>] [--time-zone <时区>]';
  if (values.help) {
    console.log(usage);
    process.exit(0);
  }
  const [backup, project] = positionals;
  if (!backup || !project || positionals.length !== 2) throw Error(usage);
  const file = path.join(project, 'data/library-v2.json');
  if (fs.existsSync(file)) throw Error('新照片库已经存在，拒绝覆盖');
  const catalog = JSON.parse(
    fs.readFileSync(path.join(backup, 'data-backup/catalog.json'), 'utf8'),
  );
  const exports = JSON.parse(
    fs.readFileSync(path.join(backup, 'location-export.json'), 'utf8'),
  );
  const result = migrate(
    catalog,
    exports,
    path.join(project, '../Photos'),
    path.join(project, 'assets'),
    { legacyPhotosRoot: values['old-photos'], timeZone: values['time-zone'] },
  );
  if (result.report.missing.length)
    throw Error(`复制尚未完成：${result.report.missing.length} 个文件缺失`);
  fs.mkdirSync(path.join(project, 'data/legacy'), { recursive: true });
  for (const name of ['catalog.json', 'library.json', 'shortcuts.json'])
    fs.copyFileSync(
      path.join(backup, 'data-backup', name),
      path.join(project, 'data/legacy', name),
    );
  fs.copyFileSync(
    path.join(backup, 'location-export.json'),
    path.join(project, 'data/legacy/location-export.json'),
  );
  atomicJSON(file, result.data);
  atomicJSON(path.join(project, 'data/migration-report.json'), result.report);
  console.log(JSON.stringify(result.report));
}
module.exports = { isTheme, migrate };
