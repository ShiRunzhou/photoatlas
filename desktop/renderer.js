'use strict';
const api = window.atlas,
  $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
let data,
  view = 'pending',
  filter = null,
  page = 0,
  query = '',
  selected = new Set(),
  busy = false,
  viewerIds = [],
  viewerId = null,
  zoom = 1,
  pan = { x: 0, y: 0 },
  drag = null,
  selectionGesture = null,
  unbindSelection = null,
  editorAction = null;
const PAGE = 100;
function notice(message) {
  $('notice').textContent = message;
}
async function action(task, message) {
  if (busy) return;
  busy = true;
  render();
  try {
    const result = await task();
    if (message)
      notice(typeof message === 'function' ? message(result) : message);
    return result;
  } catch (error) {
    notice(
      error.message.replace(
        /^Error invoking remote method '[^']+': Error: /,
        '',
      ),
    );
  } finally {
    busy = false;
    data = await api.state();
    selected = new Set(
      [...selected].filter((id) => data.photos.some((x) => x.id === id)),
    );
    render();
    refreshViewer();
  }
}
function nav(next, value = null) {
  view = next;
  filter = value;
  page = 0;
  query = '';
  selected.clear();
  render();
}
function photo(id) {
  return data.photos.find((x) => x.id === id);
}
function definitions(kind) {
  return new Map(data[kind].map((x) => [x.id, x.name]));
}
function place(p) {
  if (p.location?.status === 'unknown') return '地点无法确定';
  return `${p.location?.country || '国家待补充'} · ${p.location?.city || '城市待补充'}`;
}
function locationKey(p) {
  if (p.location?.status === 'unknown') return 'unknown';
  if (!p.location?.country) return 'pending';
  return JSON.stringify([p.location.country, p.location.city || '待补充']);
}
function needsLocation(p) {
  return (
    p.location?.status !== 'unknown' &&
    (!p.location?.country || !p.location?.city)
  );
}
function locationLabel(key) {
  if (key === 'unknown') return '地点无法确定';
  if (key === 'pending') return '地点待补充';
  return JSON.parse(key).join(' / ');
}
function year(p) {
  return p.year
    ? `${p.year}年`
    : p.yearStatus === 'unknown'
      ? '年份无法确定'
      : '年份待补充';
}
function groups() {
  return data.groups.filter((g) =>
    g.photoIds.some(
      (id) => photo(id)?.status === 'pending' || photo(id)?.needsRecheck,
    ),
  );
}
function filtered() {
  let rows = data.photos;
  if (view === 'pending') rows = rows.filter((p) => p.status === 'pending');
  else if (view === 'groups')
    rows = filter
      ? rows.filter((p) =>
          data.groups.find((g) => g.id === filter)?.photoIds.includes(p.id),
        )
      : [];
  else if (view === 'missing')
    rows = rows.filter((p) => p.missing || p.readError);
  else {
    rows = rows.filter((p) => p.status === 'library');
    if (filter !== null) {
      if (view === 'year')
        rows = rows.filter(
          (p) =>
            (p.year
              ? String(p.year)
              : p.yearStatus === 'unknown'
                ? 'unknown'
                : 'pending') === filter,
        );
      if (view === 'location')
        rows = rows.filter((p) =>
          filter === 'pending' ? needsLocation(p) : locationKey(p) === filter,
        );
      if (view === 'theme')
        rows = rows.filter((p) => (p.themeId || 'none') === filter);
      if (view === 'tag')
        rows = rows.filter((p) =>
          filter === 'none' ? !p.tagIds.length : p.tagIds.includes(filter),
        );
    }
  }
  if (query)
    rows = rows.filter((p) =>
      `${p.fileName} ${year(p)} ${place(p)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  return rows
    .slice()
    .sort(
      (a, b) =>
        (b.year || 0) - (a.year || 0) ||
        a.fileName.localeCompare(b.fileName, 'zh-CN'),
    );
}
function render() {
  if (!data) return;
  const pending = data.photos.filter((x) => x.status === 'pending').length,
    library = data.photos.filter((x) => x.status === 'library').length;
  const labels = {
    pending: `待导入 · ${pending}`,
    groups: `版本候选组 · ${groups().filter((x) => !x.reviewed).length}`,
    all: `全部已入库 · ${library}`,
    year: '按年份',
    location: '按地点',
    theme: '按主题',
    tag: '按标签',
    missing: `文件问题 · ${data.photos.filter((x) => x.missing || x.readError).length}`,
  };
  $('sidebar').innerHTML =
    `<h3>导入与检查</h3>${['pending', 'groups'].map((v) => `<button data-nav="${v}" class="${view === v ? 'active' : ''}">${labels[v]}</button>`).join('')}<h3>正式照片库</h3>${['all', 'year', 'location', 'theme', 'tag'].map((v) => `<button data-nav="${v}" class="${view === v ? 'active' : ''}">${labels[v]}</button>`).join('')}<h3>管理</h3><button id="manage-definitions">管理主题与标签</button><button data-nav="missing" class="${view === 'missing' ? 'active' : ''}">${labels.missing}</button><div class="path">原图：${escape(data.paths.photos)}<br><br>快捷方式：${escape(data.paths.library)}</div>`;
  $('sidebar')
    .querySelectorAll('[data-nav]')
    .forEach((el) => (el.onclick = () => nav(el.dataset.nav)));
  $('manage-definitions').onclick = showManager;
  $('analyze')?.remove();
  const title = filter !== null ? filterLabel() : labels[view];
  const running = data.analysis?.status === 'running';
  $('toolbar').innerHTML =
    `${filter !== null ? '<button id="back">返回</button>' : ''}<h1>${escape(title)}</h1>${view === 'pending' ? `<button id="analyze" class="primary" ${busy || running ? 'disabled' : ''}>${data.analysis?.status === 'interrupted' ? '继续本机比对' : '本机版本比对'}</button><button id="confirm-ready" ${busy || running || data.analysis?.status !== 'complete' ? 'disabled' : ''}>确认已检查且无待处理候选的照片</button>` : ''}${view === 'groups' && filter ? `<button id="review" class="primary" ${busy || running ? 'disabled' : ''}>保留剩余照片并确认入库</button>` : ''}<input id="search" type="search" placeholder="搜索文件名、年份或地点" value="${escape(query)}">`;
  $('back') && ($('back').onclick = () => nav(view));
  $('search').oninput = (event) => {
    query = event.target.value;
    page = 0;
    renderContent();
  };
  $('analyze') &&
    ($('analyze').onclick = () =>
      action(
        () => api.analyze(),
        '正在后台生成图像指纹并比对，可继续浏览；退出后可以继续。',
      ));
  $('confirm-ready') &&
    ($('confirm-ready').onclick = () => {
      const unresolved = new Set(
        groups()
          .filter((g) => !g.reviewed)
          .flatMap((g) => g.photoIds),
      );
      const ids = data.photos
        .filter(
          (p) =>
            p.status === 'pending' &&
            p.ready &&
            !p.readError &&
            !p.missing &&
            !unresolved.has(p.id),
        )
        .map((p) => p.id);
      if (!ids.length) {
        notice('没有可确认的照片，请先处理候选组或文件问题。');
        return;
      }
      action(
        () => api.confirm(ids),
        (n) => `已确认 ${n} 张照片入库。`,
      );
    });
  $('review') &&
    ($('review').onclick = () =>
      action(async () => {
        const group = data.groups.find((x) => x.id === filter);
        if (!group) return;
        await api['review-group'](group.id, true);
        nav('groups');
      }, '已确认保留候选组中的剩余照片。'));
  $('scan').disabled = busy || running;
  $('sync').disabled = busy;
  $('undo').disabled = busy || running || !data.undo?.available;
  $('undo').title = data.undo?.available
    ? `Ctrl+Z：撤销“${data.undo.label}”（剩余 ${data.undo.steps} 步）`
    : data.undo?.reason || '没有可撤销的操作';
  renderContent();
  showProgress(data.progress);
}
function filterLabel() {
  if (view === 'year')
    return filter === 'pending'
      ? '时间待补充'
      : filter === 'unknown'
        ? '年份无法确定'
        : `${filter}年`;
  if (view === 'location') return locationLabel(filter);
  if (view === 'theme') return definitions('themes').get(filter) || '无主题';
  if (view === 'tag') return definitions('tags').get(filter) || '无标签';
  if (view === 'groups')
    return `候选组 · ${data.groups.find((x) => x.id === filter)?.count || 0} 张`;
  return '';
}
function photoCard(p, themes, tags) {
  const issue = p.missing
    ? `<div class="error">文件缺失 <button data-relink="${escape(p.id)}">重新定位</button></div>`
    : p.readError
      ? `<div class="error">${escape(p.readError)}</div>`
      : !p.ready
        ? '<div>尚未完成检查</div>'
        : '';
  return `<article class="card ${selected.has(p.id) ? 'selected' : ''}" data-photo="${escape(p.id)}">
    <label class="choose"><input type="checkbox" data-select="${escape(p.id)}" ${selected.has(p.id) ? 'checked' : ''}>选择照片</label>
    <button class="image-button" data-view="${escape(p.id)}"><img loading="lazy" decoding="async" draggable="false" src="photoatlas://thumb/${encodeURIComponent(p.id)}" alt="${escape(p.fileName)}"></button>
    <div class="filename" title="${escape(p.fileName)}">${escape(p.fileName)}</div>
    <div class="meta">${p.width && p.height ? `${p.width} × ${p.height} · ` : ''}${((p.size || 0) / 1024 ** 2).toFixed(2)} MB<br>
    ${escape(year(p))} · ${escape(place(p))}<br>${escape(themes.get(p.themeId) || '无主题')}<br>${escape(p.tagIds.map((id) => '#' + (tags.get(id) || id)).join(' '))}${issue}</div>
  </article>`;
}
function renderContent() {
  selectionGesture?.();
  unbindSelection?.();
  unbindSelection = null;
  $('photo-actions').innerHTML = '';
  if (['year', 'location', 'theme', 'tag'].includes(view) && filter === null) {
    renderBuckets();
    return;
  }
  let prefix = '';
  if (view === 'pending')
    prefix =
      '<p class="explanation">照片保留在原图目录。先执行本机版本比对，处理候选并确认后进入正式照片库。</p>';
  if (view === 'groups') {
    const gs = groups(),
      start = page * 20,
      shown = filter
        ? gs.filter((g) => g.id === filter)
        : gs.slice(start, start + 20);
    prefix =
      '<p class="explanation">这些是疑似同一照片的版本候选。通过候选关系相连的照片合并成组，组内可以保留多张。点击大图核对后，可多选删除，再确认剩余照片。</p>';
    prefix += `<div class="groups">${shown.map((g) => `<button data-group="${g.id}" class="${filter === g.id ? 'active' : ''}">${g.count} 张${g.reviewed ? ' · 已确认' : ''} · ${escape(photo(g.photoIds[0])?.fileName)}</button>`).join('')}</div>`;
    if (!filter) {
      $('photo-actions').innerHTML = '<div id="pagination-top"></div>';
      $('content').innerHTML =
        prefix +
        (gs.length ? '' : '<div class="empty">没有待处理的候选组。</div>');
      $('content')
        .querySelectorAll('[data-group]')
        .forEach((el) => (el.onclick = () => nav('groups', el.dataset.group)));
      pagination(gs.length, 20);
      return;
    }
  }
  const rows = filtered(),
    maxPage = Math.max(0, Math.ceil(rows.length / PAGE) - 1);
  page = Math.min(page, maxPage);
  const shown = rows.slice(page * PAGE, (page + 1) * PAGE);
  $('photo-actions').innerHTML =
    `<div class="selection"><button id="select-page">全选本页</button> <button id="clear-selection">清空选择</button> <span id="selection-count"></span> <button id="edit-selected">修改信息</button> <button id="delete-selected" class="danger" title="Delete 键也可触发删除确认">删除所选原文件</button> ${view === 'pending' ? '<button id="confirm-selected"></button>' : ''}</div><div id="pagination-top"></div>`;
  prefix +=
    '<p class="selection-hint">拖动框选：未选照片选中，已选照片取消；外围空白也可开始，靠近上、下边缘自动滚动。Delete 删除所选照片，确认后执行。</p>';
  const tags = definitions('tags'),
    themes = definitions('themes');
  $('content').innerHTML =
    prefix +
    `<div class="grid">${shown.map((p) => photoCard(p, themes, tags)).join('')}</div>` +
    (rows.length ? '' : '<div class="empty">这里没有照片。</div>');
  $('content')
    .querySelectorAll('[data-select]')
    .forEach(
      (el) =>
        (el.onchange = () => {
          el.checked
            ? selected.add(el.dataset.select)
            : selected.delete(el.dataset.select);
          renderContent();
        }),
    );
  $('content')
    .querySelectorAll('[data-view]')
    .forEach(
      (el) =>
        (el.onclick = () =>
          openViewer(
            el.dataset.view,
            rows.map((x) => x.id),
          )),
    );
  $('content')
    .querySelectorAll('[data-group]')
    .forEach((el) => (el.onclick = () => nav('groups', el.dataset.group)));
  $('content')
    .querySelectorAll('[data-relink]')
    .forEach(
      (el) =>
        (el.onclick = () =>
          action(
            () => api.relink(el.dataset.relink),
            '照片已重新关联，请再次比对。',
          )),
    );
  $('select-page').onclick = () => {
    shown.forEach((x) => selected.add(x.id));
    renderContent();
  };
  $('clear-selection').onclick = () => {
    selected.clear();
    renderContent();
  };
  $('edit-selected').onclick = () => editPhotos([...selected]);
  $('delete-selected').onclick = () => deleteSelection([...selected]);
  $('confirm-selected') &&
    ($('confirm-selected').onclick = () =>
      action(
        () => api.confirm([...selected]),
        (n) => {
          selected.clear();
          return `已确认 ${n} 张照片入库。`;
        },
      ));
  pagination(rows.length, PAGE);
  updateSelectionControls(shown);
  bindDragSelection($('content').querySelector('.grid'), shown);
}
function updateSelectionControls(shown) {
  const visible = shown.filter((p) => selected.has(p.id)).length,
    offPage = selected.size - visible;
  $('selection-count').textContent =
    `已选择 ${selected.size} 张${offPage ? `（其他页 ${offPage} 张）` : ''}`;
  $('edit-selected').disabled =
    !selected.size || busy || view === 'pending' || view === 'groups';
  $('delete-selected').disabled = !selected.size || busy;
  if ($('confirm-selected')) {
    $('confirm-selected').disabled = !selected.size || busy;
    $('confirm-selected').textContent =
      `确认所选照片入库（${selected.size} 张）`;
  }
}
function bindDragSelection(grid, shown) {
  const scroll = document.querySelector('main'),
    bindings = new AbortController();
  unbindSelection = () => bindings.abort();
  let suppressClick = false;
  scroll.addEventListener(
    'click',
    (event) => {
      if (suppressClick) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    { capture: true, signal: bindings.signal },
  );
  grid.addEventListener('dragstart', (event) => event.preventDefault(), {
    signal: bindings.signal,
  });
  scroll.addEventListener(
    'pointerdown',
    (down) => {
      if (
        down.button !== 0 ||
        down.pointerType !== 'mouse' ||
        busy ||
        down.target.closest(
          '#browse-tools, .groups, input, a, button:not(.image-button)',
        )
      )
        return;
      const gridBounds = grid.getBoundingClientRect();
      if (
        down.clientY < gridBounds.top - 32 ||
        down.clientY > gridBounds.bottom + 32
      )
        return;
      const scrollBounds = scroll.getBoundingClientRect();
      if (down.clientX >= scrollBounds.left + scroll.clientWidth) return;
      window.getSelection()?.removeAllRanges();
      document.body.classList.add('selecting-photos');
      const initial = new Set(selected),
        bounds = scroll.getBoundingClientRect(),
        anchor = {
          x: down.clientX,
          y: down.clientY - bounds.top + scroll.scrollTop,
        },
        controller = new AbortController(),
        cards = [...grid.querySelectorAll('[data-photo]')];
      let x = down.clientX,
        y = down.clientY,
        active = false,
        frame = 0,
        box,
        lastTime;
      const finish = () => {
        const wasActive = active;
        active = false;
        controller.abort();
        cancelAnimationFrame(frame);
        box?.remove();
        document.body.classList.remove('selecting-photos');
        selectionGesture = null;
        if (wasActive) {
          suppressClick = true;
          setTimeout(() => {
            suppressClick = false;
          }, 0);
        }
      };
      selectionGesture = finish;
      function draw(time) {
        if (!active) return;
        const area = scroll.getBoundingClientRect(),
          visibleTop = Math.max(
            area.top,
            $('browse-tools').getBoundingClientRect().bottom,
          ),
          elapsed = Math.min(40, lastTime ? time - lastTime : 16);
        lastTime = time;
        const speed =
          y < visibleTop + 48
            ? -Math.min(1, (visibleTop + 48 - y) / 48)
            : y > area.bottom - 48
              ? Math.min(1, (y - area.bottom + 48) / 48)
              : 0;
        scroll.scrollTop += speed * elapsed * 0.9;
        const cursorY =
            Math.max(visibleTop, Math.min(area.bottom, y)) -
            area.top +
            scroll.scrollTop,
          left = Math.min(anchor.x, x),
          right = Math.max(anchor.x, x),
          top = Math.min(anchor.y, cursorY),
          bottom = Math.max(anchor.y, cursorY),
          clientTop = Math.max(visibleTop, top - scroll.scrollTop + area.top),
          clientBottom = Math.min(
            area.bottom,
            bottom - scroll.scrollTop + area.top,
          ),
          clientLeft = Math.max(area.left, left),
          clientRight = Math.min(area.right, right);
        Object.assign(box.style, {
          left: `${clientLeft}px`,
          top: `${clientTop}px`,
          width: `${Math.max(0, clientRight - clientLeft)}px`,
          height: `${Math.max(0, clientBottom - clientTop)}px`,
        });
        for (const card of cards) {
          const rect = card.getBoundingClientRect(),
            cardTop = rect.top - area.top + scroll.scrollTop,
            hit =
              rect.left < right &&
              rect.right > left &&
              cardTop < bottom &&
              cardTop + rect.height > top,
            id = card.dataset.photo,
            checked = hit ? !initial.has(id) : initial.has(id);
          checked ? selected.add(id) : selected.delete(id);
          card.classList.toggle('selected', checked);
          card.querySelector('[data-select]').checked = checked;
        }
        updateSelectionControls(shown);
        frame = requestAnimationFrame(draw);
      }
      window.addEventListener(
        'pointermove',
        (event) => {
          if (event.pointerId !== down.pointerId) return;
          x = event.clientX;
          y = event.clientY;
          if (!active && Math.hypot(x - down.clientX, y - down.clientY) < 6)
            return;
          if (!active) {
            active = true;
            box = document.createElement('div');
            box.className = 'selection-box';
            document.body.append(box);
            frame = requestAnimationFrame(draw);
          }
          event.preventDefault();
        },
        { signal: controller.signal },
      );
      window.addEventListener(
        'pointerup',
        (event) => {
          if (event.pointerId === down.pointerId) {
            cancelAnimationFrame(frame);
            if (active) draw(performance.now());
            finish();
          }
        },
        { signal: controller.signal },
      );
      window.addEventListener('pointercancel', finish, {
        signal: controller.signal,
      });
      window.addEventListener('blur', finish, { signal: controller.signal });
      window.addEventListener(
        'keydown',
        (event) => {
          if (event.key === 'Escape') finish();
        },
        { signal: controller.signal },
      );
    },
    { signal: bindings.signal },
  );
}
function renderBuckets() {
  const photos = data.photos.filter((p) => p.status === 'library'),
    counts = new Map(),
    names =
      view === 'theme'
        ? definitions('themes')
        : view === 'tag'
          ? definitions('tags')
          : new Map(),
    pendingCounts = new Map();
  const definitionView = view === 'theme' || view === 'tag';
  const defaultKey = definitionView ? 'none' : 'pending';
  counts.set(defaultKey, 0);
  names.set(
    defaultKey,
    {
      year: '时间待补充',
      location: '地点待补充',
      theme: '无主题',
      tag: '无标签',
    }[view],
  );
  if (definitionView) {
    for (const id of names.keys()) counts.set(id, 0);
    for (const p of data.photos.filter((p) => p.status === 'pending')) {
      const keys =
        view === 'theme'
          ? [p.themeId || 'none']
          : p.tagIds.length
            ? p.tagIds
            : ['none'];
      for (const key of keys) {
        pendingCounts.set(key, (pendingCounts.get(key) || 0) + 1);
        if (!counts.has(key)) counts.set(key, 0);
      }
    }
  }
  for (const p of photos) {
    let keys;
    if (view === 'year') {
      keys = [
        p.year
          ? String(p.year)
          : p.yearStatus === 'unknown'
            ? 'unknown'
            : 'pending',
      ];
      names.set(
        keys[0],
        p.year
          ? `${p.year}年`
          : p.yearStatus === 'unknown'
            ? '无法确定'
            : '时间待补充',
      );
    } else if (view === 'location') {
      const key = locationKey(p);
      keys = needsLocation(p) && key !== 'pending' ? [key, 'pending'] : [key];
      names.set(key, locationLabel(key));
    } else if (view === 'theme') {
      keys = [p.themeId || 'none'];
    } else {
      keys = p.tagIds.length ? p.tagIds : ['none'];
    }
    for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const buckets = [...counts].sort((a, b) =>
    a[0] === defaultKey
      ? -1
      : b[0] === defaultKey
        ? 1
        : view === 'year'
          ? b[0].localeCompare(a[0])
          : (names.get(a[0]) || '').localeCompare(
              names.get(b[0]) || '',
              'zh-CN',
            ),
  );
  $('content').innerHTML =
    `${definitionView ? '<p class="explanation">这里浏览已入库照片；待导入照片确认后会自动计入对应分类。</p>' : ''}<div class="buckets">${buckets.map(([id, count]) => `<button class="bucket" data-bucket="${escape(id)}"><strong>${escape(names.get(id) || id)}</strong><span>${count} 张${definitionView ? '已入库' : '照片'}${pendingCounts.get(id) ? ` · ${pendingCounts.get(id)} 张待导入` : ''}</span></button>`).join('')}</div>` +
    (buckets.length
      ? ''
      : '<div class="empty">确认照片入库后，会显示相应分类。</div>');
  $('content')
    .querySelectorAll('[data-bucket]')
    .forEach((el) => (el.onclick = () => nav(view, el.dataset.bucket)));
}
function pagination(count, size) {
  const pages = Math.max(1, Math.ceil(count / size));
  const goToPage = (next) => {
    if (!Number.isInteger(next) || next < 0 || next >= pages) return;
    page = next;
    renderContent();
    document.querySelector('main').scrollTop = 0;
  };
  $('pagination-top').innerHTML =
    `<button id="page-prev-top" ${page === 0 ? 'disabled' : ''}>上一页</button><span>${page + 1} / ${pages} · 共 ${count} ${size === 20 ? '组' : '张'}</span><button id="page-next-top" ${page + 1 >= pages ? 'disabled' : ''}>下一页</button><form id="page-jump-form" class="page-jump"><label for="page-number">第</label><input id="page-number" aria-label="跳转页码" type="number" min="1" max="${pages}" step="1" required value="${page + 1}" ${pages === 1 ? 'disabled' : ''}><span>页</span><button type="submit" ${pages === 1 ? 'disabled' : ''}>跳转</button></form>`;
  $('page-prev-top').onclick = () => goToPage(page - 1);
  $('page-next-top').onclick = () => goToPage(page + 1);
  $('page-jump-form').onsubmit = (event) => {
    event.preventDefault();
    if ($('page-number').reportValidity())
      goToPage(Number($('page-number').value) - 1);
  };
  $('page-number').onkeydown = (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      $('page-jump-form').requestSubmit();
    }
  };
}
function editPhotos(ids) {
  const p = ids.length === 1 ? photo(ids[0]) : null;
  if (!ids.length) return;
  $('edit-title').textContent = `修改 ${ids.length} 张照片的信息`;
  $('edit-fields').innerHTML =
    `<label class="field">年份（批量修改时留空表示不修改）</label><input id="field-year" type="number" min="1" max="9999" value="${p?.year || ''}"><select id="field-year-status"><option value="">不修改年份状态</option><option value="pending">年份待补充</option><option value="unknown">年份无法确定</option></select><label class="field">国家</label><input id="field-country" type="text" value="${escape(p?.location?.country || '')}" placeholder="批量留空表示不修改"><label class="field">市</label><input id="field-city" type="text" value="${escape(p?.location?.city || '')}" placeholder="批量留空表示不修改"><select id="field-location-status"><option value="">不修改地点状态</option><option value="pending">地点待补充（清空城市）</option><option value="unknown">地点无法确定</option></select><label class="field">主题</label><select id="field-theme"><option value="">不修改主题</option><option value="__none">无主题</option>${data.themes.map((x) => `<option value="${escape(x.id)}" ${p?.themeId === x.id ? 'selected' : ''}>${escape(x.name)}</option>`).join('')}</select><label class="field">${p ? '标签' : '添加标签（可多选）'}</label><div class="tag-list">${data.tags.map((x) => `<label class="check-row"><input type="checkbox" data-tag="${escape(x.id)}" ${p?.tagIds.includes(x.id) ? 'checked' : ''}>${escape(x.name)}</label>`).join('')}</div>${p ? '' : `<label class="field">移除标签</label><select id="field-remove-tag"><option value="">不移除</option>${data.tags.map((x) => `<option value="${escape(x.id)}">${escape(x.name)}</option>`).join('')}</select>`}`;
  editorAction = async () => {
    const patch = {},
      y = $('field-year').value.trim(),
      ys = $('field-year-status').value,
      ls = $('field-location-status').value;
    if (y) patch.year = Number(y);
    else if (p) patch.year = null;
    if (ys) patch.yearStatus = ys;
    for (const [id, key] of [
      ['field-country', 'country'],
      ['field-city', 'city'],
    ])
      if ($(id).value.trim() || p) patch[key] = $(id).value.trim() || null;
    if (ls) {
      patch.locationStatus = ls;
      if (ls === 'pending') patch.city = null;
    }
    const theme = $('field-theme').value;
    if (theme) patch.themeId = theme === '__none' ? null : theme;
    const checked = [
      ...$('edit-fields').querySelectorAll('[data-tag]:checked'),
    ].map((x) => x.dataset.tag);
    patch.addTagIds = checked;
    patch.removeTagIds = p
      ? p.tagIds.filter((x) => !checked.includes(x))
      : $('field-remove-tag')?.value
        ? [$('field-remove-tag').value]
        : [];
    await api.update(ids, patch);
  };
  $('editor').showModal();
}
function nameEditor(kind, id = null) {
  const old = data[kind].find((x) => x.id === id);
  $('edit-title').textContent = id
    ? '修改名称'
    : `新建${kind === 'themes' ? '主题' : '标签'}`;
  $('edit-fields').innerHTML =
    `<label class="field">名称</label><input id="field-name" type="text" value="${escape(old?.name || '')}" required maxlength="120">`;
  editorAction = () =>
    api.definition(kind, id ? 'rename' : 'create', id, $('field-name').value);
  $('editor').showModal();
}
function showManager() {
  $('manager-content').innerHTML = ['themes', 'tags']
    .map(
      (kind) =>
        `<h3>${kind === 'themes' ? '主题' : '标签'} <button data-new="${kind}">新建</button></h3>${data[kind].map((x) => `<div class="manager-row"><span>${escape(x.name)}</span><button data-rename="${escape(x.id)}" data-kind="${kind}">改名</button><button class="danger" data-delete-definition="${escape(x.id)}" data-kind="${kind}">删除</button></div>`).join('')}`,
    )
    .join('');
  $('manager-content')
    .querySelectorAll('[data-new]')
    .forEach((el) => (el.onclick = () => nameEditor(el.dataset.new)));
  $('manager-content')
    .querySelectorAll('[data-rename]')
    .forEach(
      (el) =>
        (el.onclick = () => nameEditor(el.dataset.kind, el.dataset.rename)),
    );
  $('manager-content')
    .querySelectorAll('[data-delete-definition]')
    .forEach(
      (el) =>
        (el.onclick = async () => {
          const kind = el.dataset.kind,
            id = el.dataset.deleteDefinition,
            def = data[kind].find((x) => x.id === id),
            count = data.photos.filter((p) =>
              kind === 'themes' ? p.themeId === id : p.tagIds.includes(id),
            ).length;
          if (
            !window.confirm(
              `删除“${def.name}”？将解除 ${count} 张照片的此项标记，原文件保留。`,
            )
          )
            return;
          await action(
            () => api.definition(kind, 'delete', id),
            '已删除标记。',
          );
          showManager();
        }),
    );
  if (!$('manager').open) $('manager').showModal();
}
async function deleteSelection(ids) {
  if (!ids.length) return;
  let target = null;
  if (view === 'groups' && filter) {
    const remaining =
      data.groups
        .find((g) => g.id === filter)
        ?.photoIds.filter((id) => !ids.includes(id)) || [];
    if (remaining.length === 1) target = remaining[0];
  }
  await action(
    () => api.delete(ids, target),
    (result) =>
      result?.cancelled
        ? '已取消删除。'
        : `已删除或移除 ${result?.removed || 0} 条记录。${result?.errors?.length ? '部分失败：' + result.errors.map((x) => x.message).join('；') : ''}`,
  );
}
function openViewer(id, ids) {
  viewerIds = ids.slice();
  viewerId = id;
  $('viewer').hidden = false;
  refreshViewer(true);
}
function closeViewer() {
  viewerId = null;
  $('viewer').hidden = true;
  $('large-image').removeAttribute('src');
}
function refreshViewer(reset = false) {
  if (!viewerId) return;
  viewerIds = viewerIds.filter((id) => photo(id));
  if (!photo(viewerId)) {
    viewerId = viewerIds[0] || null;
    reset = true;
  }
  if (!viewerId) {
    closeViewer();
    return;
  }
  const p = photo(viewerId),
    index = viewerIds.indexOf(viewerId);
  $('viewer-title').textContent =
    `${p.fileName} · ${index + 1} / ${viewerIds.length}`;
  $('viewer-info').textContent =
    `${year(p)} · ${place(p)} · ${p.width || '?'} × ${p.height || '?'} · ${(p.size / 1024 ** 2).toFixed(2)} MB`;
  $('previous').disabled = index <= 0;
  $('next').disabled = index < 0 || index >= viewerIds.length - 1;
  $('viewer-edit').disabled = p.status !== 'library';
  const src = `photoatlas://original/${encodeURIComponent(p.id)}`;
  if ($('large-image').getAttribute('src') !== src) {
    $('large-image').src = src;
    reset = true;
  }
  if (reset) {
    pan = { x: 0, y: 0 };
    $('large-image').onload = fitImage;
  }
}
function transform() {
  const image = $('large-image');
  image.style.transform = `translate(calc(-50% + ${pan.x}px),calc(-50% + ${pan.y}px)) scale(${zoom})`;
  $('zoom-label').textContent = `${Math.round(zoom * 100)}%`;
}
function fitImage() {
  const image = $('large-image'),
    stage = $('stage');
  if (!image.naturalWidth) return;
  zoom = Math.min(
    stage.clientWidth / image.naturalWidth,
    stage.clientHeight / image.naturalHeight,
    1,
  );
  pan = { x: 0, y: 0 };
  transform();
}
function zoomBy(factor, event) {
  const next = Math.max(0.01, Math.min(8, zoom * factor));
  if (event) {
    const r = $('stage').getBoundingClientRect(),
      x = event.clientX - r.left - r.width / 2,
      y = event.clientY - r.top - r.height / 2;
    pan = {
      x: x - (x - pan.x) * (next / zoom),
      y: y - (y - pan.y) * (next / zoom),
    };
  } else {
    pan.x *= next / zoom;
    pan.y *= next / zoom;
  }
  zoom = next;
  transform();
}
function step(delta) {
  const index = viewerIds.indexOf(viewerId),
    next = index + delta;
  if (index >= 0 && next >= 0 && next < viewerIds.length) {
    viewerId = viewerIds[next];
    refreshViewer(true);
  }
}
function showProgress(p) {
  $('progress').textContent = p
    ? `${p.phase === 'fingerprints' ? '生成/读取指纹' : '候选细节比对'}：${p.done.toLocaleString()} / ${p.total.toLocaleString()}${p.cached !== undefined ? ' · 已用缓存 ' + p.cached + ' · 读取失败 ' + p.failed : ''}`
    : data?.analysis?.status === 'interrupted'
      ? '上次分析已中断，点击继续会读取已有指纹和比较缓存。'
      : '';
}
$('scan').onclick = () =>
  action(
    () => api.scan(),
    (r) =>
      `扫描完成：${r.total} 条记录，待导入 ${r.pending} 张，缺失 ${r.missing} 张。`,
  );
$('sync').onclick = () =>
  action(
    () => api.sync(),
    (r) =>
      `Library 同步完成：共 ${r.total} 个链接，新增/更新 ${r.written} 个，移除 ${r.removed} 个。`,
  );
$('library').onclick = () => action(() => api['open-library']());
$('undo').onclick = () =>
  action(
    () => api.undo(),
    (result) => `已撤销：${result.label}。`,
  ).then(() => {
    if ($('manager').open) showManager();
  });
$('edit-cancel').onclick = () => $('editor').close();
$('edit-form').onsubmit = (event) => {
  event.preventDefault();
  const task = editorAction;
  $('editor').close();
  action(task, '信息已保存。').then(() => {
    if ($('manager').open) showManager();
  });
};
$('manager-close').onclick = () => $('manager').close();
$('viewer-close').onclick = closeViewer;
$('fit').onclick = fitImage;
$('actual').onclick = () => {
  zoom = 1;
  pan = { x: 0, y: 0 };
  transform();
};
$('zoom-in').onclick = () => zoomBy(1.25);
$('zoom-out').onclick = () => zoomBy(0.8);
$('previous').onclick = () => step(-1);
$('next').onclick = () => step(1);
$('viewer-edit').onclick = () => editPhotos([viewerId]);
$('viewer-delete').onclick = () => deleteSelection([viewerId]);
$('viewer-system').onclick = () => action(() => api.open(viewerId));
$('stage').onwheel = (event) => {
  event.preventDefault();
  zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15, event);
};
$('stage').onpointerdown = (event) => {
  if (event.target !== $('large-image') && event.target !== $('stage')) return;
  drag = { x: event.clientX, y: event.clientY, pan: { ...pan } };
  $('stage').setPointerCapture(event.pointerId);
};
$('stage').onpointermove = (event) => {
  if (drag) {
    pan = {
      x: drag.pan.x + event.clientX - drag.x,
      y: drag.pan.y + event.clientY - drag.y,
    };
    transform();
  }
};
$('stage').onpointerup = $('stage').onpointercancel = () => (drag = null);
document.addEventListener('keydown', (event) => {
  const typing =
    event.target.closest?.(
      'input:not([type="checkbox"]), textarea, select, [contenteditable="true"]',
    ) || event.target.isContentEditable;
  if (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !typing
  ) {
    const key = event.key.toLowerCase();
    if (
      key === 'z' &&
      !event.repeat &&
      !busy &&
      !selectionGesture &&
      !$('editor').open &&
      !$('undo').disabled
    ) {
      event.preventDefault();
      $('undo').click();
      return;
    }
    if (
      key === 'a' &&
      !busy &&
      !viewerId &&
      !selectionGesture &&
      !document.querySelector('dialog[open]') &&
      $('select-page')
    ) {
      event.preventDefault();
      $('select-page').click();
      return;
    }
  }
  if (event.key === 'Delete' && !viewerId) {
    if (
      event.repeat ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey ||
      busy ||
      selectionGesture ||
      !selected.size ||
      document.querySelector('dialog[open]') ||
      event.target.closest?.(
        'input:not([type="checkbox"]), textarea, select, [contenteditable="true"]',
      ) ||
      event.target.isContentEditable ||
      !$('delete-selected') ||
      $('delete-selected').disabled
    )
      return;
    event.preventDefault();
    deleteSelection([...selected]);
    return;
  }
  if (!viewerId || $('editor').open || $('manager').open) return;
  if (event.key === 'Escape') closeViewer();
  if (event.key === 'ArrowLeft') step(-1);
  if (event.key === 'ArrowRight') step(1);
});
api.on('state', (next) => {
  data = next;
  render();
  refreshViewer();
});
api.on('progress', showProgress);
api.on('sync', (p) => {
  $('progress').textContent = `同步快捷方式：${p.done} / ${p.total}`;
});
api
  .state()
  .then((next) => {
    data = next;
    render();
  })
  .catch((error) => notice(error.message));
