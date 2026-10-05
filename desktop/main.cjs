'use strict';
const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  shell,
  dialog,
} = require('electron');
const fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');
const { Worker } = require('worker_threads');
const {
  roots,
  openStore,
  scan,
  photoPath,
  signature,
  candidateGroups,
  completeImport,
  updatePhotos,
  atomicJSON,
} = require('./store.cjs');
const { syncLinks } = require('./shortcuts.cjs');
const project = process.env.PHOTOATLAS_PROJECT || path.resolve(__dirname, '..'),
  paths = roots(project);
app.setName('PhotoAtlas');
app.setPath('userData', path.join(paths.data, 'browser'));
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'photoatlas',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
let win,
  store,
  worker = null,
  mutation = Promise.resolve(),
  lastProgress = null;
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
const confirmations = {
  delete: (options) => dialog.showMessageBox(win, options),
};
function emit(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}
function state() {
  const groups = candidateGroups(store.data);
  return {
    version: 2,
    paths: { photos: paths.photos, library: paths.library },
    themes: store.data.themes,
    tags: store.data.tags,
    groups,
    analysis: store.data.analysis,
    undo: store.undoInfo(),
    progress: lastProgress,
    photos: store.data.photos.map((p) => ({
      id: p.id,
      fileName: p.fileName,
      relativePath: p.relativePath,
      status: p.status,
      year: p.year,
      yearStatus: p.yearStatus,
      location: p.location,
      themeId: p.themeId,
      tagIds: p.tagIds,
      size: p.size,
      width: p.fingerprint?.width || p.width,
      height: p.fingerprint?.height || p.height,
      missing: p.missing,
      readError: p.readError,
      ready: !!p.fingerprint && p.fingerprint.signature === p.fileSignature,
      needsRecheck: p.needsRecheck,
    })),
  };
}
function publish() {
  emit('atlas:state', state());
}
function enqueue(task) {
  const next = mutation.then(task);
  mutation = next.catch(() => {});
  return next;
}
async function sync() {
  const result = await syncLinks(
    store,
    (dest, target) =>
      shell.writeShortcutLink(dest, 'create', {
        target,
        workingDirectory: path.dirname(target),
        description: 'PhotoAtlas 照片快捷方式',
      }),
    (p) => emit('atlas:sync', p),
  );
  store.data.lastSync = { ...result, at: new Date().toISOString() };
  store.save();
  return result;
}
function ensureIdle() {
  if (worker) throw Error('正在分析，请等待完成后执行此操作');
}
function analyze() {
  ensureIdle();
  scan(store);
  const photos = store.data.photos.filter((p) => !p.missing);
  let initialEdges = store.data.analysis?.edges || [];
  try {
    const checkpoint = JSON.parse(
      fs.readFileSync(
        path.join(paths.data, 'analysis-checkpoint.json'),
        'utf8',
      ),
    );
    initialEdges = checkpoint.edges || initialEdges;
  } catch {}
  store.data.analysis = {
    status: 'running',
    startedAt: new Date().toISOString(),
    edges: initialEdges,
  };
  store.save();
  worker = new Worker(path.join(__dirname, 'analysis-worker.cjs'), {
    workerData: { photos, paths, initialEdges },
  });
  let changed = 0,
    finished = false;
  const interrupt = (error) => {
    if (finished) return;
    finished = true;
    if (worker) worker.terminate();
    worker = null;
    lastProgress = null;
    store.data.analysis.status = 'interrupted';
    store.data.analysis.error = error.message;
    try {
      store.save();
    } catch (saveError) {
      store.data.analysis.error += `；保存失败：${saveError.message}`;
    }
    console.error(store.data.analysis.error);
    publish();
  };
  worker.on('message', (message) => {
    try {
      if (message.type === 'photo') {
        const p = store.data.photos.find((p) => p.id === message.id);
        if (!p) return;
        p.fingerprint = message.fingerprint;
        delete p.forceRehash;
        p.fileSignature = message.fingerprint.signature;
        p.readError = null;
        const meta = message.extracted;
        if (meta) {
          if (
            !p.year &&
            p.yearStatus !== 'unknown' &&
            p.yearSource !== 'manual' &&
            meta.year
          ) {
            p.year = meta.year;
            p.yearStatus = 'known';
            p.yearSource = 'exif';
            p.originalTakenAt = meta.takenAt;
          }
          if (meta.gps && !p.location?.gps) {
            p.location ||= {};
            p.location.gps = meta.gps;
          }
          if (
            p.location?.source !== 'manual' &&
            !p.location?.city &&
            meta.location
          )
            p.location = { ...p.location, ...meta.location };
        }
        if (++changed % 100 === 0) store.save();
      } else if (message.type === 'error-photo') {
        const p = store.data.photos.find((p) => p.id === message.id);
        if (p) p.readError = message.message;
      } else if (message.type === 'progress') {
        lastProgress = message;
        emit('atlas:progress', message);
      } else if (message.type === 'complete') {
        finished = true;
        store.data.analysis = {
          ...message,
          type: undefined,
          status: 'complete',
        };
        store.save();
        worker = null;
        lastProgress = null;
        publish();
      } else if (message.type === 'fatal') {
        interrupt(Error(message.message));
      }
    } catch (error) {
      finished = false;
      interrupt(error);
    }
  });
  worker.on('error', interrupt);
  worker.on('exit', () => {
    if (!finished && store.data.analysis?.status === 'running') {
      interrupt(Error('后台分析已中断，可以重新启动并继续'));
    }
  });
  return { started: true };
}
async function deletePhotos(ids, mergeIntoId) {
  ensureIdle();
  const selected = new Set(ids),
    photos = store.data.photos.filter((p) => selected.has(p.id));
  if (photos.length !== selected.size || !photos.length)
    throw Error('照片选择无效');
  let target = mergeIntoId
    ? store.data.photos.find((x) => x.id === mergeIntoId)
    : null;
  if (mergeIntoId && (!target || selected.has(target.id)))
    throw Error('保留照片无效');
  const conflictingTheme =
    target &&
    new Set([target.themeId, ...photos.map((x) => x.themeId)].filter(Boolean))
      .size > 1;
  const answer = await confirmations.delete({
    type: 'warning',
    title: '删除照片',
    message: `确认永久删除 ${photos.filter((x) => !x.missing).length} 张原文件${photos.some((x) => x.missing) ? '，并移除缺失记录' : ''}？`,
    detail:
      '永久删除原文件无法通过“撤销操作”恢复。' +
      (conflictingTheme
        ? '照片有不同主题，本次只能删除，保留照片的信息不变。'
        : target
          ? '可合并所选照片的标签及可补充的信息到保留照片，或仅删除。'
          : '删除成功后会清理对应记录和快捷方式。'),
    buttons:
      target && !conflictingTheme
        ? ['取消', '合并信息并删除', '仅删除']
        : ['取消', '确认删除'],
    defaultId: 0,
    cancelId: 0,
  });
  if (![1, 2].includes(answer.response)) return { cancelled: true };
  if (conflictingTheme || answer.response === 2) target = null;
  if (!fs.existsSync(paths.photos)) throw Error('原图目录无法访问，操作已停止');
  const removed = [],
    errors = [];
  const journal = path.join(paths.data, 'deletion-history.ndjson');
  for (const p of photos) {
    try {
      const file = photoPath(paths, p),
        operation = crypto.randomUUID();
      // If history cannot be recorded, do not delete the file. An interrupted
      // intent can be reconciled against Photos rather than silently losing data.
      fs.appendFileSync(
        journal,
        JSON.stringify({
          operation,
          state: 'intent',
          at: new Date().toISOString(),
          photo: p,
          mergedInto: target?.id || null,
        }) + '\n',
      );
      if (fs.existsSync(file)) fs.unlinkSync(file);
      else if (!p.missing) throw Error('文件已变化，请先扫描');
      if (target) {
        target.tagIds = [
          ...new Set([...(target.tagIds || []), ...(p.tagIds || [])]),
        ];
        if (!target.themeId) target.themeId = p.themeId;
        if (!target.year && p.year) {
          target.year = p.year;
          target.yearStatus = p.yearStatus;
          target.yearSource = p.yearSource;
        }
        if (!target.location?.city && p.location?.city)
          target.location = { ...p.location };
      }
      removed.push(p.id);
      try {
        fs.appendFileSync(
          journal,
          JSON.stringify({
            operation,
            state: 'deleted',
            at: new Date().toISOString(),
            id: p.id,
          }) + '\n',
        );
      } catch (error) {
        errors.push({
          id: p.id,
          message: `文件已删除，但完成日志写入失败：${error.message}`,
        });
      }
    } catch (error) {
      errors.push({ id: p.id, message: error.message });
    }
  }
  store.data.photos = store.data.photos.filter((p) => !removed.includes(p.id));
  if (removed.length)
    store.clearUndo('永久删除照片后无法撤销；之前的操作历史已结束');
  store.save();
  await sync();
  publish();
  return { removed: removed.length, errors };
}
function register(name, handler) {
  ipcMain.handle(`atlas:${name}`, async (event, ...args) => {
    if (
      !win ||
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame
    )
      throw Error('不允许的请求');
    try {
      return await handler(...args);
    } catch (error) {
      publish();
      throw error;
    }
  });
}
const ready = app
  .whenReady()
  .then(async () => {
    store = openStore(paths);
    if (store.data.analysis?.status === 'running') {
      store.data.analysis.status = 'interrupted';
      store.save();
    }
    // Reading into a buffer releases the Windows file handle before the viewer
    // receives the image; Chromium must not prevent later manual deletion.
    protocol.handle('photoatlas', async (request) => {
      try {
        const url = new URL(request.url),
          id = decodeURIComponent(url.pathname.slice(1)),
          p = store.data.photos.find((x) => x.id === id);
        if (!p) throw Error('Missing');
        const file =
          url.hostname === 'thumb'
            ? path.join(
                paths.data,
                'thumbnails',
                `${crypto.createHash('sha256').update(id).digest('hex')}.webp`,
              )
            : photoPath(paths, p);
        if (!['thumb', 'original'].includes(url.hostname))
          throw Error('Invalid');
        const ext = path.extname(file).toLowerCase(),
          mime =
            {
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.png': 'image/png',
              '.webp': 'image/webp',
              '.gif': 'image/gif',
              '.avif': 'image/avif',
              '.bmp': 'image/bmp',
            }[ext] || 'application/octet-stream';
        const buffer = await fs.promises.readFile(file);
        return new Response(buffer, {
          headers: { 'Content-Type': mime, 'Cache-Control': 'no-store' },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    win = new BrowserWindow({
      width: 1400,
      height: 960,
      minWidth: 900,
      minHeight: 650,
      title: 'PhotoAtlas',
      icon: path.join(__dirname, 'icon.ico'),
      show: !process.env.PHOTOATLAS_TEST_MODE,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => {
      if (
        url !==
        require('url').pathToFileURL(path.join(__dirname, 'index.html')).href
      )
        event.preventDefault();
    });
    register('state', () => state());
    register('scan', () =>
      enqueue(() => {
        ensureIdle();
        const result = scan(store);
        publish();
        return result;
      }),
    );
    register('analyze', () =>
      enqueue(() => {
        const result = analyze();
        publish();
        return result;
      }),
    );
    register('review-group', (id, confirm = false) =>
      enqueue(async () => {
        ensureIdle();
        const group = candidateGroups(store.data).find((x) => x.id === id);
        if (!group) throw Error('候选组已变化');
        for (const photo of store.data.photos.filter((p) =>
          group.photoIds.includes(p.id),
        )) {
          if (
            photo.readError ||
            photo.fingerprint?.signature !==
              signature(fs.statSync(photoPath(paths, photo)))
          )
            throw Error('组内照片已变化或未完成检查，请重新分析');
        }
        store.transaction('确认候选组', () => {
          store.data.reviewedGroups[id] = {
            at: new Date().toISOString(),
            photoIds: group.photoIds,
          };
          for (const photo of store.data.photos.filter(
            (p) => p.status === 'library' && group.photoIds.includes(p.id),
          ))
            photo.needsRecheck = false;
          if (confirm) {
            const ids = group.photoIds.filter((id) =>
              store.data.photos.some(
                (p) => p.id === id && p.status === 'pending',
              ),
            );
            if (ids.length) completeImport(store, ids);
          }
        });
        await sync();
        publish();
        return true;
      }),
    );
    register('confirm', (ids) =>
      enqueue(async () => {
        ensureIdle();
        const count = store.transaction('确认照片入库', () =>
          completeImport(store, ids),
        );
        await sync();
        publish();
        return count;
      }),
    );
    register('update', (ids, patch) =>
      enqueue(async () => {
        ensureIdle();
        if (
          store.data.photos.some(
            (p) => ids.includes(p.id) && p.status !== 'library',
          )
        )
          throw Error('请先确认照片入库，再修改四维信息');
        const count = store.transaction('修改照片信息', () =>
          updatePhotos(store, ids, patch),
        );
        await sync();
        publish();
        return count;
      }),
    );
    register('definition', (kind, action, id, name) =>
      enqueue(async () => {
        ensureIdle();
        if (!['themes', 'tags'].includes(kind)) throw Error('类型无效');
        const labels = { create: '新建', rename: '改名', delete: '删除' };
        store.transaction(
          `${labels[action] || ''}${kind === 'themes' ? '主题' : '标签'}`,
          () => {
            const defs = store.data[kind];
            if (action === 'create' || action === 'rename') {
              name = String(name || '')
                .trim()
                .replace(/^#+/, '')
                .trim();
              if (!name || name.length > 120) throw Error('名称不能为空或过长');
              if (
                defs.some(
                  (x) =>
                    x.id !== id && x.name.toLowerCase() === name.toLowerCase(),
                )
              )
                throw Error('名称已存在');
              if (action === 'create') {
                id = `${kind}_${crypto.randomUUID()}`;
                defs.push({ id, name });
              } else {
                const def = defs.find((x) => x.id === id);
                if (!def) throw Error('项目不存在');
                def.name = name;
              }
            } else if (action === 'delete') {
              store.data[kind] = defs.filter((x) => x.id !== id);
              for (const p of store.data.photos) {
                if (kind === 'themes' && p.themeId === id) p.themeId = null;
                if (kind === 'tags')
                  p.tagIds = p.tagIds.filter((x) => x !== id);
              }
            } else throw Error('操作无效');
          },
        );
        await sync();
        publish();
        return id;
      }),
    );
    register('delete', (ids, target) =>
      enqueue(() => deletePhotos(ids, target)),
    );
    register('undo', () =>
      enqueue(async () => {
        ensureIdle();
        const result = store.undo();
        await sync();
        publish();
        return result;
      }),
    );
    register('sync', () =>
      enqueue(async () => {
        const result = await sync();
        publish();
        return result;
      }),
    );
    register('open', (id) => {
      const p = store.data.photos.find((x) => x.id === id);
      if (!p) throw Error('照片不存在');
      return shell.openPath(photoPath(paths, p));
    });
    register('open-library', () => shell.openPath(paths.library));
    register('relink', (id) =>
      enqueue(async () => {
        ensureIdle();
        const p = store.data.photos.find((x) => x.id === id);
        if (!p) throw Error('照片不存在');
        const choice = await dialog.showOpenDialog(win, {
          defaultPath: paths.photos,
          properties: ['openFile'],
        });
        if (choice.canceled) return false;
        const next = path
          .relative(paths.photos, choice.filePaths[0])
          .split(path.sep)
          .join('/');
        const candidate = { ...p, relativePath: next };
        photoPath(paths, candidate);
        const duplicate = store.data.photos.find(
          (x) =>
            x.id !== id && x.relativePath.toLowerCase() === next.toLowerCase(),
        );
        if (
          duplicate &&
          (duplicate.status !== 'pending' ||
            duplicate.legacy ||
            duplicate.themeId ||
            duplicate.tagIds.length ||
            duplicate.yearSource === 'manual' ||
            duplicate.location?.source === 'manual')
        )
          throw Error('该文件已属于其他已管理的照片记录');
        const stat = fs.statSync(photoPath(paths, candidate));
        if (duplicate)
          store.data.photos = store.data.photos.filter(
            (x) => x.id !== duplicate.id,
          );
        p.relativePath = next;
        p.fileName = path.basename(next);
        p.missing = false;
        p.fileSignature = signature(stat);
        p.fingerprint = null;
        p.readError = null;
        p.forceRehash = true;
        p.needsRecheck = true;
        store.clearUndo('重新定位照片后，之前的操作历史已结束');
        store.save();
        await sync();
        publish();
        return true;
      }),
    );
    await win.loadFile(path.join(__dirname, 'index.html'));
    win.on('close', () => {
      store.save();
    });
  })
  .catch((error) => {
    console.error(error.stack || error.message);
    if (process.env.PHOTOATLAS_TEST_MODE) {
      app.exit(1);
      return;
    }
    dialog.showErrorBox('PhotoAtlas 启动失败', error.message);
    app.quit();
  });
app.on('window-all-closed', () => {
  if (worker) worker.terminate();
  app.quit();
});
module.exports = {
  confirmations,
  ready,
  getState: state,
  startAnalysis: () => enqueue(() => analyze()),
  syncLibrary: () => enqueue(() => sync()),
};
