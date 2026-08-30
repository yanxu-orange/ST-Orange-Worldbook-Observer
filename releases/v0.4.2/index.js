/**
 * 世界书观测台
 * Version: 0.4.2 — 三端适配
 * Author: 砚梨
 *
 * 手机、平板与 PC 统一响应式版本。
 */
(() => {
  'use strict';

  const APP = Object.freeze({
    id: 'inkstone-worldbook-observer',
    version: '0.4.2',
    buttonName: '世界书观测台',
    chunkSize: 60,
  });

  const POSITION_LABELS = Object.freeze({
    before_character_definition: '角色定义之前',
    after_character_definition: '角色定义之后',
    before_example_messages: '示例消息之前',
    after_example_messages: '示例消息之后',
    before_author_note: '作者注释之前',
    after_author_note: '作者注释之后',
    at_depth: '插入深度',
    outlet: '锚点',
  });
  const ROLE_LABELS = Object.freeze({ system: '系统', assistant: '助手', user: '用户' });
  const ROLE_SUMMARY_LABELS = Object.freeze({ system: '系统', assistant: '助手', user: '用户' });
  const POSITION_TYPES = Object.keys(POSITION_LABELS);
  const ARRANGE_STORAGE_KEY = 'inkstone-worldbook-observer:arrange-rules-by-book';
  const MIXED_ARRANGE_STORAGE_KEY = 'inkstone-worldbook-observer:alpha4-overview-arrange-rules-v1';
  const MIXED_SLOT_STORAGE_KEY = 'inkstone-worldbook-observer:alpha4-mixed-slots-v1';
  const SOURCE_VISIBILITY_KEY = 'inkstone-worldbook-observer:alpha4-source-visible-v1';
  const MIXED_BOOK_VALUE = '__iwb_active_books__';
  const TEST_MODE = Boolean(globalThis.__IWB_QA_TEST_MODE__);
  let currentView = null;
  let buttonRegistered = false;

  function hostWindow() {
    try {
      if (globalThis.parent && globalThis.parent !== globalThis && globalThis.parent.document) return globalThis.parent;
    } catch (_error) {}
    return globalThis;
  }

  function hostDocument() {
    return hostWindow().document || globalThis.document;
  }

  function directPublicFunction(name) {
    if (name === 'eventOn' && typeof eventOn === 'function') return eventOn;
    if (name === 'getButtonEvent' && typeof getButtonEvent === 'function') return getButtonEvent;
    if (name === 'getWorldbookNames' && typeof getWorldbookNames === 'function') return getWorldbookNames;
    if (name === 'getWorldbook' && typeof getWorldbook === 'function') return getWorldbook;
    if (name === 'updateWorldbookWith' && typeof updateWorldbookWith === 'function') return updateWorldbookWith;
    return null;
  }

  function publicFunction(name) {
    const direct = directPublicFunction(name);
    if (direct) return direct;
    if (typeof globalThis[name] === 'function') return globalThis[name].bind(globalThis);
    const helper = globalThis.TavernHelper;
    if (helper && typeof helper[name] === 'function') return helper[name].bind(helper);
    const outerHelper = hostWindow().TavernHelper;
    if (outerHelper && typeof outerHelper[name] === 'function') return outerHelper[name].bind(outerHelper);
    return null;
  }

  function requirePublicFunction(name) {
    const fn = publicFunction(name);
    if (!fn) throw new Error(`缺少 Tavern Helper 公开接口：${name}`);
    return fn;
  }

  function sillyTavernApi() {
    if (typeof SillyTavern !== 'undefined' && SillyTavern) return SillyTavern;
    return globalThis.SillyTavern || hostWindow().SillyTavern || null;
  }

  function cloneJson(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function jsonText(value) {
    return JSON.stringify(value);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function cssEscape(value) {
    const api = hostWindow().CSS || globalThis.CSS;
    if (typeof api?.escape === 'function') return api.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, character => `\\${character.codePointAt(0).toString(16)} `);
  }

  function toast(kind, message, title = '世界书观测台') {
    const api = hostWindow().toastr || globalThis.toastr;
    if (api && typeof api[kind] === 'function') api[kind](message, title);
    else console[kind === 'error' ? 'error' : 'log'](`[${title}] ${message}`);
  }

  function entryId(entry) {
    const uid = entry?._iwbOriginalUid ?? entry?.uid;
    if (!['number', 'string'].includes(typeof uid) || String(uid) === '') throw new Error('存在缺少有效 UID 的条目，已停止编排。');
    const encodedUid = encodeURIComponent(String(uid));
    const local = `${typeof uid}:${encodedUid}`;
    if (!Object.prototype.hasOwnProperty.call(entry || {}, '_iwbBook')) return local;
    const encodedBook = encodeURIComponent(String(entry._iwbBook ?? ''));
    return `mixed:${encodedBook.length}:${encodedBook}:${local}`;
  }

  function decodeEntryId(id) {
    const value = String(id ?? '');
    let local = value;
    let book = null;
    if (value.startsWith('mixed:')) {
      const lengthEnd = value.indexOf(':', 6);
      const length = Number(value.slice(6, lengthEnd));
      if (lengthEnd < 0 || !Number.isSafeInteger(length) || length < 0) throw new Error('混合条目标识无效。');
      const bookStart = lengthEnd + 1;
      const bookEnd = bookStart + length;
      if (value[bookEnd] !== ':') throw new Error('混合条目标识长度无效。');
      book = decodeURIComponent(value.slice(bookStart, bookEnd));
      local = value.slice(bookEnd + 1);
    }
    const typeEnd = local.indexOf(':');
    const type = local.slice(0, typeEnd);
    if (typeEnd < 0 || (type !== 'number' && type !== 'string')) throw new Error('条目 UID 标识无效。');
    const decoded = decodeURIComponent(local.slice(typeEnd + 1));
    return { book, uidType: type, uid: type === 'number' ? Number(decoded) : decoded };
  }

  function assertUniqueEntries(entries) {
    if (!Array.isArray(entries)) throw new Error('世界书接口没有返回条目数组。');
    const seen = new Set();
    entries.forEach(entry => {
      const id = entryId(entry);
      if (seen.has(id)) throw new Error(`存在重复 UID：${String(entry.uid)}，已停止编排。`);
      seen.add(id);
    });
  }

  function entryName(entry) {
    return String(entry?.name ?? entry?.comment ?? '').trim() || `未命名条目 ${String(entry?._iwbOriginalUid ?? entry?.uid ?? '')}`;
  }

  function positionInfo(entry) {
    const position = entry?.position;
    if (!position || typeof position !== 'object' || Array.isArray(position)) {
      return { type: 'unknown', label: '未知位置', depth: null, role: null, order: null, editable: false };
    }
    const type = String(position.type || 'unknown');
    return {
      type,
      label: POSITION_LABELS[type] || `未知位置（${type}）`,
      depth: type === 'at_depth' && Number.isFinite(Number(position.depth)) ? Number(position.depth) : null,
      role: type === 'at_depth' ? String(position.role || 'system') : null,
      order: Number.isFinite(Number(position.order)) ? Number(position.order) : null,
      editable: POSITION_TYPES.includes(type),
    };
  }

  function compactPositionLabel(entry) {
    const pos = positionInfo(entry);
    if (pos.type === 'at_depth') return `${ROLE_SUMMARY_LABELS[pos.role] || pos.role || '系统'} D${pos.depth ?? '—'}`;
    return ({
      before_character_definition: '角色前',
      after_character_definition: '角色后',
      before_example_messages: '示例前',
      after_example_messages: '示例后',
      before_author_note: '作者注前',
      after_author_note: '作者注后',
      outlet: '锚点',
    })[pos.type] || '未知位置';
  }

  function compactSummary(entry, globalIndex, token = '未计算') {
    return `No.${globalIndex + 1} · Token ${token}`;
  }

  function moveModeLabel(moveMode) {
    return moveMode ? '移动模式' : '编辑模式';
  }

  function anchoredScrollTop(scrollTop, beforeTop, afterTop, maxScrollTop) {
    const next = Number(scrollTop) + Number(afterTop) - Number(beforeTop);
    return Math.min(Math.max(0, Number(maxScrollTop) || 0), Math.max(0, Number.isFinite(next) ? next : Number(scrollTop) || 0));
  }

  function contentPreviewText(content, maxLength = 150) {
    const normalized = String(content ?? '').replace(/\r\n?/gu, '\n').replace(/[^\S\n]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim();
    if (!normalized) return '正文为空';
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
  }

  /* IWB_CONTENT_ATOMIC_EDIT_BEGIN */
  function createContentEditorState(entry, scrollTop = 0) {
    const displayedName = entryName(entry);
    const keys = normalizePrimaryKeys(primaryKeys(entry));
    return { id: entryId(entry), nameDraft: displayedName, originalName: displayedName, keysDraft: cloneJson(keys), originalKeys: cloneJson(keys), keyInputDraft: '', titleEditing: false, keywordEditing: false, allowNameEdit: true, allowKeyEdit: true, draft: String(entry?.content ?? ''), originalContent: String(entry?.content ?? ''), scrollTop: Number(scrollTop) || 0, tokenGeneration: 0 };
  }

  function applyContentDraft(entries, editorState) {
    return mutateEntry(entries, editorState.id, entry => {
      if (editorState.allowNameEdit !== false && String(editorState.nameDraft ?? '') !== String(editorState.originalName ?? '')) entry.name = String(editorState.nameDraft ?? '');
      if (jsonText(editorState.keysDraft) !== jsonText(editorState.originalKeys)) {
        if (!entry.strategy || typeof entry.strategy !== 'object' || Array.isArray(entry.strategy)) throw new Error('当前条目的激活策略无法无损编辑。');
        entry.strategy.keys = cloneJson(editorState.keysDraft);
      }
      entry.content = String(editorState.draft ?? '');
    });
  }
  /* IWB_CONTENT_ATOMIC_EDIT_END */

  function searchText(entry) {
    const primary = Array.isArray(entry?.strategy?.keys) ? entry.strategy.keys : Array.isArray(entry?.key) ? entry.key : [];
    return `${entryName(entry)}\n${String(entry?.uid ?? '')}\n${primary.join('\n')}`.toLocaleLowerCase('zh-CN');
  }

  function primaryKeys(entry) {
    return Array.isArray(entry?.strategy?.keys) ? entry.strategy.keys : [];
  }

  function editableActivationType(entry) {
    const type = entry?.strategy?.type;
    return type === 'constant' || type === 'selective' || type === 'normal' ? type : null;
  }

  function enabledState(entry) {
    return typeof entry?.enabled === 'boolean' ? entry.enabled : null;
  }

  function enabledPresentation(entry) {
    const enabled = enabledState(entry);
    return {
      enabled,
      checked: enabled === true,
      disabled: enabled === null,
      label: enabled ? '禁用条目' : '启用条目',
      title: enabled === null ? '启用状态不可识别' : enabled ? '已启用，点击后仅修改工作副本' : '已禁用，点击后仅修改工作副本',
    };
  }

  function parsePrimaryKeys(value) {
    const seen = new Set();
    return String(value ?? '').split(/[,，;；\n]+/u).map(item => item.trim()).filter(item => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  }

  function normalizePrimaryKeys(keys) {
    const seen = new Set();
    return (Array.isArray(keys) ? keys : []).map(value => String(value).trim()).filter(value => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function mergePrimaryKeys(existing, value) {
    const result = normalizePrimaryKeys(existing);
    const seen = new Set(result);
    parsePrimaryKeys(value).forEach(key => {
      if (!seen.has(key)) { seen.add(key); result.push(key); }
    });
    return result;
  }

  function removePrimaryKey(existing, index) {
    const result = normalizePrimaryKeys(existing);
    if (Number.isInteger(index) && index >= 0 && index < result.length) result.splice(index, 1);
    return result;
  }

  function allocateUid(entries) {
    const used = new Set(entries.map(entry => String(entry?.uid ?? '')));
    let uid = 0;
    while (used.has(String(uid))) uid += 1;
    if (!Number.isSafeInteger(uid)) throw new Error('无法生成安全且唯一的数字 UID。');
    return uid;
  }

  function createMinimalEntry(entries) {
    return {
      uid: allocateUid(entries),
      name: '新条目',
      enabled: true,
      strategy: {
        type: 'selective',
        keys: [],
        keys_secondary: { logic: 'and_any', keys: [] },
        scan_depth: 'same_as_global',
      },
      position: { type: 'before_character_definition', role: 'system', depth: 4, order: 100 },
      content: '',
      probability: 100,
      recursion: { prevent_incoming: false, prevent_outgoing: false, delay_until: null },
      effect: { sticky: null, cooldown: null, delay: null },
    };
  }

  function copyEntry(entries, sourceId) {
    const next = cloneJson(entries);
    const index = next.findIndex(entry => entryId(entry) === sourceId);
    if (index < 0) throw new Error('没有找到要复制的条目。');
    const duplicate = cloneJson(next[index]);
    duplicate.uid = allocateUid(next);
    duplicate.name = `${entryName(duplicate)}（副本）`;
    next.splice(index + 1, 0, duplicate);
    return { entries: next, id: entryId(duplicate) };
  }

  function mutateEntry(entries, targetId, updater) {
    const next = cloneJson(entries);
    const entry = next.find(candidate => entryId(candidate) === targetId);
    if (!entry) throw new Error('没有找到要编辑的条目。');
    updater(entry);
    return next;
  }


  function allocateUidFromUsedKeys(usedKeys) {
    let uid = 0;
    while (usedKeys.has(String(uid))) uid += 1;
    if (!Number.isSafeInteger(uid)) throw new Error('无法生成安全且唯一的数字 UID。');
    return uid;
  }

  function importEntriesAtTop(targetEntries, sourceEntries, sourceIds) {
    const ids = new Set(sourceIds);
    const selected = sourceEntries.filter(entry => ids.has(entryId(entry))).map(cloneJson);
    if (!selected.length || selected.length !== ids.size) throw new Error('没有找到全部待导入条目。');
    const target = cloneJson(targetEntries);
    const usedKeys = new Set(target.map(entry => String(entry?.uid ?? '')));
    const imported = selected.map(entry => {
      const next = cloneJson(entry);
      if (usedKeys.has(String(next.uid))) next.uid = allocateUidFromUsedKeys(usedKeys);
      usedKeys.add(String(next.uid));
      return next;
    });
    const entries = [...imported, ...target];
    assertUniqueEntries(entries);
    return { entries, importedIds: imported.map(entryId) };
  }



  function createTransferDraft() {
    return { selected: new Set(), previewed: new Set(), query: '', filter: 'all', target: '', phase: 'select', mode: null, scrollTop: 0, listScrollTop: 0, loading: false };
  }

  function transferTargetStates(view) {
    return [...(view.transferStates?.values?.() || [])];
  }

  function transferDirtyBooks(view) {
    const dirty = [];
    if (view.book && view.baseline && view.working && jsonText(view.baseline) !== jsonText(view.working)) dirty.push(view.book);
    for (const state of transferTargetStates(view)) if (jsonText(state.baseline) !== jsonText(state.working)) dirty.push(state.name);
    return [...new Set(dirty)];
  }

  function transferEntriesAtTop(targetEntries, sourceEntries, sourceIds) {
    const ids = new Set(sourceIds);
    const selected = sourceEntries.filter(entry => ids.has(entryId(entry))).map(cloneJson);
    if (!selected.length || selected.length !== ids.size) throw new Error('没有找到全部待转移条目。');
    const target = cloneJson(targetEntries);
    const usedKeys = new Set(target.map(entry => String(entry?.uid ?? '')));
    const transferred = selected.map(entry => {
      const next = cloneJson(entry);
      next.uid = allocateUidFromUsedKeys(usedKeys);
      usedKeys.add(String(next.uid));
      return next;
    });
    const entries = [...transferred, ...target];
    assertUniqueEntries(entries);
    return { entries, transferredIds: transferred.map(entryId) };
  }

  function transferSnapshot(view, label) {
    return {
      kind: 'transfer', label, working: cloneJson(view.working),
      targets: transferTargetStates(view).map(state => [state.name, cloneJson(state.working)]),
      moveTargets: [...(view.transferMoveTargets || [])],
    };
  }

  function restoreTransferSnapshot(view, snapshot) {
    view.working = cloneJson(snapshot.working);
    const targets = new Map(snapshot.targets || []);
    for (const state of transferTargetStates(view)) state.working = cloneJson(targets.has(state.name) ? targets.get(state.name) : state.baseline);
    view.transferMoveTargets = new Set(snapshot.moveTargets || []);
  }

  function pushTransferUndo(view, snapshot) {
    view.undo.push(snapshot);
    if (view.undo.length > 30) view.undo.shift();
  }

  function discardTransferChanges(view) {
    view.working = cloneJson(view.baseline);
    for (const state of transferTargetStates(view)) state.working = cloneJson(state.baseline);
    view.transferMoveTargets.clear();
    view.undo = [];
    view.transferDraft.selected.clear();
  }

  async function ensureTransferTarget(view, name, dependencies = {}) {
    if (!name || name === view.book) throw new Error('目标世界书必须不同于来源书。');
    if (!view.names.includes(name)) throw new Error('目标世界书不存在。');
    if (view.transferStates.has(name)) return view.transferStates.get(name);
    const getWorldbook = dependencies.getWorldbook || requirePublicFunction('getWorldbook');
    const entries = await getWorldbook(name);
    assertUniqueEntries(entries);
    const state = { name, baseline: cloneJson(entries), working: cloneJson(entries) };
    view.transferStates.set(name, state);
    return state;
  }

  function visibleTransferEntries(view) {
    const draft = view.transferDraft;
    const query = String(draft.query || '').trim().toLocaleLowerCase('zh-CN');
    return (view.working || []).filter(entry => {
      if (query && !searchText(entry).includes(query)) return false;
      if (draft.filter === 'enabled' && entry.enabled !== true) return false;
      if (draft.filter === 'disabled' && entry.enabled !== false) return false;
      return true;
    });
  }

  function captureTransferListScroll(view) {
    const list = view.root?.querySelector?.('[data-slot="transfer-list"]');
    if (list) view.transferDraft.listScrollTop = Number(list.scrollTop) || 0;
    return view.transferDraft.listScrollTop || 0;
  }

  function restoreTransferListScroll(view, requested = view.transferDraft.listScrollTop) {
    const list = view.root?.querySelector?.('[data-slot="transfer-list"]');
    if (!list) return 0;
    const top = Math.min(Math.max(0, Number(requested) || 0), Math.max(0, list.scrollHeight - list.clientHeight));
    list.scrollTop = top;
    view.transferDraft.listScrollTop = top;
    return top;
  }

  function renderTransferSelection(view, preserveScroll = true) {
    const top = preserveScroll ? captureTransferListScroll(view) : 0;
    if (!preserveScroll) view.transferDraft.listScrollTop = 0;
    const results = view.root?.querySelector?.('[data-slot="transfer-results"]');
    if (results) results.innerHTML = transferResultsHtml(view);
    const empty = view.transferDraft.selected.size === 0;
    const unavailable = empty || (isDesktopLayout(view) && !view.transferDraft.target);
    view.root?.querySelectorAll?.('[data-action="transfer-choose"]').forEach(button => { button.disabled = unavailable; });
    const clear = view.root?.querySelector?.('[data-action="transfer-clear"]');
    if (clear) clear.disabled = empty;
    return restoreTransferListScroll(view, top);
  }

  function renderImportSelection(view, preserveScroll = true) {
    const oldList = view.root?.querySelector?.('[data-slot="import-list"]');
    const top = preserveScroll ? Number(oldList?.scrollTop) || 0 : 0;
    const results = view.root?.querySelector?.('[data-slot="import-results"]');
    if (results) results.innerHTML = importResultsHtml(view);
    const list = view.root?.querySelector?.('[data-slot="import-list"]');
    if (list) list.scrollTop = Math.min(top, Math.max(0, list.scrollHeight - list.clientHeight));
    const empty = view.importDraft.selected.size === 0;
    const clear = view.root?.querySelector?.('[data-action="import-clear"]');
    const apply = view.root?.querySelector?.('[data-action="apply-import"]');
    if (clear) clear.disabled = empty;
    if (apply) { apply.disabled = empty || view.importDraft.loading; apply.textContent = `导入 ${view.importDraft.selected.size} 条`; }
    return Number(list?.scrollTop) || 0;
  }

  function toggleSourcePreview(view, kind, id) {
    const draft = kind === 'import' ? view.importDraft : view.transferDraft;
    if (!draft?.previewed || !id) return false;
    draft.previewed.has(id) ? draft.previewed.delete(id) : draft.previewed.add(id);
    if (kind === 'import') renderImportSelection(view, true);
    else renderTransferSelection(view, true);
    return true;
  }

  /* IWB_IMPORT_TARGET_LOCK_BEGIN */
  function lockedBookPanelMessage(view) {
    if (view.panel === 'import') return '请先退出从其他书导入';
    if (view.panel === 'transfer') return '请先退出跨书转移';
    return '';
  }

  function isLockedTransferBookControl(view, target) {
    return (view.panel === 'transfer' || view.panel === 'import') && Boolean(target?.closest?.('[data-control="book"]'));
  }

  function blockTransferBookControl(view, event, notify = true) {
    if (!isLockedTransferBookControl(view, event.target)) return false;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    if (notify) toast('info', lockedBookPanelMessage(view));
    return true;
  }
  /* IWB_IMPORT_TARGET_LOCK_END */

  async function applyTransfer(view, mode, targetName, dependencies = {}) {
    if (mode !== 'copy' && mode !== 'move') throw new Error('跨书操作类型无效。');
    const selectedIds = [...view.transferDraft.selected];
    if (!selectedIds.length) throw new Error('请先选择要转移的条目。');
    const target = await ensureTransferTarget(view, targetName, dependencies);
    const snapshot = transferSnapshot(view, mode === 'copy' ? '复制到其他书' : '移动到其他书');
    const result = transferEntriesAtTop(target.working, view.working, selectedIds);
    target.working = result.entries;
    if (mode === 'move') {
      const selected = new Set(selectedIds);
      view.working = view.working.filter(entry => !selected.has(entryId(entry))).map(cloneJson);
      view.transferMoveTargets.add(targetName);
    }
    pushTransferUndo(view, snapshot);
    view.transferDraft.selected.clear();
    view.transferDraft.phase = 'select';
    view.transferDraft.mode = null;
    return { count: result.transferredIds.length, targetName, mode };
  }

  async function saveTransfer(view, dependencies = {}) {
    const getWorldbook = dependencies.getWorldbook || requirePublicFunction('getWorldbook');
    const updateWorldbookWith = dependencies.updateWorldbookWith || requirePublicFunction('updateWorldbookWith');
    const persist = dependencies.persistWorkingCopy || persistWorkingCopy;
    const targetResults = [];
    const dirtyTargets = transferTargetStates(view).filter(state => jsonText(state.baseline) !== jsonText(state.working));
    view.busy = 'save';
    if (view.root) renderDynamic(view);
    for (const state of dirtyTargets) {
      try {
        const verified = await persist(state.name, state.baseline, state.working, getWorldbook, updateWorldbookWith);
        state.baseline = cloneJson(verified);
        state.working = cloneJson(verified);
        targetResults.push({ name: state.name, ok: true });
      } catch (error) {
        targetResults.push({ name: state.name, ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    }
    const targetFailures = targetResults.filter(result => !result.ok);
    const failedNames = new Set(targetFailures.map(result => result.name));
    const blockingMoveTargets = [...view.transferMoveTargets].filter(name => failedNames.has(name));
    const sourceDirty = jsonText(view.baseline) !== jsonText(view.working);
    let sourceResult = null;
    if (sourceDirty && !blockingMoveTargets.length) {
      try {
        const verified = await persist(view.book, view.baseline, view.working, getWorldbook, updateWorldbookWith);
        view.baseline = cloneJson(verified);
        view.working = cloneJson(verified);
        sourceResult = { name: view.book, ok: true };
        view.transferMoveTargets.clear();
      } catch (error) {
        sourceResult = { name: view.book, ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
    const sourceBlocked = sourceDirty && blockingMoveTargets.length > 0;
    const failures = [...targetFailures, ...(sourceResult && !sourceResult.ok ? [sourceResult] : [])];
    const ok = !sourceBlocked && failures.length === 0;
    if (ok) {
      view.undo = [];
      toast('success', '已保存 ' + (targetResults.filter(result => result.ok).length + (sourceResult?.ok ? 1 : 0)) + ' 本实际修改的世界书。');
    } else if (sourceBlocked) {
      const detail = targetFailures.map(item => '《' + item.name + '》' + item.message).join('；');
      toast('error', '目标书保存失败：' + detail + '。已停止保存来源书。来源书尚未保存，来源书的其他修改也仍保留。失败书工作副本与跨书操作状态均已保留。', '部分保存失败');
    } else {
      toast('error', '部分保存失败：' + failures.map(item => '《' + item.name + '》' + item.message).join('；') + '。失败书工作副本与跨书操作状态均已保留。', '部分保存失败');
    }
    view.busy = null;
    if (view.root) renderDynamic(view, { list: true });
    return ok;
  }

  function arrangeTrack(entry) {
    const position = positionInfo(entry);
    if (position.type === 'at_depth') {
      const role = String(position.role || 'system');
      const depth = position.depth;
      return { key: `depth:${role}:${String(depth)}`, label: `${ROLE_SUMMARY_LABELS[role] || role} D${depth ?? '—'}`, type: 'depth', role, depth };
    }
    return { key: `position:${position.type}`, label: POSITION_LABELS[position.type] || position.label, type: 'position', position: position.type };
  }

  function discoverArrangeTracks(entries) {
    const tracks = new Map();
    entries.forEach((entry, index) => {
      const track = arrangeTrack(entry);
      if (!tracks.has(track.key)) tracks.set(track.key, { ...track, count: 0, firstIndex: index });
      tracks.get(track.key).count += 1;
    });
    return [...tracks.values()];
  }

  function defaultArrangeRules(entries) {
    const positionRanks = new Map(POSITION_TYPES.map((type, index) => [type, index]));
    const depthRank = positionRanks.get('at_depth') ?? POSITION_TYPES.length;
    const roleRanks = new Map(['system', 'user', 'assistant'].map((role, index) => [role, index]));
    return discoverArrangeTracks(entries).sort((left, right) => {
      const leftRank = left.type === 'depth' ? depthRank : positionRanks.has(left.position) ? positionRanks.get(left.position) : POSITION_TYPES.length;
      const rightRank = right.type === 'depth' ? depthRank : positionRanks.has(right.position) ? positionRanks.get(right.position) : POSITION_TYPES.length;
      if (leftRank !== rightRank) return leftRank - rightRank;
      if (left.type === 'depth' && right.type === 'depth') {
        const roleDifference = (roleRanks.get(left.role) ?? 99) - (roleRanks.get(right.role) ?? 99);
        if (roleDifference) return roleDifference;
        const leftDepth = Number.isFinite(left.depth) ? left.depth : Number.NEGATIVE_INFINITY;
        const rightDepth = Number.isFinite(right.depth) ? right.depth : Number.NEGATIVE_INFINITY;
        if (leftDepth !== rightDepth) return rightDepth - leftDepth;
      }
      return left.firstIndex - right.firstIndex;
    }).map(track => ({ ...track, direction: 'asc', isNew: false }));
  }

  function readArrangeRuleStore(storage) {
    try {
      const target = storage ?? hostWindow().localStorage;
      const parsed = JSON.parse(target?.getItem?.(ARRANGE_STORAGE_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function loadArrangeRules(book, storage) {
    const stored = readArrangeRuleStore(storage)[book];
    if (!Array.isArray(stored)) return null;
    const seen = new Set();
    return stored.filter(rule => rule && typeof rule.key === 'string' && !seen.has(rule.key) && seen.add(rule.key)).map(rule => ({ key: rule.key, direction: rule.direction === 'desc' ? 'desc' : 'asc' }));
  }

  function saveArrangeRules(book, rules, storage) {
    const normalized = (Array.isArray(rules) ? rules : []).map(rule => ({ key: String(rule.key), direction: rule.direction === 'desc' ? 'desc' : 'asc' }));
    try {
      const target = storage ?? hostWindow().localStorage;
      const store = readArrangeRuleStore(target);
      store[book] = normalized;
      target?.setItem?.(ARRANGE_STORAGE_KEY, JSON.stringify(store));
    } catch (_error) {}
    return normalized;
  }

  function effectiveArrangeRules(entries, storedRules) {
    const defaults = defaultArrangeRules(entries);
    if (!storedRules?.length) return defaults;
    const actualByKey = new Map(defaults.map(track => [track.key, track]));
    const result = [];
    storedRules.forEach(rule => {
      const actual = actualByKey.get(rule.key);
      if (!actual) return;
      result.push({ ...actual, direction: rule.direction === 'desc' ? 'desc' : 'asc', isNew: false });
      actualByKey.delete(rule.key);
    });
    defaults.forEach(track => {
      if (actualByKey.has(track.key)) result.push({ ...track, isNew: true });
    });
    return result;
  }

  function stableAutoArrange(entries, rules) {
    const effective = effectiveArrangeRules(entries, rules);
    const tracks = new Map(effective.map((rule, index) => [rule.key, { index, direction: rule.direction }]));
    return entries.map((entry, index) => ({ entry: cloneJson(entry), index, track: arrangeTrack(entry), order: positionInfo(entry).order }))
      .sort((left, right) => {
        const leftRule = tracks.get(left.track.key) || { index: tracks.size, direction: 'asc' };
        const rightRule = tracks.get(right.track.key) || { index: tracks.size, direction: 'asc' };
        if (leftRule.index !== rightRule.index) return leftRule.index - rightRule.index;
        const leftOrder = Number.isFinite(left.order) ? left.order : Number.POSITIVE_INFINITY;
        const rightOrder = Number.isFinite(right.order) ? right.order : Number.POSITIVE_INFINITY;
        const difference = leftRule.direction === 'desc' ? rightOrder - leftOrder : leftOrder - rightOrder;
        return difference || left.index - right.index;
      }).map(item => item.entry);
  }

  function disableAllRecursion(entries) {
    const next = cloneJson(entries);
    next.forEach(entry => {
      const recursion = entry.recursion && typeof entry.recursion === 'object' && !Array.isArray(entry.recursion) ? entry.recursion : {};
      recursion.prevent_incoming = true;
      recursion.prevent_outgoing = true;
      recursion.delay_until = null;
      entry.recursion = recursion;
    });
    return next;
  }


  function recursionStatusHtml(entry) {
    const recursion = entry?.recursion && typeof entry.recursion === 'object' ? entry.recursion : {};
    const incoming = recursion.prevent_incoming === true ? '禁止被递归' : '可被递归';
    const outgoing = recursion.prevent_outgoing === true ? '禁止继续递归' : '可继续递归';
    const delayed = recursion.delay_until !== null && recursion.delay_until !== undefined ? '<span>仅递归时触发</span>' : '';
    return `<span>${incoming}</span><span>${outgoing}</span>${delayed}`;
  }

  function visibleImportEntries(view) {

    const draft = view.importDraft;
    const query = draft.query.trim().toLocaleLowerCase('zh-CN');
    return (draft.entries || []).filter(entry => {
      if (query && !searchText(entry).includes(query)) return false;
      if (draft.filter === 'enabled' && entry.enabled !== true) return false;
      if (draft.filter === 'disabled' && entry.enabled !== false) return false;
      return true;
    });
  }

  /* IWB_TASK_PREVIEW_BEGIN */
  function sourcePreviewRow(entry, selected, expanded, kind) {
    const id = entryId(entry);
    const name = entryName(entry);
    const fullLabel = `${name} · UID ${String(entry.uid)}`;
    return `<div class="qa-source-preview-item" data-source-entry-id="${escapeHtml(id)}"><div class="qa-import-item ${kind === 'import' ? 'qa-import-source-item' : 'qa-transfer-item'}" title="${escapeHtml(fullLabel)}" aria-label="${escapeHtml(fullLabel)}"><input type="checkbox" data-action="${kind}-toggle" data-source-id="${escapeHtml(id)}" ${selected ? 'checked' : ''}><button type="button" class="qa-source-preview-toggle ${kind === 'import' ? 'qa-import-name' : 'qa-transfer-name'}" data-action="${kind}-preview" data-source-id="${escapeHtml(id)}" aria-expanded="${String(expanded)}">${escapeHtml(name)}</button><small class="${kind === 'import' ? 'qa-import-uid' : 'qa-transfer-uid'}">UID ${escapeHtml(entry.uid)}</small><button type="button" class="qa-source-preview-arrow" data-action="${kind}-preview" data-source-id="${escapeHtml(id)}" aria-label="${expanded ? '收起' : '预览'}《${escapeHtml(name)}》正文" aria-expanded="${String(expanded)}"><i class="fa-solid fa-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true"></i></button></div>${expanded ? `<section class="qa-source-preview" aria-label="《${escapeHtml(name)}》只读正文预览"><div class="qa-source-preview-meta"><strong>${escapeHtml(name)}</strong><span>UID ${escapeHtml(entry.uid)}</span><span>Token 未计算</span></div><div class="qa-source-preview-body">${escapeHtml(String(entry?.content ?? '')) || '正文为空'}</div></section>` : ''}</div>`;
  }

  function importResultsHtml(view) {
    const draft = view.importDraft;
    const visible = visibleImportEntries(view);
    const rendered = visible.slice(0, 200);
    const rows = rendered.map(entry => {
      const id = entryId(entry);
      return sourcePreviewRow(entry, draft.selected.has(id), draft.previewed.has(id), 'import');
    }).join('');
    return `<div class="qa-import-list" data-slot="import-list">${rows || '<div class="qa-panel-note">没有匹配条目。</div>'}</div><div class="qa-import-summary">显示 ${rendered.length} 条 · 已选 ${draft.selected.size} 条</div>`;
  }
  /* IWB_TASK_PREVIEW_END */

  async function loadImportSource(view, sourceBook) {
    view.importDraft = { source: sourceBook, entries: null, selected: new Set(), previewed: new Set(), query: '', filter: 'all', loading: Boolean(sourceBook), error: '' };
    renderDynamic(view, { list: true });
    if (!sourceBook) return;
    if (sourceBook === view.book) throw new Error('来源书不能是当前目标书。');
    try {
      const entries = await requirePublicFunction('getWorldbook')(sourceBook);
      assertUniqueEntries(entries);
      if (view.importDraft.source !== sourceBook) return;
      view.importDraft.entries = cloneJson(entries);
    } catch (error) {
      if (view.importDraft.source === sourceBook) view.importDraft.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (view.importDraft.source === sourceBook) {
        view.importDraft.loading = false;
        renderDynamic(view, { list: true });
      }
    }
  }

  function getTokenCounter() {

    try {
      const context = sillyTavernApi()?.getContext?.();
      return typeof context?.getTokenCountAsync === 'function' ? context.getTokenCountAsync.bind(context) : null;
    } catch (_error) {
      return null;
    }
  }

  function tokenLabel(view, entry) {
    const cached = view.tokenCounts.get(entryId(entry));
    const content = String(entry?.content ?? '');
    return cached?.content === content && Number.isFinite(cached.value) ? String(cached.value) : '未计算';
  }

  function scheduleTokenCounts(view, entries) {
    const counter = getTokenCounter();
    if (!counter || view.tokenTask) return;
    const pending = entries.filter(entry => {
      const cached = view.tokenCounts.get(entryId(entry));
      return cached?.content !== String(entry?.content ?? '');
    });
    if (!pending.length) return;
    view.tokenTask = (async () => {
      for (const entry of pending) {
        if (view.closed || !view.working?.some(candidate => entryId(candidate) === entryId(entry))) continue;
        const content = String(entry?.content ?? '');
        try {
          const value = await counter(content);
          view.tokenCounts.set(entryId(entry), { content, value: Number.isFinite(Number(value)) ? Number(value) : null });
        } catch (_error) {
          view.tokenCounts.set(entryId(entry), { content, value: null });
        }
        const node = view.root?.querySelector(`[data-token-id="${cssEscape(entryId(entry))}"]`);
        const cached = view.tokenCounts.get(entryId(entry));
        if (node && cached?.content === content) node.textContent = Number.isFinite(cached.value) ? String(cached.value) : '未计算';
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    })().finally(() => {
      view.tokenTask = null;
      if (!view.closed) scheduleTokenCounts(view, visibleEntries(view).slice(0, view.renderLimit));
    });
  }

  function moveEntries(entries, targetIds, direction) {
    const ids = new Set(targetIds);
    if (!ids.size) return cloneJson(entries);
    const next = cloneJson(entries);
    if (direction === 'top' || direction === 'bottom') {
      const selected = next.filter(entry => ids.has(entryId(entry)));
      const rest = next.filter(entry => !ids.has(entryId(entry)));
      return direction === 'top' ? [...selected, ...rest] : [...rest, ...selected];
    }
    if (direction === 'up') {
      for (let index = 1; index < next.length; index += 1) {
        if (ids.has(entryId(next[index])) && !ids.has(entryId(next[index - 1]))) {
          [next[index - 1], next[index]] = [next[index], next[index - 1]];
        }
      }
      return next;
    }
    if (direction === 'down') {
      for (let index = next.length - 2; index >= 0; index -= 1) {
        if (ids.has(entryId(next[index])) && !ids.has(entryId(next[index + 1]))) {
          [next[index], next[index + 1]] = [next[index + 1], next[index]];
        }
      }
      return next;
    }
    throw new Error(`未知排列方向：${direction}`);
  }

  function dropEntries(entries, targetIds, anchorId, after) {
    const ids = new Set(targetIds);
    if (!ids.size || ids.has(anchorId)) return cloneJson(entries);
    const selected = entries.filter(entry => ids.has(entryId(entry))).map(cloneJson);
    const rest = entries.filter(entry => !ids.has(entryId(entry))).map(cloneJson);
    const anchorIndex = rest.findIndex(entry => entryId(entry) === anchorId);
    if (anchorIndex < 0) return cloneJson(entries);
    rest.splice(anchorIndex + (after ? 1 : 0), 0, ...selected);
    return rest;
  }

  function mutatePosition(entries, targetIds, type, depth, role) {
    if (!POSITION_TYPES.includes(type)) throw new Error('请选择有效的原生位置。');
    if (type === 'at_depth' && (!Number.isInteger(depth) || depth < 0)) throw new Error('深度必须是大于或等于 0 的整数。');
    if (type === 'at_depth' && !Object.hasOwn(ROLE_LABELS, role)) throw new Error('请选择有效的深度角色。');
    const ids = new Set(targetIds);
    const next = cloneJson(entries);
    next.forEach(entry => {
      if (!ids.has(entryId(entry))) return;
      if (!entry.position || typeof entry.position !== 'object' || Array.isArray(entry.position)) {
        throw new Error(`UID ${String(entry.uid)} 的位置不是 Tavern Helper 标准对象，已停止修改以避免重建字段。`);
      }
      entry.position.type = type;
      if (type === 'at_depth') {
        entry.position.depth = depth;
        entry.position.role = role;
      }
    });
    return next;
  }

  function mutateOrder(entries, targetIds, mode, start, gap) {
    if (!Number.isFinite(start)) throw new Error('起始顺序必须是有效数字。');
    if (!Number.isFinite(gap)) throw new Error('间隔必须是有效数字，允许为 0。');
    const ids = new Set(targetIds);
    const next = cloneJson(entries);
    let sequenceIndex = 0;
    next.forEach(entry => {
      if (!ids.has(entryId(entry))) return;
      if (!entry.position || typeof entry.position !== 'object' || Array.isArray(entry.position)) {
        throw new Error(`UID ${String(entry.uid)} 的位置不是 Tavern Helper 标准对象，已停止修改顺序。`);
      }
      entry.position.order = mode === 'same' ? start : start + gap * sequenceIndex;
      sequenceIndex += 1;
    });
    return next;
  }

  function changedIds(baseline, working, view = currentView) {
    if (view?.mixedMode && working === view.working) return mixedChangedIds(view);
    const baseById = new Map(baseline.map(entry => [entryId(entry), entry]));
    const workById = new Map(working.map(entry => [entryId(entry), entry]));
    const baseOrder = baseline.map(entryId);
    const workOrder = working.map(entryId);
    const changed = new Set();
    working.forEach((entry, index) => {
      const id = entryId(entry);
      if (jsonText(baseById.get(id)) !== jsonText(entry) || baseOrder[index] !== workOrder[index]) changed.add(id);
    });
    baseline.forEach(entry => {
      const id = entryId(entry);
      if (!workById.has(id)) changed.add(id);
    });
    return changed;
  }

  function isDirty(view) {
    if (view.mixedMode) return Boolean(mixedDirtyBooks(view).length || jsonText(mixedSlotSequence(view.working)) !== jsonText(view.slotBaseline || []));
    if (view.transferStates?.size) return transferDirtyBooks(view).length > 0;
    return Boolean(view.baseline && view.working && jsonText(view.baseline) !== jsonText(view.working));
  }

  function visibleEntries(view) {
    if (!view.working) return [];
    const query = view.query.trim().toLocaleLowerCase('zh-CN');
    const changed = changedIds(view.baseline, view.working, view);
    return view.working.filter(entry => {
      const id = entryId(entry);
      if (query && !searchText(entry).includes(query)) return false;
      if (view.positionFilter !== 'all' && positionInfo(entry).type !== view.positionFilter) return false;
      if (view.stateFilter === 'selected' && !view.selected.has(id)) return false;
      if (view.stateFilter === 'changed' && !changed.has(id)) return false;
      return true;
    });
  }

  /* IWB_V042_LIST_SELECTION_BEGIN */
  function hasActiveListFilters(view) {
    return Boolean(view.query.trim()) || view.stateFilter !== 'all' || view.positionFilter !== 'all';
  }

  function listSelectionScope(view, entries = visibleEntries(view)) {
    const filtered = hasActiveListFilters(view);
    const scopeEntries = filtered ? entries : (view.working || []);
    const scopeIds = scopeEntries.map(entryId);
    const selectedInScope = scopeIds.filter(id => view.selected.has(id)).length;
    const exactlySelected = scopeIds.length === view.selected.size && selectedInScope === scopeIds.length;
    const scopeName = filtered ? '当前结果' : view.mixedMode ? '当前总览' : '本书';
    const countText = filtered ? `显示 ${entries.length} / 共 ${view.working?.length || 0} 条` : `共 ${view.working?.length || 0} 条`;
    return { entries: scopeEntries, ids: scopeIds, filtered, scopeName, selectedInScope, exactlySelected, countText };
  }

  function selectListScope(view) {
    const scope = listSelectionScope(view);
    view.selected.clear();
    scope.ids.forEach(id => view.selected.add(id));
    return scope.ids.length;
  }

  function listContextHtml(view, entries) {
    const scope = listSelectionScope(view, entries);
    const label = scope.exactlySelected ? `已全选${scope.scopeName}` : `全选${scope.scopeName}`;
    return `<div class="qa-list-context"><span><strong>${escapeHtml(scope.countText)}</strong><small>已选 ${view.selected.size} 条</small></span><button class="qa-btn" data-action="select-list-scope" ${!scope.ids.length || scope.exactlySelected ? 'disabled' : ''}>${escapeHtml(label)}</button></div>`;
  }
  /* IWB_V042_LIST_SELECTION_END */

  function pushUndo(view, label) {
    view.undo.push({ working: cloneJson(view.working), label });
    if (view.undo.length > 30) view.undo.shift();
  }

  function applyWorking(view, label, factory, options = {}) {
    if (view.busy) return;
    const before = jsonText(view.working);
    const next = factory();
    assertUniqueEntries(next);
    if (jsonText(next) === before) {
      if (options.noOpMessage) toast('info', options.noOpMessage);
      return false;
    }
    pushUndo(view, label);
    view.working = next;
    if (options.expandId) view.expanded.add(options.expandId);
    if (options.removeId) {
      view.selected.delete(options.removeId);
      view.expanded.delete(options.removeId);
      view.tokenCounts.delete(options.removeId);
    }
    renderDynamic(view, { list: true });
    return true;
  }

  function syncFooterState(view) {
    const footer = view.root.querySelector('[data-slot="footer"]');
    const summary = pendingSummary(view);
    const count = footer?.querySelector('.qa-count');
    if (count) count.textContent = summary.text;
    const mobileSummary = footer?.querySelector('[data-slot="mobile-change-summary"]');
    if (mobileSummary) mobileSummary.textContent = mobilePendingSummary(view, summary);
    const undo = footer?.querySelector('[data-action="undo"]');
    const discard = footer?.querySelector('[data-action="discard"]');
    const save = footer?.querySelector('[data-action="save"]');
    if (undo) undo.disabled = !view.undo.length || Boolean(view.busy);
    if (discard) discard.disabled = !isDirty(view) || Boolean(view.busy);
    if (save) save.disabled = !isDirty(view) || Boolean(view.busy);
  }

  /* IWB_AUTHORITATIVE_CHANGED_MARKER_BEGIN */
  function applyWorkingQuiet(view, label, factory, cardId) {
    if (view.busy) return false;
    const before = jsonText(view.working);
    const next = factory();
    assertUniqueEntries(next);
    if (jsonText(next) === before) return false;
    pushUndo(view, label);
    view.working = next;
    const card = view.root.querySelector(`[data-entry-id="${cssEscape(cardId)}"]`);
    card?.classList.toggle('is-changed', changedIds(view.baseline, view.working, view).has(cardId));
    syncFooterState(view);
    return true;
  }
  /* IWB_AUTHORITATIVE_CHANGED_MARKER_END */

  function syncEnabledButton(button, entry) {
    const state = enabledPresentation(entry);
    button.setAttribute('aria-checked', String(state.checked));
    button.setAttribute('aria-label', state.label);
    button.setAttribute('title', state.title);
    button.disabled = state.disabled;
  }

  function toggleEnabledInPlace(view, cardId, button) {
    const changed = applyWorkingQuiet(view, '切换启用状态', () => mutateEntry(view.working, cardId, entry => {
      if (typeof entry.enabled !== 'boolean') throw new Error('当前条目的启用状态无法无损编辑。');
      entry.enabled = !entry.enabled;
    }), cardId);
    if (changed) {
      const entry = view.working.find(candidate => entryId(candidate) === cardId);
      if (entry) syncEnabledButton(button, entry);
    }
    return changed;
  }

  /* IWB_V042_BATCH_ENABLED_BEGIN */
  function batchSetEnabledEntries(entries, selectedIds, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('批量启用状态必须是布尔值。');
    const requested = new Set(selectedIds || []);
    const found = new Set();
    const changedIds = [];
    let skippedCount = 0;
    const next = (entries || []).map(entry => {
      const id = entryId(entry);
      const copy = cloneJson(entry);
      if (!requested.has(id)) return copy;
      found.add(id);
      if (typeof copy.enabled !== 'boolean' || copy.enabled === enabled) {
        skippedCount += 1;
        return copy;
      }
      copy.enabled = enabled;
      changedIds.push(id);
      return copy;
    });
    requested.forEach(id => { if (!found.has(id)) skippedCount += 1; });
    return { entries: next, changedIds, changedCount: changedIds.length, skippedCount };
  }

  function batchSetEnabledSelected(view, enabled, render = renderDynamic, notify = toast) {
    if (view.busy) return { changedCount: 0, skippedCount: view.selected.size, changed: false };
    const result = batchSetEnabledEntries(view.working, [...view.selected], enabled);
    const verb = enabled ? '启用' : '停用';
    if (!result.changedCount) {
      notify('info', `没有条目需要${verb}；跳过 ${result.skippedCount} 条。`);
      return { changedCount: 0, skippedCount: result.skippedCount, changed: false };
    }
    pushUndo(view, `批量${verb}条目`);
    view.working = result.entries;
    render(view, { list: true });
    notify('info', `已在工作副本中${verb} ${result.changedCount} 条；跳过 ${result.skippedCount} 条。`);
    return { changedCount: result.changedCount, skippedCount: result.skippedCount, changed: true };
  }
  /* IWB_V042_BATCH_ENABLED_END */

  /* IWB_BATCH_DELETE_HELPERS_BEGIN */
  function batchDeleteEntries(entries, selectedIds) {
    const requested = new Set(selectedIds || []);
    const removedIds = (entries || []).map(entryId).filter(id => requested.has(id));
    if (!removedIds.length) return { entries: cloneJson(entries || []), removedIds: [], count: 0 };
    const removed = new Set(removedIds);
    return { entries: (entries || []).filter(entry => !removed.has(entryId(entry))).map(cloneJson), removedIds, count: removedIds.length };
  }

  function clearEntryUiState(view, ids) {
    (ids || []).forEach(id => { view.selected.delete(id); view.expanded.delete(id); view.tokenCounts.delete(id); });
  }

  function batchDeleteSelected(view, render = renderDynamic, notify = toast) {
    if (view.busy) return { count: 0, changed: false };
    const requested = [...view.selected];
    const result = batchDeleteEntries(view.working, requested);
    if (!result.count) {
      clearEntryUiState(view, requested);
      view.panel = null;
      render(view, { list: true });
      notify('info', '所选条目已不存在，没有删除任何内容。');
      return { count: 0, changed: false };
    }
    pushUndo(view, '批量删除条目');
    view.working = result.entries;
    clearEntryUiState(view, result.removedIds);
    view.panel = null;
    render(view, { list: true });
    notify('info', `已从工作副本删除 ${result.count} 条，可撤销或放弃修改。`);
    return { count: result.count, changed: true };
  }
  /* IWB_BATCH_DELETE_HELPERS_END */

  function selectedIdsForCard(view, cardId) {
    return view.selected.has(cardId) && view.selected.size ? [...view.selected] : [cardId];
  }

  function optionHtml(value, label, selected) {
    return `<option value="${escapeHtml(value)}"${selected === value ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }

  const STYLES = `
    #iwb-qa-root{--qa-bg:var(--SmartThemeBlurTintColor,rgba(20,22,27,.97));--qa-card-bg:color-mix(in srgb,var(--qa-bg) 94%,var(--SmartThemeBodyColor,#eee) 6%);--qa-edit-bg:color-mix(in srgb,var(--qa-bg) 90%,var(--SmartThemeBodyColor,#eee) 10%);--qa-card-line:color-mix(in srgb,var(--SmartThemeBodyColor,#eee) 38%,var(--qa-bg) 62%);--qa-selected-line:#78bdff;--qa-panel-bg:color-mix(in srgb,var(--qa-bg) 88%,var(--SmartThemeBodyColor,#eee) 12%);--qa-panel-line:color-mix(in srgb,var(--SmartThemeBodyColor,#eee) 48%,var(--qa-bg) 52%);--qa-line:color-mix(in srgb,var(--SmartThemeBodyColor,#eee) 20%,transparent);color:var(--SmartThemeBodyColor,#eee);font:14px/1.4 system-ui,sans-serif;width:100%;max-width:760px;min-width:0;height:min(92dvh,900px);max-height:92dvh;margin:0 auto;overflow:hidden;position:relative}
    #iwb-qa-root *{box-sizing:border-box}#iwb-qa-root button,#iwb-qa-root input,#iwb-qa-root select,#iwb-qa-root textarea{font:inherit;color:inherit}
    .qa-shell{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:var(--qa-bg);border:1px solid var(--qa-line);border-radius:16px;overflow:hidden;box-shadow:0 18px 50px #0008}
    .qa-head{padding:8px 10px 7px;border-bottom:1px solid var(--qa-line);background:color-mix(in srgb,var(--qa-bg) 94%,#fff 6%);display:grid;gap:6px}
    .qa-title-row,.qa-book-row,.qa-tool-row,.qa-footer-row,.qa-summary-actions,.qa-content-head{display:flex;gap:5px;align-items:center;min-width:0}.qa-title{min-width:0;flex:1}.qa-title h2{font-size:16px;line-height:1.2;margin:0}.qa-title p{font-size:11px;opacity:.7;margin:2px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qa-mode-toggle[aria-pressed="true"]{border-color:var(--qa-selected-line);color:var(--qa-selected-line);background:color-mix(in srgb,var(--qa-selected-line) 10%,transparent)}
    .qa-icon{width:38px;min-width:38px;height:38px;border:1px solid transparent;border-radius:7px;background:transparent;display:grid;place-items:center}.qa-icon:hover,.qa-icon:focus-visible{border-color:var(--qa-line);background:#0002}.qa-icon:disabled{opacity:.38}.qa-mobile-close{display:none}.qa-book-row .qa-select{flex:1}
    .qa-input,.qa-select,.qa-textarea{width:100%;min-width:0;border:1px solid var(--qa-card-line);border-radius:6px;background:#0002;padding:0 8px}.qa-input,.qa-select{height:34px}.qa-textarea{min-height:150px;resize:vertical;padding-block:8px;line-height:1.5}.qa-status{font-size:11px;opacity:.78;overflow-wrap:anywhere}
    .qa-search-row{display:grid;grid-template-columns:minmax(0,1fr) 118px;gap:6px}.qa-search-row[hidden]{display:none}.qa-segments{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}.qa-segment{min-width:0;min-height:32px;border:1px solid var(--qa-card-line);border-radius:8px;background:#0002;padding:4px 5px;font-size:12px}.qa-segment.is-active{border-color:#78bdff;background:#267bc8;color:#fff;font-weight:700}
    .qa-scroll{min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;padding:6px 7px 10px;scrollbar-gutter:stable}.qa-empty{padding:28px 14px;text-align:center;opacity:.72}
    .qa-list{display:grid;gap:5px}.qa-card{position:relative;display:block;padding:5px 6px;border:1px solid color-mix(in srgb,var(--qa-card-line) 72%,transparent);border-radius:7px;background:var(--qa-card-bg);box-shadow:none}.qa-card.is-selected{border-color:var(--qa-selected-line);box-shadow:inset 2px 0 0 var(--qa-selected-line)}.qa-card.is-expanded{border-color:color-mix(in srgb,var(--qa-selected-line) 62%,var(--qa-card-line));background:var(--qa-card-bg);box-shadow:none}.qa-card.is-changed:after{content:'';position:absolute;right:5px;top:5px;width:6px;height:6px;border-radius:50%;background:#ffc45d}
    .qa-card-main{min-width:0}.qa-card-head{display:grid;grid-template-columns:24px minmax(0,1fr) 44px;column-gap:4px;align-items:center;min-width:0}.qa-check{position:static;width:20px;height:20px;margin:0;justify-self:center;accent-color:var(--qa-selected-line)}.qa-name-cell{min-width:0;min-height:48px;display:grid;align-content:center}.qa-name{width:100%;min-width:0;min-height:24px;padding:0;border:0;background:transparent;text-align:left;font-weight:700;font-size:14px;line-height:1.35;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;touch-action:manipulation}.qa-name-meta{min-width:0;margin-top:1px;font-size:10px;line-height:1.25;opacity:.62;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qa-name-edit{display:grid;grid-template-columns:minmax(0,1fr) 36px;gap:2px;align-items:center;min-width:0}.qa-name-input{width:100%;min-width:0;height:34px;border:1px solid var(--qa-selected-line);border-radius:6px;background:#0002;padding:0 7px}.qa-name-done{width:36px;min-width:36px;height:36px;padding:0;border:0;border-radius:6px;background:transparent;font-size:18px;font-weight:800;line-height:1;opacity:.82}.qa-name-done:hover,.qa-name-done:focus-visible{background:#0002;opacity:1}.qa-expand{width:44px;min-width:44px;height:44px;min-height:44px;padding:0;border:0;background:transparent;opacity:.82}.qa-inline-fields{width:100%;display:grid;gap:3px;margin-top:3px}.qa-inline-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}.qa-inline-field{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px;align-items:center;min-width:0}.qa-inline-field>span{font-size:10px;font-weight:700;opacity:.72;white-space:nowrap}.qa-inline-field .qa-input,.qa-inline-field .qa-select{height:32px;padding-inline:6px;font-size:12px}
    .qa-summary-actions{justify-content:flex-start;margin-top:2px;overflow-x:auto;scrollbar-width:none;gap:1px}.qa-action-icon,.qa-drag,.qa-move{flex:0 0 auto;min-width:40px;min-height:40px;border:1px solid transparent;border-radius:6px;background:transparent;padding:4px 6px}.qa-action-icon:hover,.qa-action-icon:focus-visible,.qa-drag:hover,.qa-drag:focus-visible,.qa-move:hover,.qa-move:focus-visible{border-color:var(--qa-line);background:#0002}.qa-action-icon{font-size:14px}.qa-delete:hover,.qa-delete:focus-visible,.qa-delete:active{color:#ff9f9f;border-color:#d96d6d;background:color-mix(in srgb,#9d2d2d 18%,transparent)}.qa-drag{touch-action:none;cursor:grab;font-size:15px}.qa-switch{position:relative;flex:0 0 44px;width:44px;height:44px;border:0;background:transparent;padding:0}.qa-switch:before{content:'';position:absolute;left:7px;top:13px;width:30px;height:18px;border:1px solid var(--qa-line);border-radius:10px;background:#0004;transition:background .12s,border-color .12s}.qa-switch:after{content:'';position:absolute;top:16px;left:10px;width:12px;height:12px;border-radius:50%;background:#aaa;transition:transform .12s,background .12s}.qa-switch[aria-checked="true"]:before{background:#36905a;border-color:#78d59b}.qa-switch[aria-checked="true"]:after{transform:translateX(12px);background:#fff}.qa-lamp{min-width:40px;font-size:18px;line-height:1;font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif;font-variant-emoji:emoji}.qa-lamp.readonly{opacity:.72}.qa-card.drop-before{box-shadow:inset 0 3px #70adff}.qa-card.drop-after{box-shadow:inset 0 -3px #70adff}
    .qa-editor{margin-top:3px;padding:5px 0 1px;border:0;border-top:1px solid var(--qa-line);border-radius:0;background:transparent;display:grid;gap:5px}.qa-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}.qa-field{display:grid;gap:2px;min-width:0}.qa-field>span,.qa-content-label>span{font-size:10px;font-weight:700;opacity:.78}.qa-field.qa-wide{grid-column:1/-1}.qa-advanced-note{font-size:10px;color:#ffd28a}.qa-content-label{display:flex;align-items:center;min-width:0}.qa-content-label>span{flex:1}.qa-content-uid{font:inherit;font-weight:400;opacity:.62}.qa-content-preview{width:100%;min-width:0;min-height:9.8em;max-height:12em;padding:6px 7px;border:0;border-left:2px solid var(--qa-line);border-radius:0;background:transparent;font-size:11px;line-height:1.4;display:block;overflow-x:hidden;overflow-y:auto;overflow-wrap:anywhere;white-space:pre-wrap}.qa-content-open{width:44px;min-width:44px;height:44px;min-height:44px;padding:0;border:0!important;border-radius:6px;background:transparent!important;box-shadow:none!important;display:grid;place-items:center;opacity:.76}.qa-content-open:hover,.qa-content-open:focus-visible{background:#0002!important;opacity:1}.qa-keyword-editor{display:flex;flex-wrap:wrap;gap:4px;align-items:flex-end;min-width:0}.qa-keyword-chip{display:inline-flex;align-items:center;gap:3px;max-width:100%;min-height:26px;padding:2px 4px 2px 7px;border:1px solid var(--qa-line);border-radius:999px;background:#0002;font-size:11px}.qa-keyword-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qa-keyword-remove{width:24px;height:24px;padding:0;border:0;border-radius:50%;background:transparent;opacity:.72}.qa-keyword-remove:hover,.qa-keyword-remove:focus-visible{background:#0003;opacity:1}.qa-keyword-input{flex:1 1 116px;min-width:92px;height:31px;max-height:62px;resize:none;border:0;border-bottom:1px solid var(--qa-card-line);border-radius:0;background:transparent;padding:5px 4px;line-height:20px;outline-offset:2px}.qa-keyword-add{min-width:44px;min-height:36px}
    .qa-content-layer{position:absolute;inset:0;z-index:20;display:grid;grid-template-rows:auto minmax(0,1fr);background:var(--qa-bg);min-width:0;min-height:0}.qa-content-layer[hidden]{display:none}.qa-content-head{padding:calc(8px + env(safe-area-inset-top)) 8px 8px;border-bottom:1px solid var(--qa-line);background:color-mix(in srgb,var(--qa-bg) 94%,#fff 6%)}.qa-content-context{flex:1;min-width:0}.qa-content-context strong,.qa-content-context small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qa-content-context small{font-size:11px;opacity:.7;margin-top:2px}.qa-content-body{min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);gap:6px;padding:8px calc(8px + env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) calc(8px + env(safe-area-inset-left))}.qa-content-token{font-size:11px;opacity:.75}.qa-content-textarea{width:100%;height:100%;min-height:0;resize:none;border:1px solid var(--qa-card-line);border-radius:10px;background:#0003;padding:10px;line-height:1.55}
    .qa-more{width:100%;margin-top:8px;min-height:38px;border:1px dashed var(--qa-line);border-radius:7px;background:transparent}.qa-footer{position:relative;border-top:1px solid var(--qa-line);background:color-mix(in srgb,var(--qa-bg) 96%,#fff 4%);padding:5px 6px calc(5px + env(safe-area-inset-bottom));display:grid;gap:4px}.qa-footer-row{overflow-x:auto;scrollbar-width:none}.qa-batch-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}.qa-batch-actions .qa-btn{width:100%;min-width:0;height:34px;min-height:34px;padding-inline:3px;font-size:12px;line-height:1;white-space:nowrap;overflow:hidden}.qa-footer-bottom{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px;align-items:center;min-width:0}.qa-main-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) minmax(0,1.35fr);gap:4px;align-items:center;min-width:0}.qa-main-actions .qa-btn{width:100%;min-width:0;padding-inline:3px;white-space:nowrap}.qa-count{min-width:64px;font-size:11px;line-height:1.25;overflow-wrap:anywhere}.qa-count-narrow{display:none}.qa-btn{flex:0 0 auto;min-height:34px;border:1px solid var(--qa-line);border-radius:7px;background:transparent;padding:5px 8px}.qa-btn:hover,.qa-btn:focus-visible{background:#0002}.qa-btn.primary{background:#377fd5;border-color:#5b9ce8;color:#fff}.qa-btn.danger{color:#ffb7b7}.qa-btn:disabled{opacity:.38}.qa-panel{border:1px solid var(--qa-panel-line);border-radius:7px;padding:6px;background:var(--qa-panel-bg);display:grid;gap:5px}.qa-panel h3{font-size:13px;margin:0}.qa-panel-note{font-size:11px;opacity:.78;overflow-wrap:anywhere}.qa-leave{border-color:#e6aa55}.qa-loading{pointer-events:none;opacity:.65}
    .qa-guide-layer{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:calc(12px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right)) calc(12px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left))}.qa-guide-layer[hidden]{display:none}.qa-guide-backdrop{position:absolute;inset:0;border:0;background:#0009}.qa-guide-dialog{position:relative;z-index:1;width:min(420px,100%);max-height:min(78dvh,520px);display:grid;grid-template-rows:auto minmax(0,1fr);border:1px solid var(--qa-panel-line);border-radius:10px;background:var(--qa-bg);box-shadow:0 18px 48px #000a;overflow:hidden}.qa-guide-head{display:flex;align-items:center;gap:6px;padding:8px 8px 6px;border-bottom:1px solid var(--qa-line)}.qa-guide-head h3{flex:1;min-width:0;margin:0;font-size:15px}.qa-guide-body{min-height:0;overflow:auto;padding:10px 12px}.qa-guide-body ul{margin:0;padding-left:19px;display:grid;gap:8px}
    .iwb-qa-host{width:min(760px,calc(100dvw - 8px))!important;max-width:calc(100dvw - 8px)!important;min-width:0!important;margin-inline:auto!important;padding-inline:0!important;overflow:hidden!important}.iwb-qa-host .popup-body,.iwb-qa-host .popup-content{box-sizing:border-box!important;width:100%!important;max-width:100%!important;min-width:0!important;margin-inline:0!important;padding-inline:0!important;overflow-x:hidden!important}.qa-shell,.qa-head,.qa-title-row,.qa-book-row,.qa-search-row,.qa-status,.qa-scroll,.qa-list,.qa-card,.qa-card-main,.qa-footer,.qa-panel,.qa-fields,.qa-content-layer,.qa-content-body{box-sizing:border-box;width:100%;max-width:100%;min-width:0}
    .qa-footer{max-height:58%;overflow-y:auto}.qa-tool-actions{display:grid;grid-template-columns:minmax(0,1.7fr) repeat(2,minmax(0,1fr));gap:4px}.qa-tool-actions .qa-btn{min-width:0;padding-inline:4px;white-space:nowrap;overflow:hidden}.qa-arrange-list{max-height:156px;overflow:auto;display:grid;gap:3px}.qa-arrange-row{display:grid;grid-template-columns:minmax(0,1fr) 38px 38px;gap:4px;align-items:center}.qa-arrange-row span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qa-arrange-row .qa-btn{padding:3px;min-height:32px}.qa-import-list{max-height:190px;overflow:auto;display:grid;gap:3px;padding:2px}.qa-import-item{display:grid;grid-template-columns:26px minmax(0,1fr);gap:5px;align-items:center;min-height:34px;padding:2px 4px;border:1px solid var(--qa-line);border-radius:6px}.qa-import-item span{min-width:0;overflow-wrap:anywhere}.qa-import-summary{font-size:11px;opacity:.78}
    .qa-leave-layer{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;padding:16px;overflow:auto;overscroll-behavior:contain}.qa-leave-layer[hidden]{display:none}.qa-leave-backdrop{position:absolute;inset:0;background:#000a}.qa-leave-dialog{position:relative;z-index:1;width:min(100%,380px);max-height:calc(100dvh - 32px);overflow:auto;display:grid;gap:12px;padding:16px;border:1px solid var(--qa-card-line);border-radius:12px;background:var(--qa-bg);box-shadow:0 20px 60px #000b}.qa-leave-dialog h3{margin:0;font-size:17px}.qa-leave-dialog p{margin:0;line-height:1.5}.qa-leave-error{padding:8px;border-radius:7px;background:color-mix(in srgb,#b93232 18%,var(--qa-bg));color:#ffd5d5;font-size:12px}.qa-leave-actions{display:grid;grid-template-columns:1fr;gap:7px}.qa-leave-actions .qa-btn{width:100%;min-height:40px}.qa-leave-open .qa-scroll,.qa-leave-open .qa-workspace-panel{overflow:hidden!important}.qa-top-grid{display:grid;grid-template-columns:minmax(0,1fr) 92px;gap:7px;align-items:stretch}.qa-top-grid>.qa-top-left,.qa-top-grid>.qa-top-right{min-width:0;width:100%;height:34px}.qa-filter-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;min-width:0}.qa-filter-pair>.qa-input,.qa-filter-pair>.qa-select{min-width:0;width:100%;height:34px;padding-inline:5px;white-space:nowrap}.qa-mode-segments{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:5px!important}.qa-title-lock{white-space:nowrap;padding-inline:4px}.qa-import-workspace{min-height:100%;display:grid;align-content:start;gap:9px;padding:8px}.qa-import-workspace h3{margin:0 0 3px}.qa-import-body{display:grid;gap:7px;min-height:0}.qa-import-selection-note{font-size:11px;opacity:.72}.qa-import-actions{position:sticky;bottom:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;padding:7px 0 2px;background:var(--qa-bg);z-index:2}.qa-import-actions .qa-btn{min-width:0}.qa-import-active .qa-filter-pair,.qa-import-active .qa-top-grid>[data-action="other-tools"],.qa-import-active [data-slot="other-tools"],.qa-import-active [data-slot="status"]{display:none!important}.qa-scroll.qa-import-mode{padding:0}.qa-shell{grid-template-rows:auto auto minmax(0,1fr) auto}.qa-title h2{font-size:17px}.qa-title p{display:none}.qa-book-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:end}.qa-new-top{min-width:92px;white-space:nowrap}.qa-mode-segments{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.qa-mode-segment{height:34px;border:1px solid var(--qa-card-line);border-radius:7px;background:#0002}.qa-mode-segments .qa-mode-segment{background:#fff;color:#1b1f24!important;border-color:#d7dce2}.qa-mode-segments .qa-mode-segment.is-active{border-color:var(--qa-selected-line);background:#267bc8;color:#fff!important;font-weight:700}.qa-filter-pair input[data-control="search"]{background:#fff;color:#1b1f24!important;border-color:#d7dce2}.qa-filter-pair [data-control="search"]::placeholder{color:#69717c;opacity:1}.qa-compact-tools{display:grid;grid-template-columns:minmax(66px,.55fr) minmax(146px,1.45fr) auto;gap:5px}.qa-compact-tools .qa-input,.qa-compact-tools .qa-select,.qa-compact-tools .qa-btn{min-width:0;width:100%;padding-inline:5px;white-space:nowrap}.qa-other-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;padding-top:2px}.qa-other-tools[hidden]{display:none}.qa-other-tools .qa-btn{min-width:0;white-space:normal}.qa-other-tools .qa-btn:last-child{grid-column:1/-1}.qa-workspace-panel{max-height:min(45dvh,380px);overflow-y:auto;padding:5px 6px;border-bottom:1px solid var(--qa-line);background:var(--qa-bg)}.qa-workspace-panel[hidden]{display:none}.qa-footer{max-height:40%;overflow-y:auto}.qa-selection-context{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:4px;align-items:center}.qa-save-bar{display:grid;grid-template-columns:minmax(68px,1fr) repeat(2,minmax(56px,.75fr)) minmax(78px,1fr);gap:4px;align-items:center}.qa-save-bar .qa-btn{min-width:0;padding-inline:4px}.qa-batch-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}.qa-arrange-row{grid-template-columns:minmax(0,1fr) 92px 36px 36px}.qa-arrange-label{display:grid;min-width:0}.qa-arrange-label span{overflow-wrap:anywhere}.qa-arrange-label small{font-size:10px;opacity:.68}.qa-recursion-status{display:flex;flex-wrap:wrap;gap:2px 7px;font-size:10px;font-weight:400;opacity:.62;margin-left:5px}.qa-content-label{flex-wrap:wrap}.qa-content-label>span:first-child{flex:0 1 auto}.qa-content-open{margin-left:auto}.qa-mode-lock{width:44px;text-align:center;opacity:.45}.qa-name-readonly{cursor:default}
    @media(max-width:340px){#iwb-qa-root .qa-filter-pair select[data-control="state-filter-select"]{font-size:8px!important;padding-inline:0!important}.qa-compact-tools{grid-template-columns:minmax(66px,.55fr) minmax(146px,1.45fr) auto;gap:5px}.qa-save-bar{grid-template-columns:1fr 1fr}.qa-save-bar .primary{grid-column:2}.qa-arrange-row{grid-template-columns:minmax(0,1fr) 82px 32px 32px}}
    @media(max-width:480px){
      .iwb-qa-host{position:fixed!important;top:var(--iwb-qa-vv-top,0px)!important;left:var(--iwb-qa-vv-left,0px)!important;right:auto!important;bottom:auto!important;width:var(--iwb-qa-vv-width,100dvw)!important;max-width:none!important;height:var(--iwb-qa-vv-height,100dvh)!important;max-height:none!important;margin:0!important;padding:0!important;border-radius:0!important;transform:none!important;overflow:hidden!important}.iwb-qa-host .popup-body{display:flex!important;flex-direction:column!important;width:100%!important;height:100%!important;max-height:100%!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important}.iwb-qa-host .popup-content{flex:1 1 auto!important;width:100%!important;height:100%!important;max-height:100%!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important}
      #iwb-qa-root{width:100%!important;height:100%!important;max-width:100%!important;max-height:100%!important;min-width:0!important;min-height:0!important;margin:0!important;overflow:hidden!important}.qa-shell{width:100%;height:100%;max-height:100%;min-height:0;grid-template-rows:auto minmax(0,1fr) auto;border-radius:0}.qa-head{grid-row:1;z-index:2;padding-top:calc(6px + env(safe-area-inset-top));padding-left:calc(7px + env(safe-area-inset-left));padding-right:calc(7px + env(safe-area-inset-right))}.iwb-qa-host .popup-button-close{display:none!important}.qa-mobile-close{display:grid;flex:0 0 40px;width:40px;min-width:40px;height:40px;min-height:40px;border:1px solid transparent;background:transparent;font-size:22px;touch-action:manipulation}.qa-scroll{grid-row:2;min-height:0;max-height:none;padding:5px calc(5px + env(safe-area-inset-right)) 8px calc(5px + env(safe-area-inset-left));scrollbar-gutter:auto}.qa-footer{grid-row:3;z-index:3;padding:5px calc(5px + env(safe-area-inset-right)) calc(5px + env(safe-area-inset-bottom)) calc(5px + env(safe-area-inset-left));overflow:visible}.qa-fields{grid-template-columns:1fr 1fr}.qa-fields .qa-wide{grid-column:1/-1}.qa-footer-row{align-items:stretch}.qa-keyboard-open:not(.qa-content-editing) .qa-title,.qa-keyboard-open:not(.qa-content-editing) .qa-status,.qa-keyboard-open:not(.qa-content-editing) .qa-segments,.qa-keyboard-open:not(.qa-content-editing) .qa-tool-row{display:none}.qa-keyboard-open:not(.qa-content-editing) .qa-title-row{justify-content:flex-end}.qa-keyboard-open:not(.qa-content-editing) .qa-head{padding-top:calc(4px + env(safe-area-inset-top));gap:3px}.qa-keyboard-open:not(.qa-content-editing) .qa-footer{padding-top:4px;gap:4px}.qa-keyboard-open .qa-btn{min-height:31px;padding-block:3px}.qa-keyboard-open:not(.qa-content-editing) .qa-scroll{padding-top:4px}.qa-content-editing .qa-content-head{padding-top:calc(5px + env(safe-area-inset-top));padding-bottom:5px}
    }
    .qa-other-tools>.qa-btn{grid-column:auto}.qa-other-tools>.qa-btn[data-action="reload"]{grid-column:1/-1}.qa-source-locked{opacity:.58;cursor:not-allowed}.qa-transfer-workspace{height:100%;min-height:0!important;display:flex!important;flex-direction:column;align-content:stretch!important;overflow:hidden}.qa-workspace-title{display:flex;align-items:center;justify-content:space-between;gap:6px}.qa-workspace-title h3{margin:0;min-width:0}.qa-transfer-filter{display:grid;grid-template-columns:minmax(0,1fr) minmax(92px,.38fr);gap:6px}.qa-transfer-select-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}.qa-transfer-workspace>[data-slot="transfer-results"]{flex:1 1 0;min-height:0;display:flex;flex-direction:column;overflow:hidden}.qa-transfer-list{flex:1 1 0;min-height:0;height:auto;max-height:none;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}.qa-transfer-item{grid-template-columns:26px minmax(0,1fr) max-content;min-height:34px;height:34px;overflow:hidden}.qa-transfer-name{display:block;min-width:0;overflow:hidden!important;white-space:nowrap;text-overflow:ellipsis;overflow-wrap:normal!important}.qa-transfer-uid{white-space:nowrap;min-width:max-content}.qa-transfer-workspace .qa-import-summary{flex:0 0 auto;padding-top:5px}.qa-transfer-actions{flex:0 0 auto;position:static!important}.qa-transfer-targets{display:grid;gap:6px;overflow-y:auto;min-height:0}.qa-transfer-target{text-align:left;min-height:40px}.qa-transfer-actions .qa-btn{font-weight:700}.qa-arrange-workspace{min-height:100%;display:grid;align-content:start;padding:8px}.qa-arrange-workspace .qa-panel{min-height:100%;align-content:start}.qa-arrange-workspace .qa-arrange-list{max-height:none;overflow:visible}.qa-arrange-active .qa-filter-pair,.qa-arrange-active .qa-top-grid>[data-action="other-tools"],.qa-arrange-active [data-slot="other-tools"],.qa-arrange-active [data-slot="status"]{display:none!important}.qa-source{font-size:10px;color:var(--SmartThemeEmColor,#8b93a3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;line-height:1.25}.qa-top-right.primary{background:color-mix(in srgb,var(--SmartThemeQuoteColor,#4f86c6) 28%,var(--SmartThemeBlurTintColor,#fff));border-color:var(--SmartThemeQuoteColor,#4f86c6)}
    @media(max-width:340px){.qa-title h2{font-size:14px}.qa-book-row .qa-btn{padding-inline:6px}.qa-btn{font-size:12px;padding-inline:6px}.qa-card{padding:5px}.qa-summary-actions{gap:0}.qa-action-icon,.qa-drag,.qa-move{padding-inline:5px}.qa-batch-actions{grid-template-columns:repeat(4,minmax(0,1fr));gap:3px}.qa-batch-actions .qa-btn{font-size:11px;padding-inline:1px}.qa-footer-bottom{gap:3px}.qa-count{min-width:48px;font-size:10px}.qa-count-wide{display:none}.qa-count-narrow{display:inline}.qa-main-actions{gap:3px}.qa-main-actions .qa-btn{font-size:11px;padding-inline:1px}.qa-search-row{grid-template-columns:1fr}.qa-position-filter{display:none}}

    /* =========================================================
       雾墨青蓝 · Light Theme
       仅视觉覆盖，不修改功能、数据与交互逻辑
       ========================================================= */
    #iwb-qa-root{
      --qa-bg:#F5F7F8;
      --qa-card-bg:#FFFFFF;
      --qa-edit-bg:#F1F4F6;
      --qa-card-line:#E1E7EB;
      --qa-selected-line:#8BB7D5;
      --qa-panel-bg:#FFFFFF;
      --qa-panel-line:#D5DEE4;
      --qa-line:#E1E7EB;

      --qa-surface:#FFFFFF;
      --qa-surface-soft:#F1F4F6;
      --qa-surface-blue:#F3F8FC;
      --qa-text:#27313A;
      --qa-muted:#7B8792;
      --qa-accent:#5B8FB9;
      --qa-accent-strong:#4C7FA8;
      --qa-accent-soft:#EAF2F8;
      --qa-accent-line:#8BB7D5;
      --qa-green:#65A982;
      --qa-green-line:#86C7A0;
      --qa-warning:#D7A85B;
      --qa-danger:#C96F6F;
      --qa-danger-soft:#FBEFEF;
      --qa-shadow:0 5px 18px rgba(61,78,92,.08);
      --qa-shadow-soft:0 2px 8px rgba(61,78,92,.06);

      color:var(--qa-text)!important;
      background:var(--qa-bg);
    }

    #iwb-qa-root button,
    #iwb-qa-root input,
    #iwb-qa-root select,
    #iwb-qa-root textarea{
      color:var(--qa-text);
    }

    .qa-shell{
      background:var(--qa-bg);
      border-color:var(--qa-line);
      box-shadow:0 18px 50px rgba(57,72,84,.15);
    }

    .qa-head{
      background:color-mix(in srgb,var(--qa-bg) 96%,#fff 4%);
      border-bottom-color:var(--qa-line);
    }

    .qa-title h2{
      color:#22313D;
      letter-spacing:.01em;
    }

    .qa-icon,
    .qa-mobile-close{
      color:#3E5363;
    }

    .qa-icon:hover,
    .qa-icon:focus-visible,
    .qa-mobile-close:hover,
    .qa-mobile-close:focus-visible{
      border-color:#DCE5EA;
      background:var(--qa-accent-soft);
    }

    /* 顶部分段模式：浅灰轨道 + 白色当前项 */
    .qa-mode-segments{
      padding:4px;
      gap:4px!important;
      border:1px solid #E3E9ED;
      border-radius:13px;
      background:#EBF0F3;
    }

    .qa-mode-segments .qa-mode-segment{
      min-height:40px;
      border:1px solid transparent;
      border-radius:10px;
      background:transparent;
      color:#4B5D69!important;
      box-shadow:none;
    }

    .qa-mode-segments .qa-mode-segment:hover,
    .qa-mode-segments .qa-mode-segment:focus-visible{
      background:rgba(255,255,255,.58);
      border-color:#E0E7EB;
    }

    .qa-mode-segments .qa-mode-segment.is-active{
      border-color:#DDE6EC;
      background:var(--qa-surface);
      color:#365E7F!important;
      font-weight:700;
      box-shadow:0 2px 7px rgba(58,82,101,.10);
    }

    .qa-mode-segments .qa-title-lock[aria-pressed="true"]{
      background:var(--qa-accent-soft);
      border-color:#D8E6F0;
      color:#426C8D!important;
      box-shadow:none;
    }

    /* 世界书 / 搜索 / 筛选 */
    .qa-book-row .qa-select,
    .qa-filter-pair input[data-control="search"],
    .qa-filter-pair .qa-select,
    .qa-transfer-filter .qa-input,
    .qa-transfer-filter .qa-select,
    .qa-import-workspace>.qa-select,
    .qa-import-workspace .qa-input{
      background:var(--qa-surface)!important;
      color:var(--qa-text)!important;
      border-color:var(--qa-line)!important;
      box-shadow:var(--qa-shadow-soft);
    }

    .qa-book-row .qa-select{
      border-radius:13px;
      font-weight:650;
    }

    .qa-filter-pair [data-control="search"]::placeholder,
    .qa-transfer-filter .qa-input::placeholder,
    .qa-import-workspace .qa-input::placeholder{
      color:#8B98A2;
      opacity:1;
    }

    .qa-top-right,
    .qa-btn{
      border-color:var(--qa-line);
      color:#536571;
      background:var(--qa-surface);
    }

    .qa-top-right:hover,
    .qa-top-right:focus-visible,
    .qa-btn:hover,
    .qa-btn:focus-visible{
      background:var(--qa-accent-soft);
      border-color:#D6E4EE;
    }

    .qa-top-right.primary,
    .qa-btn.primary{
      background:var(--qa-accent)!important;
      border-color:var(--qa-accent)!important;
      color:#fff!important;
      box-shadow:0 4px 12px rgba(91,143,185,.20);
    }

    .qa-top-right.primary:hover,
    .qa-top-right.primary:focus-visible,
    .qa-btn.primary:hover,
    .qa-btn.primary:focus-visible{
      background:var(--qa-accent-strong)!important;
      border-color:var(--qa-accent-strong)!important;
    }

    .qa-status{
      color:var(--qa-muted);
      opacity:1;
    }

    /* 其它工具：白色工具卡 */
    .qa-other-tools{
      gap:8px;
      padding-top:5px;
    }

    .qa-other-tools .qa-btn{
      min-height:50px;
      border-radius:13px;
      background:var(--qa-surface);
      border-color:var(--qa-line);
      color:#334A5A;
      box-shadow:var(--qa-shadow-soft);
    }

    .qa-other-tools .qa-btn:hover,
    .qa-other-tools .qa-btn:focus-visible{
      background:var(--qa-accent-soft);
      border-color:#D5E4EF;
    }

    .qa-other-tools .qa-btn[data-action="disable-recursion"]{
      color:#A65D5D;
      background:#FFFDFD;
    }

    .qa-other-tools .qa-btn[data-action="disable-recursion"]:hover,
    .qa-other-tools .qa-btn[data-action="disable-recursion"]:focus-visible{
      background:var(--qa-danger-soft);
      border-color:#E9CACA;
    }

    /* 列表区域 */
    .qa-scroll{
      background:var(--qa-bg);
    }

    .qa-list{
      gap:8px;
    }

    .qa-card{
      padding:8px 9px;
      border:1px solid var(--qa-line);
      border-radius:14px;
      background:var(--qa-surface);
      box-shadow:var(--qa-shadow);
    }

    .qa-card.is-selected{
      border-color:var(--qa-accent-line);
      background:var(--qa-surface-blue);
      box-shadow:inset 3px 0 0 var(--qa-accent),var(--qa-shadow);
    }

    .qa-card.is-expanded{
      border-color:var(--qa-line);
      background:var(--qa-surface);
      box-shadow:var(--qa-shadow);
    }

    .qa-card.is-changed:after{
      width:7px;
      height:7px;
      right:8px;
      top:8px;
      background:var(--qa-warning);
    }

    .qa-check{
      accent-color:var(--qa-accent);
    }

    .qa-name{
      color:#263844;
    }

    .qa-name-meta,
    .qa-source{
      color:var(--qa-muted);
      opacity:1;
    }

    .qa-expand,
    .qa-mode-lock{
      color:#536A79;
    }

    /* 卡片内字段：雾灰信息槽 */
    .qa-inline-field .qa-input,
    .qa-inline-field .qa-select,
    .qa-field .qa-input,
    .qa-field .qa-select{
      background:var(--qa-surface-soft);
      border-color:#E9EEF1;
      color:var(--qa-text);
      border-radius:11px;
    }

    .qa-inline-field>span,
    .qa-field>span,
    .qa-content-label>span{
      color:#697985;
      opacity:1;
    }

    .qa-name-input{
      background:var(--qa-surface);
      border-color:var(--qa-accent-line);
      color:var(--qa-text);
      box-shadow:0 0 0 2px rgba(91,143,185,.08);
    }

    .qa-name-done:hover,
    .qa-name-done:focus-visible{
      background:var(--qa-accent-soft);
    }

    /* 卡片操作区 */
    .qa-summary-actions{
      border-top:0;
    }

    .qa-action-icon,
    .qa-drag,
    .qa-move{
      color:#536A79;
    }

    .qa-action-icon:hover,
    .qa-action-icon:focus-visible,
    .qa-drag:hover,
    .qa-drag:focus-visible,
    .qa-move:hover,
    .qa-move:focus-visible{
      border-color:#D9E4EA;
      background:var(--qa-accent-soft);
    }

    .qa-delete{
      color:var(--qa-danger);
    }

    .qa-delete:hover,
    .qa-delete:focus-visible,
    .qa-delete:active{
      color:#B95858;
      border-color:#E4BABA;
      background:var(--qa-danger-soft);
    }

    .qa-switch:before{
      border-color:#D6DEE3;
      background:#D8DEE2;
    }

    .qa-switch:after{
      background:#fff;
      box-shadow:0 1px 4px rgba(48,62,72,.22);
    }

    .qa-switch[aria-checked="true"]:before{
      background:var(--qa-green);
      border-color:var(--qa-green-line);
    }

    .qa-switch[aria-checked="true"]:after{
      background:#fff;
    }

    /* 展开编辑区域 */
    .qa-editor{
      border-top-color:#E9EEF1;
    }

    .qa-content-preview{
      border-left-color:#D8E3E9;
      color:#40525E;
      background:#FAFBFC;
      border-radius:0 10px 10px 0;
      padding:8px 9px;
    }

    .qa-keyword-chip{
      border-color:#DCE5EA;
      background:var(--qa-accent-soft);
      color:#426681;
    }

    .qa-keyword-remove:hover,
    .qa-keyword-remove:focus-visible{
      background:#DCEAF4;
    }

    .qa-keyword-input{
      border-bottom-color:#CBD8E0;
      color:var(--qa-text);
    }

    .qa-advanced-note{
      color:#A27A3F;
    }

    /* 工作台 / 导入 / 转移 / 整理 */
    .qa-workspace-panel{
      background:var(--qa-bg);
      border-bottom-color:var(--qa-line);
    }

    .qa-panel{
      border-color:var(--qa-line);
      border-radius:13px;
      background:var(--qa-surface);
      box-shadow:var(--qa-shadow-soft);
    }

    .qa-panel-note,
    .qa-import-selection-note,
    .qa-import-summary{
      color:var(--qa-muted);
      opacity:1;
    }

    .qa-import-item{
      border-color:var(--qa-line);
      border-radius:10px;
      background:var(--qa-surface);
    }

    .qa-import-item:hover{
      background:var(--qa-accent-soft);
      border-color:#D6E4EE;
    }

    .qa-transfer-target{
      background:var(--qa-surface);
      border-color:var(--qa-line);
      border-radius:11px;
      box-shadow:var(--qa-shadow-soft);
    }

    .qa-arrange-workspace,
    .qa-import-workspace{
      background:var(--qa-bg);
    }

    .qa-import-actions{
      background:var(--qa-bg);
    }

    .qa-source-locked{
      opacity:.62;
    }

    /* 全屏正文 */
    .qa-content-layer{
      background:var(--qa-bg);
    }

    .qa-content-head{
      background:color-mix(in srgb,var(--qa-bg) 96%,#fff 4%);
      border-bottom-color:var(--qa-line);
    }

    .qa-content-textarea{
      background:var(--qa-surface);
      border-color:var(--qa-line);
      color:var(--qa-text);
      box-shadow:var(--qa-shadow-soft);
    }

    .qa-content-token{
      color:var(--qa-muted);
      opacity:1;
    }

    /* 新手指引与离开提醒 */
    .qa-guide-dialog,
    .qa-leave-dialog{
      background:var(--qa-surface);
      border-color:var(--qa-line);
      color:var(--qa-text);
      box-shadow:0 20px 60px rgba(42,55,65,.20);
    }

    .qa-guide-head{
      border-bottom-color:var(--qa-line);
    }

    .qa-guide-backdrop,
    .qa-leave-backdrop{
      background:rgba(39,49,58,.48);
      backdrop-filter:blur(2px);
    }

    .qa-leave-error{
      background:var(--qa-danger-soft);
      color:#9F5050;
    }

    /* 底部保存区 */
    .qa-footer{
      background:rgba(255,255,255,.97);
      border-top-color:var(--qa-line);
      box-shadow:0 -5px 18px rgba(61,78,92,.06);
      backdrop-filter:blur(14px);
    }

    .qa-selection-context{
      padding:5px 6px;
      border:1px solid #D9E7F0;
      border-radius:11px;
      background:var(--qa-accent-soft);
      color:#426681;
    }

    .qa-count{
      color:#667985;
    }

    .qa-save-bar .qa-btn{
      border-radius:10px;
      background:var(--qa-surface);
    }

    .qa-save-bar .qa-btn.danger{
      color:var(--qa-danger);
      background:#FFFDFD;
    }

    .qa-save-bar .qa-btn.danger:hover,
    .qa-save-bar .qa-btn.danger:focus-visible{
      background:var(--qa-danger-soft);
      border-color:#E9CACA;
    }

    .qa-save-bar .qa-btn.primary{
      background:var(--qa-accent)!important;
      color:#fff!important;
      border-color:var(--qa-accent)!important;
      box-shadow:0 4px 12px rgba(91,143,185,.18);
    }

    .qa-btn:disabled,
    .qa-icon:disabled{
      opacity:.42;
    }

    .qa-more{
      border-color:#CAD8E0;
      color:#607583;
      background:rgba(255,255,255,.45);
    }

    .qa-more:hover,
    .qa-more:focus-visible{
      background:var(--qa-accent-soft);
      border-color:var(--qa-accent-line);
    }

    .qa-card.drop-before{
      box-shadow:inset 0 3px var(--qa-accent),var(--qa-shadow);
    }

    .qa-card.drop-after{
      box-shadow:inset 0 -3px var(--qa-accent),var(--qa-shadow);
    }

    @media(max-width:480px){
      .qa-shell{
        background:var(--qa-bg);
      }

      .qa-head{
        padding-bottom:9px;
      }

      .qa-card{
        border-radius:13px;
        padding:8px;
      }

      .qa-other-tools .qa-btn{
        min-height:48px;
      }

      .qa-footer{
        background:rgba(255,255,255,.98);
      }
    }


    /* IWB_GUIDE_REFINEMENT_BEGIN：用户批准的指引二次优化，仅限 .qa-guide-*。 */
    .qa-guide-dialog,.qa-guide-body{
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei UI","Noto Sans CJK SC",sans-serif;
      color:#334653;
    }
    .qa-guide-head h3,.qa-guide-section h4{font-weight:600;color:#294557}
    .qa-guide-body{font-weight:400;line-height:1.65;background:#F5F7F8}
    .qa-guide-quick{
      margin:0 0 10px;
      padding:9px 11px;
      border:1px solid #D7E5EE;
      border-radius:10px;
      background:#EAF2F8;
      color:#426681;
    }
    .qa-guide-section{
      margin:0 0 9px;
      padding:10px 11px;
      border:1px solid #E1E7EB;
      border-radius:11px;
      background:#FFFFFF;
      box-shadow:0 2px 8px rgba(61,78,92,.05);
    }
    .qa-guide-section h4{margin:0 0 6px;font-size:14px}
    .qa-guide-section ul{margin:0;padding-left:18px;gap:6px}
    .qa-guide-section li{color:#536571}
    .qa-guide-section strong{font-weight:600;color:#334A5A}
    .qa-guide-about{margin-bottom:0;text-align:center;color:#7B8792}
    .qa-guide-about p{margin:2px 0}
    /* IWB_GUIDE_REFINEMENT_END */

    /* IWB_IMPORT_LAYOUT_FIX_BEGIN */
    .qa-import-workspace:not(.qa-transfer-workspace){height:100%;min-height:0;display:flex;flex-direction:column;align-content:stretch;overflow:hidden}
    .qa-import-workspace:not(.qa-transfer-workspace)>.qa-import-body{flex:1 1 0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
    .qa-import-workspace:not(.qa-transfer-workspace)>.qa-import-body>[data-slot="import-results"]{flex:1 1 0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
    .qa-import-workspace:not(.qa-transfer-workspace) .qa-import-list{flex:1 1 0;min-height:0;height:auto;max-height:none;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
    .qa-import-workspace:not(.qa-transfer-workspace) .qa-import-summary{flex:0 0 auto}
    .qa-import-workspace:not(.qa-transfer-workspace)>.qa-import-actions{flex:0 0 auto;position:static}
    /* IWB_IMPORT_LAYOUT_FIX_END */

    /* IWB_IMPORT_NAME_ELLIPSIS_BEGIN */
    .qa-import-source-item{grid-template-columns:26px minmax(0,1fr) max-content;min-height:34px;height:34px;overflow:hidden}
    .qa-import-name{display:block;min-width:0;overflow:hidden!important;white-space:nowrap;text-overflow:ellipsis;overflow-wrap:normal!important}
    .qa-import-uid{white-space:nowrap;min-width:max-content;flex:none}
    /* IWB_IMPORT_NAME_ELLIPSIS_END */

    /* IWB_BATCH_DELETE_LAYOUT_BEGIN */
    .qa-batch-status,.qa-batch-primary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}
    .qa-batch-moves{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}
    .qa-batch-status .qa-btn,.qa-batch-primary .qa-btn,.qa-batch-moves .qa-btn{min-width:0;width:100%;padding-inline:3px;white-space:nowrap;overflow:hidden}
    /* IWB_BATCH_DELETE_LAYOUT_END */

    /* IWB_V042_LIST_SELECTION_CSS_BEGIN */
    .qa-list-context{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;padding:7px 8px;border:1px solid var(--qa-line);border-radius:9px;background:color-mix(in srgb,var(--qa-bg) 96%,#fff 4%);box-shadow:0 2px 7px rgba(49,76,93,.06)}
    .qa-list-context>span{min-width:0;display:flex;align-items:center;gap:7px}.qa-list-context strong{font-size:12px;color:var(--qa-text)}.qa-list-context small{font-size:11px;color:var(--qa-muted);white-space:nowrap}.qa-list-context .qa-btn{min-height:34px;white-space:nowrap;background:var(--qa-accent-soft);border-color:var(--qa-accent-line);color:#365e7f}
    @media(min-width:481px){.qa-footer .qa-selection-context strong{display:none!important}}
    @media(max-width:480px){.qa-list-context{margin-bottom:5px;padding:6px}.qa-list-context>span{display:grid;gap:0}.qa-list-context .qa-btn{min-height:38px}.qa-mobile-footer-summary>span:first-child{display:none!important}.qa-mobile-footer-summary{justify-content:flex-end!important}}
    /* IWB_V042_LIST_SELECTION_CSS_END */

    /* IWB_RESPONSIVE_DESKTOP_BEGIN · alpha.5.28 · single authoritative responsive module */
    .qa-desktop-task-head,.qa-guide-desktop-only,.qa-batch-group-label{display:none}
    @media(min-width:481px){
      #iwb-qa-root{width:100%;max-width:none;height:100%;max-height:100%;min-height:0}
      .iwb-qa-host{width:min(1420px,calc(100dvw - 40px))!important;max-width:min(1420px,calc(100dvw - 40px))!important;height:min(90dvh,900px)!important;max-height:min(90dvh,900px)!important;min-height:min(620px,90dvh)!important;display:flex!important;overflow:hidden!important}
      .iwb-qa-host .popup-body,.iwb-qa-host .popup-content{display:flex!important;width:100%!important;height:100%!important;max-height:100%!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important}
      #iwb-qa-root>.qa-shell{width:100%;height:100%;max-height:100%;min-height:0;overflow:hidden;grid-template-areas:"head" "task" "scroll" "workspace" "footer";grid-template-rows:auto auto minmax(0,1fr) auto auto}
      .qa-head{grid-area:head;display:grid;grid-template-columns:210px 300px minmax(220px,1fr) 178px 120px 140px;gap:8px;padding:12px 14px 8px}
      .qa-title-row{grid-column:1/-1;grid-row:1;padding-right:48px}.qa-title-lock{display:none!important}
      .qa-mode-segments{grid-column:1;grid-row:2;grid-template-columns:repeat(2,minmax(0,1fr))!important}
      .qa-top-grid,.qa-filter-pair{display:contents}.qa-top-grid>[data-control="book"]{grid-column:2;grid-row:2;height:40px}.qa-filter-pair>[data-control="search"]{grid-column:3;grid-row:2;height:40px}.qa-filter-pair>[data-control="state-filter-select"]{grid-column:4;grid-row:2;height:40px}.qa-top-grid>[data-action="other-tools"]{display:none!important}
      .qa-other-tools,.qa-other-tools[hidden]{display:contents!important}.qa-other-tools>.qa-btn[data-action="reload"]{grid-column:5/7;grid-row:2;min-height:40px}.qa-top-grid>[data-action="new-entry"],.qa-top-grid>[data-action="toggle-source"]{grid-column:1;grid-row:3;min-height:42px}.qa-other-tools>[data-action="panel-import"]{grid-column:2;grid-row:3;min-height:42px}.qa-other-tools>[data-action="panel-transfer"]{grid-column:3;grid-row:3;min-height:42px}.qa-other-tools>[data-action="auto-arrange"]{grid-column:4;grid-row:3;min-height:42px}.qa-other-tools>[data-action="arrange-settings"]{grid-column:5;grid-row:3;min-height:42px}.qa-other-tools>[data-action="disable-recursion"]{grid-column:6;grid-row:3;min-height:42px}.qa-status{grid-column:1/-1;grid-row:4}
      .qa-desktop-task-head:not([hidden]){grid-area:task;display:grid;grid-template-columns:auto minmax(0,1fr) 136px;gap:14px;align-items:center;margin:0 14px 8px;padding:10px 12px;border:1px solid var(--qa-line);border-radius:12px;background:#fff}.qa-desktop-task-head>[data-slot="desktop-task-title"]{min-height:42px;display:flex;align-items:center;padding:0 14px;border-left:4px solid var(--qa-accent);border-radius:8px;background:var(--qa-accent-soft);font-size:17px;font-weight:700;color:#294557;white-space:nowrap}.qa-desktop-task-direction{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) 42px minmax(0,1fr);gap:10px;align-items:center}.qa-desktop-task-side{min-width:0;height:44px;display:flex;align-items:center;border:1px solid #d2dee5;border-radius:9px;background:#f9fbfc}.qa-desktop-task-book{padding:0 14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;justify-content:center}.qa-desktop-task-select>.qa-select{width:100%;height:42px!important;min-width:0;border:0;background:transparent}.qa-desktop-task-arrow{width:38px;height:38px;display:grid;place-items:center;justify-self:center;border:1px solid #c5d8e5;border-radius:999px;background:var(--qa-accent-soft);color:#4f7c9b;font-size:18px;font-weight:700;line-height:1}.qa-desktop-task-back{width:136px;min-width:136px;min-height:44px;background:var(--qa-accent-soft)!important;border-color:#bfd5e4!important}
      .qa-desktop-task-active .qa-head{display:none}.qa-desktop-task-active .qa-desktop-task-head{margin-top:12px}
      .qa-scroll{grid-area:scroll;min-height:0;max-height:none;overflow-y:auto;padding:8px 10px}.qa-workspace-panel{grid-area:workspace;max-height:min(34dvh,310px);overflow-y:auto;border-top:1px solid var(--qa-line);padding:8px 14px;background:var(--qa-bg)}.qa-workspace-panel[hidden]{display:none}.qa-workspace-panel.qa-batch-workspace{max-height:none;overflow:visible}.qa-footer{grid-area:footer;position:relative;max-height:none;min-height:62px;overflow:visible!important;display:flex!important;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--qa-line);background:#fff}.qa-footer .qa-save-bar,.qa-footer .qa-selection-context{display:contents}.qa-footer .qa-count{order:1;min-width:190px;margin-right:auto;font-size:13px;color:#4e6471}.qa-footer .qa-selection-context strong{order:2;white-space:nowrap;font-size:13px;color:#4b6473}.qa-footer [data-action="batch-panel"]{order:3}.qa-footer [data-action="clear-selection"]{order:4}.qa-footer [data-action="undo"]{order:5}.qa-footer [data-action="discard"]{order:6}.qa-footer [data-action="save"]{order:7;min-width:132px}.qa-footer .qa-btn{height:42px;min-height:42px;padding:0 15px;border-radius:9px}.qa-footer [data-action="batch-panel"]{background:var(--qa-accent-soft);border-color:var(--qa-accent-line);color:#365e7f}.qa-footer-task-active .qa-selection-context,.qa-footer-task-active .qa-save-bar>.qa-btn{display:none!important}
      .qa-card{padding:9px 10px;border-radius:13px}.qa-card-main{display:grid;grid-template-columns:minmax(300px,1fr) minmax(420px,620px) auto;grid-template-areas:"head fields actions";gap:10px;align-items:center}.qa-card-head{grid-area:head;grid-template-columns:34px minmax(0,1fr) 40px;gap:7px}.qa-name-cell{min-height:58px}.qa-name{width:100%;min-width:0;min-height:36px;padding:6px 9px;border:1px solid #c5d1d8!important;border-radius:8px!important;background:#fdfefe!important;box-shadow:inset 0 1px 2px rgba(47,70,84,.04);font-size:16px;text-align:left;color:#263f50}.qa-name:hover{border-color:var(--qa-accent)!important;background:#fff!important}.qa-name-meta,.qa-source{font-size:12px}.qa-inline-fields{grid-area:fields;margin:0;display:grid;grid-template-columns:minmax(180px,1fr) 105px 112px 84px;gap:7px}.qa-inline-row{display:contents}.qa-inline-fields label,.qa-editor label,.qa-keyword-editor label,.qa-recursion-title{font-size:13px;font-weight:600;color:#526875}.qa-summary-actions{grid-area:actions;margin:0;overflow:visible;gap:5px}.qa-summary-actions .qa-btn,.qa-summary-actions .qa-icon,.qa-card-head>.qa-icon,.qa-card-head>[data-action="drag"],.qa-card-head>[data-action="toggle"]{width:38px;height:38px;min-width:38px;min-height:38px;display:grid;place-items:center;padding:0;border:1px solid #c8d4db;border-radius:8px;background:#fff}.qa-card.is-expanded .qa-card-main{grid-template-areas:"head fields actions" "editor editor editor"}.qa-editor{grid-area:editor}.qa-move-mode .qa-inline-fields{display:grid;opacity:.75;pointer-events:none}.qa-move-mode .qa-inline-fields .qa-input,.qa-move-mode .qa-inline-fields .qa-select{background:#f4f6f7}
      .qa-check{appearance:none;position:relative;width:30px!important;height:30px!important;border:1px solid #c7d4dc;border-radius:8px;background:#fff;display:grid;place-items:center}.qa-check:checked{border-color:#5ca2d0;background:linear-gradient(145deg,#7fc1ea,#4f94c3);box-shadow:0 2px 7px rgba(59,116,153,.24)}.qa-check:checked:after{content:'✓';color:#fff;font-size:20px;font-weight:800;line-height:1}.qa-card.is-selected,.qa-card.is-selected.is-expanded{border-color:var(--qa-selected-line)!important;background:linear-gradient(90deg,rgba(91,169,218,.11),rgba(255,255,255,.96) 24%)!important;box-shadow:inset 3px 0 0 var(--qa-selected-line)!important}.qa-summary-actions .qa-drag,.qa-summary-actions .qa-switch,.qa-summary-actions .qa-action-icon,.qa-card-head .qa-expand{width:38px!important;height:38px!important;min-width:38px!important;min-height:38px!important;display:grid!important;place-items:center!important;padding:0!important;border:1px solid #c8d4db!important;border-radius:8px!important;background:#fff;box-shadow:none}.qa-summary-actions .qa-switch:before{transform:scale(.82)}.qa-summary-actions{align-items:center}.qa-keyword-editor{max-width:680px}.qa-keyword-editor .qa-keyword-input-row{grid-template-columns:minmax(240px,520px) auto!important;justify-content:start}.qa-keyword-editor [data-control="entry-key-input"]{max-width:520px}.qa-keyword-editor [data-action="keyword-add"]{min-width:72px}.qa-source{font-size:14px!important;line-height:1.45!important;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qa-name-meta{line-height:1.4}
      .qa-batch-panel{width:min(100%,1280px);margin:auto}.qa-batch-title{margin:0 0 10px;font-size:17px}.qa-batch-groups{display:grid;grid-template-columns:minmax(230px,1fr) minmax(420px,1.4fr) minmax(230px,.8fr);gap:14px}.qa-batch-group{display:grid;gap:9px;padding:11px;border:1px solid var(--qa-line);border-radius:12px;background:#fff}.qa-batch-group-label{display:block}.qa-batch-group-label strong,.qa-batch-group-label small{display:block}.qa-batch-group-label strong{font-size:14px}.qa-batch-group-label small{font-size:12px;line-height:1.45;color:var(--qa-muted)}.qa-batch-primary{grid-template-columns:repeat(2,minmax(0,1fr))}.qa-batch-moves{grid-template-columns:repeat(4,minmax(0,1fr))}.qa-batch-danger-group{background:#fff7f7;border-color:#edc8c8}.qa-batch-delete-wide{width:100%;min-height:40px}.qa-workspace-panel.qa-batch-workspace:has(.qa-batch-subpanel){min-height:min(36dvh,330px);display:grid;place-items:center;overflow:auto}.qa-batch-subpanel{width:min(720px,calc(100% - 40px));max-height:calc(100% - 24px);overflow:auto;margin:auto;padding:20px;border:1px solid #cddbe3;border-radius:16px;background:#fff;box-shadow:0 16px 38px rgba(45,73,91,.16)}.qa-batch-subpanel h3{margin-top:0;font-size:18px}.qa-batch-subpanel .qa-fields{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.qa-batch-subpanel .qa-footer-row{justify-content:flex-end;margin-top:16px}
      .qa-desktop-task-active .qa-scroll{padding:0 14px 10px}.qa-import-workspace,.qa-arrange-workspace{height:100%;min-height:0}.qa-import-workspace:not(.qa-transfer-workspace){display:grid!important;grid-template-columns:280px minmax(0,1fr);grid-template-rows:auto auto minmax(0,1fr) auto;gap:10px 14px;overflow:hidden}.qa-import-workspace:not(.qa-transfer-workspace)>header{grid-column:1;grid-row:1;padding:12px;border:1px solid var(--qa-line);border-radius:12px;background:#fff}.qa-import-workspace:not(.qa-transfer-workspace)>[data-control="import-source"]{grid-column:1;grid-row:2;align-self:start;height:42px!important}.qa-import-workspace:not(.qa-transfer-workspace)>.qa-import-body{grid-column:2;grid-row:1/4;min-height:0;padding:10px;border:1px solid var(--qa-line);border-radius:12px;background:#fff}.qa-import-workspace:not(.qa-transfer-workspace)>.qa-import-actions{grid-column:2;grid-row:4;display:flex;justify-content:flex-end;align-items:center;gap:8px}.qa-import-workspace:not(.qa-transfer-workspace) .qa-import-actions .qa-btn{min-height:40px;padding-inline:14px}.qa-import-workspace:not(.qa-transfer-workspace) .qa-import-confirm{min-width:190px}.qa-import-workspace:not(.qa-transfer-workspace) [data-action="import-cancel"]{display:none!important}
      .qa-transfer-workspace{display:grid!important;grid-template-columns:280px minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto;gap:10px 14px;overflow:hidden}.qa-transfer-workspace>header{grid-column:1;grid-row:1;padding:12px;border:1px solid var(--qa-line);border-radius:12px;background:#fff}.qa-transfer-workspace [data-action="transfer-cancel"]{display:none!important}.qa-transfer-workspace>.qa-task-toolbar{grid-column:2;grid-row:1}.qa-transfer-workspace>.qa-import-body{grid-column:2;grid-row:2;min-height:0;display:flex!important;flex-direction:column;overflow:hidden;padding:10px;border:1px solid var(--qa-line);border-radius:12px;background:#fff}.qa-transfer-workspace>.qa-import-body>[data-slot="transfer-list"],.qa-transfer-workspace>.qa-import-body .qa-transfer-list{flex:1 1 0;min-height:0}.qa-transfer-actions{grid-column:2;grid-row:3;display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.qa-transfer-actions .qa-btn{min-height:48px}.qa-transfer-targets{grid-column:2;grid-row:1/4;grid-template-columns:repeat(2,minmax(0,1fr))}.qa-task-toolbar{display:grid;grid-template-columns:minmax(260px,1fr) 132px 126px 104px;gap:8px;align-items:center}.qa-task-toolbar>.qa-input,.qa-task-toolbar>.qa-select,.qa-task-toolbar>.qa-btn{height:42px!important;min-height:42px!important}.qa-task-filter-spacer{display:block}.qa-import-body>.qa-task-toolbar{flex:0 0 auto;margin-bottom:8px}.qa-import-body>.qa-task-toolbar+.qa-import-selection-note{margin-bottom:6px}.qa-task-toolbar .qa-btn{width:auto!important;padding-inline:12px;white-space:nowrap}
      .qa-source-preview-item{display:block;border-bottom:1px solid #e3eaee}.qa-source-preview-item:last-child{border-bottom:0}.qa-source-preview-item>.qa-import-item{display:grid!important;grid-template-columns:30px minmax(0,1fr) 92px 38px;gap:8px;align-items:center;min-height:46px;border:0!important}.qa-source-preview-item>.qa-import-item>input{justify-self:center}.qa-source-preview-toggle{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-align:left;border:0;background:transparent;color:inherit;padding:7px 0;font:inherit}.qa-import-uid,.qa-transfer-uid{width:92px;white-space:nowrap;text-align:right}.qa-source-preview-arrow{width:34px;height:34px;display:grid;place-items:center;border:1px solid var(--qa-line);border-radius:7px;background:#fff;color:#5c7381}.qa-source-preview{margin:0 8px 8px 38px;padding:10px;border:1px solid #d4e0e7;border-radius:9px;background:#f8fafb}.qa-source-preview-meta{display:flex;gap:10px;align-items:center;min-width:0;margin-bottom:7px;font-size:12px;color:var(--qa-muted)}.qa-source-preview-meta strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#385263}.qa-source-preview-body{max-height:170px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.55;color:#324b5b}
      .qa-arrange-workspace{padding:0}.qa-arrange-workspace .qa-panel{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr) auto}.qa-arrange-note{text-align:center;font-size:15px!important;line-height:1.6;padding:10px 14px}.qa-arrange-workspace .qa-arrange-list{max-height:none;min-height:0;overflow:auto;padding:10px 12px;display:grid;align-content:start;gap:8px}.qa-arrange-workspace .qa-arrange-row{width:min(760px,100%);min-height:56px;margin-inline:auto;padding:8px 12px;display:grid;grid-template-columns:minmax(260px,1fr) 160px 92px;gap:10px;align-items:center;border:1px solid var(--qa-line);border-radius:10px;background:#fff}.qa-arrange-label{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qa-arrange-arrows{display:grid;grid-template-columns:repeat(2,42px);gap:8px}.qa-arrange-arrows .qa-btn{width:42px;height:40px;padding:0}.qa-arrange-workspace .qa-footer-row{width:min(760px,100%);margin-inline:auto;justify-content:flex-end}.qa-arrange-workspace .qa-footer-row [data-action="panel-close"]{display:none!important}
      .qa-content-head{display:grid;grid-template-columns:120px minmax(0,1fr) 120px;align-items:center;gap:16px;padding:12px 18px}.qa-content-context{min-width:0;display:grid;justify-items:center;gap:5px}.qa-content-name-input{width:min(680px,100%);height:42px;font-size:17px;font-weight:600;text-align:center;border-color:#b9ccd8;background:#fff}.qa-content-context small{font-size:12px;color:var(--qa-muted)}.qa-content-token{text-align:center;font-size:12px;color:var(--qa-muted)}
      .qa-guide-dialog{width:min(940px,calc(100dvw - 120px));max-height:min(84dvh,760px)}.qa-guide-layout{min-height:0;display:grid;grid-template-columns:185px minmax(0,1fr)}.qa-guide-nav{min-height:0;overflow:auto;padding:14px;align-content:start;gap:6px;border-right:1px solid var(--qa-line);background:#f5f7f8}.qa-guide-nav-item{width:100%;min-height:38px;text-align:left;border:1px solid var(--qa-line);border-radius:7px;background:#fff;padding:7px 10px}.qa-guide-nav-item.is-active{background:var(--qa-accent-soft);border-color:var(--qa-accent-line);color:#365e7f}.qa-guide-body{min-height:0;overflow:auto;padding:16px 20px}.qa-guide-anchor{scroll-margin-top:6px}.qa-guide-desktop-only{display:block}nav.qa-guide-desktop-only{display:grid}
      .iwb-qa-host .popup-button-close{width:42px!important;height:42px!important;display:grid!important;place-items:center}
      @media(max-width:1180px){.qa-head{grid-template-columns:190px 250px minmax(190px,1fr) 160px 108px 124px}.qa-card-main{grid-template-columns:minmax(250px,1fr) minmax(390px,520px) auto}.qa-batch-groups{grid-template-columns:1fr 1fr}.qa-batch-danger-group{grid-column:1/-1}.qa-footer .qa-count{min-width:120px}.qa-footer .qa-btn{padding-inline:10px}}
    }
    @media(max-width:480px){.qa-move-mode .qa-inline-fields{display:none}.qa-desktop-task-head{display:none!important}.qa-content-name-input{width:100%;min-width:0;font-size:15px;font-weight:600}.qa-content-context small{white-space:normal;line-height:1.35}.qa-task-toolbar{display:grid;grid-template-columns:minmax(0,1fr) 108px;gap:6px}.qa-task-toolbar>.qa-input{grid-column:1/-1}.qa-task-toolbar>.qa-select{grid-column:1/-1}.qa-task-toolbar>.qa-btn{min-height:38px}.qa-task-filter-spacer{display:none}.qa-import-body>.qa-task-toolbar{flex:0 0 auto}.qa-source-preview-item>.qa-import-item{grid-template-columns:22px minmax(0,1fr) max-content 34px}}
    @media(min-width:481px){
      .qa-check{-webkit-appearance:none!important;appearance:none!important;background:#fff!important;color:transparent}.qa-check:before{content:none!important}.qa-check:checked{background:linear-gradient(145deg,#7fc1ea,#4f94c3)!important}.qa-check:checked:after{position:absolute;inset:0;display:grid;place-items:center}
      .qa-import-workspace,.qa-transfer-workspace{display:grid!important;grid-template-columns:minmax(0,1fr)!important;grid-template-rows:auto auto minmax(0,1fr) auto!important;gap:8px!important;overflow:hidden}.qa-import-workspace>header,.qa-transfer-workspace>header{display:none!important}.qa-task-direction{grid-column:1;grid-row:1;display:grid;grid-template-columns:minmax(220px,360px) 34px minmax(260px,1fr);align-items:center;justify-content:center;gap:10px;padding:10px 14px;border:1px solid var(--qa-line);border-radius:12px;background:#fff}.qa-task-direction-current{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;font-weight:600}.qa-task-direction-arrow{display:grid;place-items:center;color:var(--qa-muted);font-size:18px;pointer-events:none}.qa-task-direction .qa-select{height:42px!important}.qa-import-workspace>.qa-import-body,.qa-transfer-workspace>.qa-import-body{grid-column:1;grid-row:2/4;min-height:0;padding:10px;border:1px solid var(--qa-line);border-radius:12px;background:#fff}.qa-import-workspace>.qa-import-actions,.qa-transfer-workspace>.qa-import-actions{grid-column:1;grid-row:4}.qa-transfer-workspace>.qa-task-toolbar{grid-column:1;grid-row:2}.qa-transfer-workspace>.qa-import-body{grid-row:3}.qa-import-workspace>.qa-import-body{display:flex!important;flex-direction:column;overflow:hidden}.qa-import-workspace>.qa-import-body>[data-slot="import-results"]{flex:1 1 0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
      .qa-source-preview-item>.qa-import-item>*{align-self:center;margin-block:0}.qa-source-preview-toggle{line-height:1.35;padding-inline-start:11px;padding-inline-end:4px}.qa-source-preview-arrow{align-self:center!important;line-height:1!important}
      .qa-arrange-workspace .qa-arrange-row{width:min(620px,100%);grid-template-columns:minmax(220px,300px) 150px 92px;justify-content:center}.qa-arrange-workspace .qa-footer-row{width:min(620px,100%)}
      .qa-content-context small{font-size:13px}.qa-content-body{padding:12px 18px 18px}.qa-content-paper{height:100%;min-height:0;display:grid;grid-template-rows:auto auto minmax(0,1fr);gap:10px;padding:18px;border:1px solid #cfdce4;border-radius:14px;background:#fff;box-shadow:0 12px 32px rgba(48,74,91,.1)}.qa-content-paper-title,.qa-content-paper-keys{display:grid;justify-items:center}.qa-content-title-display{max-width:90%;border:0;background:transparent;padding:6px 12px;color:#263f50;font-size:20px;font-weight:700;text-align:center}.qa-content-name-input{width:min(680px,100%);height:42px;font-size:18px;font-weight:600;text-align:center}.qa-content-keys-display{max-width:90%;display:flex;flex-wrap:wrap;justify-content:center;gap:6px;border:0;background:transparent;padding:5px}.qa-content-key-placeholder{color:var(--qa-muted);font-size:13px}.qa-content-key-input-row{width:min(620px,100%);display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-top:6px}.qa-content-key-input-row .qa-keyword-input{width:100%}.qa-content-textarea{width:100%;height:100%!important;min-height:0!important;resize:none;border:0;border-top:1px solid var(--qa-line);border-radius:0;padding:14px 4px 4px;background:transparent;line-height:1.65}
    }
    @media(min-width:481px){.qa-import-workspace>.qa-task-direction,.qa-transfer-workspace>.qa-task-direction{display:none!important}}
      .qa-import-workspace:not(.qa-transfer-workspace)>.qa-import-body{grid-column:1!important;grid-row:2/4!important;width:100%!important;min-width:0!important}.qa-import-workspace:not(.qa-transfer-workspace)>.qa-import-actions{grid-column:1!important;grid-row:4!important;width:100%!important;min-width:0!important}.qa-import-workspace:not(.qa-transfer-workspace)>.qa-import-body>[data-slot="import-results"]{width:100%;min-width:0}.qa-transfer-workspace>.qa-import-body,.qa-transfer-workspace>.qa-import-actions{grid-column:1!important;width:100%!important;min-width:0!important}
      .qa-source-preview-item>.qa-import-item>input[type="checkbox"]{-webkit-appearance:none!important;appearance:none!important;position:relative;width:20px!important;height:20px!important;margin:0;border:1px solid #b9cbd6;border-radius:6px;background:#fff!important;display:grid;place-items:center;color:transparent}.qa-source-preview-item>.qa-import-item>input[type="checkbox"]:before{content:none!important}.qa-source-preview-item>.qa-import-item>input[type="checkbox"]:checked{border-color:#5ca2d0;background:linear-gradient(145deg,#7fc1ea,#4f94c3)!important;box-shadow:0 1px 4px rgba(59,116,153,.22)}.qa-source-preview-item>.qa-import-item>input[type="checkbox"]:checked:after{content:'✓';position:absolute;inset:0;display:grid;place-items:center;color:#fff;font-size:14px;font-weight:800;line-height:1}.qa-source-preview-item>.qa-import-item>input[type="checkbox"]:focus-visible{outline:2px solid var(--qa-accent);outline-offset:2px}
      .qa-summary-actions .qa-switch{position:relative!important;display:block!important;line-height:0!important}.qa-summary-actions .qa-switch:before{left:50%!important;top:50%!important;transform:translate(-50%,-50%) scale(.82)!important;transform-origin:center!important}.qa-summary-actions .qa-switch:after{left:50%!important;top:50%!important;transform:translate(-10px,-50%)!important;transform-origin:center!important}.qa-summary-actions .qa-switch[aria-checked="true"]:after{transform:translate(2px,-50%)!important}
    @media(max-width:900px) and (min-width:481px){.qa-desktop-task-head:not([hidden]){grid-template-columns:auto minmax(0,1fr) 112px;gap:8px}.qa-desktop-task-head>[data-slot="desktop-task-title"]{padding-inline:9px;font-size:15px}.qa-desktop-task-direction{grid-template-columns:minmax(0,1fr) 30px minmax(0,1fr);gap:6px}.qa-desktop-task-arrow{width:28px;height:28px;font-size:14px}.qa-desktop-task-side{height:40px}.qa-desktop-task-book{padding-inline:8px;font-size:12px}.qa-desktop-task-select>.qa-select{height:38px!important;font-size:12px}.qa-desktop-task-back{width:112px;min-width:112px;padding-inline:10px}}
    .qa-mobile-task-head,.qa-mobile-transfer-stage{display:none}
    .qa-source-preview-body{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;overflow-x:hidden}
    @media(max-width:480px){
      #iwb-qa-root{--qa-mobile-import-control-height:44px}
      #iwb-qa-root.qa-import-active>.qa-shell{grid-template-areas:"scroll"!important;grid-template-rows:minmax(0,1fr)!important}
      #iwb-qa-root.qa-import-active .qa-head,#iwb-qa-root.qa-import-active .qa-footer,#iwb-qa-root.qa-import-active .qa-workspace-panel{display:none!important}
      #iwb-qa-root.qa-import-active .qa-scroll{grid-area:scroll!important;min-height:0;padding:0!important;overflow:hidden!important}
      .qa-import-active .qa-import-workspace,.qa-import-active .qa-transfer-workspace{height:100%;min-height:0;display:grid!important;grid-template-columns:minmax(0,1fr)!important;grid-template-rows:auto auto minmax(0,1fr) auto!important;gap:8px!important;padding:8px!important;overflow:hidden}
      .qa-import-active .qa-import-workspace>header,.qa-import-active .qa-transfer-workspace>header{display:none!important}
      .qa-mobile-task-head{grid-column:1;grid-row:1;position:sticky;top:0;z-index:3;min-width:0;display:flex;align-items:center;gap:8px;padding:7px 8px;border:1px solid var(--qa-accent-line);border-radius:10px;background:rgba(255,255,255,.98);box-shadow:0 3px 10px rgba(45,73,91,.08)}
      .qa-mobile-task-heading{min-width:0;display:grid;margin-right:auto}.qa-mobile-task-heading strong{font-size:16px;color:#294557;white-space:nowrap}
      .qa-mobile-task-back{flex:0 0 auto;height:38px!important;min-height:38px!important;padding-inline:11px!important;background:var(--qa-accent-soft)!important;border-color:var(--qa-accent-line)!important;color:#365e7f!important}
      .qa-import-workspace:not(.qa-transfer-workspace)>.qa-task-direction{display:contents!important}
      .qa-import-workspace:not(.qa-transfer-workspace)>.qa-task-direction .qa-select{grid-column:1;grid-row:2;width:100%;box-sizing:border-box!important;height:var(--qa-mobile-import-control-height)!important;min-height:var(--qa-mobile-import-control-height)!important;padding-block:0!important;line-height:1.2!important}
      .qa-import-workspace:not(.qa-transfer-workspace)>.qa-task-direction-arrow,.qa-import-workspace:not(.qa-transfer-workspace)>.qa-task-direction-current{display:none!important}
      .qa-import-workspace:not(.qa-transfer-workspace)>.qa-import-body{grid-column:1!important;grid-row:3!important;min-height:0!important}.qa-import-workspace:not(.qa-transfer-workspace)>.qa-import-actions{grid-column:1!important;grid-row:4!important}.qa-import-workspace:not(.qa-transfer-workspace) .qa-import-summary{padding-top:5px!important}
      .qa-import-actions>[data-action="import-cancel"]{display:none!important}
      .qa-import-toolbar{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:5px!important}.qa-import-toolbar>.qa-input{grid-column:1!important;min-width:0}.qa-import-toolbar>.qa-btn{min-width:0!important;padding-inline:4px!important}
      .qa-transfer-workspace>.qa-task-toolbar{grid-column:1!important;grid-row:2!important}.qa-transfer-toolbar{display:grid!important;grid-template-columns:minmax(92px,1.7fr) minmax(64px,.85fr) 52px 52px!important;gap:4px!important}.qa-transfer-toolbar>.qa-input,.qa-transfer-toolbar>.qa-select{grid-column:auto!important;min-width:0;font-size:12px}.qa-transfer-toolbar>.qa-btn{min-width:0!important;padding-inline:2px!important;font-size:12px}.qa-transfer-workspace>.qa-import-body{grid-column:1!important;grid-row:3!important;min-height:0!important}.qa-transfer-workspace>.qa-import-actions{grid-column:1!important;grid-row:4!important}.qa-transfer-actions .qa-btn{min-height:52px!important}
      .qa-import-toolbar>.qa-input,.qa-import-toolbar>.qa-btn{box-sizing:border-box!important;height:var(--qa-mobile-import-control-height)!important;min-height:var(--qa-mobile-import-control-height)!important;padding-block:0!important;line-height:1.2!important;align-self:stretch}.qa-transfer-toolbar>.qa-input,.qa-transfer-toolbar>.qa-select,.qa-transfer-toolbar>.qa-btn{box-sizing:border-box!important;height:44px!important;min-height:44px!important;padding-block:0!important;line-height:1.2!important;align-self:stretch}
      .qa-import-confirm{width:100%!important;min-height:52px!important;font-size:15px}.qa-import-workspace:not(.qa-transfer-workspace)>.qa-import-actions{display:grid!important;grid-template-columns:minmax(0,1fr)!important}
      .qa-mobile-transfer-stage{grid-column:1;grid-row:2;display:flex;align-items:center;gap:8px}.qa-mobile-transfer-stage strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qa-transfer-targets{grid-column:1!important;grid-row:3/5!important;min-height:0;overflow:auto}
      .qa-task-direction.qa-transfer-direction{display:none!important}
      .qa-guide-layer{overflow:hidden;touch-action:none}.qa-guide-dialog{height:min(82dvh,560px);max-height:calc(100dvh - 24px);grid-template-rows:auto minmax(0,1fr);overflow:hidden}.qa-guide-layout{height:100%;min-height:0;display:block;overflow:hidden}.qa-guide-body{height:100%;min-height:0;max-height:none;overflow-y:auto!important;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;touch-action:pan-y}
      .qa-other-tools{row-gap:5px!important;column-gap:6px!important}.qa-other-tools .qa-btn{height:44px!important;min-height:44px!important;padding-block:4px!important;padding-inline:6px!important;font-size:13px;line-height:1.2}
      .qa-filter-pair>.qa-input,.qa-filter-pair>.qa-select,.qa-top-grid>[data-action="other-tools"]{box-sizing:border-box!important;height:34px!important;min-height:34px!important;padding-block:0!important;line-height:1.2!important;align-self:stretch}
      .qa-batch-panel .qa-batch-groups{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;grid-template-rows:auto auto;gap:5px!important}.qa-batch-panel .qa-batch-group{display:contents!important}.qa-batch-panel .qa-batch-group-label{display:none!important}.qa-batch-panel .qa-batch-primary{display:contents!important}.qa-batch-panel .qa-batch-primary>.qa-btn:nth-child(1){grid-column:1;grid-row:1}.qa-batch-panel .qa-batch-primary>.qa-btn:nth-child(2){grid-column:2;grid-row:1}.qa-batch-panel .qa-batch-delete-wide{grid-column:3;grid-row:1;width:100%;min-width:0;padding-inline:3px}.qa-batch-panel .qa-batch-moves{grid-column:1/-1;grid-row:2;display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:5px}.qa-batch-panel .qa-btn{min-width:0;white-space:nowrap}
      .qa-arrange-workspace .qa-arrange-row{width:100%;min-width:0;min-height:44px;padding:5px 6px;display:grid!important;grid-template-columns:minmax(0,1fr) 92px 32px 32px!important;gap:4px!important;align-items:center}.qa-arrange-workspace .qa-arrange-label{min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qa-arrange-workspace [data-control="arrange-direction"]{width:92px;min-width:0;height:36px!important;padding-inline:4px;font-size:12px}.qa-arrange-workspace .qa-arrange-arrows{display:contents!important}.qa-arrange-workspace .qa-arrange-arrows .qa-btn{width:32px!important;height:36px!important;min-width:32px!important;padding:0!important}.qa-arrange-workspace .qa-footer-row{width:100%;display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:5px}.qa-arrange-workspace .qa-footer-row .qa-btn{min-width:0;padding-inline:3px;font-size:12px;white-space:nowrap}
      .qa-task-direction .qa-select{width:100%}.qa-content-paper{height:100%;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);padding:8px}.qa-content-paper-keys{display:none}.qa-content-title-display{font-weight:700}.qa-content-textarea{min-height:0}
      .qa-source-preview-toggle{padding-inline-start:8px;padding-inline-end:3px}
    }

    /* IWB_ENTRY_FEEDBACK_CSS_BEGIN */
    @media(min-width:481px){
      .qa-inline-field>span{font-size:12px;line-height:1.35}
      .qa-card.is-expanded .qa-field>span,.qa-card.is-expanded .qa-content-label>span,.qa-card.is-expanded .qa-content-uid,.qa-card.is-expanded .qa-recursion-status,.qa-card.is-expanded .qa-advanced-note{font-size:13px!important;line-height:1.5}
      .qa-card.is-expanded .qa-recursion-status>span{font-size:13px}
      .qa-card.is-entry-dragging{outline:3px solid #65a7d2;outline-offset:-1px;border-color:#65a7d2!important;background:#eef7fc!important;box-shadow:0 0 0 3px rgba(101,167,210,.18),0 8px 20px rgba(54,105,139,.16)!important}
      .qa-card.drop-before,.qa-card.drop-after{position:relative;box-shadow:none!important}
      .qa-card.drop-before:before,.qa-card.drop-after:after{content:'';position:absolute;z-index:5;left:8px;right:8px;height:4px;border-radius:999px;background:#58a1d0;box-shadow:0 0 0 2px rgba(88,161,208,.2)}
      .qa-card.drop-before:before{top:-6px}.qa-card.drop-after:after{bottom:-6px}
    }
    @media(max-width:480px){
      .qa-card.is-entry-move-feedback{outline:3px solid #65a7d2;outline-offset:-2px;border-color:#65a7d2!important;background:#eef7fc!important;box-shadow:0 0 0 3px rgba(101,167,210,.18)!important;transition:outline-color .18s ease,background .18s ease,box-shadow .18s ease}
    }
    /* IWB_ENTRY_FEEDBACK_CSS_END */

    /* IWB_UI_ALIGNMENT_CSS_BEGIN */
    .qa-card-main,.qa-card-head,.qa-inline-fields,.qa-inline-field{align-items:center}
    .qa-card-head{align-self:center;min-height:58px}
    .qa-card-head>.qa-check,.qa-card-head>.qa-expand,.qa-card-head>.qa-mode-lock{align-self:center;justify-self:center}
    .qa-name-cell{align-content:center}
    .qa-inline-fields{align-self:center}
    .qa-inline-field{min-height:34px}
    .qa-card.is-expanded .qa-editor{box-sizing:border-box;min-width:0;padding-inline:12px}
    .qa-card.is-expanded .qa-content-preview{box-sizing:border-box;font-size:13px;line-height:1.55}
    .qa-import-toolbar>.qa-select,.qa-transfer-toolbar>.qa-select{text-align:center;text-align-last:center}
    @media(max-width:480px){
      .qa-card-head{min-height:48px}
      .qa-card.is-expanded .qa-editor{padding-inline:8px}
      .qa-card.is-expanded .qa-content-preview{font-size:13px;line-height:1.55}
      .qa-import-toolbar{grid-template-columns:minmax(92px,1.7fr) minmax(64px,.85fr) 52px 52px!important}
      .qa-import-toolbar>.qa-input{grid-column:auto!important}
      .qa-import-toolbar>.qa-input,.qa-import-toolbar>.qa-select,.qa-import-toolbar>.qa-btn{box-sizing:border-box!important;height:var(--qa-mobile-import-control-height)!important;min-height:var(--qa-mobile-import-control-height)!important;padding-block:0!important;line-height:1.2!important;align-self:stretch}
    }
    /* IWB_UI_ALIGNMENT_CSS_END */

    /* IWB_ARRANGE_RESTORE_CSS_BEGIN */
    @media(min-width:481px){
      .qa-top-grid>[data-control="book"],.qa-filter-pair>[data-control="search"],.qa-filter-pair>[data-control="state-filter-select"]{box-sizing:border-box!important;height:40px!important;min-height:40px!important;padding-block:0!important;line-height:1.2!important;align-self:center}
      .qa-content-body{height:100%;min-height:0;overflow:hidden;display:grid;grid-template-rows:minmax(0,1fr);padding:12px 18px 18px}
      .qa-content-paper{box-sizing:border-box;width:100%;height:100%;min-height:0;overflow:hidden;display:grid;grid-template-rows:auto auto minmax(0,1fr);gap:10px;padding:18px}
      .qa-content-textarea{box-sizing:border-box;width:100%;height:100%!important;min-height:0!important;overflow:auto}
      .qa-content-keys-display{width:min(820px,90%);min-width:0;display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:6px}
      .qa-content-keys-display .qa-keyword-chip{max-width:100%;display:inline-flex!important;align-items:center;gap:5px}
      .qa-content-key-input-row{width:min(620px,100%);display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px}
      .qa-arrange-workspace{padding:0}.qa-arrange-workspace .qa-panel{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr) auto}.qa-arrange-note{text-align:center;font-size:15px!important;line-height:1.6;padding:10px 14px}.qa-arrange-workspace .qa-arrange-list{max-height:none;min-height:0;overflow:auto;padding:10px 12px;display:grid;align-content:start;gap:8px}.qa-arrange-workspace .qa-arrange-row{position:relative;width:min(760px,100%);min-height:56px;margin-inline:auto;padding:8px 12px;display:grid;grid-template-columns:42px minmax(260px,1fr) 160px 92px;gap:10px;align-items:center;border:1px solid var(--qa-line);border-radius:10px;background:#fff}.qa-arrange-row.is-dragging{opacity:.7;border:2px solid #77acd0;background:#f0f7fb;box-shadow:0 0 0 3px rgba(111,169,207,.18),0 5px 16px rgba(59,116,153,.18)}.qa-arrange-row.is-drop-before:before,.qa-arrange-row.is-drop-after:after{content:'';position:absolute;z-index:3;left:8px;right:8px;height:3px;border-radius:999px;background:#64a4cf;box-shadow:0 0 0 2px rgba(100,164,207,.18)}.qa-arrange-row.is-drop-before:before{top:-6px}.qa-arrange-row.is-drop-after:after{bottom:-6px}.qa-arrange-drag-handle{width:42px;height:40px;display:grid;place-items:center;padding:0;border:1px solid #c8d4db;border-radius:8px;background:#f8fbfd;color:#587486;font-size:18px;line-height:1;cursor:grab}.qa-arrange-drag-handle:active{cursor:grabbing}.qa-arrange-label{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qa-arrange-arrows{display:grid;grid-template-columns:repeat(2,42px);gap:8px}.qa-arrange-arrows .qa-btn{width:42px;height:40px;padding:0}.qa-arrange-workspace .qa-footer-row{width:min(760px,100%);margin-inline:auto;display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.qa-arrange-workspace .qa-footer-row .qa-btn{width:100%;min-height:42px}.qa-arrange-workspace .qa-footer-row [data-action="panel-close"]{display:none!important}
    }
    @media(max-width:480px){
      .qa-content-body{box-sizing:border-box;height:100%;min-height:0;overflow:hidden;display:grid;grid-template-rows:minmax(0,1fr);padding:6px 8px 8px!important}
      .qa-content-paper{box-sizing:border-box;width:100%;height:100%;min-height:0;overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr);padding:8px}
      .qa-content-textarea{box-sizing:border-box;width:100%;height:100%!important;min-height:0!important;overflow:auto}
      .qa-arrange-workspace .qa-arrange-row{width:100%;min-width:0;min-height:44px;padding:5px 6px;display:grid!important;grid-template-columns:minmax(0,1fr) 92px 32px 32px!important;gap:4px!important;align-items:center;transition:border-color .18s ease,box-shadow .18s ease,background .18s ease}.qa-arrange-workspace .qa-arrange-row.is-flash-moved{border-color:#73add3!important;background:#eef7fc!important;box-shadow:0 0 0 3px rgba(111,169,207,.2)!important}.qa-arrange-drag-handle,.qa-arrange-reset{display:none!important}.qa-arrange-workspace .qa-arrange-row.is-drop-before:before,.qa-arrange-workspace .qa-arrange-row.is-drop-after:after{content:none!important}.qa-arrange-workspace .qa-arrange-label{min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qa-arrange-workspace [data-control="arrange-direction"]{width:92px;min-width:0;height:36px!important;padding-inline:4px;font-size:12px}.qa-arrange-workspace .qa-arrange-arrows{display:contents!important}.qa-arrange-workspace .qa-arrange-arrows .qa-btn{width:32px!important;height:36px!important;min-width:32px!important;padding:0!important}.qa-arrange-workspace .qa-footer-row{width:100%;display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:5px}.qa-arrange-workspace .qa-footer-row .qa-btn{min-width:0;padding-inline:3px;font-size:12px;white-space:nowrap}.qa-arrange-workspace .qa-footer-row [data-action="panel-close"]{display:block!important}
    }
    /* IWB_ARRANGE_RESTORE_CSS_END */

    /* IWB_KEYWORD_IMPORT_TOOLBAR_FINAL_BEGIN */
    @media(min-width:481px){
      .qa-card.is-expanded .qa-field.qa-wide,.qa-card.is-expanded .qa-keyword-editor{width:100%;max-width:none;min-width:0}
      .qa-card.is-expanded .qa-keyword-editor .qa-keyword-input-row{width:100%;max-width:none;grid-template-columns:minmax(0,1fr) auto!important;justify-content:stretch}
      .qa-card.is-expanded .qa-keyword-editor [data-control="entry-key-input"]{width:100%;max-width:none;min-width:0}
    }
    @media(max-width:480px){
      .qa-import-toolbar{display:grid!important;grid-template-columns:minmax(92px,1.7fr) minmax(64px,.85fr) 52px 52px!important;grid-template-rows:var(--qa-mobile-import-control-height)!important;gap:5px!important;align-items:center!important}
      .qa-import-toolbar>.qa-input,.qa-import-toolbar>.qa-select,.qa-import-toolbar>.qa-btn{grid-column:auto!important;grid-row:1!important;box-sizing:border-box!important;height:var(--qa-mobile-import-control-height)!important;min-height:var(--qa-mobile-import-control-height)!important;margin:0!important;padding-block:0!important;line-height:1.2!important;align-self:center!important}
      .qa-import-toolbar>.qa-select{text-align:center!important;text-align-last:center!important}
    }
    /* IWB_KEYWORD_IMPORT_TOOLBAR_FINAL_END */
    /* IWB_V041_MOBILE_FOOTER_BEGIN */
    .qa-mobile-footer-summary{display:none}
    @media(max-width:480px){
      #iwb-qa-root:not(.qa-import-active)>.qa-shell{grid-template-rows:auto minmax(0,1fr) auto auto!important}
      #iwb-qa-root:not(.qa-import-active) .qa-scroll{grid-row:2!important}
      #iwb-qa-root:not(.qa-import-active) .qa-workspace-panel{grid-row:3!important}
      #iwb-qa-root:not(.qa-import-active) .qa-footer{grid-row:4!important}
      .qa-footer.qa-footer-has-selection{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;align-items:stretch}
      .qa-footer-has-selection .qa-selection-context,.qa-footer-has-selection .qa-save-bar{display:contents!important}
      .qa-footer-has-selection .qa-mobile-footer-summary{grid-column:1/-1;grid-row:1;display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0;font-size:11px;line-height:1.3;color:var(--qa-muted);white-space:nowrap}
      .qa-footer-has-selection .qa-selection-context>strong,.qa-footer-has-selection .qa-save-bar>.qa-count{display:none!important}
      .qa-footer-has-selection [data-action="undo"]{grid-column:1;grid-row:2}
      .qa-footer-has-selection [data-action="discard"]{grid-column:2;grid-row:2}
      .qa-footer-has-selection [data-action="batch-panel"]{grid-column:3;grid-row:2}
      .qa-footer-has-selection [data-action="clear-selection"]{grid-column:4;grid-row:2}
      .qa-footer-has-selection [data-action="save"]{grid-column:1/-1;grid-row:3;width:100%}
      .qa-footer-has-selection .qa-btn{min-width:0!important;padding-inline:3px!important;white-space:nowrap}
      .qa-discard-confirm-dialog{width:min(100%,340px)}
      .qa-discard-confirm-actions{grid-template-columns:repeat(2,minmax(0,1fr))}
    }
    /* IWB_V041_MOBILE_FOOTER_END */
    /* IWB_V042_IOS_CONTENT_EDITOR_BEGIN */
    @media(max-width:480px){
      .qa-content-editing .qa-content-layer{inset:0 0 auto 0;height:var(--iwb-qa-content-vv-height,100%);max-height:100%;overflow:hidden}
    }
    /* IWB_V042_IOS_CONTENT_EDITOR_END */
    /* IWB_V042_MEDIUM_TABLET_BEGIN */
    @media(min-width:481px) and (max-width:1024px){
      .iwb-qa-host{width:calc(100dvw - 16px)!important;max-width:calc(100dvw - 16px)!important;height:min(94dvh,960px)!important;max-height:min(94dvh,960px)!important;min-height:min(560px,94dvh)!important}
      #iwb-qa-root>.qa-shell{grid-template-areas:"head" "task" "scroll" "workspace" "footer";grid-template-rows:auto auto minmax(0,1fr) auto auto}
      .qa-head{grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;padding:10px 12px 8px}
      .qa-title-row{grid-column:1/-1;grid-row:1}
      .qa-mode-segments{grid-column:1/3;grid-row:2}
      .qa-top-grid>[data-control="book"]{grid-column:3/5;grid-row:2;min-width:0;height:44px}
      .qa-other-tools>.qa-btn[data-action="reload"]{grid-column:5/7;grid-row:2;min-height:44px}
      .qa-filter-pair>[data-control="search"]{grid-column:1/5;grid-row:3;height:44px}
      .qa-filter-pair>[data-control="state-filter-select"]{grid-column:5/7;grid-row:3;height:44px}
      .qa-top-grid>[data-action="new-entry"],.qa-top-grid>[data-action="toggle-source"]{grid-column:1;grid-row:4;min-height:52px}
      .qa-other-tools>[data-action="panel-import"]{grid-column:2;grid-row:4;min-height:52px}
      .qa-other-tools>[data-action="panel-transfer"]{grid-column:3;grid-row:4;min-height:52px}
      .qa-other-tools>[data-action="auto-arrange"]{grid-column:4;grid-row:4;min-height:52px}
      .qa-other-tools>[data-action="arrange-settings"]{grid-column:5;grid-row:4;min-height:52px}
      .qa-other-tools>[data-action="disable-recursion"]{grid-column:6;grid-row:4;min-height:52px}
      .qa-head .qa-btn,.qa-head .qa-input,.qa-head .qa-select{min-width:0}
      .qa-head .qa-other-tools>.qa-btn{padding-inline:5px;white-space:normal;line-height:1.25}
      .qa-status{grid-column:1/-1;grid-row:5}

      .qa-scroll{padding:8px}
      .qa-card{padding:9px;border-radius:12px}
      .qa-card-main{display:grid;grid-template-columns:minmax(0,1fr);grid-template-areas:"head" "fields" "actions";gap:8px;align-items:center}
      .qa-card.is-expanded .qa-card-main{grid-template-areas:"head" "fields" "actions" "editor"}
      .qa-card-head{grid-template-columns:44px minmax(0,1fr) 44px;gap:8px}
      .qa-check{width:44px!important;height:44px!important}
      .qa-name-cell{min-height:52px}
      .qa-inline-fields{grid-area:fields;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0}
      .qa-inline-row{display:contents}
      .qa-inline-field .qa-input,.qa-inline-field .qa-select{height:44px}
      .qa-summary-actions{grid-area:actions;display:flex;justify-content:flex-end;flex-wrap:wrap;gap:6px;margin:0;overflow:visible}
      .qa-summary-actions .qa-drag,.qa-summary-actions .qa-switch,.qa-summary-actions .qa-action-icon,.qa-card-head .qa-expand{width:44px!important;height:44px!important;min-width:44px!important;min-height:44px!important}
      .qa-editor{grid-area:editor;min-width:0}
      .qa-card.is-expanded .qa-editor .qa-fields{grid-template-columns:minmax(0,1fr)}
      .qa-card.is-expanded .qa-field.qa-wide,.qa-card.is-expanded .qa-keyword-editor{width:100%;max-width:none;min-width:0}

      .qa-workspace-panel{max-height:min(46dvh,430px);overflow-y:auto;padding:8px 10px}
      .qa-workspace-panel.qa-batch-workspace{max-height:min(46dvh,430px);overflow-y:auto}
      .qa-batch-panel{width:100%}
      .qa-batch-groups{grid-template-columns:minmax(0,1fr);gap:9px}
      .qa-batch-danger-group{grid-column:auto}
      .qa-batch-group{min-width:0}
      .qa-batch-status .qa-btn,.qa-batch-primary .qa-btn,.qa-batch-moves .qa-btn,.qa-batch-delete-wide{min-height:44px}
      .qa-batch-subpanel{width:min(680px,calc(100% - 16px));max-height:calc(100% - 16px);padding:16px}
      .qa-batch-subpanel .qa-fields{grid-template-columns:repeat(2,minmax(0,1fr))}

      .qa-footer{min-height:0;display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;align-items:stretch;padding:8px 10px}
      .qa-footer .qa-count,.qa-footer .qa-selection-context strong,.qa-footer [data-action="batch-panel"],.qa-footer [data-action="clear-selection"],.qa-footer [data-action="undo"],.qa-footer [data-action="discard"],.qa-footer [data-action="save"]{order:initial;min-width:0;margin:0}
      .qa-footer .qa-count{grid-column:1/-1;grid-row:1}
      .qa-footer [data-action="undo"]{grid-column:1;grid-row:2}
      .qa-footer [data-action="discard"]{grid-column:2;grid-row:2}
      .qa-footer [data-action="save"]{grid-column:3/5;grid-row:2;width:100%}
      .qa-footer .qa-btn{width:100%;height:44px;min-height:44px;padding-inline:6px}
      .qa-footer.qa-footer-has-selection .qa-count{grid-column:1/3;grid-row:1}
      .qa-footer.qa-footer-has-selection .qa-selection-context strong{display:block!important;grid-column:3/5;grid-row:1;align-self:center;text-align:right}
      .qa-footer.qa-footer-has-selection [data-action="undo"]{grid-column:1;grid-row:2}
      .qa-footer.qa-footer-has-selection [data-action="discard"]{grid-column:2;grid-row:2}
      .qa-footer.qa-footer-has-selection [data-action="batch-panel"]{grid-column:3;grid-row:2}
      .qa-footer.qa-footer-has-selection [data-action="clear-selection"]{grid-column:4;grid-row:2}
      .qa-footer.qa-footer-has-selection [data-action="save"]{grid-column:1/-1;grid-row:3}

      .qa-desktop-task-head:not([hidden]){grid-template-columns:minmax(0,1fr) 124px;grid-template-areas:"title back" "direction direction";gap:8px;margin:0 10px 8px;padding:9px 10px}
      .qa-desktop-task-head>[data-slot="desktop-task-title"]{grid-area:title;min-width:0;min-height:44px;white-space:normal}
      .qa-desktop-task-direction{grid-area:direction;grid-template-columns:minmax(0,1fr) 34px minmax(0,1fr);gap:8px}
      .qa-desktop-task-back{grid-area:back;width:124px;min-width:124px;min-height:44px}
      .qa-desktop-task-side{height:44px}
      .qa-desktop-task-select>.qa-select{height:42px!important}
      .qa-desktop-task-active .qa-scroll{padding:0 10px 8px}
      .qa-import-workspace,.qa-transfer-workspace{grid-template-columns:minmax(0,1fr)!important;grid-template-rows:auto auto minmax(0,1fr) auto!important;gap:8px!important}
      .qa-task-toolbar{grid-template-columns:minmax(0,1fr) 132px;gap:8px}
      .qa-task-toolbar>.qa-input,.qa-task-toolbar>.qa-select,.qa-task-toolbar>.qa-btn{height:44px!important;min-height:44px!important}
      .qa-import-workspace>.qa-import-body,.qa-transfer-workspace>.qa-import-body{min-height:0;overflow:hidden}
      .qa-import-workspace>.qa-import-actions,.qa-transfer-workspace>.qa-import-actions{min-height:52px}
      .qa-import-workspace .qa-import-actions .qa-btn,.qa-transfer-workspace .qa-transfer-actions .qa-btn{min-height:48px}
      .qa-source-preview-item>.qa-import-item{grid-template-columns:30px minmax(0,1fr) 82px 40px;gap:6px;min-height:48px}
      .qa-source-preview-item>.qa-import-item>input[type="checkbox"]{width:24px!important;height:24px!important}
      .qa-source-preview-arrow{width:40px;height:40px}
      .qa-transfer-targets{grid-template-columns:minmax(0,1fr)}

      .qa-arrange-workspace .qa-arrange-row{width:100%;min-width:0;grid-template-columns:44px minmax(0,1fr) 144px 92px;gap:8px}
      .qa-arrange-drag-handle{width:44px;height:44px}
      .qa-arrange-arrows .qa-btn{height:44px;min-height:44px}
      .qa-arrange-workspace .qa-footer-row{width:100%;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
      .qa-arrange-workspace .qa-footer-row .qa-btn{min-height:44px}
      .qa-content-head{grid-template-columns:108px minmax(0,1fr) 108px;gap:10px;padding:10px 12px}
      .qa-content-body{padding:10px 12px 12px}
      .qa-guide-dialog{width:min(900px,calc(100dvw - 36px))}
      .qa-guide-layout{grid-template-columns:160px minmax(0,1fr)}
    }
    @media(min-width:700px) and (max-width:1024px){
      .qa-card-main{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"head actions" "fields fields"}
      .qa-card.is-expanded .qa-card-main{grid-template-areas:"head actions" "fields fields" "editor editor"}
      .qa-summary-actions{flex-wrap:nowrap}
    }
    /* IWB_V042_MEDIUM_TABLET_END */
    /* IWB_V042_COMPACT_BATCH_LAYOUT_BEGIN */
    @media(max-width:480px){
      .qa-batch-panel .qa-batch-groups{grid-template-columns:repeat(3,minmax(0,1fr))!important;grid-template-rows:auto auto auto!important;gap:6px!important}
      .qa-batch-panel .qa-batch-status{display:contents!important}
      .qa-batch-panel .qa-batch-status>.qa-btn:nth-child(1){grid-column:1;grid-row:1}
      .qa-batch-panel .qa-batch-status>.qa-btn:nth-child(2){grid-column:2;grid-row:1}
      .qa-batch-panel .qa-batch-delete-wide{grid-column:3!important;grid-row:1!important;width:100%;min-width:0;padding-inline:3px}
      .qa-batch-panel .qa-batch-primary{grid-column:1/-1;grid-row:2;display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:6px!important}
      .qa-batch-panel .qa-batch-moves{grid-column:1/-1;grid-row:3;display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:6px!important}
      .qa-batch-panel .qa-batch-status>.qa-btn,.qa-batch-panel .qa-batch-primary>.qa-btn,.qa-batch-panel .qa-batch-moves>.qa-btn,.qa-batch-panel .qa-batch-delete-wide{min-width:0;min-height:44px;padding-inline:3px;white-space:nowrap}
    }
    /* IWB_V042_COMPACT_BATCH_LAYOUT_END */
    /* IWB_RESPONSIVE_DESKTOP_END */

  `;



  function plainEntry(entry) {
    const next = cloneJson(entry);
    if (Object.prototype.hasOwnProperty.call(next, '_iwbOriginalUid')) next.uid = next._iwbOriginalUid;
    delete next._iwbBook;
    delete next._iwbOriginalUid;
    delete next._iwbBookIndex;
    return next;
  }

  function mixedEntry(book, entry, bookIndex) {
    const next = cloneJson(entry);
    next._iwbBook = String(book);
    next._iwbOriginalUid = next.uid;
    next._iwbBookIndex = bookIndex;
    return next;
  }

  function mixedStateList(view) {
    return [...view.bookStates.values()];
  }

  function mixedGroups(entries) {
    const groups = new Map();
    (entries || []).forEach(entry => {
      const book = String(entry._iwbBook || '');
      if (!groups.has(book)) groups.set(book, []);
      groups.get(book).push(plainEntry(entry));
    });
    return groups;
  }

  function mixedDirtyBooks(view) {
    if (!view.mixedMode) return [];
    const groups = mixedGroups(view.working);
    return mixedStateList(view).filter(state => jsonText(state.baseline) !== jsonText(groups.get(state.name) || [])).map(state => state.name);
  }

  function mixedSlotSequence(entries) {
    return (entries || []).map(entry => String(entry._iwbBook || '')).filter(Boolean);
  }

  function defaultMixedSlots(entries) {
    return mixedSlotSequence((entries || []).map(cloneJson).sort(compareMixedEntries));
  }

  function effectiveMixedArrangeRules(entries, storedRules) {
    const defaults = defaultArrangeRules(entries);
    if (!storedRules?.length) return defaults;
    const defaultsByKey = new Map(defaults.map((rule, index) => [rule.key, { rule, index }]));
    const result = [];
    storedRules.forEach(rule => {
      const actual = defaultsByKey.get(rule.key);
      if (!actual) return;
      result.push({ ...actual.rule, direction: rule.direction === 'desc' ? 'desc' : 'asc', isNew: false });
      defaultsByKey.delete(rule.key);
    });
    defaults.forEach(rule => {
      const actual = defaultsByKey.get(rule.key);
      if (!actual) return;
      const insertAt = result.findIndex(existing => (defaults.findIndex(item => item.key === existing.key)) > actual.index);
      result.splice(insertAt < 0 ? result.length : insertAt, 0, { ...rule, isNew: true });
    });
    return result;
  }

  function arrangeMixedWorking(entries, rules) {
    const effective = effectiveMixedArrangeRules(entries, rules);
    const tracks = new Map(effective.map((rule, index) => [rule.key, { index, direction: rule.direction }]));
    const indexed = (entries || []).map((entry, index) => ({
      entry: cloneJson(entry), index, bookIndex: Number(entry._iwbBookIndex || 0),
      track: arrangeTrack(entry), order: positionInfo(entry).order,
    }));
    indexed.sort((left, right) => {
      const leftRule = tracks.get(left.track.key) || { index: tracks.size, direction: 'asc' };
      const rightRule = tracks.get(right.track.key) || { index: tracks.size, direction: 'asc' };
      if (leftRule.index !== rightRule.index) return leftRule.index - rightRule.index;
      const leftOrder = Number.isFinite(left.order) ? left.order : Number.POSITIVE_INFINITY;
      const rightOrder = Number.isFinite(right.order) ? right.order : Number.POSITIVE_INFINITY;
      const orderDifference = leftRule.direction === 'desc' ? rightOrder - leftOrder : leftOrder - rightOrder;
      if (orderDifference) return orderDifference;
      const bookDifference = String(left.entry._iwbBook).localeCompare(String(right.entry._iwbBook), 'zh-CN');
      return bookDifference || left.bookIndex - right.bookIndex || left.index - right.index;
    });
    return refreshMixedBookIndexes(indexed.map(item => item.entry));
  }

  function initializeMixedWorking(entries, historicalSlots) {
    const slots = historicalSlots || defaultMixedSlots(entries);
    return refreshMixedBookIndexes(resolveMixedSlots(entries, slots));
  }

  function rebuildMixedBaseline(view) {
    const entries = mixedStateList(view).flatMap(state => state.baseline.map((entry, index) => mixedEntry(state.name, entry, index)));
    return refreshMixedBookIndexes(resolveMixedSlots(entries, view.slotBaseline || []));
  }

  function reflowMixedHardGroups(entries, targetIds = []) {
    const targets = new Set(targetIds);
    if (!targets.size) return refreshMixedBookIndexes(cloneJson(entries));
    const moving = entries.filter(entry => targets.has(entryId(entry))).map(cloneJson).sort(compareMixedEntries);
    const next = entries.filter(entry => !targets.has(entryId(entry))).map(cloneJson);
    moving.forEach(entry => {
      const index = next.findIndex(candidate => compareMixedEntries(entry, candidate) < 0);
      next.splice(index < 0 ? next.length : index, 0, entry);
    });
    return refreshMixedBookIndexes(next);
  }

  function copyMixedEntry(entries, sourceId) {
    const source = entries.find(entry => entryId(entry) === sourceId);
    if (!source?._iwbBook) throw new Error('没有找到要复制的来源书条目。');
    const sameBook = entries.filter(entry => entry._iwbBook === source._iwbBook).map(plainEntry);
    const duplicate = cloneJson(source);
    const uid = allocateUid(sameBook);
    duplicate.uid = uid;
    duplicate._iwbOriginalUid = uid;
    duplicate.name = entryName(duplicate) + '（副本）';
    const index = entries.findIndex(entry => entryId(entry) === sourceId);
    const next = cloneJson(entries);
    next.splice(index + 1, 0, duplicate);
    return { entries: refreshMixedBookIndexes(next), id: entryId(duplicate) };
  }

  function activeBookSignature(activeBooks) {
    return activeBooks.map(book => book.name).sort((a, b) => a.localeCompare(b, 'zh-CN')).join('\u0001');
  }

  function readLocalObject(key) {
    try {
      const parsed = JSON.parse(hostWindow().localStorage?.getItem?.(key) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) { return {}; }
  }

  function writeLocalObject(key, value) {
    try { hostWindow().localStorage?.setItem?.(key, JSON.stringify(value)); } catch (_error) {}
  }

  function loadMixedSlots(signature) {
    const slots = readLocalObject(MIXED_SLOT_STORAGE_KEY)[signature];
    return Array.isArray(slots) ? slots.map(String) : null;
  }

  function saveMixedSlots(signature, slots) {
    const store = readLocalObject(MIXED_SLOT_STORAGE_KEY);
    store[signature] = (slots || []).map(String);
    writeLocalObject(MIXED_SLOT_STORAGE_KEY, store);
  }

  function loadSourceVisible() {
    try { return hostWindow().localStorage?.getItem?.(SOURCE_VISIBILITY_KEY) !== 'false'; } catch (_error) { return true; }
  }

  function saveSourceVisible(value) {
    try { hostWindow().localStorage?.setItem?.(SOURCE_VISIBILITY_KEY, String(Boolean(value))); } catch (_error) {}
  }

  function loadMixedArrangeRules(storage) {
    try {
      const target = storage ?? hostWindow().localStorage;
      const parsed = JSON.parse(target?.getItem?.(MIXED_ARRANGE_STORAGE_KEY) || 'null');
      if (!Array.isArray(parsed)) return null;
      const seen = new Set();
      return parsed.filter(rule => rule && typeof rule.key === 'string' && !seen.has(rule.key) && seen.add(rule.key))
        .map(rule => ({ key: rule.key, direction: rule.direction === 'desc' ? 'desc' : 'asc' }));
    } catch (_error) { return null; }
  }

  function saveMixedArrangeRules(rules, storage) {
    const normalized = (Array.isArray(rules) ? rules : []).map(rule => ({ key: String(rule.key), direction: rule.direction === 'desc' ? 'desc' : 'asc' }));
    try {
      const target = storage ?? hostWindow().localStorage;
      target?.setItem?.(MIXED_ARRANGE_STORAGE_KEY, JSON.stringify(normalized));
    } catch (_error) {}
    return normalized;
  }

  function sourceLabel(identity) {
    return ({ global: '全局', character: '角色', chat: '聊天', persona: '个人', other: '其他' })[identity] || String(identity);
  }

  function activeSourceText(view, bookName) {
    const book = (view.activeBooks || []).find(item => item.name === bookName);
    const labels = (book?.identities || []).map(sourceLabel);
    return labels.length ? bookName + ' · ' + labels.join('／') : bookName;
  }

  function dedupeActiveSources(sources, validNames) {
    const allowed = new Set(validNames || []);
    const books = new Map();
    (sources || []).forEach(source => {
      const name = String(source?.name || '').trim();
      const identity = String(source?.identity || '').trim();
      if (!name || !identity || (allowed.size && !allowed.has(name))) return;
      if (!books.has(name)) books.set(name, { name, identities: [] });
      const item = books.get(name);
      if (!item.identities.includes(identity)) item.identities.push(identity);
    });
    return [...books.values()];
  }

  function selectedGlobalSourcesFromDom(doc) {
    const select = doc?.getElementById?.('world_info');
    if (!select || typeof select.querySelectorAll !== 'function') return { available: false, sources: [] };
    const sources = [...select.querySelectorAll('option:checked, option[selected]')]
      .filter(option => option?.selected !== false)
      .map(option => String(option?.textContent ?? option?.innerText ?? '').trim())
      .filter(Boolean)
      .map(name => ({ name, identity: 'global' }));
    return { available: true, sources };
  }

  async function collectWorldInfoEvidence(context, timeoutMs = 2500) {
    const eventName = context?.eventTypes?.WORLDINFO_ENTRIES_LOADED;
    const emitter = context?.eventSource;
    const prompt = context?.getWorldInfoPrompt;
    if (!eventName || typeof emitter?.on !== 'function' || typeof emitter?.removeListener !== 'function' || typeof prompt !== 'function') {
      return { available: false, payload: null, reason: '缺少 getWorldInfoPrompt、WORLDINFO_ENTRIES_LOADED 或可清理事件监听能力' };
    }
    let payload = null;
    let active = true;
    let timer = null;
    const listener = value => { if (active && payload === null && value && typeof value === 'object') payload = value; };
    emitter.on(eventName, listener);
    try {
      await Promise.race([
        Promise.resolve(prompt([], Math.max(1, Number(context.maxContext) || 1), true)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('世界书 dry-run 证据等待超时')), Math.max(1, Number(timeoutMs) || 2500)); }),
      ]);
      return { available: true, payload, reason: payload ? '' : 'dry-run 已完成但未收到 WORLDINFO_ENTRIES_LOADED' };
    } catch (error) {
      return { available: true, payload: null, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      active = false;
      if (timer !== null) clearTimeout(timer);
      emitter.removeListener(eventName, listener);
    }
  }

  function sourcesFromWorldInfoEvidence(payload) {
    const sources = [];
    for (const [key, identity] of [['globalLore', 'global'], ['characterLore', 'character'], ['chatLore', 'chat'], ['personaLore', 'persona']]) {
      (Array.isArray(payload?.[key]) ? payload[key] : []).forEach(entry => { if (entry?.world) sources.push({ name: entry.world, identity }); });
    }
    return sources;
  }

  async function discoverActiveBooks(view, environment = {}) {
    const api = environment.api ?? sillyTavernApi();
    const context = environment.context ?? api?.getContext?.();
    if (!context) throw new Error('SillyTavern 1.18.0 getContext() 不可用，无法可靠识别当前生效世界书。');
    const domEvidence = selectedGlobalSourcesFromDom(environment.document ?? hostDocument());
    const sources = [...domEvidence.sources];
    const chatBook = context.chatMetadata?.world_info;
    if (chatBook) sources.push({ name: chatBook, identity: 'chat' });
    const personaBook = context.powerUserSettings?.persona_description_lorebook;
    if (personaBook) sources.push({ name: personaBook, identity: 'persona' });
    const character = context.characters?.[context.characterId];
    const baseBook = character?.data?.extensions?.world;
    if (baseBook) sources.push({ name: baseBook, identity: 'character' });
    const eventEvidence = await collectWorldInfoEvidence(context, environment.timeoutMs);
    sources.push(...sourcesFromWorldInfoEvidence(eventEvidence.payload));
    const books = dedupeActiveSources(sources, view.names);
    const globalReliable = domEvidence.available || Boolean(eventEvidence.payload);
    if (!globalReliable) {
      throw new Error('无法可靠识别当前生效世界书：宿主 #world_info 全局选择投影不可用；' + (eventEvidence.reason || '世界书 dry-run 事件证据不可用') + '。');
    }
    return books;
  }

  function mixedPositionTuple(entry) {
    const order = ['before_character_definition', 'after_character_definition', 'before_example_messages', 'after_example_messages', 'before_author_note', 'after_author_note', 'at_depth', 'outlet'];
    const pos = positionInfo(entry);
    const role = ['system', 'user', 'assistant'].indexOf(pos.role);
    const positionRank = order.indexOf(pos.type);
    return [positionRank < 0 ? 99 : positionRank, pos.type === 'at_depth' ? (role < 0 ? 99 : role) : -1, pos.type === 'at_depth' ? -(pos.depth ?? -Infinity) : 0, Number.isFinite(pos.order) ? pos.order : Infinity, String(entry._iwbBook), Number(entry._iwbBookIndex || 0)];
  }

  function compareMixedEntries(left, right) {
    const a = mixedPositionTuple(left), b = mixedPositionTuple(right);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] === b[index]) continue;
      return typeof a[index] === 'string' ? a[index].localeCompare(b[index], 'zh-CN') : a[index] - b[index];
    }
    return 0;
  }

  function resolveMixedSlots(entries, slots) {
    const queues = new Map();
    entries.forEach(entry => {
      const book = String(entry._iwbBook);
      if (!queues.has(book)) queues.set(book, []);
      queues.get(book).push(entry);
    });
    const output = [];
    (slots || []).forEach(book => { const queue = queues.get(String(book)); if (queue?.length) output.push(queue.shift()); });
    const remaining = [...queues.values()].flat().sort(compareMixedEntries);
    return [...output, ...remaining];
  }

  function refreshMixedBookIndexes(entries) {
    const counts = new Map();
    entries.forEach(entry => {
      const book = String(entry._iwbBook);
      entry._iwbBookIndex = counts.get(book) || 0;
      counts.set(book, entry._iwbBookIndex + 1);
    });
    return entries;
  }

  async function loadMixedBooks(view) {
    view.loading = true;
    view.error = '';
    renderDynamic(view, { list: true });
    try {
      const activeBooks = await discoverActiveBooks(view);
      if (!activeBooks.length) throw new Error('当前没有可识别的生效世界书。');
      const getWorldbook = requirePublicFunction('getWorldbook');
      const loaded = await Promise.all(activeBooks.map(async book => {
        const entries = await getWorldbook(book.name);
        assertUniqueEntries(entries);
        return { ...book, baseline: cloneJson(entries) };
      }));
      view.mixedMode = true;
      view.transferStates = new Map(); view.transferMoveTargets = new Set(); view.transferDraft = createTransferDraft();
      view.book = MIXED_BOOK_VALUE;
      view.activeBooks = activeBooks;
      view.bookStates = new Map(loaded.map(state => [state.name, state]));
      view.mixedSignature = activeBookSignature(activeBooks);
      const defaults = loaded.flatMap(state => state.baseline.map((entry, index) => mixedEntry(state.name, entry, index)));
      const historical = loadMixedSlots(view.mixedSignature);
      view.working = initializeMixedWorking(defaults, historical);
      view.baseline = cloneJson(view.working);
      view.slotBaseline = mixedSlotSequence(view.working);
      view.sourceVisible = loadSourceVisible();
      view.selected.clear(); view.expanded.clear(); view.tokenCounts.clear(); view.undo = [];
      view.query = ''; view.stateFilter = 'all'; view.positionFilter = 'all'; view.renderLimit = APP.chunkSize;
      syncTopControls(view);
    } catch (error) {
      view.error = error instanceof Error ? error.message : String(error);
      toast('error', view.error, '生效世界书读取失败');
    } finally {
      view.loading = false;
      renderDynamic(view, { list: true, resetScroll: true });
    }
  }

  function mixedChangedIds(view) {
    const changed = new Set();
    const groups = mixedGroups(view.working);
    for (const state of mixedStateList(view)) {
      const current = groups.get(state.name) || [];
      const baseIds = state.baseline.map(entry => typeof entry.uid + ':' + String(entry.uid));
      const currentIds = current.map(entry => typeof entry.uid + ':' + String(entry.uid));
      current.forEach((entry, index) => {
        const id = typeof entry.uid + ':' + String(entry.uid);
        const base = state.baseline.find(candidate => typeof candidate.uid + ':' + String(candidate.uid) === id);
        if (jsonText(base) !== jsonText(entry) || baseIds[index] !== currentIds[index]) changed.add(entryId({ _iwbBook: state.name, _iwbOriginalUid: entry.uid }));
      });
    }
    return changed;
  }

  function singleChangeSummary(baseline, working) {
    if (!baseline || !working) return { fieldCount: 0, arrangement: false };
    const baseById = new Map(baseline.map(entry => [entryId(entry), entry]));
    const workById = new Map(working.map(entry => [entryId(entry), entry]));
    let fieldCount = 0;
    for (const [id, entry] of workById) if (jsonText(baseById.get(id)) !== jsonText(entry)) fieldCount += 1;
    for (const id of baseById.keys()) if (!workById.has(id)) fieldCount += 1;
    const arrangement = jsonText(baseline.map(entryId)) !== jsonText(working.map(entryId));
    return { fieldCount, arrangement };
  }

  function pendingSummary(view) {
    if (!view?.baseline || !view?.working) return { text: '无未保存修改', bookDirtyCount: 0, slotDirty: false };
    if (!view.mixedMode) {
      const transferDirty = view.transferStates?.size ? transferDirtyBooks(view) : [];
      if (transferDirty.length && transferTargetStates(view).some(state => jsonText(state.baseline) !== jsonText(state.working))) return { text: transferDirty.length + ' 本书有未保存修改', bookDirtyCount: transferDirty.length, slotDirty: false };
      const summary = singleChangeSummary(view.baseline, view.working);
      const parts = [];
      if (summary.fieldCount) parts.push('字段修改 ' + summary.fieldCount + ' 条');
      if (summary.arrangement) parts.push('排列调整 1 项');
      return { ...summary, text: parts.length ? parts.join(' / ') : '无未保存修改', bookDirtyCount: isDirty(view) ? 1 : 0, slotDirty: false };
    }
    const bookDirtyCount = mixedDirtyBooks(view).length;
    const slotDirty = jsonText(mixedSlotSequence(view.working)) !== jsonText(view.slotBaseline || []);
    const parts = [];
    if (bookDirtyCount) parts.push(bookDirtyCount + ' 本书有未保存修改');
    if (slotDirty) parts.push('总览排列待保存');
    return { text: parts.length ? parts.join(' / ') : '无未保存修改', bookDirtyCount, slotDirty };
  }

  function mobilePendingSummary(view, summary = pendingSummary(view)) {
    if (view?.mixedMode || view?.transferStates?.size) return summary.text;
    const parts = [];
    if (summary.fieldCount) parts.push('字段 ' + summary.fieldCount + ' 条');
    if (summary.arrangement) parts.push('排列 1 项');
    return parts.length ? parts.join(' · ') : '无未保存修改';
  }

  function pendingChangeCount(view) {
    const summary = pendingSummary(view);
    return view?.mixedMode ? summary.bookDirtyCount + (summary.slotDirty ? 1 : 0) : summary.fieldCount + (summary.arrangement ? 1 : 0);
  }

  async function saveMixed(view) {
    const dirty = mixedDirtyBooks(view);
    const slotDirty = jsonText(mixedSlotSequence(view.working)) !== jsonText(view.slotBaseline || []);
    if (!dirty.length && !slotDirty) return true;
    const getWorldbook = requirePublicFunction('getWorldbook');
    const updateWorldbookWith = requirePublicFunction('updateWorldbookWith');
    const groups = mixedGroups(view.working);
    const results = [];
    view.busy = 'save'; renderDynamic(view);
    for (const name of dirty) {
      const state = view.bookStates.get(name);
      try {
        const verified = await persistWorkingCopy(name, state.baseline, groups.get(name) || [], getWorldbook, updateWorldbookWith);
        state.baseline = cloneJson(verified);
        results.push({ name, ok: true });
      } catch (error) {
        results.push({ name, ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    }
    const failures = results.filter(result => !result.ok);
    if (!failures.length) {
      saveMixedSlots(view.mixedSignature, mixedSlotSequence(view.working));
      view.slotBaseline = mixedSlotSequence(view.working);
      view.baseline = cloneJson(view.working);
      view.undo = [];
      toast('success', dirty.length ? '已保存 ' + dirty.length + ' 本实际修改的世界书，并固定混排槽位。' : '总览排列已保存到本机，不会写入世界书。');
    } else {
      view.baseline = rebuildMixedBaseline(view);
      view.undo = [];
      toast('error', '已保存 ' + (results.length - failures.length) + ' 本，' + failures.length + ' 本失败：' + failures.map(item => '《' + item.name + '》' + item.message).join('；') + ' 失败书工作副本和混排草稿均已保留。', '部分保存失败');
    }
    view.busy = null; renderDynamic(view, { list: true });
    return failures.length === 0;
  }

  function guideHtml() {
    return `<section class="qa-guide-layer" data-slot="guide" hidden><button type="button" class="qa-guide-backdrop" data-action="guide-close" aria-label="关闭新手指引"></button><div class="qa-guide-dialog"><header class="qa-guide-head"><h3>功能简介</h3><button type="button" class="qa-icon" data-action="guide-close" aria-label="关闭功能简介">×</button></header><div class="qa-guide-layout"><nav class="qa-guide-nav qa-guide-desktop-only" aria-label="功能简介目录"><button type="button" class="qa-guide-nav-item is-active" data-guide-target="guide-view">多书总览</button><button type="button" class="qa-guide-nav-item" data-guide-target="guide-edit">条目编辑</button><button type="button" class="qa-guide-nav-item" data-guide-target="guide-batch">批量操作</button><button type="button" class="qa-guide-nav-item" data-guide-target="guide-transfer">导入与转移</button><button type="button" class="qa-guide-nav-item" data-guide-target="guide-arrange">整理排列</button><button type="button" class="qa-guide-nav-item" data-guide-target="guide-save">撤销与保存</button><button type="button" class="qa-guide-nav-item" data-guide-target="guide-tools">其它工具</button><button type="button" class="qa-guide-nav-item" data-guide-target="guide-about">关于</button></nav><div class="qa-guide-body">
      <section id="guide-view" class="qa-guide-section qa-guide-anchor"><h4>当前生效多书</h4><p>在同一工作台查看和编辑当前识别为生效的多本世界书。总览不代表实际提示词注入顺序。</p></section>
      <section id="guide-edit" class="qa-guide-section qa-guide-anchor"><h4>常规字段编辑</h4><p>支持标题、主关键词、正文、启用状态、蓝灯／绿灯、位置、角色／深度、顺序和列表排列。</p></section>
      <section id="guide-batch" class="qa-guide-section qa-guide-anchor"><h4>批量操作</h4><p>支持批量修改位置与顺序、调整列表排列和批量删除。</p></section>
      <section id="guide-transfer" class="qa-guide-section qa-guide-anchor"><h4>导入与跨书转移</h4><p>支持从其他书导入，以及在世界书之间复制或移动条目。</p></section>
      <section id="guide-arrange" class="qa-guide-section qa-guide-anchor"><h4>一键整理与设置</h4><p>支持本书或多书总览的一键整理排列，以及彼此独立的整理设置。</p></section>
      <section id="guide-save" class="qa-guide-section qa-guide-anchor"><h4>撤销、放弃与保存</h4><p>支持撤销上一步、放弃本轮调整和保存全部；未保存的编辑不会写入世界书。</p></section>
      <section id="guide-tools" class="qa-guide-section qa-guide-anchor"><h4>其它工具</h4><p>支持新建、复制、单条删除、禁止全部递归、重新读取和来源显示。</p></section>
      <section id="guide-about" class="qa-guide-section qa-guide-about qa-guide-anchor"><h4>关于</h4><p>世界书观测台 v${APP.version}｜三端适配｜作者：砚梨</p></section>
    </div></div></div></section>`;
  }


  function templateHtml() {
    return `<div id="iwb-qa-root"><style>${STYLES}</style><div class="qa-shell">
      <header class="qa-head">
        <div class="qa-title-row"><div class="qa-title"><h2>世界书观测台</h2></div><button class="qa-icon" data-action="guide-open" aria-label="打开新手指引" title="新手指引"><i class="fa-solid fa-question" aria-hidden="true"></i></button><button class="qa-icon qa-mobile-close" data-action="close" aria-label="关闭世界书观测台">×</button></div>
        <div class="qa-mode-segments" role="group" aria-label="当前操作模式"><button class="qa-mode-segment is-active" data-action="mode" data-mode="edit">编辑模式</button><button class="qa-mode-segment" data-action="mode" data-mode="move">移动模式</button><button class="qa-mode-segment qa-title-lock" data-action="title-lock" aria-pressed="true">🔒标题</button></div>
        <div class="qa-top-grid"><select class="qa-select qa-top-left" data-control="book" aria-label="选择一本具体世界书或当前生效总览"><option value="">选择一本具体世界书</option></select><button class="qa-btn qa-top-right" data-action="new-entry">新建条目</button><div class="qa-filter-pair qa-top-left"><input class="qa-input" data-control="search" type="search" placeholder="搜索"><select class="qa-select" data-control="state-filter-select" aria-label="显示范围"><option value="all">显示范围：全部</option><option value="selected">显示范围：仅已选</option><option value="changed">显示范围：仅已修改</option></select></div><button class="qa-btn qa-top-right" data-action="other-tools" aria-expanded="false">其它工具</button></div>
        <div class="qa-other-tools" data-slot="other-tools" hidden><button class="qa-btn" data-action="panel-import"><i class="fa-solid fa-file-import" aria-hidden="true"></i> 从其他书导入</button><button class="qa-btn" data-action="panel-transfer"><i class="fa-solid fa-arrow-right-arrow-left" aria-hidden="true"></i> 转移到其他书</button><button class="qa-btn" data-action="auto-arrange">一键整理排列</button><button class="qa-btn" data-action="arrange-settings">整理设置</button><button class="qa-btn" data-action="disable-recursion">禁止全部递归</button><button class="qa-btn" data-action="reload">重新读取当前书</button></div>
        <div class="qa-status" data-slot="status">正在读取世界书列表……</div>
      </header>
      <div class="qa-desktop-task-head" data-slot="desktop-task-head" hidden><strong data-slot="desktop-task-title">任务工作区</strong><div class="qa-desktop-task-direction" data-slot="desktop-task-direction"></div><button class="qa-btn qa-desktop-task-back" data-action="desktop-task-back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> 返回列表</button></div>
      <section class="qa-workspace-panel" data-slot="workspace-panel" hidden></section>
      <main class="qa-scroll" data-slot="scroll"><div class="qa-empty">请选择一本具体世界书开始编排。</div></main>
      <footer class="qa-footer" data-slot="footer"></footer>
    </div><section class="qa-content-layer" data-slot="content-editor" hidden aria-label="全屏编辑条目"><header class="qa-content-head"><button class="qa-btn" data-action="content-back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> 返回</button><div class="qa-content-context"><small><span data-slot="content-context">当前世界书 · UID</span> · Token <b data-slot="content-token">未计算</b></small></div><button class="qa-btn primary" data-action="content-done">完成</button></header><div class="qa-content-body"><div class="qa-content-paper"><section class="qa-content-paper-title" data-slot="content-title-draft"></section><section class="qa-content-paper-keys" data-slot="content-keys-draft"></section><textarea class="qa-content-textarea" data-control="content-full" aria-label="条目正文"></textarea></div></div></section>${guideHtml()}<section class="qa-leave-layer" data-slot="leave-modal" hidden aria-label="未保存修改提醒"></section></div>`;
  }

  function renderBookOptions(view) {
    const select = view.root.querySelector('[data-control="book"]');
    const value = view.book || '';
    select.innerHTML = `<option value="">选择一本具体世界书</option><option value="${MIXED_BOOK_VALUE}"${value === MIXED_BOOK_VALUE ? ' selected' : ''}>当前生效世界书总览</option>${view.names.map(name => optionHtml(name, name, value)).join('')}`;
    select.value = value;
    /* IWB_IMPORT_SELECTOR_STATE_BEGIN */
    const lockedPanel = view.panel === 'arrange-settings' || view.panel === 'transfer' || view.panel === 'import';
    select.disabled = Boolean(view.busy || lockedPanel);
    select.toggleAttribute('disabled', select.disabled);
    select.setAttribute('aria-disabled', String(select.disabled));
    select.inert = select.disabled;
    select.classList.toggle('qa-source-locked', view.panel === 'transfer' || view.panel === 'import');
    select.title = view.panel === 'import' ? '请先退出从其他书导入' : view.panel === 'transfer' ? '请先退出跨书转移' : view.panel === 'arrange-settings' ? '请先保存或取消整理设置' : '';
    /* IWB_IMPORT_SELECTOR_STATE_END */
  }

  function renderStatus(view) {
    const node = view.root.querySelector('[data-slot="status"]');
    if (view.loading) node.textContent = '正在读取完整条目对象……';
    else if (view.error) node.textContent = `读取失败：${view.error}`;
    else if (!view.book) node.textContent = `共 ${view.names.length} 本世界书，请选择一本具体世界书或当前生效总览。`;
    else if (view.mixedMode) {
      const counts = { global: 0, character: 0, chat: 0, other: 0 };
      view.activeBooks.forEach(book => book.identities.forEach(identity => { const key = identity === 'persona' ? 'other' : identity; if (Object.hasOwn(counts, key)) counts[key] += 1; }));
      node.textContent = `当前生效世界书 ${view.activeBooks.length} 本（同书多重身份按一本统计） · 全局 ${counts.global} · 角色 ${counts.character} · 聊天 ${counts.chat} · 其他 ${counts.other} · 当前显示 ${visibleEntries(view).length} 条`;
    } else {
      const shown = visibleEntries(view).length;
      node.textContent = `《${view.book}》共 ${view.working.length} 条 · 当前显示 ${shown} 条 · 已选择 ${view.selected.size} 条`;
    }
  }


  function nameButtonHtml(entry, readonly = false) {
    return readonly
      ? `<div class="qa-name qa-name-readonly">${escapeHtml(entryName(entry))}</div>`
      : `<button class="qa-name" data-action="name-edit" title="编辑条目名称">${escapeHtml(entryName(entry))}</button>`;
  }

  function inlineFieldsHtml(entry) {
    const pos = positionInfo(entry);
    const positionField = pos.editable ? `<select class="qa-select" data-control="entry-position" aria-label="原生位置">${POSITION_TYPES.map(type => optionHtml(type, POSITION_LABELS[type], pos.type)).join('')}</select>` : `<input class="qa-input" value="${escapeHtml(pos.label)}" aria-label="原生位置" disabled>`;
    const depthRow = pos.editable && pos.type === 'at_depth' ? `<div class="qa-inline-row qa-depth-row"><label class="qa-inline-field"><span>角色</span><select class="qa-select" data-control="entry-role">${Object.entries(ROLE_LABELS).map(([role, label]) => optionHtml(role, role === 'assistant' ? '助手' : label, pos.role || 'system')).join('')}</select></label><label class="qa-inline-field"><span>深度</span><input class="qa-input" data-control="entry-depth" type="number" min="0" step="1" value="${escapeHtml(pos.depth ?? 4)}"></label></div>` : '';
    return `<div class="qa-inline-row"><label class="qa-inline-field"><span>位置</span>${positionField}</label><label class="qa-inline-field"><span>顺序</span><input class="qa-input" data-control="entry-order" type="number" step="any" value="${escapeHtml(pos.order ?? 100)}" ${pos.editable ? '' : 'disabled'}></label></div>${depthRow}`;
  }

  function refreshInlineFields(view, cardId) {
    const entry = view.working.find(candidate => entryId(candidate) === cardId);
    const region = view.root.querySelector(`[data-entry-id="${cssEscape(cardId)}"] .qa-inline-fields`);
    if (entry && region) region.innerHTML = inlineFieldsHtml(entry);
  }

  function inlineFieldMutation(entries, cardId, control, rawValue) {
    const entry = entries.find(candidate => entryId(candidate) === cardId);
    if (!entry) throw new Error('没有找到要编辑的条目。');
    const current = positionInfo(entry);
    if (control === 'entry-position') {
      return mutatePosition(entries, [cardId], String(rawValue), current.depth ?? 4, current.role || 'system');
    } else if (control === 'entry-depth') {
      return mutatePosition(entries, [cardId], current.type, Number(rawValue), current.role || 'system');
    } else if (control === 'entry-role') {
      return mutatePosition(entries, [cardId], current.type, current.depth ?? 4, String(rawValue));
    } else if (control === 'entry-order') {
      return mutateOrder(entries, [cardId], 'same', Number(rawValue), 0);
    }
    return cloneJson(entries);
  }

  function commitInlineField(view, cardId, control, rawValue) {
    const labels = { 'entry-position': '修改单条原生位置', 'entry-depth': '修改单条深度', 'entry-role': '修改单条深度角色', 'entry-order': '修改单条顺序' };
    if (!labels[control]) return false;
    let next = inlineFieldMutation(view.working, cardId, control, rawValue);
    const changed = applyWorkingQuiet(view, labels[control], () => next, cardId);
    if (changed) {
      const scroll = view.root?.querySelector?.('[data-slot="scroll"]');
      const scrollTop = scroll?.scrollTop;
      renderDynamic(view, { list: true });
      if (scroll && Number.isFinite(scrollTop)) scroll.scrollTop = scrollTop;
    }
    return changed;
  }

  /* IWB_PC_TITLE_RULE_BEGIN */
  function isDesktopLayout(view) {
    const width = Number(view?.root?.getBoundingClientRect?.().width || view?.root?.clientWidth || 0);
    if (width) return width > 480;
    try { return Boolean(window?.matchMedia?.('(min-width: 481px)')?.matches); }
    catch { return false; }
  }

  function canEditTitle(view) {
    return !view.moveMode && (isDesktopLayout(view) || !view.titleLocked);
  }
  /* IWB_PC_TITLE_RULE_END */

  function startNameEdit(view, cardId) {
    if (!canEditTitle(view)) return false;
    const activeInputs = [...(view.root.querySelectorAll?.('[data-control="entry-name-inline"]') || [])];
    activeInputs.forEach(input => finishNameEdit(view, input, true));
    const entry = view.working.find(candidate => entryId(candidate) === cardId);
    const card = view.root.querySelector(`[data-entry-id="${cssEscape(cardId)}"]`);
    const name = card?.querySelector('.qa-name');
    if (!entry || !name) return false;
    name.outerHTML = `<div class="qa-name-edit"><input class="qa-name-input" data-control="entry-name-inline" value="${escapeHtml(entry?.name ?? '')}" aria-label="条目名称"><button class="qa-name-done" data-action="name-done" aria-label="确认名称修改" title="确认名称修改"><span aria-hidden="true">✓</span></button></div>`;
    const input = card.querySelector('[data-control="entry-name-inline"]');
    if (!input) return false;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange?.(end, end);
    return true;
  }

  function finishNameEdit(view, input, commit) {
    if (input.dataset.finishing === 'true') return false;
    input.dataset.finishing = 'true';
    const editor = input.closest('.qa-name-edit');
    const cardId = input.closest('.qa-card')?.dataset.entryId;
    if (cardId && commit) applyWorkingQuiet(view, '编辑条目名称', () => mutateEntry(view.working, cardId, entry => { entry.name = String(input.value); }), cardId);
    const entry = cardId ? view.working.find(candidate => entryId(candidate) === cardId) : null;
    if (entry && editor) editor.outerHTML = nameButtonHtml(entry);
    else editor?.remove?.();
    return Boolean(cardId);
  }

  function armNameClickGuard(view, event) {
    view.nameClickGuard = {
      pointerId: Number.isFinite(event?.pointerId) ? event.pointerId : null,
      expiresAt: Date.now() + 800,
    };
  }

  function consumeNameClickGuard(view, event) {
    const guard = view.nameClickGuard;
    if (!guard) return false;
    view.nameClickGuard = null;
    if (Date.now() > guard.expiresAt) return false;
    const pointerId = Number.isFinite(event?.pointerId) ? event.pointerId : null;
    if (guard.pointerId !== null && pointerId !== null && guard.pointerId !== pointerId) return false;
    return true;
  }


  function editorHtml(entry) {
    const id = entryId(entry);
    const secondary = Array.isArray(entry?.strategy?.keys_secondary?.keys) ? entry.strategy.keys_secondary.keys : [];
    const advanced = secondary.length ? `<div class="qa-advanced-note">含 ${secondary.length} 个辅助关键词／高级条件，本版只读并原样保留。</div>` : '';
    return `<section class="qa-editor" data-editor-id="${escapeHtml(id)}"><div class="qa-fields">
      <div class="qa-field qa-wide"><span>主关键词</span><div class="qa-keyword-editor">${keywordEditorContents(entry)}</div></div>
      <div class="qa-field qa-wide"><div class="qa-content-label"><span>正文 <small class="qa-content-uid">· UID ${escapeHtml(entry._iwbOriginalUid ?? entry.uid)}</small></span><span class="qa-recursion-status">${recursionStatusHtml(entry)}</span><button class="qa-content-open" data-action="content-open" aria-label="全屏编辑正文" title="全屏编辑正文"><i class="fa-solid fa-expand" aria-hidden="true"></i></button></div><div class="qa-content-preview">${escapeHtml(contentPreviewText(entry?.content, 900))}</div></div>
    </div>${advanced}</section>`;
  }

  function keywordEditorContents(entry) {
    const chips = normalizePrimaryKeys(primaryKeys(entry)).map((key, index) => `<span class="qa-keyword-chip"><span>${escapeHtml(key)}</span><button class="qa-keyword-remove" data-action="key-remove" data-key-index="${index}" aria-label="删除主关键词 ${escapeHtml(key)}">×</button></span>`).join('');
    return `${chips}<textarea class="qa-keyword-input" data-control="entry-key-input" rows="1" placeholder="连续输入关键词" inputmode="text" autocomplete="off"></textarea><button class="qa-btn qa-keyword-add" data-action="key-add" aria-label="添加主关键词">添加</button>`;
  }

  function updateKeywordEditor(view, cardId, focusInput = false) {
    const entry = view.working.find(candidate => entryId(candidate) === cardId);
    const editor = view.root.querySelector(`[data-entry-id="${cssEscape(cardId)}"] .qa-keyword-editor`);
    if (!entry || !editor) return;
    editor.innerHTML = keywordEditorContents(entry);
    if (focusInput) editor.querySelector('[data-control="entry-key-input"]')?.focus();
  }

  function commitKeywordInput(view, input, refocus = false) {
    const cardId = input.closest('.qa-card')?.dataset.entryId;
    const value = String(input.value || '');
    if (!cardId || !value.trim()) return false;
    const changed = applyWorkingQuiet(view, '新增主关键词', () => mutateEntry(view.working, cardId, entry => {
      if (!entry.strategy || typeof entry.strategy !== 'object' || Array.isArray(entry.strategy)) throw new Error('当前条目的激活策略无法无损编辑。');
      entry.strategy.keys = mergePrimaryKeys(entry.strategy.keys, value);
    }), cardId);
    input.value = '';
    if (changed) updateKeywordEditor(view, cardId, refocus);
    else if (refocus) input.focus();
    return changed;
  }


  function cardHtml(view, entry, changed, globalIndex) {
    const id = entryId(entry);
    const selected = view.selected.has(id);
    const expanded = !view.moveMode && view.expanded.has(id);
    const enabled = enabledPresentation(entry);
    const activation = editableActivationType(entry);
    const rawActivation = String(entry?.strategy?.type ?? 'unknown');
    const greenActivation = activation === 'selective' || activation === 'normal';
    const lampLabel = activation === 'constant' ? '蓝灯：永久' : greenActivation ? '绿灯：关键词' : rawActivation === 'vectorized' ? '向量状态，只读' : `无法无损映射：${rawActivation}`;
    const lampClass = activation === 'constant' ? 'blue' : greenActivation ? 'green' : rawActivation === 'vectorized' ? 'vector readonly' : 'readonly';
    const lampIcon = rawActivation === 'constant' ? '🔵' : greenActivation ? '🟢' : '🔗';
    const editActions = `<button class="qa-drag" data-action="drag" title="拖动排列" aria-label="拖动排列"><i class="fa-solid fa-bars" aria-hidden="true"></i></button><button class="qa-switch" data-action="enabled" role="switch" aria-checked="${enabled.checked}" ${enabled.disabled ? 'disabled' : ''} aria-label="${escapeHtml(enabled.label)}" title="${escapeHtml(enabled.title)}"></button><button class="qa-action-icon qa-lamp ${lampClass}" data-action="activation" ${activation ? '' : 'disabled'} title="${escapeHtml(lampLabel)}" aria-label="${escapeHtml(lampLabel)}">${lampIcon}</button><button class="qa-action-icon" data-action="duplicate" title="复制条目" aria-label="复制条目"><i class="fa-solid fa-copy" aria-hidden="true"></i></button><button class="qa-action-icon qa-delete" data-action="delete" title="删除条目" aria-label="删除条目"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>`;
    const moveActions = `<button class="qa-drag" data-action="drag" title="拖动排列" aria-label="拖动排列"><i class="fa-solid fa-bars" aria-hidden="true"></i></button><button class="qa-move" data-action="move" data-direction="up">上移</button><button class="qa-move" data-action="move" data-direction="down">下移</button><button class="qa-move" data-action="move" data-direction="top">置顶</button><button class="qa-move" data-action="move" data-direction="bottom">置底</button>`;
    const sourceText = view.mixedMode ? activeSourceText(view, entry._iwbBook) : '';
    const source = view.mixedMode && view.sourceVisible ? `<div class="qa-source" title="${escapeHtml(entry._iwbBook)}">${escapeHtml(sourceText)}</div>` : '';
    const bookNo = view.mixedMode ? (Number(entry._iwbBookIndex || 0) + 1) : (globalIndex + 1);
    return `<article class="qa-card${selected ? ' is-selected' : ''}${changed.has(id) ? ' is-changed' : ''}${expanded ? ' is-expanded' : ''}" data-entry-id="${escapeHtml(id)}" data-book="${escapeHtml(entry._iwbBook || view.book)}">
      <div class="qa-card-main"><div class="qa-card-head"><input class="qa-check" type="checkbox" data-action="toggle" ${selected ? 'checked' : ''} aria-label="选择 ${escapeHtml(entryName(entry))}"><div class="qa-name-cell">${nameButtonHtml(entry, !canEditTitle(view))}${source}<div class="qa-name-meta">${view.mixedMode ? `总览 No.${globalIndex + 1} · 本书 No.${bookNo}` : `No.${globalIndex + 1}`} · Token <b data-token-id="${escapeHtml(id)}">${escapeHtml(tokenLabel(view, entry))}</b></div></div>${view.moveMode ? '<span class="qa-mode-lock" title="移动模式下标题只读"><i class="fa-solid fa-lock" aria-hidden="true"></i></span>' : `<button class="qa-expand" data-action="expand" aria-expanded="${expanded}" aria-label="${expanded ? '收起' : '展开'}条目"><i class="fa-solid fa-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true"></i></button>`}</div><div class="qa-inline-fields" ${view.moveMode ? 'inert aria-disabled="true"' : ''}>${inlineFieldsHtml(entry)}</div>
      <div class="qa-summary-actions" data-operation-mode="${view.moveMode ? 'move' : 'edit'}">${view.moveMode ? moveActions : editActions}</div>${expanded ? editorHtml(entry) : ''}</div></article>`;
  }


  function transferResultsHtml(view) {
    const draft = view.transferDraft;
    const visible = visibleTransferEntries(view);
    const rows = visible.map(entry => {
      const id = entryId(entry);
      return sourcePreviewRow(entry, draft.selected.has(id), draft.previewed.has(id), 'transfer');
    }).join('');
    return `<div class="qa-import-list qa-transfer-list" data-slot="transfer-list">${rows || '<div class="qa-panel-note">没有匹配条目。</div>'}</div><div class="qa-import-summary">显示 ${visible.length} 条 · 已选 ${draft.selected.size} 条</div>`;
  }

  function transferWorkspaceHtml(view) {
    const draft = view.transferDraft;
    const desktop = isDesktopLayout(view);
    const selectAllLabel = desktop ? '全选当前结果' : '全选';
    const clearLabel = desktop ? '清空选择' : '清空';
    if (!desktop && draft.phase === 'target') {
      const targets = view.names.filter(name => name !== view.book);
      const buttons = targets.map(name => `<button class="qa-btn qa-transfer-target" data-action="transfer-target" data-book="${escapeHtml(name)}" ${draft.loading ? 'disabled' : ''}>《${escapeHtml(name)}》</button>`).join('');
      return `<section class="qa-import-workspace qa-transfer-workspace"><div class="qa-mobile-task-head"><span class="qa-mobile-task-heading"><strong>转移到其他世界书</strong></span><button class="qa-btn qa-mobile-task-back" data-action="transfer-cancel">返回列表</button></div><header><div class="qa-workspace-title"><button class="qa-btn" data-action="transfer-back">返回</button><h3>选择目标世界书</h3><button class="qa-btn" data-action="transfer-cancel">取消</button></div><div class="qa-panel-note">来源书：《${escapeHtml(view.book)}》 · 将${draft.mode === 'move' ? '移动' : '复制'} ${draft.selected.size} 条</div></header><div class="qa-mobile-transfer-stage"><button class="qa-btn" data-action="transfer-back">返回选择条目</button><strong>选择目标世界书</strong></div><div class="qa-transfer-targets">${buttons || '<div class="qa-panel-note">没有可用的目标世界书。</div>'}</div></section>`;
    }
    const visible = visibleTransferEntries(view);
    const targets = view.names.filter(name => name !== view.book);
    const targetSelect = `<select class="qa-select" data-control="transfer-target-select"><option value="">选择目标世界书</option>${targets.map(name => optionHtml(name, name, draft.target)).join('')}</select>`;
    const unavailable = !draft.selected.size || (desktop && !draft.target);
    return `<section class="qa-import-workspace qa-transfer-workspace"><div class="qa-mobile-task-head"><span class="qa-mobile-task-heading"><strong>转移到其他世界书</strong></span><button class="qa-btn qa-mobile-task-back" data-action="transfer-cancel">返回列表</button></div><header><div class="qa-workspace-title"><h3><i class="fa-solid fa-arrow-right-arrow-left" aria-hidden="true"></i> 转移到其他书</h3><button class="qa-btn" data-action="transfer-cancel">取消</button></div><div class="qa-panel-note">来源书：《${escapeHtml(view.book)}》 · 操作只进入工作副本</div></header><div class="qa-task-direction qa-transfer-direction"><span class="qa-task-direction-current">当前世界书：《${escapeHtml(view.book)}》</span><span class="qa-task-direction-arrow" aria-hidden="true">→</span>${targetSelect}</div><div class="qa-task-toolbar qa-transfer-toolbar"><input class="qa-input" data-control="transfer-search" type="search" value="${escapeHtml(draft.query)}" placeholder="搜索来源条目（名称／关键词／UID）"><select class="qa-select" data-control="transfer-filter"><option value="all"${draft.filter === 'all' ? ' selected' : ''}>全部</option><option value="enabled"${draft.filter === 'enabled' ? ' selected' : ''}>仅已启用</option><option value="disabled"${draft.filter === 'disabled' ? ' selected' : ''}>仅已停用</option></select><button class="qa-btn" data-action="transfer-select-visible" ${!visible.length ? 'disabled' : ''}>${selectAllLabel}</button><button class="qa-btn" data-action="transfer-clear" ${!draft.selected.size ? 'disabled' : ''}>${clearLabel}</button></div><div class="qa-import-body" data-slot="transfer-results">${transferResultsHtml(view)}</div><div class="qa-import-actions qa-transfer-actions"><button class="qa-btn" data-action="transfer-choose" data-mode="copy" ${unavailable ? 'disabled' : ''}>复制</button><button class="qa-btn primary" data-action="transfer-choose" data-mode="move" ${unavailable ? 'disabled' : ''}>移动</button></div></section>`;
  }

  function cancelTransferWorkspace(view, render = renderDynamic) {
    const returnTop = view.transferReturnScroll || 0;
    view.panel = null;
    view.transferDraft = createTransferDraft();
    render(view, { list: true });
    const scroll = view.root.querySelector('[data-slot="scroll"]');
    if (scroll) scroll.scrollTop = Math.min(returnTop, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
    return true;
  }

  function importWorkspaceHtml(view) {
    const draft = view.importDraft;
    const desktop = isDesktopLayout(view);
    const selectAllLabel = desktop ? '全选当前结果' : '全选';
    const clearLabel = desktop ? '清空选择' : '清空';
    const sourceNames = view.names.filter(name => name !== view.book);
    const visible = visibleImportEntries(view);
    const toolbar = `<div class="qa-task-toolbar qa-import-toolbar"><input class="qa-input" data-control="import-search" type="search" value="${escapeHtml(draft.query)}" placeholder="搜索来源条目（名称／关键词／UID）"><select class="qa-select" data-control="import-filter"><option value="all"${draft.filter === 'all' ? ' selected' : ''}>全部</option><option value="enabled"${draft.filter === 'enabled' ? ' selected' : ''}>仅已启用</option><option value="disabled"${draft.filter === 'disabled' ? ' selected' : ''}>仅已停用</option></select><button class="qa-btn" data-action="import-select-visible" ${!draft.entries || !visible.length || draft.loading ? 'disabled' : ''}>${selectAllLabel}</button><button class="qa-btn" data-action="import-clear" ${!draft.selected.size ? 'disabled' : ''}>${clearLabel}</button></div>`;
    const body = draft.loading ? '<div class="qa-panel-note">正在读取来源书条目……</div>' : draft.error ? `<div class="qa-panel-note">读取失败：${escapeHtml(draft.error)}</div>` : draft.entries ? (draft.entries.length ? `${toolbar}<div data-slot="import-results">${importResultsHtml(view)}</div>` : '<div class="qa-panel-note">来源书没有条目。</div>') : '<div class="qa-panel-note">选择来源书后才会读取其内容；来源书始终只读。</div>';
    const sourceSelect = `<select class="qa-select" data-control="import-source"><option value="">选择来源世界书</option>${sourceNames.map(name => optionHtml(name, name, draft.source)).join('')}</select>`;
    const importActionLabel = desktop ? `导入 ${draft.selected.size} 条` : '导入';
    const directionTail = desktop ? `<span class="qa-task-direction-arrow" aria-hidden="true">→</span><span class="qa-task-direction-current">当前世界书：《${escapeHtml(view.book)}》</span>` : '';
    return `<section class="qa-import-workspace"><div class="qa-mobile-task-head"><span class="qa-mobile-task-heading"><strong>导入到当前世界书</strong></span><button class="qa-btn qa-mobile-task-back" data-action="import-cancel">返回列表</button></div><header><h3><i class="fa-solid fa-file-import" aria-hidden="true"></i> 从其他书导入</h3><div class="qa-panel-note">目标书：《${escapeHtml(view.book)}》 · 来源书只读</div></header><div class="qa-task-direction qa-import-direction">${sourceSelect}${directionTail}</div><div class="qa-import-body">${body}</div><div class="qa-import-actions"><button class="qa-btn primary qa-import-confirm" data-action="apply-import" ${!draft.entries || !draft.selected.size || draft.loading ? 'disabled' : ''}>${importActionLabel}</button><button class="qa-btn" data-action="import-cancel">取消</button></div></section>`;
  }

  function renderList(view, preserveScroll = true) {
    const scroll = view.root.querySelector('[data-slot="scroll"]');
    const oldTop = preserveScroll ? scroll.scrollTop : 0;
    scroll.classList?.toggle('qa-import-mode', view.panel === 'import' || view.panel === 'transfer' || view.panel === 'arrange-settings');
    if (view.panel === 'import' || view.panel === 'transfer' || view.panel === 'arrange-settings') {
      scroll.innerHTML = view.panel === 'import' ? importWorkspaceHtml(view) : view.panel === 'transfer' ? transferWorkspaceHtml(view) : `<section class="qa-arrange-workspace">${renderPanel(view)}</section>`;
      scroll.scrollTop = preserveScroll ? oldTop : 0;
      if (view.panel === 'transfer' && view.transferDraft.phase === 'select') restoreTransferListScroll(view);
      return;
    }
    if (!view.book || !view.working) {
      scroll.innerHTML = `<div class="qa-empty">${view.error ? escapeHtml(view.error) : '请选择一本具体世界书开始编排。'}</div>`;
      return;
    }
    const entries = visibleEntries(view);
    const changed = changedIds(view.baseline, view.working, view);
    const limit = Math.min(view.renderLimit, entries.length);
    const globalIndex = new Map(view.working.map((entry, index) => [entryId(entry), index]));
    const rendered = entries.slice(0, limit);
    scroll.innerHTML = `${listContextHtml(view, entries)}<div class="qa-list">${rendered.map(entry => cardHtml(view, entry, changed, globalIndex.get(entryId(entry)))).join('')}</div>${limit < entries.length ? `<button class="qa-more" data-action="more">继续显示（剩余 ${entries.length - limit} 条）</button>` : entries.length ? '' : '<div class="qa-empty">没有符合当前搜索与筛选的条目。</div>'}`;
    scroll.scrollTop = Math.min(oldTop, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
    scheduleTokenCounts(view, rendered);
  }

  function toggleExpandedAnchored(view, id) {
    const scroll = view.root.querySelector('[data-slot="scroll"]');
    const before = view.root.querySelector(`[data-entry-id="${cssEscape(id)}"]`);
    const beforeTop = before?.getBoundingClientRect?.().top;
    view.expanded.has(id) ? view.expanded.delete(id) : view.expanded.add(id);
    renderDynamic(view, { list: true });
    const after = view.root.querySelector(`[data-entry-id="${cssEscape(id)}"]`);
    const afterTop = after?.getBoundingClientRect?.().top;
    if (scroll && Number.isFinite(beforeTop) && Number.isFinite(afterTop)) {
      scroll.scrollTop = anchoredScrollTop(scroll.scrollTop, beforeTop, afterTop, scroll.scrollHeight - scroll.clientHeight);
    }
  }



  /* IWB_ARRANGE_PANEL_DRAFT_BEGIN */
  function arrangeDraftChanged(view) {
    return jsonText(view.arrangeDraft || []) !== jsonText(view.arrangeInitialDraft || []);
  }

  function moveArrangeDraft(view, fromIndex, toIndex) {
    const from = Number(fromIndex);
    const to = Number(toIndex);
    const draft = view.arrangeDraft;
    if (!Array.isArray(draft) || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= draft.length || to < 0 || to >= draft.length || from === to) return false;
    const [track] = draft.splice(from, 1);
    draft.splice(to, 0, track);
    return true;
  }

  function resetArrangeDraft(view) {
    if (!arrangeDraftChanged(view)) return false;
    view.arrangeDraft = cloneJson(view.arrangeInitialDraft || []);
    return true;
  }

  function syncArrangeResetButton(view) {
    const button = view.root?.querySelector?.('[data-action="reset-arrange-settings"]');
    if (!button) return;
    button.disabled = !arrangeDraftChanged(view);
    button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
  }

  function renderArrangeDraft(view, scrollTop = null) {
    const previous = scrollTop ?? Number(view.root?.querySelector?.('.qa-arrange-list')?.scrollTop || 0);
    renderDynamic(view, { list: true });
    const list = view.root?.querySelector?.('.qa-arrange-list');
    if (list) list.scrollTop = Math.min(previous, Math.max(0, list.scrollHeight - list.clientHeight));
  }

  function clearArrangeDragFeedback(view) {
    view.root?.querySelectorAll?.('.qa-arrange-row.is-dragging,.qa-arrange-row.is-drop-before,.qa-arrange-row.is-drop-after').forEach(row => row.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after'));
  }

  function flashArrangeTrack(view, index, duration = 720) {
    clearTimeout(view.arrangeFlashTimer);
    view.arrangeFlashIndex = Number(index);
    view.arrangeFlashTimer = setTimeout(() => {
      view.arrangeFlashIndex = null;
      view.arrangeFlashTimer = null;
      view.root?.querySelector?.('.qa-arrange-row.is-flash-moved')?.classList.remove('is-flash-moved');
    }, duration);
  }
  /* IWB_ARRANGE_PANEL_DRAFT_END */

  function renderPanel(view) {
    /* IWB_BATCH_DELETE_PANEL_BEGIN */
    if (view.panel === 'batch') return `<section class="qa-panel qa-batch-panel"><h3 class="qa-batch-title">批量操作 · 已选 ${view.selected.size} 条</h3><div class="qa-batch-groups"><section class="qa-batch-group"><div class="qa-batch-group-label"><strong>状态与字段</strong><small>批量启停或修改原生字段</small></div><div class="qa-batch-status"><button class="qa-btn" data-action="batch-enabled" data-enabled="true">批量启用</button><button class="qa-btn" data-action="batch-enabled" data-enabled="false">批量停用</button></div><div class="qa-batch-primary"><button class="qa-btn" data-action="panel-position">改位置</button><button class="qa-btn" data-action="panel-order">改顺序</button></div></section><section class="qa-batch-group"><div class="qa-batch-group-label"><strong>移动操作</strong><small>调整当前列表排列</small></div><div class="qa-batch-moves"><button class="qa-btn" data-action="batch-move" data-direction="up">上移</button><button class="qa-btn" data-action="batch-move" data-direction="down">下移</button><button class="qa-btn" data-action="batch-move" data-direction="top">置顶</button><button class="qa-btn" data-action="batch-move" data-direction="bottom">置底</button></div></section><section class="qa-batch-group qa-batch-danger-group"><div class="qa-batch-group-label"><strong>危险操作</strong><small>只修改工作副本，可撤销</small></div><button class="qa-btn danger qa-batch-delete-wide" data-action="batch-delete">批量删除</button></section></div></section>`;
    /* IWB_BATCH_DELETE_PANEL_END */
    if (view.panel === 'import') return '';
    if (view.panel === 'arrange-settings') {
      const rows = view.arrangeDraft.map((track, index) => `<div class="qa-arrange-row${view.arrangeFlashIndex === index ? ' is-flash-moved' : ''}" data-arrange-index="${index}"><button type="button" class="qa-arrange-drag-handle" draggable="true" data-action="arrange-drag" data-index="${index}" aria-label="拖动轨道：${escapeHtml(track.label)}" title="拖动重排轨道">☰</button><div class="qa-arrange-label"><span>${escapeHtml(track.label)} · ${track.count} 条${track.isNew ? ' · 新增' : ''}</span></div><select class="qa-select" data-control="arrange-direction" data-index="${index}"><option value="asc"${track.direction === 'asc' ? ' selected' : ''}>从小到大</option><option value="desc"${track.direction === 'desc' ? ' selected' : ''}>从大到小</option></select><div class="qa-arrange-arrows"><button class="qa-btn" data-action="arrange-group-up" data-index="${index}" ${index === 0 ? 'disabled' : ''}>↑</button><button class="qa-btn" data-action="arrange-group-down" data-index="${index}" ${index === view.arrangeDraft.length - 1 ? 'disabled' : ''}>↓</button></div></div>`).join('');
      const scope = view.mixedMode ? '总览' : '本书';
      const note = `每个普通位置及实际“角色＋深度”都是独立轨道；这里只保存${scope}规则，不限制深度输入。`;
      return `<section class="qa-panel"><div class="qa-panel-note qa-arrange-note">${note}</div><div class="qa-arrange-list">${rows || `<div class="qa-panel-note">${scope}没有可整理条目。</div>`}</div><div class="qa-footer-row"><button class="qa-btn qa-arrange-reset" data-action="reset-arrange-settings" ${arrangeDraftChanged(view) ? '' : 'disabled aria-disabled="true"'}>还原本次设置</button><button class="qa-btn" data-action="save-arrange-settings">仅保存设置</button><button class="qa-btn primary" data-action="save-and-arrange">保存并整理</button><button class="qa-btn qa-arrange-return" data-action="panel-close">返回列表</button></div></section>`;
    }
    if (view.panel === 'position') {
      const editingDepth = view.positionDraft.type === 'at_depth';
      const depthFields = editingDepth ? `<label class="qa-field"><span>深度</span><input class="qa-input" data-control="batch-depth" type="number" min="0" step="1" value="${escapeHtml(view.positionDraft.depth)}"></label><label class="qa-field"><span>角色</span><select class="qa-select" data-control="batch-role">${Object.entries(ROLE_LABELS).map(([role, label]) => optionHtml(role, label, view.positionDraft.role)).join('')}</select></label>` : '';
      return `<section class="qa-panel qa-batch-subpanel"><h3>批量改位置</h3><div class="qa-fields"><label class="qa-field qa-wide"><span>原生位置</span><select class="qa-select" data-control="batch-position">${POSITION_TYPES.map(type => optionHtml(type, POSITION_LABELS[type], view.positionDraft.type)).join('')}</select></label>${depthFields}</div><div class="qa-footer-row"><button class="qa-btn" data-action="batch-back">返回批量操作</button><button class="qa-btn primary" data-action="apply-position">应用到已选 ${view.selected.size} 条</button></div></section>`;
    }
    if (view.panel === 'order') {
      const preview = orderPreview(view);
      const sequencing = view.orderDraft.mode === 'sequence';
      const fields = sequencing ? `<label class="qa-field"><span>起始顺序</span><input class="qa-input" data-control="order-start" type="number" step="any" value="${escapeHtml(view.orderDraft.start)}"></label><label class="qa-field"><span>间隔</span><input class="qa-input" data-control="order-gap" type="number" step="any" value="${escapeHtml(view.orderDraft.gap)}"></label>` : `<label class="qa-field qa-wide"><span>目标顺序</span><input class="qa-input" data-control="order-start" type="number" step="any" value="${escapeHtml(view.orderDraft.start)}"></label>`;
      return `<section class="qa-panel qa-batch-subpanel"><h3>批量改顺序</h3><div class="qa-fields"><label class="qa-field qa-wide"><span>修改方式</span><select class="qa-select" data-control="order-mode"><option value="same"${view.orderDraft.mode === 'same' ? ' selected' : ''}>设置相同顺序</option><option value="sequence"${view.orderDraft.mode === 'sequence' ? ' selected' : ''}>按当前列表排列连续生成</option></select></label>${fields}</div><div class="qa-panel-note">预览：<span data-slot="order-preview">${escapeHtml(preview)}</span></div><div class="qa-footer-row"><button class="qa-btn" data-action="batch-back">返回批量操作</button><button class="qa-btn primary" data-action="apply-order">应用到已选 ${view.selected.size} 条</button></div></section>`;
    }
    return '';
  }

  function orderPreview(view) {
    const count = view.selected.size;
    const start = Number(view.orderDraft.start);
    const gap = view.orderDraft.mode === 'same' ? 0 : Number(view.orderDraft.gap);
    if (!Number.isFinite(start) || !Number.isFinite(gap) || !count) return '请填写有效数字并选择条目';
    if (view.orderDraft.mode === 'same') return `${count} 条都设为 ${start}`;
    return `${start} → ${start + gap * Math.max(0, count - 1)}（${count} 条，间隔 ${gap}）`;
  }


  function leaveModalHtml(view) {
    const disabled = view.busy ? ' disabled' : '';
    const error = view.leaveError ? `<div class="qa-leave-error" role="alert">${escapeHtml(view.leaveError)}</div>` : '';
    return `<div class="qa-leave-backdrop" aria-hidden="true"></div><section class="qa-leave-dialog" role="dialog" aria-modal="true" aria-labelledby="iwb-qa-leave-title" aria-describedby="iwb-qa-leave-description"><h3 id="iwb-qa-leave-title">有未保存的修改</h3><p id="iwb-qa-leave-description">${view.mixedMode ? '当前多书工作台或混排槽位' : view.transferStates?.size ? '跨书工作副本' : '当前世界书'}还有未保存的修改，请选择如何处理。</p>${error}<div class="qa-leave-actions"><button class="qa-btn primary" data-action="leave-save"${disabled}>${view.busy === 'save' ? '保存中…' : '保存修改'}</button><button class="qa-btn danger" data-action="leave-discard"${disabled}>放弃修改</button><button class="qa-btn" data-action="leave-cancel"${disabled}>继续编辑</button></div></section>`;
  }

  function discardConfirmHtml() {
    return `<div class="qa-leave-backdrop" aria-hidden="true"></div><section class="qa-leave-dialog qa-discard-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="iwb-qa-discard-title" aria-describedby="iwb-qa-discard-description"><h3 id="iwb-qa-discard-title">确认放弃当前所有未保存的修改吗？</h3><p id="iwb-qa-discard-description">放弃后，本次未保存的修改将全部丢失。</p><div class="qa-leave-actions qa-discard-confirm-actions"><button class="qa-btn" data-action="discard-confirm-cancel">取消</button><button class="qa-btn danger" data-action="discard-confirm-accept">确认放弃</button></div></section>`;
  }

  function contentDiscardConfirmHtml() {
    return `<div class="qa-leave-backdrop" aria-hidden="true"></div><section class="qa-leave-dialog qa-discard-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="iwb-qa-content-discard-title" aria-describedby="iwb-qa-content-discard-description"><h3 id="iwb-qa-content-discard-title">正文尚未完成</h3><p id="iwb-qa-content-discard-description">标题、主关键词或正文还有未提交到工作副本的修改。</p><div class="qa-leave-actions qa-discard-confirm-actions"><button class="qa-btn" data-action="content-discard-cancel">继续编辑</button><button class="qa-btn danger" data-action="content-discard-accept">放弃修改</button></div></section>`;
  }

  function renderLeaveModal(view) {
    const modal = view.root.querySelector('[data-slot="leave-modal"]');
    if (!modal) return;
    const active = Boolean(view.leaveIntent || view.discardConfirmOpen || view.contentDiscardIntent);
    const opening = active && modal.hidden;
    modal.hidden = !active;
    modal.innerHTML = active ? (view.contentDiscardIntent ? contentDiscardConfirmHtml() : view.discardConfirmOpen ? discardConfirmHtml() : leaveModalHtml(view)) : '';
    view.root.classList.toggle('qa-leave-open', active);
    const shell = view.root.querySelector('.qa-shell');
    if (shell) shell.inert = active;
    const contentLayer = view.root.querySelector('[data-slot="content-editor"]');
    if (contentLayer) contentLayer.inert = active;
    const guideLayer = view.root.querySelector('[data-slot="guide"]');
    if (guideLayer) guideLayer.inert = active;
    if (opening) modal.querySelector(view.contentDiscardIntent ? '[data-action="content-discard-cancel"]' : view.discardConfirmOpen ? '[data-action="discard-confirm-cancel"]' : '[data-action="leave-save"]')?.focus?.();
  }

  function renderWorkspacePanel(view) {
    const panel = view.root.querySelector('[data-slot="workspace-panel"]');
    if (!panel) return;
    if (view.panel === 'import' || view.panel === 'transfer' || view.panel === 'arrange-settings') { panel.innerHTML = ''; panel.hidden = true; return; }
    const html = renderPanel(view);
    panel.classList.toggle('qa-batch-workspace', view.panel === 'batch' || view.panel === 'position' || view.panel === 'order');
    panel.innerHTML = html;
    panel.hidden = !html;
  }

  function renderFooter(view) {
    const footer = view.root.querySelector('[data-slot="footer"]');
    footer.innerHTML = footerHtml(view);
    const taskFooter = view.panel === 'import' || view.panel === 'transfer' || view.panel === 'arrange-settings';
    footer.classList.toggle('qa-footer-has-selection', view.selected.size > 0 && !taskFooter);
    footer.classList.toggle('qa-footer-task-active', taskFooter);
    view.root.classList.toggle('qa-loading', Boolean(view.busy));
    renderWorkspacePanel(view);
    renderLeaveModal(view);
  }

  function footerHtml(view) {
    const summary = pendingSummary(view);
    const selected = view.selected.size;
    const taskPanel = view.panel === 'import' || view.panel === 'transfer' || view.panel === 'arrange-settings';
    const batchActive = view.panel === 'batch' || view.panel === 'position' || view.panel === 'order';
    const desktop = isDesktopLayout(view);
    const batchLabel = batchActive ? (desktop ? '收起面板' : '收起') : (desktop ? '批量操作' : '展开');
    const clearLabel = desktop ? '清空已选' : '清空';
    const clearState = desktop && batchActive ? 'disabled aria-disabled="true" title="请先收起批量面板"' : 'aria-disabled="false"';
    const selectionContext = (selected || batchActive) && !taskPanel ? `<div class="qa-selection-context"><strong>已选 ${selected} 条</strong><button class="qa-btn" data-action="batch-panel">${batchLabel}</button><button class="qa-btn" data-action="clear-selection" ${clearState}>${clearLabel}</button></div>` : '';
    const mobileSummary = selectionContext ? `<div class="qa-mobile-footer-summary"><span>已选 ${selected} 条</span><span data-slot="mobile-change-summary">${escapeHtml(mobilePendingSummary(view, summary))}</span></div>` : '';
    const taskDisabled = taskPanel || view.busy;
    return `${selectionContext}${mobileSummary}<div class="qa-save-bar"><div class="qa-count">${escapeHtml(summary.text)}</div><button class="qa-btn" data-action="undo" ${!view.undo.length || taskDisabled ? 'disabled' : ''}>撤销</button><button class="qa-btn danger" data-action="discard" ${!isDirty(view) || taskDisabled ? 'disabled' : ''}>放弃</button><button class="qa-btn primary" data-action="save" ${!isDirty(view) || taskDisabled ? 'disabled' : ''}>${view.busy === 'save' ? '保存中…' : '保存全部'}</button></div>`;
  }

  function openGuide(view) {
    const scroll = view.root.querySelector('[data-slot="scroll"]');
    const layer = view.root.querySelector('[data-slot="guide"]');
    if (!layer) return;
    view.guideScrollTop = scroll?.scrollTop || 0;
    view.guideReturnFocus = hostDocument().activeElement;
    view.guideOpen = true;
    layer.hidden = false;
    layer.querySelector('[data-action="guide-close"]')?.focus();
  }

  function closeGuide(view) {
    if (!view.guideOpen) return;
    const scrollTop = view.guideScrollTop;
    const layer = view.root.querySelector('[data-slot="guide"]');
    if (layer) layer.hidden = true;
    view.guideOpen = false;
    const scroll = view.root.querySelector('[data-slot="scroll"]');
    if (scroll) scroll.scrollTop = Math.min(scrollTop, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
    view.guideReturnFocus?.focus?.();
    view.guideReturnFocus = null;
  }

  async function updateContentEditorToken(view) {
    const editor = view.contentEditor;
    if (!editor) return;
    const node = view.root.querySelector('[data-slot="content-token"]');
    const counter = getTokenCounter();
    if (!counter) { if (node) node.textContent = '未计算'; return; }
    const generation = ++editor.tokenGeneration;
    if (node) node.textContent = '计算中…';
    try {
      const value = await counter(editor.draft);
      if (view.contentEditor !== editor || editor.tokenGeneration !== generation) return;
      if (node) node.textContent = Number.isFinite(Number(value)) ? String(Number(value)) : '未计算';
    } catch (_error) {
      if (view.contentEditor === editor && editor.tokenGeneration === generation && node) node.textContent = '未计算';
    }
  }

  function scheduleContentEditorToken(view) {
    clearTimeout(view.contentTokenTimer);
    view.contentTokenTimer = setTimeout(() => { void updateContentEditorToken(view); }, 180);
  }

  function contentEditorTitleHtml(editor) {
    if (editor.titleEditing && editor.allowNameEdit) return `<input class="qa-input qa-content-name-input" data-control="content-name-full" value="${escapeHtml(editor.nameDraft)}" aria-label="条目标题">`;
    return `<button type="button" class="qa-content-title-display" data-action="content-title-edit" ${editor.allowNameEdit ? '' : 'disabled aria-disabled="true"'}>${escapeHtml(editor.nameDraft || '未命名条目')}</button>`;
  }

  function contentEditorKeysHtml(editor) {
    const chips = editor.keysDraft.map((key, index) => `<span class="qa-keyword-chip"><span>${escapeHtml(key)}</span>${editor.keywordEditing ? `<button type="button" class="qa-keyword-remove" data-action="content-key-remove" data-key-index="${index}" aria-label="删除主关键词 ${escapeHtml(key)}">×</button>` : ''}</span>`).join('');
    const input = editor.keywordEditing ? `<div class="qa-content-key-input-row"><textarea class="qa-keyword-input" data-control="content-key-input" rows="1" placeholder="连续输入关键词" inputmode="text">${escapeHtml(editor.keyInputDraft || '')}</textarea><button type="button" class="qa-btn" data-action="content-key-add">添加</button></div>` : '';
    return `<div class="qa-content-keys-display" role="button" tabindex="${editor.allowKeyEdit ? '0' : '-1'}" data-action="content-key-edit" aria-label="编辑主关键词" aria-disabled="${editor.allowKeyEdit ? 'false' : 'true'}">${chips || '<span class="qa-content-key-placeholder">点击添加主关键词</span>'}</div>${input}`;
  }

  function renderContentEditorDraft(view, focusControl = '') {
    const editor = view.contentEditor;
    if (!editor) return;
    const layer = view.root.querySelector('[data-slot="content-editor"]');
    const title = layer?.querySelector('[data-slot="content-title-draft"]');
    const keys = layer?.querySelector('[data-slot="content-keys-draft"]');
    if (title) title.innerHTML = contentEditorTitleHtml(editor);
    if (keys) keys.innerHTML = contentEditorKeysHtml(editor);
    if (focusControl) layer?.querySelector(`[data-control="${focusControl}"]`)?.focus({ preventScroll: true });
  }

  function contentEditorChanged(editor) {
    if (!editor) return false;
    return String(editor.nameDraft ?? '') !== String(editor.originalName ?? '')
      || jsonText(editor.keysDraft) !== jsonText(editor.originalKeys)
      || String(editor.keyInputDraft ?? '').trim() !== ''
      || String(editor.draft ?? '') !== String(editor.originalContent ?? '');
  }

  function openContentEditor(view, id) {
    const entry = view.working.find(candidate => entryId(candidate) === id);
    if (!entry) throw new Error('没有找到要编辑正文的条目。');
    const scroll = view.root.querySelector('[data-slot="scroll"]');
    view.contentEditor = createContentEditorState(entry, scroll?.scrollTop || 0);
    view.contentEditor.allowNameEdit = canEditTitle(view);
    view.contentEditor.allowKeyEdit = isDesktopLayout(view) && !view.moveMode;
    const layer = view.root.querySelector('[data-slot="content-editor"]');
    const textarea = layer.querySelector('[data-control="content-full"]');
    layer.querySelector('[data-slot="content-context"]').textContent = `《${view.book}》 · UID ${String(entry.uid)}`;
    textarea.value = view.contentEditor.draft;
    renderContentEditorDraft(view);
    layer.hidden = false;
    view.root.classList.add('qa-content-editing');
    syncMobileViewport(view);
    void updateContentEditorToken(view);
  }

  function closeContentEditor(view, commit) {
    const editor = view.contentEditor;
    if (!editor) return;
    const scrollTop = editor.scrollTop;
    const id = editor.id;
    clearTimeout(view.contentTokenTimer);
    if (commit) {
      applyWorkingQuiet(view, '编辑标题、主关键词与正文', () => applyContentDraft(view.working, editor), id);
      view.tokenCounts.delete(id);
    }
    view.contentEditor = null;
    const layer = view.root.querySelector('[data-slot="content-editor"]');
    layer.hidden = true;
    view.root.classList.remove('qa-content-editing');
    syncMobileViewport(view);
    renderDynamic(view, { list: true });
    const scroll = view.root.querySelector('[data-slot="scroll"]');
    scroll.scrollTop = Math.min(scrollTop, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
    if (commit) {
      const entry = view.working.find(candidate => entryId(candidate) === id);
      if (entry) scheduleTokenCounts(view, [entry]);
    }
  }


  function requestContentEditorClose(view, intent = 'back') {
    if (!view.contentEditor) return false;
    if (contentEditorChanged(view.contentEditor)) {
      view.contentDiscardIntent = { kind: intent };
      renderLeaveModal(view);
      return true;
    }
    closeContentEditor(view, false);
    return false;
  }

  async function confirmContentEditorDiscard(view) {
    const intent = view.contentDiscardIntent;
    if (!intent || !view.contentEditor) return false;
    view.contentDiscardIntent = null;
    closeContentEditor(view, false);
    if (intent.kind !== 'close') return true;
    if (view.busy) return false;
    if (isDirty(view)) {
      showLeavePrompt(view, { kind: 'close' });
      return true;
    }
    view.forceClose = true;
    await view.popup.completeCancelled();
    return true;
  }

  function renderDynamic(view, { list = false, resetScroll = false } = {}) {
    renderBookOptions(view);
    const topAction = view.root.querySelector('[data-action="new-entry"],[data-action="toggle-source"]');
    if (topAction) { topAction.dataset.action = view.mixedMode ? 'toggle-source' : 'new-entry'; topAction.textContent = view.mixedMode ? (view.sourceVisible ? '显示来源' : '隐藏来源') : '新建条目'; topAction.classList.toggle('primary', view.mixedMode && view.sourceVisible); }
    const importButton = view.root.querySelector('[data-action="panel-import"]'); if (importButton) importButton.hidden = view.mixedMode;
    const transferButton = view.root.querySelector('[data-action="panel-transfer"]'); if (transferButton) transferButton.hidden = view.mixedMode;
    const arrangeSettingsButton = view.root.querySelector('[data-action="arrange-settings"]'); if (arrangeSettingsButton) { arrangeSettingsButton.hidden = false; arrangeSettingsButton.textContent = view.mixedMode ? '总览整理设置' : '本书整理设置'; }
    renderStatus(view);
    const importActive = view.panel === 'import';
    const transferActive = view.panel === 'transfer';
    const arrangeActive = view.panel === 'arrange-settings';
    view.root.classList.toggle('qa-import-active', importActive || transferActive);
    view.root.classList.toggle('qa-transfer-active', transferActive);
    view.root.classList.toggle('qa-arrange-active', arrangeActive);
    const desktopTaskActive = importActive || transferActive || arrangeActive;
    view.root.classList.toggle('qa-desktop-task-active', desktopTaskActive);
    view.root.classList.toggle('qa-move-mode', view.moveMode);
    const desktopTaskHead = view.root.querySelector('[data-slot="desktop-task-head"]');
    if (desktopTaskHead) {
      desktopTaskHead.hidden = !desktopTaskActive;
      if (desktopTaskActive) {
        const title = desktopTaskHead.querySelector('[data-slot="desktop-task-title"]');
        const direction = desktopTaskHead.querySelector('[data-slot="desktop-task-direction"]');
        if (importActive) {
          if (title) title.textContent = '导入';
          const sourceNames = view.names.filter(name => name !== view.book);
          if (direction) direction.innerHTML = `<div class="qa-desktop-task-side qa-desktop-task-select"><select class="qa-select" data-control="import-source" aria-label="来源世界书"><option value="">选择来源世界书</option>${sourceNames.map(name => optionHtml(name, name, view.importDraft?.source || '')).join('')}</select></div><span class="qa-desktop-task-arrow" aria-hidden="true">→</span><strong class="qa-desktop-task-side qa-desktop-task-book" title="当前世界书：《${escapeHtml(view.book)}》" aria-label="当前世界书：《${escapeHtml(view.book)}》">当前世界书：《${escapeHtml(view.book)}》</strong>`;
        } else if (transferActive) {
          if (title) title.textContent = '转移';
          const targets = view.names.filter(name => name !== view.book);
          if (direction) direction.innerHTML = `<strong class="qa-desktop-task-side qa-desktop-task-book" title="当前世界书：《${escapeHtml(view.book)}》" aria-label="当前世界书：《${escapeHtml(view.book)}》">当前世界书：《${escapeHtml(view.book)}》</strong><span class="qa-desktop-task-arrow" aria-hidden="true">→</span><div class="qa-desktop-task-side qa-desktop-task-select"><select class="qa-select" data-control="transfer-target-select" aria-label="目标世界书"><option value="">选择目标世界书</option>${targets.map(name => optionHtml(name, name, view.transferDraft?.target || '')).join('')}</select></div>`;
        } else {
          if (title) title.textContent = view.mixedMode ? '总览整理设置' : '本书整理设置';
          if (direction) direction.textContent = view.mixedMode ? '当前生效世界书总览' : `《${view.book}》`;
        }
      }
    }
    view.root.querySelectorAll('[data-action="mode"]').forEach(button => button.classList.toggle('is-active', button.dataset.mode === (view.moveMode ? 'move' : 'edit')));
    const tools = view.root.querySelector('[data-slot="other-tools"]');
    if (tools) tools.hidden = importActive || transferActive || arrangeActive || !view.toolsOpen;
    const toolsButton = view.root.querySelector('[data-action="other-tools"]');
    if (toolsButton) toolsButton.setAttribute('aria-expanded', String(view.toolsOpen));
    const stateSelect = view.root.querySelector('[data-control="state-filter-select"]');
    if (stateSelect) stateSelect.value = view.stateFilter;
    const titleLock = view.root.querySelector('[data-action="title-lock"]');
    if (titleLock) {
      titleLock.textContent = view.titleLocked ? '🔒标题' : '🔓标题';
      titleLock.setAttribute('aria-pressed', String(view.titleLocked));
      titleLock.classList.toggle('is-active', view.titleLocked);
    }
    if (list) renderList(view, !resetScroll);
    renderFooter(view);
  }

  async function readNames(view) {
    const getNames = requirePublicFunction('getWorldbookNames');
    const names = await getNames();
    view.names = [...new Set((Array.isArray(names) ? names : []).map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    renderDynamic(view);
  }

  function syncTopControls(view) {
    const search = view.root.querySelector('[data-control="search"]');
    if (search) search.value = view.query || '';
    const state = view.root.querySelector('[data-control="state-filter-select"]');
    if (state) state.value = view.stateFilter || 'all';
  }

  async function loadBook(view, name) {
    if (!name) return;
    if (name === MIXED_BOOK_VALUE) return loadMixedBooks(view);
    view.mixedMode = false; view.activeBooks = []; view.bookStates = new Map(); view.slotBaseline = []; view.transferStates = new Map(); view.transferMoveTargets = new Set(); view.transferDraft = createTransferDraft();
    view.loading = true;
    view.error = '';
    renderDynamic(view, { list: true });
    try {
      const getWorldbook = requirePublicFunction('getWorldbook');
      const entries = await getWorldbook(name);
      assertUniqueEntries(entries);
      view.book = name;
      view.baseline = cloneJson(entries);
      view.working = cloneJson(entries);
      view.selected.clear();
      view.expanded.clear();
      view.tokenCounts.clear();
      view.moveMode = false;
      view.contentEditor = null;
      view.undo = [];
      view.query = '';
      view.searchOpen = false;
      view.positionFilter = 'all';
      view.stateFilter = 'all';
      view.renderLimit = APP.chunkSize;
      syncTopControls(view);
    } catch (error) {
      view.error = error instanceof Error ? error.message : String(error);
      toast('error', view.error, '世界书读取失败');
    } finally {
      view.loading = false;
      renderDynamic(view, { list: true, resetScroll: true });
    }
  }

  async function persistWorkingCopy(book, baseline, working, getWorldbook, updateWorldbookWith) {
    const expectedBefore = cloneJson(baseline);
    const expectedAfter = cloneJson(working);
    let writeStarted = false;
    try {
      const latest = await getWorldbook(book);
      assertUniqueEntries(latest);
      if (jsonText(latest) !== jsonText(expectedBefore)) throw new Error('保存前发现世界书已被其他页面修改。工作副本已保留，请重新读取后再处理。');
      writeStarted = true;
      await updateWorldbookWith(book, current => {
        assertUniqueEntries(current);
        if (jsonText(current) !== jsonText(expectedBefore)) throw new Error('保存回调取得的世界书与读取基线不一致，已停止写入。');
        return cloneJson(expectedAfter);
      }, { render: 'immediate' });
      const verified = await getWorldbook(book);
      assertUniqueEntries(verified);
      if (jsonText(verified) !== jsonText(expectedAfter)) throw new Error('保存后整本回读与工作副本不一致。');
      return cloneJson(verified);
    } catch (error) {
      let recovery = '';
      if (writeStarted) {
        try {
          const actual = await getWorldbook(book);
          if (jsonText(actual) === jsonText(expectedAfter)) {
            await updateWorldbookWith(book, current => {
              if (jsonText(current) !== jsonText(expectedAfter)) throw new Error('自动恢复前世界书又发生变化。');
              return cloneJson(expectedBefore);
            }, { render: 'immediate' });
            const restored = await getWorldbook(book);
            recovery = jsonText(restored) === jsonText(expectedBefore) ? ' 已自动恢复到保存前基线。' : ' 自动恢复后的回读仍不一致。';
          } else if (jsonText(actual) === jsonText(expectedBefore)) recovery = ' 世界书仍保持保存前基线。';
          else recovery = ' 检测到非预期状态，为避免覆盖外部变化未自动恢复。';
        } catch (_recoveryError) {
          recovery = ' 自动恢复未能完成。';
        }
      }
      const wrapped = new Error(`${error instanceof Error ? error.message : String(error)}${recovery}`);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async function saveAll(view) {
    if (!view.book || !isDirty(view) || view.busy) return true;
    if (view.mixedMode) return saveMixed(view);
    if (view.transferStates?.size) return saveTransfer(view);
    const scroll = view.root.querySelector('[data-slot="scroll"]');
    const scrollTop = scroll.scrollTop;
    const selection = new Set(view.selected);
    const getWorldbook = requirePublicFunction('getWorldbook');
    const updateWorldbookWith = requirePublicFunction('updateWorldbookWith');
    view.busy = 'save';
    renderDynamic(view);
    try {
      const verified = await persistWorkingCopy(view.book, view.baseline, view.working, getWorldbook, updateWorldbookWith);
      view.baseline = cloneJson(verified);
      view.working = cloneJson(verified);
      view.undo = [];
      toast('success', `《${view.book}》已保存并建立新基线。`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast('error', `${message} 工作副本、选择和滚动位置均已保留。`, '保存失败');
      return false;
    } finally {
      view.busy = null;
      view.selected = selection;
      renderDynamic(view, { list: true });
      scroll.scrollTop = scrollTop;
    }
  }

  function showLeavePrompt(view, intent, render = renderLeaveModal) {
    if (!isDirty(view)) return false;
    view.discardConfirmOpen = false;
    view.leaveIntent = intent;
    view.leaveError = '';
    view.panel = null;
    render(view);
    return true;
  }

  function cancelLeavePrompt(view, render = renderLeaveModal) {
    if (!view.leaveIntent || view.busy) return false;
    view.leaveIntent = null;
    view.leaveError = '';
    render(view);
    return true;
  }

  async function completeLeave(view, save, dependencies = {}) {
    const intent = view.leaveIntent;
    if (!intent || view.busy) return false;
    const saveWorking = dependencies.saveAll || saveAll;
    const loadTarget = dependencies.loadBook || loadBook;
    const render = dependencies.renderLeaveModal || renderLeaveModal;
    if (save && !(await saveWorking(view))) {
      view.leaveError = '保存失败，工作副本和未保存修改已保留。请重试或继续编辑。';
      render(view);
      return false;
    }
    if (!save) {
      if (view.transferStates?.size) discardTransferChanges(view);
      else { view.working = cloneJson(view.baseline); view.undo = []; }
    }
    view.leaveIntent = null;
    view.leaveError = '';
    render(view);
    if (intent.kind === 'switch') await loadTarget(view, intent.book);
    else {
      view.forceClose = true;
      await view.popup.completeCancelled();
    }
    return true;
  }

  function scheduleSearch(view, value) {
    clearTimeout(view.searchTimer);
    view.searchTimer = setTimeout(() => {
      view.query = value;
      view.renderLimit = APP.chunkSize;
      renderDynamic(view, { list: true, resetScroll: true });
    }, 180);
  }

  function computeDragAutoScrollSpeed(rect, clientX, clientY, scrollTop, scrollHeight, clientHeight) {
    if (!rect || clientX < rect.left || clientX > rect.right || clientY < rect.top - 56 || clientY > rect.bottom + 96) return 0;
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    if (maxScroll <= 0) return 0;
    const edge = Math.min(72, Math.max(32, rect.height * 0.18), rect.height / 2);
    let direction = 0;
    let proximity = 0;
    if (clientY < rect.top + edge && scrollTop > 0) {
      direction = -1;
      proximity = (rect.top + edge - clientY) / edge;
    } else if (clientY > rect.bottom - edge && scrollTop < maxScroll) {
      direction = 1;
      proximity = (clientY - (rect.bottom - edge)) / edge;
    }
    if (!direction) return 0;
    const intensity = Math.max(0, Math.min(1, proximity));
    return direction * (90 + 510 * intensity * intensity);
  }

  function updateDragDropTarget(view, clientX, clientY) {
    if (!view.drag) return;
    const doc = view.root.ownerDocument;
    const card = doc.elementFromPoint(clientX, clientY)?.closest?.('.qa-card');
    view.root.querySelectorAll('.drop-before,.drop-after').forEach(node => node.classList.remove('drop-before', 'drop-after'));
    if (!card || view.drag.ids.includes(card.dataset.entryId)) return;
    const rect = card.getBoundingClientRect();
    view.drag.anchorId = card.dataset.entryId;
    view.drag.after = clientY >= rect.top + rect.height / 2;
    card.classList.add(view.drag.after ? 'drop-after' : 'drop-before');
  }

  function stopDragAutoScroll(view) {
    const drag = view?.drag;
    if (!drag) return;
    if (drag.autoScrollFrame != null) {
      if (drag.autoScrollFrameType === 'raf') drag.autoScrollFrameWindow?.cancelAnimationFrame?.(drag.autoScrollFrame);
      else clearTimeout(drag.autoScrollFrame);
    }
    drag.autoScrollFrame = null;
    drag.autoScrollFrameType = null;
    drag.autoScrollFrameWindow = null;
    drag.autoScrollSpeed = 0;
    drag.autoScrollLastTime = null;
  }

  function scheduleDragAutoScroll(view) {
    const drag = view.drag;
    if (!drag || drag.autoScrollFrame != null || !drag.autoScrollSpeed) return;
    const outer = hostWindow();
    if (typeof outer.requestAnimationFrame === 'function') {
      drag.autoScrollFrameType = 'raf';
      drag.autoScrollFrameWindow = outer;
      drag.autoScrollFrame = outer.requestAnimationFrame(timestamp => dragAutoScrollStep(view, timestamp));
    } else {
      drag.autoScrollFrameType = 'timer';
      drag.autoScrollFrameWindow = null;
      drag.autoScrollFrame = setTimeout(() => dragAutoScrollStep(view, Date.now()), 16);
    }
  }

  function dragAutoScrollStep(view, timestamp) {
    const drag = view.drag;
    if (!drag) return;
    drag.autoScrollFrame = null;
    drag.autoScrollFrameType = null;
    drag.autoScrollFrameWindow = null;
    const scroll = view.root.querySelector('[data-slot="scroll"]');
    if (!scroll || !drag.autoScrollSpeed) { stopDragAutoScroll(view); return; }
    const rect = scroll.getBoundingClientRect();
    drag.autoScrollSpeed = computeDragAutoScrollSpeed(
      rect, drag.clientX, drag.clientY, scroll.scrollTop, scroll.scrollHeight, scroll.clientHeight,
    );
    if (!drag.autoScrollSpeed) { stopDragAutoScroll(view); return; }
    const elapsed = drag.autoScrollLastTime == null ? 16 : Math.max(8, Math.min(32, timestamp - drag.autoScrollLastTime));
    drag.autoScrollLastTime = timestamp;
    const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const before = scroll.scrollTop;
    scroll.scrollTop = Math.max(0, Math.min(maxScroll, before + drag.autoScrollSpeed * elapsed / 1000));
    if (scroll.scrollTop === before) { stopDragAutoScroll(view); return; }
    updateDragDropTarget(view, drag.clientX, drag.clientY);
    scheduleDragAutoScroll(view);
  }

  function updateDragAutoScroll(view, clientX, clientY) {
    const drag = view.drag;
    if (!drag) return;
    const scroll = view.root.querySelector('[data-slot="scroll"]');
    if (!scroll) { stopDragAutoScroll(view); return; }
    drag.clientX = clientX;
    drag.clientY = clientY;
    drag.autoScrollSpeed = computeDragAutoScrollSpeed(
      scroll.getBoundingClientRect(), clientX, clientY, scroll.scrollTop, scroll.scrollHeight, scroll.clientHeight,
    );
    if (!drag.autoScrollSpeed) { stopDragAutoScroll(view); return; }
    scheduleDragAutoScroll(view);
  }

  /* IWB_ENTRY_FEEDBACK_LOGIC_BEGIN */
  function clearEntryDragFeedback(view) {
    view.root?.querySelectorAll?.('.qa-card.is-entry-dragging,.qa-card.drop-before,.qa-card.drop-after').forEach(card => card.classList.remove('is-entry-dragging', 'drop-before', 'drop-after'));
  }

  function markEntryDragSource(view, ids) {
    const selected = new Set((ids || []).map(String));
    view.root?.querySelectorAll?.('.qa-card').forEach(card => card.classList.toggle('is-entry-dragging', selected.has(String(card.dataset.entryId))));
  }

  function clearEntryMoveFeedback(view) {
    clearTimeout(view.entryMoveFeedbackTimer);
    view.entryMoveFeedbackTimer = null;
    view.root?.querySelectorAll?.('.qa-card.is-entry-move-feedback').forEach(card => card.classList.remove('is-entry-move-feedback'));
  }

  function flashMovedEntries(view, ids, duration = 720) {
    clearEntryMoveFeedback(view);
    const moved = new Set((ids || []).map(String));
    view.root?.querySelectorAll?.('.qa-card').forEach(card => card.classList.toggle('is-entry-move-feedback', moved.has(String(card.dataset.entryId))));
    view.entryMoveFeedbackTimer = setTimeout(() => clearEntryMoveFeedback(view), duration);
  }
  /* IWB_ENTRY_FEEDBACK_LOGIC_END */

  function startDrag(view, event, card) {
    if (view.busy || event.button > 0) return;
    const cardId = card.dataset.entryId;
    view.drag = {
      pointerId: event.pointerId, ids: selectedIdsForCard(view, cardId), anchorId: null, after: false,
      clientX: event.clientX, clientY: event.clientY, autoScrollSpeed: 0, autoScrollFrame: null,
      autoScrollFrameType: null, autoScrollFrameWindow: null, autoScrollLastTime: null,
    };
    markEntryDragSource(view, view.drag.ids);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function dragMove(view, event) {
    if (!view.drag || view.drag.pointerId !== event.pointerId) return;
    updateDragDropTarget(view, event.clientX, event.clientY);
    updateDragAutoScroll(view, event.clientX, event.clientY);
  }

  function endDrag(view, event, cancelled = false) {
    if (!view.drag || view.drag.pointerId !== event.pointerId) return;
    const drag = view.drag;
    stopDragAutoScroll(view);
    view.drag = null;
    clearEntryDragFeedback(view);
    if (!cancelled && drag.anchorId) {
      const changed = applyWorking(view, '拖动列表排列', () => { const next = dropEntries(view.working, drag.ids, drag.anchorId, drag.after); return view.mixedMode ? refreshMixedBookIndexes(next) : next; }, { noOpMessage: '拖动位置未改变。' });
      if (changed) {
        if (view.mixedMode) {
          const books = mixedDirtyBooks(view).length;
          toast('info', books ? '已调整总览排列；' + books + ' 本书有未保存的列表排列修改。' : '已调整总览排列；世界书内容未修改。');
        } else toast('info', '已调整本书列表排列。');
      }
    }
  }

  function cancelActivePanel(view, render = renderFooter) {
    view.panel = null;
    render(view);
    return true;
  }

  function clearImportSelection(view, render = renderDynamic) {
    view.importDraft.selected.clear();
    if (render === renderDynamic) renderImportSelection(view, true);
    else render(view, { list: true });
    return true;
  }

  function cancelImportWorkspace(view, render = renderDynamic) {
    view.panel = null;
    view.importDraft = { source: '', entries: null, selected: new Set(), previewed: new Set(), query: '', filter: 'all', loading: false, error: '' };
    render(view, { list: true });
    return true;
  }

  async function handleAction(view, action, target) {
    if (action === 'close') {
      if (!showLeavePrompt(view, { kind: 'close' })) { view.forceClose = true; await view.popup.completeCancelled(); }

    } else if (action === 'mode') {
      view.moveMode = target.dataset.mode === 'move';
      renderDynamic(view, { list: true });
    } else if (action === 'title-lock') {
      view.titleLocked = !view.titleLocked;
      renderDynamic(view, { list: true });
    } else if (action === 'other-tools') {
      view.toolsOpen = !view.toolsOpen;
      renderDynamic(view);
    } else if (action === 'guide-open') {
      openGuide(view);
    } else if (action === 'guide-close') {
      closeGuide(view);
    } else if (action === 'reload') {
      if (!view.book) await readNames(view);
      else if (!showLeavePrompt(view, { kind: 'switch', book: view.book })) await loadBook(view, view.book);
    } else if (action === 'more') {
    } else if (action === 'more') {
      view.renderLimit += APP.chunkSize; renderDynamic(view, { list: true });
    } else if (action === 'toggle') {
      const id = target.closest('.qa-card').dataset.entryId;
      target.checked ? view.selected.add(id) : view.selected.delete(id);
      renderDynamic(view, { list: true });
    } else if (action === 'select-visible' || action === 'select-list-scope') {
      selectListScope(view); renderDynamic(view, { list: true });
    } else if (action === 'clear-selection') {
      if ((view.panel === 'batch' || view.panel === 'position' || view.panel === 'order') && isDesktopLayout(view)) return;
      view.panel = null; view.selected.clear(); renderDynamic(view, { list: true });
    } else if (action === 'move') {
      const id = target.closest('.qa-card').dataset.entryId;
      const ids = selectedIdsForCard(view, id);
      const direction = target.dataset.direction;
      const label = ({ up: '上移', down: '下移', top: '置顶', bottom: '置底' })[direction] || '移动';
      const changed = applyWorking(view, `${label}列表排列`, () => moveEntries(view.working, ids, direction));
      if (changed && !isDesktopLayout(view) && (direction === 'up' || direction === 'down')) flashMovedEntries(view, ids);
    } else if (action === 'expand') {
      const id = target.closest('.qa-card').dataset.entryId;
      toggleExpandedAnchored(view, id);
    } else if (action === 'name-edit') {
      const id = target.closest('.qa-card').dataset.entryId;
      startNameEdit(view, id);
    } else if (action === 'name-done') {
      const input = target.closest('.qa-name-edit')?.querySelector('[data-control="entry-name-inline"]');
      if (input) finishNameEdit(view, input, true);
    } else if (action === 'enabled') {
      const id = target.closest('.qa-card').dataset.entryId;
      toggleEnabledInPlace(view, id, target);
    } else if (action === 'activation') {
      const id = target.closest('.qa-card').dataset.entryId;
      applyWorking(view, '切换蓝灯／绿灯', () => mutateEntry(view.working, id, entry => {
        const type = editableActivationType(entry);
        if (!type) throw new Error('当前激活类型不是蓝灯或绿灯，已保持只读。');
        entry.strategy.type = type === 'constant' ? 'selective' : 'constant';
      }));
    } else if (action === 'key-add') {
      const input = target.closest('.qa-keyword-editor')?.querySelector('[data-control="entry-key-input"]');
      if (input) commitKeywordInput(view, input, true);
    } else if (action === 'key-remove') {
      const cardId = target.closest('.qa-card').dataset.entryId;
      const index = Number(target.dataset.keyIndex);
      const draft = target.closest('.qa-keyword-editor')?.querySelector('[data-control="entry-key-input"]')?.value || '';
      if (applyWorkingQuiet(view, '删除主关键词', () => mutateEntry(view.working, cardId, entry => {
        if (!entry.strategy || typeof entry.strategy !== 'object' || Array.isArray(entry.strategy)) throw new Error('当前条目的激活策略无法无损编辑。');
        entry.strategy.keys = removePrimaryKey(entry.strategy.keys, index);
      }), cardId)) {
        updateKeywordEditor(view, cardId);
        const input = view.root.querySelector(`[data-entry-id="${cssEscape(cardId)}"] [data-control="entry-key-input"]`);
        if (input) input.value = draft;
      }
    } else if (action === 'content-open') {
      const id = target.closest('.qa-card').dataset.entryId;
      openContentEditor(view, id);
    } else if (action === 'content-back') {
      requestContentEditorClose(view, 'back');
    } else if (action === 'content-discard-cancel') {
      view.contentDiscardIntent = null;
      renderLeaveModal(view);
    } else if (action === 'content-discard-accept') {
      await confirmContentEditorDiscard(view);
    } else if (action === 'content-title-edit') {
      if (view.contentEditor?.allowNameEdit) { view.contentEditor.titleEditing = true; renderContentEditorDraft(view, 'content-name-full'); }
    } else if (action === 'content-key-edit') {
      if (view.contentEditor?.allowKeyEdit) { view.contentEditor.keywordEditing = true; renderContentEditorDraft(view, 'content-key-input'); }
    } else if (action === 'content-key-add') {
      const input = view.root.querySelector('[data-control="content-key-input"]');
      if (view.contentEditor && input?.value.trim()) { view.contentEditor.keysDraft = mergePrimaryKeys(view.contentEditor.keysDraft, input.value); view.contentEditor.keyInputDraft = ''; renderContentEditorDraft(view, 'content-key-input'); }
    } else if (action === 'content-key-remove') {
      if (view.contentEditor) { view.contentEditor.keysDraft = removePrimaryKey(view.contentEditor.keysDraft, Number(target.dataset.keyIndex)); renderContentEditorDraft(view); }
    } else if (action === 'content-done') {
      closeContentEditor(view, true);
    } else if (action === 'duplicate') {
      const id = target.closest('.qa-card').dataset.entryId;
      const result = view.mixedMode ? copyMixedEntry(view.working, id) : copyEntry(view.working, id);
      view.renderLimit = Math.max(view.renderLimit, result.entries.length);
      view.expanded.delete(result.id);
      applyWorking(view, '复制条目', () => result.entries);
      toast('success', '已在工作副本中生成副本，可撤销或统一保存。');
    } else if (action === 'delete') {
      const id = target.closest('.qa-card').dataset.entryId;
      applyWorking(view, '删除条目', () => view.working.filter(entry => entryId(entry) !== id).map(cloneJson), { removeId: id });
      toast('info', '已从工作副本移除条目，可撤销或放弃修改。');
    } else if (action === 'toggle-source') {
      view.sourceVisible = !view.sourceVisible; saveSourceVisible(view.sourceVisible); renderDynamic(view, { list: true });
    } else if (action === 'new-entry') {
      const entry = createMinimalEntry(view.working);
      const id = entryId(entry);
      view.query = '';
      view.stateFilter = 'all';
      view.positionFilter = 'all';
      syncTopControls(view);
      view.renderLimit = view.working.length + 1;
      applyWorking(view, '新建条目', () => [...cloneJson(view.working), entry], { expandId: id });
      view.root.querySelector(`[data-entry-id="${cssEscape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (action === 'undo') {
      const snapshot = view.undo.pop();
      if (snapshot) { if (snapshot.kind === 'transfer') restoreTransferSnapshot(view, snapshot); else view.working = snapshot.working; renderDynamic(view, { list: true }); toast('info', `已撤销：${snapshot.label}`); }
    } else if (action === 'discard') {
      if (!isDirty(view) || view.busy) return;
      view.discardConfirmOpen = true;
      renderLeaveModal(view);
    } else if (action === 'discard-confirm-cancel') {
      view.discardConfirmOpen = false;
      renderLeaveModal(view);
    } else if (action === 'discard-confirm-accept') {
      if (view.transferStates?.size) discardTransferChanges(view); else { view.working = cloneJson(view.baseline); view.undo = []; }
      view.discardConfirmOpen = false;
      renderDynamic(view, { list: true }); toast('info', '已放弃本轮全部未保存修改。');
    } else if (action === 'save') {
      await saveAll(view);


    } else if (action === 'desktop-task-back') {
      if (view.panel === 'import') cancelImportWorkspace(view);
      else if (view.panel === 'transfer') cancelTransferWorkspace(view);
      else if (view.panel === 'arrange-settings') { clearTimeout(view.arrangeFlashTimer); clearArrangeDragFeedback(view); view.arrangeInitialDraft = null; view.arrangeDrag = null; view.arrangeFlashIndex = null; view.arrangeFlashTimer = null; cancelActivePanel(view, current => renderDynamic(current, { list: true })); }
    } else if (action === 'batch-back') {
      view.panel = 'batch'; view.leaveIntent = null; renderFooter(view);
    } else if (action === 'batch-panel') {
      const batchActive = view.panel === 'batch' || view.panel === 'position' || view.panel === 'order';
      view.panel = batchActive ? null : 'batch'; view.leaveIntent = null; renderFooter(view);
    } else if (action === 'batch-enabled') {
      batchSetEnabledSelected(view, target.dataset.enabled === 'true');
    } else if (action === 'batch-delete') {
      batchDeleteSelected(view);
    } else if (action === 'batch-move') {
      applyWorking(view, '批量调整列表排列', () => moveEntries(view.working, [...view.selected], target.dataset.direction));
    } else if (action === 'panel-transfer') {
      const scroll = view.root.querySelector('[data-slot="scroll"]');
      view.transferReturnScroll = scroll?.scrollTop || 0;
      view.transferDraft = createTransferDraft();
      view.toolsOpen = false;
      view.panel = 'transfer'; view.leaveIntent = null; renderDynamic(view, { list: true, resetScroll: true });
    } else if (action === 'transfer-toggle') {
      const id = target.dataset.sourceId;
      target.checked ? view.transferDraft.selected.add(id) : view.transferDraft.selected.delete(id);
      renderTransferSelection(view, true);
    } else if (action === 'transfer-preview') {
      toggleSourcePreview(view, 'transfer', target.dataset.sourceId);
    } else if (action === 'transfer-select-visible') {
      visibleTransferEntries(view).forEach(entry => view.transferDraft.selected.add(entryId(entry))); renderTransferSelection(view, true);
    } else if (action === 'transfer-clear') {
      view.transferDraft.selected.clear(); renderTransferSelection(view, true);
    } else if (action === 'transfer-choose') {
      if (!view.transferDraft.selected.size) return;
      captureTransferListScroll(view);
      view.transferDraft.scrollTop = view.root.querySelector('[data-slot="scroll"]')?.scrollTop || 0;
      if (isDesktopLayout(view)) {
        if (!view.transferDraft.target || view.transferDraft.loading) return;
        const keepTop = view.transferDraft.scrollTop || 0;
        view.transferDraft.loading = true; renderDynamic(view, { list: true });
        try {
          const result = await applyTransfer(view, target.dataset.mode, view.transferDraft.target);
          renderDynamic(view, { list: true });
          const nextScroll = view.root.querySelector('[data-slot="scroll"]'); if (nextScroll) nextScroll.scrollTop = Math.min(keepTop, Math.max(0, nextScroll.scrollHeight - nextScroll.clientHeight));
          toast('success', `已${result.mode === 'move' ? '移动' : '复制'} ${result.count} 条到《${result.targetName}》`);
        } finally {
          view.transferDraft.loading = false;
          if (view.panel === 'transfer') renderDynamic(view, { list: true });
        }
      } else {
        view.transferDraft.mode = target.dataset.mode; view.transferDraft.phase = 'target'; renderDynamic(view, { list: true });
      }
    } else if (action === 'transfer-back') {
      view.transferDraft.phase = 'select'; view.transferDraft.mode = null; renderDynamic(view, { list: true });
    } else if (action === 'transfer-target') {
      if (view.transferDraft.loading) return;
      const keepTop = view.transferDraft.scrollTop || 0;
      view.transferDraft.loading = true; renderDynamic(view, { list: true });
      try {
        const result = await applyTransfer(view, view.transferDraft.mode, target.dataset.book);
        renderDynamic(view, { list: true });
        const nextScroll = view.root.querySelector('[data-slot="scroll"]'); if (nextScroll) nextScroll.scrollTop = Math.min(keepTop, Math.max(0, nextScroll.scrollHeight - nextScroll.clientHeight));
        toast('success', `已${result.mode === 'move' ? '移动' : '复制'} ${result.count} 条到《${result.targetName}》`);
      } finally {
        view.transferDraft.loading = false;
        if (view.panel === 'transfer' && view.transferDraft.phase === 'target') renderDynamic(view, { list: true });
      }
    } else if (action === 'transfer-cancel') {
      cancelTransferWorkspace(view);
    } else if (action === 'panel-import') {

      view.importDraft = { source: '', entries: null, selected: new Set(), previewed: new Set(), query: '', filter: 'all', loading: false, error: '' };
      view.toolsOpen = false;
      view.panel = 'import'; view.leaveIntent = null; renderDynamic(view, { list: true, resetScroll: true });
    } else if (action === 'import-toggle') {
      const id = target.dataset.sourceId;
      target.checked ? view.importDraft.selected.add(id) : view.importDraft.selected.delete(id);
      renderImportSelection(view, true);
    } else if (action === 'import-preview') {
      toggleSourcePreview(view, 'import', target.dataset.sourceId);
    } else if (action === 'import-select-visible') {
      visibleImportEntries(view).forEach(entry => view.importDraft.selected.add(entryId(entry)));
      renderImportSelection(view, true);
    } else if (action === 'import-clear') {
      clearImportSelection(view);
    } else if (action === 'import-cancel') {
      cancelImportWorkspace(view);
    } else if (action === 'apply-import') {
      const result = importEntriesAtTop(view.working, view.importDraft.entries || [], [...view.importDraft.selected]);
      const count = result.importedIds.length;
      view.panel = null;
      view.importDraft = { source: '', entries: null, selected: new Set(), previewed: new Set(), query: '', filter: 'all', loading: false, error: '' };
      if (applyWorking(view, '从其他书导入条目', () => result.entries)) toast('success', `已将 ${count} 条导入当前书工作副本顶部。`);
    } else if (action === 'panel-position') {

      view.panel = 'position'; view.leaveIntent = null; renderFooter(view);

    } else if (action === 'panel-order') {
      view.panel = 'order'; view.leaveIntent = null; renderFooter(view);

    } else if (action === 'auto-arrange') {
      const rules = view.mixedMode ? loadMixedArrangeRules() : loadArrangeRules(view.book);
      if (view.mixedMode) {
        const changed = applyWorking(view, '整理多书合并工作副本', () => arrangeMixedWorking(view.working, rules), { noOpMessage: '总览已经符合总览整理设置。' });
        if (changed) {
          const books = mixedDirtyBooks(view).length;
          toast('success', books ? '已整理总览；' + books + ' 本书产生未保存的列表排列修改。' : '已整理总览排列；世界书内容未修改。');
        }
      } else applyWorking(view, '一键整理列表排列', () => stableAutoArrange(view.working, rules), { noOpMessage: '本书列表已经符合整理设置。' });
    } else if (action === 'arrange-settings') {
      view.arrangeDraft = view.mixedMode ? effectiveMixedArrangeRules(view.working, loadMixedArrangeRules()) : effectiveArrangeRules(view.working, loadArrangeRules(view.book));
      view.arrangeInitialDraft = cloneJson(view.arrangeDraft);
      view.arrangeDrag = null;
      view.arrangeFlashIndex = null;
      clearTimeout(view.arrangeFlashTimer); view.arrangeFlashTimer = null;
      view.panel = 'arrange-settings'; view.leaveIntent = null; renderDynamic(view, { list: true, resetScroll: true });
    } else if (action === 'arrange-group-up' || action === 'arrange-group-down') {
      const index = Number(target.dataset.index);
      const next = index + (action.endsWith('up') ? -1 : 1);
      if (moveArrangeDraft(view, index, next)) { view.arrangeFlashIndex = next; renderArrangeDraft(view); flashArrangeTrack(view, next); }
    } else if (action === 'reset-arrange-settings') {
      if (resetArrangeDraft(view)) renderArrangeDraft(view);
    } else if (action === 'save-arrange-settings') {
      if (view.mixedMode) saveMixedArrangeRules(view.arrangeDraft); else saveArrangeRules(view.book, view.arrangeDraft);
      const scope = view.mixedMode ? '总览' : '本书';
      clearTimeout(view.arrangeFlashTimer); clearArrangeDragFeedback(view); view.arrangeInitialDraft = null; view.arrangeDrag = null; view.arrangeFlashIndex = null; view.arrangeFlashTimer = null;
      view.panel = null; renderDynamic(view, { list: true }); toast('success', '已保存' + scope + '整理设置，列表排列未改变。');
    } else if (action === 'save-and-arrange') {
      const rules = view.mixedMode ? saveMixedArrangeRules(view.arrangeDraft) : saveArrangeRules(view.book, view.arrangeDraft);
      const mixed = view.mixedMode;
      clearTimeout(view.arrangeFlashTimer); clearArrangeDragFeedback(view); view.arrangeInitialDraft = null; view.arrangeDrag = null; view.arrangeFlashIndex = null; view.arrangeFlashTimer = null;
      view.panel = null;
      const changed = applyWorking(view, mixed ? '按总览设置整理多书合并工作副本' : '按本书设置整理列表排列', () => mixed ? arrangeMixedWorking(view.working, rules) : stableAutoArrange(view.working, rules), { noOpMessage: mixed ? '总览已经符合总览整理设置。' : '本书列表已经符合整理设置。' });
      if (mixed && changed) { const books = mixedDirtyBooks(view).length; toast('success', books ? '已整理总览；' + books + ' 本书产生未保存的列表排列修改。' : '已整理总览排列；世界书内容未修改。'); }
      renderDynamic(view, { list: true });
    } else if (action === 'disable-recursion') {
      applyWorking(view, '禁止本书全部递归', () => disableAllRecursion(view.working));
    } else if (action === 'panel-close') {
      const wasArrange = view.panel === 'arrange-settings';
      if (wasArrange) { clearTimeout(view.arrangeFlashTimer); clearArrangeDragFeedback(view); view.arrangeInitialDraft = null; view.arrangeDrag = null; view.arrangeFlashIndex = null; view.arrangeFlashTimer = null; }
      cancelActivePanel(view, wasArrange ? current => renderDynamic(current, { list: true }) : renderFooter);
    } else if (action === 'apply-position') {
      const type = view.positionDraft.type;
      const depth = Number(view.positionDraft.depth);
      const role = view.positionDraft.role;
      applyWorking(view, '批量修改原生位置', () => mutatePosition(view.working, [...view.selected], type, depth, role));
      view.panel = null; renderFooter(view);
    } else if (action === 'apply-order') {
      const start = Number(view.orderDraft.start);
      const gap = view.orderDraft.mode === 'same' ? 0 : Number(view.orderDraft.gap);
      applyWorking(view, '修改顺序', () => mutateOrder(view.working, [...view.selected], view.orderDraft.mode, start, gap));
      view.panel = null; renderFooter(view);
    } else if (action === 'leave-cancel') {
      cancelLeavePrompt(view);
    } else if (action === 'leave-save') {
      await completeLeave(view, true);
    } else if (action === 'leave-discard') {
      await completeLeave(view, false);
    }
  }

  function bindView(view) {
    const root = view.root;
    const blockBookPointer = event => blockTransferBookControl(view, event, event.type === 'pointerdown');
    root.addEventListener('pointerdown', blockBookPointer, true);
    root.addEventListener('touchstart', blockBookPointer, { capture: true, passive: false });
    root.addEventListener('click', blockBookPointer, true);
    root.addEventListener('click', event => {
      const guideNav = event.target.closest?.('[data-guide-target]');
      if (guideNav) {
        event.preventDefault();
        const body = view.root.querySelector('.qa-guide-body');
        const destination = view.root.querySelector('#' + cssEscape(guideNav.dataset.guideTarget));
        if (body && destination) {
          const bodyRect = body.getBoundingClientRect();
          const targetRect = destination.getBoundingClientRect();
          body.scrollTo({ top: body.scrollTop + targetRect.top - bodyRect.top - 6, behavior: 'smooth' });
          view.root.querySelectorAll('[data-guide-target]').forEach(button => button.classList.toggle('is-active', button === guideNav));
        }
        return;
      }
      if ((view.leaveIntent || view.discardConfirmOpen || view.contentDiscardIntent) && !event.target.closest?.('[data-slot="leave-modal"]')) {
        event.preventDefault();
        event.stopPropagation?.();
        return;
      }
      if (consumeNameClickGuard(view, event)) {
        event.preventDefault();
        event.stopPropagation?.();
        return;
      }
      const target = event.target.closest?.('[data-action]');
      if (!target || target.dataset.action === 'drag') return;
      Promise.resolve(handleAction(view, target.dataset.action, target)).catch(error => toast('error', error instanceof Error ? error.message : String(error)));
      view.keywordInternalPointer = false;
    });
    root.addEventListener('keydown', event => {
      if (event.target.dataset.action === 'content-key-edit' && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        if (view.contentEditor?.allowKeyEdit) { view.contentEditor.keywordEditing = true; renderContentEditorDraft(view, 'content-key-input'); }
        return;
      }
      if (event.target.dataset.control === 'content-key-input' && event.key === 'Enter') {
        event.preventDefault();
        if (view.contentEditor && event.target.value.trim()) { view.contentEditor.keysDraft = mergePrimaryKeys(view.contentEditor.keysDraft, event.target.value); view.contentEditor.keyInputDraft = ''; renderContentEditorDraft(view, 'content-key-input'); }
        return;
      }
      if (event.target.dataset.control === 'content-name-full' && event.key === 'Enter') {
        event.preventDefault(); view.contentEditor.titleEditing = false; renderContentEditorDraft(view); return;
      }
      if (event.target.dataset.control === 'entry-name-inline') {
        if (event.key === 'Enter') { event.preventDefault(); finishNameEdit(view, event.target, true); }
        else if (event.key === 'Escape') { event.preventDefault(); finishNameEdit(view, event.target, false); }
        return;
      }
      if (event.target.dataset.control !== 'entry-key-input' || event.key !== 'Enter') return;
      event.preventDefault();
      try { commitKeywordInput(view, event.target, true); }
      catch (error) { toast('error', error instanceof Error ? error.message : String(error), '关键词修改未应用'); }
    });
    root.addEventListener('focusout', event => {
      const control = event.target.dataset.control;
      if (control === 'entry-order' || control === 'entry-depth') {
        const cardId = event.target.closest?.('.qa-card')?.dataset.entryId;
        const value = event.target.value;
        if (!cardId) return;
        try { commitInlineField(view, cardId, control, value); }
        catch (error) { toast('error', error instanceof Error ? error.message : String(error), '字段修改未应用'); }
        return;
      }
      if (control === 'entry-name-inline') {
        finishNameEdit(view, event.target, true);
        return;
      }
      if (event.target.dataset.control !== 'entry-key-input') return;
      const editor = event.target.closest('.qa-keyword-editor');
      if (view.keywordInternalPointer || editor?.contains(event.relatedTarget)) return;
      try { commitKeywordInput(view, event.target, false); }
      catch (error) { toast('error', error instanceof Error ? error.message : String(error), '关键词修改未应用'); }
    });
    root.addEventListener('input', event => {
      const control = event.target.dataset.control;
      if (control === 'content-full' && view.contentEditor) {
        view.contentEditor.draft = event.target.value;
        scheduleContentEditorToken(view);
      }
      if (control === 'content-name-full' && view.contentEditor) view.contentEditor.nameDraft = event.target.value;
      if (control === 'content-key-input' && view.contentEditor) view.contentEditor.keyInputDraft = event.target.value;
      if (control === 'search') scheduleSearch(view, event.target.value);
      if (control === 'transfer-search') { view.transferDraft.query = event.target.value; renderTransferSelection(view, false); }
      if (control === 'import-search') { view.importDraft.query = event.target.value; renderImportSelection(view, false); }
      if (control === 'batch-depth') { view.positionDraft.depth = event.target.value; }
      if (control === 'order-start' || control === 'order-gap') {
        if (control === 'order-start') view.orderDraft.start = event.target.value;
        else view.orderDraft.gap = event.target.value;
        const preview = root.querySelector('[data-slot="order-preview"]');
        if (preview) preview.textContent = orderPreview(view);
      }
    });
    root.addEventListener('change', event => {
      try {
        const control = event.target.dataset.control;
        const card = event.target.closest?.('.qa-card');
        const cardId = card?.dataset.entryId;
        if (control === 'book') {
        const requested = event.target.value;
        /* IWB_IMPORT_CHANGE_GUARD_BEGIN */
        if (view.panel === 'import') { event.target.value = view.book || ''; toast('info', '请先退出从其他书导入'); return; }
        /* IWB_IMPORT_CHANGE_GUARD_END */
        if (view.panel === 'transfer') { event.target.value = view.book || ''; toast('info', '请先退出跨书转移'); return; }
        if (view.panel === 'arrange-settings') { event.target.value = view.book || ''; toast('info', '请先保存或取消整理设置'); return; }
        event.target.value = view.book || '';
        if (!requested || requested === view.book) return;
        if (!showLeavePrompt(view, { kind: 'switch', book: requested })) loadBook(view, requested);

      } else if (control === 'import-source') {
        Promise.resolve(loadImportSource(view, event.target.value)).catch(error => toast('error', error instanceof Error ? error.message : String(error), '来源书读取失败'));

      } else if (control === 'transfer-target-select') {
        view.transferDraft.target = event.target.value; renderTransferSelection(view, true);
      } else if (control === 'import-filter') {
        view.importDraft.filter = event.target.value; renderImportSelection(view, false);
      } else if (control === 'transfer-filter') {
        view.transferDraft.filter = event.target.value; renderTransferSelection(view, false);
      } else if (control === 'state-filter-select') {
        view.stateFilter = event.target.value; view.renderLimit = APP.chunkSize; renderDynamic(view, { list: true, resetScroll: true });
      } else if (control === 'arrange-direction') {
        const index = Number(event.target.dataset.index);
        if (view.arrangeDraft[index]) view.arrangeDraft[index].direction = event.target.value === 'desc' ? 'desc' : 'asc';
        syncArrangeResetButton(view);
      } else if (control === 'position-filter') {


        view.positionFilter = event.target.value; view.renderLimit = APP.chunkSize; renderDynamic(view, { list: true, resetScroll: true });
      } else if (control === 'entry-position' && cardId) {
        const value = event.target.value;
        commitInlineField(view, cardId, control, value);
      } else if (control === 'entry-depth' && cardId) {
        const value = event.target.value;
        commitInlineField(view, cardId, control, value);
      } else if (control === 'entry-role' && cardId) {
        const value = event.target.value;
        commitInlineField(view, cardId, control, value);
      } else if (control === 'entry-order' && cardId) {
        const value = event.target.value;
        commitInlineField(view, cardId, control, value);
      } else if (control === 'batch-position') {
        view.positionDraft.type = event.target.value; renderFooter(view);
      } else if (control === 'batch-role') {
        view.positionDraft.role = event.target.value;
        } else if (control === 'order-mode') {
          view.orderDraft.mode = event.target.value; renderFooter(view);
        }
      } catch (error) {
        toast('error', error instanceof Error ? error.message : String(error), '字段修改未应用');
        renderDynamic(view, { list: true });
      }
    });
    root.addEventListener('dragstart', event => {
      const handle = event.target.closest?.('[data-action="arrange-drag"]');
      if (!handle || view.panel !== 'arrange-settings' || !isDesktopLayout(view)) return;
      const index = Number(handle.dataset.index);
      if (!Number.isInteger(index) || !view.arrangeDraft[index]) { event.preventDefault(); return; }
      view.arrangeDrag = { from: index };
      handle.closest('.qa-arrange-row')?.classList.add('is-dragging');
      event.dataTransfer?.setData('text/plain', String(index));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    root.addEventListener('dragover', event => {
      if (!view.arrangeDrag || view.panel !== 'arrange-settings') return;
      const row = event.target.closest?.('.qa-arrange-row');
      if (!row) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      root.querySelectorAll('.qa-arrange-row.is-drop-before,.qa-arrange-row.is-drop-after').forEach(item => item.classList.remove('is-drop-before', 'is-drop-after'));
      const rowRect = row.getBoundingClientRect();
      row.classList.add(event.clientY > rowRect.top + rowRect.height / 2 ? 'is-drop-after' : 'is-drop-before');
      const list = row.closest('.qa-arrange-list');
      const rect = list?.getBoundingClientRect?.();
      if (list && rect) {
        if (event.clientY < rect.top + 36) list.scrollTop -= 18;
        else if (event.clientY > rect.bottom - 36) list.scrollTop += 18;
      }
    });
    root.addEventListener('dragleave', event => {
      if (!view.arrangeDrag || view.panel !== 'arrange-settings') return;
      if (!event.relatedTarget || !root.contains(event.relatedTarget)) clearArrangeDragFeedback(view);
    });
    root.addEventListener('drop', event => {
      if (!view.arrangeDrag || view.panel !== 'arrange-settings') return;
      const row = event.target.closest?.('.qa-arrange-row');
      if (!row) return;
      event.preventDefault();
      const from = view.arrangeDrag.from;
      const targetIndex = Number(row.dataset.arrangeIndex);
      const rect = row.getBoundingClientRect();
      let to = targetIndex + (event.clientY > rect.top + rect.height / 2 ? 1 : 0);
      if (from < to) to -= 1;
      to = Math.max(0, Math.min(view.arrangeDraft.length - 1, to));
      const scrollTop = Number(row.closest('.qa-arrange-list')?.scrollTop || 0);
      view.arrangeDrag = null;
      clearArrangeDragFeedback(view);
      if (moveArrangeDraft(view, from, to)) renderArrangeDraft(view, scrollTop);
    });
    root.addEventListener('dragend', () => {
      view.arrangeDrag = null;
      clearArrangeDragFeedback(view);
    });
    root.addEventListener('pointerdown', event => {
      const nameAction = event.target.closest?.('[data-action="name-edit"]');
      if (nameAction) {
        event.preventDefault();
        armNameClickGuard(view, event);
        const cardId = nameAction.closest('.qa-card')?.dataset.entryId;
        if (cardId) startNameEdit(view, cardId);
        return;
      }
      const doneAction = event.target.closest?.('[data-action="name-done"]');
      if (doneAction) {
        event.preventDefault();
        armNameClickGuard(view, event);
        const input = doneAction.closest('.qa-name-edit')?.querySelector('[data-control="entry-name-inline"]');
        if (input) finishNameEdit(view, input, true);
        return;
      }
      view.nameClickGuard = null;
      view.keywordInternalPointer = Boolean(event.target.closest?.('.qa-keyword-editor'));
      if (view.keywordInternalPointer) setTimeout(() => { view.keywordInternalPointer = false; }, 0);
      const handle = event.target.closest?.('[data-action="drag"]');
      const card = handle?.closest('.qa-card');
      if (handle && card) startDrag(view, event, card);
    });
    root.addEventListener('pointermove', event => dragMove(view, event));
    root.addEventListener('pointerup', event => endDrag(view, event));
    root.addEventListener('pointercancel', event => endDrag(view, event, true));
    const scroll = root.querySelector('[data-slot="scroll"]');
    scroll.addEventListener('scroll', () => {
      if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 240 && visibleEntries(view).length > view.renderLimit) {
        view.renderLimit += APP.chunkSize;
        renderList(view);
      }
    }, { passive: true });
  }

  function syncMobileViewport(view) {
    if (!view?.root || !view.popupDialog) return;
    const outer = hostWindow();
    const viewport = outer.visualViewport;
    const width = Math.max(1, Math.round(Number(viewport?.width) || Number(outer.innerWidth) || 1));
    const height = Math.max(1, Math.round(Number(viewport?.height) || Number(outer.innerHeight) || 1));
    if (!view.viewportLastWidth || Math.abs(view.viewportLastWidth - width) > 40) view.viewportBaselineHeight = height;
    view.viewportLastWidth = width;
    view.viewportBaselineHeight = Math.max(Number(view.viewportBaselineHeight) || 0, height);
    const keyboardOpen = height < view.viewportBaselineHeight - Math.max(120, view.viewportBaselineHeight * 0.18);
    const contentEditing = Boolean(view.contentEditor);
    const shellWidth = contentEditing ? Math.max(1, Math.round(Number(outer.innerWidth) || width)) : width;
    const shellHeight = contentEditing ? Math.max(height, Math.round(Number(view.viewportBaselineHeight) || Number(outer.innerHeight) || height)) : height;
    const top = contentEditing ? 0 : Math.max(0, Math.round(Number(viewport?.offsetTop) || 0));
    const left = contentEditing ? 0 : Math.max(0, Math.round(Number(viewport?.offsetLeft) || 0));
    const style = view.popupDialog.style;
    style.setProperty('--iwb-qa-vv-width', shellWidth + 'px');
    style.setProperty('--iwb-qa-vv-height', shellHeight + 'px');
    style.setProperty('--iwb-qa-vv-top', top + 'px');
    style.setProperty('--iwb-qa-vv-left', left + 'px');
    style.setProperty('--iwb-qa-content-vv-height', Math.min(shellHeight, height) + 'px');
    view.root.classList.toggle('qa-keyboard-open', keyboardOpen);
  }

  function installMobileViewport(view, popup) {
    const outer = hostWindow();
    view.popupDialog = popup.dlg || null;
    view.mobileViewport = outer.visualViewport || null;
    view.onMobileViewportChange = () => syncMobileViewport(view);
    view.mobileViewport?.addEventListener('resize', view.onMobileViewportChange, { passive: true });
    outer.addEventListener?.('resize', view.onMobileViewportChange, { passive: true });
    syncMobileViewport(view);
  }

  function removeMobileViewport(view) {
    const outer = hostWindow();
    view.mobileViewport?.removeEventListener('resize', view.onMobileViewportChange);
    outer.removeEventListener?.('resize', view.onMobileViewportChange);
    view.mobileViewport = null;
    view.onMobileViewportChange = null;
    view.popupDialog = null;
  }

  function finalizeView(view) {
    if (!view || view.closed) return;
    clearTimeout(view.searchTimer);
    clearTimeout(view.contentTokenTimer);
    clearTimeout(view.arrangeFlashTimer);
    clearEntryMoveFeedback(view);
    clearEntryDragFeedback(view);
    stopDragAutoScroll(view);
    removeMobileViewport(view);
    view.closed = true;
    view.root?.remove();
    if (currentView === view) currentView = null;
  }

  async function openObserver() {
    if (currentView && !currentView.closed) return;
    const api = sillyTavernApi();
    if (!api?.Popup || !api?.POPUP_TYPE) throw new Error('当前环境没有提供 SillyTavern.Popup 稳定接口。');
    const doc = hostDocument();
    const holder = doc.createElement('div');
    holder.innerHTML = templateHtml();
    const view = {
      root: null, popup: null, names: [], book: '', baseline: null, working: null, mixedMode: false, activeBooks: [], bookStates: new Map(), mixedSignature: '', slotBaseline: [], sourceVisible: true, transferStates: new Map(), transferMoveTargets: new Set(), transferDraft: createTransferDraft(), transferReturnScroll: 0, toolsOpen: false, titleLocked: true,
      selected: new Set(), expanded: new Set(), undo: [], query: '', stateFilter: 'all', positionFilter: 'all', searchOpen: false, moveMode: false,
      renderLimit: APP.chunkSize, panel: null, leaveIntent: null, leaveError: '', discardConfirmOpen: false, loading: false, busy: null,
      error: '', closed: false, forceClose: false, searchTimer: null, drag: null, tokenCounts: new Map(), tokenTask: null,
      contentEditor: null, contentDiscardIntent: null, contentTokenTimer: null, entryMoveFeedbackTimer: null,
      guideOpen: false, guideScrollTop: 0, guideReturnFocus: null,
      keywordInternalPointer: false, nameClickGuard: null,
      popupDialog: null, mobileViewport: null, onMobileViewportChange: null,
      viewportBaselineHeight: 0, viewportLastWidth: 0,
      positionDraft: { type: 'before_character_definition', depth: '4', role: 'system' },
      orderDraft: { mode: 'same', start: '100', gap: '10' },
      importDraft: { source: '', entries: null, selected: new Set(), previewed: new Set(), query: '', filter: 'all', loading: false, error: '' },
      arrangeDraft: [], arrangeInitialDraft: null, arrangeDrag: null, arrangeFlashIndex: null, arrangeFlashTimer: null,
    };
    const displayType = api.POPUP_TYPE.DISPLAY ?? api.POPUP_TYPE.TEXT;
    view.popup = new api.Popup(holder.firstElementChild.outerHTML, displayType, '', {
      okButton: false, cancelButton: false, wide: true, wider: true, large: true, transparent: true,
      allowHorizontalScrolling: false, allowVerticalScrolling: false, leftAlign: true,
      allowEscapeClose: true,
      onClosing: async () => {
        if (view.contentDiscardIntent) { view.contentDiscardIntent = null; renderLeaveModal(view); return false; }
        if (view.discardConfirmOpen) { view.discardConfirmOpen = false; renderLeaveModal(view); return false; }
        if (view.guideOpen) { closeGuide(view); return false; }
        if (view.contentEditor) {
          if (requestContentEditorClose(view, 'close')) return false;
          if (view.forceClose || !isDirty(view)) return true;
          showLeavePrompt(view, { kind: 'close' });
          return false;
        }
        if (view.busy) return false;
        if (view.forceClose || !isDirty(view)) return true;
        showLeavePrompt(view, { kind: 'close' });
        return false;
      },
      onOpen: async popup => {
        popup.dlg?.classList.add('iwb-qa-host');
        view.root = popup.dlg?.querySelector('#iwb-qa-root');
        if (!view.root) throw new Error('原生弹窗已打开，但未找到常用编辑容器。');
        installMobileViewport(view, popup);
        bindView(view);
        renderDynamic(view, { list: true });
        try { await readNames(view); }
        catch (error) { view.error = error instanceof Error ? error.message : String(error); renderDynamic(view, { list: true }); }
      },
      onClose: async () => finalizeView(view),
    });
    currentView = view;
    Promise.resolve(view.popup.show()).catch(error => { finalizeView(view); toast('error', error instanceof Error ? error.message : String(error), '打开失败'); });
  }

  function registerButton(quiet = false) {
    if (buttonRegistered) return true;
    try {
      const on = requirePublicFunction('eventOn');
      const getEvent = requirePublicFunction('getButtonEvent');
      on(getEvent(APP.buttonName), () => Promise.resolve(openObserver()).catch(error => toast('error', error instanceof Error ? error.message : String(error), '打开失败')));
      buttonRegistered = true;
      if (!quiet) toast('success', `v${APP.version} 入口已就绪`);
      return true;
    } catch (error) {
      if (!quiet) toast('error', error instanceof Error ? error.message : String(error), '启动失败');
      return false;
    }
  }

  const TEST_API = Object.freeze({
    cloneJson, entryId, decodeEntryId, assertUniqueEntries, positionInfo, moveEntries, dropEntries, plainEntry, mixedEntry, mixedGroups, mixedDirtyBooks, mixedSlotSequence, defaultMixedSlots, resolveMixedSlots, refreshMixedBookIndexes, effectiveMixedArrangeRules, arrangeMixedWorking, loadMixedArrangeRules, saveMixedArrangeRules, initializeMixedWorking, reflowMixedHardGroups, copyMixedEntry, dedupeActiveSources, sourceLabel, activeSourceText, selectedGlobalSourcesFromDom, collectWorldInfoEvidence, sourcesFromWorldInfoEvidence, discoverActiveBooks, compareMixedEntries, rebuildMixedBaseline, mixedChangedIds, singleChangeSummary, pendingSummary, mobilePendingSummary, pendingChangeCount, inlineFieldMutation, commitInlineField,
    mutatePosition, mutateOrder, changedIds, jsonText, persistWorkingCopy, primaryKeys, visibleEntries, hasActiveListFilters, listSelectionScope, selectListScope, listContextHtml,
    allocateUidFromUsedKeys, importEntriesAtTop, batchSetEnabledEntries, batchSetEnabledSelected, batchDeleteEntries, batchDeleteSelected, transferEntriesAtTop, transferDirtyBooks, transferSnapshot, restoreTransferSnapshot, discardTransferChanges, visibleTransferEntries, transferWorkspaceHtml, applyTransfer, saveTransfer, createTransferDraft, captureTransferListScroll, restoreTransferListScroll, renderTransferSelection, isLockedTransferBookControl, blockTransferBookControl, arrangeTrack, discoverArrangeTracks, defaultArrangeRules, loadArrangeRules, saveArrangeRules, effectiveArrangeRules, stableAutoArrange, disableAllRecursion, recursionStatusHtml, visibleImportEntries, importResultsHtml,
    editableActivationType, enabledPresentation, parsePrimaryKeys, normalizePrimaryKeys, mergePrimaryKeys, removePrimaryKey, allocateUid, createMinimalEntry, copyEntry, mutateEntry,
    computeDragAutoScrollSpeed, templateHtml, STYLES, applyWorkingQuiet, toggleEnabledInPlace, compactPositionLabel, compactSummary,
    contentPreviewText, createContentEditorState, applyContentDraft, contentEditorChanged, contentEditorTitleHtml, contentEditorKeysHtml, sourcePreviewRow, renderImportSelection, toggleSourcePreview, arrangeDraftChanged, moveArrangeDraft, resetArrangeDraft, syncArrangeResetButton, renderArrangeDraft, clearArrangeDragFeedback, flashArrangeTrack, clearEntryDragFeedback, markEntryDragSource, clearEntryMoveFeedback, flashMovedEntries, moveModeLabel, anchoredScrollTop, nameButtonHtml, canEditTitle, isDesktopLayout, startNameEdit, finishNameEdit, bindView, inlineFieldsHtml, keywordEditorContents, guideHtml, editorHtml, cardHtml, renderPanel, importWorkspaceHtml, footerHtml, leaveModalHtml, discardConfirmHtml, renderLeaveModal, showLeavePrompt, cancelLeavePrompt, completeLeave, syncTopControls, cancelActivePanel, clearImportSelection, cancelImportWorkspace, loadBook, renderDynamic,
  });
  if (TEST_MODE) {
    globalThis.__IWB_QA_TEST_API__ = TEST_API;
    return;
  }

  registerButton(true);
  if (typeof $ === 'function') $(() => registerButton(false));
  else if (hostDocument().readyState === 'loading') hostDocument().addEventListener('DOMContentLoaded', () => registerButton(false), { once: true });
  else registerButton(false);
})();

