'use strict';
const { isDeepStrictEqual: equal } = require('util');
const PHOTO_FIELDS = [
  'year',
  'yearStatus',
  'yearSource',
  'location',
  'themeId',
  'tagIds',
  'status',
  'needsRecheck',
  'confirmedAt',
];
const LIBRARY_FIELDS = ['themes', 'tags', 'reviewedGroups'];
const LIMIT = 20,
  MAX_BYTES = 8 * 1024 * 1024;
function value(object, key) {
  return Object.hasOwn(object, key) && object[key] !== undefined
    ? { present: true, value: structuredClone(object[key]) }
    : { present: false };
}
function diff(before, after, fields) {
  return fields.flatMap((key) => {
    const a = value(before, key),
      b = value(after, key);
    return equal(a, b) ? [] : [{ key, before: a, after: b }];
  });
}
function record(before, after, label) {
  const old = new Map(before.photos.map((p) => [p.id, p]));
  if (
    old.size !== after.photos.length ||
    after.photos.some((p) => !old.has(p.id))
  )
    throw Error('该操作改变了文件记录，不能记录为可撤销操作');
  const photos = after.photos.flatMap((p) => {
    const fields = diff(old.get(p.id), p, PHOTO_FIELDS);
    return fields.length ? [{ id: p.id, fields }] : [];
  });
  const fields = diff(before, after, LIBRARY_FIELDS);
  if (!photos.length && !fields.length) return;
  const entry = { label, at: new Date().toISOString(), photos, fields };
  const history = [...(after.undoHistory || []), entry].slice(-LIMIT);
  const bytes = history.map((item) => Buffer.byteLength(JSON.stringify(item)));
  let total = bytes.reduce((sum, size) => sum + size, 0);
  while (history.length > 1 && total > MAX_BYTES) {
    history.shift();
    total -= bytes.shift();
  }
  after.undoHistory = history;
  delete after.undoResetReason;
}
function info(data) {
  const entry = data.undoHistory?.at(-1);
  return {
    available: !!entry,
    label: entry?.label || '',
    steps: data.undoHistory?.length || 0,
    reason: data.undoResetReason || '没有可撤销的操作',
  };
}
function restore(data) {
  const entry = data.undoHistory?.at(-1);
  if (!entry) throw Error(info(data).reason);
  const next = structuredClone(data),
    photos = new Map(next.photos.map((p) => [p.id, p]));
  function apply(object, fields, allowed) {
    for (const change of fields) {
      if (
        !allowed.includes(change.key) ||
        !equal(value(object, change.key), change.after)
      )
        throw Error('相关信息已变化，无法安全撤销；没有修改照片库');
      if (change.before.present)
        object[change.key] = structuredClone(change.before.value);
      else delete object[change.key];
    }
  }
  apply(next, entry.fields, LIBRARY_FIELDS);
  for (const change of entry.photos) {
    const p = photos.get(change.id);
    if (!p) throw Error('相关照片记录已变化，无法安全撤销；没有修改照片库');
    apply(p, change.fields, PHOTO_FIELDS);
    p.updatedAt = new Date().toISOString();
  }
  next.undoHistory.pop();
  return { data: next, label: entry.label, photos: entry.photos.length };
}
module.exports = { record, info, restore, LIMIT };
