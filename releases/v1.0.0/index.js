/** Worldbook Observer | P2-B01: UI lifecycle migration, legacy visuals retained. */
(() => {
  'use strict';

  // UI lifecycle only. No worldbook data, device CSS, or persistence rules.
  function createUiResources(isAlive = () => true) {
    let disposed = false;
    const cleanups = new Set();
    const timers = new Map();
    function own(cleanup) {
      let active = true;
      const release = () => {
        if (!active) return;
        active = false;
        cleanups.delete(release);
        cleanup();
      };
      if (disposed) release(); else cleanups.add(release);
      return release;
    }
    function listen(target, event, callback, options) {
      if (disposed || !target?.addEventListener) return () => {};
      const guarded = function (...args) {
        if (!disposed && isAlive()) return callback.apply(this, args);
      };
      target.addEventListener(event, guarded, options);
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      return own(() => target.removeEventListener(event, guarded, capture));
    }
    function timeout(key, callback, delay = 0) {
      if (timers.has(key)) clearTimeout(timers.get(key));
      timers.delete(key);
      if (disposed || !isAlive()) return null;
      const id = setTimeout(() => {
        if (timers.get(key) !== id) return;
        timers.delete(key);
        if (!disposed && isAlive()) callback();
      }, delay);
      timers.set(key, id);
      return id;
    }
    function frame(outer, callback) {
      if (disposed || !isAlive()) return null;
      if (typeof outer?.requestAnimationFrame !== 'function') {
        return timeout(Symbol('ui-frame'), () => callback(Date.now()), 16);
      }
      let release;
      const id = outer.requestAnimationFrame(timestamp => {
        release();
        if (!disposed && isAlive()) callback(timestamp);
      });
      release = own(() => outer.cancelAnimationFrame?.(id));
      return id;
    }
    function dispose() {
      if (disposed) return [];
      disposed = true;
      const errors = [];
      for (const id of timers.values()) clearTimeout(id);
      timers.clear();
      for (const release of [...cleanups].reverse()) {
        try { release(); } catch (error) { errors.push(error); }
      }
      return errors;
    }
    return Object.freeze({ own, listen, timeout, frame, dispose,
      get disposed() { return disposed; },
      get pendingCount() { return cleanups.size + timers.size; },
    });
  }

  function createUiSession(view, adapter) {
    for (const key of ['template', 'mount', 'refresh', 'canClose', 'unmount']) {
      if (typeof adapter?.[key] !== 'function') throw new TypeError('UI adapter missing ' + key);
    }
    const resources = createUiResources(() => !view.closed);
    let phase = 'prepared';
    let cleanupErrors = [];
    const session = {
      adapterId: adapter.id,
      resources,
      template() {
        if (phase === 'disposed') throw new Error('UI session already disposed');
        return adapter.template(view);
      },
      mount(popup) {
        if (phase === 'disposed' || view.closed) return false;
        if (phase !== 'prepared') return false;
        phase = 'mounting';
        try { adapter.mount(view, popup, resources); phase = 'mounted'; return true; }
        catch (error) { session.dispose(); throw error; }
      },
      refresh(options = {}) {
        if (phase === 'disposed' || view.closed) return;
        return adapter.refresh(view, options);
      },
      invoke(name, ...args) {
        if (phase === 'disposed' || view.closed) return;
        const operation = adapter.parts?.[name];
        if (typeof operation !== 'function') throw new Error('Selected UI has no operation: ' + name);
        return operation(view, ...args);
      },
      canClose() {
        return phase === 'disposed' ? true : adapter.canClose(view);
      },
      dispose() {
        if (phase === 'disposed') return cleanupErrors.slice();
        phase = 'disposed';
        cleanupErrors = resources.dispose();
        try { adapter.unmount(view); } catch (error) { cleanupErrors.push(error); }
        return cleanupErrors.slice();
      },
      get phase() { return phase; },
    };
    return Object.freeze(session);
  }
  // Pure data helpers moved without changing their source bodies.
  function cloneJson(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
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

  // Data command: explicit target IDs in; a data-only receipt out.
  // commit() checkpoints the current working copy BEFORE replacing it.
  // No selection, DOM, UI adapter, notification or persistence is accessed here.
  function runSetEntriesEnabled(data, targetIds, enabled, undoLabel) {
    const ids = [...new Set(targetIds || [])];
    if (data.getBusy()) {
      return { status: 'busy', changed: false, changedIds: [],
        changedCount: 0, skippedCount: ids.length };
    }
    const result = batchSetEnabledEntries(data.getWorking(), ids, enabled);
    if (!result.changedCount) {
      return { status: 'unchanged', changed: false, changedIds: [],
        changedCount: 0, skippedCount: result.skippedCount };
    }
    data.commit(result.entries, undoLabel);
    return { status: 'changed', changed: true, changedIds: result.changedIds,
      changedCount: result.changedCount, skippedCount: result.skippedCount };
  }

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

  // Unchanged 19.3 style snapshot. Compat only; not the final cleaned mobile stylesheet.
  const STYLES = `
    #iwb-qa-root{--qa-bg:var(--SmartThemeBlurTintColor,rgba(20,22,27,.97));--qa-card-bg:color-mix(in srgb,var(--qa-bg) 94%,var(--SmartThemeBodyColor,#eee) 6%);--qa-edit-bg:color-mix(in srgb,var(--qa-bg) 90%,var(--SmartThemeBodyColor,#eee) 10%);--qa-card-line:color-mix(in srgb,var(--SmartThemeBodyColor,#eee) 38%,var(--qa-bg) 62%);--qa-selected-line:#78bdff;--qa-panel-bg:color-mix(in srgb,var(--qa-bg) 88%,var(--SmartThemeBodyColor,#eee) 12%);--qa-panel-line:color-mix(in srgb,var(--SmartThemeBodyColor,#eee) 48%,var(--qa-bg) 52%);--qa-line:color-mix(in srgb,var(--SmartThemeBodyColor,#eee) 20%,transparent);color:var(--SmartThemeBodyColor,#eee);font:14px/1.4 system-ui,sans-serif;width:100%;max-width:760px;min-width:0;height:min(92dvh,900px);max-height:92dvh;margin:0 auto;overflow:hidden;position:relative}
    #iwb-qa-root *{box-sizing:border-box}#iwb-qa-root button,#iwb-qa-root input,#iwb-qa-root select,#iwb-qa-root textarea{font:inherit;color:inherit}
    .qa-shell{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:var(--qa-bg);border:1px solid var(--qa-line);border-radius:16px;overflow:hidden;box-shadow:0 18px 50px #0008}
    .qa-head{padding:8px 10px 7px;border-bottom:1px solid var(--qa-line);background:color-mix(in srgb,var(--qa-bg) 94%,#fff 6%);display:grid;gap:6px}
    .qa-title-row,.qa-book-row,.qa-tool-row,.qa-footer-row,.qa-summary-actions,.qa-content-head{display:flex;gap:5px;align-items:center;min-width:0}.qa-title{min-width:0;flex:1}.qa-title h2{font-size:16px;line-height:1.2;margin:0}.qa-title p{font-size:11px;opacity:.7;margin:2px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qa-mode-toggle[aria-pressed="true"]{border-color:var(--qa-selected-line);color:var(--qa-selected-line);background:color-mix(in srgb,var(--qa-selected-line) 10%,transparent)}
    .qa-icon{width:38px;min-width:38px;height:38px;border:1px solid transparent;border-radius:7px;background:transparent;display:grid;place-items:center}.qa-icon:hover,.qa-icon:focus-visible{border-color:var(--qa-line);background:#0002}.qa-icon:disabled{opacity:.38}.qa-mobile-close{display:none}.qa-book-row .qa-select{flex:1}
    .qa-book-picker{position:relative;min-width:0}.qa-book-picker-trigger{width:100%;height:34px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 8px;border:1px solid var(--qa-card-line);border-radius:6px;background:#0002;color:inherit;text-align:left}.qa-book-picker-trigger>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qa-book-picker-trigger[aria-expanded="true"]{border-color:var(--qa-selected-line);box-shadow:0 0 0 1px color-mix(in srgb,var(--qa-selected-line) 28%,transparent)}.qa-book-picker-trigger:disabled{opacity:.58}.qa-book-picker-popover{position:absolute;z-index:40;top:calc(100% + 5px);left:0;width:min(100%,520px);min-width:min(100%,320px);max-height:min(58dvh,470px);display:grid;grid-template-rows:auto minmax(0,1fr);gap:7px;padding:8px;border:1px solid var(--qa-card-line);border-radius:10px;background:var(--qa-bg);box-shadow:0 16px 40px #0008}.qa-book-picker-popover[hidden]{display:none}.qa-book-picker-search{height:38px!important;background:var(--qa-edit-bg)!important}.qa-book-picker-results{min-height:0;overflow:auto;overscroll-behavior:contain;display:grid;gap:8px}.qa-book-picker-group{display:grid;gap:3px}.qa-book-picker-group h3{position:sticky;top:0;z-index:1;margin:0;padding:5px 7px;font-size:12px;color:inherit;background:var(--qa-panel-bg);border-radius:6px}.qa-book-picker-item{min-height:38px;width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border:1px solid transparent;border-radius:7px;background:transparent;color:inherit;text-align:left}.qa-book-picker-item>span{min-width:0;overflow-wrap:anywhere}.qa-book-picker-item:hover,.qa-book-picker-item:focus-visible{border-color:var(--qa-card-line);background:var(--qa-edit-bg)}.qa-book-picker-item.is-current{border-color:var(--qa-selected-line);background:color-mix(in srgb,var(--qa-selected-line) 13%,var(--qa-bg))}.qa-book-picker-empty{padding:24px 10px;text-align:center;opacity:.7}.qa-book-picker.is-locked .qa-book-picker-trigger{cursor:not-allowed}
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
    .qa-leave-layer{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;padding:16px;overflow:auto;overscroll-behavior:contain}.qa-leave-layer[hidden]{display:none}.qa-leave-backdrop{position:absolute;inset:0;background:#000a}.qa-leave-dialog{position:relative;z-index:1;width:min(100%,380px);max-height:calc(100dvh - 32px);overflow:auto;display:grid;gap:12px;padding:16px;border:1px solid var(--qa-card-line);border-radius:12px;background:var(--qa-bg);box-shadow:0 20px 60px #000b}.qa-leave-dialog h3{margin:0;font-size:17px}.qa-leave-dialog p{margin:0;line-height:1.5}.qa-leave-error{padding:8px;border-radius:7px;background:color-mix(in srgb,#b93232 18%,var(--qa-bg));color:#ffd5d5;font-size:12px}.qa-leave-actions{display:grid;grid-template-columns:1fr;gap:7px}.qa-leave-actions .qa-btn{width:100%;min-height:40px}.qa-leave-open .qa-scroll,.qa-leave-open .qa-workspace-panel{overflow:hidden!important}.qa-top-grid{display:grid;grid-template-columns:minmax(0,1fr) 92px;gap:7px;align-items:stretch}.qa-top-grid>.qa-top-left,.qa-top-grid>.qa-top-right{min-width:0;width:100%;height:34px}.qa-top-grid>.qa-book-picker{height:auto}.qa-filter-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;min-width:0}.qa-filter-pair>.qa-input,.qa-filter-pair>.qa-select{min-width:0;width:100%;height:34px;padding-inline:5px;white-space:nowrap}.qa-mode-segments{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:5px!important}.qa-title-lock{white-space:nowrap;padding-inline:4px}.qa-import-workspace{min-height:100%;display:grid;align-content:start;gap:9px;padding:8px}.qa-import-workspace h3{margin:0 0 3px}.qa-import-body{display:grid;gap:7px;min-height:0}.qa-import-selection-note{font-size:11px;opacity:.72}.qa-import-actions{position:sticky;bottom:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;padding:7px 0 2px;background:var(--qa-bg);z-index:2}.qa-import-actions .qa-btn{min-width:0}.qa-import-active .qa-filter-pair,.qa-import-active .qa-top-grid>[data-action="other-tools"],.qa-import-active [data-slot="other-tools"],.qa-import-active [data-slot="status"]{display:none!important}.qa-scroll.qa-import-mode{padding:0}.qa-shell{grid-template-rows:auto auto minmax(0,1fr) auto}.qa-title h2{font-size:17px}.qa-title p{display:none}.qa-book-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:end}.qa-new-top{min-width:92px;white-space:nowrap}.qa-mode-segments{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.qa-mode-segment{height:34px;border:1px solid var(--qa-card-line);border-radius:7px;background:#0002}.qa-mode-segments .qa-mode-segment{background:#fff;color:#1b1f24!important;border-color:#d7dce2}.qa-mode-segments .qa-mode-segment.is-active{border-color:var(--qa-selected-line);background:#267bc8;color:#fff!important;font-weight:700}.qa-filter-pair input[data-control="search"]{background:#fff;color:#1b1f24!important;border-color:#d7dce2}.qa-filter-pair [data-control="search"]::placeholder{color:#69717c;opacity:1}.qa-compact-tools{display:grid;grid-template-columns:minmax(66px,.55fr) minmax(146px,1.45fr) auto;gap:5px}.qa-compact-tools .qa-input,.qa-compact-tools .qa-select,.qa-compact-tools .qa-btn{min-width:0;width:100%;padding-inline:5px;white-space:nowrap}.qa-other-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;padding-top:2px}.qa-other-tools[hidden]{display:none}.qa-other-tools .qa-btn{min-width:0;white-space:normal}.qa-other-tools .qa-btn:last-child{grid-column:1/-1}.qa-arrange-quick{min-width:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}.qa-arrange-quick .qa-btn{width:100%;min-width:0;padding-inline:3px;white-space:nowrap}.qa-workspace-panel{max-height:min(45dvh,380px);overflow-y:auto;padding:5px 6px;border-bottom:1px solid var(--qa-line);background:var(--qa-bg)}.qa-workspace-panel[hidden]{display:none}.qa-footer{max-height:40%;overflow-y:auto}.qa-selection-context{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:4px;align-items:center}.qa-save-bar{display:grid;grid-template-columns:minmax(68px,1fr) repeat(2,minmax(56px,.75fr)) minmax(78px,1fr);gap:4px;align-items:center}.qa-save-bar .qa-btn{min-width:0;padding-inline:4px}.qa-batch-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}.qa-arrange-row{grid-template-columns:minmax(0,1fr) 92px 36px 36px}.qa-arrange-label{display:grid;min-width:0}.qa-arrange-label span{overflow-wrap:anywhere}.qa-arrange-label small{font-size:10px;opacity:.68}.qa-recursion-status{display:flex;flex-wrap:wrap;gap:2px 7px;font-size:10px;font-weight:400;opacity:.62;margin-left:5px}.qa-content-label{flex-wrap:wrap}.qa-content-label>span:first-child{flex:0 1 auto}.qa-content-open{margin-left:auto}.qa-mode-lock{width:44px;text-align:center;opacity:.45}.qa-name-readonly{cursor:default}
    @media(max-width:340px){#iwb-qa-root .qa-filter-pair select[data-control="state-filter-select"]{font-size:8px!important;padding-inline:0!important}.qa-compact-tools{grid-template-columns:minmax(66px,.55fr) minmax(146px,1.45fr) auto;gap:5px}.qa-save-bar{grid-template-columns:1fr 1fr}.qa-save-bar .primary{grid-column:2}.qa-arrange-row{grid-template-columns:minmax(0,1fr) 82px 32px 32px}}
    @media(max-width:480px){
      .qa-book-picker-popover{position:fixed;z-index:10020;top:106px;left:10px;right:10px;width:auto;min-width:0;max-height:calc(var(--iwb-qa-vv-height,100dvh) - 126px)}.qa-book-picker-item{min-height:44px}
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
    .qa-list-context>span{min-width:0;display:flex;align-items:center;gap:7px}.qa-list-context-actions{display:flex;align-items:center;gap:5px;min-width:0}.qa-list-context strong{font-size:12px;color:var(--qa-text)}.qa-list-context small{font-size:11px;color:var(--qa-muted);white-space:nowrap}.qa-list-context .qa-btn{min-height:34px;white-space:nowrap;background:var(--qa-accent-soft);border-color:var(--qa-accent-line);color:#365e7f}
    @media(min-width:481px){.qa-footer .qa-selection-context strong{display:none!important}}
    @media(max-width:480px){.qa-list-context{min-height:44px;margin-bottom:4px;padding:3px 5px}.qa-list-context>span{display:flex;align-items:baseline;gap:5px;white-space:nowrap}.qa-list-context strong{font-size:12px}.qa-list-context small{font-size:10px}.qa-list-context .qa-btn{min-height:38px;padding-inline:8px}.qa-mobile-footer-summary>span:first-child{display:none!important}.qa-mobile-footer-summary{justify-content:flex-end!important}}
    /* IWB_V042_LIST_SELECTION_CSS_END */

    /* IWB_V047_ENTRY_GROUPS_CSS_BEGIN */
    .qa-entry-groups-panel{min-height:0}.qa-entry-groups-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.qa-entry-groups-head>div{min-width:0}.qa-entry-group-create{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}.qa-entry-group-create .qa-input{min-width:0}.qa-entry-group-list{display:grid;gap:6px;min-height:0;max-height:230px;overflow:auto}.qa-entry-group{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:7px;border:1px solid var(--qa-line);border-radius:9px;background:var(--qa-surface)}.qa-entry-group-summary{min-width:0;display:grid;gap:2px}.qa-entry-group-summary strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qa-entry-group-summary small{font-size:11px;color:var(--qa-muted)}.qa-entry-group-actions{display:grid;grid-template-columns:repeat(4,auto);gap:4px}.qa-entry-group-actions .qa-btn{min-height:38px;padding-inline:10px}
    @media(max-width:480px){.qa-list-context-actions{gap:3px}.qa-list-context-actions .qa-btn{padding-inline:6px}.qa-entry-groups-head .qa-panel-note{font-size:10px}.qa-entry-group-create{grid-template-columns:minmax(0,1fr);gap:5px}.qa-entry-group-create .qa-btn{min-height:42px}.qa-entry-group{grid-template-columns:minmax(0,1fr);gap:5px}.qa-entry-group-actions{grid-template-columns:repeat(4,minmax(0,1fr))}.qa-entry-group-actions .qa-btn{min-width:0;min-height:42px;padding-inline:2px}.qa-entry-group-list{max-height:38dvh}}
    /* IWB_V047_ENTRY_GROUPS_CSS_END */

    /* IWB_V045_MOBILE_TOOLBAR_BEGIN */
    @media(max-width:480px){
      .qa-head{gap:4px!important;padding-bottom:5px!important}
      .qa-title-row{min-height:38px}
      .qa-title h2{font-size:16px}
      .qa-title-row .qa-icon{width:36px;min-width:36px;height:36px}
      .qa-title-row .qa-mobile-close{width:36px;min-width:36px;height:36px;min-height:36px}
      .qa-mode-segments{min-height:44px;padding:2px;gap:2px!important}
      .qa-mode-segments .qa-mode-segment{min-height:38px;height:38px}
      .qa-top-grid{gap:4px 6px}
      .qa-book-picker-trigger>span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .qa-status.qa-status-redundant{display:none!important}
    }
    /* IWB_V045_MOBILE_TOOLBAR_END */

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
      .qa-other-tools,.qa-other-tools[hidden]{display:contents!important}.qa-other-tools>.qa-btn[data-action="reload"]{grid-column:5/7;grid-row:2;min-height:40px}.qa-top-grid>[data-action="new-entry"],.qa-top-grid>[data-action="toggle-source"]{grid-column:1;grid-row:3;min-height:42px}.qa-other-tools>[data-action="panel-import"]{grid-column:2;grid-row:3;min-height:42px}.qa-other-tools>[data-action="panel-transfer"]{grid-column:3;grid-row:3;min-height:42px}.qa-other-tools>[data-action="auto-arrange"]{grid-column:4;grid-row:3;min-height:42px}.qa-other-tools>.qa-arrange-quick{grid-column:4;grid-row:3;height:42px}.qa-other-tools>.qa-arrange-quick .qa-btn{height:42px;min-height:42px;padding-inline:3px}.qa-other-tools>[data-action="arrange-settings"]{grid-column:5;grid-row:3;min-height:42px}.qa-other-tools>[data-action="disable-recursion"]{grid-column:6;grid-row:3;min-height:42px}.qa-status{grid-column:1/-1;grid-row:4}
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
      .qa-other-tools>.qa-arrange-quick{grid-column:4;grid-row:4;height:52px}.qa-other-tools>.qa-arrange-quick .qa-btn{height:52px;min-height:52px;padding-inline:3px}
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

    /* IWB_V043_THEME_SWITCH_BEGIN */
    .qa-theme-layer{position:absolute;inset:0;z-index:36;display:grid;place-items:center;padding:14px}
    .qa-theme-layer[hidden]{display:none}
    .qa-theme-backdrop{position:absolute;inset:0;border:0;background:rgba(31,34,43,.34);backdrop-filter:blur(2px)}
    .qa-theme-dialog{position:relative;width:min(430px,100%);max-height:calc(100% - 12px);overflow:auto;border:1px solid var(--qa-panel-line);border-radius:16px;background:var(--qa-surface);box-shadow:0 18px 48px rgba(40,43,59,.22);padding:14px;color:var(--qa-text)}
    .qa-theme-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:12px}.qa-theme-head>div{min-width:0;flex:1}.qa-theme-head h3{margin:0;font-size:16px}.qa-theme-head p{margin:3px 0 0;color:var(--qa-muted);font-size:12px}.qa-theme-head .qa-icon{flex:0 0 40px;width:40px;height:40px;font-size:22px}
    .qa-theme-options{display:grid;gap:9px}.qa-theme-choice{display:grid;grid-template-columns:72px minmax(0,1fr) 28px;align-items:center;gap:11px;width:100%;min-height:76px;padding:9px 10px;border:1px solid var(--qa-card-line);border-radius:13px;background:var(--qa-card-bg);text-align:left;cursor:pointer}.qa-theme-choice:hover,.qa-theme-choice:focus-visible{border-color:var(--qa-accent-line);box-shadow:0 0 0 2px color-mix(in srgb,var(--qa-accent) 13%,transparent)}.qa-theme-choice>span:nth-child(2){display:grid;gap:3px;min-width:0}.qa-theme-choice strong{font-size:14px}.qa-theme-choice small{color:var(--qa-muted);font-size:11px;line-height:1.35}.qa-theme-choice>b{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--qa-accent);color:#fff;opacity:0}
    #iwb-qa-root[data-theme="fog-ink"] .qa-theme-choice[data-theme-choice="fog-ink"],#iwb-qa-root[data-theme="wisteria-moon"] .qa-theme-choice[data-theme-choice="wisteria-moon"],#iwb-qa-root[data-theme="night-mist"] .qa-theme-choice[data-theme-choice="night-mist"]{border-color:var(--qa-accent-line);background:var(--qa-accent-soft)}
    #iwb-qa-root[data-theme="fog-ink"] .qa-theme-choice[data-theme-choice="fog-ink"]>b,#iwb-qa-root[data-theme="wisteria-moon"] .qa-theme-choice[data-theme-choice="wisteria-moon"]>b,#iwb-qa-root[data-theme="night-mist"] .qa-theme-choice[data-theme-choice="night-mist"]>b{opacity:1}
    .qa-theme-preview{display:grid;grid-template-columns:repeat(4,1fr);align-items:end;width:72px;height:48px;padding:6px;border:1px solid rgba(68,72,86,.12);border-radius:10px}.qa-theme-preview i{display:block;height:100%;border-radius:5px}.qa-theme-preview i:nth-child(2){height:82%}.qa-theme-preview i:nth-child(3){height:64%}.qa-theme-preview i:nth-child(4){height:46%}.qa-theme-preview-fog{background:#F5F7F8}.qa-theme-preview-fog i:nth-child(1){background:#FFFFFF}.qa-theme-preview-fog i:nth-child(2){background:#EAF2F8}.qa-theme-preview-fog i:nth-child(3){background:#5B8FB9}.qa-theme-preview-fog i:nth-child(4){background:#D7A85B}.qa-theme-preview-wisteria{background:#F7F7FC}.qa-theme-preview-wisteria i:nth-child(1){background:#FFFFFF}.qa-theme-preview-wisteria i:nth-child(2){background:#ECE9F8}.qa-theme-preview-wisteria i:nth-child(3){background:#6F63A8}.qa-theme-preview-wisteria i:nth-child(4){background:#D8D3F0}.qa-theme-preview-night{background:#202129}.qa-theme-preview-night i:nth-child(1){background:#2B2C36}.qa-theme-preview-night i:nth-child(2){background:#39354B}.qa-theme-preview-night i:nth-child(3){background:#9186C2}.qa-theme-preview-night i:nth-child(4){background:#D6B86A}

    #iwb-qa-root[data-theme="wisteria-moon"]{
      --qa-bg:#F7F7FC;--qa-card-bg:#FFFFFF;--qa-edit-bg:#F0EFF8;--qa-card-line:#E2DFF0;--qa-selected-line:#AFA6D4;--qa-panel-bg:#FFFFFF;--qa-panel-line:#D8D3E8;--qa-line:#E2DFF0;
      --qa-surface:#FFFFFF;--qa-surface-soft:#F0EFF8;--qa-surface-blue:#F2F0FB;--qa-text:#2F3040;--qa-muted:#6F7084;--qa-accent:#6F63A8;--qa-accent-strong:#594B91;--qa-accent-soft:#ECE9F8;--qa-accent-line:#AFA6D4;--qa-green:#65A982;--qa-green-line:#86C7A0;--qa-warning:#D6B86A;--qa-danger:#A7535E;--qa-danger-soft:#F9ECEE;--qa-shadow:0 5px 18px rgba(65,58,101,.09);--qa-shadow-soft:0 2px 8px rgba(65,58,101,.07);
      color:var(--qa-text)!important;background:var(--qa-bg)
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-shell{box-shadow:0 18px 50px rgba(50,47,74,.17)}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-title h2,#iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-head h3,#iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-section h4{color:#393553}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-icon,#iwb-qa-root[data-theme="wisteria-moon"] .qa-mobile-close{color:#55516B}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-dialog,#iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-body{color:#3B3A4D}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-body{background:var(--qa-bg)}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-quick{border-color:#D8D3E8;background:var(--qa-accent-soft);color:#585080}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-section{border-color:var(--qa-card-line);background:var(--qa-card-bg);box-shadow:var(--qa-shadow-soft)}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-section li{color:#5D5D70}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-section strong{color:#45415F}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-about{color:var(--qa-muted)}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-card.is-selected{background:#F2F0FB}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-batch-danger-group{background:#FBF2F3;border-color:#E9C8CD}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-discard-confirm-dialog,#iwb-qa-root[data-theme="wisteria-moon"] .qa-leave-dialog{border-color:#D8D3E8;box-shadow:0 18px 48px rgba(50,47,74,.22)}
    @media(max-width:480px){.qa-theme-layer{padding:12px}.qa-theme-dialog{width:100%;border-radius:15px}.qa-theme-choice{grid-template-columns:64px minmax(0,1fr) 26px;min-height:72px;gap:9px}.qa-theme-preview{width:64px}}

    /* IWB_V043_WISTERIA_POLISH_BEGIN：Android 真机主题漏色修复。 */
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mode-segments{
      border-color:#E2DFF0;
      background:#F0EFF8;
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mode-segments .qa-mode-segment{
      color:#5D5D70!important;
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mode-segments .qa-mode-segment:hover,
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mode-segments .qa-mode-segment:focus-visible{
      border-color:#D8D3E8;
      background:rgba(255,255,255,.68);
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mode-segments .qa-mode-segment.is-active{
      border-color:#D8D3E8;
      background:#FFFFFF;
      color:#594B91!important;
      box-shadow:0 2px 7px rgba(65,58,101,.10);
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mode-segments .qa-title-lock[aria-pressed="true"]{
      border-color:#D8D3E8;
      background:#ECE9F8;
      color:#6F63A8!important;
    }

    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mobile-task-head{
      border-color:#AFA6D4;
      box-shadow:0 3px 10px rgba(65,58,101,.09);
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mobile-task-heading strong{
      color:#393553;
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mobile-task-back,
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-desktop-task-back{
      border-color:#AFA6D4!important;
      background:#ECE9F8!important;
      color:#594B91!important;
    }

    #iwb-qa-root[data-theme="wisteria-moon"] .qa-source-preview-item>.qa-import-item>input[type="checkbox"]{
      border-color:#CEC9DF;
      background:#FFFFFF!important;
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-source-preview-item>.qa-import-item>input[type="checkbox"]:checked{
      border-color:#6F63A8;
      background:linear-gradient(145deg,#9186C2,#6F63A8)!important;
      box-shadow:0 1px 5px rgba(89,75,145,.25);
    }

    #iwb-qa-root[data-theme="wisteria-moon"] select{
      accent-color:#6F63A8;
    }
    #iwb-qa-root[data-theme="wisteria-moon"] select option:checked{
      color:#594B91!important;
      background:#ECE9F8!important;
    }
    /* IWB_V043_WISTERIA_POLISH_END */


    /* IWB_V043_NIGHT_MIST_BEGIN：深而不黑的夜雾墨紫主题。 */
    #iwb-qa-root[data-theme="night-mist"]{
      color-scheme:dark;
      --qa-bg:#202129;--qa-card-bg:#2B2C36;--qa-edit-bg:#32333E;--qa-card-line:#3D3E4B;--qa-selected-line:#A99DD4;--qa-panel-bg:#292A34;--qa-panel-line:#454653;--qa-line:#3D3E4B;
      --qa-surface:#2B2C36;--qa-surface-soft:#32333E;--qa-surface-blue:#302D40;--qa-text:#E7E5ED;--qa-muted:#AAA7B6;--qa-accent:#9186C2;--qa-accent-strong:#A99DD4;--qa-accent-soft:#39354B;--qa-accent-line:#6F668F;--qa-green:#70B58B;--qa-green-line:#5B9872;--qa-warning:#D6B86A;--qa-danger:#D47D88;--qa-danger-soft:#432D34;--qa-shadow:0 8px 24px rgba(5,6,10,.28);--qa-shadow-soft:0 3px 10px rgba(5,6,10,.20);
      color:var(--qa-text)!important;background:var(--qa-bg)
    }
    .iwb-qa-host[data-iwb-qa-theme="night-mist"] .popup-button-close{background:#E7E5ED!important;border:1px solid #AAA7B6!important;color:#202129!important;opacity:1!important;filter:none!important;box-shadow:0 2px 9px rgba(5,6,10,.38)!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-shell{background:var(--qa-bg);box-shadow:0 18px 54px rgba(5,6,10,.42)}
    #iwb-qa-root[data-theme="night-mist"] .qa-book-picker-trigger,
    #iwb-qa-root[data-theme="night-mist"] .qa-book-picker-popover{background:var(--qa-bg)!important;border-color:var(--qa-panel-line)!important;color:var(--qa-text)!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-book-picker-results{scrollbar-color:#565361 #252630}
    #iwb-qa-root[data-theme="night-mist"] .qa-book-picker-item{background:var(--qa-surface)!important;border-color:var(--qa-panel-line)!important;color:var(--qa-text)!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-book-picker-item:hover,
    #iwb-qa-root[data-theme="night-mist"] .qa-book-picker-item:focus-visible{background:var(--qa-surface-soft)!important;border-color:var(--qa-accent-line)!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-book-picker-item.is-current{background:var(--qa-accent-soft)!important;border-color:var(--qa-accent-line)!important;color:var(--qa-accent-strong)!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-head,
    #iwb-qa-root[data-theme="night-mist"] .qa-content-head,
    #iwb-qa-root[data-theme="night-mist"] .qa-footer,
    #iwb-qa-root[data-theme="night-mist"] .qa-list-context{background:color-mix(in srgb,var(--qa-bg) 88%,var(--qa-surface) 12%);border-color:var(--qa-line)}
    #iwb-qa-root[data-theme="night-mist"] .qa-title h2,
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-head h3,
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-section h4,
    #iwb-qa-root[data-theme="night-mist"] .qa-mobile-task-heading strong,
    #iwb-qa-root[data-theme="night-mist"] .qa-desktop-task-head>[data-slot="desktop-task-title"]{color:var(--qa-text)}
    #iwb-qa-root[data-theme="night-mist"] .qa-icon,
    #iwb-qa-root[data-theme="night-mist"] .qa-mobile-close{color:#D4D1DC}

    #iwb-qa-root[data-theme="night-mist"] input:not([type="checkbox"]):not([type="range"]),
    #iwb-qa-root[data-theme="night-mist"] select,
    #iwb-qa-root[data-theme="night-mist"] textarea,
    #iwb-qa-root[data-theme="night-mist"] .qa-name,
    #iwb-qa-root[data-theme="night-mist"] .qa-inline-value{background:var(--qa-surface)!important;border-color:var(--qa-panel-line)!important;color:var(--qa-text)!important}
    #iwb-qa-root[data-theme="night-mist"] input::placeholder,
    #iwb-qa-root[data-theme="night-mist"] textarea::placeholder{color:#858392!important}

    #iwb-qa-root[data-theme="night-mist"] .qa-btn:not(.primary),
    #iwb-qa-root[data-theme="night-mist"] .qa-icon,
    #iwb-qa-root[data-theme="night-mist"] .qa-top-right:not(.primary){background:var(--qa-surface);border-color:var(--qa-panel-line);color:var(--qa-text)}
    #iwb-qa-root[data-theme="night-mist"] .qa-btn.primary,
    #iwb-qa-root[data-theme="night-mist"] .qa-top-right.primary{background:var(--qa-accent)!important;border-color:var(--qa-accent)!important;color:#F7F5FB!important;box-shadow:0 4px 14px rgba(145,134,194,.22)}
    #iwb-qa-root[data-theme="night-mist"] .qa-btn.danger,
    #iwb-qa-root[data-theme="night-mist"] .qa-save-bar .qa-btn.danger,
    #iwb-qa-root[data-theme="night-mist"] .qa-other-tools .qa-btn[data-action="disable-recursion"]{background:var(--qa-danger-soft)!important;border-color:#68424B!important;color:var(--qa-danger)!important}

    #iwb-qa-root[data-theme="night-mist"] .qa-mode-segments{background:#292A34;border-color:var(--qa-line)}
    #iwb-qa-root[data-theme="night-mist"] .qa-mode-segments .qa-mode-segment{background:transparent;color:#B9B6C4!important;border-color:transparent}
    #iwb-qa-root[data-theme="night-mist"] .qa-mode-segments .qa-mode-segment:hover,
    #iwb-qa-root[data-theme="night-mist"] .qa-mode-segments .qa-mode-segment:focus-visible{background:#32333E;border-color:#454653}
    #iwb-qa-root[data-theme="night-mist"] .qa-mode-segments .qa-mode-segment.is-active{background:#34313F;border-color:#5D5677;color:var(--qa-accent-strong)!important;box-shadow:0 2px 8px rgba(5,6,10,.24)}
    #iwb-qa-root[data-theme="night-mist"] .qa-mode-segments .qa-title-lock[aria-pressed="true"]{background:var(--qa-accent-soft);border-color:var(--qa-accent-line);color:var(--qa-accent-strong)!important}

    #iwb-qa-root[data-theme="night-mist"] .qa-card,
    #iwb-qa-root[data-theme="night-mist"] .qa-batch-group,
    #iwb-qa-root[data-theme="night-mist"] .qa-batch-subpanel,
    #iwb-qa-root[data-theme="night-mist"] .qa-desktop-task-head,
    #iwb-qa-root[data-theme="night-mist"] .qa-import-workspace:not(.qa-transfer-workspace)>header,
    #iwb-qa-root[data-theme="night-mist"] .qa-import-workspace:not(.qa-transfer-workspace)>.qa-import-body,
    #iwb-qa-root[data-theme="night-mist"] .qa-transfer-workspace>header,
    #iwb-qa-root[data-theme="night-mist"] .qa-transfer-workspace>.qa-import-body,
    #iwb-qa-root[data-theme="night-mist"] .qa-import-workspace>.qa-import-body,
    #iwb-qa-root[data-theme="night-mist"] .qa-arrange-workspace .qa-arrange-row,
    #iwb-qa-root[data-theme="night-mist"] .qa-task-direction,
    #iwb-qa-root[data-theme="night-mist"] .qa-content-paper{background:var(--qa-card-bg)!important;border-color:var(--qa-card-line)!important;color:var(--qa-text)}
    #iwb-qa-root[data-theme="night-mist"] .qa-card.is-selected{background:var(--qa-surface-blue)!important;border-color:var(--qa-selected-line)!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-batch-danger-group{background:var(--qa-danger-soft)!important;border-color:#68424B!important}

    #iwb-qa-root[data-theme="night-mist"] .qa-summary-actions .qa-btn,
    #iwb-qa-root[data-theme="night-mist"] .qa-summary-actions .qa-icon,
    #iwb-qa-root[data-theme="night-mist"] .qa-card-head>.qa-icon,
    #iwb-qa-root[data-theme="night-mist"] .qa-card-head>[data-action="drag"],
    #iwb-qa-root[data-theme="night-mist"] .qa-card-head>[data-action="toggle"],
    #iwb-qa-root[data-theme="night-mist"] .qa-summary-actions .qa-drag,
    #iwb-qa-root[data-theme="night-mist"] .qa-summary-actions .qa-switch,
    #iwb-qa-root[data-theme="night-mist"] .qa-summary-actions .qa-action-icon,
    #iwb-qa-root[data-theme="night-mist"] .qa-card-head .qa-expand,
    #iwb-qa-root[data-theme="night-mist"] .qa-source-preview-arrow{background:var(--qa-surface)!important;border-color:var(--qa-panel-line)!important;color:var(--qa-text)!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-name:hover{background:#343640!important;border-color:var(--qa-accent)!important}

    #iwb-qa-root[data-theme="night-mist"] .qa-check,
    #iwb-qa-root[data-theme="night-mist"] .qa-source-preview-item>.qa-import-item>input[type="checkbox"]{background:#252630!important;border-color:#575865!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-check:checked,
    #iwb-qa-root[data-theme="night-mist"] .qa-source-preview-item>.qa-import-item>input[type="checkbox"]:checked{background:linear-gradient(145deg,#A99DD4,#8176B1)!important;border-color:#A99DD4!important;box-shadow:0 1px 6px rgba(169,157,212,.24)}
    #iwb-qa-root[data-theme="night-mist"] .qa-check:checked:after,
    #iwb-qa-root[data-theme="night-mist"] .qa-source-preview-item>.qa-import-item>input[type="checkbox"]:checked:after{color:#F7F5FB!important}

    #iwb-qa-root[data-theme="night-mist"] .qa-keyword-chip,
    #iwb-qa-root[data-theme="night-mist"] .qa-selection-context,
    #iwb-qa-root[data-theme="night-mist"] .qa-list-context .qa-btn,
    #iwb-qa-root[data-theme="night-mist"] .qa-footer [data-action="batch-panel"]{background:var(--qa-accent-soft)!important;border-color:var(--qa-accent-line)!important;color:var(--qa-accent-strong)!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-mobile-task-head{background:var(--qa-bg);border-color:var(--qa-accent-line);box-shadow:0 3px 11px rgba(5,6,10,.26)}
    #iwb-qa-root[data-theme="night-mist"] .qa-mobile-task-back,
    #iwb-qa-root[data-theme="night-mist"] .qa-desktop-task-back{background:var(--qa-accent-soft)!important;border-color:var(--qa-accent-line)!important;color:var(--qa-accent-strong)!important}

    #iwb-qa-root[data-theme="night-mist"] .qa-guide-dialog,
    #iwb-qa-root[data-theme="night-mist"] .qa-theme-dialog,
    #iwb-qa-root[data-theme="night-mist"] .qa-leave-dialog,
    #iwb-qa-root[data-theme="night-mist"] .qa-discard-confirm-dialog{background:var(--qa-panel-bg);border-color:var(--qa-panel-line);color:var(--qa-text);box-shadow:0 18px 50px rgba(5,6,10,.46)}
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-body,
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-nav{background:var(--qa-bg);color:var(--qa-text)}
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-section,
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-nav-item{background:var(--qa-card-bg);border-color:var(--qa-card-line);color:var(--qa-text);box-shadow:var(--qa-shadow-soft)}
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-nav-item.is-active,
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-quick{background:var(--qa-accent-soft);border-color:var(--qa-accent-line);color:var(--qa-accent-strong)}
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-section li,
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-about{color:var(--qa-muted)}
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-section strong{color:var(--qa-text)}
    #iwb-qa-root[data-theme="night-mist"] .qa-theme-backdrop,
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-backdrop{background:rgba(7,8,12,.68)}
    #iwb-qa-root[data-theme="night-mist"] select{accent-color:var(--qa-accent)}
    /* IWB_V043_NIGHT_MIST_END */

    /* IWB_V043_THEME_SWITCH_END */

    /* IWB_V048_MOBILE_SHELL_BEGIN */
    .qa-mobile-only{display:none}
    @media(max-width:480px){
      .qa-head{display:grid!important;grid-template-columns:minmax(0,2fr) repeat(2,minmax(0,1fr)) minmax(0,1fr);grid-template-rows:auto auto auto auto auto auto;gap:4px 5px!important}
      .qa-title-row{grid-column:1/-1;grid-row:1}
      .qa-title-row .qa-mobile-only{display:grid}
      .qa-mode-segments{display:contents!important}
      .qa-mode-segments>[data-action="mode"]{display:none!important}
      .qa-title-lock{display:block!important;grid-column:4;grid-row:2;width:100%;height:40px;min-height:40px;overflow:hidden;text-overflow:ellipsis}
      .qa-top-grid{display:contents!important}
      .qa-top-grid>.qa-book-picker{grid-column:1/3;grid-row:2;width:100%;height:40px}
      .qa-top-grid>.qa-book-picker .qa-book-picker-trigger{height:40px}
      .qa-top-grid>[data-action="new-entry"],.qa-top-grid>[data-action="toggle-source"]{grid-column:3;grid-row:2;width:100%;height:40px;min-height:40px;padding-inline:4px;white-space:nowrap}
      .qa-filter-pair{display:contents!important}
      .qa-filter-pair>[data-control="state-filter-select"]{display:none!important}
      .qa-filter-pair>[data-control="search"]{display:none;grid-column:1/-1;grid-row:4;width:100%;height:40px;min-height:40px}
      .qa-mobile-search-open .qa-filter-pair>[data-control="search"]{display:block}
      .qa-top-grid>[data-action="other-tools"]{display:none!important}
      .qa-mobile-operation-row{display:grid;grid-column:1/-1;grid-row:3;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}
      .qa-mobile-operation-row .qa-btn{min-width:0;min-height:40px;padding-inline:3px;white-space:nowrap}
      .qa-mobile-operation-row .qa-btn.is-active,.qa-mobile-menu .qa-btn.is-active,.qa-mobile-search-toggle.is-active{border-color:var(--qa-accent-line);background:var(--qa-accent-soft);color:var(--qa-accent-strong)}
      .qa-mobile-menu{display:grid;grid-column:1/-1;grid-row:5;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;padding:5px;border:1px solid var(--qa-line);border-radius:10px;background:var(--qa-panel-bg);box-shadow:var(--qa-shadow-soft)}
      .qa-mobile-menu[hidden]{display:none!important}
      .qa-mobile-menu .qa-btn{min-width:0;min-height:40px;padding-inline:3px;white-space:nowrap}
      .qa-other-tools{grid-column:1/-1;grid-row:5}
      .qa-status{grid-column:1/-1;grid-row:6}
      .qa-import-active .qa-mobile-operation-row,.qa-transfer-active .qa-mobile-operation-row,.qa-arrange-active .qa-mobile-operation-row,.qa-import-active .qa-mobile-menu,.qa-transfer-active .qa-mobile-menu,.qa-arrange-active .qa-mobile-menu{display:none!important}
      .qa-keyboard-open:not(.qa-content-editing) .qa-mobile-operation-row,.qa-keyboard-open:not(.qa-content-editing) .qa-mobile-menu{display:none!important}
    }
    /* IWB_V048_MOBILE_SHELL_END */

    /* IWB_V049_MOBILE_WORKFLOW_BEGIN */
    .qa-count-mobile{display:none}
    @media(max-width:480px){
      .qa-head{grid-template-columns:repeat(4,minmax(0,1fr))!important}
      .qa-top-grid>.qa-book-picker{grid-column:1/3!important}
      .qa-mobile-operation-row{grid-template-columns:repeat(5,minmax(0,1fr))!important}
      .qa-mobile-operation-row .qa-btn{font-size:12px!important}
      .qa-mobile-menu[data-slot="mobile-mode-menu"]{grid-template-columns:repeat(3,minmax(0,1fr))}
      .qa-list-context{display:none!important}
      .qa-other-tools .qa-arrange-quick,.qa-other-tools>[data-action="arrange-settings"]{display:none!important}
      .qa-footer{border-top:2px solid var(--qa-accent-line)!important;background:var(--qa-surface)!important;box-shadow:0 -8px 22px rgba(42,39,65,.13)!important}
      .qa-count-desktop{display:none}.qa-count-mobile{display:inline;font-weight:700;font-variant-numeric:tabular-nums}
      .qa-selection-context{grid-template-columns:repeat(3,minmax(0,1fr))!important}
      .qa-group-edit-actions{grid-template-columns:repeat(2,minmax(0,1fr))!important}
      .qa-entry-group-create-panel{grid-template-columns:minmax(0,1fr) auto;align-items:center;padding:7px}
      .qa-entry-group-create-panel>div{display:grid;grid-template-columns:repeat(2,auto);gap:4px}
      .qa-entry-group-mode{position:sticky;top:0;z-index:5;display:grid;gap:5px;margin-bottom:5px;padding:6px;border:1px solid var(--qa-line);border-radius:10px;background:var(--qa-surface);box-shadow:var(--qa-shadow-soft)}
      .qa-entry-group-mode-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px;align-items:start}
      .qa-entry-group-tabs{display:flex;gap:4px;min-width:0;overflow-x:auto;scrollbar-width:none}
      .qa-entry-group-chip{flex:0 0 auto;max-width:150px;min-height:30px;padding:4px 8px;border:1px solid var(--qa-line);border-radius:999px;background:var(--qa-surface-soft);color:var(--qa-text);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .qa-entry-group-chip small{font-size:9px;opacity:.65}.qa-entry-group-chip.is-active{border-color:var(--qa-accent-line);background:var(--qa-accent-soft);color:var(--qa-accent-strong)}
      .qa-entry-group-mode-head>.qa-btn{min-height:30px;padding:3px 7px;font-size:11px}
      .qa-entry-group-mode-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}.qa-entry-group-mode-actions .qa-btn{min-width:0;min-height:32px;padding:3px 2px;font-size:11px}
      .qa-entry-group-editing{font-size:11px;font-weight:700;color:var(--qa-accent-strong)}
      .qa-group-mode:not(.qa-group-member-editing) .qa-card .qa-check{visibility:hidden;pointer-events:none}
      .qa-group-mode .qa-head>:not(.qa-title-row),.qa-import-active .qa-head>:not(.qa-title-row),.qa-transfer-active .qa-head>:not(.qa-title-row),.qa-arrange-active .qa-head>:not(.qa-title-row){display:none!important}
      .qa-group-mode .qa-mobile-search-toggle,.qa-import-active .qa-mobile-search-toggle,.qa-transfer-active .qa-mobile-search-toggle,.qa-arrange-active .qa-mobile-search-toggle{display:none!important}
      .qa-group-mode .qa-head,.qa-import-active .qa-head,.qa-transfer-active .qa-head,.qa-arrange-active .qa-head{padding-bottom:5px!important}
      .qa-import-active .qa-footer,.qa-transfer-active .qa-footer,.qa-arrange-active .qa-footer{display:none!important}
      .qa-arrange-workspace{padding-bottom:0!important}.qa-arrange-settings-panel{padding-bottom:0!important}.qa-arrange-settings-panel .qa-arrange-note{display:none!important}
      .qa-arrange-settings-panel>.qa-footer-row{position:sticky;bottom:0;z-index:6;display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:5px;padding:7px 0 calc(7px + env(safe-area-inset-bottom));background:var(--qa-bg);box-shadow:0 -7px 18px rgba(42,39,65,.12)}
      .qa-arrange-settings-panel .qa-arrange-reset{display:none!important}
      .qa-batch-group-label small{display:none}
    }
    /* IWB_V049_MOBILE_WORKFLOW_END */

  `;

  const MOBILE_DESIGN_STYLES = "\n/* Mobile design foundation: approved tokens; no business-state changes. */\n@media(max-width:480px){\n#iwb-qa-root[data-theme=\"fog-ink\"]{--iwb-canvas:#E5E9E7;--iwb-shell:#FAFAF7;--iwb-workbench:#F1F4F2;--iwb-card:#FFFDFC;--iwb-control:#FCFCFA;--iwb-editor:#FFFFFF;--iwb-text:#2B3133;--iwb-text-secondary:#616C6D;--iwb-muted:#929B99;--iwb-accent:#5F7D87;--iwb-accent-2:#9A747B;--iwb-secondary:#8C7967;--iwb-selected:#EAF1F5;--iwb-selected-border:#9FB7C4;--iwb-selected-decoration:#7898A8;--iwb-checkbox-selected:#688696}\n#iwb-qa-root[data-theme=\"wisteria-moon\"]{--iwb-canvas:#EAE5E3;--iwb-shell:#FBF8F6;--iwb-workbench:#F6F1EF;--iwb-card:#FFFDFC;--iwb-control:#FCFAF8;--iwb-editor:#FFFFFF;--iwb-text:#302C31;--iwb-text-secondary:#6C646B;--iwb-muted:#9E969C;--iwb-accent:#9B6F82;--iwb-accent-2:#756A91;--iwb-secondary:#6E8987;--iwb-selected:#EEF3F5;--iwb-selected-border:#AABBC6;--iwb-selected-decoration:#8EA2B1;--iwb-checkbox-selected:#7B8FA2}\n#iwb-qa-root[data-theme=\"night-mist\"]{--iwb-canvas:#242228;--iwb-shell:#2C2930;--iwb-workbench:#302D34;--iwb-card:#343138;--iwb-control:#36333A;--iwb-editor:#39363D;--iwb-text:#E3DDE2;--iwb-text-secondary:#BBB3B9;--iwb-muted:#918990;--iwb-accent:#B08EA2;--iwb-accent-2:#9488B0;--iwb-secondary:#7FA19F;--iwb-selected:#39434C;--iwb-selected-border:#6D8794;--iwb-selected-decoration:#8497A7;--iwb-checkbox-selected:#7D6A8C}\n#iwb-qa-root[data-theme]{\n  --qa-bg:var(--iwb-shell);--qa-card-bg:var(--iwb-card);--qa-edit-bg:var(--iwb-control);\n  --qa-panel-bg:var(--iwb-workbench);--qa-text:var(--iwb-text);--qa-muted:var(--iwb-text-secondary);\n  --qa-accent:var(--iwb-accent);--qa-selected-line:var(--iwb-selected-border);\n  --qa-card-line:color-mix(in srgb,var(--iwb-text) 16%,var(--iwb-card));\n  --qa-line:color-mix(in srgb,var(--iwb-text) 12%,var(--iwb-shell));\n  color:var(--iwb-text);font-size:14px;font-weight:400;\n}\n#iwb-qa-root[data-theme] .qa-shell{background:var(--iwb-shell);border-radius:14px;box-shadow:none}\n#iwb-qa-root[data-theme] .qa-head,\n#iwb-qa-root[data-theme] .qa-footer,\n#iwb-qa-root[data-theme] .qa-workspace-panel{background:var(--iwb-workbench);box-shadow:none}\n#iwb-qa-root[data-theme] .qa-title h2{font-size:18px;font-weight:600}\n#iwb-qa-root[data-theme] .qa-btn{font-size:13px;font-weight:400;border-radius:4px;box-shadow:none}\n#iwb-qa-root[data-theme] input,\n#iwb-qa-root[data-theme] select,\n#iwb-qa-root[data-theme] textarea{border-radius:4px;background:var(--iwb-control);box-shadow:none;font-weight:400}\n#iwb-qa-root[data-theme] .qa-content-textarea{background:var(--iwb-editor)}\n}\n";

  const MOBILE_CARD_STYLES = "\n@media(max-width:480px){\n#iwb-qa-root[data-theme=\"fog-ink\"]{--iwb-success:#6D8A72;--iwb-danger:#A45F67;--iwb-changed:#BD8D50;--iwb-lamp-blue:#668DAC;--iwb-lamp-green:#789967}\n#iwb-qa-root[data-theme=\"wisteria-moon\"]{--iwb-success:#6E8B74;--iwb-danger:#A55F69;--iwb-changed:#C29555;--iwb-lamp-blue:#6189A8;--iwb-lamp-green:#7B9B68}\n#iwb-qa-root[data-theme=\"night-mist\"]{--iwb-success:#7EA087;--iwb-danger:#CF8792;--iwb-changed:#C8A05D;--iwb-lamp-blue:#82A8C3;--iwb-lamp-green:#8CAA77}\n#iwb-qa-root[data-theme] .qa-mobile-card{position:relative;overflow:hidden;padding:0!important;border:1px solid var(--qa-card-line)!important;border-radius:6px!important;background:var(--iwb-card)!important;box-shadow:none!important}\n#iwb-qa-root[data-theme] .qa-mobile-card.is-entry-dragging{outline:2px solid var(--iwb-accent);outline-offset:-2px;background:var(--iwb-selected)!important;border-color:var(--iwb-accent)!important;transform:scale(.985);transition:transform .12s ease}\n#iwb-qa-root[data-theme] .qa-mobile-card.is-entry-move-feedback{animation:iwb-phone-move .72s ease;background:var(--iwb-selected)!important;border-color:var(--iwb-accent)!important;box-shadow:inset 0 0 0 1px var(--iwb-accent)!important}\n#iwb-qa-root[data-theme] .qa-mobile-card.drop-before{box-shadow:inset 0 3px 0 var(--iwb-accent)!important}\n#iwb-qa-root[data-theme] .qa-mobile-card.drop-after{box-shadow:inset 0 -3px 0 var(--iwb-accent)!important}\n#iwb-qa-root[data-theme] .qa-mobile-card.drop-before:before,#iwb-qa-root[data-theme] .qa-mobile-card.drop-after:before{content:\"\";position:absolute;left:7px;right:auto;top:9px;bottom:9px;height:auto;width:2px;box-shadow:none;background:linear-gradient(to bottom,transparent,var(--iwb-accent) 30%,var(--iwb-accent-2) 70%,transparent)}\n#iwb-qa-root[data-theme] .qa-mobile-card.drop-after:after{left:5px;right:auto;top:19px;bottom:auto;width:6px;height:6px;border-radius:0;box-shadow:none;background:linear-gradient(135deg,var(--iwb-accent),var(--iwb-accent-2))}\n@keyframes iwb-phone-move{0%{transform:translateY(4px)}55%{transform:translateY(-1px)}100%{transform:translateY(0)}}\n#iwb-qa-root[data-theme] .qa-mobile-card.is-selected{background:var(--iwb-selected)!important;border-color:var(--iwb-selected-border)!important}\n#iwb-qa-root[data-theme] .qa-mobile-card:before{content:\"\";position:absolute;left:7px;top:9px;bottom:9px;width:2px;background:linear-gradient(to bottom,transparent,var(--iwb-accent) 30%,var(--iwb-accent-2) 70%,transparent);pointer-events:none}\n#iwb-qa-root[data-theme] .qa-mobile-card:after{content:\"\";position:absolute;left:5px;top:19px;width:6px;height:6px;transform:rotate(45deg);background:linear-gradient(135deg,var(--iwb-accent),var(--iwb-accent-2));pointer-events:none}\n#iwb-qa-root[data-theme] .qa-mobile-card.is-selected:before{background:linear-gradient(to bottom,transparent,var(--iwb-selected-decoration) 30%,var(--iwb-accent-2) 70%,transparent)}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-card-main{display:block!important;min-width:0;padding:0!important}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-card-head{display:grid!important;grid-template-columns:20px minmax(0,1fr) 32px 32px!important;gap:7px!important;min-height:55px;padding:7px 7px 7px 16px!important}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-name-cell{min-width:0}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-name{display:block;width:100%;min-width:0;height:auto;min-height:0;padding:0!important;border:0!important;border-radius:0;background:transparent!important;color:var(--iwb-text)!important;font-size:15px!important;font-weight:600!important;line-height:1.35;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:none!important}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-name-meta{font-size:11px!important;font-weight:400!important;color:var(--iwb-muted)!important;line-height:1.35;margin-top:2px}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-name-meta b{font-weight:400!important}\n#iwb-qa-root[data-theme] .qa-mobile-card.is-changed .qa-name-meta:after{content:\"\";display:inline-block;width:5px;height:5px;background:var(--iwb-changed);border-radius:50%;margin-left:5px}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-check{appearance:none!important;-webkit-appearance:none!important;position:relative;width:18px!important;height:18px!important;min-width:18px;margin:0!important;border:1px solid var(--qa-card-line)!important;border-radius:3px!important;background:var(--iwb-card)!important;box-shadow:none!important}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-check:checked{background:var(--iwb-checkbox-selected)!important;border-color:var(--iwb-checkbox-selected)!important}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-check:checked:after{content:\"\";position:absolute;left:5px;top:2px;width:5px;height:9px;border:solid white;border-width:0 2px 2px 0;transform:rotate(45deg)}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-drag,#iwb-qa-root[data-theme] .qa-mobile-card .qa-expand{width:32px!important;height:32px!important;min-width:0;min-height:0;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;color:var(--iwb-text-secondary)!important;box-shadow:none!important}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-inline-fields{display:grid!important;grid-column:auto!important;gap:6px!important;padding:8px 7px 9px 16px!important;border-top:1px solid var(--qa-line)}\n#iwb-qa-root[data-theme] .qa-mobile-detail-row{display:grid;grid-template-columns:minmax(0,1fr) 48px 36px 36px;gap:10px;align-items:end;justify-content:stretch}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-inline-field{display:grid!important;grid-template-columns:minmax(0,1fr)!important;gap:2px!important;min-width:0}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-inline-field>span{font-size:10px!important;font-weight:400!important;line-height:1.2;color:var(--iwb-muted)!important}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-inline-field input,#iwb-qa-root[data-theme] .qa-mobile-card .qa-inline-field select{width:100%!important;min-width:0!important;height:30px!important;min-height:0!important;padding:0 7px!important;font-size:14px!important;font-weight:400!important;border:1px solid var(--qa-line)!important;border-radius:4px!important;background:var(--iwb-control)!important;color:var(--iwb-text)!important;box-shadow:none!important}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-inline-field input{text-align:center;padding-inline:3px!important}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-action-icon,#iwb-qa-root[data-theme] .qa-mobile-card .qa-switch{position:relative;display:grid;place-items:center;width:36px!important;height:32px!important;min-height:0;min-width:0;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;color:var(--iwb-text-secondary)!important;font-size:15px!important;box-shadow:none!important}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-switch:before{content:\"\";position:static;width:30px;height:17px;border-radius:20px;background:color-mix(in srgb,var(--iwb-muted) 42%,var(--iwb-control))}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-switch:after{content:\"\";position:absolute;left:9px;top:10px;width:11px;height:11px;border-radius:50%;background:white;box-shadow:none;transform:none}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-switch[aria-checked=\"true\"]:before{background:var(--iwb-success)}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-switch[aria-checked=\"true\"]:after{left:21px;transform:none}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-lamp.blue,#iwb-qa-root[data-theme] .qa-mobile-card .qa-lamp.green{font-size:0!important}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-lamp.blue:before,#iwb-qa-root[data-theme] .qa-mobile-card .qa-lamp.green:before{content:\"\";width:15px;height:15px;border-radius:50%;background:var(--iwb-lamp-blue)}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-lamp.green:before{background:var(--iwb-lamp-green)}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-delete:hover{color:var(--iwb-danger)!important}\n#iwb-qa-root[data-theme] .qa-mobile-compact-actions{display:flex;align-items:center;gap:4px;min-height:40px;padding:2px 7px 3px 16px;border-top:1px solid var(--qa-line)}\n#iwb-qa-root[data-theme] .qa-mobile-compact-actions>.qa-action-icon[data-action=\"duplicate\"]{margin-left:auto}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-editor{display:block!important;margin:0!important;padding:10px 7px 12px 16px!important;background:transparent!important;border:0!important;border-top:1px solid var(--qa-line)!important;box-shadow:none!important}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-field>span,#iwb-qa-root[data-theme] .qa-mobile-card .qa-content-label>span{font-size:10px!important;font-weight:400!important;color:var(--iwb-muted)!important}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-content-inline{display:block;width:100%;min-height:108px;resize:vertical;padding:9px 10px!important;border:1px solid var(--qa-line)!important;background:var(--iwb-editor)!important;color:var(--iwb-text)!important;font-size:14px!important;line-height:1.6!important}\n#iwb-qa-root[data-theme] .qa-mobile-card .qa-keyword-chip{border-radius:3px!important;font-size:12px!important;font-weight:400!important;box-shadow:none!important}\n#iwb-qa-root[data-theme] .qa-mobile-density-toggle{display:flex;gap:5px;align-items:center;justify-content:flex-end;padding:3px 12px;border-top:1px solid var(--qa-line);font-size:12px}\n#iwb-qa-root[data-theme] .qa-mobile-density-toggle button{min-height:32px;padding:0 3px;border:0;background:transparent;color:var(--iwb-muted);font-size:12px;box-shadow:none}\n#iwb-qa-root[data-theme] .qa-mobile-density-toggle button.is-active{color:var(--iwb-accent);text-decoration:underline;text-underline-offset:5px}\n}\n@media(max-width:350px){#iwb-qa-root[data-theme] .qa-mobile-detail-row{grid-template-columns:minmax(0,1fr) 44px 32px 32px;gap:6px}#iwb-qa-root[data-theme] .qa-mobile-card .qa-action-icon,#iwb-qa-root[data-theme] .qa-mobile-card .qa-switch{width:32px!important}}\n";

  const MOBILE_WORKBENCH_STYLES = "\n@media(max-width:480px){\n#iwb-qa-root[data-theme] .qa-shell{position:relative;display:flex!important;flex-direction:column!important;gap:0!important;border-radius:14px 14px 0 0!important}\n#iwb-qa-root[data-theme] .qa-head{display:block!important;grid-template-columns:none!important;grid-template-rows:none!important;grid-area:auto!important;gap:0!important;order:0;flex:none;padding:0!important;border-bottom:1px solid var(--qa-line)!important;background:var(--iwb-workbench)!important}\n#iwb-qa-root[data-theme] .qa-head>*{grid-column:auto!important;grid-row:auto!important;grid-area:auto!important}\n#iwb-qa-root[data-theme] .qa-title-row{display:flex!important;flex-wrap:nowrap!important;min-width:0;min-height:54px!important;padding:0 14px 0 16px!important;gap:1px!important}\n#iwb-qa-root[data-theme] .qa-title{margin-right:auto;min-width:0;flex:1}\n#iwb-qa-root[data-theme] .qa-title h2{white-space:nowrap}\n#iwb-qa-root[data-theme] .qa-title h2{font-size:18px!important;font-weight:600!important}\n#iwb-qa-root[data-theme] .qa-title-row>.qa-icon{width:34px!important;height:38px!important;min-height:0!important;min-width:0!important;border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important;color:var(--iwb-text-secondary)!important}\n#iwb-qa-root[data-theme] .qa-mode-segments{display:none!important}\n#iwb-qa-root[data-theme] .qa-top-grid{display:grid!important;grid-template-areas:none!important;grid-template-rows:auto!important;grid-template-columns:minmax(0,1fr) auto 34px!important;gap:5px!important;padding:0 14px 4px 16px!important;align-items:center;min-height:45px!important}\n#iwb-qa-root[data-theme] .qa-top-grid>.qa-book-picker{display:block!important;grid-area:auto!important;grid-column:1!important;grid-row:1!important;min-width:0!important;width:100%!important;max-width:100%!important;height:auto!important}\n#iwb-qa-root[data-theme] .qa-book-picker-trigger{display:flex!important;flex-wrap:nowrap!important;width:100%!important;min-width:0!important;overflow:hidden;min-height:38px!important;height:auto!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;color:var(--iwb-text)!important;font-size:15px!important;font-weight:600!important;box-shadow:none!important}\n#iwb-qa-root[data-theme] .qa-top-grid>[data-action=\"new-entry\"],#iwb-qa-root[data-theme] .qa-top-grid>[data-action=\"toggle-source\"]{grid-column:2!important;grid-row:1!important;width:auto!important;min-height:38px!important;padding:0 7px!important;border:0!important;background:transparent!important;color:var(--iwb-accent)!important;box-shadow:none!important;font-size:13px!important;white-space:nowrap}\n#iwb-qa-root[data-theme] .qa-top-grid>.qa-mobile-title-lock{grid-column:3!important;grid-row:1!important;width:34px!important;height:34px!important;min-width:0!important;min-height:0!important;padding:0!important;border:0!important;background:transparent!important;color:var(--iwb-muted)!important;box-shadow:none!important;font-size:15px!important}\n#iwb-qa-root[data-theme] .qa-top-grid>.qa-filter-pair{display:none!important}\n#iwb-qa-root[data-theme].qa-mobile-search-open .qa-top-grid>.qa-filter-pair{display:block!important;grid-column:1/-1!important;grid-row:2!important;padding:5px 0!important}\n#iwb-qa-root[data-theme] .qa-filter-pair>[data-control=\"search\"]{width:100%;min-height:38px!important;font-size:14px!important;border:1px solid var(--qa-line)!important;background:var(--iwb-control)!important}\n#iwb-qa-root[data-theme] .qa-filter-pair>select,#iwb-qa-root[data-theme] .qa-top-grid>[data-action=\"other-tools\"],#iwb-qa-root[data-theme] .qa-status,#iwb-qa-root[data-theme] .qa-list-context{display:none!important}\n#iwb-qa-root[data-theme] .qa-book-picker-trigger>span{display:block!important;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n#iwb-qa-root[data-theme] .qa-book-picker-trigger>i{flex:none;width:14px}\n#iwb-qa-root[data-theme] .qa-mobile-operation-row{display:flex!important;align-items:center;gap:12px!important;padding:0 16px!important;min-height:43px!important;border-top:1px solid var(--qa-line)!important;flex-wrap:nowrap!important}\n#iwb-qa-root[data-theme] .qa-mobile-operation-row>.qa-btn{min-height:40px!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;color:var(--iwb-text-secondary)!important;box-shadow:none!important;font-size:13px!important;font-weight:400!important;white-space:nowrap}\n#iwb-qa-root[data-theme] .qa-mobile-operation-row>.qa-quick-combo{min-height:30px!important;padding:0 8px!important;border:1px solid color-mix(in srgb,var(--iwb-secondary) 42%,var(--qa-line))!important;border-radius:4px!important;color:var(--iwb-secondary)!important;background:color-mix(in srgb,var(--iwb-secondary) 7%,var(--iwb-workbench))!important}\n#iwb-qa-root[data-theme] .qa-mobile-density-toggle{margin-left:auto!important;display:flex!important;gap:5px!important;min-width:0;padding:0!important;border:0!important;white-space:nowrap}\n#iwb-qa-root[data-theme] .qa-mobile-density-toggle button{min-height:40px!important;font-size:12px!important}\n#iwb-qa-root[data-theme] .qa-mobile-menu,#iwb-qa-root[data-theme] .qa-other-tools{grid-template-columns:none!important;grid-template-rows:none!important;grid-area:auto!important;border:0!important;border-radius:0!important;margin:0!important;padding:0 16px!important;gap:0!important;border-top:1px solid var(--qa-line)!important;background:var(--iwb-workbench)!important;box-shadow:none!important}\n#iwb-qa-root[data-theme] .qa-mobile-menu .qa-btn,#iwb-qa-root[data-theme] .qa-other-tools .qa-btn{min-height:43px!important;padding:0!important;border:0!important;border-radius:0!important;box-shadow:none!important;background:transparent!important;text-align:left!important;font-size:13px!important;font-weight:400!important}\n#iwb-qa-root[data-theme] .qa-mobile-menu[data-slot=\"mobile-filter-menu\"]{display:flex!important;align-items:center!important;gap:20px!important;flex-wrap:nowrap!important}\n#iwb-qa-root[data-theme] .qa-mobile-menu[data-slot=\"mobile-arrange-menu\"]{display:flex!important;flex-direction:column!important;align-items:stretch!important}\n#iwb-qa-root[data-theme] .qa-mobile-menu[data-slot=\"mobile-arrange-menu\"]>.qa-btn{width:100%!important;text-align:left!important}\n#iwb-qa-root[data-theme] .qa-mobile-operation-row>.qa-btn.is-active,#iwb-qa-root[data-theme] .qa-mobile-menu .qa-btn.is-active{color:var(--iwb-accent)!important;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:7px}\n#iwb-qa-root[data-theme] .qa-other-tools{display:flex!important;flex-direction:column}\n#iwb-qa-root[data-theme] .qa-other-tools[hidden],#iwb-qa-root[data-theme] .qa-mobile-menu[hidden],#iwb-qa-root[data-theme] .qa-workspace-panel[hidden]{display:none!important}\n#iwb-qa-root[data-theme] .qa-mobile-arrange-selection{display:flex;align-items:center;gap:14px;min-height:44px;font-size:13px;color:var(--iwb-text-secondary)}\n#iwb-qa-root[data-theme] .qa-mobile-arrange-selection>span{margin-right:auto}\n#iwb-qa-root[data-theme] .qa-other-tools>.qa-arrange-quick,#iwb-qa-root[data-theme] .qa-other-tools>[data-action=\"arrange-settings\"]{display:none!important}\n#iwb-qa-root[data-theme] .qa-scroll{order:1;flex:1 1 0!important;min-height:0!important;padding:10px!important;overflow-y:auto!important}\n#iwb-qa-root[data-theme] .qa-list{gap:9px!important}\n#iwb-qa-root[data-theme] .qa-workspace-panel:not(.qa-group-name-dialog){order:2;position:static!important;flex:none!important;width:auto!important;max-height:40dvh!important;overflow:auto!important;margin:0!important;padding:0!important;background:var(--iwb-workbench)!important;border:0!important;border-top:1px solid var(--qa-line)!important;border-radius:0!important;box-shadow:none!important;transform:none!important}\n#iwb-qa-root[data-theme] .qa-workspace-panel .qa-panel{margin:0!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important}\n#iwb-qa-root[data-theme] .qa-mobile-batch-head{display:flex;align-items:center;min-height:38px;padding:0 16px;font-size:13px;font-weight:600}\n#iwb-qa-root[data-theme] .qa-mobile-batch-head>.qa-btn{margin-left:auto;border:0!important;background:transparent!important;padding:0!important;min-height:32px!important}\n#iwb-qa-root[data-theme] .qa-mobile-batch-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid var(--qa-line)}\n#iwb-qa-root[data-theme] .qa-mobile-batch-grid>.qa-btn,#iwb-qa-root[data-theme] .qa-mobile-batch-grid>.qa-batch-flower{min-height:43px!important;border:0!important;border-right:1px solid var(--qa-line)!important;border-bottom:1px solid var(--qa-line)!important;border-radius:0!important;background:transparent!important;padding:0!important;font-size:13px!important;font-weight:400!important;box-shadow:none!important}\n#iwb-qa-root[data-theme] .qa-mobile-batch-grid>:nth-child(3n){border-right:0!important}\n#iwb-qa-root[data-theme] .qa-batch-flower{display:grid;place-items:center;color:var(--iwb-accent-2)}\n#iwb-qa-root[data-theme] .qa-footer{order:3;flex:none!important;position:static!important;padding:0!important;border-top:1px solid var(--qa-line)!important;border-radius:0!important;background:var(--iwb-workbench)!important;box-shadow:none!important;display:block!important}\n#iwb-qa-root[data-theme] .qa-selection-strip{min-height:48px;display:flex;align-items:center;gap:3px;padding:0 10px 0 12px;border-bottom:1px solid var(--qa-line);font-size:13px}\n#iwb-qa-root[data-theme] .qa-selection-strip>span{margin-right:auto;font-weight:600;white-space:nowrap;font-size:13px}\n#iwb-qa-root[data-theme] .qa-selection-strip .qa-btn[data-action]{min-height:44px!important;min-width:34px!important;padding:0 5px!important}\n#iwb-qa-root[data-theme] .qa-group-name-dialog{box-sizing:border-box!important;position:absolute!important;inset:0!important;z-index:10050!important;display:flex!important;align-items:center!important;justify-content:center!important;max-height:none!important;padding:20px!important;background:color-mix(in srgb,var(--iwb-text) 26%,transparent)!important;overflow:auto!important}\n#iwb-qa-root[data-theme] .qa-group-name-dialog .qa-entry-group-create-panel{display:block!important;box-sizing:border-box!important;width:100%;max-width:340px;margin:0!important;padding:18px!important;border:1px solid var(--qa-line)!important;border-radius:6px!important;background:var(--iwb-workbench)!important}\n#iwb-qa-root[data-theme] .qa-group-name-dialog .qa-input{width:100%;min-width:0;height:42px;font-size:14px;background:var(--iwb-control)}\n#iwb-qa-root[data-theme] .qa-group-name-dialog .qa-entry-group-create-panel>div{display:flex;justify-content:flex-end;gap:18px;margin-top:15px}\n#iwb-qa-root[data-theme] .qa-group-name-dialog .qa-btn{min-height:44px;padding:0 10px}\n#iwb-qa-root[data-theme] .qa-selection-strip .qa-btn,#iwb-qa-root[data-theme] .qa-mobile-safety .qa-btn{width:auto!important;min-width:0!important;min-height:32px!important;margin:0!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;color:var(--iwb-accent)!important;box-shadow:none!important;font-size:13px!important;font-weight:400!important;white-space:nowrap}\n#iwb-qa-root[data-theme] .qa-selection-strip .qa-btn:disabled{color:var(--iwb-muted)!important;opacity:.48}\n#iwb-qa-root[data-theme] .qa-mobile-safety{display:flex;align-items:center;gap:13px;min-height:28px;padding:0 14px max(0px,env(safe-area-inset-bottom)) 16px}\n#iwb-qa-root[data-theme] .qa-mobile-safety.is-dirty{min-height:51px}\n#iwb-qa-root[data-theme] .qa-mobile-safety>span{margin-right:auto;color:var(--iwb-muted);font-size:12px}\n#iwb-qa-root[data-theme] .qa-mobile-safety.is-dirty>span{color:var(--iwb-accent)}\n#iwb-qa-root[data-theme] .qa-mobile-safety>.danger{color:var(--iwb-danger)!important}\n#iwb-qa-root[data-theme] .qa-workspace-panel .qa-batch-subpanel{padding:8px 16px!important}\n#iwb-qa-root[data-theme].qa-import-active .qa-top-grid,#iwb-qa-root[data-theme].qa-transfer-active .qa-top-grid,#iwb-qa-root[data-theme].qa-arrange-active .qa-top-grid,#iwb-qa-root[data-theme].qa-import-active .qa-mobile-operation-row,#iwb-qa-root[data-theme].qa-transfer-active .qa-mobile-operation-row,#iwb-qa-root[data-theme].qa-arrange-active .qa-mobile-operation-row{display:none!important}\n#iwb-qa-root[data-theme].qa-import-active .qa-footer,#iwb-qa-root[data-theme].qa-transfer-active .qa-footer,#iwb-qa-root[data-theme].qa-arrange-active .qa-footer{display:none!important}\n#iwb-qa-root[data-theme] .qa-title-row .is-active{color:var(--iwb-accent)!important}\n}\n@media(max-width:350px){#iwb-qa-root[data-theme] .qa-mobile-operation-row{gap:9px!important;padding-inline:12px!important}#iwb-qa-root[data-theme] .qa-mobile-operation-row>.qa-quick-combo{padding-inline:5px!important}#iwb-qa-root[data-theme] .qa-selection-strip{gap:9px!important;padding-inline:12px!important;font-size:12px!important}#iwb-qa-root[data-theme] .qa-selection-strip .qa-btn{font-size:12px!important}}\n";

  const COMBO_WORKSPACE_STYLES = "\n#iwb-qa-root .qa-combo-head{display:none}\n#iwb-qa-root.qa-combo-workspace .qa-head>:not(.qa-combo-head){display:none!important}\n#iwb-qa-root.qa-combo-workspace .qa-combo-head{display:block!important;background:var(--iwb-workbench,var(--qa-panel-bg))}\n#iwb-qa-root .qa-combo-titlebar{display:flex;align-items:center;gap:5px;min-height:54px;padding:0 12px}\n#iwb-qa-root .qa-combo-titlebar h2{font-size:18px;font-weight:600;margin:0 auto 0 0;white-space:nowrap}\n#iwb-qa-root .qa-combo-titlebar button{min-height:36px;min-width:32px;border:0;background:transparent;font-size:13px;padding:0 3px;box-shadow:none}\n#iwb-qa-root .qa-combo-book{font-size:11px;padding:0 16px 8px;color:var(--iwb-muted,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n#iwb-qa-root .qa-combo-tabs{display:flex;gap:17px;overflow-x:auto;white-space:nowrap;scrollbar-width:none;padding:0 16px;border-top:1px solid var(--qa-line);border-bottom:1px solid var(--qa-line)}\n#iwb-qa-root .qa-combo-tab{flex:none;min-height:42px;padding:0;border:0;background:transparent;box-shadow:none;font-size:13px;color:var(--iwb-text-secondary,inherit)}\n#iwb-qa-root .qa-combo-tab[aria-current=\"true\"]{color:var(--iwb-accent,inherit);font-weight:600;border-bottom:2px solid var(--iwb-accent,var(--qa-selected-line))}\n#iwb-qa-root .qa-combo-controls{display:flex;align-items:center;gap:13px;padding:8px 16px;flex-wrap:wrap;font-size:12px}\n#iwb-qa-root .qa-combo-controls>span:first-child{margin-right:auto;font-size:13px;min-width:0;overflow-wrap:anywhere}\n#iwb-qa-root .qa-combo-controls button,#iwb-qa-root .qa-combo-more button{border:0;background:transparent;box-shadow:none;min-height:30px;padding:0;font-size:13px;color:var(--iwb-accent,inherit)}\n#iwb-qa-root .qa-combo-more{display:flex;gap:18px;padding:0 16px 8px;border-bottom:1px solid var(--qa-line)}\n#iwb-qa-root .qa-combo-more[hidden]{display:none!important}\n#iwb-qa-root .qa-combo-context{display:grid;gap:7px;border-top:1px solid var(--qa-line);padding:8px 0;font-size:11px}\n#iwb-qa-root .qa-combo-context-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-height:26px}\n#iwb-qa-root .qa-combo-context-row>span:first-child{color:var(--iwb-muted,inherit);font-size:10px;min-width:42px}\n#iwb-qa-root .qa-combo-chip{padding:3px 6px;border:1px solid var(--qa-line);border-radius:3px;color:var(--iwb-text-secondary,inherit);background:var(--iwb-workbench,var(--qa-panel-bg))}\n#iwb-qa-root .qa-combo-chip.current{color:var(--iwb-accent,inherit)}\n#iwb-qa-root .qa-combo-context button{border:0;background:transparent;min-height:30px;padding:0 5px;font-size:12px;color:var(--iwb-accent,inherit);box-shadow:none}\n#iwb-qa-root .qa-combo-assignment{display:grid;gap:6px}\n#iwb-qa-root .qa-combo-assignment-row{display:flex;gap:10px;align-items:center;width:100%;padding:7px 0;border:0;border-bottom:1px solid var(--qa-line);background:transparent;text-align:left;font-size:13px;min-height:40px}\n#iwb-qa-root .qa-combo-assignment-row>span:first-child{font-size:15px;min-width:18px;color:var(--iwb-accent,inherit)}\n@media(max-width:350px){#iwb-qa-root .qa-combo-titlebar{gap:3px;padding-inline:9px}#iwb-qa-root .qa-combo-titlebar h2{font-size:17px}#iwb-qa-root .qa-combo-titlebar button{min-width:28px;font-size:12px}}\n\n@media(max-width:480px){\n#iwb-qa-root[data-theme] .qa-combo-head,#iwb-qa-root[data-theme] .qa-search-head{width:100%!important;min-width:0!important;max-width:none!important;grid-column:1/-1!important}\n#iwb-qa-root[data-theme] .qa-combo-titlebar,#iwb-qa-root[data-theme] .qa-search-titlebar{display:flex!important;flex-wrap:nowrap!important;width:100%;min-width:0;gap:6px;padding:8px 12px}\n#iwb-qa-root[data-theme] .qa-combo-titlebar h2,#iwb-qa-root[data-theme] .qa-search-titlebar h2{white-space:nowrap;flex:1;min-width:0;font-size:18px;font-weight:600}\n#iwb-qa-root[data-theme] .qa-combo-titlebar button,#iwb-qa-root[data-theme] .qa-search-titlebar button{flex:none;min-height:36px;width:auto!important;padding:0 5px;font-size:12px}\n#iwb-qa-root[data-theme] .qa-combo-controls{display:grid!important;grid-template-columns:minmax(0,1fr) auto auto auto!important;gap:8px!important;align-items:center}\n#iwb-qa-root[data-theme] .qa-combo-controls>span:first-child{grid-column:1/-1;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n#iwb-qa-root[data-theme] .qa-combo-controls button{width:auto!important;min-width:0!important;min-height:40px;font-size:12px;padding:0 3px!important;white-space:nowrap}\n#iwb-qa-root[data-theme] .qa-search-modes{display:flex!important}\n#iwb-qa-root[data-theme] .qa-search-replace{display:flex!important;min-width:0}\n#iwb-qa-root[data-theme] .qa-search-replace input{min-width:0;flex:1}\n#iwb-qa-root[data-theme] .qa-search-replace button{flex:none;width:auto!important;font-size:12px;white-space:nowrap}\n}\n";

  const BODY_SEARCH_STYLES = "\n#iwb-qa-root .qa-search-head{display:none}\n#iwb-qa-root.qa-search-workspace .qa-head>:not(.qa-search-head){display:none!important}\n#iwb-qa-root.qa-search-workspace .qa-search-head{display:block!important;background:var(--iwb-workbench,var(--qa-panel-bg))}\n#iwb-qa-root .qa-search-titlebar{display:flex;align-items:center;padding:8px 12px;gap:7px;min-height:46px}\n#iwb-qa-root .qa-search-titlebar h2{font-size:18px;font-weight:600;margin:0 auto 0 0}\n#iwb-qa-root .qa-search-titlebar button{border:0;background:transparent;box-shadow:none;min-width:30px;min-height:34px}\n#iwb-qa-root .qa-search-book{font-size:11px;color:var(--iwb-muted,inherit);padding:0 16px 9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n#iwb-qa-root .qa-search-modes{display:flex;gap:23px;padding:0 16px;border-bottom:1px solid var(--qa-line)}\n#iwb-qa-root .qa-search-modes button{font-size:13px;border:0;background:transparent;min-height:36px;padding:0;box-shadow:none}\n#iwb-qa-root .qa-search-modes button[aria-current=\"true\"]{color:var(--iwb-accent,var(--qa-accent-strong));border-bottom:2px solid currentColor}\n#iwb-qa-root .qa-search-inputs{display:grid;gap:8px;padding:10px 16px 12px}\n#iwb-qa-root .qa-search-inputs input{width:100%;min-width:0;font-size:14px;min-height:36px;background:var(--iwb-control,var(--qa-field-bg))}\n#iwb-qa-root .qa-search-replace{display:flex;gap:8px;align-items:center}\n#iwb-qa-root .qa-search-replace button{flex:none;font-size:12px;min-height:36px;padding:0 8px;white-space:nowrap}\n#iwb-qa-root .qa-search-summary{font-size:11px;color:var(--iwb-muted,inherit);padding:4px 0 10px}\n#iwb-qa-root .qa-search-result{padding:13px 0;border-top:1px solid var(--qa-line);background:transparent}\n#iwb-qa-root .qa-search-result header{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;font-size:14px}\n#iwb-qa-root .qa-search-result small{font-size:11px;color:var(--iwb-muted,inherit);margin-left:auto}\n#iwb-qa-root .qa-search-result p{font-size:13px;line-height:1.7;margin:7px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--iwb-text-secondary,inherit)}\n#iwb-qa-root.qa-search-workspace .qa-workspace-panel{display:none!important}\n@media(min-width:481px){#iwb-qa-root.qa-search-workspace .qa-search-inputs{max-width:720px}#iwb-qa-root.qa-search-workspace .qa-mobile-safety{display:flex;align-items:center;justify-content:flex-end;gap:12px;min-height:28px}#iwb-qa-root.qa-search-workspace .qa-mobile-safety.is-dirty{min-height:51px}#iwb-qa-root.qa-search-workspace .qa-mobile-safety span{margin-right:auto}}\n\n@media(max-width:480px){\n#iwb-qa-root[data-theme] .qa-combo-head,#iwb-qa-root[data-theme] .qa-search-head{width:100%!important;min-width:0!important;max-width:none!important;grid-column:1/-1!important}\n#iwb-qa-root[data-theme] .qa-combo-titlebar,#iwb-qa-root[data-theme] .qa-search-titlebar{display:flex!important;flex-wrap:nowrap!important;width:100%;min-width:0;gap:6px;padding:8px 12px}\n#iwb-qa-root[data-theme] .qa-combo-titlebar h2,#iwb-qa-root[data-theme] .qa-search-titlebar h2{white-space:nowrap;flex:1;min-width:0;font-size:18px;font-weight:600}\n#iwb-qa-root[data-theme] .qa-combo-titlebar button,#iwb-qa-root[data-theme] .qa-search-titlebar button{flex:none;min-height:36px;width:auto!important;padding:0 5px;font-size:12px}\n#iwb-qa-root[data-theme] .qa-combo-controls{display:grid!important;grid-template-columns:minmax(0,1fr) auto auto auto!important;gap:8px!important;align-items:center}\n#iwb-qa-root[data-theme] .qa-combo-controls>span:first-child{grid-column:1/-1;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n#iwb-qa-root[data-theme] .qa-combo-controls button{width:auto!important;min-width:0!important;min-height:40px;font-size:12px;padding:0 3px!important;white-space:nowrap}\n#iwb-qa-root[data-theme] .qa-search-modes{display:flex!important}\n#iwb-qa-root[data-theme] .qa-search-replace{display:flex!important;min-width:0}\n#iwb-qa-root[data-theme] .qa-search-replace input{min-width:0;flex:1}\n#iwb-qa-root[data-theme] .qa-search-replace button{flex:none;width:auto!important;font-size:12px;white-space:nowrap}\n}\n";

  const PC_WORKBENCH_STYLES = "\n@media(min-width:1025px){\n#iwb-qa-root[data-theme=\"fog-ink\"]{--iwb-canvas:#E5E9E7;--iwb-shell:#FAFAF7;--iwb-workbench:#F1F4F2;--iwb-card:#FFFDFC;--iwb-control:#FCFCFA;--iwb-editor:#FFFFFF;--iwb-text:#2B3133;--iwb-text-secondary:#616C6D;--iwb-muted:#929B99;--iwb-accent:#5F7D87;--iwb-accent-2:#9A747B;--iwb-secondary:#8C7967;--iwb-selected:#EAF1F5;--iwb-selected-border:#9FB7C4;--iwb-selected-decoration:#7898A8;--iwb-checkbox-selected:#688696}\n#iwb-qa-root[data-theme=\"wisteria-moon\"]{--iwb-canvas:#EAE5E3;--iwb-shell:#FBF8F6;--iwb-workbench:#F6F1EF;--iwb-card:#FFFDFC;--iwb-control:#FCFAF8;--iwb-editor:#FFFFFF;--iwb-text:#302C31;--iwb-text-secondary:#6C646B;--iwb-muted:#9E969C;--iwb-accent:#9B6F82;--iwb-accent-2:#756A91;--iwb-secondary:#6E8987;--iwb-selected:#EEF3F5;--iwb-selected-border:#AABBC6;--iwb-selected-decoration:#8EA2B1;--iwb-checkbox-selected:#7B8FA2}\n#iwb-qa-root[data-theme=\"night-mist\"]{--iwb-canvas:#242228;--iwb-shell:#2C2930;--iwb-workbench:#302D34;--iwb-card:#343138;--iwb-control:#36333A;--iwb-editor:#39363D;--iwb-text:#E3DDE2;--iwb-text-secondary:#BBB3B9;--iwb-muted:#918990;--iwb-accent:#B08EA2;--iwb-accent-2:#9488B0;--iwb-secondary:#7FA19F;--iwb-selected:#39434C;--iwb-selected-border:#6D8794;--iwb-selected-decoration:#8497A7;--iwb-checkbox-selected:#7D6A8C}\n#iwb-qa-root{--qa-bg:var(--iwb-shell);--qa-card-bg:var(--iwb-card);--qa-panel-bg:var(--iwb-workbench);--qa-edit-bg:var(--iwb-control);--qa-field-bg:var(--iwb-control);--qa-text:var(--iwb-text);--qa-muted:var(--iwb-text-secondary);--qa-accent:var(--iwb-accent);--qa-line:color-mix(in srgb,var(--iwb-text) 12%,var(--iwb-shell));color:var(--iwb-text);font-size:14px}\n#iwb-qa-root .qa-shell{background:var(--iwb-shell)}\n#iwb-qa-root .qa-head{display:block;padding:8px 18px 9px;background:var(--iwb-workbench,var(--qa-bg));border-bottom:1px solid var(--qa-line)}\n#iwb-qa-root .qa-title-row{display:flex;align-items:center;gap:7px;min-height:38px;margin:0 0 8px}\n#iwb-qa-root .qa-title{margin-right:auto}\n#iwb-qa-root .qa-title h2{font-size:18px;font-weight:600}\n#iwb-qa-root .qa-title-row .qa-icon{border:0;background:transparent;box-shadow:none;border-radius:4px;min-width:32px;min-height:32px;height:32px}\n#iwb-qa-root .qa-mobile-close{display:inline-flex!important;align-items:center;justify-content:center}\n#iwb-qa-root .qa-mode-segments,#iwb-qa-root .qa-mobile-title-lock,#iwb-qa-root .qa-top-grid>.qa-filter-pair,#iwb-qa-root .qa-top-grid>[data-action=\"other-tools\"]{display:none!important}\n#iwb-qa-root .qa-top-grid{display:flex;align-items:center;gap:12px;margin:0 0 4px;grid-area:auto}\n#iwb-qa-root .qa-top-grid>.qa-book-picker{flex:0 1 540px;min-width:220px;max-width:50%;width:auto}\n#iwb-qa-root .qa-book-picker-trigger{height:36px;min-height:36px;border-radius:4px;font-size:15px;font-weight:600;background:var(--iwb-control,var(--qa-field-bg));box-shadow:none}\n#iwb-qa-root .qa-top-grid>[data-action=\"new-entry\"],#iwb-qa-root .qa-top-grid>[data-action=\"toggle-source\"]{height:34px;min-height:34px;width:auto;padding:0 11px;border-radius:4px;font-size:13px;box-shadow:none}\n#iwb-qa-root .qa-mobile-operation-row{display:flex!important;align-items:center;gap:24px;min-height:36px;padding:0;border:0;background:transparent}\n#iwb-qa-root .qa-mobile-operation-row>.qa-btn{width:auto;min-width:0;height:32px;min-height:32px;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;font-size:13px;font-weight:400}\n#iwb-qa-root .qa-mobile-operation-row>.qa-btn.is-active{color:var(--iwb-accent,var(--qa-accent-strong));border-bottom:1px solid currentColor}\n#iwb-qa-root .qa-mobile-density-toggle{display:flex!important;align-items:center;gap:6px;margin-left:auto;font-size:12px}\n#iwb-qa-root .qa-mobile-density-toggle button{border:0;min-height:28px;background:transparent;font-size:12px;box-shadow:none;padding:0}\n#iwb-qa-root .qa-mobile-density-toggle button.is-active{color:var(--iwb-accent,var(--qa-accent-strong))}\n#iwb-qa-root .qa-mobile-menu:not([hidden]){display:flex!important;gap:19px;align-items:center;padding:9px 0;border-top:1px solid var(--qa-line);background:transparent;flex-wrap:wrap}\n#iwb-qa-root .qa-mobile-menu[hidden]{display:none!important}\n#iwb-qa-root .qa-mobile-menu .qa-btn{height:30px;min-height:30px;font-size:13px;padding:0 9px;border-radius:4px;box-shadow:none}\n#iwb-qa-root .qa-mobile-arrange-selection{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--iwb-muted,inherit)}\n#iwb-qa-root .qa-other-tools:not([hidden]){display:flex;gap:12px;flex-wrap:wrap;padding:9px 0;border-top:1px solid var(--qa-line);background:transparent}\n#iwb-qa-root .qa-other-tools .qa-arrange-quick,#iwb-qa-root .qa-other-tools>[data-action=\"arrange-settings\"]{display:none!important}\n#iwb-qa-root .qa-other-tools .qa-btn{font-size:13px;height:32px;min-height:32px;padding:0 10px;border-radius:4px;box-shadow:none}\n#iwb-qa-root .qa-status{font-size:11px;margin:2px 0 0;color:var(--iwb-muted,inherit)}\n#iwb-qa-root .qa-list-context .qa-entry-groups-open{display:none!important}\n#iwb-qa-root .qa-list-context{border:0;border-bottom:1px solid var(--qa-line);border-radius:0;background:transparent;min-height:30px;padding:0 0 7px;box-shadow:none;font-size:11px}\n#iwb-qa-root .qa-list-context strong{font-size:11px;font-weight:400}\n#iwb-qa-root .qa-list-context .qa-btn{min-height:28px;height:28px;font-size:12px;border:0;background:transparent;box-shadow:none}\n#iwb-qa-root .qa-card{border-radius:6px;box-shadow:none;padding:9px 12px;background:var(--iwb-card,var(--qa-card))}\n#iwb-qa-root .qa-card.is-selected{background:var(--iwb-selected);border-color:var(--iwb-selected-border)}\n#iwb-qa-root .qa-check{appearance:none!important;accent-color:auto!important;background:var(--iwb-control);border:1px solid var(--qa-line);border-radius:3px;width:23px;height:23px;box-shadow:none}\n#iwb-qa-root .qa-check:checked{background:var(--iwb-checkbox-selected);border-color:var(--iwb-checkbox-selected);background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3 8l3 3 7-7' fill='none' stroke='white' stroke-width='2'/%3E%3C/svg%3E\")}\n#iwb-qa-root .qa-card-main{grid-template-columns:minmax(230px,1fr) minmax(330px,480px) auto;gap:14px}\n#iwb-qa-root .qa-inline-field>span{font-size:10px;font-weight:400;color:var(--iwb-muted,inherit)}\n#iwb-qa-root .qa-inline-field .qa-input,#iwb-qa-root .qa-inline-field .qa-select{border-radius:4px;font-size:13px;background:var(--iwb-control,var(--qa-field-bg));box-shadow:none}\n#iwb-qa-root .qa-name{font-size:15px;font-weight:600}\n#iwb-qa-root .qa-name-meta{font-size:11px;font-weight:400}\n#iwb-qa-root .qa-name-meta b{font-weight:400}\n#iwb-qa-root .qa-summary-actions button{width:32px;min-width:32px;height:32px;min-height:32px;border-radius:4px;box-shadow:none}\n#iwb-qa-root .qa-summary-actions .qa-switch{width:32px!important;min-width:32px!important}\n#iwb-qa-root.qa-pc-compact-mode .qa-card:not(.is-expanded) .qa-inline-fields{display:none!important}\n#iwb-qa-root.qa-pc-compact-mode .qa-card:not(.is-expanded) .qa-card-main{grid-template-columns:minmax(230px,1fr) auto;grid-template-areas:\"head actions\"}\n#iwb-qa-root .qa-footer{min-height:45px;padding:6px 18px;background:var(--iwb-workbench,var(--qa-bg));border-top:1px solid var(--qa-line)}\n#iwb-qa-root .qa-footer .qa-btn{height:32px;min-height:32px;border-radius:4px;font-size:13px;padding:0 11px;box-shadow:none}\n#iwb-qa-root .qa-footer .qa-count{font-size:11px;color:var(--iwb-muted,inherit)}\n#iwb-qa-root .qa-workspace-panel{background:var(--iwb-workbench,var(--qa-bg));padding:10px 18px;border-top:1px solid var(--qa-line)}\n#iwb-qa-root .qa-workspace-panel .qa-panel,#iwb-qa-root .qa-batch-group{border:0;border-radius:0;box-shadow:none;background:transparent}\n#iwb-qa-root.qa-desktop-task-active .qa-head{display:none!important}\n#iwb-qa-root .qa-desktop-task-head{background:var(--iwb-workbench,var(--qa-bg));box-shadow:none;border-radius:0;font-weight:400}\n#iwb-qa-root .qa-import-workspace,#iwb-qa-root .qa-transfer-workspace,#iwb-qa-root .qa-arrange-workspace{background:var(--iwb-shell,var(--qa-bg));border-radius:0;box-shadow:none}\n}\n";

  const MOBILE_POLISH_STYLES = "\n@media(max-width:480px){\n#iwb-qa-root[data-theme] .qa-selection-strip .qa-btn[data-action]{font-size:14px!important;font-weight:400!important;min-height:44px!important}\n#iwb-qa-root[data-theme] .qa-mobile-batch-grid .qa-btn{font-size:14px!important;font-weight:400!important}\n#iwb-qa-root[data-theme] .qa-top-grid>.qa-mobile-title-lock,#iwb-qa-root[data-theme] .qa-combo-title-lock{display:grid!important;place-items:center;min-width:34px;min-height:38px;color:var(--iwb-muted);background:transparent;border:0;box-shadow:none}\n#iwb-qa-root[data-theme] .qa-book-picker-trigger{background:var(--iwb-control)!important;border:1px solid var(--qa-line)!important;border-radius:4px!important;padding:0 7px!important}\n#iwb-qa-root[data-theme] .qa-mobile-compact-actions{justify-content:flex-start!important;gap:4px!important}\n#iwb-qa-root[data-theme] .qa-mobile-compact-actions>.qa-action-icon[data-action=\"duplicate\"]{margin-left:0!important}\n#iwb-qa-root[data-theme] .qa-combo-context{padding-left:16px!important;padding-right:7px!important}\n#iwb-qa-root[data-theme] .qa-combo-density-row{display:flex;align-items:center;min-height:42px;padding:0 12px;border-bottom:1px solid var(--qa-line);gap:6px}\n#iwb-qa-root[data-theme] .qa-combo-density-row>span:first-child{margin-right:auto;font-size:11px;color:var(--iwb-muted)}\n#iwb-qa-root[data-theme] .qa-combo-density-row button{min-height:40px;border:0;background:transparent;color:var(--iwb-muted);font-size:12px}\n#iwb-qa-root[data-theme] .qa-combo-density-row button.is-active{color:var(--iwb-accent);text-decoration:underline;text-underline-offset:5px}\n#iwb-qa-root[data-theme] .qa-combo-management{padding:8px 12px;background:var(--iwb-workbench);border-bottom:1px solid var(--qa-line)}\n#iwb-qa-root[data-theme] .qa-combo-management-summary{display:flex;align-items:center;gap:12px;min-height:30px;font-size:13px}\n#iwb-qa-root[data-theme] .qa-combo-management-summary>span:first-child{display:flex;flex:1;min-width:0;white-space:nowrap}\n#iwb-qa-root .qa-combo-management-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n#iwb-qa-root .qa-combo-management-summary small{flex:none;font-size:11px;font-weight:400}\n#iwb-qa-root[data-theme] .qa-combo-management-summary>span:last-child{flex:none;color:var(--iwb-muted);font-size:11px;white-space:nowrap}\n#iwb-qa-root[data-theme] .qa-combo-management-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}\n#iwb-qa-root[data-theme] .qa-combo-management-actions button{min-height:44px;border:0;box-shadow:none;background:transparent;color:var(--iwb-text-secondary);font-size:14px;font-weight:400;padding:0 3px;white-space:nowrap}\n#iwb-qa-root[data-theme] .qa-combo-management-actions button.danger{color:var(--iwb-danger)}\n#iwb-qa-root[data-theme] .qa-name-arrange-settings{padding:12px 8px;display:grid;grid-template-columns:1fr 1fr;gap:10px}\n#iwb-qa-root[data-theme] .qa-name-arrange-settings .qa-field{display:grid;gap:4px;min-width:0}\n#iwb-qa-root[data-theme] .qa-name-arrange-settings select{width:100%;height:38px;font-size:14px}\n}\n#iwb-qa-root .qa-name-arrange-settings{display:flex;gap:14px;padding:10px 0}\n#iwb-qa-root .qa-arrange-list[hidden]{display:none!important}\n@media(min-width:481px){#iwb-qa-root .qa-combo-title-lock{display:none!important}#iwb-qa-root .qa-combo-management{display:flex;align-items:center;gap:24px;padding:8px 16px}#iwb-qa-root .qa-combo-management-summary{display:flex;gap:12px;min-width:0;flex:1}#iwb-qa-root .qa-combo-management-summary>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#iwb-qa-root .qa-combo-management-summary>span:last-child{white-space:nowrap;font-size:11px;opacity:.65}#iwb-qa-root .qa-combo-management-actions{display:flex;gap:16px}#iwb-qa-root .qa-combo-management-actions button{background:transparent;border:0;min-height:36px}#iwb-qa-root .qa-combo-density-row{display:flex;gap:7px;padding:6px 16px}#iwb-qa-root .qa-combo-density-row>span:first-child{margin-right:auto}}\n";

  const COMBO_NAV_STYLES = "\n@media(max-width:480px){\n#iwb-qa-root[data-theme] .qa-combo-navigation{display:flex;align-items:flex-start;gap:12px;padding:0 12px;border-block:1px solid var(--qa-line);font-size:13px;min-width:0}\n#iwb-qa-root[data-theme] .qa-combo-fixed-tabs{display:flex;flex:none;gap:12px}\n#iwb-qa-root[data-theme] .qa-combo-user-tabs{display:flex;gap:14px;overflow-x:auto;white-space:nowrap;flex:1;min-width:0;scrollbar-width:none}\n#iwb-qa-root[data-theme] .qa-combo-navigation.is-expanded{position:relative;display:flex;flex-wrap:wrap;gap:0 14px;padding-right:54px;min-height:88px}\n#iwb-qa-root[data-theme] .qa-combo-navigation.is-expanded .qa-combo-fixed-tabs,#iwb-qa-root[data-theme] .qa-combo-navigation.is-expanded .qa-combo-user-tabs{display:contents}\n#iwb-qa-root[data-theme] .qa-combo-navigation.is-expanded .qa-combo-nav-tools{position:absolute;right:12px;top:0}\n#iwb-qa-root[data-theme] .qa-combo-user-tab{display:flex;align-items:center;flex:none;max-width:100%;min-width:0}\n#iwb-qa-root[data-theme] .qa-combo-user-tab .qa-combo-tab{max-width:min(170px,100%);min-width:0;flex:0 1 auto;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}\n#iwb-qa-root[data-theme] .qa-combo-nav-tools{display:flex;flex-direction:column;flex:none;gap:0}\n#iwb-qa-root[data-theme] .qa-combo-nav-tools button{min-width:34px;min-height:44px;padding:0 2px;font-size:12px;background:transparent;border:0;box-shadow:none;color:var(--iwb-text-secondary)}\n#iwb-qa-root[data-theme] .qa-combo-group-drag{width:30px;height:44px;flex:none;touch-action:none;border:0;background:transparent;color:var(--iwb-muted)}\n#iwb-qa-root[data-theme] .qa-combo-user-tab.is-nav-drag-source{opacity:.55}\n#iwb-qa-root[data-theme] .qa-combo-user-tab.is-nav-drop-before{box-shadow:inset 2px 0 var(--iwb-accent)}\n#iwb-qa-root[data-theme] .qa-combo-user-tab.is-nav-drop-after{box-shadow:inset -2px 0 var(--iwb-accent)}\n#iwb-qa-root[data-theme] .qa-combo-compact-management{display:flex;align-items:center;flex-wrap:wrap;gap:5px;padding:0 12px;border-bottom:1px solid var(--qa-line);min-height:44px;font-size:11px}\n#iwb-qa-root[data-theme] .qa-combo-compact-summary{display:flex;align-items:center;gap:8px;min-height:40px;font-size:12px;white-space:nowrap}\n#iwb-qa-root[data-theme] .qa-combo-compact-summary small{font-size:11px;color:var(--iwb-muted);font-weight:400}\n#iwb-qa-root[data-theme] .qa-combo-inline-density{margin-left:auto;display:flex;gap:5px;align-items:center}\n#iwb-qa-root[data-theme] .qa-combo-inline-density button{min-height:40px;padding:0 2px;border:0;background:transparent;color:var(--iwb-muted);font-size:12px}\n#iwb-qa-root[data-theme] .qa-combo-inline-density button.is-active{color:var(--iwb-accent);text-decoration:underline;text-underline-offset:5px}\n#iwb-qa-root[data-theme] .qa-combo-compact-management .qa-combo-management-actions{display:flex;gap:5px;flex:none}\n#iwb-qa-root[data-theme] .qa-combo-compact-management .qa-combo-management-actions button{min-width:32px;font-size:13px;padding:0 2px;min-height:44px}\n}\n";

// Frozen components used only by the old compatibility UI/tests.
// New mobile UI owns separate private definitions; do not import its presentation.
  // P2-B03: existing presentation moved without visual or business redesign.
  // Phone-owned components. Shared legacy helpers remain explicit dependencies until P3.
  function mobileCardActionsHtml(entry) {
    const enabled = enabledPresentation(entry);
    const activation = editableActivationType(entry);
    const green = activation === 'selective' || activation === 'normal';
    const raw = String(entry?.strategy?.type ?? 'unknown');
    const label = activation === 'constant' ? '蓝灯：永久' : green ? '绿灯：关键词' : raw === 'vectorized' ? '向量状态，只读' : '激活方式只读';
    return [
      '<button class="qa-switch" data-action="enabled" role="switch" aria-checked="' + enabled.checked + '" ' + (enabled.disabled ? 'disabled ' : '') + 'aria-label="' + escapeHtml(enabled.label) + '" title="' + escapeHtml(enabled.title) + '"></button>',
      '<button class="qa-action-icon qa-lamp ' + (activation === 'constant' ? 'blue' : green ? 'green' : 'readonly') + '" data-action="activation" ' + (activation ? '' : 'disabled ') + 'aria-label="' + escapeHtml(label) + '" title="' + escapeHtml(label) + '">' + (activation === 'constant' ? '🔵' : green ? '🟢' : '🔗') + '</button>',
      '<button class="qa-action-icon" data-action="duplicate" aria-label="复制条目" title="复制条目"><i class="fa-solid fa-copy" aria-hidden="true"></i></button>',
      '<button class="qa-action-icon qa-delete" data-action="delete" aria-label="删除条目" title="删除条目"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>',
    ];
  }

  function mobileCardFieldsHtml(entry) {
    const pos = positionInfo(entry);
    const actions = mobileCardActionsHtml(entry);
    const atDepth = pos.editable && pos.type === 'at_depth';
    const position = pos.editable ? '<select class="qa-select" data-control="entry-position" aria-label="原生位置">' + POSITION_TYPES.map(type => optionHtml(type, POSITION_LABELS[type], pos.type)).join('') + '</select>' : '<input class="qa-input" value="' + escapeHtml(pos.label) + '" disabled aria-label="原生位置">';
    const role = atDepth ? '<select class="qa-select" data-control="entry-role" aria-label="角色">' + Object.entries(ROLE_LABELS).map(([value, label]) => optionHtml(value, label, pos.role || 'system')).join('') + '</select>' : '<input class="qa-input" value="—" disabled aria-label="角色不适用">';
    const field = (label, control) => '<label class="qa-inline-field"><span>' + label + '</span>' + control + '</label>';
    return '<div class="qa-mobile-detail-row">' + field('位置', position) + field('顺序', '<input class="qa-input" data-control="entry-order" aria-label="顺序" type="number" step="any" value="' + escapeHtml(pos.order ?? 100) + '" ' + (pos.editable ? '' : 'disabled') + '>') + actions[0] + actions[1] + '</div><div class="qa-mobile-detail-row">' + field('角色', role) + field('深度', '<input class="qa-input" ' + (atDepth ? 'data-control="entry-depth"' : 'disabled') + ' aria-label="深度" type="number" min="0" step="1" value="' + (atDepth ? escapeHtml(pos.depth ?? 4) : '') + '">') + actions[2] + actions[3] + '</div>';
  }

  function mobileCardEditorHtml(entry) {
    return editorHtml(entry).replace(/<div class="qa-content-preview">[\s\S]*?<\/div>/, () => '<textarea class="qa-content-inline" data-control="entry-content" aria-label="正文">' + escapeHtml(entry?.content ?? '') + '</textarea>');
  }

  function mobileEntryCardHtml(view, entry, changed, globalIndex) {
    const id = entryId(entry);
    const selected = view.selected.has(id);
    const expanded = view.expanded.has(id);
    const compact = view.cardDensity === 'compact' && !expanded;
    const source = view.mixedMode && view.sourceVisible ? '<div class="qa-source" title="' + escapeHtml(entry._iwbBook) + '">' + escapeHtml(activeSourceText(view, entry._iwbBook)) + '</div>' : '';
    const meta = view.mixedMode ? '总览 No.' + (globalIndex + 1) + ' · 本书 No.' + (Number(entry._iwbBookIndex || 0) + 1) : 'No.' + (globalIndex + 1);
    const actions = mobileCardActionsHtml(entry);
    return '<article class="qa-card qa-mobile-card' + (selected ? ' is-selected' : '') + (changed.has(id) ? ' is-changed' : '') + (expanded ? ' is-expanded' : '') + (compact ? ' is-compact' : '') + '" data-entry-id="' + escapeHtml(id) + '" data-book="' + escapeHtml(entry._iwbBook || view.book) + '"><div class="qa-card-main"><div class="qa-card-head"><input class="qa-check" type="checkbox" data-action="toggle" ' + (selected ? 'checked ' : '') + 'aria-label="选择 ' + escapeHtml(entryName(entry)) + '"><div class="qa-name-cell">' + nameButtonHtml(entry, !canEditTitle(view)) + source + '<div class="qa-name-meta">' + meta + ' · Token <b data-token-id="' + escapeHtml(id) + '">' + escapeHtml(tokenLabel(view, entry)) + '</b></div></div><button class="qa-drag" data-action="drag" title="拖动排列" aria-label="拖动排列"><i class="fa-solid fa-bars" aria-hidden="true"></i></button><button class="qa-expand" data-action="expand" aria-expanded="' + expanded + '" aria-label="' + (expanded ? '收起' : '展开') + '条目"><i class="fa-solid fa-chevron-' + (expanded ? 'up' : 'down') + '" aria-hidden="true"></i></button></div>' + (compact ? '<div class="qa-mobile-compact-actions">' + actions.join('') + '</div>' : '<div class="qa-inline-fields">' + mobileCardFieldsHtml(entry) + '</div>') + (expanded ? mobileCardEditorHtml(entry) : '') + '</div></article>';
  }


  // P2-B03: existing presentation moved without visual or business redesign.
  // Phone-owned components. Shared legacy helpers remain explicit dependencies until P3.
  function mobileBatchPanelHtml(view) {
    return '<section class="qa-panel qa-mobile-batch"><div class="qa-mobile-batch-head"><span>批量操作</span><button class="qa-btn" data-action="panel-close">收起</button></div><div class="qa-mobile-batch-grid"><button class="qa-btn" data-action="batch-enabled" data-enabled="true">启用</button><button class="qa-btn" data-action="batch-enabled" data-enabled="false">停用</button><button class="qa-btn danger" data-action="batch-delete">删除</button><button class="qa-btn" data-action="panel-position">改位置</button><button class="qa-btn" data-action="panel-order">改顺序</button><span class="qa-batch-flower" aria-hidden="true">❀</span></div></section>';
  }

  function mobileFooterHtml(view) {
    if (['import', 'transfer', 'arrange-settings'].includes(view.panel)) return '';
    const creating = view.panel === 'entry-group-create';
    const editingGroup = view.mobileMode === 'group' && Boolean(view.entryGroupEditingId);
    const selected = view.selected.size;
    const scope = listSelectionScope(view).entries;
    const allSelected = scope.length > 0 && scope.every(entry => view.selected.has(entryId(entry)));
    const batchActive = ['batch', 'position', 'order'].includes(view.panel);
    const strip = editingGroup ? '<div class="qa-selection-strip"><span>成员选择</span><button class="qa-btn" data-action="entry-group-edit-cancel">取消</button><button class="qa-btn" data-action="entry-group-edit-save">保存成员</button></div>' : selected && !creating ? '<div class="qa-selection-strip"><span>已选 ' + selected + ' 条</span><button class="qa-btn" data-action="select-list-scope" ' + (allSelected ? 'disabled' : '') + '>全选</button><button class="qa-btn" data-action="entry-group-create-open">存为组合</button><button class="qa-btn" data-action="batch-panel">' + (batchActive ? '收起' : '批量') + '</button><button class="qa-btn" data-action="clear-selection">清空</button></div>' : '';
    const dirty = isDirty(view);
    const count = pendingChangeCount(view);
    const status = dirty ? count + ' 项未保存修改' : '无未保存修改';
    const disabled = view.busy ? ' disabled' : '';
    return strip + '<div class="qa-mobile-safety' + (dirty ? ' is-dirty' : '') + '"><span data-slot="mobile-change-summary">' + status + '</span>' + (dirty ? '<button class="qa-btn" data-action="undo"' + (!view.undo.length || view.busy ? ' disabled' : '') + '>撤销</button><button class="qa-btn danger" data-action="discard"' + disabled + '>放弃</button><button class="qa-btn" data-action="save"' + disabled + '>' + (view.busy === 'save' ? '保存中…' : '保存全部') + '</button>' : '') + '</div>';
  }


  // P2-B03: existing presentation moved without visual or business redesign.
  // Phone-owned components. Shared legacy helpers remain explicit dependencies until P3.
  function mobileComboHeaderHtml(view) {
    const active=view.entryGroups.find(group=>group.id===view.comboGroupId),entries=comboOrderedEntries(view),enabled=entries.filter(entry=>entry.enabled!==false).length;
    const status=active && entries.length ? enabled===0?'全部停用':enabled===entries.length?'全部启用':'部分启用' : '';
    const tab=(id,name,user=false)=>'<button class="qa-combo-tab" data-action="combo-tab" data-group-id="'+escapeHtml(id)+'"'+(user&&!view.comboNavArrange?' data-combo-drop-id="'+escapeHtml(id)+'"':'')+' aria-current="'+(id===view.comboGroupId)+'">'+escapeHtml(name)+'</button>';
    const users=view.entryGroups.map(group=>'<span class="qa-combo-user-tab" data-group-id="'+escapeHtml(group.id)+'">'+tab(group.id,group.name,true)+(view.comboNavArrange?'<button class="qa-combo-group-drag" data-action="combo-group-drag" data-group-id="'+escapeHtml(group.id)+'" aria-label="拖动组合排列">≡</button>':'')+'</span>').join('');
    const density='<div class="qa-combo-inline-density">'+(comboSelectedIds(view).length?'<button data-action="combo-assignment-open">分组</button>':'')+['compact','full'].map(value=>'<button data-action="card-density" data-density="'+value+'"'+(view.cardDensity===value || value==='full'&&!view.cardDensity?' class="is-active"':'')+'>'+(value==='full'?'完整':'精简')+'</button>').join('<span>/</span>')+'</div>';
    const management=active?comboManagementHtml(view).match(/<div class="qa-combo-management-actions">[\s\S]*?<\/div>/)?.[0]||'':'';
    return '<div class="qa-combo-titlebar"><button data-action="combo-back" aria-label="返回编辑视图">←</button><h2>快捷组合</h2><button class="qa-combo-title-lock" data-action="title-lock" aria-label="标题锁" aria-pressed="'+Boolean(view.titleLocked)+'"><i class="fa-solid fa-'+(view.titleLocked?'lock':'lock-open')+'"></i></button><button data-action="combo-new-open">＋ 新建组合</button><button data-action="theme-open" aria-label="界面主题"><i class="fa-solid fa-palette"></i></button><button data-action="close" aria-label="关闭观测台">×</button></div><nav class="qa-combo-navigation'+(view.comboNavExpanded?' is-expanded':'')+'"><div class="qa-combo-fixed-tabs">'+tab('__all__','全部')+tab('__ungrouped__','未分组')+'</div><div class="qa-combo-user-tabs" data-slot="combo-user-tabs">'+users+'</div><div class="qa-combo-nav-tools"><button data-action="combo-nav-toggle" aria-expanded="'+Boolean(view.comboNavExpanded)+'">'+(view.comboNavExpanded?'收起':'展开')+'</button>'+(view.comboNavExpanded?'<button data-action="combo-nav-arrange" aria-pressed="'+Boolean(view.comboNavArrange)+'">'+(view.comboNavArrange?'完成':'排列')+'</button>':'')+'</div></nav><div class="qa-combo-compact-management" title="'+escapeHtml(status)+'" aria-label="'+entries.length+' 条 '+escapeHtml(status)+'"><span>'+entries.length+' 条</span>'+management+density+'</div>';
  }

  // P2-B03: existing presentation moved without visual or business redesign.
  // Transitional mixed-width UI only; not a shared UI for the future desktop.
  function searchWorkspaceHeaderHtml(view) {
    const body = view.searchKind === 'body', count = searchWorkspaceResults(view).reduce((sum,result) => sum + result.count, 0);
    const replace = body && !view.mixedMode && view.book ? '<div class="qa-search-replace"><input class="qa-input" data-control="body-search-replace" placeholder="替换为" aria-label="替换为" value="' + escapeHtml(view.searchReplace || '') + '"><button class="qa-btn" data-action="body-replace-results"' + (!count || view.busy ? ' disabled' : '') + '>替换匹配结果（' + count + ' 处）</button></div>' : '';
    return '<div class="qa-search-titlebar"><button class="qa-icon" data-action="search-back" aria-label="返回上一工作区">←</button><h2>查找与替换</h2><button class="qa-icon" data-action="theme-open" aria-label="主题"><i class="fa-solid fa-palette" aria-hidden="true"></i></button><button class="qa-icon" data-action="guide-open" aria-label="帮助">?</button><button class="qa-icon" data-action="close" aria-label="关闭世界书观测台">×</button></div><div class="qa-search-book">' + escapeHtml(view.mixedMode ? '当前生效世界书总览' : view.book || '未选择世界书') + '</div><div class="qa-search-modes"><button data-action="search-kind" data-kind="metadata" aria-current="' + !body + '">条目</button><button data-action="search-kind" data-kind="body" aria-current="' + body + '">正文</button></div><div class="qa-search-inputs"><input class="qa-input" data-control="body-search-find" placeholder="' + (body ? '查找正文内容' : '名称 / UID / 主关键词') + '" aria-label="查找内容" value="' + escapeHtml(view.searchFind || '') + '">' + replace + '</div>';
  }

  function searchWorkspaceResultHtml(view) {
    const results = searchWorkspaceResults(view), count = results.reduce((sum,result) => sum + result.count, 0), limit = view.renderLimit || APP.chunkSize;
    return '<section class="qa-search-results"><div class="qa-search-summary">' + results.length + ' 条结果' + (view.searchKind === 'body' ? ' · ' + count + ' 处匹配' : '') + '</div>' + results.slice(0,limit).map(result => '<article class="qa-search-result"><header><span>' + escapeHtml(entryName(result.entry)) + '</span><small>UID ' + escapeHtml(result.entry._iwbOriginalUid ?? result.entry.uid) + (view.searchKind === 'body' ? ' · ' + result.count + ' 处' : '') + '</small></header><p>' + escapeHtml(result.snippet) + '</p></article>').join('') + (results.length > limit ? '<button class="qa-more" data-action="more">继续显示</button>' : '') + '</section>';
  }

  function searchSafetyFooterHtml(view) {
    const dirty = isDirty(view), count = pendingChangeCount(view), disabled = view.busy ? ' disabled' : '';
    return '<div class="qa-mobile-safety' + (dirty ? ' is-dirty' : '') + '"><span>' + (dirty ? count + ' 项未保存修改' : '无未保存修改') + '</span>' + (dirty ? '<button class="qa-btn" data-action="undo"' + (!view.undo.length || view.busy ? ' disabled' : '') + '>撤销</button><button class="qa-btn danger" data-action="discard"' + disabled + '>放弃</button><button class="qa-btn" data-action="save"' + disabled + '>保存全部</button>' : '') + '</div>';
  }

  function recursionStatusHtml(entry) {
    const recursion = entry?.recursion && typeof entry.recursion === 'object' ? entry.recursion : {};
    const incoming = recursion.prevent_incoming === true ? '禁止被递归' : '可被递归';
    const outgoing = recursion.prevent_outgoing === true ? '禁止继续递归' : '可继续递归';
    const delayed = recursion.delay_until !== null && recursion.delay_until !== undefined ? '<span>仅递归时触发</span>' : '';
    return `<span>${incoming}</span><span>${outgoing}</span>${delayed}`;
  }

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

  function groupModeBarHtml(view) {
    const sets = entryGroupIdSets(view);
    if (!view.activeEntryGroupId || (view.activeEntryGroupId !== '__ungrouped__' && !sets.some(item => item.group.id === view.activeEntryGroupId))) view.activeEntryGroupId = sets[0]?.group.id || '__ungrouped__';
    const grouped = new Set(sets.flatMap(item => [...item.ids]));
    const ungroupedCount = (view.working || []).map(entryId).filter(id => !grouped.has(id)).length;
    const chips = sets.map(({ group, ids }) => '<button class="qa-entry-group-chip' + (view.activeEntryGroupId === group.id ? ' is-active' : '') + '" data-action="entry-group-view" data-group-id="' + escapeHtml(group.id) + '" title="' + escapeHtml(group.name) + '">' + escapeHtml(group.name) + ' <small>' + ids.size + '</small></button>').join('');
    const ungrouped = '<button class="qa-entry-group-chip' + (view.activeEntryGroupId === '__ungrouped__' ? ' is-active' : '') + '" data-action="entry-group-view" data-group-id="__ungrouped__">未分组 <small>' + ungroupedCount + '</small></button>';
    const active = sets.find(item => item.group.id === view.activeEntryGroupId);
    const actions = active && !view.entryGroupEditingId ? '<div class="qa-entry-group-mode-actions"><button class="qa-btn" data-action="entry-group-enabled" data-enabled="true" data-group-id="' + escapeHtml(active.group.id) + '">启用</button><button class="qa-btn" data-action="entry-group-enabled" data-enabled="false" data-group-id="' + escapeHtml(active.group.id) + '">停用</button><button class="qa-btn" data-action="entry-group-edit-members" data-group-id="' + escapeHtml(active.group.id) + '">编辑成员</button><button class="qa-btn" data-action="entry-group-rename-open" data-group-id="' + escapeHtml(active.group.id) + '">改名</button><button class="qa-btn danger" data-action="entry-group-delete" data-group-id="' + escapeHtml(active.group.id) + '">删除</button></div>' : '';
    const editing = view.entryGroupEditingId ? '<div class="qa-entry-group-editing">编辑“' + escapeHtml(active?.group.name || '') + '”成员</div>' : '';
    return '<section class="qa-entry-group-mode"><div class="qa-entry-group-mode-head"><div class="qa-entry-group-tabs">' + chips + ungrouped + '</div><button class="qa-btn" data-action="mobile-group-exit">返回列表</button></div>' + editing + actions + '</section>';
  }

  function listContextHtml(view, entries) {
    const scope = listSelectionScope(view, entries);
    const label = scope.exactlySelected ? `已全选${scope.scopeName}` : `全选${scope.scopeName}`;
    const groupButton = view.mixedMode ? '' : '<button class="qa-btn qa-entry-groups-open" data-action="entry-groups-open">快捷组合</button>';
    return `<div class="qa-list-context"><span><strong>${escapeHtml(scope.countText)}</strong><small>已选 ${view.selected.size} 条</small></span><div class="qa-list-context-actions">${groupButton}<button class="qa-btn" data-action="select-list-scope" ${!scope.ids.length || scope.exactlySelected ? 'disabled' : ''}>${escapeHtml(label)}</button></div></div>`;
  }

  function bookSelectorOptionsHtml(view, value = view.book || '') {
    const groups = bookSelectorGroups(view);
    const empty = '<option value="">选择一本具体世界书</option>';
    const overview = optionHtml(MIXED_BOOK_VALUE, '当前生效世界书总览', value);
    if (!groups.reliable) {
      const all = groups.all.map(name => optionHtml(name, name, value)).join('');
      return `${empty}<optgroup label="当前生效">${overview}</optgroup><optgroup label="所有世界书">${all}</optgroup>`;
    }
    const active = groups.active.map(book => optionHtml(book.name, bookSelectorLabel(book), value)).join('');
    const inactive = groups.inactive.map(name => optionHtml(name, name, value)).join('');
    return `${empty}<optgroup label="当前生效">${overview}${active}</optgroup><optgroup label="当前未生效">${inactive}</optgroup>`;
  }

  function bookPickerItemHtml(value, label, current) {
    const selected = value === current;
    return `<button class="qa-book-picker-item${selected ? ' is-current' : ''}" data-action="book-picker-select" data-book-value="${escapeHtml(value)}" role="option" aria-selected="${selected}"><span>${escapeHtml(label)}</span>${selected ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : ''}</button>`;
  }

  function bookPickerResultsHtml(view, query = view.bookPickerQuery || '') {
    const groups = bookSelectorGroups(view);
    const activeItems = [];
    if (bookPickerMatches('当前生效世界书总览', query)) activeItems.push(bookPickerItemHtml(MIXED_BOOK_VALUE, '当前生效世界书总览', view.book));
    if (groups.reliable) {
      groups.active.forEach(book => {
        const label = bookSelectorLabel(book);
        if (bookPickerMatches(label, query)) activeItems.push(bookPickerItemHtml(book.name, label, view.book));
      });
      const inactiveItems = groups.inactive.filter(name => bookPickerMatches(name, query)).map(name => bookPickerItemHtml(name, name, view.book));
      if (!activeItems.length && !inactiveItems.length) return '<div class="qa-book-picker-empty">没有找到匹配的世界书</div>';
      return `${activeItems.length ? '<section class="qa-book-picker-group"><h3>当前生效</h3>' + activeItems.join('') + '</section>' : ''}${inactiveItems.length ? '<section class="qa-book-picker-group"><h3>当前未生效</h3>' + inactiveItems.join('') + '</section>' : ''}`;
    }
    const allItems = groups.all.filter(name => bookPickerMatches(name, query)).map(name => bookPickerItemHtml(name, name, view.book));
    if (!activeItems.length && !allItems.length) return '<div class="qa-book-picker-empty">没有找到匹配的世界书</div>';
    return `${activeItems.length ? '<section class="qa-book-picker-group"><h3>当前生效</h3>' + activeItems.join('') + '</section>' : ''}${allItems.length ? '<section class="qa-book-picker-group"><h3>所有世界书</h3>' + allItems.join('') + '</section>' : ''}`;
  }

  function themeHtml() {
    return `<section class="qa-theme-layer" data-slot="theme-picker" hidden><button type="button" class="qa-theme-backdrop" data-action="theme-close" aria-label="关闭界面主题选择"></button><div class="qa-theme-dialog" role="dialog" aria-modal="true" aria-labelledby="iwb-theme-title"><header class="qa-theme-head"><div><h3 id="iwb-theme-title">界面主题</h3><p>只改变观测台外观，不影响世界书内容。</p></div><button type="button" class="qa-icon" data-action="theme-close" aria-label="关闭界面主题选择">×</button></header><div class="qa-theme-options"><button type="button" class="qa-theme-choice" data-action="theme-select" data-theme-choice="fog-ink"><span class="qa-theme-preview qa-theme-preview-fog" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span><strong>雾墨青蓝</strong><small>冷雾灰、墨蓝与低饱和雾蓝</small></span><b aria-hidden="true">✓</b></button><button type="button" class="qa-theme-choice" data-action="theme-select" data-theme-choice="wisteria-moon"><span class="qa-theme-preview qa-theme-preview-wisteria" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span><strong>藤月烟粉</strong><small>冷白月雾、灰紫与少量雾蓝</small></span><b aria-hidden="true">✓</b></button><button type="button" class="qa-theme-choice" data-action="theme-select" data-theme-choice="night-mist"><span class="qa-theme-preview qa-theme-preview-night" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span><strong>夜雾墨紫</strong><small>深灰夜雾、柔和冷白与月紫强调</small></span><b aria-hidden="true">✓</b></button></div></div></section>`;
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

  function nameArrangeSettingsHtml(view) {
    const pref=normalizeNameArrangePreference(view.nameArrangeDraft);
    return '<div class="qa-name-arrange-settings"><label class="qa-field"><span>整理方式</span><select class="qa-select" data-control="arrange-method">'+optionHtml('position','位置与顺序',pref.mode)+optionHtml('name','名称',pref.mode)+'</select></label><label class="qa-field"><span>名称排序</span><select class="qa-select" data-control="name-arrange-direction">'+optionHtml('asc','名称升序',pref.direction)+optionHtml('desc','名称降序',pref.direction)+'</select></label></div>';
  }

  function comboDensityHtml(view) {
    return '<div class="qa-combo-density-row"><span>'+(comboSelectedIds(view).length ? '<button data-action="combo-assignment-open">分组</button>' : '')+'</span><button data-action="card-density" data-density="compact"'+(view.cardDensity==='compact'?' class="is-active"':'')+'>精简</button><span aria-hidden="true">/</span><button data-action="card-density" data-density="full"'+(view.cardDensity!=='compact'?' class="is-active"':'')+'>完整</button></div>';
  }

  function comboManagementHtml(view) {
    const active=view.entryGroups.find(group=>group.id===view.comboGroupId);if(!active)return '';
    const entries=comboOrderedEntries(view),enabled=entries.filter(entry=>entry.enabled!==false).length;
    const status=!entries.length?'0 条':enabled===0?'全部停用':enabled===entries.length?'全部启用':'部分启用';
    return '<div class="qa-combo-management"><div class="qa-combo-management-summary"><span><span class="qa-combo-management-name" title="'+escapeHtml(active.name)+'">'+escapeHtml(active.name)+'</span><small> · '+entries.length+' 条</small></span><span>'+status+'</span></div><div class="qa-combo-management-actions"><button data-action="entry-group-enabled" data-group-id="'+escapeHtml(active.id)+'" data-enabled="true">启用</button><button data-action="entry-group-enabled" data-group-id="'+escapeHtml(active.id)+'" data-enabled="false">停用</button><button data-action="entry-group-rename-open" data-group-id="'+escapeHtml(active.id)+'">重命名</button><button class="danger" data-action="entry-group-delete" data-group-id="'+escapeHtml(active.id)+'">解散</button></div></div>';
  }

  function templateHtml() {
    return `<div id="iwb-qa-root"><style>${STYLES}${MOBILE_DESIGN_STYLES}${MOBILE_CARD_STYLES}${MOBILE_WORKBENCH_STYLES}${COMBO_WORKSPACE_STYLES}${BODY_SEARCH_STYLES}${PC_WORKBENCH_STYLES}${MOBILE_POLISH_STYLES}${COMBO_NAV_STYLES}</style><div class="qa-shell">
      <header class="qa-head">
        <section class="qa-search-head" data-slot="search-head"></section><section class="qa-combo-head" data-slot="combo-head"></section><div class="qa-title-row"><div class="qa-title"><h2>世界书观测台</h2></div><button class="qa-icon qa-search-toggle" data-action="mobile-search-toggle" aria-label="搜索条目" title="搜索条目"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></button><button class="qa-icon" data-action="theme-open" aria-label="选择界面主题" title="界面主题"><i class="fa-solid fa-palette" aria-hidden="true"></i></button><button class="qa-icon" data-action="guide-open" aria-label="打开新手指引" title="新手指引"><i class="fa-solid fa-question" aria-hidden="true"></i></button><button class="qa-icon qa-mobile-close" data-action="close" aria-label="关闭世界书观测台">×</button></div>
        <div class="qa-mode-segments" role="group" aria-label="当前操作模式"><button class="qa-mode-segment is-active" data-action="mode" data-mode="edit">编辑模式</button><button class="qa-mode-segment" data-action="mode" data-mode="move">移动模式</button></div>
        <div class="qa-top-grid"><div class="qa-book-picker qa-top-left" data-control="book"><button class="qa-book-picker-trigger" data-action="book-picker-toggle" type="button" aria-haspopup="listbox" aria-expanded="false"><span data-slot="book-picker-label">选择一本具体世界书</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button><section class="qa-book-picker-popover" data-slot="book-picker-popover" hidden><input class="qa-input qa-book-picker-search" data-control="book-picker-search" type="search" placeholder="搜索世界书名称……" aria-label="搜索世界书名称"><div class="qa-book-picker-results" data-slot="book-picker-results" role="listbox" aria-label="世界书列表"></div></section></div><button class="qa-btn qa-top-right" data-action="new-entry">新建条目</button><button class="qa-btn qa-mobile-only qa-mobile-title-lock" data-action="title-lock" aria-pressed="true" aria-label="标题已锁定"><i class="fa-solid fa-lock" aria-hidden="true"></i></button><div class="qa-filter-pair qa-top-left"><input class="qa-input" data-control="search" type="search" placeholder="搜索"><select class="qa-select" data-control="state-filter-select" aria-label="显示范围"><option value="all">显示范围：全部</option><option value="selected">显示范围：仅已选</option><option value="changed">显示范围：仅已修改</option></select></div><button class="qa-btn qa-top-right" data-action="other-tools" aria-expanded="false">其它工具</button></div>
        <div class="qa-mobile-operation-row qa-mobile-only" role="group" aria-label="手机端操作栏"><button class="qa-btn qa-quick-combo" data-action="mobile-combos">快捷组合</button><button class="qa-btn" data-action="mobile-filter-toggle" aria-expanded="false">筛选</button><button class="qa-btn" data-action="mobile-arrange-toggle" aria-expanded="false">排列</button><button class="qa-btn" data-action="other-tools" aria-expanded="false">工具</button><div class="qa-mobile-density-toggle qa-mobile-only" role="group" aria-label="列表显示密度"><button data-action="card-density" data-density="compact">精简</button><span>/</span><button class="is-active" data-action="card-density" data-density="full">完整</button></div></div>

        <div class="qa-mobile-menu qa-mobile-only" data-slot="mobile-filter-menu" hidden><button class="qa-btn" data-action="mobile-filter-set" data-filter="all">全部</button><button class="qa-btn" data-action="mobile-filter-set" data-filter="selected">仅已选</button><button class="qa-btn" data-action="mobile-filter-set" data-filter="changed">仅已修改</button></div>
        <div class="qa-mobile-menu qa-mobile-only" data-slot="mobile-arrange-menu" hidden><button class="qa-btn" data-action="auto-arrange">按位置与顺序整理</button><button class="qa-btn" data-action="name-arrange">按名称整理</button><div class="qa-mobile-arrange-selection"><span>选中条目</span><button class="qa-btn" data-action="batch-move" data-direction="top">置顶</button><button class="qa-btn" data-action="batch-move" data-direction="bottom">置底</button></div><button class="qa-btn" data-action="arrange-settings">整理设置</button></div>
        <div class="qa-other-tools" data-slot="other-tools" hidden><button class="qa-btn" data-action="panel-import"><i class="fa-solid fa-file-import" aria-hidden="true"></i> 从其他书导入</button><button class="qa-btn" data-action="panel-transfer"><i class="fa-solid fa-arrow-right-arrow-left" aria-hidden="true"></i> 转移到其他书</button><div class="qa-arrange-quick" role="group" aria-label="一键整理排列"><button class="qa-btn" data-action="auto-arrange" title="按位置、深度与顺序整理">位置顺序</button><button class="qa-btn" data-action="name-arrange" title="忽略位置与顺序，仅按名称整理">名称</button></div><button class="qa-btn" data-action="arrange-settings">整理设置</button><button class="qa-btn" data-action="disable-recursion">禁止全部递归</button><button class="qa-btn" data-action="reload">重新读取当前书</button><button class="qa-btn" data-action="fault-report-copy">复制故障信息</button></div>
        <div class="qa-status" data-slot="status">正在读取世界书列表……</div>
      </header>
      <div class="qa-desktop-task-head" data-slot="desktop-task-head" hidden><strong data-slot="desktop-task-title">任务工作区</strong><div class="qa-desktop-task-direction" data-slot="desktop-task-direction"></div><button class="qa-btn qa-desktop-task-back" data-action="desktop-task-back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> 返回列表</button></div>
      <section class="qa-workspace-panel" data-slot="workspace-panel" hidden></section>
      <main class="qa-scroll" data-slot="scroll"><div class="qa-empty">请选择一本具体世界书开始编排。</div></main>
      <footer class="qa-footer" data-slot="footer"></footer>
    </div><section class="qa-content-layer" data-slot="content-editor" hidden aria-label="全屏编辑条目"><header class="qa-content-head"><button class="qa-btn" data-action="content-back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> 返回</button><div class="qa-content-context"><small><span data-slot="content-context">当前世界书 · UID</span> · Token <b data-slot="content-token">未计算</b></small></div><button class="qa-btn primary" data-action="content-done">完成</button></header><div class="qa-content-body"><div class="qa-content-paper"><section class="qa-content-paper-title" data-slot="content-title-draft"></section><section class="qa-content-paper-keys" data-slot="content-keys-draft"></section><textarea class="qa-content-textarea" data-control="content-full" aria-label="条目正文"></textarea></div></div></section>${themeHtml()}${guideHtml()}<section class="qa-leave-layer" data-slot="leave-modal" hidden aria-label="未保存修改提醒"></section></div>`;
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

  function coreEntryCardHtml(view, entry, changed, globalIndex) {
    if (!isDesktopLayout(view) && !view.moveMode) return mobileEntryCardHtml(view, entry, changed, globalIndex);
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

  function cardHtml(view, entry, changed, globalIndex) {
    const html = coreEntryCardHtml(view, entry, changed, globalIndex);
    const context = comboCardContextHtml(view, entry);
    return context ? html.replace('<section class="qa-editor"', () => context + '<section class="qa-editor"') : html;
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

  function comboWorkspaceHeaderHtml(view) {
    if (!isDesktopLayout(view)) return mobileComboHeaderHtml(view);
    const active = (view.entryGroups || []).find(group => group.id === view.comboGroupId);
    const tabs = [{ id: '__all__', name: '全部' }, { id: '__ungrouped__', name: '未分组' }, ...(view.entryGroups || [])];
    const navigation = tabs.map(group => '<button class="qa-combo-tab" data-action="combo-tab" data-group-id="' + escapeHtml(group.id) + '"' + (group.id.startsWith('__') ? '' : ' data-combo-drop-id="' + escapeHtml(group.id) + '"') + ' aria-current="' + (group.id === view.comboGroupId) + '">' + escapeHtml(group.name) + '</button>').join('');
    let controls = comboManagementHtml(view);
    return '<div class="qa-combo-titlebar"><button data-action="combo-back" aria-label="返回编辑视图">←</button><h2>快捷组合</h2><button class="qa-combo-title-lock" data-action="title-lock" aria-label="标题锁" aria-pressed="' + Boolean(view.titleLocked) + '"><i class="fa-solid fa-' + (view.titleLocked ? 'lock' : 'lock-open') + '"></i></button><button data-action="combo-new-open">＋ 新建组合</button><button data-action="theme-open" aria-label="界面主题"><i class="fa-solid fa-palette" aria-hidden="true"></i></button><button data-action="close" aria-label="关闭整个世界书观测台">×</button></div><div class="qa-combo-book">' + escapeHtml(view.book) + '' + '</div><nav class="qa-combo-tabs" aria-label="组合">' + navigation + '</nav>' + comboDensityHtml(view) + controls;
  }

  function comboCardContextHtml(view, entry) {
    if (!comboWorkspaceActive(view) || !view.expanded.has(entryId(entry))) return '';
    const id = entryId(entry), groups = view.entryGroups.filter(group => group.entryIds.includes(id)), active = view.entryGroups.find(group => group.id === view.comboGroupId);
    const chips = groups.map(group => '<span class="qa-combo-chip' + (group.id === view.comboGroupId ? ' current' : '') + '">' + escapeHtml(group.name) + '</span>').join('');
    let order = '';
    if (active) {
      const available = comboOrderedEntries(view).map(entryId), index = available.indexOf(id);
      order = '<div class="qa-combo-context-row"><span>组内顺序</span><span>第 ' + (index + 1) + ' / ' + available.length + ' 条</span><button data-action="combo-member-move" data-entry-id="' + escapeHtml(id) + '" data-direction="up"' + (index <= 0 ? ' disabled' : '') + '>上移</button><button data-action="combo-member-move" data-entry-id="' + escapeHtml(id) + '" data-direction="down"' + (index === available.length - 1 ? ' disabled' : '') + '>下移</button><button data-action="combo-member-remove" data-entry-id="' + escapeHtml(id) + '">移出本组</button></div>';
    }
    return '<div class="qa-combo-context"><div class="qa-combo-context-row"><span>所属组</span>' + chips + '<button data-action="combo-assignment-open" data-entry-id="' + escapeHtml(id) + '" aria-label="编辑所属组">＋</button></div>' + order + '</div>';
  }

  function comboAssignmentHtml(view) {
    const ids = view.comboAssignmentIds || [];
    const rows = view.entryGroups.map(group => {
      const count = ids.filter(id => group.entryIds.includes(id)).length, state = !count ? 'false' : count === ids.length ? 'true' : 'mixed';
      return '<button class="qa-combo-assignment-row" role="checkbox" aria-checked="' + state + '" data-action="combo-assignment-toggle" data-group-id="' + escapeHtml(group.id) + '"><span aria-hidden="true">' + (state === 'true' ? '✓' : state === 'mixed' ? '−' : '□') + '</span><span>' + escapeHtml(group.name) + '</span></button>';
    }).join('');
    return '<section class="qa-panel qa-combo-assignment"><h3>所属组</h3>' + rows + '<div><button class="qa-btn" data-action="combo-new-open">＋ 新建组合</button><button class="qa-btn" data-action="panel-close">完成</button></div></section>';
  }

  function footerHtml(view) {
    if (searchWorkspaceActive(view)) return searchSafetyFooterHtml(view);
    if (!isDesktopLayout(view)) return mobileFooterHtml(view);
    const summary = pendingSummary(view);
    const selected = view.selected.size;
    const taskPanel = view.panel === 'import' || view.panel === 'transfer' || view.panel === 'arrange-settings';
    const groupCreating = view.panel === 'entry-group-create';
    const groupEditing = view.mobileMode === 'group' && Boolean(view.entryGroupEditingId);
    const batchActive = view.panel === 'batch' || view.panel === 'position' || view.panel === 'order';
    const desktop = isDesktopLayout(view);
    const batchLabel = batchActive ? (desktop ? '收起面板' : '收起') : (desktop ? '批量操作' : '展开');
    const clearLabel = desktop ? '清空已选' : '清空';
    const clearState = desktop && batchActive ? 'disabled aria-disabled="true" title="请先收起批量面板"' : 'aria-disabled="false"';
    const normalSelection = (selected || batchActive) && !taskPanel && !groupCreating && view.mobileMode !== 'group';
    const selectionContext = normalSelection ? `<div class="qa-selection-context"><button class="qa-btn" data-action="entry-group-create-open">存为组合</button><button class="qa-btn" data-action="batch-panel">${batchLabel}</button><button class="qa-btn" data-action="clear-selection" ${clearState}>${clearLabel}</button></div>` : groupEditing ? `<div class="qa-selection-context qa-group-edit-actions"><button class="qa-btn" data-action="entry-group-edit-cancel">取消</button><button class="qa-btn primary" data-action="entry-group-edit-save">保存成员</button></div>` : '';
    const taskDisabled = taskPanel || view.busy;
    const ratio = view.mobileMode === 'group' && !groupEditing ? `${visibleEntries(view).length}/${view.working?.length || 0}` : `${selected}/${view.working?.length || 0}`;
    return `${selectionContext}<div class="qa-save-bar"><div class="qa-count"><span class="qa-count-desktop" data-slot="desktop-change-count">${escapeHtml(summary.text)}</span><span class="qa-count-mobile" data-slot="mobile-selection-count">${escapeHtml(ratio)}</span></div><button class="qa-btn" data-action="undo" ${!view.undo.length || taskDisabled ? 'disabled' : ''}>撤销</button><button class="qa-btn danger" data-action="discard" ${!isDirty(view) || taskDisabled ? 'disabled' : ''}>放弃</button><button class="qa-btn primary" data-action="save" ${!isDirty(view) || taskDisabled ? 'disabled' : ''}>${view.busy === 'save' ? '保存中…' : '保存全部'}</button></div>`;
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
  // P2-B03: existing presentation moved without visual or business redesign.
  // Transitional mixed-width UI only; not a shared UI for the future desktop.
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

  function renderBookPickerResults(view) {
    const results = view.root.querySelector('[data-slot="book-picker-results"]');
    if (results) results.innerHTML = bookPickerResultsHtml(view);
  }

  function renderBookOptions(view) {
    const picker = view.root.querySelector('[data-control="book"]');
    const trigger = picker?.querySelector('[data-action="book-picker-toggle"]');
    const popover = picker?.querySelector('[data-slot="book-picker-popover"]');
    const search = picker?.querySelector('[data-control="book-picker-search"]');
    const label = picker?.querySelector('[data-slot="book-picker-label"]');
    if (!picker || !trigger || !popover) return;
    const lockedPanel = view.panel === 'arrange-settings' || view.panel === 'transfer' || view.panel === 'import';
    const disabled = Boolean(view.busy || lockedPanel);
    if (disabled) view.bookPickerOpen = false;
    trigger.disabled = disabled;
    trigger.setAttribute('aria-disabled', String(disabled));
    trigger.setAttribute('aria-expanded', String(Boolean(view.bookPickerOpen)));
    picker.classList.toggle('is-locked', disabled);
    picker.classList.toggle('qa-source-locked', view.panel === 'transfer' || view.panel === 'import');
    picker.title = view.panel === 'import' ? '请先退出从其他书导入' : view.panel === 'transfer' ? '请先退出跨书转移' : view.panel === 'arrange-settings' ? '请先保存或取消整理设置' : '';
    popover.hidden = !view.bookPickerOpen;
    if (label) { label.textContent = bookPickerTriggerLabel(view); label.title = label.textContent; }
    if (search && search.value !== (view.bookPickerQuery || '')) search.value = view.bookPickerQuery || '';
    const width = Number(view.root?.getBoundingClientRect?.().width || 0);
    if (view.bookPickerOpen && width > 0 && width <= 480) {
      const rect = trigger.getBoundingClientRect();
      const viewportHeight = Number(hostWindow().visualViewport?.height || hostWindow().innerHeight || 0);
      popover.style.top = Math.max(8, Math.round(rect.bottom + 5)) + 'px';
      popover.style.maxHeight = Math.max(160, Math.round(viewportHeight - rect.bottom - 15)) + 'px';
    } else {
      popover.style.removeProperty('top');
      popover.style.removeProperty('max-height');
    }
    renderBookPickerResults(view);
  }

  function renderStatus(view) {
    const node = view.root.querySelector('[data-slot="status"]');
    node.classList.remove('qa-status-redundant');
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
      node.classList.add('qa-status-redundant');
    }
  }

  function renderArrangeDraft(view, scrollTop = null) {
    const previous = scrollTop ?? Number(view.root?.querySelector?.('.qa-arrange-list')?.scrollTop || 0);
    renderDynamic(view, { list: true });
    const list = view.root?.querySelector?.('.qa-arrange-list');
    if (list) list.scrollTop = Math.min(previous, Math.max(0, list.scrollHeight - list.clientHeight));
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


  function legacySyncFooterState(view) {
    if (!isDesktopLayout(view)) { renderFooter(view); return; }
    const footer = view.root.querySelector('[data-slot="footer"]');
    const summary = pendingSummary(view);
    const count = footer?.querySelector('[data-slot="desktop-change-count"]');
    if (count) count.textContent = summary.text;
    const mobileCount = footer?.querySelector('[data-slot="mobile-selection-count"]');
    if (mobileCount) mobileCount.textContent = `${view.selected.size}/${view.working?.length || 0}`;
    const mobileSummary = footer?.querySelector('[data-slot="mobile-change-summary"]');
    if (mobileSummary) mobileSummary.textContent = mobilePendingSummary(view, summary);
    const undo = footer?.querySelector('[data-action="undo"]');
    const discard = footer?.querySelector('[data-action="discard"]');
    const save = footer?.querySelector('[data-action="save"]');
    if (undo) undo.disabled = !view.undo.length || Boolean(view.busy);
    if (discard) discard.disabled = !isDirty(view) || Boolean(view.busy);
    if (save) save.disabled = !isDirty(view) || Boolean(view.busy);
  }

  function legacySyncTopControls(view) {
    const search = view.root.querySelector('[data-control="search"]');
    if (search) search.value = view.query || '';
    const state = view.root.querySelector('[data-control="state-filter-select"]');
    if (state) state.value = view.stateFilter || 'all';
  }
  // P2-B03: existing presentation moved without visual or business redesign.
  // Transitional mixed-width UI only; not a shared UI for the future desktop.
  function legacyRenderList(view, preserveScroll = true) {
    if (searchWorkspaceActive(view)) { const scroll = view.root.querySelector('[data-slot="scroll"]'); scroll.innerHTML = searchWorkspaceResultHtml(view); if (!preserveScroll) scroll.scrollTop = 0; return; }
    const scroll = view.root.querySelector('[data-slot="scroll"]');
    const oldTop = preserveScroll ? scroll.scrollTop : 0;
    scroll.classList?.toggle('qa-import-mode', view.panel === 'import' || view.panel === 'transfer' || view.panel === 'arrange-settings');
    scroll.classList?.toggle('qa-group-mode-list', view.mobileMode === 'group');
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
    const context = comboWorkspaceActive(view) ? '' : view.mobileMode === 'group' ? groupModeBarHtml(view) : listContextHtml(view, entries);
    scroll.innerHTML = `${context}<div class="qa-list">${rendered.map(entry => cardHtml(view, entry, changed, globalIndex.get(entryId(entry)))).join('')}</div>${limit < entries.length ? `<button class="qa-more" data-action="more">继续显示（剩余 ${entries.length - limit} 条）</button>` : entries.length ? '' : '<div class="qa-empty">当前视图没有条目。</div>'}`;
    scroll.scrollTop = Math.min(oldTop, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
    scheduleTokenCounts(view, rendered);
  }

  function legacyRenderPanel(view) {
    if (view.panel === 'combo-assignment') return comboAssignmentHtml(view);
    if (view.panel === 'combo-new') return '<section class="qa-panel"><h3>新建组合</h3><input class="qa-input" data-control="entry-group-name" maxlength="60" placeholder="组合名称" value="' + escapeHtml(view.entryGroupNameDraft || '') + '"><button class="qa-btn" data-action="panel-close">取消</button><button class="qa-btn" data-action="combo-new-create">创建</button></section>';
    if (view.panel === 'entry-group-rename') return '<section class="qa-panel"><h3>重命名组合</h3><input class="qa-input" data-control="entry-group-name" maxlength="60" value="' + escapeHtml(view.entryGroupNameDraft || '') + '"><button class="qa-btn" data-action="panel-close">取消</button><button class="qa-btn" data-action="entry-group-rename">完成</button></section>';
    if (!isDesktopLayout(view) && view.panel === 'batch') return mobileBatchPanelHtml(view);
    if (view.panel === 'entry-group-create') {
      return `<section class="qa-panel qa-entry-group-create-panel"><input class="qa-input" data-control="entry-group-name" maxlength="60" placeholder="组合名称" value="${escapeHtml(view.entryGroupNameDraft || '')}"><div><button class="qa-btn" data-action="entry-group-create-cancel">取消</button><button class="qa-btn primary" data-action="entry-group-save">保存组合</button></div></section>`;
    }
    if (view.panel === 'entry-groups') {
      const rows = (view.entryGroups || []).map(group => {
        const membership = entryGroupMembership(view.working, group);
        const stale = membership.missingCount ? ` · 缺少 ${membership.missingCount} 条` : '';
        return `<article class="qa-entry-group" data-group-id="${escapeHtml(group.id)}"><div class="qa-entry-group-summary"><strong title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</strong><small>${membership.existingIds.length} 条${stale}</small></div><div class="qa-entry-group-actions"><button class="qa-btn" data-action="entry-group-select" data-group-id="${escapeHtml(group.id)}">选中</button><button class="qa-btn" data-action="entry-group-enabled" data-enabled="true" data-group-id="${escapeHtml(group.id)}">启用</button><button class="qa-btn" data-action="entry-group-enabled" data-enabled="false" data-group-id="${escapeHtml(group.id)}">停用</button><button class="qa-btn" data-action="entry-group-rename-open" data-group-id="${escapeHtml(group.id)}">改名</button><button class="qa-btn danger" data-action="entry-group-delete" data-group-id="${escapeHtml(group.id)}">删除</button></div></article>`;
      }).join('');
      return `<section class="qa-panel qa-entry-groups-panel"><div class="qa-entry-groups-head"><div><h3>快捷组合</h3><div class="qa-panel-note">组合只保存在本机；启用／停用先修改工作副本，点击“保存全部”后生效。</div></div><button class="qa-btn" data-action="panel-close">返回列表</button></div><div class="qa-entry-group-create"><input class="qa-input" data-control="entry-group-name" maxlength="60" placeholder="组合名称，例如：NSFW 常用" value="${escapeHtml(view.entryGroupNameDraft || '')}"><button class="qa-btn primary" data-action="entry-group-save">存为组合（${view.selected.size}）</button></div><div class="qa-entry-group-list">${rows || '<div class="qa-empty">这本世界书还没有快捷组合。先返回列表选择条目，再保存为组合。</div>'}</div></section>`;
    }
    /* IWB_BATCH_DELETE_PANEL_BEGIN */
    if (view.panel === 'batch') return `<section class="qa-panel qa-batch-panel"><h3 class="qa-batch-title">批量操作 · 已选 ${view.selected.size} 条</h3><div class="qa-batch-groups"><section class="qa-batch-group"><div class="qa-batch-group-label"><strong>状态与字段</strong><small>批量启停或修改原生字段</small></div><div class="qa-batch-status"><button class="qa-btn" data-action="batch-enabled" data-enabled="true">批量启用</button><button class="qa-btn" data-action="batch-enabled" data-enabled="false">批量停用</button></div><div class="qa-batch-primary"><button class="qa-btn" data-action="panel-position">改位置</button><button class="qa-btn" data-action="panel-order">改顺序</button></div></section><section class="qa-batch-group"><div class="qa-batch-group-label"><strong>移动操作</strong><small>调整当前列表排列</small></div><div class="qa-batch-moves"><button class="qa-btn" data-action="batch-move" data-direction="up">上移</button><button class="qa-btn" data-action="batch-move" data-direction="down">下移</button><button class="qa-btn" data-action="batch-move" data-direction="top">置顶</button><button class="qa-btn" data-action="batch-move" data-direction="bottom">置底</button></div></section><section class="qa-batch-group qa-batch-danger-group"><div class="qa-batch-group-label"><strong>危险操作</strong><small>只修改工作副本，可撤销</small></div><button class="qa-btn danger qa-batch-delete-wide" data-action="batch-delete">批量删除</button></section></div></section>`;
    /* IWB_BATCH_DELETE_PANEL_END */
    if (view.panel === 'import') return '';
    if (view.panel === 'arrange-settings') {
      const rows = view.arrangeDraft.map((track, index) => `<div class="qa-arrange-row${view.arrangeFlashIndex === index ? ' is-flash-moved' : ''}" data-arrange-index="${index}"><button type="button" class="qa-arrange-drag-handle" draggable="true" data-action="arrange-drag" data-index="${index}" aria-label="拖动轨道：${escapeHtml(track.label)}" title="拖动重排轨道">☰</button><div class="qa-arrange-label"><span>${escapeHtml(track.label)} · ${track.count} 条${track.isNew ? ' · 新增' : ''}</span></div><select class="qa-select" data-control="arrange-direction" data-index="${index}"><option value="asc"${track.direction === 'asc' ? ' selected' : ''}>从小到大</option><option value="desc"${track.direction === 'desc' ? ' selected' : ''}>从大到小</option></select><div class="qa-arrange-arrows"><button class="qa-btn" data-action="arrange-group-up" data-index="${index}" ${index === 0 ? 'disabled' : ''}>↑</button><button class="qa-btn" data-action="arrange-group-down" data-index="${index}" ${index === view.arrangeDraft.length - 1 ? 'disabled' : ''}>↓</button></div></div>`).join('');
      const scope = view.mixedMode ? '总览' : '本书';
      return `<section class="qa-panel qa-arrange-settings-panel">${nameArrangeSettingsHtml(view)}<div class="qa-arrange-list"${view.nameArrangeDraft?.mode === 'name' ? ' hidden' : ''}>${rows || `<div class="qa-empty">${scope}没有可整理条目。</div>`}</div><div class="qa-footer-row"><button class="qa-btn qa-arrange-reset" data-action="reset-arrange-settings" ${arrangeDraftChanged(view) ? '' : 'disabled aria-disabled="true"'}>还原</button><button class="qa-btn" data-action="save-arrange-settings">仅保存设置</button><button class="qa-btn primary" data-action="save-and-arrange">保存并整理</button><button class="qa-btn qa-arrange-return" data-action="panel-close">返回列表</button></div></section>`;
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

  function legacyRenderWorkspacePanel(view) {
    const panel = view.root.querySelector('[data-slot="workspace-panel"]');
    if (!panel) return;
    if (view.panel === 'import' || view.panel === 'transfer' || view.panel === 'arrange-settings') { panel.innerHTML = ''; panel.hidden = true; return; }
    const html = renderPanel(view);
    const namingDialog = !isDesktopLayout(view) && view.panel === 'entry-group-create';
    panel.classList.toggle('qa-group-name-dialog', namingDialog);
    if (namingDialog) { panel.setAttribute?.('role', 'dialog'); panel.setAttribute?.('aria-modal', 'true'); panel.setAttribute?.('aria-label', '存为组合'); } else { panel.removeAttribute?.('role'); panel.removeAttribute?.('aria-modal'); panel.removeAttribute?.('aria-label'); }
    panel.classList.toggle('qa-batch-workspace', view.panel === 'batch' || view.panel === 'position' || view.panel === 'order');
    panel.innerHTML = html;
    panel.hidden = !html;
  }

  function legacyRenderFooter(view) {
    const footer = view.root.querySelector('[data-slot="footer"]');
    footer.innerHTML = footerHtml(view);
    const taskFooter = view.panel === 'import' || view.panel === 'transfer' || view.panel === 'arrange-settings';
    footer.classList.toggle('qa-footer-has-selection', view.selected.size > 0 && !taskFooter);
    footer.classList.toggle('qa-footer-task-active', taskFooter);
    view.root.classList.toggle('qa-loading', Boolean(view.busy));
    renderWorkspacePanel(view);
    renderLeaveModal(view);
  }

  function legacyRenderLeaveModal(view) {
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

  function renderLegacyDynamic(view, { list = false, resetScroll = false } = {}) {
    view.root.classList.toggle('qa-search-workspace', searchWorkspaceActive(view));
    const searchHead = view.root.querySelector('[data-slot="search-head"]');
    if (searchHead) searchHead.innerHTML = searchWorkspaceActive(view) ? searchWorkspaceHeaderHtml(view) : '';
    const phone = !isDesktopLayout(view);
    if (phone || isWideDesktopLayout(view)) view.moveMode = false;
    if (comboWorkspaceActive(view) && !['__all__', '__ungrouped__'].includes(view.comboGroupId) && !view.entryGroups.some(group => group.id === view.comboGroupId)) view.comboGroupId = '__all__';
    view.root.classList.toggle('qa-combo-workspace', comboWorkspaceActive(view));
    captureComboNavScroll(view);
    const comboHead = view.root.querySelector('[data-slot="combo-head"]');
    if (comboHead) comboHead.innerHTML = comboWorkspaceActive(view) ? comboWorkspaceHeaderHtml(view) : '';
    restoreComboNavScroll(view,Boolean(view.comboNavEnsureActive)); view.comboNavEnsureActive=false;
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
    const groupActive = view.mobileMode === 'group';
    view.root.classList.toggle('qa-import-active', importActive || transferActive);
    view.root.classList.toggle('qa-transfer-active', transferActive);
    view.root.classList.toggle('qa-arrange-active', arrangeActive);
    view.root.classList.toggle('qa-group-mode', groupActive);
    view.root.classList.toggle('qa-group-member-editing', groupActive && Boolean(view.entryGroupEditingId));
    const desktopTaskActive = importActive || transferActive || arrangeActive;
    view.root.classList.toggle('qa-desktop-task-active', desktopTaskActive);
    view.root.classList.toggle('qa-move-mode', view.moveMode);
    view.root.classList.toggle('qa-mobile-search-open', Boolean(view.searchOpen));
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
    const mobileMode = view.root.querySelector('[data-action="mobile-mode-menu-toggle"]');
    if (mobileMode) { mobileMode.textContent = view.mobileMode === 'group' ? '组合中' : view.moveMode ? '移动中' : '编辑中'; mobileMode.classList.toggle('is-active', view.mobileMode !== 'edit'); mobileMode.setAttribute('aria-expanded', String(view.mobileMenu === 'mode')); }
    const modeMenu = view.root.querySelector('[data-slot="mobile-mode-menu"]');
    if (modeMenu) { modeMenu.hidden = view.mobileMenu !== 'mode' || desktopTaskActive; modeMenu.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('is-active', button.dataset.mode === view.mobileMode)); }
    const mobileFilter = view.root.querySelector('[data-action="mobile-filter-toggle"]');
    if (mobileFilter) { mobileFilter.classList.toggle('is-active', view.stateFilter !== 'all' || view.mobileMenu === 'filter'); mobileFilter.setAttribute('aria-expanded', String(view.mobileMenu === 'filter')); }
    const mobileArrange = view.root.querySelector('[data-action="mobile-arrange-toggle"]');
    if (mobileArrange) { mobileArrange.classList.toggle('is-active', view.mobileMenu === 'arrange'); mobileArrange.setAttribute('aria-expanded', String(view.mobileMenu === 'arrange')); }
    const mobileSearch = view.root.querySelector('[data-action="mobile-search-toggle"]');
    if (mobileSearch) { mobileSearch.classList.toggle('is-active', Boolean(view.searchOpen)); mobileSearch.setAttribute('aria-expanded', String(Boolean(view.searchOpen))); }
    const filterMenu = view.root.querySelector('[data-slot="mobile-filter-menu"]');
    if (filterMenu) { filterMenu.hidden = view.mobileMenu !== 'filter' || desktopTaskActive; filterMenu.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('is-active', button.dataset.filter === view.stateFilter)); }
    const arrangeMenu = view.root.querySelector('[data-slot="mobile-arrange-menu"]');
    if (arrangeMenu) arrangeMenu.hidden = view.mobileMenu !== 'arrange' || desktopTaskActive;
    const tools = view.root.querySelector('[data-slot="other-tools"]');
    if (tools) tools.hidden = importActive || transferActive || arrangeActive || !view.toolsOpen;
    view.root.querySelectorAll('[data-action="other-tools"]').forEach(button => { button.setAttribute('aria-expanded', String(view.toolsOpen)); button.classList.toggle('is-active', view.toolsOpen); });
    const stateSelect = view.root.querySelector('[data-control="state-filter-select"]');
    if (stateSelect) stateSelect.value = view.stateFilter;
    const titleLocks = view.root.querySelectorAll('[data-action="title-lock"]');
    const titleLock = view.root.querySelector('[data-action="title-lock"]');
    titleLocks.forEach(button => { button.setAttribute('aria-pressed',String(view.titleLocked)); button.setAttribute('aria-label',view.titleLocked ? '标题已锁定' : '标题可编辑'); button.innerHTML='<i class="fa-solid fa-'+(view.titleLocked ? 'lock' : 'lock-open')+'"></i>'; });
    if (titleLock) {
      titleLock.textContent = view.titleLocked ? '🔒标题' : '🔓标题';
      titleLock.setAttribute('aria-pressed', String(view.titleLocked));
      titleLock.classList.toggle('is-active', view.titleLocked);
    }
    if (phone) {
      if (topAction && !view.mixedMode) topAction.textContent = '＋ 新建条目';
      if (titleLock) { titleLock.innerHTML = '<i class="fa-solid fa-' + (view.titleLocked ? 'lock' : 'lock-open') + '" aria-hidden="true"></i>'; titleLock.setAttribute('aria-label', view.titleLocked ? '标题已锁定' : '标题可编辑'); }
      const combo = view.root.querySelector('[data-action="mobile-combos"]');
      if (combo) { combo.disabled = view.mixedMode || !view.book; combo.classList.toggle('is-active', comboWorkspaceActive(view)); combo.textContent = groupActive ? '返回编辑' : '快捷组合'; }
      const recursion = view.root.querySelector('[data-action="disable-recursion"]');
      if (recursion) { recursion.hidden = view.mixedMode; recursion.textContent = '禁止当前书全部递归'; }
    }
    syncWideDesktopWorkbench(view);
    if (list) renderList(view, !resetScroll);
    renderFooter(view);
  }

  function createLegacyUiParts() {
    return Object.freeze({
      list: legacyRenderList,
      panel: legacyRenderPanel,
      workspacePanel: legacyRenderWorkspacePanel,
      footer: legacyRenderFooter,
      leaveModal: legacyRenderLeaveModal,
      action: legacyHandleAction,
      bind: legacyBindView,
      syncFooterState: legacySyncFooterState,
      syncTopControls: legacySyncTopControls,
    });
  }
  // P2-B03: existing presentation moved without visual or business redesign.
  // Transitional mixed-width UI only; not a shared UI for the future desktop.
  async function legacyHandleAction(view, action, target) {
    view.cardContentInput = null; view.cardContentUndo = null;
    if (action === 'combo-nav-toggle') { captureComboNavScroll(view); view.comboNavExpanded=!view.comboNavExpanded; if(!view.comboNavExpanded)view.comboNavArrange=false; renderDynamic(view); return; }
    if (action === 'combo-nav-arrange') { view.comboNavArrange=!view.comboNavArrange; view.comboNavExpanded=true; renderDynamic(view); return; }
    if (action === 'combo-group-drag') return;
    if (action === 'search-back') { closeSearchWorkspace(view);
    } else if (action === 'search-kind') { view.searchKind = target.dataset.kind === 'body' ? 'body' : 'metadata'; renderDynamic(view, {list: true, resetScroll: true});
    } else if (action === 'body-replace-results') { replaceBodySearchResults(view);
    } else if (action === 'combo-back') {
      closeComboWorkspace(view);
    } else if (action === 'combo-tab') {
      if(view.comboNavArrange)return;
      view.comboNavExpanded=false;view.comboNavEnsureActive=true;
      view.comboGroupId = target.dataset.groupId; view.comboMore = false; view.panel = null; view.selected.clear(); renderDynamic(view, { list: true, resetScroll: true });
    } else if (action === 'combo-more') {
      view.comboMore = !view.comboMore; renderDynamic(view);
    } else if (action === 'combo-new-open') {
      view.entryGroupNameDraft = ''; view.panel = 'combo-new'; renderFooter(view);
    } else if (action === 'combo-new-create') {
      const result = upsertEntryGroup(view.entryGroups, view.entryGroupNameDraft, []);
      applyGroupRelations(view, '新建空组合', result.groups); toastComboCreated(result.group.name); view.comboNavExpanded=false; view.comboNavArrange=false; view.comboNavEnsureActive=true; view.panel = null; view.comboGroupId = result.group.id; view.selected.clear(); renderDynamic(view, { list: true });
    } else if (action === 'combo-assignment-open') {
      view.comboAssignmentIds = target.dataset.entryId ? [target.dataset.entryId] : comboSelectedIds(view); view.panel = 'combo-assignment'; renderFooter(view);
    } else if (action === 'combo-assignment-toggle') {
      const group = view.entryGroups.find(group => group.id === target.dataset.groupId), ids = view.comboAssignmentIds || [];
      if (group) addEntriesToGroup(view, group.id, ids, ids.length > 0 && ids.every(id => group.entryIds.includes(id))); renderDynamic(view, { list: true });
    } else if (action === 'combo-member-move') {
      moveComboMember(view, target.dataset.entryId, target.dataset.direction); renderDynamic(view, { list: true });
    } else if (action === 'combo-member-remove') {
      addEntriesToGroup(view, view.comboGroupId, [target.dataset.entryId], true); renderDynamic(view, { list: true });
    } else if (action === 'entry-group-rename-open') {
      const group = view.entryGroups.find(group => group.id === target.dataset.groupId);
      if (!group) return; view.entryGroupRenameId = group.id; view.entryGroupNameDraft = group.name; view.panel = 'entry-group-rename'; renderFooter(view);
    } else if (action === 'entry-group-rename') {
      renameEntryGroup(view, view.entryGroupRenameId, view.entryGroupNameDraft); view.panel = null; view.entryGroupRenameId = null; view.entryGroupNameDraft = ''; renderDynamic(view, { list: true });
    } else if (action === 'mobile-combos') {
      openMobileCombos(view);
    } else if (action === 'card-density') {
      view.cardDensity = target.dataset.density === 'compact' ? 'compact' : 'full';
      view.root.querySelectorAll('[data-action="card-density"]').forEach(button => button.classList.toggle('is-active', button.dataset.density === view.cardDensity));
      renderList(view, true);
    } else if (action === 'close') {
      if (!showLeavePrompt(view, { kind: 'close' })) { view.forceClose = true; await view.popup.completeCancelled(); }

    } else if (action === 'book-picker-toggle') {
      toggleBookPicker(view);
    } else if (action === 'book-picker-select') {
      requestBookSwitch(view, target.dataset.bookValue || '');
    } else if (action === 'mode') {
      view.moveMode = target.dataset.mode === 'move';
      renderDynamic(view, { list: true });
    } else if (action === 'mobile-mode-menu-toggle') {
      if (!isDesktopLayout(view)) return;
      view.mobileMenu = view.mobileMenu === 'mode' ? null : 'mode';
      view.toolsOpen = false;
      renderDynamic(view);
    } else if (action === 'mobile-mode-set') {
      if (!isDesktopLayout(view)) return;
      const mode = ['move', 'group'].includes(target.dataset.mode) ? target.dataset.mode : 'edit';
      if (mode === 'group' && (view.mixedMode || !view.book)) throw new Error('组合模式只能用于一本具体世界书。');
      view.mobileMode = mode;
      view.moveMode = mode === 'move';
      view.mobileMenu = null;
      view.toolsOpen = false;
      view.panel = null;
      view.entryGroupEditingId = null;
      view.selected.clear();
      renderDynamic(view, { list: true, resetScroll: true });
    } else if (action === 'mobile-search-toggle') {
      openSearchWorkspace(view); target.blur?.();
    } else if (action === 'mobile-filter-toggle') {
      view.mobileMenu = view.mobileMenu === 'filter' ? null : 'filter';
      view.toolsOpen = false;
      renderDynamic(view);
    } else if (action === 'mobile-arrange-toggle') {
      view.mobileMenu = view.mobileMenu === 'arrange' ? null : 'arrange';
      view.toolsOpen = false;
      renderDynamic(view);
    } else if (action === 'mobile-filter-set') {
      view.stateFilter = ['selected', 'changed'].includes(target.dataset.filter) ? target.dataset.filter : 'all';
      view.mobileMenu = null;
      view.renderLimit = APP.chunkSize;
      renderDynamic(view, { list: true, resetScroll: true });
    } else if (action === 'title-lock') {
      view.titleLocked = !view.titleLocked;
      renderDynamic(view, { list: true });
    } else if (action === 'other-tools') {
      view.toolsOpen = !view.toolsOpen;
      view.mobileMenu = null;
      renderDynamic(view);
    } else if (action === 'theme-open') {
      openThemePicker(view);
    } else if (action === 'theme-close') {
      closeThemePicker(view);
    } else if (action === 'theme-select') {
      const nextTheme = target.dataset.themeChoice;
      applyTheme(view, nextTheme, true);
      closeThemePicker(view);
      toast('success', nextTheme === 'wisteria-moon' ? '已切换为藤月烟粉。' : '已切换为雾墨青蓝。');
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
    } else if (action === 'mobile-group-exit') {
      view.mobileMode = 'edit';
      view.moveMode = false;
      view.entryGroupEditingId = null;
      view.selected.clear();
      renderDynamic(view, { list: true, resetScroll: true });
    } else if (action === 'entry-group-view') {
      view.activeEntryGroupId = target.dataset.groupId || '__ungrouped__';
      view.entryGroupEditingId = null;
      view.selected.clear();
      renderDynamic(view, { list: true, resetScroll: true });
    } else if (action === 'entry-group-create-open') {
      if (view.mixedMode || !view.book || !view.selected.size) throw new Error('请先选择要保存为组合的条目。');
      view.entryGroupNameDraft = '';
      view.panel = 'entry-group-create';
      renderFooter(view);
      legacyUiFrame(view, () => view.root.querySelector('[data-control="entry-group-name"]')?.focus?.({ preventScroll: true }));
    } else if (action === 'entry-group-create-cancel') {
      view.panel = null;
      view.entryGroupNameDraft = '';
      renderFooter(view);
    } else if (action === 'entry-group-edit-members') {
      const result = selectEntryGroup(view, target.dataset.groupId);
      view.entryGroupEditingId = result.group.id;
      view.activeEntryGroupId = result.group.id;
      renderDynamic(view, { list: true, resetScroll: true });
    } else if (action === 'entry-group-edit-cancel') {
      view.entryGroupEditingId = null;
      view.selected.clear();
      renderDynamic(view, { list: true });
    } else if (action === 'entry-group-edit-save') {
      const result = saveEditedEntryGroup(view);
      renderDynamic(view, { list: true });
      toast('success', `已更新“${result.group.name}”的成员。`);
    } else if (action === 'entry-groups-open') {
      if (view.mixedMode || !view.book) throw new Error('快捷组合只能用于一本具体世界书。');
      openComboWorkspace(view);
    } else if (action === 'entry-group-save') {
      const result = createOrUpdateEntryGroup(view);
      const mobileCreating = view.panel === 'entry-group-create';
      if (mobileCreating) { view.panel = null; renderDynamic(view, { list: true }); }
      else renderFooter(view);
      if(result.updated)toast('success', `已更新组合“${result.group.name}”。`);else toastComboCreated(result.group.name);
    } else if (action === 'entry-group-select') {
      const result = selectEntryGroup(view, target.dataset.groupId);
      view.panel = null; renderDynamic(view, { list: true });
      toast('info', `已选中“${result.group.name}”的 ${result.existingIds.length} 条；缺少 ${result.missingCount} 条。`);
    } else if (action === 'entry-group-enabled') {
      setEntryGroupEnabled(view, target.dataset.groupId, target.dataset.enabled === 'true');
    } else if (action === 'entry-group-delete') {
      const group = (view.entryGroups || []).find(candidate => candidate.id === String(target.dataset.groupId));
      applyGroupRelations(view, '删除组合', removeEntryGroup(view.entryGroups, target.dataset.groupId));
      if (view.activeEntryGroupId === target.dataset.groupId) view.activeEntryGroupId = view.entryGroups[0]?.id || '__ungrouped__';
      view.entryGroupEditingId = null;
      view.selected.clear();
      renderDynamic(view, { list: true });
      toast('info', group ? `已删除组合“${group.name}”。` : '这个组合已不存在。');
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
      applyWorking(view, '复制条目', () => result.entries, { copySourceId: id, copyId: result.id });
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
      if (snapshot) { if (snapshot.kind === 'transfer') restoreTransferSnapshot(view, snapshot); else view.working = snapshot.working; if (snapshot.entryGroups) view.entryGroups = cloneJson(snapshot.entryGroups); renderDynamic(view, { list: true }); toast('info', `已撤销：${snapshot.label}`); }
    } else if (action === 'discard') {
      if (!isDirty(view) || view.busy) return;
      if (!isDesktopLayout(view)) return handleAction(view, 'discard-confirm-accept', target);
      view.discardConfirmOpen = true;
      renderLeaveModal(view);
    } else if (action === 'discard-confirm-cancel') {
      view.discardConfirmOpen = false;
      renderLeaveModal(view);
    } else if (action === 'discard-confirm-accept') {
      if (view.transferStates?.size) discardTransferChanges(view); else { view.working = cloneJson(view.baseline); view.undo = []; }
      view.entryGroups = cloneJson(view.entryGroupBaseline || []);
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
      if (comboWorkspaceActive(view)) { moveComboSelection(view, comboSelectedIds(view), target.dataset.direction); renderDynamic(view, {list: true}); }
      else applyWorking(view, '批量调整列表排列', () => moveEntries(view.working, [...view.selected], target.dataset.direction));
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
      view.mobileMenu = null;
      const rules = view.mixedMode ? loadMixedArrangeRules() : loadArrangeRules(view.book);
      if (view.mixedMode) {
        const changed = applyWorking(view, '整理多书合并工作副本', () => arrangeMixedWorking(view.working, rules), { noOpMessage: '总览已经符合总览整理设置。' });
        if (changed) {
          const books = mixedDirtyBooks(view).length;
          toast('success', books ? '已整理总览；' + books + ' 本书产生未保存的列表排列修改。' : '已整理总览排列；世界书内容未修改。');
        }
      } else applyWorking(view, '一键整理列表排列', () => stableAutoArrange(view.working, rules), { noOpMessage: '本书列表已经符合整理设置。' });
    } else if (action === 'name-arrange') {
      view.mobileMenu = null;
      applyWorking(view, '按名称整理列表排列', () => arrangeNamesByDirection(view.working,readNameArrangePreference(view).direction), { noOpMessage: '当前列表已经符合名称顺序。' });
    } else if (action === 'arrange-settings') {
      view.mobileMenu = null;
      view.arrangeDraft = view.mixedMode ? effectiveMixedArrangeRules(view.working, loadMixedArrangeRules()) : effectiveArrangeRules(view.working, loadArrangeRules(view.book));
      view.arrangeInitialDraft = cloneJson(view.arrangeDraft);
      view.nameArrangeDraft = readNameArrangePreference(view);
      view.nameArrangeInitialDraft = cloneJson(view.nameArrangeDraft);
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
      saveNameArrangePreference(view);
      if (view.mixedMode) saveMixedArrangeRules(view.arrangeDraft); else saveArrangeRules(view.book, view.arrangeDraft);
      const scope = view.mixedMode ? '总览' : '本书';
      clearTimeout(view.arrangeFlashTimer); clearArrangeDragFeedback(view); view.arrangeInitialDraft = null; view.arrangeDrag = null; view.arrangeFlashIndex = null; view.arrangeFlashTimer = null;
      view.panel = null; renderDynamic(view, { list: true }); toast('success', '已保存' + scope + '整理设置，列表排列未改变。');
    } else if (action === 'save-and-arrange') {
      const namePrefs = saveNameArrangePreference(view);
      const rules = view.mixedMode ? saveMixedArrangeRules(view.arrangeDraft) : saveArrangeRules(view.book, view.arrangeDraft);
      const mixed = view.mixedMode;
      clearTimeout(view.arrangeFlashTimer); clearArrangeDragFeedback(view); view.arrangeInitialDraft = null; view.arrangeDrag = null; view.arrangeFlashIndex = null; view.arrangeFlashTimer = null;
      view.panel = null;
      const changed = applyWorking(view, mixed ? '按总览设置整理多书合并工作副本' : '按本书设置整理列表排列', () => namePrefs.mode === 'name' ? arrangeNamesByDirection(view.working,namePrefs.direction) : mixed ? arrangeMixedWorking(view.working, rules) : stableAutoArrange(view.working, rules), { noOpMessage: mixed ? '总览已经符合总览整理设置。' : '本书列表已经符合整理设置。' });
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
  // P2-B03: existing presentation moved without visual or business redesign.
  // Transitional mixed-width UI only; not a shared UI for the future desktop.
  function legacyBindView(view) {
    const root = view.root;
    if (view.legacyEventsBound) return;
    const resources = ensureLegacyUiSession(view).resources;
    view.legacyEventsBound = true;
    resources.own(() => { view.legacyEventsBound = false; });
    const listen = resources.listen;
    listen(root, 'pointerdown',event=>{const handle=event.target.closest?.('[data-action="combo-group-drag"]');if(handle)startComboNavDrag(view,event,handle);});
    listen(root, 'pointermove',event=>moveComboNavDrag(view,event));
    listen(root, 'pointerup',event=>endComboNavDrag(view,event));
    listen(root, 'pointercancel',event=>endComboNavDrag(view,event,true));
    const blockBookPointer = event => blockTransferBookControl(view, event, event.type === 'pointerdown');
    listen(root, 'pointerdown', blockBookPointer, true);
    listen(root, 'touchstart', blockBookPointer, { capture: true, passive: false });
    listen(root, 'click', blockBookPointer, true);
    listen(root, 'click', event => {
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
      if (view.bookPickerOpen && !event.target.closest?.('.qa-book-picker')) closeBookPicker(view, false);
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
    listen(root, 'keydown', event => {
      if (view.bookPickerOpen && event.key === 'Escape') { event.preventDefault(); closeBookPicker(view, true); return; }
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
    listen(root, 'focusout', event => {
      const control = event.target.dataset.control;
      if (control === 'entry-content') { view.cardContentInput = null; view.cardContentUndo = null; return; }
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
    listen(root, 'input', event => {
      const control = event.target.dataset.control;
      if (control === 'entry-content') { commitCardContentInput(view, event.target); return; }
      if (control === 'content-full' && view.contentEditor) {
        view.contentEditor.draft = event.target.value;
        scheduleContentEditorToken(view);
      }
      if (control === 'content-name-full' && view.contentEditor) view.contentEditor.nameDraft = event.target.value;
      if (control === 'content-key-input' && view.contentEditor) view.contentEditor.keyInputDraft = event.target.value;
      if (control === 'search') scheduleSearch(view, event.target.value);
      if (control === 'body-search-find' || control === 'body-search-replace') updateBodySearchInput(view, control, event.target.value);
      if (control === 'book-picker-search') { view.bookPickerQuery = event.target.value; renderBookPickerResults(view); }
      if (control === 'entry-group-name') view.entryGroupNameDraft = event.target.value;
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
    listen(root, 'change', event => {
      try {
        const control = event.target.dataset.control;
        const card = event.target.closest?.('.qa-card');
        const cardId = card?.dataset.entryId;
        if (control === 'import-source') {
        Promise.resolve(loadImportSource(view, event.target.value)).catch(error => toast('error', error instanceof Error ? error.message : String(error), '来源书读取失败'));

      } else if (control === 'transfer-target-select') {
        view.transferDraft.target = event.target.value; renderTransferSelection(view, true);
      } else if (control === 'import-filter') {
        view.importDraft.filter = event.target.value; renderImportSelection(view, false);
      } else if (control === 'transfer-filter') {
        view.transferDraft.filter = event.target.value; renderTransferSelection(view, false);
      } else if (control === 'state-filter-select') {
        view.stateFilter = event.target.value; view.renderLimit = APP.chunkSize; renderDynamic(view, { list: true, resetScroll: true });
      } else if (control === 'arrange-method' || control === 'name-arrange-direction') {
        view.nameArrangeDraft = normalizeNameArrangePreference(view.nameArrangeDraft);
        if(control === 'arrange-method') view.nameArrangeDraft.mode = event.target.value === 'name' ? 'name' : 'position';
        else view.nameArrangeDraft.direction = event.target.value === 'desc' ? 'desc' : 'asc';
        renderArrangeDraft(view);
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
    listen(root, 'dragstart', event => {
      const handle = event.target.closest?.('[data-action="arrange-drag"]');
      if (!handle || view.panel !== 'arrange-settings' || !isDesktopLayout(view)) return;
      const index = Number(handle.dataset.index);
      if (!Number.isInteger(index) || !view.arrangeDraft[index]) { event.preventDefault(); return; }
      view.arrangeDrag = { from: index };
      handle.closest('.qa-arrange-row')?.classList.add('is-dragging');
      event.dataTransfer?.setData('text/plain', String(index));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    listen(root, 'dragover', event => {
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
    listen(root, 'dragleave', event => {
      if (!view.arrangeDrag || view.panel !== 'arrange-settings') return;
      if (!event.relatedTarget || !root.contains(event.relatedTarget)) clearArrangeDragFeedback(view);
    });
    listen(root, 'drop', event => {
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
    listen(root, 'dragend', () => {
      view.arrangeDrag = null;
      clearArrangeDragFeedback(view);
    });
    listen(root, 'pointerdown', event => {
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
      if (view.keywordInternalPointer) legacyUiTimeout(view, 'keywordPointerTimer', () => { view.keywordInternalPointer = false; }, 0);
      const handle = event.target.closest?.('[data-action="drag"]');
      const card = handle?.closest('.qa-card');
      if (handle && card) startDrag(view, event, card);
    });
    listen(root, 'pointermove', event => dragMove(view, event));
    listen(root, 'pointerup', event => endDrag(view, event));
    listen(root, 'pointercancel', event => endDrag(view, event, true));
    const scroll = root.querySelector('[data-slot="scroll"]');
    listen(scroll, 'scroll', () => {
      if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 240 && visibleEntries(view).length > view.renderLimit) {
        view.renderLimit += APP.chunkSize;
        renderList(view);
      }
    }, { passive: true });
  }

  // Transitional callers only. A selected UI owns every operation below.
  // Missing operations are errors; never fall back to legacy rendering.
  function invokeCurrentUiPart(view, name, ...args) {
    if (!view || view.closed) return;
    return ensureLegacyUiSession(view).invoke(name, ...args);
  }
  function renderList(view, preserveScroll = true) {
    return invokeCurrentUiPart(view, 'list', preserveScroll);
  }
  function renderPanel(view) {
    return invokeCurrentUiPart(view, 'panel');
  }
  function renderWorkspacePanel(view) {
    return invokeCurrentUiPart(view, 'workspacePanel');
  }
  function renderFooter(view) {
    return invokeCurrentUiPart(view, 'footer');
  }
  function renderLeaveModal(view) {
    return invokeCurrentUiPart(view, 'leaveModal');
  }
  async function handleAction(view, action, target) {
    if (action === 'fault-report-copy') {
      try {
        const copied = await faultReportCopy(view);
        if (copied) toast('success', '故障信息已复制。');
        else toast('error', '无法自动复制故障信息，请换用支持剪贴板的页面。', '故障信息');
      } catch (error) { toast('error', error instanceof Error ? error.message : String(error), '复制故障信息失败'); }
      return;
    }
    return invokeCurrentUiPart(view, 'action', action, target);
  }
  function bindView(view) {
    return invokeCurrentUiPart(view, 'bind');
  }

  function syncFooterState(view) {
    return invokeCurrentUiPart(view, 'syncFooterState');
  }

  function syncTopControls(view) {
    return invokeCurrentUiPart(view, 'syncTopControls');
  }
  const APP = Object.freeze({
    id: 'inkstone-worldbook-observer',
    version: '1.0.0',
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
  const ENTRY_GROUP_STORAGE_KEY = 'inkstone-worldbook-observer:entry-groups-v1';
  const MIXED_ARRANGE_STORAGE_KEY = 'inkstone-worldbook-observer:alpha4-overview-arrange-rules-v1';
  const MIXED_SLOT_STORAGE_KEY = 'inkstone-worldbook-observer:alpha4-mixed-slots-v1';
  const SOURCE_VISIBILITY_KEY = 'inkstone-worldbook-observer:alpha4-source-visible-v1';
  const THEME_STORAGE_KEY = 'inkstone-worldbook-observer:theme-v1';
  const THEME_IDS = Object.freeze(['fog-ink', 'wisteria-moon', 'night-mist']);
  const DEFAULT_THEME = 'fog-ink';
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



  function jsonText(value) {
    return JSON.stringify(value);
  }

  function jsonStructurallyEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
      return Array.isArray(left) && Array.isArray(right)
        && left.length === right.length
        && left.every((value, index) => jsonStructurallyEqual(value, right[index]));
    }
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && jsonStructurallyEqual(left[key], right[key]));
  }

  function inactiveCharacterFilter(value) {
    if (value == null) return true;
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    const allowed = new Set(['isExclude', 'names', 'tags']);
    if (Object.keys(value).some(key => !allowed.has(key))) return false;
    if (Object.hasOwn(value, 'isExclude') && value.isExclude !== false) return false;
    if (Object.hasOwn(value, 'names') && (!Array.isArray(value.names) || value.names.length)) return false;
    if (Object.hasOwn(value, 'tags') && (!Array.isArray(value.tags) || value.tags.length)) return false;
    return true;
  }

  function entryPostSaveEquivalent(expected, verified) {
    if (!expected || !verified || typeof expected !== 'object' || typeof verified !== 'object'
      || Array.isArray(expected) || Array.isArray(verified)) return jsonStructurallyEqual(expected, verified);
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(verified)])].sort();
    return keys.every(key => {
      if (key === 'characterFilter' && inactiveCharacterFilter(expected[key]) && inactiveCharacterFilter(verified[key])) return true;
      return Object.hasOwn(expected, key) && Object.hasOwn(verified, key)
        && jsonStructurallyEqual(expected[key], verified[key]);
    });
  }

  function postSaveWorldbookEquivalent(expected, verified) {
    return Array.isArray(expected) && Array.isArray(verified)
      && expected.length === verified.length
      && expected.every((entry, index) => entryPostSaveEquivalent(entry, verified[index]));
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


  function searchWorkspaceActive(view) { return view.workspace === 'search'; }
  function textOccurrenceCount(text, find) { return find ? text.split(find).length - 1 : 0; }
  function searchWorkspaceResults(view) {
    const find = String(view.searchFind || ''), body = view.searchKind === 'body';
    if (!find || (!body && !find.trim())) return [];
    const metadataQuery = find.trim().toLocaleLowerCase('zh-CN');
    return (view.working || []).flatMap(entry => {
      if (!body) return searchText(entry).includes(metadataQuery) ? [{entry, count: 1, snippet: entryName(entry)}] : [];
      if (typeof entry.content !== 'string') return [];
      const count = textOccurrenceCount(entry.content, find); if (!count) return [];
      const index = entry.content.indexOf(find), start = Math.max(0, index - 35);
      return [{entry, count, snippet: (start ? '…' : '') + entry.content.slice(start, Math.min(entry.content.length, index + find.length + 90)) + (index + find.length + 90 < entry.content.length ? '…' : '')}];
    });
  }
  function openSearchWorkspace(view) {
    if (searchWorkspaceActive(view)) return;
    clearTimeout(view.searchTimer);
    view.searchReturnContext = {workspace: view.workspace || 'edit', panel: view.panel, query: view.query, stateFilter: view.stateFilter, positionFilter: view.positionFilter, comboGroupId: view.comboGroupId, scrollTop: view.root.querySelector('[data-slot="scroll"]')?.scrollTop || 0};
    view.workspace = 'search'; view.panel = null; view.searchOpen = false; view.mobileMenu = null; view.toolsOpen = false;
    view.searchKind = view.searchKind || 'metadata'; view.searchFind = view.searchFind ?? view.query ?? ''; view.searchReplace = view.searchReplace ?? '';
    renderDynamic(view, {list: true, resetScroll: true});
  }
  function closeSearchWorkspace(view) {
    clearTimeout(view.bodySearchTimer);
    const context = view.searchReturnContext || {workspace: 'edit'}; Object.assign(view, context); view.searchOpen = false;
    renderDynamic(view, {list: true}); const scroll = view.root.querySelector('[data-slot="scroll"]'); if (scroll) scroll.scrollTop = context.scrollTop || 0;
  }


  function replaceBodySearchResults(view) {
    if (!searchWorkspaceActive(view) || view.searchKind !== 'body' || view.mixedMode || !view.book || view.busy) return false;
    const find = String(view.searchFind || ''), replacement = String(view.searchReplace ?? '');
    if (!find || find === replacement || !searchWorkspaceResults(view).length) return false;
    return applyWorking(view, '替换正文匹配结果', () => view.working.map(entry => typeof entry.content === 'string' && entry.content.includes(find) ? {...entry, content: entry.content.split(find).join(replacement)} : entry));
  }
  function updateBodySearchInput(view, control, value) {
    if (control === 'body-search-replace') view.searchReplace = value;
    else view.searchFind = value;
    clearTimeout(view.bodySearchTimer);
    view.bodySearchTimer = legacyUiTimeout(view, 'bodySearchTimer', () => {
      if (!searchWorkspaceActive(view)) return;
      const scroll = view.root.querySelector('[data-slot="scroll"]'); if (scroll) scroll.innerHTML = searchWorkspaceResultHtml(view);
      const button = view.root.querySelector('[data-action="body-replace-results"]');
      if (button) { const count = searchWorkspaceResults(view).reduce((sum,result) => sum + result.count, 0); button.textContent = '替换匹配结果（' + count + ' 处）'; button.disabled = !count || Boolean(view.busy); }
    },180);
  }


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
    ensureGroupWorkingCopy(view);
    snapshot.entryGroups = cloneJson(view.entryGroups);
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

  /* IWB_V046_NAME_ARRANGE_BEGIN */
  function stableNameArrange(entries) {
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
    return (entries || []).map((entry, index) => ({ entry: cloneJson(entry), index, name: entryName(entry) }))
      .sort((left, right) => collator.compare(left.name, right.name) || left.index - right.index)
      .map(item => item.entry);
  }
  /* IWB_V046_NAME_ARRANGE_END */

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

  async function readWorldbookEntries(name, dependencies = {}) {
    if (!name) return [];
    const getWorldbook = dependencies.getWorldbook || requirePublicFunction('getWorldbook');
    const entries = await getWorldbook(name);
    assertUniqueEntries(entries);
    return cloneJson(entries);
  }

  /* IWB_TASK_PREVIEW_BEGIN */



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
    if (view.closed) return;
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
          if (view.closed) return;
          view.tokenCounts.set(entryId(entry), { content, value: Number.isFinite(Number(value)) ? Number(value) : null });
        } catch (_error) {
          if (view.closed) return;
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

  function worldbookIsDirty(view) {
    if (view.mixedMode) return Boolean(mixedDirtyBooks(view).length || jsonText(mixedSlotSequence(view.working)) !== jsonText(view.slotBaseline || []));
    if (view.transferStates?.size) return transferDirtyBooks(view).length > 0;
    return Boolean(view.baseline && view.working && jsonText(view.baseline) !== jsonText(view.working));
  }

  function isDirty(view) { return worldbookIsDirty(view) || groupRelationsDirty(view); }

  function entryGroupIdSets(view) {
    return (view.entryGroups || []).map(group => ({ group, ids: new Set(entryGroupMembership(view.working || [], group).existingIds) }));
  }

  function groupModeFilterIds(view) {
    const sets = entryGroupIdSets(view);
    if (view.entryGroupEditingId) return null;
    if (view.activeEntryGroupId === '__ungrouped__') {
      const grouped = new Set(sets.flatMap(item => [...item.ids]));
      return new Set((view.working || []).map(entryId).filter(id => !grouped.has(id)));
    }
    const active = sets.find(item => item.group.id === view.activeEntryGroupId) || sets[0];
    return active ? active.ids : new Set();
  }

  function visibleEntries(view) {
    if (!view.working) return [];
    const query = view.query.trim().toLocaleLowerCase('zh-CN');
    const changed = changedIds(view.baseline, view.working, view);
    const groupIds = view.mobileMode === 'group' ? groupModeFilterIds(view) : null;
    return comboOrderedEntries(view).filter(entry => {
      const id = entryId(entry);
      if (groupIds && !groupIds.has(id)) return false;
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
    const filtered = hasActiveListFilters(view) || comboWorkspaceActive(view);
    const scopeEntries = filtered ? entries : (view.working || []);
    const scopeIds = scopeEntries.map(entryId);
    const selectedInScope = scopeIds.filter(id => view.selected.has(id)).length;
    const exactlySelected = scopeIds.length === view.selected.size && selectedInScope === scopeIds.length;
    const scopeName = comboWorkspaceActive(view) ? '当前组合视图' : filtered ? '当前结果' : view.mixedMode ? '当前总览' : '本书';
    const countText = filtered ? `显示 ${entries.length} / 共 ${view.working?.length || 0} 条` : `共 ${view.working?.length || 0} 条`;
    return { entries: scopeEntries, ids: scopeIds, filtered, scopeName, selectedInScope, exactlySelected, countText };
  }

  function selectListScope(view) {
    const scope = listSelectionScope(view);
    view.selected.clear();
    scope.ids.forEach(id => view.selected.add(id));
    return scope.ids.length;
  }




  /* IWB_V042_LIST_SELECTION_END */

  function pushUndo(view, label) {
    ensureGroupWorkingCopy(view);
    view.undo.push({ working: cloneJson(view.working), entryGroups: cloneJson(view.entryGroups), label });
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
    const previous = view.working;
    view.working = next;
    faultReportMutation(view, label);
    syncDeletedGroupMembers(view, previous, next);
    if (!view.mixedMode && options.copySourceId) inheritCopiedGroupMembers(view, options.copySourceId, options.copyId);
    if (options.expandId) view.expanded.add(options.expandId);
    if (options.removeId) {
      view.selected.delete(options.removeId);
      view.expanded.delete(options.removeId);
      view.tokenCounts.delete(options.removeId);
    }
    renderDynamic(view, { list: true });
    return true;
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
    faultReportMutation(view, label);
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

  /* IWB_V047_ENTRY_GROUPS_BEGIN */



  const ENTRY_GROUP_V2_STORAGE_KEY = 'inkstone-worldbook-observer:entry-groups-v2';
  function groupMemberReference(id, entry, previous = {}) {
    const text = String(id);
    let uid = entry?.uid ?? previous.uid ?? null;
    if (uid === null && /^(number|string):/.test(text)) {
      const colon = text.indexOf(':'); const value = decodeURIComponent(text.slice(colon + 1));
      uid = text.startsWith('number:') ? Number(value) : value;
    }
    return { ...cloneJson(previous), entryId: text, uid, objectKey: previous.objectKey ?? null };
  }
  function normalizeEntryGroups(groups) {
    const seen = new Set();
    return (Array.isArray(groups) ? groups : []).flatMap(group => {
      const id = String(group?.id ?? '').trim(), name = String(group?.name ?? '').trim();
      if (!id || !name || seen.has(id)) return [];
      seen.add(id);
      const members = Array.isArray(group.members) ? group.members : (group.entryIds || []).map(id => groupMemberReference(id));
      const ids = new Set();
      const normalized = members.flatMap(member => {
        const reference = member.entryId ?? (['number', 'string'].includes(typeof member.uid) ? typeof member.uid + ':' + encodeURIComponent(String(member.uid)) : null);
        if (!reference || ids.has(String(reference))) return [];
        ids.add(String(reference)); return [groupMemberReference(reference, null, member)];
      });
      return [{ ...cloneJson(group), id, name, members: normalized, entryIds: normalized.map(member => member.entryId) }];
    });
  }
  function readGroupDocument(book, storage) {
    try { return readGroupDocumentUnsafe(book, storage); }
    catch (error) { return { schemaVersion: 2, book: { name: String(book) }, groups: [], storageReadError: String(error.message || error) }; }
  }
  function readGroupDocumentUnsafe(book, storage) {
    const target = storage ?? hostWindow().localStorage;
    const raw = target?.getItem?.(ENTRY_GROUP_V2_STORAGE_KEY);
    let store = null;
    if (raw) store = JSON.parse(raw);
    const document = store?.books?.[entryGroupBookKey(book)];
    if (document) {
      if (document.schemaVersion !== 2 || !Array.isArray(document.groups)) throw new Error('无法读取此版本的本机组合数据。');
      return { ...cloneJson(document), groups: normalizeEntryGroups(document.groups) };
    }
    // Legacy key is never overwritten or deleted; migration is only persisted by Save All.
    return { schemaVersion: 2, book: { name: String(book) }, groups: normalizeEntryGroups(readEntryGroupStore(target)[entryGroupBookKey(book)]) };
  }
  function loadEntryGroups(book, storage) { return readGroupDocument(book, storage).groups; }
  function saveEntryGroups(book, groups, storage, document = {}) {
    if (document.storageReadError) throw new Error(document.storageReadError);
    if (!book || book === MIXED_BOOK_VALUE) throw new Error('快捷组合只能保存到一本具体世界书。');
    const target = storage ?? hostWindow().localStorage;
    if (!target?.setItem) throw new Error('当前环境没有可用的本机存储。');
    const raw = target.getItem(ENTRY_GROUP_V2_STORAGE_KEY);
    const store = raw ? JSON.parse(raw) : { schemaVersion: 2, books: {} };
    if (store.schemaVersion !== 2 || typeof store.books !== 'object' || !store.books) throw new Error('无法写入此版本的本机组合数据。');
    const normalized = normalizeEntryGroups(groups);
    const previous = store.books[entryGroupBookKey(book)] || {};
    store.books[entryGroupBookKey(book)] = { ...cloneJson(previous), ...cloneJson(document), schemaVersion: 2, book: { ...cloneJson(previous.book || {}), ...cloneJson(document.book || {}), name: String(book) }, groups: normalized };
    target.setItem(ENTRY_GROUP_V2_STORAGE_KEY, JSON.stringify(store));
    return normalized;
  }
  function ensureGroupWorkingCopy(view) {
    if (!view.entryGroupBaseline) view.entryGroupBaseline = cloneJson(normalizeEntryGroups(view.entryGroups || []));
    view.entryGroups = normalizeEntryGroups(view.entryGroups || []);
  }
  function groupRelationsDirty(view) {
    if (view.mixedMode || !view.book) return false;
    ensureGroupWorkingCopy(view);
    return jsonText(view.entryGroups) !== jsonText(view.entryGroupBaseline);
  }
  function applyGroupRelations(view, label, next) {
    if (view.busy || view.mixedMode || !view.book) return false;
    ensureGroupWorkingCopy(view);
    const groups = normalizeEntryGroups(next);
    if (jsonText(groups) === jsonText(view.entryGroups)) return false;
    pushUndo(view, label); view.entryGroups = groups; return true;
  }
  function replaceGroupMembers(view, groupId, ids) {
    const group = view.entryGroups.find(group => group.id === String(groupId));
    if (!group) throw new Error('这个快捷组合已不存在。');
    const entries = new Map(view.working.map(entry => [entryId(entry), entry]));
    const previous = new Map((group.members || []).map(member => [member.entryId, member]));
    const members = [...new Set(ids.map(String))].map(id => groupMemberReference(id, entries.get(id), previous.get(id)));
    return applyGroupRelations(view, '修改组合成员', view.entryGroups.map(candidate => candidate.id === group.id ? { ...candidate, members } : candidate));
  }
  function renameEntryGroup(view, groupId, name) {
    const value = String(name || '').trim(); if (!value) throw new Error('请填写组合名称。');
    return applyGroupRelations(view, '重命名组合', view.entryGroups.map(group => group.id === String(groupId) ? { ...group, name: value } : group));
  }
  function upsertEntryGroup(groups, name, entryIds, makeId = () => 'group-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)) {
    const normalizedName = String(name ?? '').trim().slice(0, 60);
    if (!normalizedName) throw new Error('请先填写组合名称。');
    const next = normalizeEntryGroups(groups);
    if (next.some(group => group.name === normalizedName)) throw new Error('已有同名组合，请使用其他名称。');
    const group = normalizeEntryGroups([{ id: String(makeId()), name: normalizedName, entryIds }])[0];
    return { groups: [...next, group], group, updated: false };
  }
  function createOrUpdateEntryGroup(view, storage, makeId) {
    if (view.mixedMode || !view.book) throw new Error('快捷组合只能用于一本具体世界书。');
    ensureGroupWorkingCopy(view);
    const orderedIds = comboOrderedEntries(view).map(entryId).filter(id => view.selected.has(id));
    if (!orderedIds.length) throw new Error('请先选择条目。');
    const result = upsertEntryGroup(view.entryGroups, view.entryGroupNameDraft, orderedIds, makeId);
    const entries = new Map(view.working.map(entry => [entryId(entry), entry]));
    result.group.members = result.group.members.map(member => groupMemberReference(member.entryId, entries.get(member.entryId), member));
    applyGroupRelations(view, '新建组合', result.groups);
    view.entryGroupNameDraft = ''; view.selected.clear(); return result;
  }
  function createEntryGroupWithMembers(view, name, ids = [], makeId) {
    if (view.mixedMode || !view.book) throw new Error('快捷组合只能用于一本具体世界书。');
    ensureGroupWorkingCopy(view);
    const available = new Map((view.working || []).map(entry => [entryId(entry), entry]));
    const orderedIds = [...new Set((ids || []).map(String))].filter(id => available.has(id));
    const result = upsertEntryGroup(view.entryGroups, name, orderedIds, makeId);
    result.group.members = result.group.members.map(member => groupMemberReference(member.entryId, available.get(member.entryId), member));
    applyGroupRelations(view, orderedIds.length ? '新建组合' : '新建空组合', result.groups);
    return result;
  }
  function deleteEntryGroupFromView(view, groupId) {
    const group = (view.entryGroups || []).find(candidate => candidate.id === String(groupId));
    if (!group) return null;
    return applyGroupRelations(view, '删除组合', removeEntryGroup(view.entryGroups, group.id)) ? group : null;
  }
  function moveEntryGroupByDirection(view, groupId, direction) {
    const groups = view.entryGroups || [], index = groups.findIndex(group => group.id === String(groupId));
    const other = direction === 'up' ? groups[index - 1] : groups[index + 1];
    return other ? reorderComboGroups(view, groups[index].id, other.id, direction !== 'up') : false;
  }
  function saveEditedEntryGroup(view, storage) {
    ensureGroupWorkingCopy(view);
    const group = view.entryGroups.find(group => group.id === String(view.entryGroupEditingId));
    if (!group) throw new Error('这个快捷组合已不存在。');
    // Keep existing group order; append newly selected members in main-list order.
    const ids = [...group.entryIds.filter(id => view.selected.has(id)), ...view.working.map(entryId).filter(id => view.selected.has(id) && !group.entryIds.includes(id))];
    replaceGroupMembers(view, group.id, ids);
    view.entryGroupEditingId = null; view.activeEntryGroupId = group.id; view.selected.clear();
    return { group: view.entryGroups.find(candidate => candidate.id === group.id), updated: true };
  }
  function syncDeletedGroupMembers(view, previous, next) {
    if (view.mixedMode) return;
    const remaining = new Set(next.map(entryId));
    const removed = new Set(previous.map(entryId).filter(id => !remaining.has(id)));
    view.entryGroups = normalizeEntryGroups(view.entryGroups).map(group => {
      const members = group.members.filter(member => !removed.has(member.entryId));
      return { ...group, members, entryIds: members.map(member => member.entryId) };
    });
  }
  function inheritCopiedGroupMembers(view, sourceId, copyId) {
    const entry = view.working.find(entry => entryId(entry) === copyId);
    view.entryGroups = normalizeEntryGroups(view.entryGroups).map(group => {
      const members = group.members.flatMap(member => member.entryId === sourceId ? [member, groupMemberReference(copyId, entry)] : [member]);
      return { ...group, members, entryIds: members.map(member => member.entryId) };
    });
  }
  async function saveAllWithGroups(view, saveWorldbook = saveWorldbookAll, storage, render = renderDynamic, notify = toast) {
    if (!view.book || !isDirty(view) || view.busy) return true;
    const relationDirty = groupRelationsDirty(view);
    const worldDirty = worldbookIsDirty(view);
    const undo = view.undo.slice();
    if (worldDirty && !await saveWorldbook(view)) return false;
    if (relationDirty) {
      try {
        view.entryGroups = saveEntryGroups(view.book, view.entryGroups, storage, view.entryGroupDocument || {});
        view.entryGroupBaseline = cloneJson(view.entryGroups);
        view.entryGroupDocument = { ...cloneJson(view.entryGroupDocument || {}), schemaVersion: 2, book: { ...cloneJson(view.entryGroupDocument?.book || {}), name: view.book }, groups: cloneJson(view.entryGroups) };
      } catch (error) {
        // Entries already saved cannot be undone by an older relation snapshot.
        const relationUndo = undo.filter((snapshot, index) => jsonText(snapshot.entryGroups || view.entryGroupBaseline) !== jsonText(index + 1 < undo.length ? undo[index + 1].entryGroups || view.entryGroupBaseline : view.entryGroups));
        view.undo = worldDirty ? relationUndo.map(snapshot => ({ ...snapshot, working: cloneJson(view.working), ...(snapshot.kind === 'transfer' ? { targets: transferTargetStates(view).map(state => [state.name, cloneJson(state.working)]), moveTargets: [...(view.transferMoveTargets || [])] } : {}) })) : undo;
        notify('error', String(error.message || error), '组合保存失败'); render(view); return false;
      }
    }
    view.undo = []; render(view); if (!worldDirty) notify('success', '已保存组合。'); return true;
  }
  async function saveAll(view) { return saveAllWithGroups(view); }

  function readEntryGroupStore(storage) {
    try {
      const target = storage ?? hostWindow().localStorage;
      const parsed = JSON.parse(target?.getItem?.(ENTRY_GROUP_STORAGE_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function entryGroupBookKey(book) {
    return 'book:' + encodeURIComponent(String(book ?? ''));
  }







  function removeEntryGroup(groups, groupId) {
    return normalizeEntryGroups(groups).filter(group => group.id !== String(groupId));
  }

  function entryGroupMembership(entries, group) {
    const available = new Set((entries || []).map(entryId));
    const storedIds = [...new Set((group?.entryIds || []).map(String))];
    const existingIds = storedIds.filter(id => available.has(id));
    return { existingIds, missingCount: storedIds.length - existingIds.length };
  }





  function selectEntryGroup(view, groupId) {
    const group = (view.entryGroups || []).find(candidate => candidate.id === String(groupId));
    if (!group) throw new Error('这个快捷组合已不存在。');
    const membership = entryGroupMembership(view.working, group);
    view.selected.clear();
    membership.existingIds.forEach(id => view.selected.add(id));
    return { group, ...membership };
  }

  function setEntryGroupEnabled(view, groupId, enabled, render = renderDynamic, notify = toast) {
    if (view.busy) return { changedCount: 0, skippedCount: 0, changed: false };
    const group = (view.entryGroups || []).find(candidate => candidate.id === String(groupId));
    if (!group) throw new Error('这个快捷组合已不存在。');
    const membership = entryGroupMembership(view.working, group);
    const result = batchSetEnabledEntries(view.working, membership.existingIds, enabled);
    const verb = enabled ? '启用' : '停用';
    const skippedCount = result.skippedCount + membership.missingCount;
    if (!result.changedCount) {
      notify('info', `“${group.name}”没有条目需要${verb}；跳过 ${skippedCount} 条。`);
      return { changedCount: 0, skippedCount, changed: false };
    }
    pushUndo(view, `${verb}快捷组合“${group.name}”`);
    view.working = result.entries;
    render(view, { list: true });
    notify('info', `已在工作副本中${verb}“${group.name}”的 ${result.changedCount} 条；跳过 ${skippedCount} 条。`);
    return { changedCount: result.changedCount, skippedCount, changed: true };
  }
  /* IWB_V047_ENTRY_GROUPS_END */

  /* IWB_V042_BATCH_ENABLED_BEGIN */



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
    syncDeletedGroupMembers(view, view.working, result.entries);
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

  /* IWB_V044_BOOK_SELECTOR_BEGIN */
  function selectorSourceLabel(identity) {
    return ({ global: '全局', character: '角色', chat: '聊天', persona: '其他', other: '其他' })[identity] || '';
  }

  function selectorSourceLabels(identities) {
    const priority = ['global', 'character', 'chat', 'persona', 'other'];
    const values = new Set(Array.isArray(identities) ? identities.map(String) : []);
    const labels = [];
    priority.forEach(identity => {
      if (!values.has(identity)) return;
      const label = selectorSourceLabel(identity);
      if (label && !labels.includes(label)) labels.push(label);
    });
    return labels;
  }

  function bookSelectorLabel(book) {
    const labels = selectorSourceLabels(book?.identities);
    return labels.length ? `[${labels.join(' · ')}] ${book.name}` : String(book?.name || '');
  }

  function selectorPrimarySourceRank(book) {
    const ranks = { global: 0, character: 1, chat: 2, persona: 3, other: 3 };
    const values = Array.isArray(book?.identities) ? book.identities : [];
    return values.reduce((best, identity) => Math.min(best, ranks[identity] ?? 3), 3);
  }

  function bookSelectorGroups(view) {
    const names = Array.isArray(view.names) ? view.names : [];
    if (!view.catalogReady) return { reliable: false, active: [], inactive: [], all: names };
    const activeByName = new Map((view.catalogActiveBooks || []).map(book => [book.name, book]));
    const active = names.filter(name => activeByName.has(name)).map(name => activeByName.get(name));
    active.sort((left, right) => selectorPrimarySourceRank(left) - selectorPrimarySourceRank(right) || String(left.name).localeCompare(String(right.name), 'zh-CN'));
    return {
      reliable: true,
      active,
      inactive: names.filter(name => !activeByName.has(name)),
      all: [],
    };
  }



  async function refreshBookCatalog(view) {
    try {
      view.catalogActiveBooks = await discoverActiveBooks(view);
      view.catalogReady = true;
      view.catalogError = '';
    } catch (error) {
      view.catalogActiveBooks = [];
      view.catalogReady = false;
      view.catalogError = error instanceof Error ? error.message : String(error);
    }
  }

  function bookPickerMatches(label, query) {
    return !query || String(label || '').toLocaleLowerCase('zh-CN').includes(String(query).trim().toLocaleLowerCase('zh-CN'));
  }





  function bookPickerTriggerLabel(view) {
    if (view.book === MIXED_BOOK_VALUE) return '当前生效世界书总览';
    return view.book || '选择一本具体世界书';
  }
  /* IWB_V044_BOOK_SELECTOR_END */

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
      view.entryGroups = []; view.entryGroupBaseline = []; view.entryGroupDocument = null;
      view.entryGroupNameDraft = '';
      view.activeBooks = activeBooks;
      view.catalogActiveBooks = activeBooks;
      view.catalogReady = true;
      view.catalogError = '';
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
      return { ...summary, text: [...parts, ...(groupRelationsDirty(view) ? ['组合关系修改 1 项'] : [])].join(' / ') || '无未保存修改', bookDirtyCount: isDirty(view) ? 1 : 0, slotDirty: false };
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
    return view?.mixedMode ? summary.bookDirtyCount + (summary.slotDirty ? 1 : 0) : (summary.fieldCount || 0) + (summary.arrangement ? 1 : 0) + (groupRelationsDirty(view) ? 1 : 0);
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

  function readThemePreference() {
    try {
      const value = hostWindow().localStorage?.getItem?.(THEME_STORAGE_KEY);
      return THEME_IDS.includes(value) ? value : DEFAULT_THEME;
    } catch (_error) {
      return DEFAULT_THEME;
    }
  }

  function saveThemePreference(theme) {
    try { hostWindow().localStorage?.setItem?.(THEME_STORAGE_KEY, theme); }
    catch (_error) {}
  }

  function applyTheme(view, theme, persist = true) {
    const next = THEME_IDS.includes(theme) ? theme : DEFAULT_THEME;
    view.theme = next;
    view.root.dataset.theme = next;
    if (view.popupDialog) view.popupDialog.dataset.iwbQaTheme = next;
    if (persist) saveThemePreference(next);
  }



  function openThemePicker(view) {
    const layer = view.root.querySelector('[data-slot="theme-picker"]');
    if (!layer) return;
    view.themeReturnFocus = hostDocument().activeElement;
    view.themePickerOpen = true;
    layer.hidden = false;
    layer.querySelector(`[data-theme-choice="${cssEscape(view.theme)}"]`)?.focus();
  }

  function closeThemePicker(view) {
    if (!view.themePickerOpen) return;
    const layer = view.root.querySelector('[data-slot="theme-picker"]');
    if (layer) layer.hidden = true;
    view.themePickerOpen = false;
    view.themeReturnFocus?.focus?.();
    view.themeReturnFocus = null;
  }













  function isWideDesktopLayout(view) { return Number(view?.root?.getBoundingClientRect?.().width || view?.root?.clientWidth || 0) >= 1025; }
  function syncWideDesktopWorkbench(view) {
    if (!isWideDesktopLayout(view)) return;
    view.root.classList.toggle('qa-pc-compact-mode', view.cardDensity === 'compact');
    const create = view.root.querySelector('[data-action="new-entry"]'); if (create) create.textContent = '＋ 新建条目';
    const combo = view.root.querySelector('[data-action="mobile-combos"]'); if (combo) {combo.disabled = view.mixedMode || !view.book; combo.textContent = '快捷组合';}
    const recursion = view.root.querySelector('[data-action="disable-recursion"]'); if (recursion) {recursion.hidden = view.mixedMode; recursion.textContent = '禁止当前书全部递归';}
    const selected = view.root.querySelector('.qa-mobile-arrange-selection');
    if (selected) selected.innerHTML = '<span>选中条目</span>' + ['up','down','top','bottom'].map(direction => '<button class="qa-btn" data-action="batch-move" data-direction="' + direction + '"' + (!view.selected.size ? ' disabled' : '') + '>' + ({up:'上移',down:'下移',top:'置顶',bottom:'置底'})[direction] + '</button>').join('');
  }



  const NAME_ARRANGE_STORAGE_KEY = 'iwb-qa-name-arrange-v1';
  function normalizeNameArrangePreference(value) { return {mode:value?.mode === 'name' ? 'name' : 'position',direction:value?.direction === 'desc' ? 'desc' : 'asc'}; }
  function nameArrangeScope(view) { return view.mixedMode ? 'overview' : 'book:' + view.book; }
  function readNameArrangePreference(view, storage) {
    try { const target=storage ?? hostWindow().localStorage; const store=JSON.parse(target?.getItem?.(NAME_ARRANGE_STORAGE_KEY)||'{}'); return normalizeNameArrangePreference(store[nameArrangeScope(view)]); } catch (_error) { return normalizeNameArrangePreference(); }
  }
  function saveNameArrangePreference(view, storage) {
    const pref=normalizeNameArrangePreference(view.nameArrangeDraft);
    const target=storage ?? hostWindow().localStorage;
    let store;try {store=JSON.parse(target?.getItem?.(NAME_ARRANGE_STORAGE_KEY)||'{}');}catch(_error){store={};}
    if(!store || typeof store !== 'object' || Array.isArray(store))store={};
    store[nameArrangeScope(view)]=pref;target?.setItem?.(NAME_ARRANGE_STORAGE_KEY,JSON.stringify(store));return pref;
  }
  function arrangeNamesByDirection(entries,direction) {
    if(direction !== 'desc')return stableNameArrange(entries);
    const collator=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});
    return (entries||[]).map((entry,index)=>({entry:cloneJson(entry),index,name:entryName(entry)})).sort((a,b)=>-collator.compare(a.name,b.name)||a.index-b.index).map(item=>item.entry);
  }






  function toastComboCreated(name) {
    const api=hostWindow().toastr || globalThis.toastr;
    if(api && typeof api.success === 'function')api.success('已创建组合“'+name+'”。','',{timeOut:1500,extendedTimeOut:0,closeButton:false});
    else console.log('[世界书观测台] 已创建组合“'+name+'”。');
  }
  function captureComboNavScroll(view) {
    const node=view.root.querySelector('[data-slot="combo-user-tabs"]');
    if(node && !node.closest?.('.qa-combo-navigation')?.classList?.contains?.('is-expanded'))view.comboNavScrollLeft=Number(node.scrollLeft||0);
  }
  function restoreComboNavScroll(view,ensureActive=false) {
    const node=view.root.querySelector('[data-slot="combo-user-tabs"]');if(!node || view.comboNavExpanded)return;
    node.scrollLeft=Number(view.comboNavScrollLeft||0);
    if(ensureActive){const active=Array.from(node.querySelectorAll?.('[data-group-id]')||[]).find(tab=>tab.dataset.groupId===view.comboGroupId);if(active){const rect=active.getBoundingClientRect?.(),area=node.getBoundingClientRect?.();if(rect&&area){if(rect.left<area.left)node.scrollLeft-=area.left-rect.left;else if(rect.right>area.right)node.scrollLeft+=rect.right-area.right;}}}
    view.comboNavScrollLeft=Number(node.scrollLeft||0);
  }
  function reorderComboGroups(view,id,anchorId,after=false) {
    if(!id || id===anchorId || !view.entryGroups.some(group=>group.id===id) || !view.entryGroups.some(group=>group.id===anchorId))return false;
    const moving=view.entryGroups.find(group=>group.id===id),next=view.entryGroups.filter(group=>group.id!==id),at=next.findIndex(group=>group.id===anchorId);
    next.splice(at+(after?1:0),0,moving);return applyGroupRelations(view,'调整组合排列',next);
  }
  function startComboNavDrag(view,event,handle) {
    if(!comboWorkspaceActive(view) || !view.comboNavArrange || view.busy || event.button>0)return false;
    const id=handle.dataset.groupId;if(!view.entryGroups.some(group=>group.id===id))return false;
    view.comboNavDrag={id,pointerId:event.pointerId,anchorId:null,after:false};
    handle.closest?.('.qa-combo-user-tab')?.classList.add('is-nav-drag-source');handle.setPointerCapture?.(event.pointerId);event.preventDefault();return true;
  }
  function moveComboNavDrag(view,event) {
    const drag=view.comboNavDrag;if(!drag || drag.pointerId!==event.pointerId)return;
    view.root.querySelectorAll('.is-nav-drop-before,.is-nav-drop-after').forEach(node=>node.classList.remove('is-nav-drop-before','is-nav-drop-after'));
    const target=view.root.ownerDocument.elementFromPoint(event.clientX,event.clientY)?.closest?.('.qa-combo-user-tab');
    drag.anchorId=null;if(!target || target.dataset.groupId===drag.id)return;
    const rect=target.getBoundingClientRect();drag.anchorId=target.dataset.groupId;drag.after=event.clientX>=rect.left+rect.width/2;target.classList.add(drag.after?'is-nav-drop-after':'is-nav-drop-before');event.preventDefault();
  }
  function endComboNavDrag(view,event,cancelled=false) {
    const drag=view.comboNavDrag;if(!drag || drag.pointerId!==event.pointerId)return false;
    view.comboNavDrag=null;view.root.querySelectorAll('.is-nav-drag-source,.is-nav-drop-before,.is-nav-drop-after').forEach(node=>node.classList.remove('is-nav-drag-source','is-nav-drop-before','is-nav-drop-after'));
    const changed=!cancelled && drag.anchorId && reorderComboGroups(view,drag.id,drag.anchorId,drag.after);
    view.comboNavExpanded=true;renderDynamic(view);return Boolean(changed);
  }









  function closeBookPicker(view, restoreFocus = false) {
    if (!view.bookPickerOpen) return false;
    view.bookPickerOpen = false;
    view.bookPickerQuery = '';
    renderBookOptions(view);
    if (restoreFocus) view.root.querySelector('[data-action="book-picker-toggle"]')?.focus?.({ preventScroll: true });
    return true;
  }

  function toggleBookPicker(view) {
    if (view.busy || view.panel === 'arrange-settings' || view.panel === 'transfer' || view.panel === 'import') return false;
    view.bookPickerOpen = !view.bookPickerOpen;
    view.bookPickerQuery = '';
    renderBookOptions(view);
    return true;
  }

  function requestBookSwitch(view, requested) {
    closeBookPicker(view, false);
    if (!requested || requested === view.book) return false;
    if (!showLeavePrompt(view, { kind: 'switch', book: requested })) loadBook(view, requested);
    return true;
  }








  function refreshInlineFields(view, cardId) {
    const entry = view.working.find(candidate => entryId(candidate) === cardId);
    const region = view.root.querySelector(`[data-entry-id="${cssEscape(cardId)}"] .qa-inline-fields`);
    if (entry && region) region.innerHTML = region.closest('.qa-mobile-card') ? mobileCardFieldsHtml(entry) : inlineFieldsHtml(entry);
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









  function commitCardContentInput(view, input) {
    const id = input.closest('.qa-card')?.dataset.entryId;
    if (!id) return false;
    const previousUndo = view.undo.slice();
    const coalesce = view.cardContentUndo === previousUndo.at(-1) && view.cardContentInput === input;
    const changed = applyWorkingQuiet(view, '编辑条目正文', () => mutateEntry(view.working, id, entry => { entry.content = String(input.value); }), id);
    if (!changed) return false;
    if (coalesce) view.undo = previousUndo;
    view.cardContentUndo = view.undo.at(-1);
    view.cardContentInput = input;
    const entry = view.working.find(candidate => entryId(candidate) === id);
    if (entry) scheduleTokenCounts(view, [entry]);
    return true;
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
    return jsonText(view.arrangeDraft || []) !== jsonText(view.arrangeInitialDraft || []) || jsonText(normalizeNameArrangePreference(view.nameArrangeDraft)) !== jsonText(normalizeNameArrangePreference(view.nameArrangeInitialDraft));
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
    view.nameArrangeDraft = cloneJson(normalizeNameArrangePreference(view.nameArrangeInitialDraft));
    return true;
  }

  function syncArrangeResetButton(view) {
    const button = view.root?.querySelector?.('[data-action="reset-arrange-settings"]');
    if (!button) return;
    button.disabled = !arrangeDraftChanged(view);
    button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
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



  function orderPreview(view) {
    const count = view.selected.size;
    const start = Number(view.orderDraft.start);
    const gap = view.orderDraft.mode === 'same' ? 0 : Number(view.orderDraft.gap);
    if (!Number.isFinite(start) || !Number.isFinite(gap) || !count) return '请填写有效数字并选择条目';
    if (view.orderDraft.mode === 'same') return `${count} 条都设为 ${start}`;
    return `${start} → ${start + gap * Math.max(0, count - 1)}（${count} 条，间隔 ${gap}）`;
  }


















  function comboWorkspaceActive(view) { return view.workspace === 'combos'; }
  function comboOrderedEntries(view) {
    if (!comboWorkspaceActive(view) || view.comboGroupId === '__all__' || !view.comboGroupId) return view.working || [];
    if (view.comboGroupId === '__ungrouped__') {
      const grouped = new Set((view.entryGroups || []).flatMap(group => group.entryIds));
      return (view.working || []).filter(entry => !grouped.has(entryId(entry)));
    }
    const group = (view.entryGroups || []).find(group => group.id === view.comboGroupId);
    const entries = new Map((view.working || []).map(entry => [entryId(entry), entry]));
    return (group?.members || []).map(member => entries.get(member.entryId)).filter(Boolean);
  }
  function openComboWorkspace(view) {
    if (view.mixedMode || !view.book) throw new Error('快捷组合仅用于一本具体世界书。');
    view.comboEditContext = { query: view.query, stateFilter: view.stateFilter, positionFilter: view.positionFilter, scrollTop: view.root.querySelector('[data-slot="scroll"]')?.scrollTop || 0 };
    view.workspace = 'combos'; view.comboGroupId = '__all__'; view.comboMore = false;
    view.query = ''; view.stateFilter = 'all'; view.positionFilter = 'all';
    view.mobileMode = 'edit'; view.moveMode = false; view.panel = null; view.mobileMenu = null; view.toolsOpen = false;
    view.entryGroupEditingId = null; renderDynamic(view, { list: true, resetScroll: true });
  }
  function closeComboWorkspace(view) {
    view.workspace = 'edit'; view.panel = null; view.comboMore = false;
    if (view.comboEditContext) Object.assign(view, { query: view.comboEditContext.query, stateFilter: view.comboEditContext.stateFilter, positionFilter: view.comboEditContext.positionFilter });
    renderDynamic(view, { list: true });
    const scroll = view.root.querySelector('[data-slot="scroll"]'); if (scroll) scroll.scrollTop = view.comboEditContext?.scrollTop || 0;
  }

  function addEntriesToGroup(view, groupId, ids, remove = false) {
    ensureGroupWorkingCopy(view);
    const group = view.entryGroups.find(group => group.id === groupId); if (!group) return false;
    const chosen = new Set(ids), entries = new Map(view.working.map(entry => [entryId(entry), entry]));
    let members = group.members.filter(member => !remove || !chosen.has(member.entryId));
    if (!remove) for (const id of ids) if (entries.has(id) && !members.some(member => member.entryId === id)) members.push(groupMemberReference(id, entries.get(id)));
    return applyGroupRelations(view, remove ? '移出组合' : '加入组合', view.entryGroups.map(candidate => candidate.id === group.id ? { ...candidate, members } : candidate));
  }
  function reorderComboMembers(view, ids, anchorId, after) {
    const group = view.entryGroups.find(group => group.id === view.comboGroupId); if (!group || ids.includes(anchorId)) return false;
    const chosen = new Set(ids), block = group.members.filter(member => chosen.has(member.entryId)), rest = group.members.filter(member => !chosen.has(member.entryId));
    const index = rest.findIndex(member => member.entryId === anchorId); if (index < 0 || !block.length) return false;
    rest.splice(index + (after ? 1 : 0), 0, ...block);
    return applyGroupRelations(view, '调整组内排列', view.entryGroups.map(candidate => candidate.id === group.id ? { ...candidate, members: rest } : candidate));
  }
  function moveComboMember(view, id, direction) {
    const group = view.entryGroups.find(group => group.id === view.comboGroupId); if (!group) return false;
    const index = group.members.findIndex(member => member.entryId === id), other = group.members[index + (direction === 'up' ? -1 : 1)];
    return other ? reorderComboMembers(view, [id], other.entryId, direction !== 'up') : false;
  }


  function comboSelectedIds(view) { const available = new Set(comboOrderedEntries(view).map(entryId)); return [...view.selected].filter(id => available.has(id)); }
  function moveComboSelection(view, ids, direction) {
    const group = view.entryGroups.find(group => group.id === view.comboGroupId); if (!group) return false;
    const refs = new Map(group.members.map(member => [member.entryId, member]));
    const proxies = group.members.map(member => ({uid: member.entryId}));
    const selected = proxies.filter(proxy => ids.includes(proxy.uid)).map(entryId);
    const members = moveEntries(proxies, selected, direction).map(proxy => refs.get(proxy.uid));
    return applyGroupRelations(view, '调整组内排列', view.entryGroups.map(candidate => candidate.id === group.id ? {...candidate, members} : candidate));
  }

  function openMobileCombos(view) { openComboWorkspace(view); }



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
    if (view.closed || !editor) return;
    const node = view.root.querySelector('[data-slot="content-token"]');
    const counter = getTokenCounter();
    if (!counter) { if (node) node.textContent = '未计算'; return; }
    const generation = ++editor.tokenGeneration;
    if (node) node.textContent = '计算中…';
    try {
      const value = await counter(editor.draft);
      if (view.closed || view.contentEditor !== editor || editor.tokenGeneration !== generation) return;
      if (node) node.textContent = Number.isFinite(Number(value)) ? String(Number(value)) : '未计算';
    } catch (_error) {
      if (!view.closed && view.contentEditor === editor && editor.tokenGeneration === generation && node) node.textContent = '未计算';
    }
  }

  function scheduleContentEditorToken(view) {
    clearTimeout(view.contentTokenTimer);
    view.contentTokenTimer = setTimeout(() => { void updateContentEditorToken(view); }, 180);
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


  async function readNames(view) {
    const getNames = requirePublicFunction('getWorldbookNames');
    const names = await getNames();
    if (view.closed) return;
    view.names = [...new Set((Array.isArray(names) ? names : []).map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    await refreshBookCatalog(view);
    renderDynamic(view);
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
      view.entryGroupDocument = readGroupDocument(name);
      view.entryGroups = cloneJson(view.entryGroupDocument.groups);
      view.entryGroupBaseline = cloneJson(view.entryGroups);
      view.entryGroupNameDraft = '';
      view.baseline = cloneJson(entries);
      view.working = cloneJson(entries);
      faultReportStart(view, name, view.baseline);
      view.selected.clear();
      view.expanded.clear();
      view.tokenCounts.clear();
      view.moveMode = false;
      view.contentEditor = null;
      view.undo = [];
      view.query = '';
      view.searchOpen = false;
      view.mobileMenu = null;
      view.mobileMode = 'edit';
      view.activeEntryGroupId = view.entryGroups[0]?.id || '__ungrouped__';
      view.entryGroupEditingId = null;
      view.toolsOpen = false;
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
    const reportView = faultReportViewForBook(book);
    if (reportView) faultReportCaptureDrafts(reportView);
    let writeStarted = false;
    try {
      const latest = await getWorldbook(book);
      assertUniqueEntries(latest);
      faultReportBookEvent(book, { type: 'save-preflight', latest: faultReportSummary(latest), comparison: faultReportDiff(expectedBefore, latest) });
      if (jsonStructurallyEqual(latest, expectedAfter)) {
        faultReportBookEvent(book, { type: 'save-noop', reason: 'latest-already-working' });
        return cloneJson(latest);
      }
      if (!jsonStructurallyEqual(latest, expectedBefore)) throw new Error('保存前发现世界书已被其他页面修改。工作副本已保留，请重新读取后再处理。');
      writeStarted = true;
      faultReportBookEvent(book, { type: 'write-call', phase: 'save' });
      await updateWorldbookWith(book, current => {
        assertUniqueEntries(current);
        faultReportBookEvent(book, { type: 'write-callback', comparison: faultReportDiff(expectedBefore, current) });
        if (!jsonStructurallyEqual(current, expectedBefore)) throw new Error('保存回调取得的世界书与读取基线不一致，已停止写入。');
        return cloneJson(expectedAfter);
      }, { render: 'immediate' });
      const verified = await getWorldbook(book);
      assertUniqueEntries(verified);
      const accepted = postSaveWorldbookEquivalent(expectedAfter, verified);
      faultReportBookEvent(book, { type: 'save-verified', accepted, verified: faultReportSummary(verified), comparison: faultReportDiff(expectedAfter, verified) });
      if (!accepted) throw new Error('保存后整本回读与工作副本不一致。');
      return cloneJson(verified);
    } catch (error) {
      faultReportBookEvent(book, { type: 'save-error', errorName: error?.name || 'Error' });
      let recovery = '';
      if (writeStarted) {
        try {
          const actual = await getWorldbook(book);
          if (jsonStructurallyEqual(actual, expectedAfter)) {
            faultReportBookEvent(book, { type: 'write-call', phase: 'recovery' });
            await updateWorldbookWith(book, current => {
              if (!jsonStructurallyEqual(current, expectedAfter)) throw new Error('自动恢复前世界书又发生变化。');
              return cloneJson(expectedBefore);
            }, { render: 'immediate' });
            const restored = await getWorldbook(book);
            recovery = jsonStructurallyEqual(restored, expectedBefore) ? ' 已自动恢复到保存前基线。' : ' 自动恢复后的回读仍不一致。';
          } else if (jsonStructurallyEqual(actual, expectedBefore)) recovery = ' 世界书仍保持保存前基线。';
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

  async function saveWorldbookAll(view) {
    if (!view.book || !worldbookIsDirty(view) || view.busy) return true;
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
      view.entryGroups = cloneJson(view.entryGroupBaseline || []);
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
    if(comboWorkspaceActive(view) && view.comboNavArrange){view.drag.anchorId=null;view.drag.comboDropId=null;return;}
    const doc = view.root.ownerDocument;
    const hit = doc.elementFromPoint(clientX, clientY);
    if (comboWorkspaceActive(view)) { view.drag.anchorId = null; view.drag.comboDropId = hit?.closest?.('[data-combo-drop-id]')?.dataset.comboDropId || null; if (view.drag.comboDropId) { view.drag.anchorId = null; return; } }
    const card = hit?.closest?.('.qa-card');
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
    if (view.closed || !drag || drag.autoScrollFrame != null || !drag.autoScrollSpeed) return;
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
    if (view.busy || event.button > 0 || (comboWorkspaceActive(view) && view.comboNavArrange)) return;
    const cardId = card.dataset.entryId;
    view.drag = {
      pointerId: event.pointerId, ids: selectedIdsForCard(view, cardId), anchorId: null, after: false,
      clientX: event.clientX, clientY: event.clientY, autoScrollSpeed: 0, autoScrollFrame: null,
      autoScrollFrameType: null, autoScrollFrameWindow: null, autoScrollLastTime: null,
    };
    if (comboWorkspaceActive(view)) { const scope = new Set(comboOrderedEntries(view).map(entryId)); const chosen = new Set(view.drag.ids); view.drag.ids = comboOrderedEntries(view).map(entryId).filter(id => chosen.has(id) && scope.has(id)); }
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
    if (comboWorkspaceActive(view)) {
      if (!cancelled) { if (drag.comboDropId) addEntriesToGroup(view, drag.comboDropId, drag.ids); else if (drag.anchorId) reorderComboMembers(view, drag.ids, drag.anchorId, drag.after); renderDynamic(view, { list: true }); flashMovedEntries(view, drag.ids); }
      return;
    }
    if (!cancelled && drag.anchorId) {
      const changed = applyWorking(view, '拖动列表排列', () => { const next = dropEntries(view.working, drag.ids, drag.anchorId, drag.after); return view.mixedMode ? refreshMixedBookIndexes(next) : next; }, { noOpMessage: '拖动位置未改变。' });
      if (changed) {
        flashMovedEntries(view, drag.ids);
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
  // Local, privacy-preserving fault report. Data leaves the device only when the user copies it.
  const FAULT_REPORT_STORAGE_KEY = 'inkstone-worldbook-observer:fault-report-v1';
  const FAULT_REPORT_MAX_SESSIONS = 5;
  const FAULT_REPORT_MAX_EVENTS = 160;
  const FAULT_REPORT_BY_VIEW = new WeakMap();
  const FAULT_REPORT_VIEW_BY_BOOK = new Map();
  let faultReportCounter = 0;

  function faultReportHashText(value) {
    const text = String(value ?? '');
    let a = 0x811c9dc5 >>> 0, b = 0x9e3779b9 >>> 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      a = Math.imul(a ^ code, 0x01000193) >>> 0;
      b = Math.imul(b ^ (code + index + 1), 0x85ebca6b) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }

  function faultReportCanonical(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return '[' + value.map(faultReportCanonical).join(',') + ']';
    if (typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + faultReportCanonical(value[key])).join(',') + '}';
    }
    const encoded = JSON.stringify(value);
    return encoded === undefined ? JSON.stringify(String(value)) : encoded;
  }

  function faultReportEntryId(entry, index) {
    try { return entryId(entry); }
    catch (_error) { return 'invalid:' + index; }
  }

  function faultReportSummary(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const ids = list.map(faultReportEntryId);
    return {
      count: list.length,
      exact: faultReportHashText(JSON.stringify(list)),
      canonical: faultReportHashText(faultReportCanonical(list)),
      order: faultReportHashText(JSON.stringify(ids)),
    };
  }

  function faultReportFieldChanges(before, after) {
    const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
    return keys.filter(key => faultReportCanonical(before?.[key]) !== faultReportCanonical(after?.[key]));
  }

  function faultReportDiff(beforeEntries, afterEntries) {
    const before = Array.isArray(beforeEntries) ? beforeEntries : [];
    const after = Array.isArray(afterEntries) ? afterEntries : [];
    const beforeIds = before.map(faultReportEntryId), afterIds = after.map(faultReportEntryId);
    const beforeMap = new Map(before.map((entry, index) => [beforeIds[index], entry]));
    const afterMap = new Map(after.map((entry, index) => [afterIds[index], entry]));
    const changedFields = [];
    for (const id of beforeIds) {
      if (!afterMap.has(id)) continue;
      const fields = faultReportFieldChanges(beforeMap.get(id), afterMap.get(id));
      if (fields.length) changedFields.push({ id, fields });
    }
    const sameMembers = beforeIds.length === afterIds.length && beforeIds.every(id => afterMap.has(id));
    return {
      exactSame: JSON.stringify(before) === JSON.stringify(after),
      structuralSame: faultReportCanonical(before) === faultReportCanonical(after),
      entryOrderChanged: sameMembers && JSON.stringify(beforeIds) !== JSON.stringify(afterIds),
      addedIds: afterIds.filter(id => !beforeMap.has(id)).slice(0, 24),
      removedIds: beforeIds.filter(id => !afterMap.has(id)).slice(0, 24),
      changedFields: changedFields.slice(0, 48),
    };
  }

  function faultReportReadStore() {
    try {
      const raw = hostWindow().localStorage?.getItem?.(FAULT_REPORT_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && Array.isArray(parsed.sessions) ? parsed : { schemaVersion: 1, sessions: [] };
    } catch (_error) { return { schemaVersion: 1, sessions: [] }; }
  }

  function faultReportPersist(session) {
    if (!session) return;
    try {
      const store = faultReportReadStore();
      const at = store.sessions.findIndex(item => item.id === session.id);
      if (at >= 0) store.sessions[at] = session;
      else store.sessions.push(session);
      store.sessions = store.sessions.slice(-FAULT_REPORT_MAX_SESSIONS);
      hostWindow().localStorage?.setItem?.(FAULT_REPORT_STORAGE_KEY, JSON.stringify(store));
    } catch (_error) {}
  }

  function faultReportPush(view, payload, { collapse = false } = {}) {
    const session = FAULT_REPORT_BY_VIEW.get(view);
    if (!session) return null;
    const event = { at: new Date().toISOString(), ...payload };
    const last = session.events.at(-1);
    if (collapse && last?.type === event.type && last?.label === event.label) session.events[session.events.length - 1] = event;
    else session.events.push(event);
    if (session.events.length > FAULT_REPORT_MAX_EVENTS) session.events.splice(0, session.events.length - FAULT_REPORT_MAX_EVENTS);
    faultReportPersist(session);
    return event;
  }

  function faultReportStart(view, book, baseline) {
    const session = {
      schemaVersion: 1,
      id: Date.now() + '-' + (++faultReportCounter),
      appVersion: APP.version,
      bookFingerprint: faultReportHashText(String(book || '')),
      startedAt: new Date().toISOString(),
      baseline: faultReportSummary(baseline),
      events: [],
    };
    FAULT_REPORT_BY_VIEW.set(view, session);
    FAULT_REPORT_VIEW_BY_BOOK.set(String(book || ''), view);
    faultReportPush(view, { type: 'session-start', baseline: session.baseline });
    return session;
  }

  function faultReportMutation(view, label) {
    if (!FAULT_REPORT_BY_VIEW.get(view) || !view?.baseline || !view?.working) return;
    faultReportPush(view, {
      type: 'working-change', label: String(label || ''),
      working: faultReportSummary(view.working),
      local: faultReportDiff(view.baseline, view.working),
    }, { collapse: label === '编辑条目正文' });
  }

  function faultReportViewForBook(book) {
    const view = FAULT_REPORT_VIEW_BY_BOOK.get(String(book || ''));
    return view && !view.closed ? view : null;
  }

  function faultReportBookEvent(book, payload) {
    const view = faultReportViewForBook(book);
    if (view) faultReportPush(view, payload);
  }

  function faultReportCaptureDrafts(view) {
    if (!FAULT_REPORT_BY_VIEW.get(view) || !view?.root) return;
    const titles = [];
    for (const input of Array.from(view.root.querySelectorAll?.('[data-control="entry-name-inline"]') || [])) {
      const id = input.closest?.('.qa-card')?.dataset?.entryId || '';
      const entry = (view.working || []).find(candidate => {
        try { return entryId(candidate) === id; } catch (_error) { return false; }
      });
      titles.push({
        id,
        draft: faultReportHashText(String(input.value ?? '')),
        working: faultReportHashText(String(entry?.name ?? '')),
        committed: String(input.value ?? '') === String(entry?.name ?? ''),
      });
    }
    faultReportPush(view, { type: 'ui-drafts', titles });
  }

  function faultReportExport(view) {
    const session = FAULT_REPORT_BY_VIEW.get(view);
    if (session) faultReportPersist(session);
    const store = faultReportReadStore();
    return JSON.stringify({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      appVersion: APP.version,
      privacy: 'No book name, title, body, or keyword raw values are included.',
      sessions: store.sessions.slice(-FAULT_REPORT_MAX_SESSIONS),
    }, null, 2);
  }

  async function faultReportCopy(view) {
    const text = faultReportExport(view);
    const navigatorObject = hostWindow().navigator || globalThis.navigator;
    if (navigatorObject?.clipboard?.writeText) {
      await navigatorObject.clipboard.writeText(text);
      return true;
    }
    const doc = hostDocument();
    if (!doc?.createElement) return false;
    const node = doc.createElement('textarea');
    node.value = text;
    node.setAttribute('readonly', '');
    node.style.position = 'fixed';
    node.style.opacity = '0';
    doc.body?.appendChild(node);
    node.select?.();
    const copied = Boolean(doc.execCommand?.('copy'));
    node.remove?.();
    return copied;
  }
  // Transitional adapter: the existing complete UI, not a new mobile/PC UI.
  // Only compat callers may create it; future UIs supply their own adapter.
  function createLegacyUiAdapter() {
    return Object.freeze({
      id: 'compat-v04193',
      template: templateHtml,
      parts: createLegacyUiParts(),
      mount(view, popup) {
        view.root = popup.dlg?.querySelector('#iwb-qa-root');
        if (!view.root) throw new Error('原生弹窗已打开，但未找到常用编辑容器。');
        applyTheme(view, readThemePreference(), false);
        installMobileViewport(view, popup);
        bindView(view);
      },
      refresh: renderLegacyDynamic,
      canClose: legacyCanClose,
      unmount: releaseLegacyUi,
    });
  }
  function ensureLegacyUiSession(view) {
    // Existing legacy headless callers may have a view without a host mount.
    // Never replace a selected adapter, including when it throws or is disposed.
    if (!view.uiSession) view.uiSession = createUiSession(view, createLegacyUiAdapter());
    return view.uiSession;
  }
  function renderDynamic(view, options = {}) {
    if (!view || view.closed) return;
    return ensureLegacyUiSession(view).refresh(options);
  }
  function legacyUiTimeout(view, key, callback, delay) {
    return ensureLegacyUiSession(view).resources.timeout(key, callback, delay);
  }
  function legacyUiFrame(view, callback) {
    return ensureLegacyUiSession(view).resources.frame(hostWindow(), callback);
  }
  function releaseLegacyUi(view) {
    for (const key of ['searchTimer', 'bodySearchTimer', 'contentTokenTimer',
      'arrangeFlashTimer', 'entryMoveFeedbackTimer']) {
      clearTimeout(view[key]);
      view[key] = null;
    }
    // These cancel animation work and clear feedback while the root still exists.
    const errors = [];
    for (const release of [clearEntryMoveFeedback, clearEntryDragFeedback,
      stopDragAutoScroll, removeMobileViewport]) {
      try { release(view); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Legacy UI cleanup failed');
  }


  function createLegacyViewState() {
    return {
      root: null, popup: null, names: [], book: '', baseline: null, working: null, mixedMode: false, activeBooks: [], catalogActiveBooks: [], catalogReady: false, catalogError: '', bookPickerOpen: false, bookPickerQuery: '', bookStates: new Map(), mixedSignature: '', slotBaseline: [], sourceVisible: true, transferStates: new Map(), transferMoveTargets: new Set(), transferDraft: createTransferDraft(), transferReturnScroll: 0, toolsOpen: false, mobileMenu: null, mobileMode: 'edit', activeEntryGroupId: '', entryGroupEditingId: null, titleLocked: true,
      selected: new Set(), expanded: new Set(), undo: [], query: '', stateFilter: 'all', positionFilter: 'all', searchOpen: false, moveMode: false,
      renderLimit: APP.chunkSize, panel: null, leaveIntent: null, leaveError: '', discardConfirmOpen: false, loading: false, busy: null,
      error: '', closed: false, forceClose: false, searchTimer: null, drag: null, tokenCounts: new Map(), tokenTask: null,
      contentEditor: null, contentDiscardIntent: null, contentTokenTimer: null, entryMoveFeedbackTimer: null,
      guideOpen: false, guideScrollTop: 0, guideReturnFocus: null,
      theme: DEFAULT_THEME, themePickerOpen: false, themeReturnFocus: null,
      keywordInternalPointer: false, nameClickGuard: null,
      popupDialog: null, mobileViewport: null, onMobileViewportChange: null,
      viewportBaselineHeight: 0, viewportLastWidth: 0,
      positionDraft: { type: 'before_character_definition', depth: '4', role: 'system' },
      orderDraft: { mode: 'same', start: '100', gap: '10' },
      importDraft: { source: '', entries: null, selected: new Set(), previewed: new Set(), query: '', filter: 'all', loading: false, error: '' },
      entryGroups: [], entryGroupBaseline: [], entryGroupDocument: null, entryGroupNameDraft: '',
      arrangeDraft: [], arrangeInitialDraft: null, arrangeDrag: null, arrangeFlashIndex: null, arrangeFlashTimer: null,
    };
  }


  async function legacyCanClose(view) {
    if (view.contentDiscardIntent) { view.contentDiscardIntent = null; renderLeaveModal(view); return false; }
    if (view.discardConfirmOpen) { view.discardConfirmOpen = false; renderLeaveModal(view); return false; }
    if (view.bookPickerOpen) { closeBookPicker(view, true); return false; }
    if (view.themePickerOpen) { closeThemePicker(view); return false; }
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
  }





  function installMobileViewport(view, popup) {
    removeMobileViewport(view);
    const outer = hostWindow();
    const resources = ensureLegacyUiSession(view).resources;
    view.popupDialog = popup.dlg || null;
    view.mobileViewport = outer.visualViewport || null;
    view.onMobileViewportChange = () => syncMobileViewport(view);
    view.uiViewportReleases = [
      resources.listen(view.mobileViewport, 'resize', view.onMobileViewportChange, { passive: true }),
      resources.listen(outer, 'resize', view.onMobileViewportChange, { passive: true }),
    ];
    syncMobileViewport(view);
  }

  function removeMobileViewport(view) {
    for (const release of view.uiViewportReleases || []) release();
    view.uiViewportReleases = [];
    view.mobileViewport = null;
    view.onMobileViewportChange = null;
    view.popupDialog = null;
  }
  // Temporary data port for the combined legacy view. No UI fields cross it.
  // Keep the existing checkpoint/group-normalization algorithm unchanged.
  function legacyEntryDataPort(view) {
    return Object.freeze({
      getBusy: () => view.busy,
      getWorking: () => view.working,
      commit(next, label) {
        pushUndo(view, label);
        view.working = next;
      },
    });
  }

  // Legacy presentation only; future mobile/desktop controllers own their UI.
  function batchSetEnabledSelected(view, enabled, render = renderDynamic, notify = toast) {
    const verb = enabled ? '启用' : '停用';
    const result = runSetEntriesEnabled(legacyEntryDataPort(view), [...view.selected],
      enabled, `批量${verb}条目`);
    if (result.status === 'busy') {
      return { changedCount: 0, skippedCount: result.skippedCount, changed: false };
    }
    if (result.changed) render(view, { list: true });
    notify('info', result.changed
      ? `已在工作副本中${verb} ${result.changedCount} 条；跳过 ${result.skippedCount} 条。`
      : `没有条目需要${verb}；跳过 ${result.skippedCount} 条。`);
    return { changedCount: result.changedCount, skippedCount: result.skippedCount,
      changed: result.changed };
  }

  // Temporary service facade: shared data + existing session/host orchestration.
  // Some working-copy coordinators still have UI effects; not a fully pure core.
  // No compat/ui template, renderer or event implementation is passed here.
  function createMobileServicePort() {
    return Object.freeze({
      APP,
      DEFAULT_THEME,
      MIXED_BOOK_VALUE,
      POSITION_LABELS,
      POSITION_TYPES,
      ROLE_LABELS,
      TEST_MODE,
      THEME_IDS,
      activeSourceText,
      addEntriesToGroup,
      applyContentDraft,
      applyGroupRelations,
      applyTransfer,
      applyWorking,
      applyWorkingQuiet,
      arrangeDraftChanged,
      arrangeMixedWorking,
      arrangeNamesByDirection,
      assertUniqueEntries,
      batchDeleteSelected,
      batchSetEnabledSelected,
      bookPickerMatches,
      bookPickerTriggerLabel,
      bookSelectorGroups,
      bookSelectorLabel,
      changedIds,
      cloneJson,
      comboOrderedEntries,
      comboSelectedIds,
      comboWorkspaceActive,
      contentEditorChanged,
      copyEntry,
      copyMixedEntry,
      createContentEditorState,
      createMinimalEntry,
      createOrUpdateEntryGroup,
      createTransferDraft,
      cssEscape,
      disableAllRecursion,
      discardTransferChanges,
      dropEntries,
      editableActivationType,
      effectiveArrangeRules,
      effectiveMixedArrangeRules,
      enabledPresentation,
      entryGroupIdSets,
      entryGroupMembership,
      entryId,
      entryName,
      escapeHtml,
      getTokenCounter,
      hostDocument,
      hostWindow,
      importEntriesAtTop,
      inlineFieldMutation,
      isDirty,
      listSelectionScope,
      loadArrangeRules,
      loadBook,
      loadMixedArrangeRules,
      mergePrimaryKeys,
      mixedDirtyBooks,
      moveArrangeDraft,
      moveComboMember,
      moveComboSelection,
      moveEntries,
      mutateEntry,
      mutateOrder,
      mutatePosition,
      normalizeNameArrangePreference,
      normalizePrimaryKeys,
      pendingChangeCount,
      pendingSummary,
      positionInfo,
      primaryKeys,
      readNameArrangePreference,
      readNames,
      readThemePreference,
      refreshMixedBookIndexes,
      removeEntryGroup,
      removePrimaryKey,
      renameEntryGroup,
      reorderComboGroups,
      reorderComboMembers,
      replaceBodySearchResults,
      requirePublicFunction,
      resetArrangeDraft,
      restoreTransferSnapshot,
      saveAll,
      saveArrangeRules,
      saveEditedEntryGroup,
      saveMixedArrangeRules,
      saveNameArrangePreference,
      saveSourceVisible,
      saveThemePreference,
      searchWorkspaceActive,
      searchWorkspaceResults,
      selectEntryGroup,
      selectListScope,
      selectedIdsForCard,
      setEntryGroupEnabled,
      stableAutoArrange,
      toast,
      toastComboCreated,
      tokenLabel,
      upsertEntryGroup,
      visibleEntries,
      visibleImportEntries,
      visibleTransferEntries,
    });
  }
  // Explicit business/design facade for the independent desktop UI.
  // No compat or mobile template, renderer, event, or stylesheet is exposed.
  function createDesktopServicePort() {
    return Object.freeze({
      APP,
      DEFAULT_THEME,
      POSITION_LABELS,
      POSITION_TYPES,
      ROLE_LABELS,
      applyWorking,
      applyTransfer,
      applyTheme,
      addEntriesToGroup,
      arrangeNamesByDirection,
      batchSetEnabledSelected,
      cancelLeavePrompt,
      cloneJson,
      comboOrderedEntries,
      comboSelectedIds,
      completeLeave,
      createEntryGroupWithMembers,
      createTransferDraft,
      defaultArrangeRules,
      disableAllRecursion,
      discardTransferChanges,
      entryId,
      entryGroupMembership,
      entryName,
      effectiveArrangeRules,
      faultReportCopy,
      hostDocument,
      hostWindow,
      inlineFieldMutation,
      isDirty,
      importEntriesAtTop,
      loadBook,
      loadArrangeRules,
      mutateOrder,
      mutatePosition,
      moveComboSelection,
      moveEntryGroupByDirection,
      normalizeNameArrangePreference,
      pendingSummary,
      positionInfo,
      readNameArrangePreference,
      readThemePreference,
      readWorldbookEntries,
      replaceBodySearchResults,
      renameEntryGroup,
      saveAll,
      saveArrangeRules,
      saveNameArrangePreference,
      searchWorkspaceResults,
      showLeavePrompt,
      setEntryGroupEnabled,
      stableAutoArrange,
      tokenLabel,
      restoreTransferSnapshot,
      visibleImportEntries,
      visibleTransferEntries,
      toast,
      visibleEntries,
      deleteEntryGroupFromView,
    });
  }
  // Tablet uses the accepted wide-screen business facade while owning its layout boundary.
  function createTabletServicePort() {
    return createDesktopServicePort();
  }

  // Mobile owns a private complete presentation tree. No compat UI imports.
  function createMobileUiAdapter(ports) {
    const {
      APP,
      DEFAULT_THEME,
      MIXED_BOOK_VALUE,
      POSITION_LABELS,
      POSITION_TYPES,
      ROLE_LABELS,
      TEST_MODE,
      THEME_IDS,
      activeSourceText,
      addEntriesToGroup,
      applyContentDraft,
      applyGroupRelations,
      applyTransfer,
      applyWorking,
      applyWorkingQuiet,
      arrangeDraftChanged,
      arrangeMixedWorking,
      arrangeNamesByDirection,
      assertUniqueEntries,
      batchDeleteSelected,
      batchSetEnabledSelected,
      bookPickerMatches,
      bookPickerTriggerLabel,
      bookSelectorGroups,
      bookSelectorLabel,
      changedIds,
      cloneJson,
      comboOrderedEntries,
      comboSelectedIds,
      comboWorkspaceActive,
      contentEditorChanged,
      copyEntry,
      copyMixedEntry,
      createContentEditorState,
      createMinimalEntry,
      createOrUpdateEntryGroup,
      createTransferDraft,
      cssEscape,
      disableAllRecursion,
      discardTransferChanges,
      dropEntries,
      editableActivationType,
      effectiveArrangeRules,
      effectiveMixedArrangeRules,
      enabledPresentation,
      entryGroupIdSets,
      entryGroupMembership,
      entryId,
      entryName,
      escapeHtml,
      getTokenCounter,
      hostDocument,
      hostWindow,
      importEntriesAtTop,
      inlineFieldMutation,
      isDirty,
      listSelectionScope,
      loadArrangeRules,
      loadBook,
      loadMixedArrangeRules,
      mergePrimaryKeys,
      mixedDirtyBooks,
      moveArrangeDraft,
      moveComboMember,
      moveComboSelection,
      moveEntries,
      mutateEntry,
      mutateOrder,
      mutatePosition,
      normalizeNameArrangePreference,
      normalizePrimaryKeys,
      pendingChangeCount,
      pendingSummary,
      positionInfo,
      primaryKeys,
      readNameArrangePreference,
      readNames,
      readThemePreference,
      refreshMixedBookIndexes,
      removeEntryGroup,
      removePrimaryKey,
      renameEntryGroup,
      reorderComboGroups,
      reorderComboMembers,
      replaceBodySearchResults,
      requirePublicFunction,
      resetArrangeDraft,
      restoreTransferSnapshot,
      saveAll,
      saveArrangeRules,
      saveEditedEntryGroup,
      saveMixedArrangeRules,
      saveNameArrangePreference,
      saveSourceVisible,
      saveThemePreference,
      searchWorkspaceActive,
      searchWorkspaceResults,
      selectEntryGroup,
      selectListScope,
      selectedIdsForCard,
      setEntryGroupEnabled,
      stableAutoArrange,
      toast,
      toastComboCreated,
      tokenLabel,
      upsertEntryGroup,
      visibleEntries,
      visibleImportEntries,
      visibleTransferEntries,
    } = ports;
  // Remaining pre-cleanup component styles. Workbench and dialogs have moved out.
  const STYLES = String.raw`
    #iwb-qa-root{--qa-bg:var(--SmartThemeBlurTintColor,rgba(20,22,27,.97));--qa-card-bg:color-mix(in srgb,var(--qa-bg) 94%,var(--SmartThemeBodyColor,#eee) 6%);--qa-edit-bg:color-mix(in srgb,var(--qa-bg) 90%,var(--SmartThemeBodyColor,#eee) 10%);--qa-card-line:color-mix(in srgb,var(--SmartThemeBodyColor,#eee) 38%,var(--qa-bg) 62%);--qa-selected-line:#78bdff;--qa-panel-bg:color-mix(in srgb,var(--qa-bg) 88%,var(--SmartThemeBodyColor,#eee) 12%);--qa-panel-line:color-mix(in srgb,var(--SmartThemeBodyColor,#eee) 48%,var(--qa-bg) 52%);--qa-line:color-mix(in srgb,var(--SmartThemeBodyColor,#eee) 20%,transparent);color:var(--SmartThemeBodyColor,#eee);font:14px/1.4 system-ui,sans-serif;width:100%;max-width:760px;min-width:0;height:min(92dvh,900px);max-height:92dvh;margin:0 auto;overflow:hidden;position:relative}
    #iwb-qa-root *{box-sizing:border-box}#iwb-qa-root button,#iwb-qa-root input,#iwb-qa-root select,#iwb-qa-root textarea{font:inherit;color:inherit}
    .qa-shell{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:var(--qa-bg);border:1px solid var(--qa-line);border-radius:16px;overflow:hidden;box-shadow:0 18px 50px #0008}
    .qa-head{padding:8px 10px 7px;border-bottom:1px solid var(--qa-line);background:color-mix(in srgb,var(--qa-bg) 94%,#fff 6%);display:grid;gap:6px}
    .qa-title-row,.qa-book-row,.qa-tool-row,.qa-footer-row,.qa-summary-actions,.qa-content-head{display:flex;gap:5px;align-items:center;min-width:0}.qa-title{min-width:0;flex:1}.qa-title h2{font-size:16px;line-height:1.2;margin:0}.qa-title p{font-size:11px;opacity:.7;margin:2px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qa-mode-toggle[aria-pressed="true"]{border-color:var(--qa-selected-line);color:var(--qa-selected-line);background:color-mix(in srgb,var(--qa-selected-line) 10%,transparent)}
    .qa-icon{width:38px;min-width:38px;height:38px;border:1px solid transparent;border-radius:7px;background:transparent;display:grid;place-items:center}.qa-icon:hover,.qa-icon:focus-visible{border-color:var(--qa-line);background:#0002}.qa-icon:disabled{opacity:.38}.qa-mobile-close{display:none}.qa-book-row .qa-select{flex:1}
    .qa-book-picker{position:relative;min-width:0}.qa-book-picker-trigger{width:100%;height:34px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 8px;border:1px solid var(--qa-card-line);border-radius:6px;background:#0002;color:inherit;text-align:left}.qa-book-picker-trigger>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qa-book-picker-trigger[aria-expanded="true"]{border-color:var(--qa-selected-line);box-shadow:0 0 0 1px color-mix(in srgb,var(--qa-selected-line) 28%,transparent)}.qa-book-picker-trigger:disabled{opacity:.58}.qa-book-picker-popover{position:absolute;z-index:40;top:calc(100% + 5px);left:0;width:min(100%,520px);min-width:min(100%,320px);max-height:min(58dvh,470px);display:grid;grid-template-rows:auto minmax(0,1fr);gap:7px;padding:8px;border:1px solid var(--qa-card-line);border-radius:10px;background:var(--qa-bg);box-shadow:0 16px 40px #0008}.qa-book-picker-popover[hidden]{display:none}.qa-book-picker-search{height:38px!important;background:var(--qa-edit-bg)!important}.qa-book-picker-results{min-height:0;overflow:auto;overscroll-behavior:contain;display:grid;gap:8px}.qa-book-picker-group{display:grid;gap:3px}.qa-book-picker-group h3{position:sticky;top:0;z-index:1;margin:0;padding:5px 7px;font-size:12px;color:inherit;background:var(--qa-panel-bg);border-radius:6px}.qa-book-picker-item{min-height:38px;width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border:1px solid transparent;border-radius:7px;background:transparent;color:inherit;text-align:left}.qa-book-picker-item>span{min-width:0;overflow-wrap:anywhere}.qa-book-picker-item:hover,.qa-book-picker-item:focus-visible{border-color:var(--qa-card-line);background:var(--qa-edit-bg)}.qa-book-picker-item.is-current{border-color:var(--qa-selected-line);background:color-mix(in srgb,var(--qa-selected-line) 13%,var(--qa-bg))}.qa-book-picker-empty{padding:24px 10px;text-align:center;opacity:.7}.qa-book-picker.is-locked .qa-book-picker-trigger{cursor:not-allowed}
    .qa-input,.qa-select,.qa-textarea{width:100%;min-width:0;border:1px solid var(--qa-card-line);border-radius:6px;background:#0002;padding:0 8px}.qa-input,.qa-select{height:34px}.qa-textarea{min-height:150px;resize:vertical;padding-block:8px;line-height:1.5}.qa-status{font-size:11px;opacity:.78;overflow-wrap:anywhere}
    .qa-search-row{display:grid;grid-template-columns:minmax(0,1fr) 118px;gap:6px}.qa-search-row[hidden]{display:none}.qa-segments{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}.qa-segment{min-width:0;min-height:32px;border:1px solid var(--qa-card-line);border-radius:8px;background:#0002;padding:4px 5px;font-size:12px}.qa-segment.is-active{border-color:#78bdff;background:#267bc8;color:#fff;font-weight:700}
    .qa-scroll{min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;padding:6px 7px 10px;scrollbar-gutter:stable}.qa-empty{padding:28px 14px;text-align:center;opacity:.72}
    .qa-list{display:grid;gap:5px}
    .qa-summary-actions{justify-content:flex-start;margin-top:2px;overflow-x:auto;scrollbar-width:none;gap:1px}.qa-action-icon,.qa-drag,.qa-move{flex:0 0 auto;min-width:40px;min-height:40px;border:1px solid transparent;border-radius:6px;background:transparent;padding:4px 6px}.qa-action-icon:hover,.qa-action-icon:focus-visible,.qa-drag:hover,.qa-drag:focus-visible,.qa-move:hover,.qa-move:focus-visible{border-color:var(--qa-line);background:#0002}.qa-action-icon{font-size:14px}.qa-delete:hover,.qa-delete:focus-visible,.qa-delete:active{color:#ff9f9f;border-color:#d96d6d;background:color-mix(in srgb,#9d2d2d 18%,transparent)}.qa-drag{touch-action:none;cursor:grab;font-size:15px}.qa-switch{position:relative;flex:0 0 44px;width:44px;height:44px;border:0;background:transparent;padding:0}.qa-switch:before{content:'';position:absolute;left:7px;top:13px;width:30px;height:18px;border:1px solid var(--qa-line);border-radius:10px;background:#0004;transition:background .12s,border-color .12s}.qa-switch:after{content:'';position:absolute;top:16px;left:10px;width:12px;height:12px;border-radius:50%;background:#aaa;transition:transform .12s,background .12s}.qa-switch[aria-checked="true"]:before{background:#36905a;border-color:#78d59b}.qa-switch[aria-checked="true"]:after{transform:translateX(12px);background:#fff}.qa-lamp{min-width:40px;font-size:18px;line-height:1;font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif;font-variant-emoji:emoji}.qa-lamp.readonly{opacity:.72}
    .qa-editor{margin-top:3px;padding:5px 0 1px;border:0;border-top:1px solid var(--qa-line);border-radius:0;background:transparent;display:grid;gap:5px}.qa-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}.qa-field{display:grid;gap:2px;min-width:0}.qa-field>span,.qa-content-label>span{font-size:10px;font-weight:700;opacity:.78}.qa-field.qa-wide{grid-column:1/-1}.qa-advanced-note{font-size:10px;color:#ffd28a}.qa-content-label{display:flex;align-items:center;min-width:0}.qa-content-label>span{flex:1}.qa-content-uid{font:inherit;font-weight:400;opacity:.62}.qa-content-preview{width:100%;min-width:0;min-height:9.8em;max-height:12em;padding:6px 7px;border:0;border-left:2px solid var(--qa-line);border-radius:0;background:transparent;font-size:11px;line-height:1.4;display:block;overflow-x:hidden;overflow-y:auto;overflow-wrap:anywhere;white-space:pre-wrap}.qa-content-open{width:44px;min-width:44px;height:44px;min-height:44px;padding:0;border:0!important;border-radius:6px;background:transparent!important;box-shadow:none!important;display:grid;place-items:center;opacity:.76}.qa-content-open:hover,.qa-content-open:focus-visible{background:#0002!important;opacity:1}.qa-keyword-editor{display:flex;flex-wrap:wrap;gap:4px;align-items:flex-end;min-width:0}.qa-keyword-chip{display:inline-flex;align-items:center;gap:3px;max-width:100%;min-height:26px;padding:2px 4px 2px 7px;border:1px solid var(--qa-line);border-radius:999px;background:#0002;font-size:11px}.qa-keyword-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qa-keyword-remove{width:24px;height:24px;padding:0;border:0;border-radius:50%;background:transparent;opacity:.72}.qa-keyword-remove:hover,.qa-keyword-remove:focus-visible{background:#0003;opacity:1}.qa-keyword-input{flex:1 1 116px;min-width:92px;height:31px;max-height:62px;resize:none;border:0;border-bottom:1px solid var(--qa-card-line);border-radius:0;background:transparent;padding:5px 4px;line-height:20px;outline-offset:2px}.qa-keyword-add{min-width:44px;min-height:36px}
    .qa-content-layer{position:absolute;inset:0;z-index:20;display:grid;grid-template-rows:auto minmax(0,1fr);background:var(--qa-bg);min-width:0;min-height:0}.qa-content-layer[hidden]{display:none}.qa-content-head{padding:calc(8px + env(safe-area-inset-top)) 8px 8px;border-bottom:1px solid var(--qa-line);background:color-mix(in srgb,var(--qa-bg) 94%,#fff 6%)}.qa-content-context{flex:1;min-width:0}.qa-content-context strong,.qa-content-context small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qa-content-context small{font-size:11px;opacity:.7;margin-top:2px}.qa-content-body{min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);gap:6px;padding:8px calc(8px + env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) calc(8px + env(safe-area-inset-left))}.qa-content-token{font-size:11px;opacity:.75}.qa-content-textarea{width:100%;height:100%;min-height:0;resize:none;border:1px solid var(--qa-card-line);border-radius:10px;background:#0003;padding:10px;line-height:1.55}
    .qa-more{width:100%;margin-top:8px;min-height:38px;border:1px dashed var(--qa-line);border-radius:7px;background:transparent}.qa-footer-row{overflow-x:auto;scrollbar-width:none}.qa-batch-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}.qa-batch-actions .qa-btn{width:100%;min-width:0;height:34px;min-height:34px;padding-inline:3px;font-size:12px;line-height:1;white-space:nowrap;overflow:hidden}.qa-footer-bottom{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px;align-items:center;min-width:0}.qa-main-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) minmax(0,1.35fr);gap:4px;align-items:center;min-width:0}.qa-main-actions .qa-btn{width:100%;min-width:0;padding-inline:3px;white-space:nowrap}.qa-count{min-width:64px;font-size:11px;line-height:1.25;overflow-wrap:anywhere}.qa-count-narrow{display:none}.qa-btn{flex:0 0 auto;min-height:34px;border:1px solid var(--qa-line);border-radius:7px;background:transparent;padding:5px 8px}.qa-btn:hover,.qa-btn:focus-visible{background:#0002}.qa-btn.primary{background:#377fd5;border-color:#5b9ce8;color:#fff}.qa-btn.danger{color:#ffb7b7}.qa-btn:disabled{opacity:.38}.qa-panel{border:1px solid var(--qa-panel-line);border-radius:7px;padding:6px;background:var(--qa-panel-bg);display:grid;gap:5px}.qa-panel h3{font-size:13px;margin:0}.qa-panel-note{font-size:11px;opacity:.78;overflow-wrap:anywhere}.qa-leave{border-color:#e6aa55}.qa-loading{pointer-events:none;opacity:.65}
    .qa-guide-layer{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:calc(12px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right)) calc(12px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left))}.qa-guide-layer[hidden]{display:none}.qa-guide-backdrop{position:absolute;inset:0;border:0;background:#0009}.qa-guide-dialog{position:relative;z-index:1;width:min(420px,100%);max-height:min(78dvh,520px);display:grid;grid-template-rows:auto minmax(0,1fr);border:1px solid var(--qa-panel-line);border-radius:10px;background:var(--qa-bg);box-shadow:0 18px 48px #000a;overflow:hidden}.qa-guide-head{display:flex;align-items:center;gap:6px;padding:8px 8px 6px;border-bottom:1px solid var(--qa-line)}.qa-guide-head h3{flex:1;min-width:0;margin:0;font-size:15px}.qa-guide-body{min-height:0;overflow:auto;padding:10px 12px}.qa-guide-body ul{margin:0;padding-left:19px;display:grid;gap:8px}
    .iwb-qa-host{width:min(760px,calc(100dvw - 8px))!important;max-width:calc(100dvw - 8px)!important;min-width:0!important;margin-inline:auto!important;padding-inline:0!important;overflow:hidden!important}.iwb-qa-host .popup-body,.iwb-qa-host .popup-content{box-sizing:border-box!important;width:100%!important;max-width:100%!important;min-width:0!important;margin-inline:0!important;padding-inline:0!important;overflow-x:hidden!important}.qa-shell,.qa-head,.qa-title-row,.qa-book-row,.qa-search-row,.qa-status,.qa-scroll,.qa-list,.qa-panel,.qa-fields,.qa-content-layer,.qa-content-body{box-sizing:border-box;width:100%;max-width:100%;min-width:0}
    .qa-tool-actions{display:grid;grid-template-columns:minmax(0,1.7fr) repeat(2,minmax(0,1fr));gap:4px}.qa-tool-actions .qa-btn{min-width:0;padding-inline:4px;white-space:nowrap;overflow:hidden}.qa-arrange-list{max-height:156px;overflow:auto;display:grid;gap:3px}.qa-arrange-row{display:grid;grid-template-columns:minmax(0,1fr) 38px 38px;gap:4px;align-items:center}.qa-arrange-row span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qa-arrange-row .qa-btn{padding:3px;min-height:32px}.qa-import-list{max-height:190px;overflow:auto;display:grid;gap:3px;padding:2px}.qa-import-item{display:grid;grid-template-columns:26px minmax(0,1fr);gap:5px;align-items:center;min-height:34px;padding:2px 4px;border:1px solid var(--qa-line);border-radius:6px}.qa-import-item span{min-width:0;overflow-wrap:anywhere}.qa-import-summary{font-size:11px;opacity:.78}
    .qa-top-grid{display:grid;grid-template-columns:minmax(0,1fr) 92px;gap:7px;align-items:stretch}.qa-top-grid>.qa-top-left,.qa-top-grid>.qa-top-right{min-width:0;width:100%;height:34px}.qa-top-grid>.qa-book-picker{height:auto}.qa-filter-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;min-width:0}.qa-filter-pair>.qa-input,.qa-filter-pair>.qa-select{min-width:0;width:100%;height:34px;padding-inline:5px;white-space:nowrap}.qa-mode-segments{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:5px!important}.qa-title-lock{white-space:nowrap;padding-inline:4px}.qa-import-workspace{min-height:100%;display:grid;align-content:start;gap:9px;padding:8px}.qa-import-workspace h3{margin:0 0 3px}.qa-import-body{display:grid;gap:7px;min-height:0}.qa-import-selection-note{font-size:11px;opacity:.72}.qa-import-actions{position:sticky;bottom:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;padding:7px 0 2px;background:var(--qa-bg);z-index:2}.qa-import-actions .qa-btn{min-width:0}.qa-import-active .qa-filter-pair,.qa-import-active .qa-top-grid>[data-action="other-tools"],.qa-import-active [data-slot="other-tools"],.qa-import-active [data-slot="status"]{display:none!important}.qa-scroll.qa-import-mode{padding:0}.qa-shell{grid-template-rows:auto auto minmax(0,1fr) auto}.qa-title h2{font-size:17px}.qa-title p{display:none}.qa-book-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:end}.qa-new-top{min-width:92px;white-space:nowrap}.qa-mode-segments{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.qa-mode-segment{height:34px;border:1px solid var(--qa-card-line);border-radius:7px;background:#0002}.qa-mode-segments .qa-mode-segment{background:#fff;color:#1b1f24!important;border-color:#d7dce2}.qa-mode-segments .qa-mode-segment.is-active{border-color:var(--qa-selected-line);background:#267bc8;color:#fff!important;font-weight:700}.qa-filter-pair input[data-control="search"]{background:#fff;color:#1b1f24!important;border-color:#d7dce2}.qa-filter-pair [data-control="search"]::placeholder{color:#69717c;opacity:1}.qa-compact-tools{display:grid;grid-template-columns:minmax(66px,.55fr) minmax(146px,1.45fr) auto;gap:5px}.qa-compact-tools .qa-input,.qa-compact-tools .qa-select,.qa-compact-tools .qa-btn{min-width:0;width:100%;padding-inline:5px;white-space:nowrap}.qa-other-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;padding-top:2px}.qa-other-tools[hidden]{display:none}.qa-other-tools .qa-btn{min-width:0;white-space:normal}.qa-other-tools .qa-btn:last-child{grid-column:1/-1}.qa-arrange-quick{min-width:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}.qa-arrange-quick .qa-btn{width:100%;min-width:0;padding-inline:3px;white-space:nowrap}.qa-batch-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}.qa-arrange-row{grid-template-columns:minmax(0,1fr) 92px 36px 36px}.qa-arrange-label{display:grid;min-width:0}.qa-arrange-label span{overflow-wrap:anywhere}.qa-arrange-label small{font-size:10px;opacity:.68}.qa-recursion-status{display:flex;flex-wrap:wrap;gap:2px 7px;font-size:10px;font-weight:400;opacity:.62;margin-left:5px}.qa-content-label{flex-wrap:wrap}.qa-content-label>span:first-child{flex:0 1 auto}.qa-content-open{margin-left:auto}.qa-mode-lock{width:44px;text-align:center;opacity:.45}.qa-name-readonly{cursor:default}
    @media(max-width:340px){#iwb-qa-root .qa-filter-pair select[data-control="state-filter-select"]{font-size:8px!important;padding-inline:0!important}.qa-compact-tools{grid-template-columns:minmax(66px,.55fr) minmax(146px,1.45fr) auto;gap:5px}.qa-arrange-row{grid-template-columns:minmax(0,1fr) 82px 32px 32px}}
    @media(max-width:480px){
      .qa-book-picker-popover{position:fixed;z-index:10020;top:106px;left:10px;right:10px;width:auto;min-width:0;max-height:calc(var(--iwb-qa-vv-height,100dvh) - 126px)}.qa-book-picker-item{min-height:44px}
      .iwb-qa-host{position:fixed!important;top:var(--iwb-qa-vv-top,0px)!important;left:var(--iwb-qa-vv-left,0px)!important;right:auto!important;bottom:auto!important;width:var(--iwb-qa-vv-width,100dvw)!important;max-width:none!important;height:var(--iwb-qa-vv-height,100dvh)!important;max-height:none!important;margin:0!important;padding:0!important;border-radius:0!important;transform:none!important;overflow:hidden!important}.iwb-qa-host .popup-body{display:flex!important;flex-direction:column!important;width:100%!important;height:100%!important;max-height:100%!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important}.iwb-qa-host .popup-content{flex:1 1 auto!important;width:100%!important;height:100%!important;max-height:100%!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important}
      #iwb-qa-root{width:100%!important;height:100%!important;max-width:100%!important;max-height:100%!important;min-width:0!important;min-height:0!important;margin:0!important;overflow:hidden!important}.qa-shell{width:100%;height:100%;max-height:100%;min-height:0;grid-template-rows:auto minmax(0,1fr) auto;border-radius:0}.qa-head{grid-row:1;z-index:2;padding-top:calc(6px + env(safe-area-inset-top));padding-left:calc(7px + env(safe-area-inset-left));padding-right:calc(7px + env(safe-area-inset-right))}.iwb-qa-host .popup-button-close{display:none!important}.qa-mobile-close{display:grid;flex:0 0 40px;width:40px;min-width:40px;height:40px;min-height:40px;border:1px solid transparent;background:transparent;font-size:22px;touch-action:manipulation}.qa-scroll{grid-row:2;min-height:0;max-height:none;padding:5px calc(5px + env(safe-area-inset-right)) 8px calc(5px + env(safe-area-inset-left));scrollbar-gutter:auto}.qa-fields{grid-template-columns:1fr 1fr}.qa-fields .qa-wide{grid-column:1/-1}.qa-footer-row{align-items:stretch}.qa-keyboard-open:not(.qa-content-editing) .qa-title,.qa-keyboard-open:not(.qa-content-editing) .qa-status,.qa-keyboard-open:not(.qa-content-editing) .qa-segments,.qa-keyboard-open:not(.qa-content-editing) .qa-tool-row{display:none}.qa-keyboard-open:not(.qa-content-editing) .qa-title-row{justify-content:flex-end}.qa-keyboard-open:not(.qa-content-editing) .qa-head{padding-top:calc(4px + env(safe-area-inset-top));gap:3px}.qa-keyboard-open .qa-btn{min-height:31px;padding-block:3px}.qa-keyboard-open:not(.qa-content-editing) .qa-scroll{padding-top:4px}.qa-content-editing .qa-content-head{padding-top:calc(5px + env(safe-area-inset-top));padding-bottom:5px}
    }
    .qa-other-tools>.qa-btn{grid-column:auto}.qa-other-tools>.qa-btn[data-action="reload"]{grid-column:1/-1}.qa-source-locked{opacity:.58;cursor:not-allowed}.qa-transfer-workspace{height:100%;min-height:0!important;display:flex!important;flex-direction:column;align-content:stretch!important;overflow:hidden}.qa-workspace-title{display:flex;align-items:center;justify-content:space-between;gap:6px}.qa-workspace-title h3{margin:0;min-width:0}.qa-transfer-filter{display:grid;grid-template-columns:minmax(0,1fr) minmax(92px,.38fr);gap:6px}.qa-transfer-select-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}.qa-transfer-workspace>[data-slot="transfer-results"]{flex:1 1 0;min-height:0;display:flex;flex-direction:column;overflow:hidden}.qa-transfer-list{flex:1 1 0;min-height:0;height:auto;max-height:none;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}.qa-transfer-item{grid-template-columns:26px minmax(0,1fr) max-content;min-height:34px;height:34px;overflow:hidden}.qa-transfer-name{display:block;min-width:0;overflow:hidden!important;white-space:nowrap;text-overflow:ellipsis;overflow-wrap:normal!important}.qa-transfer-uid{white-space:nowrap;min-width:max-content}.qa-transfer-workspace .qa-import-summary{flex:0 0 auto;padding-top:5px}.qa-transfer-actions{flex:0 0 auto;position:static!important}.qa-transfer-targets{display:grid;gap:6px;overflow-y:auto;min-height:0}.qa-transfer-target{text-align:left;min-height:40px}.qa-transfer-actions .qa-btn{font-weight:700}.qa-arrange-workspace{min-height:100%;display:grid;align-content:start;padding:8px}.qa-arrange-workspace .qa-panel{min-height:100%;align-content:start}.qa-arrange-workspace .qa-arrange-list{max-height:none;overflow:visible}.qa-arrange-active .qa-filter-pair,.qa-arrange-active .qa-top-grid>[data-action="other-tools"],.qa-arrange-active [data-slot="other-tools"],.qa-arrange-active [data-slot="status"]{display:none!important}.qa-source{font-size:10px;color:var(--SmartThemeEmColor,#8b93a3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;line-height:1.25}.qa-top-right.primary{background:color-mix(in srgb,var(--SmartThemeQuoteColor,#4f86c6) 28%,var(--SmartThemeBlurTintColor,#fff));border-color:var(--SmartThemeQuoteColor,#4f86c6)}
    @media(max-width:340px){.qa-title h2{font-size:14px}.qa-book-row .qa-btn{padding-inline:6px}.qa-btn{font-size:12px;padding-inline:6px}.qa-summary-actions{gap:0}.qa-action-icon,.qa-drag,.qa-move{padding-inline:5px}.qa-batch-actions{grid-template-columns:repeat(4,minmax(0,1fr));gap:3px}.qa-batch-actions .qa-btn{font-size:11px;padding-inline:1px}.qa-footer-bottom{gap:3px}.qa-count{min-width:48px;font-size:10px}.qa-count-wide{display:none}.qa-count-narrow{display:inline}.qa-main-actions{gap:3px}.qa-main-actions .qa-btn{font-size:11px;padding-inline:1px}.qa-search-row{grid-template-columns:1fr}.qa-position-filter{display:none}}

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

    .qa-check{
      accent-color:var(--qa-accent);
    }

    .qa-source{
      color:var(--qa-muted);
      opacity:1;
    }

    .qa-mode-lock{
      color:#536A79;
    }

    /* 卡片内字段：雾灰信息槽 */
    .qa-field .qa-input,
    .qa-field .qa-select{
      background:var(--qa-surface-soft);
      border-color:#E9EEF1;
      color:var(--qa-text);
      border-radius:11px;
    }

    .qa-field>span,
    .qa-content-label>span{
      color:#697985;
      opacity:1;
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
    .qa-guide-dialog{
      background:var(--qa-surface);
      border-color:var(--qa-line);
      color:var(--qa-text);
      box-shadow:0 20px 60px rgba(42,55,65,.20);
    }

    .qa-guide-head{
      border-bottom-color:var(--qa-line);
    }

    .qa-guide-backdrop{
      background:rgba(39,49,58,.48);
      backdrop-filter:blur(2px);
    }

    

    /* 底部保存区 */
    

    

    .qa-count{
      color:#667985;
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

    @media(max-width:480px){
      .qa-shell{
        background:var(--qa-bg);
      }

      .qa-head{
        padding-bottom:9px;
      }

      .qa-other-tools .qa-btn{
        min-height:48px;
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
    
    
    
    /* IWB_BATCH_DELETE_LAYOUT_END */

    /* IWB_V042_LIST_SELECTION_CSS_BEGIN */
    .qa-list-context{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;padding:7px 8px;border:1px solid var(--qa-line);border-radius:9px;background:color-mix(in srgb,var(--qa-bg) 96%,#fff 4%);box-shadow:0 2px 7px rgba(49,76,93,.06)}
    .qa-list-context>span{min-width:0;display:flex;align-items:center;gap:7px}.qa-list-context-actions{display:flex;align-items:center;gap:5px;min-width:0}.qa-list-context strong{font-size:12px;color:var(--qa-text)}.qa-list-context small{font-size:11px;color:var(--qa-muted);white-space:nowrap}.qa-list-context .qa-btn{min-height:34px;white-space:nowrap;background:var(--qa-accent-soft);border-color:var(--qa-accent-line);color:#365e7f}
    @media(min-width:481px){}
    @media(max-width:480px){.qa-list-context{min-height:44px;margin-bottom:4px;padding:3px 5px}.qa-list-context>span{display:flex;align-items:baseline;gap:5px;white-space:nowrap}.qa-list-context strong{font-size:12px}.qa-list-context small{font-size:10px}.qa-list-context .qa-btn{min-height:38px;padding-inline:8px}}
    /* IWB_V042_LIST_SELECTION_CSS_END */

    /* IWB_V047_ENTRY_GROUPS_CSS_BEGIN */
    .qa-entry-groups-panel{min-height:0}.qa-entry-groups-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.qa-entry-groups-head>div{min-width:0}.qa-entry-group-create{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}.qa-entry-group-create .qa-input{min-width:0}.qa-entry-group-list{display:grid;gap:6px;min-height:0;max-height:230px;overflow:auto}.qa-entry-group{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:7px;border:1px solid var(--qa-line);border-radius:9px;background:var(--qa-surface)}.qa-entry-group-summary{min-width:0;display:grid;gap:2px}.qa-entry-group-summary strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qa-entry-group-summary small{font-size:11px;color:var(--qa-muted)}.qa-entry-group-actions{display:grid;grid-template-columns:repeat(4,auto);gap:4px}.qa-entry-group-actions .qa-btn{min-height:38px;padding-inline:10px}
    @media(max-width:480px){.qa-list-context-actions{gap:3px}.qa-list-context-actions .qa-btn{padding-inline:6px}.qa-entry-groups-head .qa-panel-note{font-size:10px}.qa-entry-group-create{grid-template-columns:minmax(0,1fr);gap:5px}.qa-entry-group-create .qa-btn{min-height:42px}.qa-entry-group{grid-template-columns:minmax(0,1fr);gap:5px}.qa-entry-group-actions{grid-template-columns:repeat(4,minmax(0,1fr))}.qa-entry-group-actions .qa-btn{min-width:0;min-height:42px;padding-inline:2px}.qa-entry-group-list{max-height:38dvh}}
    /* IWB_V047_ENTRY_GROUPS_CSS_END */

    /* IWB_V045_MOBILE_TOOLBAR_BEGIN */
    @media(max-width:480px){
      .qa-head{gap:4px!important;padding-bottom:5px!important}
      .qa-title-row{min-height:38px}
      .qa-title h2{font-size:16px}
      .qa-title-row .qa-icon{width:36px;min-width:36px;height:36px}
      .qa-title-row .qa-mobile-close{width:36px;min-width:36px;height:36px;min-height:36px}
      .qa-mode-segments{min-height:44px;padding:2px;gap:2px!important}
      .qa-mode-segments .qa-mode-segment{min-height:38px;height:38px}
      .qa-top-grid{gap:4px 6px}
      .qa-book-picker-trigger>span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .qa-status.qa-status-redundant{display:none!important}
    }
    /* IWB_V045_MOBILE_TOOLBAR_END */

    /* IWB_RESPONSIVE_DESKTOP_BEGIN · alpha.5.28 · single authoritative responsive module */
    .qa-desktop-task-head,.qa-guide-desktop-only{display:none}
    @media(min-width:481px){
      #iwb-qa-root{width:100%;max-width:none;height:100%;max-height:100%;min-height:0}
      .iwb-qa-host{width:min(1420px,calc(100dvw - 40px))!important;max-width:min(1420px,calc(100dvw - 40px))!important;height:min(90dvh,900px)!important;max-height:min(90dvh,900px)!important;min-height:min(620px,90dvh)!important;display:flex!important;overflow:hidden!important}
      .iwb-qa-host .popup-body,.iwb-qa-host .popup-content{display:flex!important;width:100%!important;height:100%!important;max-height:100%!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important}
      #iwb-qa-root>.qa-shell{width:100%;height:100%;max-height:100%;min-height:0;overflow:hidden;grid-template-areas:"head" "task" "scroll" "workspace" "footer";grid-template-rows:auto auto minmax(0,1fr) auto auto}
      .qa-head{grid-area:head;display:grid;grid-template-columns:210px 300px minmax(220px,1fr) 178px 120px 140px;gap:8px;padding:12px 14px 8px}
      .qa-title-row{grid-column:1/-1;grid-row:1;padding-right:48px}.qa-title-lock{display:none!important}
      .qa-mode-segments{grid-column:1;grid-row:2;grid-template-columns:repeat(2,minmax(0,1fr))!important}
      .qa-top-grid,.qa-filter-pair{display:contents}.qa-top-grid>[data-control="book"]{grid-column:2;grid-row:2;height:40px}.qa-filter-pair>[data-control="search"]{grid-column:3;grid-row:2;height:40px}.qa-filter-pair>[data-control="state-filter-select"]{grid-column:4;grid-row:2;height:40px}.qa-top-grid>[data-action="other-tools"]{display:none!important}
      .qa-other-tools,.qa-other-tools[hidden]{display:contents!important}.qa-other-tools>.qa-btn[data-action="reload"]{grid-column:5/7;grid-row:2;min-height:40px}.qa-top-grid>[data-action="new-entry"],.qa-top-grid>[data-action="toggle-source"]{grid-column:1;grid-row:3;min-height:42px}.qa-other-tools>[data-action="panel-import"]{grid-column:2;grid-row:3;min-height:42px}.qa-other-tools>[data-action="panel-transfer"]{grid-column:3;grid-row:3;min-height:42px}.qa-other-tools>[data-action="auto-arrange"]{grid-column:4;grid-row:3;min-height:42px}.qa-other-tools>.qa-arrange-quick{grid-column:4;grid-row:3;height:42px}.qa-other-tools>.qa-arrange-quick .qa-btn{height:42px;min-height:42px;padding-inline:3px}.qa-other-tools>[data-action="arrange-settings"]{grid-column:5;grid-row:3;min-height:42px}.qa-other-tools>[data-action="disable-recursion"]{grid-column:6;grid-row:3;min-height:42px}.qa-status{grid-column:1/-1;grid-row:4}
      .qa-desktop-task-head:not([hidden]){grid-area:task;display:grid;grid-template-columns:auto minmax(0,1fr) 136px;gap:14px;align-items:center;margin:0 14px 8px;padding:10px 12px;border:1px solid var(--qa-line);border-radius:12px;background:#fff}.qa-desktop-task-head>[data-slot="desktop-task-title"]{min-height:42px;display:flex;align-items:center;padding:0 14px;border-left:4px solid var(--qa-accent);border-radius:8px;background:var(--qa-accent-soft);font-size:17px;font-weight:700;color:#294557;white-space:nowrap}.qa-desktop-task-direction{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) 42px minmax(0,1fr);gap:10px;align-items:center}.qa-desktop-task-side{min-width:0;height:44px;display:flex;align-items:center;border:1px solid #d2dee5;border-radius:9px;background:#f9fbfc}.qa-desktop-task-book{padding:0 14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;justify-content:center}.qa-desktop-task-select>.qa-select{width:100%;height:42px!important;min-width:0;border:0;background:transparent}.qa-desktop-task-arrow{width:38px;height:38px;display:grid;place-items:center;justify-self:center;border:1px solid #c5d8e5;border-radius:999px;background:var(--qa-accent-soft);color:#4f7c9b;font-size:18px;font-weight:700;line-height:1}.qa-desktop-task-back{width:136px;min-width:136px;min-height:44px;background:var(--qa-accent-soft)!important;border-color:#bfd5e4!important}
      .qa-desktop-task-active .qa-head{display:none}.qa-desktop-task-active .qa-desktop-task-head{margin-top:12px}
      .qa-scroll{grid-area:scroll;min-height:0;max-height:none;overflow-y:auto;padding:8px 10px}
      .qa-card{padding:9px 10px;border-radius:13px}.qa-card-main{display:grid;grid-template-columns:minmax(300px,1fr) minmax(420px,620px) auto;grid-template-areas:"head fields actions";gap:10px;align-items:center}.qa-card-head{grid-area:head;grid-template-columns:34px minmax(0,1fr) 40px;gap:7px}.qa-name-cell{min-height:58px}.qa-name{width:100%;min-width:0;min-height:36px;padding:6px 9px;border:1px solid #c5d1d8!important;border-radius:8px!important;background:#fdfefe!important;box-shadow:inset 0 1px 2px rgba(47,70,84,.04);font-size:16px;text-align:left;color:#263f50}.qa-name:hover{border-color:var(--qa-accent)!important;background:#fff!important}.qa-name-meta,.qa-source{font-size:12px}.qa-inline-fields{grid-area:fields;margin:0;display:grid;grid-template-columns:minmax(180px,1fr) 105px 112px 84px;gap:7px}.qa-inline-row{display:contents}.qa-inline-fields label,.qa-editor label,.qa-keyword-editor label,.qa-recursion-title{font-size:13px;font-weight:600;color:#526875}.qa-summary-actions{grid-area:actions;margin:0;overflow:visible;gap:5px}.qa-summary-actions .qa-btn,.qa-summary-actions .qa-icon,.qa-card-head>.qa-icon,.qa-card-head>[data-action="drag"],.qa-card-head>[data-action="toggle"]{width:38px;height:38px;min-width:38px;min-height:38px;display:grid;place-items:center;padding:0;border:1px solid #c8d4db;border-radius:8px;background:#fff}.qa-card.is-expanded .qa-card-main{grid-template-areas:"head fields actions" "editor editor editor"}.qa-editor{grid-area:editor}.qa-move-mode .qa-inline-fields{display:grid;opacity:.75;pointer-events:none}.qa-move-mode .qa-inline-fields .qa-input,.qa-move-mode .qa-inline-fields .qa-select{background:#f4f6f7}
      .qa-check{appearance:none;position:relative;width:30px!important;height:30px!important;border:1px solid #c7d4dc;border-radius:8px;background:#fff;display:grid;place-items:center}.qa-check:checked{border-color:#5ca2d0;background:linear-gradient(145deg,#7fc1ea,#4f94c3);box-shadow:0 2px 7px rgba(59,116,153,.24)}.qa-check:checked:after{content:'✓';color:#fff;font-size:20px;font-weight:800;line-height:1}.qa-card.is-selected,.qa-card.is-selected.is-expanded{border-color:var(--qa-selected-line)!important;background:linear-gradient(90deg,rgba(91,169,218,.11),rgba(255,255,255,.96) 24%)!important;box-shadow:inset 3px 0 0 var(--qa-selected-line)!important}.qa-summary-actions .qa-drag,.qa-summary-actions .qa-switch,.qa-summary-actions .qa-action-icon,.qa-card-head .qa-expand{width:38px!important;height:38px!important;min-width:38px!important;min-height:38px!important;display:grid!important;place-items:center!important;padding:0!important;border:1px solid #c8d4db!important;border-radius:8px!important;background:#fff;box-shadow:none}.qa-summary-actions .qa-switch:before{transform:scale(.82)}.qa-summary-actions{align-items:center}.qa-keyword-editor{max-width:680px}.qa-keyword-editor .qa-keyword-input-row{grid-template-columns:minmax(240px,520px) auto!important;justify-content:start}.qa-keyword-editor [data-control="entry-key-input"]{max-width:520px}.qa-keyword-editor [data-action="keyword-add"]{min-width:72px}.qa-source{font-size:14px!important;line-height:1.45!important;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qa-name-meta{line-height:1.4}
      
      .qa-desktop-task-active .qa-scroll{padding:0 14px 10px}.qa-import-workspace,.qa-arrange-workspace{height:100%;min-height:0}.qa-import-workspace:not(.qa-transfer-workspace){display:grid!important;grid-template-columns:280px minmax(0,1fr);grid-template-rows:auto auto minmax(0,1fr) auto;gap:10px 14px;overflow:hidden}.qa-import-workspace:not(.qa-transfer-workspace)>header{grid-column:1;grid-row:1;padding:12px;border:1px solid var(--qa-line);border-radius:12px;background:#fff}.qa-import-workspace:not(.qa-transfer-workspace)>[data-control="import-source"]{grid-column:1;grid-row:2;align-self:start;height:42px!important}.qa-import-workspace:not(.qa-transfer-workspace)>.qa-import-body{grid-column:2;grid-row:1/4;min-height:0;padding:10px;border:1px solid var(--qa-line);border-radius:12px;background:#fff}.qa-import-workspace:not(.qa-transfer-workspace)>.qa-import-actions{grid-column:2;grid-row:4;display:flex;justify-content:flex-end;align-items:center;gap:8px}.qa-import-workspace:not(.qa-transfer-workspace) .qa-import-actions .qa-btn{min-height:40px;padding-inline:14px}.qa-import-workspace:not(.qa-transfer-workspace) .qa-import-confirm{min-width:190px}.qa-import-workspace:not(.qa-transfer-workspace) [data-action="import-cancel"]{display:none!important}
      .qa-transfer-workspace{display:grid!important;grid-template-columns:280px minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto;gap:10px 14px;overflow:hidden}.qa-transfer-workspace>header{grid-column:1;grid-row:1;padding:12px;border:1px solid var(--qa-line);border-radius:12px;background:#fff}.qa-transfer-workspace [data-action="transfer-cancel"]{display:none!important}.qa-transfer-workspace>.qa-task-toolbar{grid-column:2;grid-row:1}.qa-transfer-workspace>.qa-import-body{grid-column:2;grid-row:2;min-height:0;display:flex!important;flex-direction:column;overflow:hidden;padding:10px;border:1px solid var(--qa-line);border-radius:12px;background:#fff}.qa-transfer-workspace>.qa-import-body>[data-slot="transfer-list"],.qa-transfer-workspace>.qa-import-body .qa-transfer-list{flex:1 1 0;min-height:0}.qa-transfer-actions{grid-column:2;grid-row:3;display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.qa-transfer-actions .qa-btn{min-height:48px}.qa-transfer-targets{grid-column:2;grid-row:1/4;grid-template-columns:repeat(2,minmax(0,1fr))}.qa-task-toolbar{display:grid;grid-template-columns:minmax(260px,1fr) 132px 126px 104px;gap:8px;align-items:center}.qa-task-toolbar>.qa-input,.qa-task-toolbar>.qa-select,.qa-task-toolbar>.qa-btn{height:42px!important;min-height:42px!important}.qa-task-filter-spacer{display:block}.qa-import-body>.qa-task-toolbar{flex:0 0 auto;margin-bottom:8px}.qa-import-body>.qa-task-toolbar+.qa-import-selection-note{margin-bottom:6px}.qa-task-toolbar .qa-btn{width:auto!important;padding-inline:12px;white-space:nowrap}
      .qa-source-preview-item{display:block;border-bottom:1px solid #e3eaee}.qa-source-preview-item:last-child{border-bottom:0}.qa-source-preview-item>.qa-import-item{display:grid!important;grid-template-columns:30px minmax(0,1fr) 92px 38px;gap:8px;align-items:center;min-height:46px;border:0!important}.qa-source-preview-item>.qa-import-item>input{justify-self:center}.qa-source-preview-toggle{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-align:left;border:0;background:transparent;color:inherit;padding:7px 0;font:inherit}.qa-import-uid,.qa-transfer-uid{width:92px;white-space:nowrap;text-align:right}.qa-source-preview-arrow{width:34px;height:34px;display:grid;place-items:center;border:1px solid var(--qa-line);border-radius:7px;background:#fff;color:#5c7381}.qa-source-preview{margin:0 8px 8px 38px;padding:10px;border:1px solid #d4e0e7;border-radius:9px;background:#f8fafb}.qa-source-preview-meta{display:flex;gap:10px;align-items:center;min-width:0;margin-bottom:7px;font-size:12px;color:var(--qa-muted)}.qa-source-preview-meta strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#385263}.qa-source-preview-body{max-height:170px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.55;color:#324b5b}
      .qa-arrange-workspace{padding:0}.qa-arrange-workspace .qa-panel{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr) auto}.qa-arrange-note{text-align:center;font-size:15px!important;line-height:1.6;padding:10px 14px}.qa-arrange-workspace .qa-arrange-list{max-height:none;min-height:0;overflow:auto;padding:10px 12px;display:grid;align-content:start;gap:8px}.qa-arrange-workspace .qa-arrange-row{width:min(760px,100%);min-height:56px;margin-inline:auto;padding:8px 12px;display:grid;grid-template-columns:minmax(260px,1fr) 160px 92px;gap:10px;align-items:center;border:1px solid var(--qa-line);border-radius:10px;background:#fff}.qa-arrange-label{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qa-arrange-arrows{display:grid;grid-template-columns:repeat(2,42px);gap:8px}.qa-arrange-arrows .qa-btn{width:42px;height:40px;padding:0}.qa-arrange-workspace .qa-footer-row{width:min(760px,100%);margin-inline:auto;justify-content:flex-end}.qa-arrange-workspace .qa-footer-row [data-action="panel-close"]{display:none!important}
      .qa-content-head{display:grid;grid-template-columns:120px minmax(0,1fr) 120px;align-items:center;gap:16px;padding:12px 18px}.qa-content-context{min-width:0;display:grid;justify-items:center;gap:5px}.qa-content-name-input{width:min(680px,100%);height:42px;font-size:17px;font-weight:600;text-align:center;border-color:#b9ccd8;background:#fff}.qa-content-context small{font-size:12px;color:var(--qa-muted)}.qa-content-token{text-align:center;font-size:12px;color:var(--qa-muted)}
      .qa-guide-dialog{width:min(940px,calc(100dvw - 120px));max-height:min(84dvh,760px)}.qa-guide-layout{min-height:0;display:grid;grid-template-columns:185px minmax(0,1fr)}.qa-guide-nav{min-height:0;overflow:auto;padding:14px;align-content:start;gap:6px;border-right:1px solid var(--qa-line);background:#f5f7f8}.qa-guide-nav-item{width:100%;min-height:38px;text-align:left;border:1px solid var(--qa-line);border-radius:7px;background:#fff;padding:7px 10px}.qa-guide-nav-item.is-active{background:var(--qa-accent-soft);border-color:var(--qa-accent-line);color:#365e7f}.qa-guide-body{min-height:0;overflow:auto;padding:16px 20px}.qa-guide-anchor{scroll-margin-top:6px}.qa-guide-desktop-only{display:block}nav.qa-guide-desktop-only{display:grid}
      .iwb-qa-host .popup-button-close{width:42px!important;height:42px!important;display:grid!important;place-items:center}
      @media(max-width:1180px){.qa-head{grid-template-columns:190px 250px minmax(190px,1fr) 160px 108px 124px}.qa-card-main{grid-template-columns:minmax(250px,1fr) minmax(390px,520px) auto}}
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
      #iwb-qa-root.qa-import-active .qa-head{display:none!important}
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
    /* IWB_ENTRY_FEEDBACK_CSS_END */

    /* IWB_UI_ALIGNMENT_CSS_BEGIN */
    @media(min-width:481px){
      .qa-card-main,.qa-card-head,.qa-inline-fields,.qa-inline-field{align-items:center}
      .qa-card-head{align-self:center;min-height:58px}
      .qa-card-head>.qa-check,.qa-card-head>.qa-expand,.qa-card-head>.qa-mode-lock{align-self:center;justify-self:center}
      .qa-name-cell{align-content:center}
      .qa-inline-fields{align-self:center}
      .qa-inline-field{min-height:34px}
      .qa-card.is-expanded .qa-editor{box-sizing:border-box;min-width:0;padding-inline:12px}
      .qa-card.is-expanded .qa-content-preview{box-sizing:border-box;font-size:13px;line-height:1.55}
    }
    .qa-import-toolbar>.qa-select,.qa-transfer-toolbar>.qa-select{text-align:center;text-align-last:center}
    @media(max-width:480px){
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
    
    @media(max-width:480px){
      #iwb-qa-root:not(.qa-import-active)>.qa-shell{grid-template-rows:auto minmax(0,1fr) auto auto!important}
      #iwb-qa-root:not(.qa-import-active) .qa-scroll{grid-row:2!important}
      
      
      
      
      
      
      .qa-footer-has-selection [data-action="undo"]{grid-column:1;grid-row:2}
      .qa-footer-has-selection [data-action="discard"]{grid-column:2;grid-row:2}
      .qa-footer-has-selection [data-action="batch-panel"]{grid-column:3;grid-row:2}
      .qa-footer-has-selection [data-action="clear-selection"]{grid-column:4;grid-row:2}
      .qa-footer-has-selection [data-action="save"]{grid-column:1/-1;grid-row:3;width:100%}
      .qa-footer-has-selection .qa-btn{min-width:0!important;padding-inline:3px!important;white-space:nowrap}
      
      
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
      .qa-other-tools>.qa-arrange-quick{grid-column:4;grid-row:4;height:52px}.qa-other-tools>.qa-arrange-quick .qa-btn{height:52px;min-height:52px;padding-inline:3px}
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
      
      
      
      
      
      
      
      
    }
    /* IWB_V042_COMPACT_BATCH_LAYOUT_END */
    /* IWB_RESPONSIVE_DESKTOP_END */

    /* IWB_V043_THEME_SWITCH_BEGIN */
    .qa-theme-layer{position:absolute;inset:0;z-index:36;display:grid;place-items:center;padding:14px}
    .qa-theme-layer[hidden]{display:none}
    .qa-theme-backdrop{position:absolute;inset:0;border:0;background:rgba(31,34,43,.34);backdrop-filter:blur(2px)}
    .qa-theme-dialog{position:relative;width:min(430px,100%);max-height:calc(100% - 12px);overflow:auto;border:1px solid var(--qa-panel-line);border-radius:16px;background:var(--qa-surface);box-shadow:0 18px 48px rgba(40,43,59,.22);padding:14px;color:var(--qa-text)}
    .qa-theme-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:12px}.qa-theme-head>div{min-width:0;flex:1}.qa-theme-head h3{margin:0;font-size:16px}.qa-theme-head p{margin:3px 0 0;color:var(--qa-muted);font-size:12px}.qa-theme-head .qa-icon{flex:0 0 40px;width:40px;height:40px;font-size:22px}
    .qa-theme-options{display:grid;gap:9px}.qa-theme-choice{display:grid;grid-template-columns:72px minmax(0,1fr) 28px;align-items:center;gap:11px;width:100%;min-height:76px;padding:9px 10px;border:1px solid var(--qa-card-line);border-radius:13px;background:var(--qa-card-bg);text-align:left;cursor:pointer}.qa-theme-choice:hover,.qa-theme-choice:focus-visible{border-color:var(--qa-accent-line);box-shadow:0 0 0 2px color-mix(in srgb,var(--qa-accent) 13%,transparent)}.qa-theme-choice>span:nth-child(2){display:grid;gap:3px;min-width:0}.qa-theme-choice strong{font-size:14px}.qa-theme-choice small{color:var(--qa-muted);font-size:11px;line-height:1.35}.qa-theme-choice>b{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--qa-accent);color:#fff;opacity:0}
    #iwb-qa-root[data-theme="fog-ink"] .qa-theme-choice[data-theme-choice="fog-ink"],#iwb-qa-root[data-theme="wisteria-moon"] .qa-theme-choice[data-theme-choice="wisteria-moon"],#iwb-qa-root[data-theme="night-mist"] .qa-theme-choice[data-theme-choice="night-mist"]{border-color:var(--qa-accent-line);background:var(--qa-accent-soft)}
    #iwb-qa-root[data-theme="fog-ink"] .qa-theme-choice[data-theme-choice="fog-ink"]>b,#iwb-qa-root[data-theme="wisteria-moon"] .qa-theme-choice[data-theme-choice="wisteria-moon"]>b,#iwb-qa-root[data-theme="night-mist"] .qa-theme-choice[data-theme-choice="night-mist"]>b{opacity:1}
    .qa-theme-preview{display:grid;grid-template-columns:repeat(4,1fr);align-items:end;width:72px;height:48px;padding:6px;border:1px solid rgba(68,72,86,.12);border-radius:10px}.qa-theme-preview i{display:block;height:100%;border-radius:5px}.qa-theme-preview i:nth-child(2){height:82%}.qa-theme-preview i:nth-child(3){height:64%}.qa-theme-preview i:nth-child(4){height:46%}.qa-theme-preview-fog{background:#F5F7F8}.qa-theme-preview-fog i:nth-child(1){background:#FFFFFF}.qa-theme-preview-fog i:nth-child(2){background:#EAF2F8}.qa-theme-preview-fog i:nth-child(3){background:#5B8FB9}.qa-theme-preview-fog i:nth-child(4){background:#D7A85B}.qa-theme-preview-wisteria{background:#F7F7FC}.qa-theme-preview-wisteria i:nth-child(1){background:#FFFFFF}.qa-theme-preview-wisteria i:nth-child(2){background:#ECE9F8}.qa-theme-preview-wisteria i:nth-child(3){background:#6F63A8}.qa-theme-preview-wisteria i:nth-child(4){background:#D8D3F0}.qa-theme-preview-night{background:#202129}.qa-theme-preview-night i:nth-child(1){background:#2B2C36}.qa-theme-preview-night i:nth-child(2){background:#39354B}.qa-theme-preview-night i:nth-child(3){background:#9186C2}.qa-theme-preview-night i:nth-child(4){background:#D6B86A}

    #iwb-qa-root[data-theme="wisteria-moon"]{
      --qa-bg:#F7F7FC;--qa-card-bg:#FFFFFF;--qa-edit-bg:#F0EFF8;--qa-card-line:#E2DFF0;--qa-selected-line:#AFA6D4;--qa-panel-bg:#FFFFFF;--qa-panel-line:#D8D3E8;--qa-line:#E2DFF0;
      --qa-surface:#FFFFFF;--qa-surface-soft:#F0EFF8;--qa-surface-blue:#F2F0FB;--qa-text:#2F3040;--qa-muted:#6F7084;--qa-accent:#6F63A8;--qa-accent-strong:#594B91;--qa-accent-soft:#ECE9F8;--qa-accent-line:#AFA6D4;--qa-green:#65A982;--qa-green-line:#86C7A0;--qa-warning:#D6B86A;--qa-danger:#A7535E;--qa-danger-soft:#F9ECEE;--qa-shadow:0 5px 18px rgba(65,58,101,.09);--qa-shadow-soft:0 2px 8px rgba(65,58,101,.07);
      color:var(--qa-text)!important;background:var(--qa-bg)
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-shell{box-shadow:0 18px 50px rgba(50,47,74,.17)}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-title h2,#iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-head h3,#iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-section h4{color:#393553}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-icon,#iwb-qa-root[data-theme="wisteria-moon"] .qa-mobile-close{color:#55516B}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-dialog,#iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-body{color:#3B3A4D}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-body{background:var(--qa-bg)}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-quick{border-color:#D8D3E8;background:var(--qa-accent-soft);color:#585080}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-section{border-color:var(--qa-card-line);background:var(--qa-card-bg);box-shadow:var(--qa-shadow-soft)}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-section li{color:#5D5D70}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-section strong{color:#45415F}
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-guide-about{color:var(--qa-muted)}
    
    
    @media(max-width:480px){.qa-theme-layer{padding:12px}.qa-theme-dialog{width:100%;border-radius:15px}.qa-theme-choice{grid-template-columns:64px minmax(0,1fr) 26px;min-height:72px;gap:9px}.qa-theme-preview{width:64px}}

    /* IWB_V043_WISTERIA_POLISH_BEGIN：Android 真机主题漏色修复。 */
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mode-segments{
      border-color:#E2DFF0;
      background:#F0EFF8;
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mode-segments .qa-mode-segment{
      color:#5D5D70!important;
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mode-segments .qa-mode-segment:hover,
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mode-segments .qa-mode-segment:focus-visible{
      border-color:#D8D3E8;
      background:rgba(255,255,255,.68);
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mode-segments .qa-mode-segment.is-active{
      border-color:#D8D3E8;
      background:#FFFFFF;
      color:#594B91!important;
      box-shadow:0 2px 7px rgba(65,58,101,.10);
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mode-segments .qa-title-lock[aria-pressed="true"]{
      border-color:#D8D3E8;
      background:#ECE9F8;
      color:#6F63A8!important;
    }

    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mobile-task-head{
      border-color:#AFA6D4;
      box-shadow:0 3px 10px rgba(65,58,101,.09);
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mobile-task-heading strong{
      color:#393553;
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-mobile-task-back,
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-desktop-task-back{
      border-color:#AFA6D4!important;
      background:#ECE9F8!important;
      color:#594B91!important;
    }

    #iwb-qa-root[data-theme="wisteria-moon"] .qa-source-preview-item>.qa-import-item>input[type="checkbox"]{
      border-color:#CEC9DF;
      background:#FFFFFF!important;
    }
    #iwb-qa-root[data-theme="wisteria-moon"] .qa-source-preview-item>.qa-import-item>input[type="checkbox"]:checked{
      border-color:#6F63A8;
      background:linear-gradient(145deg,#9186C2,#6F63A8)!important;
      box-shadow:0 1px 5px rgba(89,75,145,.25);
    }

    #iwb-qa-root[data-theme="wisteria-moon"] select{
      accent-color:#6F63A8;
    }
    #iwb-qa-root[data-theme="wisteria-moon"] select option:checked{
      color:#594B91!important;
      background:#ECE9F8!important;
    }
    /* IWB_V043_WISTERIA_POLISH_END */


    /* IWB_V043_NIGHT_MIST_BEGIN：深而不黑的夜雾墨紫主题。 */
    #iwb-qa-root[data-theme="night-mist"]{
      color-scheme:dark;
      --qa-bg:#202129;--qa-card-bg:#2B2C36;--qa-edit-bg:#32333E;--qa-card-line:#3D3E4B;--qa-selected-line:#A99DD4;--qa-panel-bg:#292A34;--qa-panel-line:#454653;--qa-line:#3D3E4B;
      --qa-surface:#2B2C36;--qa-surface-soft:#32333E;--qa-surface-blue:#302D40;--qa-text:#E7E5ED;--qa-muted:#AAA7B6;--qa-accent:#9186C2;--qa-accent-strong:#A99DD4;--qa-accent-soft:#39354B;--qa-accent-line:#6F668F;--qa-green:#70B58B;--qa-green-line:#5B9872;--qa-warning:#D6B86A;--qa-danger:#D47D88;--qa-danger-soft:#432D34;--qa-shadow:0 8px 24px rgba(5,6,10,.28);--qa-shadow-soft:0 3px 10px rgba(5,6,10,.20);
      color:var(--qa-text)!important;background:var(--qa-bg)
    }
    .iwb-qa-host[data-iwb-qa-theme="night-mist"] .popup-button-close{background:#E7E5ED!important;border:1px solid #AAA7B6!important;color:#202129!important;opacity:1!important;filter:none!important;box-shadow:0 2px 9px rgba(5,6,10,.38)!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-shell{background:var(--qa-bg);box-shadow:0 18px 54px rgba(5,6,10,.42)}
    #iwb-qa-root[data-theme="night-mist"] .qa-book-picker-trigger,
    #iwb-qa-root[data-theme="night-mist"] .qa-book-picker-popover{background:var(--qa-bg)!important;border-color:var(--qa-panel-line)!important;color:var(--qa-text)!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-book-picker-results{scrollbar-color:#565361 #252630}
    #iwb-qa-root[data-theme="night-mist"] .qa-book-picker-item{background:var(--qa-surface)!important;border-color:var(--qa-panel-line)!important;color:var(--qa-text)!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-book-picker-item:hover,
    #iwb-qa-root[data-theme="night-mist"] .qa-book-picker-item:focus-visible{background:var(--qa-surface-soft)!important;border-color:var(--qa-accent-line)!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-book-picker-item.is-current{background:var(--qa-accent-soft)!important;border-color:var(--qa-accent-line)!important;color:var(--qa-accent-strong)!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-head,#iwb-qa-root[data-theme="night-mist"] .qa-content-head,#iwb-qa-root[data-theme="night-mist"] .qa-list-context{background:color-mix(in srgb,var(--qa-bg) 88%,var(--qa-surface) 12%);border-color:var(--qa-line)}
    #iwb-qa-root[data-theme="night-mist"] .qa-title h2,
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-head h3,
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-section h4,
    #iwb-qa-root[data-theme="night-mist"] .qa-mobile-task-heading strong,
    #iwb-qa-root[data-theme="night-mist"] .qa-desktop-task-head>[data-slot="desktop-task-title"]{color:var(--qa-text)}
    #iwb-qa-root[data-theme="night-mist"] .qa-icon,
    #iwb-qa-root[data-theme="night-mist"] .qa-mobile-close{color:#D4D1DC}

    #iwb-qa-root[data-theme="night-mist"] input:not([type="checkbox"]):not([type="range"]),
    #iwb-qa-root[data-theme="night-mist"] select,
    #iwb-qa-root[data-theme="night-mist"] textarea,
    #iwb-qa-root[data-theme="night-mist"] .qa-inline-value{background:var(--qa-surface)!important;border-color:var(--qa-panel-line)!important;color:var(--qa-text)!important}
    #iwb-qa-root[data-theme="night-mist"] input::placeholder,
    #iwb-qa-root[data-theme="night-mist"] textarea::placeholder{color:#858392!important}

    #iwb-qa-root[data-theme="night-mist"] .qa-btn:not(.primary),
    #iwb-qa-root[data-theme="night-mist"] .qa-icon,
    #iwb-qa-root[data-theme="night-mist"] .qa-top-right:not(.primary){background:var(--qa-surface);border-color:var(--qa-panel-line);color:var(--qa-text)}
    #iwb-qa-root[data-theme="night-mist"] .qa-btn.primary,
    #iwb-qa-root[data-theme="night-mist"] .qa-top-right.primary{background:var(--qa-accent)!important;border-color:var(--qa-accent)!important;color:#F7F5FB!important;box-shadow:0 4px 14px rgba(145,134,194,.22)}
    #iwb-qa-root[data-theme="night-mist"] .qa-btn.danger,#iwb-qa-root[data-theme="night-mist"] .qa-other-tools .qa-btn[data-action="disable-recursion"]{background:var(--qa-danger-soft)!important;border-color:#68424B!important;color:var(--qa-danger)!important}

    #iwb-qa-root[data-theme="night-mist"] .qa-mode-segments{background:#292A34;border-color:var(--qa-line)}
    #iwb-qa-root[data-theme="night-mist"] .qa-mode-segments .qa-mode-segment{background:transparent;color:#B9B6C4!important;border-color:transparent}
    #iwb-qa-root[data-theme="night-mist"] .qa-mode-segments .qa-mode-segment:hover,
    #iwb-qa-root[data-theme="night-mist"] .qa-mode-segments .qa-mode-segment:focus-visible{background:#32333E;border-color:#454653}
    #iwb-qa-root[data-theme="night-mist"] .qa-mode-segments .qa-mode-segment.is-active{background:#34313F;border-color:#5D5677;color:var(--qa-accent-strong)!important;box-shadow:0 2px 8px rgba(5,6,10,.24)}
    #iwb-qa-root[data-theme="night-mist"] .qa-mode-segments .qa-title-lock[aria-pressed="true"]{background:var(--qa-accent-soft);border-color:var(--qa-accent-line);color:var(--qa-accent-strong)!important}

    #iwb-qa-root[data-theme="night-mist"] .qa-desktop-task-head,#iwb-qa-root[data-theme="night-mist"] .qa-import-workspace:not(.qa-transfer-workspace)>header,#iwb-qa-root[data-theme="night-mist"] .qa-import-workspace:not(.qa-transfer-workspace)>.qa-import-body,#iwb-qa-root[data-theme="night-mist"] .qa-transfer-workspace>header,#iwb-qa-root[data-theme="night-mist"] .qa-transfer-workspace>.qa-import-body,#iwb-qa-root[data-theme="night-mist"] .qa-import-workspace>.qa-import-body,#iwb-qa-root[data-theme="night-mist"] .qa-arrange-workspace .qa-arrange-row,#iwb-qa-root[data-theme="night-mist"] .qa-task-direction,#iwb-qa-root[data-theme="night-mist"] .qa-content-paper{background:var(--qa-card-bg)!important;border-color:var(--qa-card-line)!important;color:var(--qa-text)}
    

    #iwb-qa-root[data-theme="night-mist"] .qa-summary-actions .qa-btn,
    #iwb-qa-root[data-theme="night-mist"] .qa-summary-actions .qa-icon,
    #iwb-qa-root[data-theme="night-mist"] .qa-card-head>.qa-icon,
    #iwb-qa-root[data-theme="night-mist"] .qa-card-head>[data-action="drag"],
    #iwb-qa-root[data-theme="night-mist"] .qa-card-head>[data-action="toggle"],
    #iwb-qa-root[data-theme="night-mist"] .qa-summary-actions .qa-drag,
    #iwb-qa-root[data-theme="night-mist"] .qa-summary-actions .qa-switch,
    #iwb-qa-root[data-theme="night-mist"] .qa-summary-actions .qa-action-icon,
    #iwb-qa-root[data-theme="night-mist"] .qa-card-head .qa-expand,
    #iwb-qa-root[data-theme="night-mist"] .qa-source-preview-arrow{background:var(--qa-surface)!important;border-color:var(--qa-panel-line)!important;color:var(--qa-text)!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-name:hover{background:#343640!important;border-color:var(--qa-accent)!important}

    #iwb-qa-root[data-theme="night-mist"] .qa-source-preview-item>.qa-import-item>input[type="checkbox"]{background:#252630!important;border-color:#575865!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-source-preview-item>.qa-import-item>input[type="checkbox"]:checked{background:linear-gradient(145deg,#A99DD4,#8176B1)!important;border-color:#A99DD4!important;box-shadow:0 1px 6px rgba(169,157,212,.24)}
    #iwb-qa-root[data-theme="night-mist"] .qa-source-preview-item>.qa-import-item>input[type="checkbox"]:checked:after{color:#F7F5FB!important}

    #iwb-qa-root[data-theme="night-mist"] .qa-keyword-chip,#iwb-qa-root[data-theme="night-mist"] .qa-list-context .qa-btn{background:var(--qa-accent-soft)!important;border-color:var(--qa-accent-line)!important;color:var(--qa-accent-strong)!important}
    #iwb-qa-root[data-theme="night-mist"] .qa-mobile-task-head{background:var(--qa-bg);border-color:var(--qa-accent-line);box-shadow:0 3px 11px rgba(5,6,10,.26)}
    #iwb-qa-root[data-theme="night-mist"] .qa-mobile-task-back,
    #iwb-qa-root[data-theme="night-mist"] .qa-desktop-task-back{background:var(--qa-accent-soft)!important;border-color:var(--qa-accent-line)!important;color:var(--qa-accent-strong)!important}

    #iwb-qa-root[data-theme="night-mist"] .qa-guide-dialog,#iwb-qa-root[data-theme="night-mist"] .qa-theme-dialog{background:var(--qa-panel-bg);border-color:var(--qa-panel-line);color:var(--qa-text);box-shadow:0 18px 50px rgba(5,6,10,.46)}
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-body,
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-nav{background:var(--qa-bg);color:var(--qa-text)}
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-section,
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-nav-item{background:var(--qa-card-bg);border-color:var(--qa-card-line);color:var(--qa-text);box-shadow:var(--qa-shadow-soft)}
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-nav-item.is-active,
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-quick{background:var(--qa-accent-soft);border-color:var(--qa-accent-line);color:var(--qa-accent-strong)}
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-section li,
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-about{color:var(--qa-muted)}
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-section strong{color:var(--qa-text)}
    #iwb-qa-root[data-theme="night-mist"] .qa-theme-backdrop,
    #iwb-qa-root[data-theme="night-mist"] .qa-guide-backdrop{background:rgba(7,8,12,.68)}
    #iwb-qa-root[data-theme="night-mist"] select{accent-color:var(--qa-accent)}
    /* IWB_V043_NIGHT_MIST_END */

    /* IWB_V043_THEME_SWITCH_END */

    /* IWB_V048_MOBILE_SHELL_BEGIN */
    .qa-mobile-only{display:none}
    @media(max-width:480px){
      .qa-head{display:grid!important;grid-template-columns:minmax(0,2fr) repeat(2,minmax(0,1fr)) minmax(0,1fr);grid-template-rows:auto auto auto auto auto auto;gap:4px 5px!important}
      .qa-title-row{grid-column:1/-1;grid-row:1}
      .qa-title-row .qa-mobile-only{display:grid}
      .qa-mode-segments{display:contents!important}
      .qa-mode-segments>[data-action="mode"]{display:none!important}
      .qa-title-lock{display:block!important;grid-column:4;grid-row:2;width:100%;height:40px;min-height:40px;overflow:hidden;text-overflow:ellipsis}
      .qa-top-grid{display:contents!important}
      .qa-top-grid>.qa-book-picker{grid-column:1/3;grid-row:2;width:100%;height:40px}
      .qa-top-grid>.qa-book-picker .qa-book-picker-trigger{height:40px}
      .qa-top-grid>[data-action="new-entry"],.qa-top-grid>[data-action="toggle-source"]{grid-column:3;grid-row:2;width:100%;height:40px;min-height:40px;padding-inline:4px;white-space:nowrap}
      .qa-filter-pair{display:contents!important}
      .qa-filter-pair>[data-control="state-filter-select"]{display:none!important}
      .qa-filter-pair>[data-control="search"]{display:none;grid-column:1/-1;grid-row:4;width:100%;height:40px;min-height:40px}
      .qa-mobile-search-open .qa-filter-pair>[data-control="search"]{display:block}
      .qa-top-grid>[data-action="other-tools"]{display:none!important}
      .qa-mobile-operation-row{display:grid;grid-column:1/-1;grid-row:3;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}
      .qa-mobile-operation-row .qa-btn{min-width:0;min-height:40px;padding-inline:3px;white-space:nowrap}
      .qa-mobile-operation-row .qa-btn.is-active,.qa-mobile-menu .qa-btn.is-active,.qa-mobile-search-toggle.is-active{border-color:var(--qa-accent-line);background:var(--qa-accent-soft);color:var(--qa-accent-strong)}
      .qa-mobile-menu{display:grid;grid-column:1/-1;grid-row:5;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;padding:5px;border:1px solid var(--qa-line);border-radius:10px;background:var(--qa-panel-bg);box-shadow:var(--qa-shadow-soft)}
      .qa-mobile-menu[hidden]{display:none!important}
      .qa-mobile-menu .qa-btn{min-width:0;min-height:40px;padding-inline:3px;white-space:nowrap}
      .qa-other-tools{grid-column:1/-1;grid-row:5}
      .qa-status{grid-column:1/-1;grid-row:6}
      .qa-import-active .qa-mobile-operation-row,.qa-transfer-active .qa-mobile-operation-row,.qa-arrange-active .qa-mobile-operation-row,.qa-import-active .qa-mobile-menu,.qa-transfer-active .qa-mobile-menu,.qa-arrange-active .qa-mobile-menu{display:none!important}
      .qa-keyboard-open:not(.qa-content-editing) .qa-mobile-operation-row,.qa-keyboard-open:not(.qa-content-editing) .qa-mobile-menu{display:none!important}
    }
    /* IWB_V048_MOBILE_SHELL_END */

    /* IWB_V049_MOBILE_WORKFLOW_BEGIN */
    .qa-count-mobile{display:none}
    @media(max-width:480px){
      .qa-head{grid-template-columns:repeat(4,minmax(0,1fr))!important}
      .qa-top-grid>.qa-book-picker{grid-column:1/3!important}
      .qa-mobile-operation-row{grid-template-columns:repeat(5,minmax(0,1fr))!important}
      .qa-mobile-operation-row .qa-btn{font-size:12px!important}
      .qa-mobile-menu[data-slot="mobile-mode-menu"]{grid-template-columns:repeat(3,minmax(0,1fr))}
      .qa-list-context{display:none!important}
      .qa-other-tools .qa-arrange-quick,.qa-other-tools>[data-action="arrange-settings"]{display:none!important}
      
      .qa-count-desktop{display:none}.qa-count-mobile{display:inline;font-weight:700;font-variant-numeric:tabular-nums}
      
      .qa-group-edit-actions{grid-template-columns:repeat(2,minmax(0,1fr))!important}
      .qa-entry-group-create-panel{grid-template-columns:minmax(0,1fr) auto;align-items:center;padding:7px}
      .qa-entry-group-create-panel>div{display:grid;grid-template-columns:repeat(2,auto);gap:4px}
      .qa-entry-group-mode{position:sticky;top:0;z-index:5;display:grid;gap:5px;margin-bottom:5px;padding:6px;border:1px solid var(--qa-line);border-radius:10px;background:var(--qa-surface);box-shadow:var(--qa-shadow-soft)}
      .qa-entry-group-mode-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px;align-items:start}
      .qa-entry-group-tabs{display:flex;gap:4px;min-width:0;overflow-x:auto;scrollbar-width:none}
      .qa-entry-group-chip{flex:0 0 auto;max-width:150px;min-height:30px;padding:4px 8px;border:1px solid var(--qa-line);border-radius:999px;background:var(--qa-surface-soft);color:var(--qa-text);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .qa-entry-group-chip small{font-size:9px;opacity:.65}.qa-entry-group-chip.is-active{border-color:var(--qa-accent-line);background:var(--qa-accent-soft);color:var(--qa-accent-strong)}
      .qa-entry-group-mode-head>.qa-btn{min-height:30px;padding:3px 7px;font-size:11px}
      .qa-entry-group-mode-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}.qa-entry-group-mode-actions .qa-btn{min-width:0;min-height:32px;padding:3px 2px;font-size:11px}
      .qa-entry-group-editing{font-size:11px;font-weight:700;color:var(--qa-accent-strong)}
      .qa-group-mode:not(.qa-group-member-editing) .qa-card .qa-check{visibility:hidden;pointer-events:none}
      .qa-group-mode .qa-head>:not(.qa-title-row),.qa-import-active .qa-head>:not(.qa-title-row),.qa-transfer-active .qa-head>:not(.qa-title-row),.qa-arrange-active .qa-head>:not(.qa-title-row){display:none!important}
      .qa-group-mode .qa-mobile-search-toggle,.qa-import-active .qa-mobile-search-toggle,.qa-transfer-active .qa-mobile-search-toggle,.qa-arrange-active .qa-mobile-search-toggle{display:none!important}
      .qa-group-mode .qa-head,.qa-import-active .qa-head,.qa-transfer-active .qa-head,.qa-arrange-active .qa-head{padding-bottom:5px!important}
      
      .qa-arrange-workspace{padding-bottom:0!important}.qa-arrange-settings-panel{padding-bottom:0!important}.qa-arrange-settings-panel .qa-arrange-note{display:none!important}
      .qa-arrange-settings-panel>.qa-footer-row{position:sticky;bottom:0;z-index:6;display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:5px;padding:7px 0 calc(7px + env(safe-area-inset-bottom));background:var(--qa-bg);box-shadow:0 -7px 18px rgba(42,39,65,.12)}
      .qa-arrange-settings-panel .qa-arrange-reset{display:none!important}
      
    }
    /* IWB_V049_MOBILE_WORKFLOW_END */

  `;
  const MOBILE_DESIGN_STYLES = String.raw`
/* Mobile design foundation: approved tokens; no business-state changes. */
@media(max-width:480px){
#iwb-qa-root[data-theme="fog-ink"]{--iwb-canvas:#E5E9E7;--iwb-shell:#FAFAF7;--iwb-workbench:#F1F4F2;--iwb-card:#FFFDFC;--iwb-control:#FCFCFA;--iwb-editor:#FFFFFF;--iwb-text:#2B3133;--iwb-text-secondary:#616C6D;--iwb-muted:#929B99;--iwb-accent:#5F7D87;--iwb-accent-2:#9A747B;--iwb-secondary:#8C7967;--iwb-selected:#EAF1F5;--iwb-selected-border:#9FB7C4;--iwb-selected-decoration:#7898A8;--iwb-checkbox-selected:#688696}
#iwb-qa-root[data-theme="wisteria-moon"]{--iwb-canvas:#EAE5E3;--iwb-shell:#FBF8F6;--iwb-workbench:#F6F1EF;--iwb-card:#FFFDFC;--iwb-control:#FCFAF8;--iwb-editor:#FFFFFF;--iwb-text:#302C31;--iwb-text-secondary:#6C646B;--iwb-muted:#9E969C;--iwb-accent:#9B6F82;--iwb-accent-2:#756A91;--iwb-secondary:#6E8987;--iwb-selected:#EEF3F5;--iwb-selected-border:#AABBC6;--iwb-selected-decoration:#8EA2B1;--iwb-checkbox-selected:#7B8FA2}
#iwb-qa-root[data-theme="night-mist"]{--iwb-canvas:#242228;--iwb-shell:#2C2930;--iwb-workbench:#302D34;--iwb-card:#343138;--iwb-control:#36333A;--iwb-editor:#39363D;--iwb-text:#E3DDE2;--iwb-text-secondary:#BBB3B9;--iwb-muted:#918990;--iwb-accent:#B08EA2;--iwb-accent-2:#9488B0;--iwb-secondary:#7FA19F;--iwb-selected:#39434C;--iwb-selected-border:#6D8794;--iwb-selected-decoration:#8497A7;--iwb-checkbox-selected:#7D6A8C}
#iwb-qa-root[data-theme]{
  --qa-bg:var(--iwb-shell);--qa-card-bg:var(--iwb-card);--qa-edit-bg:var(--iwb-control);
  --qa-panel-bg:var(--iwb-workbench);--qa-text:var(--iwb-text);--qa-muted:var(--iwb-text-secondary);
  --qa-accent:var(--iwb-accent);--qa-selected-line:var(--iwb-selected-border);
  --qa-card-line:color-mix(in srgb,var(--iwb-text) 16%,var(--iwb-card));
  --qa-line:color-mix(in srgb,var(--iwb-text) 12%,var(--iwb-shell));
  color:var(--iwb-text);font-size:14px;font-weight:400;
}
#iwb-qa-root[data-theme] .qa-shell{background:var(--iwb-shell);border-radius:14px;box-shadow:none}
#iwb-qa-root[data-theme] .qa-head{background:var(--iwb-workbench);box-shadow:none}
#iwb-qa-root[data-theme] .qa-title h2{font-size:18px;font-weight:600}
#iwb-qa-root[data-theme] .qa-btn{font-size:13px;font-weight:400;border-radius:4px;box-shadow:none}
#iwb-qa-root[data-theme] input,
#iwb-qa-root[data-theme] select,
#iwb-qa-root[data-theme] textarea{border-radius:4px;background:var(--iwb-control);box-shadow:none;font-weight:400}
#iwb-qa-root[data-theme] .qa-content-textarea{background:var(--iwb-editor)}
}
`;
  const MOBILE_WORKBENCH_STYLES = String.raw`
@media(max-width:480px){
#iwb-qa-root[data-theme] .qa-shell{position:relative;display:flex!important;flex-direction:column!important;gap:0!important;border-radius:14px 14px 0 0!important}
#iwb-qa-root[data-theme] .qa-head{display:block!important;grid-template-columns:none!important;grid-template-rows:none!important;grid-area:auto!important;gap:0!important;order:0;flex:none;padding:0!important;border-bottom:1px solid var(--qa-line)!important;background:var(--iwb-workbench)!important}
#iwb-qa-root[data-theme] .qa-head>*{grid-column:auto!important;grid-row:auto!important;grid-area:auto!important}
#iwb-qa-root[data-theme] .qa-title-row{display:flex!important;flex-wrap:nowrap!important;min-width:0;min-height:54px!important;padding:0 14px 0 16px!important;gap:1px!important}
#iwb-qa-root[data-theme] .qa-title{margin-right:auto;min-width:0;flex:1}
#iwb-qa-root[data-theme] .qa-title h2{white-space:nowrap}
#iwb-qa-root[data-theme] .qa-title h2{font-size:18px!important;font-weight:600!important}
#iwb-qa-root[data-theme] .qa-title-row>.qa-icon{width:34px!important;height:38px!important;min-height:0!important;min-width:0!important;border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important;color:var(--iwb-text-secondary)!important}
#iwb-qa-root[data-theme] .qa-mode-segments{display:none!important}
#iwb-qa-root[data-theme] .qa-top-grid{display:grid!important;grid-template-areas:none!important;grid-template-rows:auto!important;grid-template-columns:minmax(0,1fr) auto 34px!important;gap:5px!important;padding:0 14px 4px 16px!important;align-items:center;min-height:45px!important}
#iwb-qa-root[data-theme] .qa-top-grid>.qa-book-picker{display:block!important;grid-area:auto!important;grid-column:1!important;grid-row:1!important;min-width:0!important;width:100%!important;max-width:100%!important;height:auto!important}
#iwb-qa-root[data-theme] .qa-book-picker-trigger{display:flex!important;flex-wrap:nowrap!important;width:100%!important;min-width:0!important;overflow:hidden;min-height:38px!important;height:auto!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;color:var(--iwb-text)!important;font-size:15px!important;font-weight:600!important;box-shadow:none!important}
#iwb-qa-root[data-theme] .qa-top-grid>[data-action="new-entry"],#iwb-qa-root[data-theme] .qa-top-grid>[data-action="toggle-source"]{grid-column:2!important;grid-row:1!important;width:auto!important;min-height:38px!important;padding:0 7px!important;border:0!important;background:transparent!important;color:var(--iwb-accent)!important;box-shadow:none!important;font-size:13px!important;white-space:nowrap}
#iwb-qa-root[data-theme] .qa-top-grid>.qa-mobile-title-lock{grid-column:3!important;grid-row:1!important;width:34px!important;height:34px!important;min-width:0!important;min-height:0!important;padding:0!important;border:0!important;background:transparent!important;color:var(--iwb-muted)!important;box-shadow:none!important;font-size:15px!important}
#iwb-qa-root[data-theme] .qa-top-grid>.qa-filter-pair{display:none!important}
#iwb-qa-root[data-theme].qa-mobile-search-open .qa-top-grid>.qa-filter-pair{display:block!important;grid-column:1/-1!important;grid-row:2!important;padding:5px 0!important}
#iwb-qa-root[data-theme] .qa-filter-pair>[data-control="search"]{width:100%;min-height:38px!important;font-size:14px!important;border:1px solid var(--qa-line)!important;background:var(--iwb-control)!important}
#iwb-qa-root[data-theme] .qa-filter-pair>select,#iwb-qa-root[data-theme] .qa-top-grid>[data-action="other-tools"],#iwb-qa-root[data-theme] .qa-status,#iwb-qa-root[data-theme] .qa-list-context{display:none!important}
#iwb-qa-root[data-theme] .qa-book-picker-trigger>span{display:block!important;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#iwb-qa-root[data-theme] .qa-book-picker-trigger>i{flex:none;width:14px}
#iwb-qa-root[data-theme] .qa-mobile-operation-row{display:flex!important;align-items:center;gap:12px!important;padding:0 16px!important;min-height:43px!important;border-top:1px solid var(--qa-line)!important;flex-wrap:nowrap!important}
#iwb-qa-root[data-theme] .qa-mobile-operation-row>.qa-btn{min-height:40px!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;color:var(--iwb-text-secondary)!important;box-shadow:none!important;font-size:13px!important;font-weight:400!important;white-space:nowrap}
#iwb-qa-root[data-theme] .qa-mobile-operation-row>.qa-quick-combo{min-height:30px!important;padding:0 8px!important;border:1px solid color-mix(in srgb,var(--iwb-secondary) 42%,var(--qa-line))!important;border-radius:4px!important;color:var(--iwb-secondary)!important;background:color-mix(in srgb,var(--iwb-secondary) 7%,var(--iwb-workbench))!important}
#iwb-qa-root[data-theme] .qa-mobile-density-toggle{margin-left:auto!important;display:flex!important;gap:5px!important;min-width:0;padding:0!important;border:0!important;white-space:nowrap}
#iwb-qa-root[data-theme] .qa-mobile-density-toggle button{min-height:40px!important;font-size:12px!important}
#iwb-qa-root[data-theme] .qa-mobile-menu,#iwb-qa-root[data-theme] .qa-other-tools{grid-template-columns:none!important;grid-template-rows:none!important;grid-area:auto!important;border:0!important;border-radius:0!important;margin:0!important;padding:0 16px!important;gap:0!important;border-top:1px solid var(--qa-line)!important;background:var(--iwb-workbench)!important;box-shadow:none!important}
#iwb-qa-root[data-theme] .qa-mobile-menu .qa-btn,#iwb-qa-root[data-theme] .qa-other-tools .qa-btn{min-height:43px!important;padding:0!important;border:0!important;border-radius:0!important;box-shadow:none!important;background:transparent!important;text-align:left!important;font-size:13px!important;font-weight:400!important}
#iwb-qa-root[data-theme] .qa-mobile-menu[data-slot="mobile-filter-menu"]{display:flex!important;align-items:center!important;gap:20px!important;flex-wrap:nowrap!important}
#iwb-qa-root[data-theme] .qa-mobile-menu[data-slot="mobile-arrange-menu"]{display:flex!important;flex-direction:column!important;align-items:stretch!important}
#iwb-qa-root[data-theme] .qa-mobile-menu[data-slot="mobile-arrange-menu"]>.qa-btn{width:100%!important;text-align:left!important}
#iwb-qa-root[data-theme] .qa-mobile-operation-row>.qa-btn.is-active,#iwb-qa-root[data-theme] .qa-mobile-menu .qa-btn.is-active{color:var(--iwb-accent)!important;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:7px}
#iwb-qa-root[data-theme] .qa-other-tools{display:flex!important;flex-direction:column}
#iwb-qa-root[data-theme] .qa-other-tools[hidden],#iwb-qa-root[data-theme] .qa-mobile-menu[hidden]{display:none!important}
#iwb-qa-root[data-theme] .qa-mobile-arrange-selection{display:flex;align-items:center;gap:14px;min-height:44px;font-size:13px;color:var(--iwb-text-secondary)}
#iwb-qa-root[data-theme] .qa-mobile-arrange-selection>span{margin-right:auto}
#iwb-qa-root[data-theme] .qa-other-tools>.qa-arrange-quick,#iwb-qa-root[data-theme] .qa-other-tools>[data-action="arrange-settings"]{display:none!important}
#iwb-qa-root[data-theme] .qa-scroll{order:1;flex:1 1 0!important;min-height:0!important;padding:10px!important;overflow-y:auto!important}
#iwb-qa-root[data-theme] .qa-list{gap:9px!important}

























#iwb-qa-root[data-theme].qa-import-active .qa-top-grid,#iwb-qa-root[data-theme].qa-transfer-active .qa-top-grid,#iwb-qa-root[data-theme].qa-arrange-active .qa-top-grid,#iwb-qa-root[data-theme].qa-import-active .qa-mobile-operation-row,#iwb-qa-root[data-theme].qa-transfer-active .qa-mobile-operation-row,#iwb-qa-root[data-theme].qa-arrange-active .qa-mobile-operation-row{display:none!important}

#iwb-qa-root[data-theme] .qa-title-row .is-active{color:var(--iwb-accent)!important}
}
@media(max-width:350px){#iwb-qa-root[data-theme] .qa-mobile-operation-row{gap:9px!important;padding-inline:12px!important}#iwb-qa-root[data-theme] .qa-mobile-operation-row>.qa-quick-combo{padding-inline:5px!important}}
`;
  const COMBO_WORKSPACE_STYLES = String.raw`
#iwb-qa-root .qa-combo-head{display:none}
#iwb-qa-root.qa-combo-workspace .qa-head>:not(.qa-combo-head){display:none!important}
#iwb-qa-root.qa-combo-workspace .qa-combo-head{display:block!important;background:var(--iwb-workbench,var(--qa-panel-bg))}
#iwb-qa-root .qa-combo-titlebar{display:flex;align-items:center;gap:5px;min-height:54px;padding:0 12px}
#iwb-qa-root .qa-combo-titlebar h2{font-size:18px;font-weight:600;margin:0 auto 0 0;white-space:nowrap}
#iwb-qa-root .qa-combo-titlebar button{min-height:36px;min-width:32px;border:0;background:transparent;font-size:13px;padding:0 3px;box-shadow:none}
#iwb-qa-root .qa-combo-book{font-size:11px;padding:0 16px 8px;color:var(--iwb-muted,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#iwb-qa-root .qa-combo-tabs{display:flex;gap:17px;overflow-x:auto;white-space:nowrap;scrollbar-width:none;padding:0 16px;border-top:1px solid var(--qa-line);border-bottom:1px solid var(--qa-line)}
#iwb-qa-root .qa-combo-tab{flex:none;min-height:42px;padding:0;border:0;background:transparent;box-shadow:none;font-size:13px;color:var(--iwb-text-secondary,inherit)}
#iwb-qa-root .qa-combo-tab[aria-current="true"]{color:var(--iwb-accent,inherit);font-weight:600;border-bottom:2px solid var(--iwb-accent,var(--qa-selected-line))}
#iwb-qa-root .qa-combo-controls{display:flex;align-items:center;gap:13px;padding:8px 16px;flex-wrap:wrap;font-size:12px}
#iwb-qa-root .qa-combo-controls>span:first-child{margin-right:auto;font-size:13px;min-width:0;overflow-wrap:anywhere}
#iwb-qa-root .qa-combo-controls button,#iwb-qa-root .qa-combo-more button{border:0;background:transparent;box-shadow:none;min-height:30px;padding:0;font-size:13px;color:var(--iwb-accent,inherit)}
#iwb-qa-root .qa-combo-more{display:flex;gap:18px;padding:0 16px 8px;border-bottom:1px solid var(--qa-line)}
#iwb-qa-root .qa-combo-more[hidden]{display:none!important}
#iwb-qa-root .qa-combo-context{display:grid;gap:7px;border-top:1px solid var(--qa-line);padding:8px 0;font-size:11px}
#iwb-qa-root .qa-combo-context-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-height:26px}
#iwb-qa-root .qa-combo-context-row>span:first-child{color:var(--iwb-muted,inherit);font-size:10px;min-width:42px}
#iwb-qa-root .qa-combo-chip{padding:3px 6px;border:1px solid var(--qa-line);border-radius:3px;color:var(--iwb-text-secondary,inherit);background:var(--iwb-workbench,var(--qa-panel-bg))}
#iwb-qa-root .qa-combo-chip.current{color:var(--iwb-accent,inherit)}
#iwb-qa-root .qa-combo-context button{border:0;background:transparent;min-height:30px;padding:0 5px;font-size:12px;color:var(--iwb-accent,inherit);box-shadow:none}
#iwb-qa-root .qa-combo-assignment{display:grid;gap:6px}
#iwb-qa-root .qa-combo-assignment-row{display:flex;gap:10px;align-items:center;width:100%;padding:7px 0;border:0;border-bottom:1px solid var(--qa-line);background:transparent;text-align:left;font-size:13px;min-height:40px}
#iwb-qa-root .qa-combo-assignment-row>span:first-child{font-size:15px;min-width:18px;color:var(--iwb-accent,inherit)}
@media(max-width:350px){#iwb-qa-root .qa-combo-titlebar{gap:3px;padding-inline:9px}#iwb-qa-root .qa-combo-titlebar h2{font-size:17px}#iwb-qa-root .qa-combo-titlebar button{min-width:28px;font-size:12px}}

@media(max-width:480px){
#iwb-qa-root[data-theme] .qa-combo-head,#iwb-qa-root[data-theme] .qa-search-head{width:100%!important;min-width:0!important;max-width:none!important;grid-column:1/-1!important}
#iwb-qa-root[data-theme] .qa-combo-titlebar,#iwb-qa-root[data-theme] .qa-search-titlebar{display:flex!important;flex-wrap:nowrap!important;width:100%;min-width:0;gap:6px;padding:8px 12px}
#iwb-qa-root[data-theme] .qa-combo-titlebar h2,#iwb-qa-root[data-theme] .qa-search-titlebar h2{white-space:nowrap;flex:1;min-width:0;font-size:18px;font-weight:600}
#iwb-qa-root[data-theme] .qa-combo-titlebar button,#iwb-qa-root[data-theme] .qa-search-titlebar button{flex:none;min-height:36px;width:auto!important;padding:0 5px;font-size:12px}
#iwb-qa-root[data-theme] .qa-combo-controls{display:grid!important;grid-template-columns:minmax(0,1fr) auto auto auto!important;gap:8px!important;align-items:center}
#iwb-qa-root[data-theme] .qa-combo-controls>span:first-child{grid-column:1/-1;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#iwb-qa-root[data-theme] .qa-combo-controls button{width:auto!important;min-width:0!important;min-height:40px;font-size:12px;padding:0 3px!important;white-space:nowrap}
#iwb-qa-root[data-theme] .qa-search-modes{display:flex!important}
#iwb-qa-root[data-theme] .qa-search-replace{display:flex!important;min-width:0}
#iwb-qa-root[data-theme] .qa-search-replace input{min-width:0;flex:1}
#iwb-qa-root[data-theme] .qa-search-replace button{flex:none;width:auto!important;font-size:12px;white-space:nowrap}
}
`;
  const BODY_SEARCH_STYLES = String.raw`
#iwb-qa-root .qa-search-head{display:none}
#iwb-qa-root.qa-search-workspace .qa-head>:not(.qa-search-head){display:none!important}
#iwb-qa-root.qa-search-workspace .qa-search-head{display:block!important;background:var(--iwb-workbench,var(--qa-panel-bg))}
#iwb-qa-root .qa-search-titlebar{display:flex;align-items:center;padding:8px 12px;gap:7px;min-height:46px}
#iwb-qa-root .qa-search-titlebar h2{font-size:18px;font-weight:600;margin:0 auto 0 0}
#iwb-qa-root .qa-search-titlebar button{border:0;background:transparent;box-shadow:none;min-width:30px;min-height:34px}
#iwb-qa-root .qa-search-book{font-size:11px;color:var(--iwb-muted,inherit);padding:0 16px 9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#iwb-qa-root .qa-search-modes{display:flex;gap:23px;padding:0 16px;border-bottom:1px solid var(--qa-line)}
#iwb-qa-root .qa-search-modes button{font-size:13px;border:0;background:transparent;min-height:36px;padding:0;box-shadow:none}
#iwb-qa-root .qa-search-modes button[aria-current="true"]{color:var(--iwb-accent,var(--qa-accent-strong));border-bottom:2px solid currentColor}
#iwb-qa-root .qa-search-inputs{display:grid;gap:8px;padding:10px 16px 12px}
#iwb-qa-root .qa-search-inputs input{width:100%;min-width:0;font-size:14px;min-height:36px;background:var(--iwb-control,var(--qa-field-bg))}
#iwb-qa-root .qa-search-replace{display:flex;gap:8px;align-items:center}
#iwb-qa-root .qa-search-replace button{flex:none;font-size:12px;min-height:36px;padding:0 8px;white-space:nowrap}
#iwb-qa-root .qa-search-summary{font-size:11px;color:var(--iwb-muted,inherit);padding:4px 0 10px}
#iwb-qa-root .qa-search-result{padding:13px 0;border-top:1px solid var(--qa-line);background:transparent}
#iwb-qa-root .qa-search-result header{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;font-size:14px}
#iwb-qa-root .qa-search-result small{font-size:11px;color:var(--iwb-muted,inherit);margin-left:auto}
#iwb-qa-root .qa-search-result p{font-size:13px;line-height:1.7;margin:7px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--iwb-text-secondary,inherit)}

@media(min-width:481px){#iwb-qa-root.qa-search-workspace .qa-search-inputs{max-width:720px}}

@media(max-width:480px){
#iwb-qa-root[data-theme] .qa-combo-head,#iwb-qa-root[data-theme] .qa-search-head{width:100%!important;min-width:0!important;max-width:none!important;grid-column:1/-1!important}
#iwb-qa-root[data-theme] .qa-combo-titlebar,#iwb-qa-root[data-theme] .qa-search-titlebar{display:flex!important;flex-wrap:nowrap!important;width:100%;min-width:0;gap:6px;padding:8px 12px}
#iwb-qa-root[data-theme] .qa-combo-titlebar h2,#iwb-qa-root[data-theme] .qa-search-titlebar h2{white-space:nowrap;flex:1;min-width:0;font-size:18px;font-weight:600}
#iwb-qa-root[data-theme] .qa-combo-titlebar button,#iwb-qa-root[data-theme] .qa-search-titlebar button{flex:none;min-height:36px;width:auto!important;padding:0 5px;font-size:12px}
#iwb-qa-root[data-theme] .qa-combo-controls{display:grid!important;grid-template-columns:minmax(0,1fr) auto auto auto!important;gap:8px!important;align-items:center}
#iwb-qa-root[data-theme] .qa-combo-controls>span:first-child{grid-column:1/-1;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#iwb-qa-root[data-theme] .qa-combo-controls button{width:auto!important;min-width:0!important;min-height:40px;font-size:12px;padding:0 3px!important;white-space:nowrap}
#iwb-qa-root[data-theme] .qa-search-modes{display:flex!important}
#iwb-qa-root[data-theme] .qa-search-replace{display:flex!important;min-width:0}
#iwb-qa-root[data-theme] .qa-search-replace input{min-width:0;flex:1}
#iwb-qa-root[data-theme] .qa-search-replace button{flex:none;width:auto!important;font-size:12px;white-space:nowrap}
}
`;
  const MOBILE_POLISH_STYLES = String.raw`
@media(max-width:480px){


#iwb-qa-root[data-theme] .qa-top-grid>.qa-mobile-title-lock,#iwb-qa-root[data-theme] .qa-combo-title-lock{display:grid!important;place-items:center;min-width:34px;min-height:38px;color:var(--iwb-muted);background:transparent;border:0;box-shadow:none}
#iwb-qa-root[data-theme] .qa-book-picker-trigger{background:var(--iwb-control)!important;border:1px solid var(--qa-line)!important;border-radius:4px!important;padding:0 7px!important}
#iwb-qa-root[data-theme] .qa-mobile-compact-actions{justify-content:flex-start!important;gap:4px!important}
#iwb-qa-root[data-theme] .qa-mobile-compact-actions>.qa-action-icon[data-action="duplicate"]{margin-left:0!important}
#iwb-qa-root[data-theme] .qa-combo-context{padding-left:16px!important;padding-right:7px!important}
#iwb-qa-root[data-theme] .qa-combo-density-row{display:flex;align-items:center;min-height:42px;padding:0 12px;border-bottom:1px solid var(--qa-line);gap:6px}
#iwb-qa-root[data-theme] .qa-combo-density-row>span:first-child{margin-right:auto;font-size:11px;color:var(--iwb-muted)}
#iwb-qa-root[data-theme] .qa-combo-density-row button{min-height:40px;border:0;background:transparent;color:var(--iwb-muted);font-size:12px}
#iwb-qa-root[data-theme] .qa-combo-density-row button.is-active{color:var(--iwb-accent);text-decoration:underline;text-underline-offset:5px}
#iwb-qa-root[data-theme] .qa-combo-management{padding:8px 12px;background:var(--iwb-workbench);border-bottom:1px solid var(--qa-line)}
#iwb-qa-root[data-theme] .qa-combo-management-summary{display:flex;align-items:center;gap:12px;min-height:30px;font-size:13px}
#iwb-qa-root[data-theme] .qa-combo-management-summary>span:first-child{display:flex;flex:1;min-width:0;white-space:nowrap}
#iwb-qa-root .qa-combo-management-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#iwb-qa-root .qa-combo-management-summary small{flex:none;font-size:11px;font-weight:400}
#iwb-qa-root[data-theme] .qa-combo-management-summary>span:last-child{flex:none;color:var(--iwb-muted);font-size:11px;white-space:nowrap}
#iwb-qa-root[data-theme] .qa-combo-management-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}
#iwb-qa-root[data-theme] .qa-combo-management-actions button{min-height:44px;border:0;box-shadow:none;background:transparent;color:var(--iwb-text-secondary);font-size:14px;font-weight:400;padding:0 3px;white-space:nowrap}
#iwb-qa-root[data-theme] .qa-combo-management-actions button.danger{color:var(--iwb-danger)}
#iwb-qa-root[data-theme] .qa-name-arrange-settings{padding:12px 8px;display:grid;grid-template-columns:1fr 1fr;gap:10px}
#iwb-qa-root[data-theme] .qa-name-arrange-settings .qa-field{display:grid;gap:4px;min-width:0}
#iwb-qa-root[data-theme] .qa-name-arrange-settings select{width:100%;height:38px;font-size:14px}
}
#iwb-qa-root .qa-name-arrange-settings{display:flex;gap:14px;padding:10px 0}
#iwb-qa-root .qa-arrange-list[hidden]{display:none!important}
@media(min-width:481px){#iwb-qa-root .qa-combo-title-lock{display:none!important}#iwb-qa-root .qa-combo-management{display:flex;align-items:center;gap:24px;padding:8px 16px}#iwb-qa-root .qa-combo-management-summary{display:flex;gap:12px;min-width:0;flex:1}#iwb-qa-root .qa-combo-management-summary>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#iwb-qa-root .qa-combo-management-summary>span:last-child{white-space:nowrap;font-size:11px;opacity:.65}#iwb-qa-root .qa-combo-management-actions{display:flex;gap:16px}#iwb-qa-root .qa-combo-management-actions button{background:transparent;border:0;min-height:36px}#iwb-qa-root .qa-combo-density-row{display:flex;gap:7px;padding:6px 16px}#iwb-qa-root .qa-combo-density-row>span:first-child{margin-right:auto}}
`;
  const COMBO_NAV_STYLES = String.raw`
@media(max-width:480px){
#iwb-qa-root[data-theme] .qa-combo-navigation{display:flex;align-items:flex-start;gap:12px;padding:0 12px;border-block:1px solid var(--qa-line);font-size:13px;min-width:0}
#iwb-qa-root[data-theme] .qa-combo-fixed-tabs{display:flex;flex:none;gap:12px}
#iwb-qa-root[data-theme] .qa-combo-user-tabs{display:flex;gap:14px;overflow-x:auto;white-space:nowrap;flex:1;min-width:0;scrollbar-width:none}
#iwb-qa-root[data-theme] .qa-combo-navigation.is-expanded{position:relative;display:flex;flex-wrap:wrap;gap:0 14px;padding-right:54px;min-height:88px}
#iwb-qa-root[data-theme] .qa-combo-navigation.is-expanded .qa-combo-fixed-tabs,#iwb-qa-root[data-theme] .qa-combo-navigation.is-expanded .qa-combo-user-tabs{display:contents}
#iwb-qa-root[data-theme] .qa-combo-navigation.is-expanded .qa-combo-nav-tools{position:absolute;right:12px;top:0}
#iwb-qa-root[data-theme] .qa-combo-user-tab{display:flex;align-items:center;flex:none;max-width:100%;min-width:0}
#iwb-qa-root[data-theme] .qa-combo-user-tab .qa-combo-tab{max-width:min(170px,100%);min-width:0;flex:0 1 auto;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
#iwb-qa-root[data-theme] .qa-combo-nav-tools{display:flex;flex-direction:column;flex:none;gap:0}
#iwb-qa-root[data-theme] .qa-combo-nav-tools button{min-width:34px;min-height:44px;padding:0 2px;font-size:12px;background:transparent;border:0;box-shadow:none;color:var(--iwb-text-secondary)}
#iwb-qa-root[data-theme] .qa-combo-group-drag{width:30px;height:44px;flex:none;touch-action:none;border:0;background:transparent;color:var(--iwb-muted)}
#iwb-qa-root[data-theme] .qa-combo-user-tab.is-nav-drag-source{opacity:.55}
#iwb-qa-root[data-theme] .qa-combo-user-tab.is-nav-drop-before{box-shadow:inset 2px 0 var(--iwb-accent)}
#iwb-qa-root[data-theme] .qa-combo-user-tab.is-nav-drop-after{box-shadow:inset -2px 0 var(--iwb-accent)}
#iwb-qa-root[data-theme] .qa-combo-compact-management{display:flex;align-items:center;flex-wrap:wrap;gap:5px;padding:0 12px;border-bottom:1px solid var(--qa-line);min-height:44px;font-size:11px}
#iwb-qa-root[data-theme] .qa-combo-compact-summary{display:flex;align-items:center;gap:8px;min-height:40px;font-size:12px;white-space:nowrap}
#iwb-qa-root[data-theme] .qa-combo-compact-summary small{font-size:11px;color:var(--iwb-muted);font-weight:400}
#iwb-qa-root[data-theme] .qa-combo-inline-density{margin-left:auto;display:flex;gap:5px;align-items:center}
#iwb-qa-root[data-theme] .qa-combo-inline-density button{min-height:40px;padding:0 2px;border:0;background:transparent;color:var(--iwb-muted);font-size:12px}
#iwb-qa-root[data-theme] .qa-combo-inline-density button.is-active{color:var(--iwb-accent);text-decoration:underline;text-underline-offset:5px}
#iwb-qa-root[data-theme] .qa-combo-compact-management .qa-combo-management-actions{display:flex;gap:5px;flex:none}
#iwb-qa-root[data-theme] .qa-combo-compact-management .qa-combo-management-actions button{min-width:32px;font-size:13px;padding:0 2px;min-height:44px}
}
`;
  const MOBILE_CARD_STYLES = String.raw`
@media(max-width:480px){
#iwb-qa-root[data-theme="fog-ink"]{--iwb-success:#6D8A72;--iwb-danger:#A45F67;--iwb-changed:#BD8D50;--iwb-lamp-blue:#668DAC;--iwb-lamp-green:#789967}
#iwb-qa-root[data-theme="wisteria-moon"]{--iwb-success:#6E8B74;--iwb-danger:#A55F69;--iwb-changed:#C29555;--iwb-lamp-blue:#6189A8;--iwb-lamp-green:#7B9B68}
#iwb-qa-root[data-theme="night-mist"]{--iwb-success:#7EA087;--iwb-danger:#CF8792;--iwb-changed:#C8A05D;--iwb-lamp-blue:#82A8C3;--iwb-lamp-green:#8CAA77}
#iwb-qa-root[data-theme] .qa-mobile-card{position:relative;display:block;box-sizing:border-box;width:100%;max-width:100%;min-width:0;overflow:hidden;padding:0!important;border:1px solid var(--qa-card-line)!important;border-radius:6px!important;background:var(--iwb-card)!important;box-shadow:none!important}
#iwb-qa-root[data-theme] .qa-mobile-card.is-entry-dragging{outline:2px solid var(--iwb-accent);outline-offset:-2px;background:var(--iwb-selected)!important;border-color:var(--iwb-accent)!important;transform:scale(.985);transition:transform .12s ease}
#iwb-qa-root[data-theme] .qa-mobile-card.is-entry-move-feedback{animation:iwb-phone-move .72s ease;background:var(--iwb-selected)!important;border-color:var(--iwb-accent)!important;box-shadow:inset 0 0 0 1px var(--iwb-accent)!important}
#iwb-qa-root[data-theme] .qa-mobile-card.drop-before{box-shadow:inset 0 3px 0 var(--iwb-accent)!important}
#iwb-qa-root[data-theme] .qa-mobile-card.drop-after{box-shadow:inset 0 -3px 0 var(--iwb-accent)!important}
#iwb-qa-root[data-theme] .qa-mobile-card.drop-before:before,#iwb-qa-root[data-theme] .qa-mobile-card.drop-after:before{content:"";position:absolute;left:7px;right:auto;top:9px;bottom:9px;height:auto;width:2px;box-shadow:none;background:linear-gradient(to bottom,transparent,var(--iwb-accent) 30%,var(--iwb-accent-2) 70%,transparent)}
#iwb-qa-root[data-theme] .qa-mobile-card.drop-after:after{left:5px;right:auto;top:19px;bottom:auto;width:6px;height:6px;border-radius:0;box-shadow:none;background:linear-gradient(135deg,var(--iwb-accent),var(--iwb-accent-2))}
@keyframes iwb-phone-move{0%{transform:translateY(4px)}55%{transform:translateY(-1px)}100%{transform:translateY(0)}}
#iwb-qa-root[data-theme] .qa-mobile-card.is-selected{background:var(--iwb-selected)!important;border-color:var(--iwb-selected-border)!important}
#iwb-qa-root[data-theme] .qa-mobile-card:before{content:"";position:absolute;left:7px;top:9px;bottom:9px;width:2px;background:linear-gradient(to bottom,transparent,var(--iwb-accent) 30%,var(--iwb-accent-2) 70%,transparent);pointer-events:none}
#iwb-qa-root[data-theme] .qa-mobile-card:after{content:"";position:absolute;left:5px;top:19px;width:6px;height:6px;transform:rotate(45deg);background:linear-gradient(135deg,var(--iwb-accent),var(--iwb-accent-2));pointer-events:none}
#iwb-qa-root[data-theme] .qa-mobile-card.is-changed:after{right:8px;border-radius:50%}
#iwb-qa-root[data-theme] .qa-mobile-card.is-selected:before{background:linear-gradient(to bottom,transparent,var(--iwb-selected-decoration) 30%,var(--iwb-accent-2) 70%,transparent)}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-card-main{display:block!important;box-sizing:border-box;width:100%;max-width:100%;min-width:0;align-items:center;padding:0!important}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-card-head{display:grid!important;grid-template-columns:20px minmax(0,1fr) 32px 32px!important;gap:7px!important;align-items:center;align-self:center;min-width:0;min-height:55px;padding:7px 7px 7px 16px!important}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-name-cell{display:grid;align-content:center;min-width:0;min-height:48px}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-name{display:block;width:100%;min-width:0;height:auto;min-height:0;padding:0!important;border:0!important;border-radius:0;background:transparent!important;color:var(--iwb-text)!important;font-size:15px!important;font-weight:600!important;line-height:1.35;text-align:left;white-space:nowrap;overflow:hidden;overflow-wrap:anywhere;text-overflow:ellipsis;touch-action:manipulation;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;box-shadow:none!important}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-name-meta{min-width:0;font-size:11px!important;font-weight:400!important;color:var(--iwb-muted)!important;line-height:1.35;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-name-meta b{font-weight:400!important}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-name-edit{display:grid;grid-template-columns:minmax(0,1fr) 36px;gap:2px;align-items:center;min-width:0}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-name-input{width:100%;min-width:0;height:34px;padding:0 7px;border-width:1px;border-style:solid;border-color:var(--qa-accent-line)}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-name-done{width:36px;min-width:36px;height:36px;padding:0;border:0;border-radius:6px;background:transparent;opacity:.82}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-name-done:hover,#iwb-qa-root[data-theme] .qa-mobile-card .qa-name-done:focus-visible{background:var(--qa-accent-soft);opacity:1}
#iwb-qa-root[data-theme] .qa-mobile-card.is-changed .qa-name-meta:after{content:"";display:inline-block;width:5px;height:5px;background:var(--iwb-changed);border-radius:50%;margin-left:5px}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-check{appearance:none!important;-webkit-appearance:none!important;position:relative;width:18px!important;height:18px!important;min-width:18px;margin:0!important;border:1px solid var(--qa-card-line)!important;border-radius:3px!important;background:var(--iwb-card)!important;box-shadow:none!important;align-self:center;justify-self:center}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-check:checked{background:var(--iwb-checkbox-selected)!important;border-color:var(--iwb-checkbox-selected)!important}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-check:checked:after{content:"";position:absolute;left:5px;top:2px;width:5px;height:9px;border:solid white;border-width:0 2px 2px 0;transform:rotate(45deg)}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-drag,#iwb-qa-root[data-theme] .qa-mobile-card .qa-expand{width:32px!important;height:32px!important;min-width:0;min-height:0;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;color:var(--iwb-text-secondary)!important;box-shadow:none!important}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-expand{align-self:center;justify-self:center;opacity:.82}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-inline-fields{width:100%;display:grid!important;grid-column:auto!important;gap:6px!important;align-items:center;align-self:center;margin-top:3px;padding:8px 7px 9px 16px!important;border-top:1px solid var(--qa-line)}
#iwb-qa-root[data-theme] .qa-mobile-detail-row{display:grid;grid-template-columns:minmax(0,1fr) 48px 36px 36px;gap:10px;align-items:end;justify-content:stretch}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-inline-field{display:grid!important;grid-template-columns:minmax(0,1fr)!important;gap:2px!important;align-items:center;min-width:0;min-height:34px}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-inline-field>span{font-size:10px!important;font-weight:400!important;line-height:1.2;color:var(--iwb-muted)!important;white-space:nowrap}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-inline-field input,#iwb-qa-root[data-theme] .qa-mobile-card .qa-inline-field select{width:100%!important;min-width:0!important;height:30px!important;min-height:0!important;padding:0 7px!important;font-size:14px!important;font-weight:400!important;border:1px solid var(--qa-line)!important;border-radius:4px!important;background:var(--iwb-control)!important;color:var(--iwb-text)!important;box-shadow:none!important}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-inline-field input{text-align:center;padding-inline:3px!important}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-action-icon,#iwb-qa-root[data-theme] .qa-mobile-card .qa-switch{position:relative;display:grid;place-items:center;width:36px!important;height:32px!important;min-height:0;min-width:0;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;color:var(--iwb-text-secondary)!important;font-size:15px!important;box-shadow:none!important}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-switch:before{content:"";position:static;width:30px;height:17px;border-radius:20px;background:color-mix(in srgb,var(--iwb-muted) 42%,var(--iwb-control))}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-switch:after{content:"";position:absolute;left:9px;top:10px;width:11px;height:11px;border-radius:50%;background:white;box-shadow:none;transform:none}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-switch[aria-checked="true"]:before{background:var(--iwb-success)}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-switch[aria-checked="true"]:after{left:21px;transform:none}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-lamp.blue,#iwb-qa-root[data-theme] .qa-mobile-card .qa-lamp.green{font-size:0!important}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-lamp.blue:before,#iwb-qa-root[data-theme] .qa-mobile-card .qa-lamp.green:before{content:"";width:15px;height:15px;border-radius:50%;background:var(--iwb-lamp-blue)}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-lamp.green:before{background:var(--iwb-lamp-green)}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-delete:hover{color:var(--iwb-danger)!important}
#iwb-qa-root[data-theme] .qa-mobile-compact-actions{display:flex;align-items:center;gap:4px;min-height:40px;padding:2px 7px 3px 16px;border-top:1px solid var(--qa-line)}
#iwb-qa-root[data-theme] .qa-mobile-compact-actions>.qa-action-icon[data-action="duplicate"]{margin-left:auto}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-editor{display:block!important;margin:0!important;padding:10px 7px 12px 16px!important;background:transparent!important;border:0!important;border-top:1px solid var(--qa-line)!important;box-shadow:none!important}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-field>span,#iwb-qa-root[data-theme] .qa-mobile-card .qa-content-label>span{font-size:10px!important;font-weight:400!important;color:var(--iwb-muted)!important}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-content-inline{display:block;width:100%;min-height:108px;resize:vertical;padding:9px 10px!important;border:1px solid var(--qa-line)!important;background:var(--iwb-editor)!important;color:var(--iwb-text)!important;font-size:14px!important;line-height:1.6!important}
#iwb-qa-root[data-theme] .qa-mobile-card .qa-keyword-chip{border-radius:3px!important;font-size:12px!important;font-weight:400!important;box-shadow:none!important}
#iwb-qa-root[data-theme] .qa-mobile-density-toggle{display:flex;gap:5px;align-items:center;justify-content:flex-end;padding:3px 12px;border-top:1px solid var(--qa-line);font-size:12px}
#iwb-qa-root[data-theme] .qa-mobile-density-toggle button{min-height:32px;padding:0 3px;border:0;background:transparent;color:var(--iwb-muted);font-size:12px;box-shadow:none}
#iwb-qa-root[data-theme] .qa-mobile-density-toggle button.is-active{color:var(--iwb-accent);text-decoration:underline;text-underline-offset:5px}
}
@media(max-width:350px){#iwb-qa-root[data-theme] .qa-mobile-detail-row{grid-template-columns:minmax(0,1fr) 44px 32px 32px;gap:6px}#iwb-qa-root[data-theme] .qa-mobile-card .qa-action-icon,#iwb-qa-root[data-theme] .qa-mobile-card .qa-switch{width:32px!important}}
`;
  const MOBILE_WORKBENCH_COMPONENT_STYLES = String.raw`/* Mobile-owned workbench, selection/safety bars and dialogs. */
.qa-leave-layer{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;padding:16px;overflow:auto;overscroll-behavior:contain}
.qa-leave-layer[hidden]{display:none}
.qa-leave-dialog h3{margin:0;font-size:17px}
.qa-leave-dialog p{margin:0;line-height:1.5}
.qa-leave-actions{display:grid;grid-template-columns:1fr;gap:7px}
.qa-leave-actions .qa-btn{width:100%;min-height:40px}
.qa-leave-open .qa-scroll{overflow:hidden!important}
.qa-leave-open .qa-workspace-panel{overflow:hidden!important}
.qa-workspace-panel[hidden]{display:none}
@media (max-width:480px) {
  .qa-keyboard-open:not(.qa-content-editing) .qa-footer{padding-top:4px;gap:4px}
}
.qa-workspace-panel{max-height:min(45dvh,380px);overflow-y:auto;padding:5px 6px;border-bottom:1px solid var(--qa-line);background:var(--qa-bg);border-bottom-color:var(--qa-line)}
.qa-leave-dialog{position:relative;z-index:1;width:min(100%,380px);max-height:calc(100dvh - 32px);overflow:auto;display:grid;gap:12px;padding:16px;border:1px solid var(--qa-card-line);border-radius:12px;background:var(--qa-surface);border-color:var(--qa-line);color:var(--qa-text);box-shadow:0 20px 60px rgba(42,55,65,.20)}
.qa-leave-backdrop{position:absolute;inset:0;background:rgba(39,49,58,.48);backdrop-filter:blur(2px)}
.qa-leave-error{padding:8px;border-radius:7px;font-size:12px;background:var(--qa-danger-soft);color:#9F5050}
.qa-footer{position:relative;border-top:1px solid var(--qa-line);padding:5px 6px calc(5px + env(safe-area-inset-bottom));display:grid;gap:4px;box-sizing:border-box;width:100%;max-width:100%;min-width:0;max-height:40%;overflow-y:auto;background:rgba(255,255,255,.97);border-top-color:var(--qa-line);box-shadow:0 -5px 18px rgba(61,78,92,.06);backdrop-filter:blur(14px)}
@media (min-width:481px) {
  .qa-workspace-panel{grid-area:workspace;max-height:min(34dvh,310px);overflow-y:auto;border-top:1px solid var(--qa-line);padding:8px 14px;background:var(--qa-bg)}
  .qa-workspace-panel[hidden]{display:none}
  .qa-workspace-panel.qa-batch-workspace{max-height:none;overflow:visible}
  .qa-footer{grid-area:footer;position:relative;max-height:none;min-height:62px;overflow:visible!important;display:flex!important;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--qa-line);background:#fff}
  .qa-footer [data-action="clear-selection"]{order:4}
  .qa-footer [data-action="undo"]{order:5}
  .qa-footer [data-action="discard"]{order:6}
  .qa-footer [data-action="save"]{order:7;min-width:132px}
  .qa-footer .qa-btn{height:42px;min-height:42px;padding:0 15px;border-radius:9px}
  .qa-footer [data-action="batch-panel"]{order:3;background:var(--qa-accent-soft);border-color:var(--qa-accent-line);color:#365e7f}
  .qa-workspace-panel.qa-batch-workspace:has(.qa-batch-subpanel){min-height:min(36dvh,330px);display:grid;place-items:center;overflow:auto}
  .qa-batch-subpanel{width:min(720px,calc(100% - 40px));max-height:calc(100% - 24px);overflow:auto;margin:auto;padding:20px;border:1px solid #cddbe3;border-radius:16px;background:#fff;box-shadow:0 16px 38px rgba(45,73,91,.16)}
  .qa-batch-subpanel h3{margin-top:0;font-size:18px}
  .qa-batch-subpanel .qa-fields{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .qa-batch-subpanel .qa-footer-row{justify-content:flex-end;margin-top:16px}
@media (max-width:1180px) {
    .qa-footer .qa-btn{padding-inline:10px}
}
}
@media (max-width:480px) {
  #iwb-qa-root.qa-import-active .qa-footer{display:none!important}
  #iwb-qa-root.qa-import-active .qa-workspace-panel{display:none!important}
  #iwb-qa-root:not(.qa-import-active) .qa-workspace-panel{grid-row:3!important}
  #iwb-qa-root:not(.qa-import-active) .qa-footer{grid-row:4!important}
  .qa-footer.qa-footer-has-selection{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;align-items:stretch}
  .qa-discard-confirm-dialog{width:min(100%,340px)}
  .qa-discard-confirm-actions{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (min-width:481px) and (max-width:1024px) {
  .qa-workspace-panel{max-height:min(46dvh,430px);overflow-y:auto;padding:8px 10px}
  .qa-workspace-panel.qa-batch-workspace{max-height:min(46dvh,430px);overflow-y:auto}
  .qa-batch-subpanel{width:min(680px,calc(100% - 16px));max-height:calc(100% - 16px);padding:16px}
  .qa-batch-subpanel .qa-fields{grid-template-columns:repeat(2,minmax(0,1fr))}
  .qa-footer{min-height:0;display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;align-items:stretch;padding:8px 10px}
  .qa-footer [data-action="batch-panel"]{order:initial;min-width:0;margin:0}
  .qa-footer [data-action="clear-selection"]{order:initial;min-width:0;margin:0}
  .qa-footer [data-action="undo"]{order:initial;min-width:0;margin:0;grid-column:1;grid-row:2}
  .qa-footer [data-action="discard"]{order:initial;min-width:0;margin:0;grid-column:2;grid-row:2}
  .qa-footer [data-action="save"]{order:initial;min-width:0;margin:0;grid-column:3/5;grid-row:2;width:100%}
  .qa-footer .qa-btn{width:100%;height:44px;min-height:44px;padding-inline:6px}
  .qa-footer.qa-footer-has-selection .qa-count{grid-column:1/3;grid-row:1}
  .qa-footer.qa-footer-has-selection [data-action="undo"]{grid-column:1;grid-row:2}
  .qa-footer.qa-footer-has-selection [data-action="discard"]{grid-column:2;grid-row:2}
  .qa-footer.qa-footer-has-selection [data-action="batch-panel"]{grid-column:3;grid-row:2}
  .qa-footer.qa-footer-has-selection [data-action="clear-selection"]{grid-column:4;grid-row:2}
  .qa-footer.qa-footer-has-selection [data-action="save"]{grid-column:1/-1;grid-row:3}
}
#iwb-qa-root[data-theme="wisteria-moon"] .qa-discard-confirm-dialog{border-color:#D8D3E8;box-shadow:0 18px 48px rgba(50,47,74,.22)}
#iwb-qa-root[data-theme="wisteria-moon"] .qa-leave-dialog{border-color:#D8D3E8;box-shadow:0 18px 48px rgba(50,47,74,.22)}
#iwb-qa-root[data-theme="night-mist"] .qa-footer{background:color-mix(in srgb,var(--qa-bg) 88%,var(--qa-surface) 12%);border-color:var(--qa-line)}
#iwb-qa-root[data-theme="night-mist"] .qa-batch-subpanel{background:var(--qa-card-bg)!important;border-color:var(--qa-card-line)!important;color:var(--qa-text)}
#iwb-qa-root[data-theme="night-mist"] .qa-footer [data-action="batch-panel"]{background:var(--qa-accent-soft)!important;border-color:var(--qa-accent-line)!important;color:var(--qa-accent-strong)!important}
#iwb-qa-root[data-theme="night-mist"] .qa-leave-dialog{background:var(--qa-panel-bg);border-color:var(--qa-panel-line);color:var(--qa-text);box-shadow:0 18px 50px rgba(5,6,10,.46)}
#iwb-qa-root[data-theme="night-mist"] .qa-discard-confirm-dialog{background:var(--qa-panel-bg);border-color:var(--qa-panel-line);color:var(--qa-text);box-shadow:0 18px 50px rgba(5,6,10,.46)}
@media (max-width:480px) {
  .qa-footer{grid-row:3;z-index:3;padding:5px calc(5px + env(safe-area-inset-right)) calc(5px + env(safe-area-inset-bottom)) calc(5px + env(safe-area-inset-left));overflow:visible;border-top:2px solid var(--qa-accent-line)!important;background:var(--qa-surface)!important;box-shadow:0 -8px 22px rgba(42,39,65,.13)!important}
  .qa-import-active .qa-footer{display:none!important}
  .qa-transfer-active .qa-footer{display:none!important}
  .qa-arrange-active .qa-footer{display:none!important}
  #iwb-qa-root[data-theme] .qa-workspace-panel{background:var(--iwb-workbench);box-shadow:none}
  #iwb-qa-root[data-theme] .qa-workspace-panel[hidden]{display:none!important}
  #iwb-qa-root[data-theme] .qa-workspace-panel:not(.qa-group-name-dialog){order:2;position:static!important;flex:none!important;width:auto!important;max-height:40dvh!important;overflow:auto!important;margin:0!important;padding:0!important;background:var(--iwb-workbench)!important;border:0!important;border-top:1px solid var(--qa-line)!important;border-radius:0!important;box-shadow:none!important;transform:none!important}
  #iwb-qa-root[data-theme] .qa-workspace-panel .qa-panel{margin:0!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important}
  #iwb-qa-root[data-theme] .qa-mobile-batch-head{display:flex;align-items:center;min-height:38px;padding:0 16px;font-size:13px;font-weight:600}
  #iwb-qa-root[data-theme] .qa-mobile-batch-head>.qa-btn{margin-left:auto;border:0!important;background:transparent!important;padding:0!important;min-height:32px!important}
  #iwb-qa-root[data-theme] .qa-mobile-batch-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid var(--qa-line)}
  #iwb-qa-root[data-theme] .qa-mobile-batch-grid>.qa-btn{min-height:43px!important;border:0!important;border-right:1px solid var(--qa-line)!important;border-bottom:1px solid var(--qa-line)!important;border-radius:0!important;background:transparent!important;padding:0!important;font-size:13px!important;font-weight:400!important;box-shadow:none!important}
  #iwb-qa-root[data-theme] .qa-mobile-batch-grid>.qa-batch-flower{min-height:43px!important;border:0!important;border-right:1px solid var(--qa-line)!important;border-bottom:1px solid var(--qa-line)!important;border-radius:0!important;background:transparent!important;padding:0!important;font-size:13px!important;font-weight:400!important;box-shadow:none!important}
  #iwb-qa-root[data-theme] .qa-mobile-batch-grid>:nth-child(3n){border-right:0!important}
  #iwb-qa-root[data-theme] .qa-batch-flower{display:grid;place-items:center;color:var(--iwb-accent-2)}
  #iwb-qa-root[data-theme] .qa-footer{order:3;flex:none!important;position:static!important;padding:0!important;border-top:1px solid var(--qa-line)!important;border-radius:0!important;background:var(--iwb-workbench)!important;box-shadow:none!important;display:block!important}
  #iwb-qa-root[data-theme] .qa-selection-strip{min-height:48px;display:flex;align-items:center;gap:3px;padding:0 10px 0 12px;border-bottom:1px solid var(--qa-line);font-size:13px}
  #iwb-qa-root[data-theme] .qa-selection-strip>span{margin-right:auto;font-weight:600;white-space:nowrap;font-size:13px}
  #iwb-qa-root[data-theme] .qa-group-name-dialog{box-sizing:border-box!important;position:absolute!important;inset:0!important;z-index:10050!important;display:flex!important;align-items:center!important;justify-content:center!important;max-height:none!important;padding:20px!important;background:color-mix(in srgb,var(--iwb-text) 26%,transparent)!important;overflow:auto!important}
  #iwb-qa-root[data-theme] .qa-group-name-dialog .qa-entry-group-create-panel{display:block!important;box-sizing:border-box!important;width:100%;max-width:340px;margin:0!important;padding:18px!important;border:1px solid var(--qa-line)!important;border-radius:6px!important;background:var(--iwb-workbench)!important}
  #iwb-qa-root[data-theme] .qa-group-name-dialog .qa-input{width:100%;min-width:0;height:42px;font-size:14px;background:var(--iwb-control)}
  #iwb-qa-root[data-theme] .qa-group-name-dialog .qa-entry-group-create-panel>div{display:flex;justify-content:flex-end;gap:18px;margin-top:15px}
  #iwb-qa-root[data-theme] .qa-group-name-dialog .qa-btn{min-height:44px;padding:0 10px}
  #iwb-qa-root[data-theme] .qa-selection-strip .qa-btn{width:auto!important;min-width:0!important;min-height:32px!important;margin:0!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;color:var(--iwb-accent)!important;box-shadow:none!important;font-size:13px!important;font-weight:400!important;white-space:nowrap}
  #iwb-qa-root[data-theme] .qa-mobile-safety .qa-btn{width:auto!important;min-width:0!important;min-height:32px!important;margin:0!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;color:var(--iwb-accent)!important;box-shadow:none!important;font-size:13px!important;font-weight:400!important;white-space:nowrap}
  #iwb-qa-root[data-theme] .qa-selection-strip .qa-btn:disabled{color:var(--iwb-muted)!important;opacity:.48}
  #iwb-qa-root[data-theme] .qa-mobile-safety{display:flex;align-items:center;gap:13px;min-height:28px;padding:0 14px max(0px,env(safe-area-inset-bottom)) 16px}
  #iwb-qa-root[data-theme] .qa-mobile-safety.is-dirty{min-height:51px}
  #iwb-qa-root[data-theme] .qa-mobile-safety>span{margin-right:auto;color:var(--iwb-muted);font-size:12px}
  #iwb-qa-root[data-theme] .qa-mobile-safety.is-dirty>span{color:var(--iwb-accent)}
  #iwb-qa-root[data-theme] .qa-mobile-safety>.danger{color:var(--iwb-danger)!important}
  #iwb-qa-root[data-theme] .qa-workspace-panel .qa-batch-subpanel{padding:8px 16px!important}
  #iwb-qa-root[data-theme].qa-import-active .qa-footer{display:none!important}
  #iwb-qa-root[data-theme].qa-transfer-active .qa-footer{display:none!important}
  #iwb-qa-root[data-theme].qa-arrange-active .qa-footer{display:none!important}
}
@media (max-width:350px) {
  #iwb-qa-root[data-theme] .qa-selection-strip{gap:9px!important;padding-inline:12px!important;font-size:12px!important}
  #iwb-qa-root[data-theme] .qa-selection-strip .qa-btn{font-size:12px!important}
}
#iwb-qa-root.qa-search-workspace .qa-workspace-panel{display:none!important}
@media (min-width:481px) {
  #iwb-qa-root.qa-search-workspace .qa-mobile-safety{display:flex;align-items:center;justify-content:flex-end;gap:12px;min-height:28px}
  #iwb-qa-root.qa-search-workspace .qa-mobile-safety.is-dirty{min-height:51px}
  #iwb-qa-root.qa-search-workspace .qa-mobile-safety span{margin-right:auto}
}
@media (min-width:1025px) {
  #iwb-qa-root .qa-footer{min-height:45px;padding:6px 18px;background:var(--iwb-workbench,var(--qa-bg));border-top:1px solid var(--qa-line)}
  #iwb-qa-root .qa-footer .qa-btn{height:32px;min-height:32px;border-radius:4px;font-size:13px;padding:0 11px;box-shadow:none}
  #iwb-qa-root .qa-workspace-panel{background:var(--iwb-workbench,var(--qa-bg));padding:10px 18px;border-top:1px solid var(--qa-line)}
  #iwb-qa-root .qa-workspace-panel .qa-panel{border:0;border-radius:0;box-shadow:none;background:transparent}
}
@media (max-width:480px) {
  #iwb-qa-root[data-theme] .qa-selection-strip .qa-btn[data-action]{min-width:34px!important;padding:0 5px!important;font-size:14px!important;font-weight:400!important;min-height:44px!important}
  #iwb-qa-root[data-theme] .qa-mobile-batch-grid .qa-btn{font-size:14px!important;font-weight:400!important}
}
`;
  function isDesktopLayout() { return false; }
  function isWideDesktopLayout() { return false; }
  function syncWideDesktopWorkbench() {} // Existing phone path was already a no-op.
  function requireMobileUiSession(view) {
    if (!view.uiSession || view.uiSession.adapterId !== 'mobile-v1') throw new Error('Mobile UI requires its own session');
    return view.uiSession;
  }
  function mobileUiTimeout(view, key, callback, delay) {
    return requireMobileUiSession(view).resources.timeout(key, callback, delay);
  }
  function mobileUiFrame(view, callback) {
    return requireMobileUiSession(view).resources.frame(hostWindow(), callback);
  }

  function mobileCardActionsHtml(entry) {
    const enabled = enabledPresentation(entry);
    const activation = editableActivationType(entry);
    const green = activation === 'selective' || activation === 'normal';
    const raw = String(entry?.strategy?.type ?? 'unknown');
    const label = activation === 'constant' ? '蓝灯：永久' : green ? '绿灯：关键词' : raw === 'vectorized' ? '向量状态，只读' : '激活方式只读';
    return [
      '<button class="qa-switch" data-action="enabled" role="switch" aria-checked="' + enabled.checked + '" ' + (enabled.disabled ? 'disabled ' : '') + 'aria-label="' + escapeHtml(enabled.label) + '" title="' + escapeHtml(enabled.title) + '"></button>',
      '<button class="qa-action-icon qa-lamp ' + (activation === 'constant' ? 'blue' : green ? 'green' : 'readonly') + '" data-action="activation" ' + (activation ? '' : 'disabled ') + 'aria-label="' + escapeHtml(label) + '" title="' + escapeHtml(label) + '">' + (activation === 'constant' ? '🔵' : green ? '🟢' : '🔗') + '</button>',
      '<button class="qa-action-icon" data-action="duplicate" aria-label="复制条目" title="复制条目"><i class="fa-solid fa-copy" aria-hidden="true"></i></button>',
      '<button class="qa-action-icon qa-delete" data-action="delete" aria-label="删除条目" title="删除条目"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>',
    ];
  }

  function mobileCardFieldsHtml(entry) {
    const pos = positionInfo(entry);
    const actions = mobileCardActionsHtml(entry);
    const atDepth = pos.editable && pos.type === 'at_depth';
    const position = pos.editable ? '<select class="qa-select" data-control="entry-position" aria-label="原生位置">' + POSITION_TYPES.map(type => optionHtml(type, POSITION_LABELS[type], pos.type)).join('') + '</select>' : '<input class="qa-input" value="' + escapeHtml(pos.label) + '" disabled aria-label="原生位置">';
    const role = atDepth ? '<select class="qa-select" data-control="entry-role" aria-label="角色">' + Object.entries(ROLE_LABELS).map(([value, label]) => optionHtml(value, label, pos.role || 'system')).join('') + '</select>' : '<input class="qa-input" value="—" disabled aria-label="角色不适用">';
    const field = (label, control) => '<label class="qa-inline-field"><span>' + label + '</span>' + control + '</label>';
    return '<div class="qa-mobile-detail-row">' + field('位置', position) + field('顺序', '<input class="qa-input" data-control="entry-order" aria-label="顺序" type="number" step="any" value="' + escapeHtml(pos.order ?? 100) + '" ' + (pos.editable ? '' : 'disabled') + '>') + actions[0] + actions[1] + '</div><div class="qa-mobile-detail-row">' + field('角色', role) + field('深度', '<input class="qa-input" ' + (atDepth ? 'data-control="entry-depth"' : 'disabled') + ' aria-label="深度" type="number" min="0" step="1" value="' + (atDepth ? escapeHtml(pos.depth ?? 4) : '') + '">') + actions[2] + actions[3] + '</div>';
  }

  function mobileCardEditorHtml(entry) {
    const id = entryId(entry);
    const secondary = Array.isArray(entry?.strategy?.keys_secondary?.keys) ? entry.strategy.keys_secondary.keys : [];
    const advanced = secondary.length ? `<div class="qa-advanced-note">含 ${secondary.length} 个辅助关键词／高级条件，本版只读并原样保留。</div>` : '';
    return `<section class="qa-editor" data-editor-id="${escapeHtml(id)}"><div class="qa-fields">
      <div class="qa-field qa-wide"><span>主关键词</span><div class="qa-keyword-editor">${keywordEditorContents(entry)}</div></div>
      <div class="qa-field qa-wide"><div class="qa-content-label"><span>正文 <small class="qa-content-uid">· UID ${escapeHtml(entry._iwbOriginalUid ?? entry.uid)}</small></span><span class="qa-recursion-status">${recursionStatusHtml(entry)}</span><button class="qa-content-open" data-action="content-open" aria-label="全屏编辑正文" title="全屏编辑正文"><i class="fa-solid fa-expand" aria-hidden="true"></i></button></div><textarea class="qa-content-inline" data-control="entry-content" aria-label="正文">${escapeHtml(entry?.content ?? '')}</textarea></div>
    </div>${advanced}</section>`;
  }

  function mobileEntryCardHtml(view, entry, changed, globalIndex) {
    const id = entryId(entry);
    const selected = view.selected.has(id);
    const expanded = view.expanded.has(id);
    const compact = view.cardDensity === 'compact' && !expanded;
    const source = view.mixedMode && view.sourceVisible ? '<div class="qa-source" title="' + escapeHtml(entry._iwbBook) + '">' + escapeHtml(activeSourceText(view, entry._iwbBook)) + '</div>' : '';
    const meta = view.mixedMode ? '总览 No.' + (globalIndex + 1) + ' · 本书 No.' + (Number(entry._iwbBookIndex || 0) + 1) : 'No.' + (globalIndex + 1);
    const actions = mobileCardActionsHtml(entry);
    return '<article class="qa-card qa-mobile-card' + (selected ? ' is-selected' : '') + (changed.has(id) ? ' is-changed' : '') + (expanded ? ' is-expanded' : '') + (compact ? ' is-compact' : '') + '" data-entry-id="' + escapeHtml(id) + '" data-book="' + escapeHtml(entry._iwbBook || view.book) + '"><div class="qa-card-main"><div class="qa-card-head"><input class="qa-check" type="checkbox" data-action="toggle" ' + (selected ? 'checked ' : '') + 'aria-label="选择 ' + escapeHtml(entryName(entry)) + '"><div class="qa-name-cell">' + nameButtonHtml(entry, !canEditTitle(view)) + source + '<div class="qa-name-meta">' + meta + ' · Token <b data-token-id="' + escapeHtml(id) + '">' + escapeHtml(tokenLabel(view, entry)) + '</b></div></div><button class="qa-drag" data-action="drag" title="拖动排列" aria-label="拖动排列"><i class="fa-solid fa-bars" aria-hidden="true"></i></button><button class="qa-expand" data-action="expand" aria-expanded="' + expanded + '" aria-label="' + (expanded ? '收起' : '展开') + '条目"><i class="fa-solid fa-chevron-' + (expanded ? 'up' : 'down') + '" aria-hidden="true"></i></button></div>' + (compact ? '<div class="qa-mobile-compact-actions">' + actions.join('') + '</div>' : '<div class="qa-inline-fields">' + mobileCardFieldsHtml(entry) + '</div>') + (expanded ? mobileCardEditorHtml(entry) : '') + '</div></article>';
  }
  function mobileBatchPanelHtml(view) {
    return '<section class="qa-panel qa-mobile-batch"><div class="qa-mobile-batch-head"><span>批量操作</span><button class="qa-btn" data-action="panel-close">收起</button></div><div class="qa-mobile-batch-grid"><button class="qa-btn" data-action="batch-enabled" data-enabled="true">启用</button><button class="qa-btn" data-action="batch-enabled" data-enabled="false">停用</button><button class="qa-btn danger" data-action="batch-delete">删除</button><button class="qa-btn" data-action="panel-position">改位置</button><button class="qa-btn" data-action="panel-order">改顺序</button><span class="qa-batch-flower" aria-hidden="true">❀</span></div></section>';
  }

  function mobileFooterHtml(view) {
    if (['import', 'transfer', 'arrange-settings'].includes(view.panel)) return '';
    const creating = view.panel === 'entry-group-create';
    const editingGroup = view.mobileMode === 'group' && Boolean(view.entryGroupEditingId);
    const selected = view.selected.size;
    const scope = listSelectionScope(view).entries;
    const allSelected = scope.length > 0 && scope.every(entry => view.selected.has(entryId(entry)));
    const batchActive = ['batch', 'position', 'order'].includes(view.panel);
    const strip = editingGroup ? '<div class="qa-selection-strip"><span>成员选择</span><button class="qa-btn" data-action="entry-group-edit-cancel">取消</button><button class="qa-btn" data-action="entry-group-edit-save">保存成员</button></div>' : selected && !creating ? '<div class="qa-selection-strip"><span>已选 ' + selected + ' 条</span><button class="qa-btn" data-action="select-list-scope" ' + (allSelected ? 'disabled' : '') + '>全选</button><button class="qa-btn" data-action="entry-group-create-open">存为组合</button><button class="qa-btn" data-action="batch-panel">' + (batchActive ? '收起' : '批量') + '</button><button class="qa-btn" data-action="clear-selection">清空</button></div>' : '';
    const dirty = isDirty(view);
    const count = pendingChangeCount(view);
    const status = dirty ? count + ' 项未保存修改' : '无未保存修改';
    const disabled = view.busy ? ' disabled' : '';
    return strip + '<div class="qa-mobile-safety' + (dirty ? ' is-dirty' : '') + '"><span data-slot="mobile-change-summary">' + status + '</span>' + (dirty ? '<button class="qa-btn" data-action="undo"' + (!view.undo.length || view.busy ? ' disabled' : '') + '>撤销</button><button class="qa-btn danger" data-action="discard"' + disabled + '>放弃</button><button class="qa-btn" data-action="save"' + disabled + '>' + (view.busy === 'save' ? '保存中…' : '保存全部') + '</button>' : '') + '</div>';
  }

  function mobileComboHeaderHtml(view) {
    const active=view.entryGroups.find(group=>group.id===view.comboGroupId),entries=comboOrderedEntries(view),enabled=entries.filter(entry=>entry.enabled!==false).length;
    const status=active && entries.length ? enabled===0?'全部停用':enabled===entries.length?'全部启用':'部分启用' : '';
    const tab=(id,name,user=false)=>'<button class="qa-combo-tab" data-action="combo-tab" data-group-id="'+escapeHtml(id)+'"'+(user&&!view.comboNavArrange?' data-combo-drop-id="'+escapeHtml(id)+'"':'')+' aria-current="'+(id===view.comboGroupId)+'">'+escapeHtml(name)+'</button>';
    const users=view.entryGroups.map(group=>'<span class="qa-combo-user-tab" data-group-id="'+escapeHtml(group.id)+'">'+tab(group.id,group.name,true)+(view.comboNavArrange?'<button class="qa-combo-group-drag" data-action="combo-group-drag" data-group-id="'+escapeHtml(group.id)+'" aria-label="拖动组合排列">≡</button>':'')+'</span>').join('');
    const density='<div class="qa-combo-inline-density">'+(comboSelectedIds(view).length?'<button data-action="combo-assignment-open">分组</button>':'')+['compact','full'].map(value=>'<button data-action="card-density" data-density="'+value+'"'+(view.cardDensity===value || value==='full'&&!view.cardDensity?' class="is-active"':'')+'>'+(value==='full'?'完整':'精简')+'</button>').join('<span>/</span>')+'</div>';
    const management=active?comboManagementHtml(view).match(/<div class="qa-combo-management-actions">[\s\S]*?<\/div>/)?.[0]||'':'';
    return '<div class="qa-combo-titlebar"><button data-action="combo-back" aria-label="返回编辑视图">←</button><h2>快捷组合</h2><button class="qa-combo-title-lock" data-action="title-lock" aria-label="标题锁" aria-pressed="'+Boolean(view.titleLocked)+'"><i class="fa-solid fa-'+(view.titleLocked?'lock':'lock-open')+'"></i></button><button data-action="combo-new-open">＋ 新建组合</button><button data-action="theme-open" aria-label="界面主题"><i class="fa-solid fa-palette"></i></button><button data-action="close" aria-label="关闭观测台">×</button></div><nav class="qa-combo-navigation'+(view.comboNavExpanded?' is-expanded':'')+'"><div class="qa-combo-fixed-tabs">'+tab('__all__','全部')+tab('__ungrouped__','未分组')+'</div><div class="qa-combo-user-tabs" data-slot="combo-user-tabs">'+users+'</div><div class="qa-combo-nav-tools"><button data-action="combo-nav-toggle" aria-expanded="'+Boolean(view.comboNavExpanded)+'">'+(view.comboNavExpanded?'收起':'展开')+'</button>'+(view.comboNavExpanded?'<button data-action="combo-nav-arrange" aria-pressed="'+Boolean(view.comboNavArrange)+'">'+(view.comboNavArrange?'完成':'排列')+'</button>':'')+'</div></nav><div class="qa-combo-compact-management" title="'+escapeHtml(status)+'" aria-label="'+entries.length+' 条 '+escapeHtml(status)+'"><span>'+entries.length+' 条</span>'+management+density+'</div>';
  }

  function searchWorkspaceHeaderHtml(view) {
    const body = view.searchKind === 'body', count = searchWorkspaceResults(view).reduce((sum,result) => sum + result.count, 0);
    const replace = body && !view.mixedMode && view.book ? '<div class="qa-search-replace"><input class="qa-input" data-control="body-search-replace" placeholder="替换为" aria-label="替换为" value="' + escapeHtml(view.searchReplace || '') + '"><button class="qa-btn" data-action="body-replace-results"' + (!count || view.busy ? ' disabled' : '') + '>替换匹配结果（' + count + ' 处）</button></div>' : '';
    return '<div class="qa-search-titlebar"><button class="qa-icon" data-action="search-back" aria-label="返回上一工作区">←</button><h2>查找与替换</h2><button class="qa-icon" data-action="theme-open" aria-label="主题"><i class="fa-solid fa-palette" aria-hidden="true"></i></button><button class="qa-icon" data-action="guide-open" aria-label="帮助">?</button><button class="qa-icon" data-action="close" aria-label="关闭世界书观测台">×</button></div><div class="qa-search-book">' + escapeHtml(view.mixedMode ? '当前生效世界书总览' : view.book || '未选择世界书') + '</div><div class="qa-search-modes"><button data-action="search-kind" data-kind="metadata" aria-current="' + !body + '">条目</button><button data-action="search-kind" data-kind="body" aria-current="' + body + '">正文</button></div><div class="qa-search-inputs"><input class="qa-input" data-control="body-search-find" placeholder="' + (body ? '查找正文内容' : '名称 / UID / 主关键词') + '" aria-label="查找内容" value="' + escapeHtml(view.searchFind || '') + '">' + replace + '</div>';
  }

  function searchWorkspaceResultHtml(view) {
    const results = searchWorkspaceResults(view), count = results.reduce((sum,result) => sum + result.count, 0), limit = view.renderLimit || APP.chunkSize;
    return '<section class="qa-search-results"><div class="qa-search-summary">' + results.length + ' 条结果' + (view.searchKind === 'body' ? ' · ' + count + ' 处匹配' : '') + '</div>' + results.slice(0,limit).map(result => '<article class="qa-search-result"><header><span>' + escapeHtml(entryName(result.entry)) + '</span><small>UID ' + escapeHtml(result.entry._iwbOriginalUid ?? result.entry.uid) + (view.searchKind === 'body' ? ' · ' + result.count + ' 处' : '') + '</small></header><p>' + escapeHtml(result.snippet) + '</p></article>').join('') + (results.length > limit ? '<button class="qa-more" data-action="more">继续显示</button>' : '') + '</section>';
  }

  function searchSafetyFooterHtml(view) {
    const dirty = isDirty(view), count = pendingChangeCount(view), disabled = view.busy ? ' disabled' : '';
    return '<div class="qa-mobile-safety' + (dirty ? ' is-dirty' : '') + '"><span>' + (dirty ? count + ' 项未保存修改' : '无未保存修改') + '</span>' + (dirty ? '<button class="qa-btn" data-action="undo"' + (!view.undo.length || view.busy ? ' disabled' : '') + '>撤销</button><button class="qa-btn danger" data-action="discard"' + disabled + '>放弃</button><button class="qa-btn" data-action="save"' + disabled + '>保存全部</button>' : '') + '</div>';
  }

  function recursionStatusHtml(entry) {
    const recursion = entry?.recursion && typeof entry.recursion === 'object' ? entry.recursion : {};
    const incoming = recursion.prevent_incoming === true ? '禁止被递归' : '可被递归';
    const outgoing = recursion.prevent_outgoing === true ? '禁止继续递归' : '可继续递归';
    const delayed = recursion.delay_until !== null && recursion.delay_until !== undefined ? '<span>仅递归时触发</span>' : '';
    return `<span>${incoming}</span><span>${outgoing}</span>${delayed}`;
  }

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

  function groupModeBarHtml(view) {
    const sets = entryGroupIdSets(view);
    if (!view.activeEntryGroupId || (view.activeEntryGroupId !== '__ungrouped__' && !sets.some(item => item.group.id === view.activeEntryGroupId))) view.activeEntryGroupId = sets[0]?.group.id || '__ungrouped__';
    const grouped = new Set(sets.flatMap(item => [...item.ids]));
    const ungroupedCount = (view.working || []).map(entryId).filter(id => !grouped.has(id)).length;
    const chips = sets.map(({ group, ids }) => '<button class="qa-entry-group-chip' + (view.activeEntryGroupId === group.id ? ' is-active' : '') + '" data-action="entry-group-view" data-group-id="' + escapeHtml(group.id) + '" title="' + escapeHtml(group.name) + '">' + escapeHtml(group.name) + ' <small>' + ids.size + '</small></button>').join('');
    const ungrouped = '<button class="qa-entry-group-chip' + (view.activeEntryGroupId === '__ungrouped__' ? ' is-active' : '') + '" data-action="entry-group-view" data-group-id="__ungrouped__">未分组 <small>' + ungroupedCount + '</small></button>';
    const active = sets.find(item => item.group.id === view.activeEntryGroupId);
    const actions = active && !view.entryGroupEditingId ? '<div class="qa-entry-group-mode-actions"><button class="qa-btn" data-action="entry-group-enabled" data-enabled="true" data-group-id="' + escapeHtml(active.group.id) + '">启用</button><button class="qa-btn" data-action="entry-group-enabled" data-enabled="false" data-group-id="' + escapeHtml(active.group.id) + '">停用</button><button class="qa-btn" data-action="entry-group-edit-members" data-group-id="' + escapeHtml(active.group.id) + '">编辑成员</button><button class="qa-btn" data-action="entry-group-rename-open" data-group-id="' + escapeHtml(active.group.id) + '">改名</button><button class="qa-btn danger" data-action="entry-group-delete" data-group-id="' + escapeHtml(active.group.id) + '">删除</button></div>' : '';
    const editing = view.entryGroupEditingId ? '<div class="qa-entry-group-editing">编辑“' + escapeHtml(active?.group.name || '') + '”成员</div>' : '';
    return '<section class="qa-entry-group-mode"><div class="qa-entry-group-mode-head"><div class="qa-entry-group-tabs">' + chips + ungrouped + '</div><button class="qa-btn" data-action="mobile-group-exit">返回列表</button></div>' + editing + actions + '</section>';
  }

  function listContextHtml(view, entries) {
    const scope = listSelectionScope(view, entries);
    const label = scope.exactlySelected ? `已全选${scope.scopeName}` : `全选${scope.scopeName}`;
    const groupButton = view.mixedMode ? '' : '<button class="qa-btn qa-entry-groups-open" data-action="entry-groups-open">快捷组合</button>';
    return `<div class="qa-list-context"><span><strong>${escapeHtml(scope.countText)}</strong><small>已选 ${view.selected.size} 条</small></span><div class="qa-list-context-actions">${groupButton}<button class="qa-btn" data-action="select-list-scope" ${!scope.ids.length || scope.exactlySelected ? 'disabled' : ''}>${escapeHtml(label)}</button></div></div>`;
  }

  function bookSelectorOptionsHtml(view, value = view.book || '') {
    const groups = bookSelectorGroups(view);
    const empty = '<option value="">选择一本具体世界书</option>';
    const overview = optionHtml(MIXED_BOOK_VALUE, '当前生效世界书总览', value);
    if (!groups.reliable) {
      const all = groups.all.map(name => optionHtml(name, name, value)).join('');
      return `${empty}<optgroup label="当前生效">${overview}</optgroup><optgroup label="所有世界书">${all}</optgroup>`;
    }
    const active = groups.active.map(book => optionHtml(book.name, bookSelectorLabel(book), value)).join('');
    const inactive = groups.inactive.map(name => optionHtml(name, name, value)).join('');
    return `${empty}<optgroup label="当前生效">${overview}${active}</optgroup><optgroup label="当前未生效">${inactive}</optgroup>`;
  }

  function bookPickerItemHtml(value, label, current) {
    const selected = value === current;
    return `<button class="qa-book-picker-item${selected ? ' is-current' : ''}" data-action="book-picker-select" data-book-value="${escapeHtml(value)}" role="option" aria-selected="${selected}"><span>${escapeHtml(label)}</span>${selected ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : ''}</button>`;
  }

  function bookPickerResultsHtml(view, query = view.bookPickerQuery || '') {
    const groups = bookSelectorGroups(view);
    const activeItems = [];
    if (bookPickerMatches('当前生效世界书总览', query)) activeItems.push(bookPickerItemHtml(MIXED_BOOK_VALUE, '当前生效世界书总览', view.book));
    if (groups.reliable) {
      groups.active.forEach(book => {
        const label = bookSelectorLabel(book);
        if (bookPickerMatches(label, query)) activeItems.push(bookPickerItemHtml(book.name, label, view.book));
      });
      const inactiveItems = groups.inactive.filter(name => bookPickerMatches(name, query)).map(name => bookPickerItemHtml(name, name, view.book));
      if (!activeItems.length && !inactiveItems.length) return '<div class="qa-book-picker-empty">没有找到匹配的世界书</div>';
      return `${activeItems.length ? '<section class="qa-book-picker-group"><h3>当前生效</h3>' + activeItems.join('') + '</section>' : ''}${inactiveItems.length ? '<section class="qa-book-picker-group"><h3>当前未生效</h3>' + inactiveItems.join('') + '</section>' : ''}`;
    }
    const allItems = groups.all.filter(name => bookPickerMatches(name, query)).map(name => bookPickerItemHtml(name, name, view.book));
    if (!activeItems.length && !allItems.length) return '<div class="qa-book-picker-empty">没有找到匹配的世界书</div>';
    return `${activeItems.length ? '<section class="qa-book-picker-group"><h3>当前生效</h3>' + activeItems.join('') + '</section>' : ''}${allItems.length ? '<section class="qa-book-picker-group"><h3>所有世界书</h3>' + allItems.join('') + '</section>' : ''}`;
  }

  function themeHtml() {
    return `<section class="qa-theme-layer" data-slot="theme-picker" hidden><button type="button" class="qa-theme-backdrop" data-action="theme-close" aria-label="关闭界面主题选择"></button><div class="qa-theme-dialog" role="dialog" aria-modal="true" aria-labelledby="iwb-theme-title"><header class="qa-theme-head"><div><h3 id="iwb-theme-title">界面主题</h3><p>只改变观测台外观，不影响世界书内容。</p></div><button type="button" class="qa-icon" data-action="theme-close" aria-label="关闭界面主题选择">×</button></header><div class="qa-theme-options"><button type="button" class="qa-theme-choice" data-action="theme-select" data-theme-choice="fog-ink"><span class="qa-theme-preview qa-theme-preview-fog" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span><strong>雾墨青蓝</strong><small>冷雾灰、墨蓝与低饱和雾蓝</small></span><b aria-hidden="true">✓</b></button><button type="button" class="qa-theme-choice" data-action="theme-select" data-theme-choice="wisteria-moon"><span class="qa-theme-preview qa-theme-preview-wisteria" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span><strong>藤月烟粉</strong><small>冷白月雾、灰紫与少量雾蓝</small></span><b aria-hidden="true">✓</b></button><button type="button" class="qa-theme-choice" data-action="theme-select" data-theme-choice="night-mist"><span class="qa-theme-preview qa-theme-preview-night" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span><strong>夜雾墨紫</strong><small>深灰夜雾、柔和冷白与月紫强调</small></span><b aria-hidden="true">✓</b></button></div></div></section>`;
  }

  function guideHtml() {
    return `<section class="qa-guide-layer" data-slot="guide" hidden><button type="button" class="qa-guide-backdrop" data-action="guide-close" aria-label="关闭新手指引"></button><div class="qa-guide-dialog"><header class="qa-guide-head"><h3>功能简介</h3><button type="button" class="qa-icon" data-action="guide-close" aria-label="关闭功能简介">×</button></header><div class="qa-guide-layout"><nav class="qa-guide-nav qa-guide-desktop-only" aria-label="功能简介目录"><button type="button" class="qa-guide-nav-item is-active" data-guide-target="guide-edit">条目管理</button><button type="button" class="qa-guide-nav-item" data-guide-target="guide-combos">快捷组合</button><button type="button" class="qa-guide-nav-item" data-guide-target="guide-batch">批量整理</button><button type="button" class="qa-guide-nav-item" data-guide-target="guide-search">查找替换</button><button type="button" class="qa-guide-nav-item" data-guide-target="guide-transfer">跨书管理</button><button type="button" class="qa-guide-nav-item" data-guide-target="guide-save">修改保护</button><button type="button" class="qa-guide-nav-item" data-guide-target="guide-about">关于</button></nav><div class="qa-guide-body">
      <section id="guide-edit" class="qa-guide-section qa-guide-anchor"><h4>条目管理</h4><p>编辑条目名称、关键词、正文、启用状态、递归、位置、深度、角色与顺序。</p></section>
      <section id="guide-combos" class="qa-guide-section qa-guide-anchor"><h4>快捷组合</h4><p>建立和管理常用条目组合，并调整组合与成员排列。</p></section>
      <section id="guide-batch" class="qa-guide-section qa-guide-anchor"><h4>批量整理</h4><p>批量启停、修改位置与顺序，并按位置、顺序或名称整理列表。</p></section>
      <section id="guide-search" class="qa-guide-section qa-guide-anchor"><h4>查找与替换</h4><p>查找名称、UID、关键词与正文，并替换正文中的匹配内容。</p></section>
      <section id="guide-transfer" class="qa-guide-section qa-guide-anchor"><h4>跨书管理</h4><p>从其他世界书导入条目，或在世界书之间复制、移动条目。</p></section>
      <section id="guide-save" class="qa-guide-section qa-guide-anchor"><h4>修改保护</h4><p>未保存修改保留在工作副本中，可撤销、放弃或统一保存。</p></section>
      <section id="guide-about" class="qa-guide-section qa-guide-about qa-guide-anchor"><h4>关于</h4><p>世界书观测台 v${APP.version}｜三端适配｜作者：砚梨</p><p>相关项目：<a href="https://github.com/yanxu-orange/ST-Orange-Yancang" target="_blank" rel="noopener noreferrer">砚藏存卡 APK ↗</a> · <a href="https://github.com/yanxu-orange/ST-Orange-Lantai-Benmo" target="_blank" rel="noopener noreferrer">兰台记忆插件 ↗</a></p></section>
    </div></div></div></section>`;
  }

  function nameArrangeSettingsHtml(view) {
    const pref=normalizeNameArrangePreference(view.nameArrangeDraft);
    return '<div class="qa-name-arrange-settings"><label class="qa-field"><span>整理方式</span><select class="qa-select" data-control="arrange-method">'+optionHtml('position','位置与顺序',pref.mode)+optionHtml('name','名称',pref.mode)+'</select></label><label class="qa-field"><span>名称排序</span><select class="qa-select" data-control="name-arrange-direction">'+optionHtml('asc','名称升序',pref.direction)+optionHtml('desc','名称降序',pref.direction)+'</select></label></div>';
  }

  function comboDensityHtml(view) {
    return '<div class="qa-combo-density-row"><span>'+(comboSelectedIds(view).length ? '<button data-action="combo-assignment-open">分组</button>' : '')+'</span><button data-action="card-density" data-density="compact"'+(view.cardDensity==='compact'?' class="is-active"':'')+'>精简</button><span aria-hidden="true">/</span><button data-action="card-density" data-density="full"'+(view.cardDensity!=='compact'?' class="is-active"':'')+'>完整</button></div>';
  }

  function comboManagementHtml(view) {
    const active=view.entryGroups.find(group=>group.id===view.comboGroupId);if(!active)return '';
    const entries=comboOrderedEntries(view),enabled=entries.filter(entry=>entry.enabled!==false).length;
    const status=!entries.length?'0 条':enabled===0?'全部停用':enabled===entries.length?'全部启用':'部分启用';
    return '<div class="qa-combo-management"><div class="qa-combo-management-summary"><span><span class="qa-combo-management-name" title="'+escapeHtml(active.name)+'">'+escapeHtml(active.name)+'</span><small> · '+entries.length+' 条</small></span><span>'+status+'</span></div><div class="qa-combo-management-actions"><button data-action="entry-group-enabled" data-group-id="'+escapeHtml(active.id)+'" data-enabled="true">启用</button><button data-action="entry-group-enabled" data-group-id="'+escapeHtml(active.id)+'" data-enabled="false">停用</button><button data-action="entry-group-rename-open" data-group-id="'+escapeHtml(active.id)+'">重命名</button><button class="danger" data-action="entry-group-delete" data-group-id="'+escapeHtml(active.id)+'">解散</button></div></div>';
  }

  function templateHtml() {
    return `<div id="iwb-qa-root"><style>${STYLES}${MOBILE_DESIGN_STYLES}${MOBILE_CARD_STYLES}${MOBILE_WORKBENCH_STYLES}${COMBO_WORKSPACE_STYLES}${BODY_SEARCH_STYLES}${MOBILE_POLISH_STYLES}${COMBO_NAV_STYLES}${MOBILE_WORKBENCH_COMPONENT_STYLES}</style><div class="qa-shell">
      <header class="qa-head">
        <section class="qa-search-head" data-slot="search-head"></section><section class="qa-combo-head" data-slot="combo-head"></section><div class="qa-title-row"><div class="qa-title"><h2>世界书观测台</h2></div><button class="qa-icon qa-search-toggle" data-action="mobile-search-toggle" aria-label="搜索条目" title="搜索条目"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></button><button class="qa-icon" data-action="theme-open" aria-label="选择界面主题" title="界面主题"><i class="fa-solid fa-palette" aria-hidden="true"></i></button><button class="qa-icon" data-action="guide-open" aria-label="打开新手指引" title="新手指引"><i class="fa-solid fa-question" aria-hidden="true"></i></button><button class="qa-icon qa-mobile-close" data-action="close" aria-label="关闭世界书观测台">×</button></div>
        <div class="qa-mode-segments" role="group" aria-label="当前操作模式"><button class="qa-mode-segment is-active" data-action="mode" data-mode="edit">编辑模式</button><button class="qa-mode-segment" data-action="mode" data-mode="move">移动模式</button></div>
        <div class="qa-top-grid"><div class="qa-book-picker qa-top-left" data-control="book"><button class="qa-book-picker-trigger" data-action="book-picker-toggle" type="button" aria-haspopup="listbox" aria-expanded="false"><span data-slot="book-picker-label">选择一本具体世界书</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button><section class="qa-book-picker-popover" data-slot="book-picker-popover" hidden><input class="qa-input qa-book-picker-search" data-control="book-picker-search" type="search" placeholder="搜索世界书名称……" aria-label="搜索世界书名称"><div class="qa-book-picker-results" data-slot="book-picker-results" role="listbox" aria-label="世界书列表"></div></section></div><button class="qa-btn qa-top-right" data-action="new-entry">新建条目</button><button class="qa-btn qa-mobile-only qa-mobile-title-lock" data-action="title-lock" aria-pressed="true" aria-label="标题已锁定"><i class="fa-solid fa-lock" aria-hidden="true"></i></button><div class="qa-filter-pair qa-top-left"><input class="qa-input" data-control="search" type="search" placeholder="搜索"><select class="qa-select" data-control="state-filter-select" aria-label="显示范围"><option value="all">显示范围：全部</option><option value="selected">显示范围：仅已选</option><option value="changed">显示范围：仅已修改</option></select></div><button class="qa-btn qa-top-right" data-action="other-tools" aria-expanded="false">其它工具</button></div>
        <div class="qa-mobile-operation-row qa-mobile-only" role="group" aria-label="手机端操作栏"><button class="qa-btn qa-quick-combo" data-action="mobile-combos">快捷组合</button><button class="qa-btn" data-action="mobile-filter-toggle" aria-expanded="false">筛选</button><button class="qa-btn" data-action="mobile-arrange-toggle" aria-expanded="false">排列</button><button class="qa-btn" data-action="other-tools" aria-expanded="false">工具</button><div class="qa-mobile-density-toggle qa-mobile-only" role="group" aria-label="列表显示密度"><button data-action="card-density" data-density="compact">精简</button><span>/</span><button class="is-active" data-action="card-density" data-density="full">完整</button></div></div>

        <div class="qa-mobile-menu qa-mobile-only" data-slot="mobile-filter-menu" hidden><button class="qa-btn" data-action="mobile-filter-set" data-filter="all">全部</button><button class="qa-btn" data-action="mobile-filter-set" data-filter="selected">仅已选</button><button class="qa-btn" data-action="mobile-filter-set" data-filter="changed">仅已修改</button></div>
        <div class="qa-mobile-menu qa-mobile-only" data-slot="mobile-arrange-menu" hidden><button class="qa-btn" data-action="auto-arrange">按位置与顺序整理</button><button class="qa-btn" data-action="name-arrange">按名称整理</button><div class="qa-mobile-arrange-selection"><span>选中条目</span><button class="qa-btn" data-action="batch-move" data-direction="top">置顶</button><button class="qa-btn" data-action="batch-move" data-direction="bottom">置底</button></div><button class="qa-btn" data-action="arrange-settings">整理设置</button></div>
        <div class="qa-other-tools" data-slot="other-tools" hidden><button class="qa-btn" data-action="panel-import"><i class="fa-solid fa-file-import" aria-hidden="true"></i> 从其他书导入</button><button class="qa-btn" data-action="panel-transfer"><i class="fa-solid fa-arrow-right-arrow-left" aria-hidden="true"></i> 转移到其他书</button><div class="qa-arrange-quick" role="group" aria-label="一键整理排列"><button class="qa-btn" data-action="auto-arrange" title="按位置、深度与顺序整理">位置顺序</button><button class="qa-btn" data-action="name-arrange" title="忽略位置与顺序，仅按名称整理">名称</button></div><button class="qa-btn" data-action="arrange-settings">整理设置</button><button class="qa-btn" data-action="disable-recursion">禁止全部递归</button><button class="qa-btn" data-action="reload">重新读取当前书</button><button class="qa-btn" data-action="fault-report-copy">复制故障信息</button></div>
        <div class="qa-status" data-slot="status">正在读取世界书列表……</div>
      </header>
      <div class="qa-desktop-task-head" data-slot="desktop-task-head" hidden><strong data-slot="desktop-task-title">任务工作区</strong><div class="qa-desktop-task-direction" data-slot="desktop-task-direction"></div><button class="qa-btn qa-desktop-task-back" data-action="desktop-task-back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> 返回列表</button></div>
      <section class="qa-workspace-panel" data-slot="workspace-panel" hidden></section>
      <main class="qa-scroll" data-slot="scroll"><div class="qa-empty">请选择一本具体世界书开始编排。</div></main>
      <footer class="qa-footer" data-slot="footer"></footer>
    </div><section class="qa-content-layer" data-slot="content-editor" hidden aria-label="全屏编辑条目"><header class="qa-content-head"><button class="qa-btn" data-action="content-back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> 返回</button><div class="qa-content-context"><small><span data-slot="content-context">当前世界书 · UID</span> · Token <b data-slot="content-token">未计算</b></small></div><button class="qa-btn primary" data-action="content-done">完成</button></header><div class="qa-content-body"><div class="qa-content-paper"><section class="qa-content-paper-title" data-slot="content-title-draft"></section><section class="qa-content-paper-keys" data-slot="content-keys-draft"></section><textarea class="qa-content-textarea" data-control="content-full" aria-label="条目正文"></textarea></div></div></section>${themeHtml()}${guideHtml()}<section class="qa-leave-layer" data-slot="leave-modal" hidden aria-label="未保存修改提醒"></section></div>`;
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

  function coreEntryCardHtml(view, entry, changed, globalIndex) {
    if (!isDesktopLayout(view) && !view.moveMode) return mobileEntryCardHtml(view, entry, changed, globalIndex);
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

  function cardHtml(view, entry, changed, globalIndex) {
    const html = coreEntryCardHtml(view, entry, changed, globalIndex);
    const context = comboCardContextHtml(view, entry);
    return context ? html.replace('<section class="qa-editor"', () => context + '<section class="qa-editor"') : html;
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

  function comboWorkspaceHeaderHtml(view) {
    if (!isDesktopLayout(view)) return mobileComboHeaderHtml(view);
    const active = (view.entryGroups || []).find(group => group.id === view.comboGroupId);
    const tabs = [{ id: '__all__', name: '全部' }, { id: '__ungrouped__', name: '未分组' }, ...(view.entryGroups || [])];
    const navigation = tabs.map(group => '<button class="qa-combo-tab" data-action="combo-tab" data-group-id="' + escapeHtml(group.id) + '"' + (group.id.startsWith('__') ? '' : ' data-combo-drop-id="' + escapeHtml(group.id) + '"') + ' aria-current="' + (group.id === view.comboGroupId) + '">' + escapeHtml(group.name) + '</button>').join('');
    let controls = comboManagementHtml(view);
    return '<div class="qa-combo-titlebar"><button data-action="combo-back" aria-label="返回编辑视图">←</button><h2>快捷组合</h2><button class="qa-combo-title-lock" data-action="title-lock" aria-label="标题锁" aria-pressed="' + Boolean(view.titleLocked) + '"><i class="fa-solid fa-' + (view.titleLocked ? 'lock' : 'lock-open') + '"></i></button><button data-action="combo-new-open">＋ 新建组合</button><button data-action="theme-open" aria-label="界面主题"><i class="fa-solid fa-palette" aria-hidden="true"></i></button><button data-action="close" aria-label="关闭整个世界书观测台">×</button></div><div class="qa-combo-book">' + escapeHtml(view.book) + '' + '</div><nav class="qa-combo-tabs" aria-label="组合">' + navigation + '</nav>' + comboDensityHtml(view) + controls;
  }

  function comboCardContextHtml(view, entry) {
    if (!comboWorkspaceActive(view) || !view.expanded.has(entryId(entry))) return '';
    const id = entryId(entry), groups = view.entryGroups.filter(group => group.entryIds.includes(id)), active = view.entryGroups.find(group => group.id === view.comboGroupId);
    const chips = groups.map(group => '<span class="qa-combo-chip' + (group.id === view.comboGroupId ? ' current' : '') + '">' + escapeHtml(group.name) + '</span>').join('');
    let order = '';
    if (active) {
      const available = comboOrderedEntries(view).map(entryId), index = available.indexOf(id);
      order = '<div class="qa-combo-context-row"><span>组内顺序</span><span>第 ' + (index + 1) + ' / ' + available.length + ' 条</span><button data-action="combo-member-move" data-entry-id="' + escapeHtml(id) + '" data-direction="up"' + (index <= 0 ? ' disabled' : '') + '>上移</button><button data-action="combo-member-move" data-entry-id="' + escapeHtml(id) + '" data-direction="down"' + (index === available.length - 1 ? ' disabled' : '') + '>下移</button><button data-action="combo-member-remove" data-entry-id="' + escapeHtml(id) + '">移出本组</button></div>';
    }
    return '<div class="qa-combo-context"><div class="qa-combo-context-row"><span>所属组</span>' + chips + '<button data-action="combo-assignment-open" data-entry-id="' + escapeHtml(id) + '" aria-label="编辑所属组">＋</button></div>' + order + '</div>';
  }

  function comboAssignmentHtml(view) {
    const ids = view.comboAssignmentIds || [];
    const rows = view.entryGroups.map(group => {
      const count = ids.filter(id => group.entryIds.includes(id)).length, state = !count ? 'false' : count === ids.length ? 'true' : 'mixed';
      return '<button class="qa-combo-assignment-row" role="checkbox" aria-checked="' + state + '" data-action="combo-assignment-toggle" data-group-id="' + escapeHtml(group.id) + '"><span aria-hidden="true">' + (state === 'true' ? '✓' : state === 'mixed' ? '−' : '□') + '</span><span>' + escapeHtml(group.name) + '</span></button>';
    }).join('');
    return '<section class="qa-panel qa-combo-assignment"><h3>所属组</h3>' + rows + '<div><button class="qa-btn" data-action="combo-new-open">＋ 新建组合</button><button class="qa-btn" data-action="panel-close">完成</button></div></section>';
  }

  function footerHtml(view) {
    if (searchWorkspaceActive(view)) return searchSafetyFooterHtml(view);
    return mobileFooterHtml(view);
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

  function renderBookPickerResults(view) {
    const results = view.root.querySelector('[data-slot="book-picker-results"]');
    if (results) results.innerHTML = bookPickerResultsHtml(view);
  }

  function renderBookOptions(view) {
    const picker = view.root.querySelector('[data-control="book"]');
    const trigger = picker?.querySelector('[data-action="book-picker-toggle"]');
    const popover = picker?.querySelector('[data-slot="book-picker-popover"]');
    const search = picker?.querySelector('[data-control="book-picker-search"]');
    const label = picker?.querySelector('[data-slot="book-picker-label"]');
    if (!picker || !trigger || !popover) return;
    const lockedPanel = view.panel === 'arrange-settings' || view.panel === 'transfer' || view.panel === 'import';
    const disabled = Boolean(view.busy || lockedPanel);
    if (disabled) view.bookPickerOpen = false;
    trigger.disabled = disabled;
    trigger.setAttribute('aria-disabled', String(disabled));
    trigger.setAttribute('aria-expanded', String(Boolean(view.bookPickerOpen)));
    picker.classList.toggle('is-locked', disabled);
    picker.classList.toggle('qa-source-locked', view.panel === 'transfer' || view.panel === 'import');
    picker.title = view.panel === 'import' ? '请先退出从其他书导入' : view.panel === 'transfer' ? '请先退出跨书转移' : view.panel === 'arrange-settings' ? '请先保存或取消整理设置' : '';
    popover.hidden = !view.bookPickerOpen;
    if (label) { label.textContent = bookPickerTriggerLabel(view); label.title = label.textContent; }
    if (search && search.value !== (view.bookPickerQuery || '')) search.value = view.bookPickerQuery || '';
    const width = Number(view.root?.getBoundingClientRect?.().width || 0);
    if (view.bookPickerOpen && width > 0 && width <= 480) {
      const rect = trigger.getBoundingClientRect();
      const viewportHeight = Number(hostWindow().visualViewport?.height || hostWindow().innerHeight || 0);
      popover.style.top = Math.max(8, Math.round(rect.bottom + 5)) + 'px';
      popover.style.maxHeight = Math.max(160, Math.round(viewportHeight - rect.bottom - 15)) + 'px';
    } else {
      popover.style.removeProperty('top');
      popover.style.removeProperty('max-height');
    }
    renderBookPickerResults(view);
  }

  function renderStatus(view) {
    const node = view.root.querySelector('[data-slot="status"]');
    node.classList.remove('qa-status-redundant');
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
      node.classList.add('qa-status-redundant');
    }
  }

  function renderArrangeDraft(view, scrollTop = null) {
    const previous = scrollTop ?? Number(view.root?.querySelector?.('.qa-arrange-list')?.scrollTop || 0);
    renderDynamic(view, { list: true });
    const list = view.root?.querySelector?.('.qa-arrange-list');
    if (list) list.scrollTop = Math.min(previous, Math.max(0, list.scrollHeight - list.clientHeight));
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

  function renderList(view, preserveScroll = true) {
    if (searchWorkspaceActive(view)) { const scroll = view.root.querySelector('[data-slot="scroll"]'); scroll.innerHTML = searchWorkspaceResultHtml(view); if (!preserveScroll) scroll.scrollTop = 0; return; }
    const scroll = view.root.querySelector('[data-slot="scroll"]');
    const oldTop = preserveScroll ? scroll.scrollTop : 0;
    scroll.classList?.toggle('qa-import-mode', view.panel === 'import' || view.panel === 'transfer' || view.panel === 'arrange-settings');
    scroll.classList?.toggle('qa-group-mode-list', view.mobileMode === 'group');
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
    const context = comboWorkspaceActive(view) ? '' : view.mobileMode === 'group' ? groupModeBarHtml(view) : listContextHtml(view, entries);
    scroll.innerHTML = `${context}<div class="qa-list">${rendered.map(entry => cardHtml(view, entry, changed, globalIndex.get(entryId(entry)))).join('')}</div>${limit < entries.length ? `<button class="qa-more" data-action="more">继续显示（剩余 ${entries.length - limit} 条）</button>` : entries.length ? '' : '<div class="qa-empty">当前视图没有条目。</div>'}`;
    scroll.scrollTop = Math.min(oldTop, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
    scheduleTokenCounts(view, rendered);
  }

  function renderPanel(view) {
    if (view.panel === 'combo-assignment') return comboAssignmentHtml(view);
    if (view.panel === 'combo-new') return '<section class="qa-panel"><h3>新建组合</h3><input class="qa-input" data-control="entry-group-name" maxlength="60" placeholder="组合名称" value="' + escapeHtml(view.entryGroupNameDraft || '') + '"><button class="qa-btn" data-action="panel-close">取消</button><button class="qa-btn" data-action="combo-new-create">创建</button></section>';
    if (view.panel === 'entry-group-rename') return '<section class="qa-panel"><h3>重命名组合</h3><input class="qa-input" data-control="entry-group-name" maxlength="60" value="' + escapeHtml(view.entryGroupNameDraft || '') + '"><button class="qa-btn" data-action="panel-close">取消</button><button class="qa-btn" data-action="entry-group-rename">完成</button></section>';
    if (view.panel === 'batch') return mobileBatchPanelHtml(view);
    if (view.panel === 'entry-group-create') {
      return `<section class="qa-panel qa-entry-group-create-panel"><input class="qa-input" data-control="entry-group-name" maxlength="60" placeholder="组合名称" value="${escapeHtml(view.entryGroupNameDraft || '')}"><div><button class="qa-btn" data-action="entry-group-create-cancel">取消</button><button class="qa-btn primary" data-action="entry-group-save">保存组合</button></div></section>`;
    }
    if (view.panel === 'entry-groups') {
      const rows = (view.entryGroups || []).map(group => {
        const membership = entryGroupMembership(view.working, group);
        const stale = membership.missingCount ? ` · 缺少 ${membership.missingCount} 条` : '';
        return `<article class="qa-entry-group" data-group-id="${escapeHtml(group.id)}"><div class="qa-entry-group-summary"><strong title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</strong><small>${membership.existingIds.length} 条${stale}</small></div><div class="qa-entry-group-actions"><button class="qa-btn" data-action="entry-group-select" data-group-id="${escapeHtml(group.id)}">选中</button><button class="qa-btn" data-action="entry-group-enabled" data-enabled="true" data-group-id="${escapeHtml(group.id)}">启用</button><button class="qa-btn" data-action="entry-group-enabled" data-enabled="false" data-group-id="${escapeHtml(group.id)}">停用</button><button class="qa-btn" data-action="entry-group-rename-open" data-group-id="${escapeHtml(group.id)}">改名</button><button class="qa-btn danger" data-action="entry-group-delete" data-group-id="${escapeHtml(group.id)}">删除</button></div></article>`;
      }).join('');
      return `<section class="qa-panel qa-entry-groups-panel"><div class="qa-entry-groups-head"><div><h3>快捷组合</h3><div class="qa-panel-note">组合只保存在本机；启用／停用先修改工作副本，点击“保存全部”后生效。</div></div><button class="qa-btn" data-action="panel-close">返回列表</button></div><div class="qa-entry-group-create"><input class="qa-input" data-control="entry-group-name" maxlength="60" placeholder="组合名称，例如：NSFW 常用" value="${escapeHtml(view.entryGroupNameDraft || '')}"><button class="qa-btn primary" data-action="entry-group-save">存为组合（${view.selected.size}）</button></div><div class="qa-entry-group-list">${rows || '<div class="qa-empty">这本世界书还没有快捷组合。先返回列表选择条目，再保存为组合。</div>'}</div></section>`;
    }

    if (view.panel === 'import') return '';
    if (view.panel === 'arrange-settings') {
      const rows = view.arrangeDraft.map((track, index) => `<div class="qa-arrange-row${view.arrangeFlashIndex === index ? ' is-flash-moved' : ''}" data-arrange-index="${index}"><button type="button" class="qa-arrange-drag-handle" draggable="true" data-action="arrange-drag" data-index="${index}" aria-label="拖动轨道：${escapeHtml(track.label)}" title="拖动重排轨道">☰</button><div class="qa-arrange-label"><span>${escapeHtml(track.label)} · ${track.count} 条${track.isNew ? ' · 新增' : ''}</span></div><select class="qa-select" data-control="arrange-direction" data-index="${index}"><option value="asc"${track.direction === 'asc' ? ' selected' : ''}>从小到大</option><option value="desc"${track.direction === 'desc' ? ' selected' : ''}>从大到小</option></select><div class="qa-arrange-arrows"><button class="qa-btn" data-action="arrange-group-up" data-index="${index}" ${index === 0 ? 'disabled' : ''}>↑</button><button class="qa-btn" data-action="arrange-group-down" data-index="${index}" ${index === view.arrangeDraft.length - 1 ? 'disabled' : ''}>↓</button></div></div>`).join('');
      const scope = view.mixedMode ? '总览' : '本书';
      return `<section class="qa-panel qa-arrange-settings-panel">${nameArrangeSettingsHtml(view)}<div class="qa-arrange-list"${view.nameArrangeDraft?.mode === 'name' ? ' hidden' : ''}>${rows || `<div class="qa-empty">${scope}没有可整理条目。</div>`}</div><div class="qa-footer-row"><button class="qa-btn qa-arrange-reset" data-action="reset-arrange-settings" ${arrangeDraftChanged(view) ? '' : 'disabled aria-disabled="true"'}>还原</button><button class="qa-btn" data-action="save-arrange-settings">仅保存设置</button><button class="qa-btn primary" data-action="save-and-arrange">保存并整理</button><button class="qa-btn qa-arrange-return" data-action="panel-close">返回列表</button></div></section>`;
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

  function renderWorkspacePanel(view) {
    const panel = view.root.querySelector('[data-slot="workspace-panel"]');
    if (!panel) return;
    if (view.panel === 'import' || view.panel === 'transfer' || view.panel === 'arrange-settings') { panel.innerHTML = ''; panel.hidden = true; return; }
    const html = renderPanel(view);
    const namingDialog = !isDesktopLayout(view) && view.panel === 'entry-group-create';
    panel.classList.toggle('qa-group-name-dialog', namingDialog);
    if (namingDialog) { panel.setAttribute?.('role', 'dialog'); panel.setAttribute?.('aria-modal', 'true'); panel.setAttribute?.('aria-label', '存为组合'); } else { panel.removeAttribute?.('role'); panel.removeAttribute?.('aria-modal'); panel.removeAttribute?.('aria-label'); }
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

  function renderDynamic(view, { list = false, resetScroll = false } = {}) {
    view.root.classList.toggle('qa-search-workspace', searchWorkspaceActive(view));
    const searchHead = view.root.querySelector('[data-slot="search-head"]');
    if (searchHead) searchHead.innerHTML = searchWorkspaceActive(view) ? searchWorkspaceHeaderHtml(view) : '';
    const phone = !isDesktopLayout(view);
    if (phone || isWideDesktopLayout(view)) view.moveMode = false;
    if (comboWorkspaceActive(view) && !['__all__', '__ungrouped__'].includes(view.comboGroupId) && !view.entryGroups.some(group => group.id === view.comboGroupId)) view.comboGroupId = '__all__';
    view.root.classList.toggle('qa-combo-workspace', comboWorkspaceActive(view));
    captureComboNavScroll(view);
    const comboHead = view.root.querySelector('[data-slot="combo-head"]');
    if (comboHead) comboHead.innerHTML = comboWorkspaceActive(view) ? comboWorkspaceHeaderHtml(view) : '';
    restoreComboNavScroll(view,Boolean(view.comboNavEnsureActive)); view.comboNavEnsureActive=false;
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
    const groupActive = view.mobileMode === 'group';
    view.root.classList.toggle('qa-import-active', importActive || transferActive);
    view.root.classList.toggle('qa-transfer-active', transferActive);
    view.root.classList.toggle('qa-arrange-active', arrangeActive);
    view.root.classList.toggle('qa-group-mode', groupActive);
    view.root.classList.toggle('qa-group-member-editing', groupActive && Boolean(view.entryGroupEditingId));
    const desktopTaskActive = importActive || transferActive || arrangeActive;
    view.root.classList.toggle('qa-desktop-task-active', desktopTaskActive);
    view.root.classList.toggle('qa-move-mode', view.moveMode);
    view.root.classList.toggle('qa-mobile-search-open', Boolean(view.searchOpen));
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
    const mobileMode = view.root.querySelector('[data-action="mobile-mode-menu-toggle"]');
    if (mobileMode) { mobileMode.textContent = view.mobileMode === 'group' ? '组合中' : view.moveMode ? '移动中' : '编辑中'; mobileMode.classList.toggle('is-active', view.mobileMode !== 'edit'); mobileMode.setAttribute('aria-expanded', String(view.mobileMenu === 'mode')); }
    const modeMenu = view.root.querySelector('[data-slot="mobile-mode-menu"]');
    if (modeMenu) { modeMenu.hidden = view.mobileMenu !== 'mode' || desktopTaskActive; modeMenu.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('is-active', button.dataset.mode === view.mobileMode)); }
    const mobileFilter = view.root.querySelector('[data-action="mobile-filter-toggle"]');
    if (mobileFilter) { mobileFilter.classList.toggle('is-active', view.stateFilter !== 'all' || view.mobileMenu === 'filter'); mobileFilter.setAttribute('aria-expanded', String(view.mobileMenu === 'filter')); }
    const mobileArrange = view.root.querySelector('[data-action="mobile-arrange-toggle"]');
    if (mobileArrange) { mobileArrange.classList.toggle('is-active', view.mobileMenu === 'arrange'); mobileArrange.setAttribute('aria-expanded', String(view.mobileMenu === 'arrange')); }
    const mobileSearch = view.root.querySelector('[data-action="mobile-search-toggle"]');
    if (mobileSearch) { mobileSearch.classList.toggle('is-active', Boolean(view.searchOpen)); mobileSearch.setAttribute('aria-expanded', String(Boolean(view.searchOpen))); }
    const filterMenu = view.root.querySelector('[data-slot="mobile-filter-menu"]');
    if (filterMenu) { filterMenu.hidden = view.mobileMenu !== 'filter' || desktopTaskActive; filterMenu.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('is-active', button.dataset.filter === view.stateFilter)); }
    const arrangeMenu = view.root.querySelector('[data-slot="mobile-arrange-menu"]');
    if (arrangeMenu) arrangeMenu.hidden = view.mobileMenu !== 'arrange' || desktopTaskActive;
    const tools = view.root.querySelector('[data-slot="other-tools"]');
    if (tools) tools.hidden = importActive || transferActive || arrangeActive || !view.toolsOpen;
    view.root.querySelectorAll('[data-action="other-tools"]').forEach(button => { button.setAttribute('aria-expanded', String(view.toolsOpen)); button.classList.toggle('is-active', view.toolsOpen); });
    const stateSelect = view.root.querySelector('[data-control="state-filter-select"]');
    if (stateSelect) stateSelect.value = view.stateFilter;
    const titleLocks = view.root.querySelectorAll('[data-action="title-lock"]');
    const titleLock = view.root.querySelector('[data-action="title-lock"]');
    titleLocks.forEach(button => { button.setAttribute('aria-pressed',String(view.titleLocked)); button.setAttribute('aria-label',view.titleLocked ? '标题已锁定' : '标题可编辑'); button.innerHTML='<i class="fa-solid fa-'+(view.titleLocked ? 'lock' : 'lock-open')+'"></i>'; });
    if (titleLock) {
      titleLock.textContent = view.titleLocked ? '🔒标题' : '🔓标题';
      titleLock.setAttribute('aria-pressed', String(view.titleLocked));
      titleLock.classList.toggle('is-active', view.titleLocked);
    }
    if (phone) {
      if (topAction && !view.mixedMode) topAction.textContent = '＋ 新建条目';
      if (titleLock) { titleLock.innerHTML = '<i class="fa-solid fa-' + (view.titleLocked ? 'lock' : 'lock-open') + '" aria-hidden="true"></i>'; titleLock.setAttribute('aria-label', view.titleLocked ? '标题已锁定' : '标题可编辑'); }
      const combo = view.root.querySelector('[data-action="mobile-combos"]');
      if (combo) { combo.disabled = view.mixedMode || !view.book; combo.classList.toggle('is-active', comboWorkspaceActive(view)); combo.textContent = groupActive ? '返回编辑' : '快捷组合'; }
      const recursion = view.root.querySelector('[data-action="disable-recursion"]');
      if (recursion) { recursion.hidden = view.mixedMode; recursion.textContent = '禁止当前书全部递归'; }
    }
    syncWideDesktopWorkbench(view);
    if (list) renderList(view, !resetScroll);
    renderFooter(view);
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

  function openSearchWorkspace(view) {
    if (searchWorkspaceActive(view)) return;
    clearTimeout(view.searchTimer);
    view.searchReturnContext = {workspace: view.workspace || 'edit', panel: view.panel, query: view.query, stateFilter: view.stateFilter, positionFilter: view.positionFilter, comboGroupId: view.comboGroupId, scrollTop: view.root.querySelector('[data-slot="scroll"]')?.scrollTop || 0};
    view.workspace = 'search'; view.panel = null; view.searchOpen = false; view.mobileMenu = null; view.toolsOpen = false;
    view.searchKind = view.searchKind || 'metadata'; view.searchFind = view.searchFind ?? view.query ?? ''; view.searchReplace = view.searchReplace ?? '';
    renderDynamic(view, {list: true, resetScroll: true});
  }

  function closeSearchWorkspace(view) {
    clearTimeout(view.bodySearchTimer);
    const context = view.searchReturnContext || {workspace: 'edit'}; Object.assign(view, context); view.searchOpen = false;
    renderDynamic(view, {list: true}); const scroll = view.root.querySelector('[data-slot="scroll"]'); if (scroll) scroll.scrollTop = context.scrollTop || 0;
  }

  function updateBodySearchInput(view, control, value) {
    if (control === 'body-search-replace') view.searchReplace = value;
    else view.searchFind = value;
    clearTimeout(view.bodySearchTimer);
    view.bodySearchTimer = mobileUiTimeout(view, 'bodySearchTimer', () => {
      if (!searchWorkspaceActive(view)) return;
      const scroll = view.root.querySelector('[data-slot="scroll"]'); if (scroll) scroll.innerHTML = searchWorkspaceResultHtml(view);
      const button = view.root.querySelector('[data-action="body-replace-results"]');
      if (button) { const count = searchWorkspaceResults(view).reduce((sum,result) => sum + result.count, 0); button.textContent = '替换匹配结果（' + count + ' 处）'; button.disabled = !count || Boolean(view.busy); }
    },180);
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

  function toggleSourcePreview(view, kind, id) {
    const draft = kind === 'import' ? view.importDraft : view.transferDraft;
    if (!draft?.previewed || !id) return false;
    draft.previewed.has(id) ? draft.previewed.delete(id) : draft.previewed.add(id);
    if (kind === 'import') renderImportSelection(view, true);
    else renderTransferSelection(view, true);
    return true;
  }

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

  function scheduleTokenCounts(view, entries) {
    if (view.closed) return;
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
          if (view.closed) return;
          view.tokenCounts.set(entryId(entry), { content, value: Number.isFinite(Number(value)) ? Number(value) : null });
        } catch (_error) {
          if (view.closed) return;
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

  function syncFooterState(view) {
    if (!isDesktopLayout(view)) { renderFooter(view); return; }
    const footer = view.root.querySelector('[data-slot="footer"]');
    const summary = pendingSummary(view);
    const count = footer?.querySelector('[data-slot="desktop-change-count"]');
    if (count) count.textContent = summary.text;
    const mobileCount = footer?.querySelector('[data-slot="mobile-selection-count"]');
    if (mobileCount) mobileCount.textContent = `${view.selected.size}/${view.working?.length || 0}`;
    const mobileSummary = footer?.querySelector('[data-slot="mobile-change-summary"]');
    if (mobileSummary) mobileSummary.textContent = mobilePendingSummary(view, summary);
    const undo = footer?.querySelector('[data-action="undo"]');
    const discard = footer?.querySelector('[data-action="discard"]');
    const save = footer?.querySelector('[data-action="save"]');
    if (undo) undo.disabled = !view.undo.length || Boolean(view.busy);
    if (discard) discard.disabled = !isDirty(view) || Boolean(view.busy);
    if (save) save.disabled = !isDirty(view) || Boolean(view.busy);
  }

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

  function optionHtml(value, label, selected) {
    return `<option value="${escapeHtml(value)}"${selected === value ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }

  function mobilePendingSummary(view, summary = pendingSummary(view)) {
    if (view?.mixedMode || view?.transferStates?.size) return summary.text;
    const parts = [];
    if (summary.fieldCount) parts.push('字段 ' + summary.fieldCount + ' 条');
    if (summary.arrangement) parts.push('排列 1 项');
    return parts.length ? parts.join(' · ') : '无未保存修改';
  }

  function applyTheme(view, theme, persist = true) {
    const next = THEME_IDS.includes(theme) ? theme : DEFAULT_THEME;
    view.theme = next;
    view.root.dataset.theme = next;
    if (view.popupDialog) view.popupDialog.dataset.iwbQaTheme = next;
    if (persist) saveThemePreference(next);
  }

  function openThemePicker(view) {
    const layer = view.root.querySelector('[data-slot="theme-picker"]');
    if (!layer) return;
    view.themeReturnFocus = hostDocument().activeElement;
    view.themePickerOpen = true;
    layer.hidden = false;
    layer.querySelector(`[data-theme-choice="${cssEscape(view.theme)}"]`)?.focus();
  }

  function closeThemePicker(view) {
    if (!view.themePickerOpen) return;
    const layer = view.root.querySelector('[data-slot="theme-picker"]');
    if (layer) layer.hidden = true;
    view.themePickerOpen = false;
    view.themeReturnFocus?.focus?.();
    view.themeReturnFocus = null;
  }

  function captureComboNavScroll(view) {
    const node=view.root.querySelector('[data-slot="combo-user-tabs"]');
    if(node && !node.closest?.('.qa-combo-navigation')?.classList?.contains?.('is-expanded'))view.comboNavScrollLeft=Number(node.scrollLeft||0);
  }

  function restoreComboNavScroll(view,ensureActive=false) {
    const node=view.root.querySelector('[data-slot="combo-user-tabs"]');if(!node || view.comboNavExpanded)return;
    node.scrollLeft=Number(view.comboNavScrollLeft||0);
    if(ensureActive){const active=Array.from(node.querySelectorAll?.('[data-group-id]')||[]).find(tab=>tab.dataset.groupId===view.comboGroupId);if(active){const rect=active.getBoundingClientRect?.(),area=node.getBoundingClientRect?.();if(rect&&area){if(rect.left<area.left)node.scrollLeft-=area.left-rect.left;else if(rect.right>area.right)node.scrollLeft+=rect.right-area.right;}}}
    view.comboNavScrollLeft=Number(node.scrollLeft||0);
  }

  function startComboNavDrag(view,event,handle) {
    if(!comboWorkspaceActive(view) || !view.comboNavArrange || view.busy || event.button>0)return false;
    const id=handle.dataset.groupId;if(!view.entryGroups.some(group=>group.id===id))return false;
    view.comboNavDrag={id,pointerId:event.pointerId,anchorId:null,after:false};
    handle.closest?.('.qa-combo-user-tab')?.classList.add('is-nav-drag-source');handle.setPointerCapture?.(event.pointerId);event.preventDefault();return true;
  }

  function moveComboNavDrag(view,event) {
    const drag=view.comboNavDrag;if(!drag || drag.pointerId!==event.pointerId)return;
    view.root.querySelectorAll('.is-nav-drop-before,.is-nav-drop-after').forEach(node=>node.classList.remove('is-nav-drop-before','is-nav-drop-after'));
    const target=view.root.ownerDocument.elementFromPoint(event.clientX,event.clientY)?.closest?.('.qa-combo-user-tab');
    drag.anchorId=null;if(!target || target.dataset.groupId===drag.id)return;
    const rect=target.getBoundingClientRect();drag.anchorId=target.dataset.groupId;drag.after=event.clientX>=rect.left+rect.width/2;target.classList.add(drag.after?'is-nav-drop-after':'is-nav-drop-before');event.preventDefault();
  }

  function endComboNavDrag(view,event,cancelled=false) {
    const drag=view.comboNavDrag;if(!drag || drag.pointerId!==event.pointerId)return false;
    view.comboNavDrag=null;view.root.querySelectorAll('.is-nav-drag-source,.is-nav-drop-before,.is-nav-drop-after').forEach(node=>node.classList.remove('is-nav-drag-source','is-nav-drop-before','is-nav-drop-after'));
    const changed=!cancelled && drag.anchorId && reorderComboGroups(view,drag.id,drag.anchorId,drag.after);
    view.comboNavExpanded=true;renderDynamic(view);return Boolean(changed);
  }

  function closeBookPicker(view, restoreFocus = false) {
    if (!view.bookPickerOpen) return false;
    view.bookPickerOpen = false;
    view.bookPickerQuery = '';
    renderBookOptions(view);
    if (restoreFocus) view.root.querySelector('[data-action="book-picker-toggle"]')?.focus?.({ preventScroll: true });
    return true;
  }

  function toggleBookPicker(view) {
    if (view.busy || view.panel === 'arrange-settings' || view.panel === 'transfer' || view.panel === 'import') return false;
    view.bookPickerOpen = !view.bookPickerOpen;
    view.bookPickerQuery = '';
    renderBookOptions(view);
    return true;
  }

  function requestBookSwitch(view, requested) {
    closeBookPicker(view, false);
    if (!requested || requested === view.book) return false;
    if (!showLeavePrompt(view, { kind: 'switch', book: requested })) loadBook(view, requested);
    return true;
  }

  function refreshInlineFields(view, cardId) {
    const entry = view.working.find(candidate => entryId(candidate) === cardId);
    const region = view.root.querySelector(`[data-entry-id="${cssEscape(cardId)}"] .qa-inline-fields`);
    if (entry && region) region.innerHTML = region.closest('.qa-mobile-card') ? mobileCardFieldsHtml(entry) : inlineFieldsHtml(entry);
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

  function canEditTitle(view) {
    return !view.moveMode && (isDesktopLayout(view) || !view.titleLocked);
  }

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

  function commitCardContentInput(view, input) {
    const id = input.closest('.qa-card')?.dataset.entryId;
    if (!id) return false;
    const previousUndo = view.undo.slice();
    const coalesce = view.cardContentUndo === previousUndo.at(-1) && view.cardContentInput === input;
    const changed = applyWorkingQuiet(view, '编辑条目正文', () => mutateEntry(view.working, id, entry => { entry.content = String(input.value); }), id);
    if (!changed) return false;
    if (coalesce) view.undo = previousUndo;
    view.cardContentUndo = view.undo.at(-1);
    view.cardContentInput = input;
    const entry = view.working.find(candidate => entryId(candidate) === id);
    if (entry) scheduleTokenCounts(view, [entry]);
    return true;
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

  function syncArrangeResetButton(view) {
    const button = view.root?.querySelector?.('[data-action="reset-arrange-settings"]');
    if (!button) return;
    button.disabled = !arrangeDraftChanged(view);
    button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
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

  function orderPreview(view) {
    const count = view.selected.size;
    const start = Number(view.orderDraft.start);
    const gap = view.orderDraft.mode === 'same' ? 0 : Number(view.orderDraft.gap);
    if (!Number.isFinite(start) || !Number.isFinite(gap) || !count) return '请填写有效数字并选择条目';
    if (view.orderDraft.mode === 'same') return `${count} 条都设为 ${start}`;
    return `${start} → ${start + gap * Math.max(0, count - 1)}（${count} 条，间隔 ${gap}）`;
  }

  function openComboWorkspace(view) {
    if (view.mixedMode || !view.book) throw new Error('快捷组合仅用于一本具体世界书。');
    view.comboEditContext = { query: view.query, stateFilter: view.stateFilter, positionFilter: view.positionFilter, scrollTop: view.root.querySelector('[data-slot="scroll"]')?.scrollTop || 0 };
    view.workspace = 'combos'; view.comboGroupId = '__all__'; view.comboMore = false;
    view.query = ''; view.stateFilter = 'all'; view.positionFilter = 'all';
    view.mobileMode = 'edit'; view.moveMode = false; view.panel = null; view.mobileMenu = null; view.toolsOpen = false;
    view.entryGroupEditingId = null; renderDynamic(view, { list: true, resetScroll: true });
  }

  function closeComboWorkspace(view) {
    view.workspace = 'edit'; view.panel = null; view.comboMore = false;
    if (view.comboEditContext) Object.assign(view, { query: view.comboEditContext.query, stateFilter: view.comboEditContext.stateFilter, positionFilter: view.comboEditContext.positionFilter });
    renderDynamic(view, { list: true });
    const scroll = view.root.querySelector('[data-slot="scroll"]'); if (scroll) scroll.scrollTop = view.comboEditContext?.scrollTop || 0;
  }

  function openMobileCombos(view) { openComboWorkspace(view); }

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
    if (view.closed || !editor) return;
    const node = view.root.querySelector('[data-slot="content-token"]');
    const counter = getTokenCounter();
    if (!counter) { if (node) node.textContent = '未计算'; return; }
    const generation = ++editor.tokenGeneration;
    if (node) node.textContent = '计算中…';
    try {
      const value = await counter(editor.draft);
      if (view.closed || view.contentEditor !== editor || editor.tokenGeneration !== generation) return;
      if (node) node.textContent = Number.isFinite(Number(value)) ? String(Number(value)) : '未计算';
    } catch (_error) {
      if (!view.closed && view.contentEditor === editor && editor.tokenGeneration === generation && node) node.textContent = '未计算';
    }
  }

  function scheduleContentEditorToken(view) {
    clearTimeout(view.contentTokenTimer);
    view.contentTokenTimer = setTimeout(() => { void updateContentEditorToken(view); }, 180);
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

  function syncTopControls(view) {
    const search = view.root.querySelector('[data-control="search"]');
    if (search) search.value = view.query || '';
    const state = view.root.querySelector('[data-control="state-filter-select"]');
    if (state) state.value = view.stateFilter || 'all';
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
      view.entryGroups = cloneJson(view.entryGroupBaseline || []);
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
    if(comboWorkspaceActive(view) && view.comboNavArrange){view.drag.anchorId=null;view.drag.comboDropId=null;return;}
    const doc = view.root.ownerDocument;
    const hit = doc.elementFromPoint(clientX, clientY);
    if (comboWorkspaceActive(view)) { view.drag.anchorId = null; view.drag.comboDropId = hit?.closest?.('[data-combo-drop-id]')?.dataset.comboDropId || null; if (view.drag.comboDropId) { view.drag.anchorId = null; return; } }
    const card = hit?.closest?.('.qa-card');
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
    if (view.closed || !drag || drag.autoScrollFrame != null || !drag.autoScrollSpeed) return;
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

  function startDrag(view, event, card) {
    if (view.busy || event.button > 0 || (comboWorkspaceActive(view) && view.comboNavArrange)) return;
    const cardId = card.dataset.entryId;
    view.drag = {
      pointerId: event.pointerId, ids: selectedIdsForCard(view, cardId), anchorId: null, after: false,
      clientX: event.clientX, clientY: event.clientY, autoScrollSpeed: 0, autoScrollFrame: null,
      autoScrollFrameType: null, autoScrollFrameWindow: null, autoScrollLastTime: null,
    };
    if (comboWorkspaceActive(view)) { const scope = new Set(comboOrderedEntries(view).map(entryId)); const chosen = new Set(view.drag.ids); view.drag.ids = comboOrderedEntries(view).map(entryId).filter(id => chosen.has(id) && scope.has(id)); }
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
    if (comboWorkspaceActive(view)) {
      if (!cancelled) { if (drag.comboDropId) addEntriesToGroup(view, drag.comboDropId, drag.ids); else if (drag.anchorId) reorderComboMembers(view, drag.ids, drag.anchorId, drag.after); renderDynamic(view, { list: true }); flashMovedEntries(view, drag.ids); }
      return;
    }
    if (!cancelled && drag.anchorId) {
      const changed = applyWorking(view, '拖动列表排列', () => { const next = dropEntries(view.working, drag.ids, drag.anchorId, drag.after); return view.mixedMode ? refreshMixedBookIndexes(next) : next; }, { noOpMessage: '拖动位置未改变。' });
      if (changed) {
        flashMovedEntries(view, drag.ids);
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

  async function handleAction(view, action, target) {
    view.cardContentInput = null; view.cardContentUndo = null;
    if (action === 'combo-nav-toggle') { captureComboNavScroll(view); view.comboNavExpanded=!view.comboNavExpanded; if(!view.comboNavExpanded)view.comboNavArrange=false; renderDynamic(view); return; }
    if (action === 'combo-nav-arrange') { view.comboNavArrange=!view.comboNavArrange; view.comboNavExpanded=true; renderDynamic(view); return; }
    if (action === 'combo-group-drag') return;
    if (action === 'search-back') { closeSearchWorkspace(view);
    } else if (action === 'search-kind') { view.searchKind = target.dataset.kind === 'body' ? 'body' : 'metadata'; renderDynamic(view, {list: true, resetScroll: true});
    } else if (action === 'body-replace-results') { replaceBodySearchResults(view);
    } else if (action === 'combo-back') {
      closeComboWorkspace(view);
    } else if (action === 'combo-tab') {
      if(view.comboNavArrange)return;
      view.comboNavExpanded=false;view.comboNavEnsureActive=true;
      view.comboGroupId = target.dataset.groupId; view.comboMore = false; view.panel = null; view.selected.clear(); renderDynamic(view, { list: true, resetScroll: true });
    } else if (action === 'combo-more') {
      view.comboMore = !view.comboMore; renderDynamic(view);
    } else if (action === 'combo-new-open') {
      view.entryGroupNameDraft = ''; view.panel = 'combo-new'; renderFooter(view);
    } else if (action === 'combo-new-create') {
      const result = upsertEntryGroup(view.entryGroups, view.entryGroupNameDraft, []);
      applyGroupRelations(view, '新建空组合', result.groups); toastComboCreated(result.group.name); view.comboNavExpanded=false; view.comboNavArrange=false; view.comboNavEnsureActive=true; view.panel = null; view.comboGroupId = result.group.id; view.selected.clear(); renderDynamic(view, { list: true });
    } else if (action === 'combo-assignment-open') {
      view.comboAssignmentIds = target.dataset.entryId ? [target.dataset.entryId] : comboSelectedIds(view); view.panel = 'combo-assignment'; renderFooter(view);
    } else if (action === 'combo-assignment-toggle') {
      const group = view.entryGroups.find(group => group.id === target.dataset.groupId), ids = view.comboAssignmentIds || [];
      if (group) addEntriesToGroup(view, group.id, ids, ids.length > 0 && ids.every(id => group.entryIds.includes(id))); renderDynamic(view, { list: true });
    } else if (action === 'combo-member-move') {
      moveComboMember(view, target.dataset.entryId, target.dataset.direction); renderDynamic(view, { list: true });
    } else if (action === 'combo-member-remove') {
      addEntriesToGroup(view, view.comboGroupId, [target.dataset.entryId], true); renderDynamic(view, { list: true });
    } else if (action === 'entry-group-rename-open') {
      const group = view.entryGroups.find(group => group.id === target.dataset.groupId);
      if (!group) return; view.entryGroupRenameId = group.id; view.entryGroupNameDraft = group.name; view.panel = 'entry-group-rename'; renderFooter(view);
    } else if (action === 'entry-group-rename') {
      renameEntryGroup(view, view.entryGroupRenameId, view.entryGroupNameDraft); view.panel = null; view.entryGroupRenameId = null; view.entryGroupNameDraft = ''; renderDynamic(view, { list: true });
    } else if (action === 'mobile-combos') {
      openMobileCombos(view);
    } else if (action === 'card-density') {
      view.cardDensity = target.dataset.density === 'compact' ? 'compact' : 'full';
      view.root.querySelectorAll('[data-action="card-density"]').forEach(button => button.classList.toggle('is-active', button.dataset.density === view.cardDensity));
      renderList(view, true);
    } else if (action === 'close') {
      if (!showLeavePrompt(view, { kind: 'close' })) { view.forceClose = true; await view.popup.completeCancelled(); }

    } else if (action === 'book-picker-toggle') {
      toggleBookPicker(view);
    } else if (action === 'book-picker-select') {
      requestBookSwitch(view, target.dataset.bookValue || '');
    } else if (action === 'mode') {
      view.moveMode = target.dataset.mode === 'move';
      renderDynamic(view, { list: true });
    } else if (action === 'mobile-mode-menu-toggle') {
      if (!isDesktopLayout(view)) return;
      view.mobileMenu = view.mobileMenu === 'mode' ? null : 'mode';
      view.toolsOpen = false;
      renderDynamic(view);
    } else if (action === 'mobile-mode-set') {
      if (!isDesktopLayout(view)) return;
      const mode = ['move', 'group'].includes(target.dataset.mode) ? target.dataset.mode : 'edit';
      if (mode === 'group' && (view.mixedMode || !view.book)) throw new Error('组合模式只能用于一本具体世界书。');
      view.mobileMode = mode;
      view.moveMode = mode === 'move';
      view.mobileMenu = null;
      view.toolsOpen = false;
      view.panel = null;
      view.entryGroupEditingId = null;
      view.selected.clear();
      renderDynamic(view, { list: true, resetScroll: true });
    } else if (action === 'mobile-search-toggle') {
      openSearchWorkspace(view); target.blur?.();
    } else if (action === 'mobile-filter-toggle') {
      view.mobileMenu = view.mobileMenu === 'filter' ? null : 'filter';
      view.toolsOpen = false;
      renderDynamic(view);
    } else if (action === 'mobile-arrange-toggle') {
      view.mobileMenu = view.mobileMenu === 'arrange' ? null : 'arrange';
      view.toolsOpen = false;
      renderDynamic(view);
    } else if (action === 'mobile-filter-set') {
      view.stateFilter = ['selected', 'changed'].includes(target.dataset.filter) ? target.dataset.filter : 'all';
      view.mobileMenu = null;
      view.renderLimit = APP.chunkSize;
      renderDynamic(view, { list: true, resetScroll: true });
    } else if (action === 'title-lock') {
      view.titleLocked = !view.titleLocked;
      renderDynamic(view, { list: true });
    } else if (action === 'other-tools') {
      view.toolsOpen = !view.toolsOpen;
      view.mobileMenu = null;
      renderDynamic(view);
    } else if (action === 'theme-open') {
      openThemePicker(view);
    } else if (action === 'theme-close') {
      closeThemePicker(view);
    } else if (action === 'theme-select') {
      const nextTheme = target.dataset.themeChoice;
      applyTheme(view, nextTheme, true);
      closeThemePicker(view);
      toast('success', nextTheme === 'wisteria-moon' ? '已切换为藤月烟粉。' : '已切换为雾墨青蓝。');
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
    } else if (action === 'mobile-group-exit') {
      view.mobileMode = 'edit';
      view.moveMode = false;
      view.entryGroupEditingId = null;
      view.selected.clear();
      renderDynamic(view, { list: true, resetScroll: true });
    } else if (action === 'entry-group-view') {
      view.activeEntryGroupId = target.dataset.groupId || '__ungrouped__';
      view.entryGroupEditingId = null;
      view.selected.clear();
      renderDynamic(view, { list: true, resetScroll: true });
    } else if (action === 'entry-group-create-open') {
      if (view.mixedMode || !view.book || !view.selected.size) throw new Error('请先选择要保存为组合的条目。');
      view.entryGroupNameDraft = '';
      view.panel = 'entry-group-create';
      renderFooter(view);
      mobileUiFrame(view, () => view.root.querySelector('[data-control="entry-group-name"]')?.focus?.({ preventScroll: true }));
    } else if (action === 'entry-group-create-cancel') {
      view.panel = null;
      view.entryGroupNameDraft = '';
      renderFooter(view);
    } else if (action === 'entry-group-edit-members') {
      const result = selectEntryGroup(view, target.dataset.groupId);
      view.entryGroupEditingId = result.group.id;
      view.activeEntryGroupId = result.group.id;
      renderDynamic(view, { list: true, resetScroll: true });
    } else if (action === 'entry-group-edit-cancel') {
      view.entryGroupEditingId = null;
      view.selected.clear();
      renderDynamic(view, { list: true });
    } else if (action === 'entry-group-edit-save') {
      const result = saveEditedEntryGroup(view);
      renderDynamic(view, { list: true });
      toast('success', `已更新“${result.group.name}”的成员。`);
    } else if (action === 'entry-groups-open') {
      if (view.mixedMode || !view.book) throw new Error('快捷组合只能用于一本具体世界书。');
      openComboWorkspace(view);
    } else if (action === 'entry-group-save') {
      const result = createOrUpdateEntryGroup(view);
      const mobileCreating = view.panel === 'entry-group-create';
      if (mobileCreating) { view.panel = null; renderDynamic(view, { list: true }); }
      else renderFooter(view);
      if(result.updated)toast('success', `已更新组合“${result.group.name}”。`);else toastComboCreated(result.group.name);
    } else if (action === 'entry-group-select') {
      const result = selectEntryGroup(view, target.dataset.groupId);
      view.panel = null; renderDynamic(view, { list: true });
      toast('info', `已选中“${result.group.name}”的 ${result.existingIds.length} 条；缺少 ${result.missingCount} 条。`);
    } else if (action === 'entry-group-enabled') {
      setEntryGroupEnabled(view, target.dataset.groupId, target.dataset.enabled === 'true');
    } else if (action === 'entry-group-delete') {
      const group = (view.entryGroups || []).find(candidate => candidate.id === String(target.dataset.groupId));
      applyGroupRelations(view, '删除组合', removeEntryGroup(view.entryGroups, target.dataset.groupId));
      if (view.activeEntryGroupId === target.dataset.groupId) view.activeEntryGroupId = view.entryGroups[0]?.id || '__ungrouped__';
      view.entryGroupEditingId = null;
      view.selected.clear();
      renderDynamic(view, { list: true });
      toast('info', group ? `已删除组合“${group.name}”。` : '这个组合已不存在。');
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
      applyWorking(view, '复制条目', () => result.entries, { copySourceId: id, copyId: result.id });
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
      if (snapshot) { if (snapshot.kind === 'transfer') restoreTransferSnapshot(view, snapshot); else view.working = snapshot.working; if (snapshot.entryGroups) view.entryGroups = cloneJson(snapshot.entryGroups); renderDynamic(view, { list: true }); toast('info', `已撤销：${snapshot.label}`); }
    } else if (action === 'discard') {
      if (!isDirty(view) || view.busy) return;
      view.discardConfirmOpen = true;
      renderLeaveModal(view);
    } else if (action === 'discard-confirm-cancel') {
      view.discardConfirmOpen = false;
      renderLeaveModal(view);
    } else if (action === 'discard-confirm-accept') {
      if (!view.discardConfirmOpen || !isDirty(view) || view.busy) return;
      if (view.transferStates?.size) discardTransferChanges(view); else { view.working = cloneJson(view.baseline); view.undo = []; }
      view.entryGroups = cloneJson(view.entryGroupBaseline || []);
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
      if (comboWorkspaceActive(view)) { moveComboSelection(view, comboSelectedIds(view), target.dataset.direction); renderDynamic(view, {list: true}); }
      else applyWorking(view, '批量调整列表排列', () => moveEntries(view.working, [...view.selected], target.dataset.direction));
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
      view.mobileMenu = null;
      const rules = view.mixedMode ? loadMixedArrangeRules() : loadArrangeRules(view.book);
      if (view.mixedMode) {
        const changed = applyWorking(view, '整理多书合并工作副本', () => arrangeMixedWorking(view.working, rules), { noOpMessage: '总览已经符合总览整理设置。' });
        if (changed) {
          const books = mixedDirtyBooks(view).length;
          toast('success', books ? '已整理总览；' + books + ' 本书产生未保存的列表排列修改。' : '已整理总览排列；世界书内容未修改。');
        }
      } else applyWorking(view, '一键整理列表排列', () => stableAutoArrange(view.working, rules), { noOpMessage: '本书列表已经符合整理设置。' });
    } else if (action === 'name-arrange') {
      view.mobileMenu = null;
      applyWorking(view, '按名称整理列表排列', () => arrangeNamesByDirection(view.working,readNameArrangePreference(view).direction), { noOpMessage: '当前列表已经符合名称顺序。' });
    } else if (action === 'arrange-settings') {
      view.mobileMenu = null;
      view.arrangeDraft = view.mixedMode ? effectiveMixedArrangeRules(view.working, loadMixedArrangeRules()) : effectiveArrangeRules(view.working, loadArrangeRules(view.book));
      view.arrangeInitialDraft = cloneJson(view.arrangeDraft);
      view.nameArrangeDraft = readNameArrangePreference(view);
      view.nameArrangeInitialDraft = cloneJson(view.nameArrangeDraft);
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
      saveNameArrangePreference(view);
      if (view.mixedMode) saveMixedArrangeRules(view.arrangeDraft); else saveArrangeRules(view.book, view.arrangeDraft);
      const scope = view.mixedMode ? '总览' : '本书';
      clearTimeout(view.arrangeFlashTimer); clearArrangeDragFeedback(view); view.arrangeInitialDraft = null; view.arrangeDrag = null; view.arrangeFlashIndex = null; view.arrangeFlashTimer = null;
      view.panel = null; renderDynamic(view, { list: true }); toast('success', '已保存' + scope + '整理设置，列表排列未改变。');
    } else if (action === 'save-and-arrange') {
      const namePrefs = saveNameArrangePreference(view);
      const rules = view.mixedMode ? saveMixedArrangeRules(view.arrangeDraft) : saveArrangeRules(view.book, view.arrangeDraft);
      const mixed = view.mixedMode;
      clearTimeout(view.arrangeFlashTimer); clearArrangeDragFeedback(view); view.arrangeInitialDraft = null; view.arrangeDrag = null; view.arrangeFlashIndex = null; view.arrangeFlashTimer = null;
      view.panel = null;
      const changed = applyWorking(view, mixed ? '按总览设置整理多书合并工作副本' : '按本书设置整理列表排列', () => namePrefs.mode === 'name' ? arrangeNamesByDirection(view.working,namePrefs.direction) : mixed ? arrangeMixedWorking(view.working, rules) : stableAutoArrange(view.working, rules), { noOpMessage: mixed ? '总览已经符合总览整理设置。' : '本书列表已经符合整理设置。' });
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
    if (view.legacyEventsBound) return;
    const resources = requireMobileUiSession(view).resources;
    view.legacyEventsBound = true;
    resources.own(() => { view.legacyEventsBound = false; });
    const listen = resources.listen;
    listen(root, 'pointerdown',event=>{const handle=event.target.closest?.('[data-action="combo-group-drag"]');if(handle)startComboNavDrag(view,event,handle);});
    listen(root, 'pointermove',event=>moveComboNavDrag(view,event));
    listen(root, 'pointerup',event=>endComboNavDrag(view,event));
    listen(root, 'pointercancel',event=>endComboNavDrag(view,event,true));
    const blockBookPointer = event => blockTransferBookControl(view, event, event.type === 'pointerdown');
    listen(root, 'pointerdown', blockBookPointer, true);
    listen(root, 'touchstart', blockBookPointer, { capture: true, passive: false });
    listen(root, 'click', blockBookPointer, true);
    listen(root, 'click', event => {
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
      if (view.bookPickerOpen && !event.target.closest?.('.qa-book-picker')) closeBookPicker(view, false);
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
    listen(root, 'keydown', event => {
      if (view.bookPickerOpen && event.key === 'Escape') { event.preventDefault(); closeBookPicker(view, true); return; }
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
    listen(root, 'focusout', event => {
      const control = event.target.dataset.control;
      if (control === 'entry-content') { view.cardContentInput = null; view.cardContentUndo = null; return; }
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
    listen(root, 'input', event => {
      const control = event.target.dataset.control;
      if (control === 'entry-content') { commitCardContentInput(view, event.target); return; }
      if (control === 'content-full' && view.contentEditor) {
        view.contentEditor.draft = event.target.value;
        scheduleContentEditorToken(view);
      }
      if (control === 'content-name-full' && view.contentEditor) view.contentEditor.nameDraft = event.target.value;
      if (control === 'content-key-input' && view.contentEditor) view.contentEditor.keyInputDraft = event.target.value;
      if (control === 'search') scheduleSearch(view, event.target.value);
      if (control === 'body-search-find' || control === 'body-search-replace') updateBodySearchInput(view, control, event.target.value);
      if (control === 'book-picker-search') { view.bookPickerQuery = event.target.value; renderBookPickerResults(view); }
      if (control === 'entry-group-name') view.entryGroupNameDraft = event.target.value;
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
    listen(root, 'change', event => {
      try {
        const control = event.target.dataset.control;
        const card = event.target.closest?.('.qa-card');
        const cardId = card?.dataset.entryId;
        if (control === 'import-source') {
        Promise.resolve(loadImportSource(view, event.target.value)).catch(error => toast('error', error instanceof Error ? error.message : String(error), '来源书读取失败'));

      } else if (control === 'transfer-target-select') {
        view.transferDraft.target = event.target.value; renderTransferSelection(view, true);
      } else if (control === 'import-filter') {
        view.importDraft.filter = event.target.value; renderImportSelection(view, false);
      } else if (control === 'transfer-filter') {
        view.transferDraft.filter = event.target.value; renderTransferSelection(view, false);
      } else if (control === 'state-filter-select') {
        view.stateFilter = event.target.value; view.renderLimit = APP.chunkSize; renderDynamic(view, { list: true, resetScroll: true });
      } else if (control === 'arrange-method' || control === 'name-arrange-direction') {
        view.nameArrangeDraft = normalizeNameArrangePreference(view.nameArrangeDraft);
        if(control === 'arrange-method') view.nameArrangeDraft.mode = event.target.value === 'name' ? 'name' : 'position';
        else view.nameArrangeDraft.direction = event.target.value === 'desc' ? 'desc' : 'asc';
        renderArrangeDraft(view);
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
    listen(root, 'dragstart', event => {
      const handle = event.target.closest?.('[data-action="arrange-drag"]');
      if (!handle || view.panel !== 'arrange-settings' || !isDesktopLayout(view)) return;
      const index = Number(handle.dataset.index);
      if (!Number.isInteger(index) || !view.arrangeDraft[index]) { event.preventDefault(); return; }
      view.arrangeDrag = { from: index };
      handle.closest('.qa-arrange-row')?.classList.add('is-dragging');
      event.dataTransfer?.setData('text/plain', String(index));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    listen(root, 'dragover', event => {
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
    listen(root, 'dragleave', event => {
      if (!view.arrangeDrag || view.panel !== 'arrange-settings') return;
      if (!event.relatedTarget || !root.contains(event.relatedTarget)) clearArrangeDragFeedback(view);
    });
    listen(root, 'drop', event => {
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
    listen(root, 'dragend', () => {
      view.arrangeDrag = null;
      clearArrangeDragFeedback(view);
    });
    listen(root, 'pointerdown', event => {
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
      if (view.keywordInternalPointer) mobileUiTimeout(view, 'keywordPointerTimer', () => { view.keywordInternalPointer = false; }, 0);
      const handle = event.target.closest?.('[data-action="drag"]');
      const card = handle?.closest('.qa-card');
      if (handle && card) startDrag(view, event, card);
    });
    listen(root, 'pointermove', event => dragMove(view, event));
    listen(root, 'pointerup', event => endDrag(view, event));
    listen(root, 'pointercancel', event => endDrag(view, event, true));
    const scroll = root.querySelector('[data-slot="scroll"]');
    listen(scroll, 'scroll', () => {
      if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 240 && visibleEntries(view).length > view.renderLimit) {
        view.renderLimit += APP.chunkSize;
        renderList(view);
      }
    }, { passive: true });
  }

  function releaseMobileUi(view) {
    for (const key of ['searchTimer', 'bodySearchTimer', 'contentTokenTimer',
      'arrangeFlashTimer', 'entryMoveFeedbackTimer']) {
      clearTimeout(view[key]);
      view[key] = null;
    }
    // These cancel animation work and clear feedback while the root still exists.
    const errors = [];
    for (const release of [clearEntryMoveFeedback, clearEntryDragFeedback,
      stopDragAutoScroll, removeMobileViewport]) {
      try { release(view); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Mobile UI cleanup failed');
  }

  async function mobileCanClose(view) {
    if (view.contentDiscardIntent) { view.contentDiscardIntent = null; renderLeaveModal(view); return false; }
    if (view.discardConfirmOpen) { view.discardConfirmOpen = false; renderLeaveModal(view); return false; }
    if (view.bookPickerOpen) { closeBookPicker(view, true); return false; }
    if (view.themePickerOpen) { closeThemePicker(view); return false; }
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
  }

  function installMobileViewport(view, popup) {
    removeMobileViewport(view);
    const outer = hostWindow();
    const resources = requireMobileUiSession(view).resources;
    view.popupDialog = popup.dlg || null;
    view.mobileViewport = outer.visualViewport || null;
    view.onMobileViewportChange = () => syncMobileViewport(view);
    view.uiViewportReleases = [
      resources.listen(view.mobileViewport, 'resize', view.onMobileViewportChange, { passive: true }),
      resources.listen(outer, 'resize', view.onMobileViewportChange, { passive: true }),
    ];
    syncMobileViewport(view);
  }

  function removeMobileViewport(view) {
    for (const release of view.uiViewportReleases || []) release();
    view.uiViewportReleases = [];
    view.mobileViewport = null;
    view.onMobileViewportChange = null;
    view.popupDialog = null;
  }

  function createMobileViewState() {
    return {
      root: null, popup: null, names: [], book: '', baseline: null, working: null, mixedMode: false, activeBooks: [], catalogActiveBooks: [], catalogReady: false, catalogError: '', bookPickerOpen: false, bookPickerQuery: '', bookStates: new Map(), mixedSignature: '', slotBaseline: [], sourceVisible: true, transferStates: new Map(), transferMoveTargets: new Set(), transferDraft: createTransferDraft(), transferReturnScroll: 0, toolsOpen: false, mobileMenu: null, mobileMode: 'edit', activeEntryGroupId: '', entryGroupEditingId: null, titleLocked: true,
      selected: new Set(), expanded: new Set(), undo: [], query: '', stateFilter: 'all', positionFilter: 'all', searchOpen: false, moveMode: false,
      renderLimit: APP.chunkSize, panel: null, leaveIntent: null, leaveError: '', discardConfirmOpen: false, loading: false, busy: null,
      error: '', closed: false, forceClose: false, searchTimer: null, drag: null, tokenCounts: new Map(), tokenTask: null,
      contentEditor: null, contentDiscardIntent: null, contentTokenTimer: null, entryMoveFeedbackTimer: null,
      guideOpen: false, guideScrollTop: 0, guideReturnFocus: null,
      theme: DEFAULT_THEME, themePickerOpen: false, themeReturnFocus: null,
      keywordInternalPointer: false, nameClickGuard: null,
      popupDialog: null, mobileViewport: null, onMobileViewportChange: null,
      viewportBaselineHeight: 0, viewportLastWidth: 0,
      positionDraft: { type: 'before_character_definition', depth: '4', role: 'system' },
      orderDraft: { mode: 'same', start: '100', gap: '10' },
      importDraft: { source: '', entries: null, selected: new Set(), previewed: new Set(), query: '', filter: 'all', loading: false, error: '' },
      entryGroups: [], entryGroupBaseline: [], entryGroupDocument: null, entryGroupNameDraft: '',
      arrangeDraft: [], arrangeInitialDraft: null, arrangeDrag: null, arrangeFlashIndex: null, arrangeFlashTimer: null,
    };
  }
  const parts=Object.freeze({list:renderList,panel:renderPanel,workspacePanel:renderWorkspacePanel,
    footer:renderFooter,leaveModal:renderLeaveModal,action:handleAction,bind:bindView,
    syncFooterState,syncTopControls});
  const adapter={id:'mobile-v1',createState:createMobileViewState,template:templateHtml,parts,
    mount(view,popup){
      view.root=popup.dlg?.querySelector('#iwb-qa-root');
      if(!view.root)throw new Error('原生弹窗已打开，但未找到常用编辑容器。');
      applyTheme(view,readThemePreference(),false);
      installMobileViewport(view,popup);bindView(view);
    },
    refresh:renderDynamic,canClose:mobileCanClose,unmount:releaseMobileUi};
  if(TEST_MODE)adapter.inspection=Object.freeze({cardHtml,mobileEntryCardHtml,mobileCardEditorHtml,footerHtml,mobileComboHeaderHtml,
    openComboWorkspace,closeComboWorkspace,openContentEditor,closeContentEditor,
    scheduleTokenCounts,updateBodySearchInput,applyTheme,renderContentEditorDraft,
    contentEditorTitleHtml,contentEditorKeysHtml,renderList,renderPanel,renderFooter,
    handleAction,bindView,createMobileViewState,STYLES});
  return Object.freeze(adapter);
  }
  function createDesktopUiAdapter(ports, options = {}) {
    const {
      APP,DEFAULT_THEME,POSITION_LABELS,POSITION_TYPES,ROLE_LABELS,addEntriesToGroup,applyTheme,applyTransfer,applyWorking,
      arrangeNamesByDirection,batchSetEnabledSelected,cancelLeavePrompt,cloneJson,comboOrderedEntries,comboSelectedIds,
      completeLeave,createEntryGroupWithMembers,createTransferDraft,deleteEntryGroupFromView,defaultArrangeRules,disableAllRecursion,
      discardTransferChanges,effectiveArrangeRules,entryGroupMembership,entryId,entryName,faultReportCopy,importEntriesAtTop,
      inlineFieldMutation,isDirty,loadArrangeRules,loadBook,moveComboSelection,moveEntryGroupByDirection,mutateOrder,mutatePosition,
      normalizeNameArrangePreference,pendingSummary,positionInfo,readNameArrangePreference,readThemePreference,readWorldbookEntries,renameEntryGroup,replaceBodySearchResults,
      restoreTransferSnapshot,saveAll,saveArrangeRules,saveNameArrangePreference,searchWorkspaceResults,setEntryGroupEnabled,showLeavePrompt,
      stableAutoArrange,toast,tokenLabel,visibleEntries,visibleImportEntries,visibleTransferEntries,
    }=ports;
    const adapterId=options.id||'desktop-v1',tabletMode=options.mode==='tablet',extraStyles=String(options.extraStyles||'');
    const DESKTOP_STYLES=String.raw`
#iwb-qa-root.qa-desktop-root{--iwb-canvas:#E5E9E7;--iwb-shell:#FAFAF7;--iwb-workbench:#F1F4F2;--iwb-card:#FFFDFC;--iwb-control:#FCFCFA;--iwb-editor:#FFFFFF;--iwb-text:#2B3133;--iwb-text-secondary:#616C6D;--iwb-muted:#929B99;--iwb-accent:#5F7D87;--iwb-accent-soft:#DDE8EA;--iwb-accent-2:#9A747B;--iwb-danger:#A24F5C;--iwb-line:color-mix(in srgb,var(--iwb-text) 13%,var(--iwb-shell));--iwb-line-strong:color-mix(in srgb,var(--iwb-text) 25%,var(--iwb-shell));width:min(1480px,calc(100vw - 32px));height:min(860px,calc(100vh - 96px));height:min(860px,calc(100dvh - 96px));max-height:calc(100vh - 96px);max-height:calc(100dvh - 96px);margin:auto;overflow:hidden;color:var(--iwb-text);font:14px/1.5 system-ui,sans-serif}
#iwb-qa-root.qa-desktop-root[data-theme="wisteria-moon"]{--iwb-canvas:#EAE5E3;--iwb-shell:#FBF8F6;--iwb-workbench:#F6F1EF;--iwb-card:#FFFDFC;--iwb-control:#FCFAF8;--iwb-editor:#FFFFFF;--iwb-text:#302C31;--iwb-text-secondary:#6C646B;--iwb-muted:#9E969C;--iwb-accent:#9B6F82;--iwb-accent-soft:#F0E2E7;--iwb-accent-2:#756A91}
#iwb-qa-root.qa-desktop-root[data-theme="night-mist"]{--iwb-canvas:#242228;--iwb-shell:#2C2930;--iwb-workbench:#302D34;--iwb-card:#343138;--iwb-control:#36333A;--iwb-editor:#39363D;--iwb-text:#E3DDE2;--iwb-text-secondary:#BBB3B9;--iwb-muted:#918990;--iwb-accent:#B08EA2;--iwb-accent-soft:#493B45;--iwb-accent-2:#9488B0;--iwb-line:color-mix(in srgb,var(--iwb-text) 17%,var(--iwb-shell))}
.iwb-qa-host{width:min(1480px,calc(100dvw - 24px))!important;max-width:calc(100dvw - 24px)!important;min-width:0!important;margin-inline:auto!important;padding:0!important;overflow:visible!important}.iwb-qa-host .popup-body,.iwb-qa-host .popup-content{box-sizing:border-box!important;width:100%!important;max-width:100%!important;min-width:0!important;margin:0!important;padding:0!important;overflow:hidden!important}
.iwb-qa-host[data-iwb-qa-theme="night-mist"] .popup-button-close{background:#E7E5ED!important;border:1px solid #AAA7B6!important;color:#202129!important;opacity:1!important;filter:none!important}
#iwb-qa-root.qa-desktop-root *{box-sizing:border-box}
#iwb-qa-root.qa-desktop-root button,#iwb-qa-root.qa-desktop-root input,#iwb-qa-root.qa-desktop-root select,#iwb-qa-root.qa-desktop-root textarea{font:inherit;color:inherit}
#iwb-qa-root.qa-desktop-root button{min-height:36px;border:1px solid var(--iwb-line);background:var(--iwb-control);padding:7px 12px;cursor:pointer}
#iwb-qa-root.qa-desktop-root button:hover:not(:disabled){border-color:var(--iwb-accent);color:var(--iwb-accent)}
#iwb-qa-root.qa-desktop-root button:disabled{opacity:.45;cursor:not-allowed}
#iwb-qa-root.qa-desktop-root .qa-primary{background:var(--iwb-accent);border-color:var(--iwb-accent);color:var(--iwb-shell)}
#iwb-qa-root.qa-desktop-root .qa-danger{color:var(--iwb-danger)}
#iwb-qa-root.qa-desktop-root input,#iwb-qa-root.qa-desktop-root select,#iwb-qa-root.qa-desktop-root textarea{width:100%;border:1px solid var(--iwb-line-strong);background:var(--iwb-editor);padding:8px 10px;outline:none}
#iwb-qa-root.qa-desktop-root input:focus,#iwb-qa-root.qa-desktop-root select:focus,#iwb-qa-root.qa-desktop-root textarea:focus{border-color:var(--iwb-accent);box-shadow:0 0 0 2px var(--iwb-accent-soft)}
#iwb-qa-root.qa-desktop-root .qa-desktop-shell{height:100%;min-height:0;display:grid;grid-template-columns:minmax(180px,230px) minmax(600px,920px) minmax(180px,270px);justify-content:center;background:var(--iwb-canvas);border:1px solid var(--iwb-line);overflow:hidden}
#iwb-qa-root.qa-desktop-root .qa-desktop-left,#iwb-qa-root.qa-desktop-root .qa-desktop-right{min-width:0;min-height:0;background:var(--iwb-workbench);padding:18px;overflow:auto}
#iwb-qa-root.qa-desktop-root .qa-desktop-center{height:100%;min-width:0;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:var(--iwb-shell);border-inline:1px solid var(--iwb-line);overflow:hidden}
#iwb-qa-root.qa-desktop-root .qa-desktop-head{display:flex;align-items:end;justify-content:space-between;gap:20px;padding:16px 20px;border-block-end:1px solid var(--iwb-line)}
#iwb-qa-root.qa-desktop-root .qa-desktop-title h2{margin:0;font-size:19px;font-weight:600}.qa-desktop-title p{margin:3px 0 0;color:var(--iwb-text-secondary);font-size:12px}
#iwb-qa-root.qa-desktop-root .qa-book-select{width:min(330px,46%)}
#iwb-qa-root.qa-desktop-root .qa-desktop-main{height:100%;min-height:0;overflow-x:hidden;overflow-y:scroll;overscroll-behavior:contain;touch-action:pan-y;padding:18px 20px;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:var(--iwb-accent) var(--iwb-workbench)}
#iwb-qa-root.qa-desktop-root .qa-desktop-list{display:grid;gap:10px}
#iwb-qa-root.qa-desktop-root .qa-desktop-empty{height:100%;min-height:220px;display:grid;place-items:center;color:var(--iwb-muted);text-align:center;padding:24px}
#iwb-qa-root.qa-desktop-root .qa-desktop-card{background:var(--iwb-card);border:1px solid var(--iwb-line);border-left:3px solid var(--iwb-accent-2)}
#iwb-qa-root.qa-desktop-root .qa-desktop-card.is-selected{background:color-mix(in srgb,var(--iwb-accent-soft) 82%,var(--iwb-card));border-color:var(--iwb-accent)}
#iwb-qa-root.qa-desktop-root .qa-card-summary{display:grid;grid-template-columns:32px minmax(0,1fr) auto;align-items:center;gap:10px;padding:12px 14px}
#iwb-qa-root.qa-desktop-root .qa-card-check{appearance:none;-webkit-appearance:none;display:grid;place-content:center;width:19px;height:19px;margin:0;padding:0!important;border:1.5px solid var(--iwb-accent);border-radius:3px;background:var(--iwb-card);cursor:pointer}#iwb-qa-root.qa-desktop-root .qa-card-check::before{content:"";width:9px;height:5px;border-left:2px solid var(--iwb-shell);border-bottom:2px solid var(--iwb-shell);transform:rotate(-45deg) scale(0);transform-origin:center}#iwb-qa-root.qa-desktop-root .qa-card-check:checked{background:var(--iwb-accent)}#iwb-qa-root.qa-desktop-root .qa-card-check:checked::before{transform:rotate(-45deg) scale(1)}.qa-card-heading{min-width:0}.qa-card-heading strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:600}.qa-card-meta{color:var(--iwb-muted);font-size:12px}
#iwb-qa-root.qa-desktop-root .qa-card-expand{width:38px;min-width:38px;padding:0;border:0;background:transparent;font-size:18px}
#iwb-qa-root.qa-desktop-root .qa-card-editor{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;padding:14px;border-top:1px solid var(--iwb-line)}
#iwb-qa-root.qa-desktop-root .qa-editor-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;color:var(--iwb-text-secondary);font-size:12px}.qa-editor-heading strong{color:var(--iwb-text);font-size:13px;font-weight:600}
#iwb-qa-root.qa-desktop-root .qa-field{display:grid;gap:5px}.qa-field>span{font-size:12px;color:var(--iwb-text-secondary)}.qa-field-wide{grid-column:1/-1}.qa-field textarea{min-height:150px;resize:vertical;line-height:1.55}
#iwb-qa-root.qa-desktop-root .qa-inline-grid{display:grid;grid-template-columns:minmax(200px,1fr) repeat(3,minmax(72px,110px));align-items:end;gap:10px}
#iwb-qa-root.qa-desktop-root .qa-inline-grid.is-basic{grid-template-columns:minmax(200px,1fr) minmax(72px,110px)}
#iwb-qa-root.qa-desktop-root .qa-desktop-foot{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 20px;border-block-start:1px solid var(--iwb-line);background:var(--iwb-shell)}
#iwb-qa-root.qa-desktop-root .qa-pending{color:var(--iwb-text-secondary)}.qa-foot-actions{display:flex;gap:8px}
#iwb-qa-root.qa-desktop-root .qa-side-title{margin:0 0 14px;font-size:13px;font-weight:600;color:var(--iwb-text-secondary);letter-spacing:.06em}.qa-side-block{border-top:1px solid var(--iwb-line);padding-top:14px;margin-top:14px}.qa-side-stat{font-size:24px;line-height:1.2}.qa-side-muted{color:var(--iwb-muted);font-size:12px}.qa-side-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.qa-side-actions .qa-wide{grid-column:1/-1}
#iwb-qa-root.qa-desktop-root .qa-desktop-nav{display:grid;gap:5px;margin-top:18px;padding-top:16px;border-top:1px solid var(--iwb-line)}#iwb-qa-root.qa-desktop-root .qa-desktop-nav button{text-align:left;border-color:transparent;background:transparent}#iwb-qa-root.qa-desktop-root .qa-desktop-nav button.is-active{border-color:var(--iwb-accent);background:var(--iwb-accent-soft);color:var(--iwb-text);font-weight:600}#iwb-qa-root.qa-desktop-root .qa-desktop-nav-section{margin-top:9px;padding-top:10px;border-top:1px solid var(--iwb-line)}#iwb-qa-root.qa-desktop-root .qa-desktop-nav-label{padding:0 12px 4px;color:var(--iwb-muted);font-size:11px;letter-spacing:.06em}#iwb-qa-root.qa-desktop-root .qa-desktop-nav .qa-nav-action{color:var(--iwb-text-secondary)}#iwb-qa-root.qa-desktop-root .qa-desktop-nav .qa-nav-aux{min-height:31px;padding-block:4px;color:var(--iwb-muted);font-size:12px}
#iwb-qa-root.qa-desktop-root .qa-combo-nav{display:grid;gap:4px;margin:2px 4px 5px 10px;padding:5px 2px 5px 8px;border-left:2px solid var(--iwb-line)}#iwb-qa-root.qa-desktop-root .qa-combo-nav.is-expanded{max-height:210px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--iwb-accent) transparent}#iwb-qa-root.qa-desktop-root .qa-combo-nav-label{position:sticky;top:-5px;z-index:1;margin-bottom:2px;padding:4px 6px;background:var(--iwb-workbench);color:var(--iwb-muted);font-size:11px}#iwb-qa-root.qa-desktop-root .qa-combo-nav button{display:flex;justify-content:space-between;gap:8px;min-width:0;min-height:31px;padding-block:4px;text-align:left;border-color:transparent;background:transparent}#iwb-qa-root.qa-desktop-root .qa-combo-nav button span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#iwb-qa-root.qa-desktop-root .qa-combo-nav button.is-active{border-color:var(--iwb-accent);background:var(--iwb-accent-soft);font-weight:600}#iwb-qa-root.qa-desktop-root .qa-combo-nav .qa-combo-nav-toggle{position:sticky;bottom:-5px;justify-content:center;background:var(--iwb-workbench);border-top:1px solid var(--iwb-line);color:var(--iwb-accent);font-size:12px}#iwb-qa-root.qa-desktop-root .qa-combo-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}#iwb-qa-root.qa-desktop-root .qa-combo-actions .qa-wide{grid-column:1/-1}#iwb-qa-root.qa-desktop-root .qa-combo-danger{margin-top:8px;width:100%}
#iwb-qa-root.qa-desktop-root .qa-combo-target-list{display:grid;gap:6px;max-height:190px;margin-top:10px;padding-right:3px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--iwb-accent) transparent}#iwb-qa-root.qa-desktop-root .qa-combo-target{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;width:100%;min-width:0;text-align:left}#iwb-qa-root.qa-desktop-root .qa-combo-target span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#iwb-qa-root.qa-desktop-root .qa-combo-target span:last-child{color:var(--iwb-muted);font-size:12px}#iwb-qa-root.qa-desktop-root .qa-combo-target.is-active{border-color:var(--iwb-accent);background:var(--iwb-accent-soft);font-weight:600}#iwb-qa-root.qa-desktop-root .qa-combo-assign-hint{margin:10px 0 0;color:var(--iwb-text-secondary);line-height:1.65}
#iwb-qa-root.qa-desktop-root .qa-theme-choices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;margin-top:6px}#iwb-qa-root.qa-desktop-root .qa-theme-dot{display:grid;place-items:center;min-width:0;min-height:32px;padding:4px!important;border-color:transparent!important;background:transparent!important;color:var(--iwb-muted);font-size:11px}#iwb-qa-root.qa-desktop-root .qa-theme-dot::before{content:"";display:block;width:18px;height:18px;margin-bottom:2px;border:1px solid var(--iwb-line-strong);border-radius:50%;background:linear-gradient(135deg,#5F7D87 0 50%,#DDE8EA 50%)}#iwb-qa-root.qa-desktop-root .qa-theme-dot[data-theme="wisteria-moon"]::before{background:linear-gradient(135deg,#9B6F82 0 50%,#F0E2E7 50%)}#iwb-qa-root.qa-desktop-root .qa-theme-dot[data-theme="night-mist"]::before{background:linear-gradient(135deg,#B08EA2 0 50%,#493B45 50%)}#iwb-qa-root.qa-desktop-root .qa-theme-dot.is-active{border-color:var(--iwb-accent)!important;background:var(--iwb-accent-soft)!important;color:var(--iwb-text);font-weight:600}
#iwb-qa-root.qa-desktop-root .qa-filter-fields{display:grid;gap:10px;margin-top:14px}#iwb-qa-root.qa-desktop-root .qa-task-tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px}#iwb-qa-root.qa-desktop-root .qa-task-tabs button.is-active{border-color:var(--iwb-accent);background:var(--iwb-accent-soft);font-weight:600}#iwb-qa-root.qa-desktop-root .qa-arrange-actions{display:grid;gap:8px;margin-top:12px}#iwb-qa-root.qa-desktop-root .qa-search-page{display:grid;gap:14px}#iwb-qa-root.qa-desktop-root .qa-search-toolbar{position:sticky;top:-18px;z-index:3;display:grid;grid-template-columns:140px minmax(0,1fr);align-items:end;gap:10px;margin:-18px -20px 0;padding:14px 20px;background:var(--iwb-shell);border-bottom:1px solid var(--iwb-line)}#iwb-qa-root.qa-desktop-root .qa-search-toolbar.is-body{grid-template-columns:140px repeat(2,minmax(0,1fr))}#iwb-qa-root.qa-desktop-root .qa-search-toolbar.is-body .qa-primary{grid-column:2/4}#iwb-qa-root.qa-desktop-root .qa-search-results{display:grid;gap:10px}#iwb-qa-root.qa-desktop-root .qa-search-summary{padding:2px 0 8px;color:var(--iwb-text-secondary)}#iwb-qa-root.qa-desktop-root .qa-search-result{padding:14px;background:var(--iwb-card);border:1px solid var(--iwb-line)}#iwb-qa-root.qa-desktop-root .qa-search-result header{display:flex;justify-content:space-between;gap:16px}#iwb-qa-root.qa-desktop-root .qa-search-result header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#iwb-qa-root.qa-desktop-root .qa-search-result small{flex:none;color:var(--iwb-muted)}#iwb-qa-root.qa-desktop-root .qa-search-result p{margin:8px 0 0;color:var(--iwb-text-secondary);white-space:pre-wrap;overflow-wrap:anywhere}#iwb-qa-root.qa-desktop-root .qa-result-empty{padding:48px 20px;text-align:center;color:var(--iwb-muted)}
#iwb-qa-root.qa-desktop-root .qa-work-fields{display:grid;gap:10px;margin-top:14px}.qa-work-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.qa-workbench-empty{color:var(--iwb-muted);padding-top:30px;line-height:1.65}.qa-workbench-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.qa-workbench-head-copy{min-width:0}.qa-workbench-head-copy .qa-side-title{margin-bottom:2px;color:var(--iwb-text);font-size:15px;letter-spacing:0}.qa-workbench-head button{border:0;background:transparent;min-height:30px;padding:0 6px;font-size:18px}.qa-selected-list{display:grid;gap:3px;margin:12px 0 0;padding:0;list-style:none}.qa-selected-list li{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--iwb-text-secondary);font-size:12px}.qa-workbench-open{width:100%;margin-top:14px}
#iwb-qa-root.qa-desktop-root .qa-task-page{height:100%;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);gap:14px;overflow:hidden}.qa-task-toolbar{z-index:3;display:grid;grid-template-columns:minmax(180px,1fr) minmax(180px,1fr) 150px;align-items:end;gap:10px;margin:-18px -20px 0;padding:14px 20px;background:var(--iwb-shell);border-bottom:1px solid var(--iwb-line)}.qa-task-list{min-height:0;display:grid;align-content:start;gap:8px;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding-right:4px}.qa-task-row{display:grid;grid-template-columns:30px minmax(0,1fr) 38px;gap:10px;align-items:center;padding:10px 14px;background:var(--iwb-card);border:1px solid var(--iwb-line)}.qa-task-row.is-selected{border-color:var(--iwb-accent);background:var(--iwb-accent-soft)}.qa-task-row-copy{min-width:0}.qa-task-row strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qa-task-row small{display:block;color:var(--iwb-muted)}.qa-task-preview{grid-column:2/4;margin:2px 0 4px;padding-top:10px;border-top:1px solid var(--iwb-line);color:var(--iwb-text-secondary);white-space:pre-wrap;overflow-wrap:anywhere}.qa-task-preview-toggle{width:38px;min-width:38px;padding:0!important;border:0!important;background:transparent!important;font-size:18px}.qa-arrange-methods{display:grid;grid-template-columns:1fr 1fr;gap:10px}.qa-arrange-list{display:grid;gap:8px}.qa-arrange-row{display:grid;grid-template-columns:minmax(0,1fr) 120px auto auto;gap:8px;align-items:center;padding:10px 12px;background:var(--iwb-card);border:1px solid var(--iwb-line)}
#iwb-qa-root.qa-desktop-root .qa-desktop-modal{position:absolute;inset:0;display:grid;place-items:center;padding:18px;background:color-mix(in srgb,var(--iwb-text) 24%,transparent);z-index:20}#iwb-qa-root.qa-desktop-root .qa-desktop-modal[hidden]{display:none}.qa-modal-card{width:min(440px,calc(100% - 48px));background:var(--iwb-card);border:1px solid var(--iwb-line);padding:22px;box-shadow:0 18px 50px #0003}.qa-modal-card h3{margin:0 0 8px;font-size:18px}.qa-modal-card p{margin:0 0 18px;color:var(--iwb-text-secondary)}.qa-modal-actions{display:flex;justify-content:flex-end;gap:8px}.qa-guide-card{width:min(620px,100%);max-height:min(680px,100%);display:grid;grid-template-rows:auto minmax(0,1fr);padding:0;overflow:hidden}.qa-guide-card header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 18px;border-bottom:1px solid var(--iwb-line)}.qa-guide-card header h3{margin:0}.qa-guide-card header button{width:40px;min-width:40px;padding:0;font-size:18px}.qa-guide-content{min-height:0;overflow-y:auto;padding:4px 18px 18px}.qa-guide-section{padding:14px 0;border-bottom:1px solid var(--iwb-line)}.qa-guide-section:last-child{border-bottom:0}.qa-guide-section h4{margin:0 0 4px;font-size:15px}.qa-guide-section p{margin:0;line-height:1.65}.qa-guide-about p{font-size:12px}.qa-desktop-root{position:relative}
`;
    const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const optionHtml=(value,label,current)=>`<option value="${escapeHtml(value)}"${String(value)===String(current)?' selected':''}>${escapeHtml(label)}</option>`;
    function templateHtml(){return `<div id="iwb-qa-root" class="qa-desktop-root${tabletMode?' qa-tablet-root':''}"><style>${DESKTOP_STYLES}${extraStyles}</style><div class="qa-desktop-shell"><aside class="qa-desktop-left" data-slot="desktop-left" aria-label="导航"></aside><section class="qa-desktop-center"><header class="qa-desktop-head" data-slot="desktop-header"></header><main class="qa-desktop-main" data-slot="scroll"><div class="qa-desktop-empty">正在读取世界书…</div></main><footer class="qa-desktop-foot" data-slot="desktop-footer"></footer></section><aside class="qa-desktop-right" data-slot="desktop-right" aria-label="工作台"></aside></div><div class="qa-desktop-modal" data-slot="desktop-modal" hidden></div></div>`}
    function createDesktopViewState(){return {
      root:null,popup:null,names:[],book:'',baseline:null,working:null,mixedMode:false,activeBooks:[],catalogActiveBooks:[],catalogReady:false,catalogError:'',bookPickerOpen:false,bookPickerQuery:'',bookStates:new Map(),mixedSignature:'',slotBaseline:[],sourceVisible:true,transferStates:new Map(),transferMoveTargets:new Set(),transferDraft:createTransferDraft(),transferReturnScroll:0,toolsOpen:false,mobileMenu:null,mobileMode:'edit',workspace:'edit',desktopReturnScroll:0,searchKind:'metadata',searchFind:'',searchReplace:'',comboGroupId:'__all__',comboNameDraft:'',comboRenameDraft:'',comboTargetGroupId:'',activeEntryGroupId:'',entryGroupEditingId:null,titleLocked:false,
      selected:new Set(),expanded:new Set(),undo:[],query:'',stateFilter:'all',positionFilter:'all',searchOpen:false,moveMode:false,renderLimit:APP.chunkSize,panel:null,toolTask:'',selectionWorkbenchDismissed:false,comboNavExpanded:false,leaveIntent:null,leaveError:'',discardConfirmOpen:false,loading:false,busy:null,error:'',closed:false,forceClose:false,searchTimer:null,drag:null,tokenCounts:new Map(),tokenTask:null,contentEditor:null,contentDiscardIntent:null,contentTokenTimer:null,entryMoveFeedbackTimer:null,guideOpen:false,guideScrollTop:0,guideReturnFocus:null,theme:DEFAULT_THEME,themePickerOpen:false,themeReturnFocus:null,keywordInternalPointer:false,nameClickGuard:null,popupDialog:null,mobileViewport:null,onMobileViewportChange:null,viewportBaselineHeight:0,viewportLastWidth:0,positionDraft:{type:'before_character_definition',depth:'4',role:'system'},orderDraft:{mode:'same',start:'100',gap:'10'},importDraft:{source:'',entries:null,selected:new Set(),previewed:new Set(),query:'',filter:'all',listScrollTop:0,loading:false,error:''},entryGroups:[],entryGroupBaseline:[],entryGroupDocument:null,entryGroupNameDraft:'',arrangeDraft:[],nameArrangeDraft:{mode:'position',direction:'asc'},arrangeInitialDraft:null,arrangeDrag:null,arrangeFlashIndex:null,arrangeFlashTimer:null,
    }}
    function requireDesktopSession(view){if(!view.uiSession||view.uiSession.adapterId!==adapterId)throw new Error('Wide UI requires its own session');return view.uiSession}
    function comboCount(view,groupId){
      if(groupId==='__all__')return view.working?.length||0;
      if(groupId==='__ungrouped__'){const grouped=new Set((view.entryGroups||[]).flatMap(group=>group.entryIds||[]));return (view.working||[]).filter(entry=>!grouped.has(entryId(entry))).length;}
      const group=(view.entryGroups||[]).find(candidate=>candidate.id===groupId);return group?entryGroupMembership(view.working,group).existingIds.length:0;
    }
    function renderHeader(view){
      const options=['<option value="">选择一本世界书</option>',...view.names.map(name=>optionHtml(name,name,view.book))].join('');
      const toolTitles={import:'从其他书导入',transfer:'转移到其他书',arrange:'整理规则设置'};
      const title=view.workspace==='search'?'查找与替换':view.workspace==='combos'?'快捷组合':view.workspace==='tools'?(toolTitles[view.toolTask]||'世界书观测台'):'世界书观测台';
      return `<div class="qa-desktop-title"><h2>${title}</h2><p>${view.loading?'正在读取…':view.book?escapeHtml(view.book):'PC 独立工作区'}</p></div><select class="qa-book-select" data-control="desktop-book" aria-label="选择世界书"${view.busy?' disabled':''}>${options}</select>`;
    }
    function renderLeft(view){
      const count=view.working?.length||0;
      const active=view.workspace==='search'?'search':view.workspace==='combos'?'combos':view.workspace==='tools'?view.toolTask:view.panel==='filters'?'filters':'entries';
      const allGroups=view.entryGroups||[],comboOverflow=allGroups.length>3,activeGroup=allGroups.find(group=>group.id===view.comboGroupId);
      let visibleGroups=view.comboNavExpanded||!comboOverflow?allGroups:allGroups.slice(0,3);
      if(!view.comboNavExpanded&&activeGroup&&!visibleGroups.some(group=>group.id===activeGroup.id))visibleGroups=[...allGroups.slice(0,2),activeGroup];
      const comboToggle=comboOverflow?`<button class="qa-combo-nav-toggle" data-action="desktop-combo-nav-toggle" aria-expanded="${view.comboNavExpanded}">${view.comboNavExpanded?'收起组合':`展开全部（剩余 ${allGroups.length-visibleGroups.length} 个）`}</button>`:'';
      const comboNav=view.workspace==='combos'?`<div class="qa-combo-nav${view.comboNavExpanded?' is-expanded':''}" aria-label="组合视图"><div class="qa-combo-nav-label">组合视图</div><button class="${view.comboGroupId==='__all__'?'is-active':''}" data-action="desktop-combo-group" data-group-id="__all__"><span>全部</span><span>${count}</span></button><button class="${view.comboGroupId==='__ungrouped__'?'is-active':''}" data-action="desktop-combo-group" data-group-id="__ungrouped__"><span>未分组</span><span>${comboCount(view,'__ungrouped__')}</span></button>${visibleGroups.map(group=>`<button class="${view.comboGroupId===group.id?'is-active':''}" data-action="desktop-combo-group" data-group-id="${escapeHtml(group.id)}" title="${escapeHtml(group.name)}"><span>${escapeHtml(group.name)}</span><span>${entryGroupMembership(view.working,group).existingIds.length}</span></button>`).join('')}${comboToggle}</div>`:'';
      const disabled=view.book?'':' disabled';
      const themes=[['fog-ink','青蓝','雾墨青蓝'],['wisteria-moon','烟粉','藤月烟粉'],['night-mist','墨紫','夜雾墨紫']].map(([id,short,label])=>`<button class="qa-theme-dot${view.theme===id?' is-active':''}" data-action="desktop-theme" data-theme="${id}" title="${label}" aria-label="切换为${label}" aria-pressed="${view.theme===id}">${short}</button>`).join('');
      return `<h3 class="qa-side-title">当前世界书</h3><div class="qa-side-stat">${count}</div><div class="qa-side-muted">${view.book?'条目':'尚未选择'}</div><div class="qa-side-block"><strong>${view.book?escapeHtml(view.book):'请选择世界书'}</strong><p class="qa-side-muted">单条编辑在卡片内完成；批量任务使用右侧工作台。</p></div><nav class="qa-desktop-nav" aria-label="PC 工作区"><button class="${active==='entries'?'is-active':''}" data-action="desktop-nav-entries">条目列表</button><button class="${active==='combos'?'is-active':''}" data-action="desktop-nav-combos"${disabled}>快捷组合</button>${comboNav}<button class="${active==='search'?'is-active':''}" data-action="desktop-nav-search"${disabled}>查找与替换</button><button class="${active==='filters'?'is-active':''}" data-action="desktop-filter-open"${disabled}>筛选</button><div class="qa-desktop-nav-section"><div class="qa-desktop-nav-label">快速排列</div><button class="qa-nav-action" data-action="desktop-arrange-position"${disabled}>按位置与顺序</button><button class="qa-nav-action" data-action="desktop-arrange-name" data-direction="asc"${disabled}>按名称 A → Z</button><button class="qa-nav-action" data-action="desktop-arrange-name" data-direction="desc"${disabled}>按名称 Z → A</button></div><div class="qa-desktop-nav-section"><div class="qa-desktop-nav-label">跨书</div><button class="${active==='import'?'is-active':''}" data-action="desktop-tool-open" data-tool="import"${disabled}>从其他书导入</button><button class="${active==='transfer'?'is-active':''}" data-action="desktop-tool-open" data-tool="transfer"${disabled}>转移到其他书</button></div><div class="qa-desktop-nav-section"><div class="qa-desktop-nav-label">本书</div><button class="${active==='arrange'?'is-active':''}" data-action="desktop-tool-open" data-tool="arrange"${disabled}>整理规则设置</button><button class="qa-nav-action" data-action="desktop-disable-recursion"${disabled}>禁止全部递归</button></div><div class="qa-desktop-nav-section"><div class="qa-desktop-nav-label">辅助</div><button class="qa-nav-aux" data-action="desktop-guide-open">功能简介</button><button class="qa-nav-aux" data-action="desktop-reload"${disabled}>重新读取当前书</button><button class="qa-nav-aux" data-action="desktop-fault-copy"${disabled}>复制故障信息</button><div class="qa-desktop-nav-label">界面配色</div><div class="qa-theme-choices" role="group" aria-label="界面配色">${themes}</div></div></nav>`;
    }
    function editorHtml(view,entry){
      const id=entryId(entry),pos=positionInfo(entry),keys=Array.isArray(entry?.strategy?.keys)?entry.strategy.keys.join('\n'):'';
      const positions=POSITION_TYPES.map(type=>optionHtml(type,POSITION_LABELS[type],pos.type)).join('');
      const roles=Object.entries(ROLE_LABELS).map(([role,label])=>optionHtml(role,label,pos.role||'system')).join('');
      const depthFields=pos.type==='at_depth'?`<label class="qa-field"><span>深度</span><input type="number" min="0" data-field="entry-depth" data-entry-id="${escapeHtml(id)}" value="${escapeHtml(pos.depth??4)}"></label><label class="qa-field"><span>角色</span><select data-field="entry-role" data-entry-id="${escapeHtml(id)}">${roles}</select></label>`:'';
      return `<div class="qa-card-editor"><div class="qa-editor-heading qa-field-wide"><strong>单条设置</strong><span>只修改当前条目</span></div><label class="qa-field qa-field-wide"><span>条目名称</span><input data-field="name" data-entry-id="${escapeHtml(id)}" value="${escapeHtml(entryName(entry))}"></label><div class="qa-inline-grid qa-field-wide${pos.type==='at_depth'?'':' is-basic'}"><label class="qa-field"><span>位置</span><select data-field="entry-position" data-entry-id="${escapeHtml(id)}">${positions}</select></label><label class="qa-field"><span>顺序</span><input type="number" data-field="entry-order" data-entry-id="${escapeHtml(id)}" value="${escapeHtml(pos.order??100)}"></label>${depthFields}</div><label class="qa-field qa-field-wide"><span>主关键词（每行一个）</span><textarea rows="3" data-field="keys" data-entry-id="${escapeHtml(id)}">${escapeHtml(keys)}</textarea></label><label class="qa-field qa-field-wide"><span>正文</span><textarea data-field="content" data-entry-id="${escapeHtml(id)}">${escapeHtml(entry?.content??'')}</textarea></label></div>`;
    }
    function cardHtml(view,entry,index){
      const id=entryId(entry),expanded=view.expanded.has(id),selected=view.selected.has(id),pos=positionInfo(entry);
      return `<article class="qa-desktop-card${selected?' is-selected':''}" data-entry-id="${escapeHtml(id)}"><div class="qa-card-summary"><input class="qa-card-check" type="checkbox" data-control="desktop-select" data-entry-id="${escapeHtml(id)}" aria-label="选择 ${escapeHtml(entryName(entry))}"${selected?' checked':''}><div class="qa-card-heading"><strong>${escapeHtml(entryName(entry))}</strong><span class="qa-card-meta">No.${index+1} · Token ${escapeHtml(tokenLabel(view,entry))} · ${escapeHtml(pos.label)} · 顺序 ${escapeHtml(pos.order??'—')} · ${entry.enabled===false?'停用':'启用'}</span></div><button class="qa-card-expand" data-action="desktop-expand" data-entry-id="${escapeHtml(id)}" aria-expanded="${expanded}" aria-label="${expanded?'收起':'展开'}条目">${expanded?'⌃':'⌄'}</button></div>${expanded?editorHtml(view,entry):''}</article>`;
    }
    function taskEntryRows(entries,draft,control,kind){
      return entries.map(entry=>{const id=entryId(entry),selected=draft.selected.has(id),expanded=draft.previewed.has(id),content=String(entry?.content??'').trim();return `<article class="qa-task-row${selected?' is-selected':''}"><input class="qa-card-check" type="checkbox" data-control="${control}" data-entry-id="${escapeHtml(id)}" aria-label="选择 ${escapeHtml(entryName(entry))}"${selected?' checked':''}><div class="qa-task-row-copy"><strong>${escapeHtml(entryName(entry))}</strong><small>UID ${escapeHtml(entry?._iwbOriginalUid??entry?.uid??'—')} · ${entry.enabled===false?'停用':'启用'}</small></div><button class="qa-task-preview-toggle" data-action="desktop-task-preview" data-kind="${kind}" data-entry-id="${escapeHtml(id)}" aria-expanded="${expanded}" aria-label="${expanded?'收起':'展开'}正文">${expanded?'⌃':'⌄'}</button>${expanded?`<div class="qa-task-preview">${content?escapeHtml(content):'正文为空'}</div>`:''}</article>`;}).join('');
    }
    function importTaskHtml(view){
      const draft=view.importDraft,sources=(view.names||[]).filter(name=>name&&name!==view.book),sourceOptions=['<option value="">选择来源世界书</option>',...sources.map(name=>optionHtml(name,name,draft.source))].join('');
      const entries=draft.entries?visibleImportEntries(view):[];
      const body=draft.loading?'<div class="qa-result-empty">正在读取来源书…</div>':draft.error?`<div class="qa-result-empty">${escapeHtml(draft.error)}</div>`:draft.source?(entries.length?taskEntryRows(entries,draft,'desktop-import-select','import'):'<div class="qa-result-empty">没有符合条件的来源条目。</div>'):'<div class="qa-result-empty">先选择一本来源世界书。</div>';
      return `<div class="qa-task-page"><div class="qa-task-toolbar"><label class="qa-field"><span>来源世界书</span><select data-control="desktop-import-source">${sourceOptions}</select></label><label class="qa-field"><span>筛选来源条目</span><input data-control="desktop-import-query" value="${escapeHtml(draft.query)}" placeholder="名称 / UID / 主关键词"></label><label class="qa-field"><span>状态</span><select data-control="desktop-import-filter"><option value="all"${draft.filter==='all'?' selected':''}>全部</option><option value="enabled"${draft.filter==='enabled'?' selected':''}>启用</option><option value="disabled"${draft.filter==='disabled'?' selected':''}>停用</option></select></label></div><div class="qa-task-list" data-slot="desktop-task-list">${body}</div></div>`;
    }
    function transferTaskHtml(view){
      const draft=view.transferDraft,entries=visibleTransferEntries(view);
      return `<div class="qa-task-page"><div class="qa-task-toolbar"><div class="qa-field"><span>来源世界书</span><strong>${escapeHtml(view.book)}</strong></div><label class="qa-field"><span>筛选当前条目</span><input data-control="desktop-transfer-query" value="${escapeHtml(draft.query)}" placeholder="名称 / UID / 主关键词"></label><label class="qa-field"><span>状态</span><select data-control="desktop-transfer-filter"><option value="all"${draft.filter==='all'?' selected':''}>全部</option><option value="enabled"${draft.filter==='enabled'?' selected':''}>启用</option><option value="disabled"${draft.filter==='disabled'?' selected':''}>停用</option></select></label></div><div class="qa-task-list" data-slot="desktop-task-list">${entries.length?taskEntryRows(entries,draft,'desktop-transfer-select','transfer'):'<div class="qa-result-empty">没有符合条件的条目。</div>'}</div></div>`;
    }
    function arrangeTaskHtml(view){
      const pref=normalizeNameArrangePreference(view.nameArrangeDraft),rows=(view.arrangeDraft||[]).map((rule,index)=>`<div class="qa-arrange-row"><div><strong>${escapeHtml(rule.label||rule.key)}</strong><div class="qa-side-muted">${rule.count??0} 条</div></div><select data-control="desktop-arrange-direction" data-index="${index}"><option value="asc"${rule.direction==='asc'?' selected':''}>顺序升序</option><option value="desc"${rule.direction==='desc'?' selected':''}>顺序降序</option></select><button data-action="desktop-arrange-track" data-index="${index}" data-direction="up"${index===0?' disabled':''}>上移</button><button data-action="desktop-arrange-track" data-index="${index}" data-direction="down"${index===(view.arrangeDraft.length-1)?' disabled':''}>下移</button></div>`).join('');
      return `<div class="qa-task-page"><div><h3>整理规则设置</h3><p class="qa-side-muted">选择按位置轨道整理，或忽略原生位置与顺序、直接按名称排列。设置本身保存在本机。</p><div class="qa-arrange-methods"><label class="qa-field"><span>整理方式</span><select data-control="desktop-arrange-method"><option value="position"${pref.mode==='position'?' selected':''}>位置与顺序</option><option value="name"${pref.mode==='name'?' selected':''}>名称</option></select></label><label class="qa-field"><span>名称排列</span><select data-control="desktop-name-arrange-direction"${pref.mode==='name'?'':' disabled'}><option value="asc"${pref.direction==='asc'?' selected':''}>A → Z</option><option value="desc"${pref.direction==='desc'?' selected':''}>Z → A</option></select></label></div></div><div class="qa-arrange-list"${pref.mode==='name'?' hidden':''}>${rows||'<div class="qa-result-empty">当前书没有可整理轨道。</div>'}</div></div>`;
    }
    function toolsPageHtml(view){if(view.toolTask==='import')return importTaskHtml(view);if(view.toolTask==='transfer')return transferTaskHtml(view);if(view.toolTask==='arrange')return arrangeTaskHtml(view);return '<div class="qa-desktop-empty">请从左侧选择一项任务。</div>'}
    function renderMain(view){
      if(view.error)return `<div class="qa-desktop-empty">${escapeHtml(view.error)}</div>`;
      if(view.loading)return '<div class="qa-desktop-empty">正在读取世界书…</div>';
      if(!view.book||!view.working)return '<div class="qa-desktop-empty">选择一本具体世界书开始编辑。</div>';
      if(view.workspace==='search')return searchPageHtml(view);
      if(view.workspace==='tools')return toolsPageHtml(view);
      const combos=view.workspace==='combos',entries=(combos?comboOrderedEntries(view):visibleEntries(view)).slice(0,view.renderLimit);
      if(!entries.length)return `<div class="qa-desktop-empty">${combos?'当前组合视图没有条目。':'当前世界书没有条目。'}</div>`;
      return `<div class="qa-desktop-list">${entries.map((entry,index)=>cardHtml(view,entry,combos?index:view.working.findIndex(candidate=>entryId(candidate)===entryId(entry)))).join('')}</div>`;
    }
    function searchResultsHtml(view){
      const results=searchWorkspaceResults(view),matches=results.reduce((sum,result)=>sum+result.count,0);
      const summary=`${results.length} 条结果${view.searchKind==='body'?` · ${matches} 处匹配`:''}`;
      const rows=results.slice(0,view.renderLimit).map(result=>`<article class="qa-search-result"><header><strong>${escapeHtml(entryName(result.entry))}</strong><small>UID ${escapeHtml(result.entry?._iwbOriginalUid??result.entry?.uid??'—')}${view.searchKind==='body'?` · ${result.count} 处`:''}</small></header><p>${escapeHtml(result.snippet)}</p></article>`).join('');
      const more=results.length>view.renderLimit?`<button data-action="desktop-more">继续显示（剩余 ${results.length-view.renderLimit} 条）</button>`:'';
      return `<section class="qa-search-results"><div class="qa-search-summary">${escapeHtml(summary)}</div>${rows||'<div class="qa-result-empty">输入查找内容后，这里显示匹配结果。</div>'}${more}</section>`;
    }
    function searchControlsHtml(view){
      const body=view.searchKind==='body',matches=searchWorkspaceResults(view).reduce((sum,result)=>sum+result.count,0);
      return `<div class="qa-search-toolbar${body?' is-body':''}"><div class="qa-task-tabs"><button class="${body?'':'is-active'}" data-action="desktop-search-kind" data-kind="metadata">条目</button><button class="${body?'is-active':''}" data-action="desktop-search-kind" data-kind="body">正文</button></div><label class="qa-field"><span>${body?'查找正文内容':'名称 / UID / 主关键词'}</span><input data-control="desktop-search-find" value="${escapeHtml(view.searchFind)}" placeholder="输入查找内容"></label>${body?`<label class="qa-field"><span>替换为</span><input data-control="desktop-search-replace" value="${escapeHtml(view.searchReplace)}" placeholder="留空表示删除匹配文字"></label><button class="qa-primary" data-action="desktop-search-replace"${!matches||view.busy?' disabled':''}>替换匹配结果（${matches} 处）</button>`:''}</div>`;
    }
    function searchPageHtml(view){return `<div class="qa-search-page">${searchControlsHtml(view)}<div data-slot="desktop-search-results">${searchResultsHtml(view)}</div></div>`}
    function searchWorkbenchHtml(view){
      const body=view.searchKind==='body',results=searchWorkspaceResults(view),matches=results.reduce((sum,result)=>sum+result.count,0);
      return `<div class="qa-workbench-head"><div class="qa-workbench-head-copy"><h3 class="qa-side-title">查找与替换</h3><div class="qa-side-muted">${body?'正文按字面匹配，只替换正文':'名称、UID 与主关键词'}</div></div><button data-action="desktop-search-back" aria-label="返回条目列表">×</button></div><div class="qa-side-block"><div class="qa-side-stat">${results.length}</div><div class="qa-side-muted">条结果${body?` · ${matches} 处匹配`:''}</div><p class="qa-side-muted">查找与替换输入位于中央结果区顶部。</p></div>`;
    }
    function filterWorkbenchHtml(view){
      const positions=POSITION_TYPES.map(type=>optionHtml(type,POSITION_LABELS[type],view.positionFilter)).join('');
      return `<div class="qa-workbench-head"><div class="qa-workbench-head-copy"><h3 class="qa-side-title">筛选</h3><div class="qa-side-muted">筛选只改变当前显示范围，不修改数据</div></div><button data-action="desktop-filter-close" aria-label="收起筛选">×</button></div><div class="qa-filter-fields"><label class="qa-field"><span>筛选条目</span><input data-control="desktop-filter-query" value="${escapeHtml(view.query)}" placeholder="名称 / UID / 主关键词"></label><label class="qa-field"><span>显示范围</span><select data-control="desktop-state-filter"><option value="all"${view.stateFilter==='all'?' selected':''}>全部</option><option value="selected"${view.stateFilter==='selected'?' selected':''}>仅已选</option><option value="changed"${view.stateFilter==='changed'?' selected':''}>仅已修改</option></select></label><label class="qa-field"><span>原生位置</span><select data-control="desktop-position-filter"><option value="all">全部位置</option>${positions}</select></label><button data-action="desktop-filter-clear">清除筛选</button></div>`;
    }
    function comboWorkbenchHtml(view){
      const groups=view.entryGroups||[],active=groups.find(group=>group.id===view.comboGroupId),selected=comboSelectedIds(view),target=view.comboTargetGroupId&&groups.some(group=>group.id===view.comboTargetGroupId)?view.comboTargetGroupId:groups[0]?.id||'';
      const create=`<div class="qa-side-block"><strong>新建组合</strong><div class="qa-work-fields"><label class="qa-field"><span>组合名称</span><input data-control="desktop-combo-name" maxlength="60" value="${escapeHtml(view.comboNameDraft)}" placeholder="输入组合名称"></label><button class="qa-primary" data-action="desktop-combo-create"${view.comboNameDraft.trim()?'':' disabled'}>${selected.length?`将已选 ${selected.length} 条存为组合`:'新建空组合'}</button></div></div>`;
      if(!active){
        const scope=view.comboGroupId==='__ungrouped__'?'未分组':'全部条目';
        const targetList=groups.map(group=>`<button class="qa-combo-target${target===group.id?' is-active':''}" data-action="desktop-combo-target" data-group-id="${escapeHtml(group.id)}" aria-pressed="${target===group.id}" title="${escapeHtml(group.name)}"><span>${escapeHtml(group.name)}</span><span>${entryGroupMembership(view.working,group).existingIds.length} 条</span></button>`).join('');
        const assign=!selected.length?`<div class="qa-side-block"><strong>加入组合</strong><p class="qa-combo-assign-hint">先在中间勾选条目，随后可将它们加入已有组合。</p></div>`:groups.length?`<div class="qa-side-block"><strong>将已选 ${selected.length} 条加入组合</strong><div class="qa-combo-target-list" role="listbox" aria-label="目标组合">${targetList}</div><button class="qa-primary qa-workbench-open" data-action="desktop-combo-add">加入所选 ${selected.length} 条</button></div>`:`<div class="qa-side-block"><strong>加入组合</strong><p class="qa-combo-assign-hint">还没有可加入的组合，请先在下方新建组合。</p></div>`;
        return `<div class="qa-workbench-head"><div class="qa-workbench-head-copy"><h3 class="qa-side-title">快捷组合</h3><div class="qa-side-muted">${scope} · 已选 ${selected.length} 条</div></div><button data-action="desktop-nav-entries" aria-label="返回条目列表">×</button></div>${assign}${create}`;
      }
      const membership=entryGroupMembership(view.working,active),index=groups.findIndex(group=>group.id===active.id);
      return `<div class="qa-workbench-head"><div class="qa-workbench-head-copy"><h3 class="qa-side-title">${escapeHtml(active.name)}</h3><div class="qa-side-muted">${membership.existingIds.length} 条${membership.missingCount?` · 缺少 ${membership.missingCount} 条`:''} · 已选 ${selected.length} 条</div></div><button data-action="desktop-nav-entries" aria-label="返回条目列表">×</button></div><div class="qa-combo-actions"><button data-action="desktop-combo-enabled" data-enabled="true">启用全组</button><button data-action="desktop-combo-enabled" data-enabled="false">停用全组</button><button data-action="desktop-combo-group-move" data-direction="up"${index<=0?' disabled':''}>组合上移</button><button data-action="desktop-combo-group-move" data-direction="down"${index>=groups.length-1?' disabled':''}>组合下移</button></div><div class="qa-side-block"><strong>成员排列</strong><div class="qa-combo-actions"><button data-action="desktop-combo-member-move" data-direction="top"${selected.length?'':' disabled'}>置顶</button><button data-action="desktop-combo-member-move" data-direction="up"${selected.length?'':' disabled'}>上移</button><button data-action="desktop-combo-member-move" data-direction="down"${selected.length?'':' disabled'}>下移</button><button data-action="desktop-combo-member-move" data-direction="bottom"${selected.length?'':' disabled'}>置底</button><button class="qa-wide" data-action="desktop-combo-remove"${selected.length?'':' disabled'}>移出本组（${selected.length}）</button></div></div><div class="qa-side-block"><strong>组合管理</strong><div class="qa-work-fields"><label class="qa-field"><span>名称</span><input data-control="desktop-combo-rename" maxlength="60" value="${escapeHtml(view.comboRenameDraft||active.name)}"></label><button data-action="desktop-combo-rename">重命名</button></div><button class="qa-danger qa-combo-danger" data-action="desktop-combo-delete">解散组合</button></div>${create}`;
    }
    function toolsWorkbenchHtml(view){
      const close=`<button data-action="desktop-nav-entries" aria-label="返回条目列表">×</button>`;
      if(view.toolTask==='import'){
        const draft=view.importDraft,visible=draft.entries?visibleImportEntries(view):[];
        return `<div class="qa-workbench-head"><div class="qa-workbench-head-copy"><h3 class="qa-side-title">从其他书导入</h3><div class="qa-side-muted">目标书：${escapeHtml(view.book)}</div></div>${close}</div><div class="qa-side-block"><div class="qa-side-stat">${draft.selected.size}</div><div class="qa-side-muted">条来源条目已选择</div><div class="qa-side-actions"><button data-action="desktop-import-select-visible"${visible.length?'':' disabled'}>选择当前结果</button><button data-action="desktop-import-clear"${draft.selected.size?'':' disabled'}>清空</button></div><button class="qa-primary qa-workbench-open" data-action="desktop-import-apply"${draft.selected.size&&!draft.loading?'':' disabled'}>导入当前书工作副本</button></div>`;
      }
      if(view.toolTask==='transfer'){
        const draft=view.transferDraft,targets=(view.names||[]).filter(name=>name&&name!==view.book),targetOptions=['<option value="">选择目标世界书</option>',...targets.map(name=>optionHtml(name,name,draft.target))].join('');
        return `<div class="qa-workbench-head"><div class="qa-workbench-head-copy"><h3 class="qa-side-title">转移到其他书</h3><div class="qa-side-muted">复制或移动所选条目</div></div>${close}</div><div class="qa-side-block"><div class="qa-side-stat">${draft.selected.size}</div><div class="qa-side-muted">条当前书条目已选择</div><label class="qa-field"><span>目标世界书</span><select data-control="desktop-transfer-target">${targetOptions}</select></label><div class="qa-side-actions"><button data-action="desktop-transfer-select-visible">选择当前结果</button><button data-action="desktop-transfer-clear"${draft.selected.size?'':' disabled'}>清空</button></div><div class="qa-side-actions"><button data-action="desktop-transfer-apply" data-mode="copy"${draft.selected.size&&draft.target&&!draft.loading?'':' disabled'}>复制</button><button data-action="desktop-transfer-apply" data-mode="move"${draft.selected.size&&draft.target&&!draft.loading?'':' disabled'}>移动</button></div><p class="qa-side-muted">所有修改先进入工作副本；保存时先写目标书，目标成功后才允许写来源书。</p></div>`;
      }
      if(view.toolTask==='arrange')return `<div class="qa-workbench-head"><div class="qa-workbench-head-copy"><h3 class="qa-side-title">整理规则设置</h3><div class="qa-side-muted">${view.arrangeDraft.length} 个位置轨道</div></div>${close}</div><div class="qa-side-block"><div class="qa-work-fields"><button data-action="desktop-arrange-reset">恢复默认规则</button><button data-action="desktop-arrange-save">仅保存设置</button><button class="qa-primary" data-action="desktop-arrange-save-apply">保存并整理</button></div><p class="qa-side-muted">“保存并整理”才会改变当前列表排列，并作为一次动作进入撤销。</p></div>`;
      return `<h3 class="qa-side-title">当前任务</h3><div class="qa-workbench-empty">请从左侧选择工作区。</div>`;
    }
    function renderRight(view){
      if(view.workspace==='search')return searchWorkbenchHtml(view);
      if(view.workspace==='combos')return comboWorkbenchHtml(view);
      if(view.workspace==='tools')return toolsWorkbenchHtml(view);
      if(view.panel==='filters')return filterWorkbenchHtml(view);
      const ids=[...view.selected];
      if(ids.length<2){
        const hint=ids.length===1?'已选 1 条。再选择 1 条后，批量操作会自动展开。':'选择至少 2 个条目后，这里会自动展开批量操作。';
        return `<h3 class="qa-side-title">批量操作</h3><div class="qa-workbench-empty">${hint}</div>`;
      }
      if(view.panel!=='selection')return `<div class="qa-workbench-head"><div class="qa-workbench-head-copy"><h3 class="qa-side-title">批量操作</h3><div class="qa-side-muted">已选 ${ids.length} 条，选择仍然保留</div></div></div><button class="qa-primary qa-workbench-open" data-action="desktop-workbench-open">打开批量操作（${ids.length}）</button>`;
      const positionOptions=POSITION_TYPES.map(type=>optionHtml(type,POSITION_LABELS[type],view.positionDraft.type)).join('');
      const roleOptions=Object.entries(ROLE_LABELS).map(([role,label])=>optionHtml(role,label,view.positionDraft.role)).join('');
      const selectedNames=ids.map(id=>view.working?.find(entry=>entryId(entry)===id)).filter(Boolean).map(entry=>entryName(entry));
      const namesHtml=selectedNames.slice(0,2).map(name=>`<li>${escapeHtml(name)}</li>`).join('')+(selectedNames.length>2?`<li>以及另外 ${selectedNames.length-2} 条</li>`:'');
      const depthControls=view.positionDraft.type==='at_depth'?`<div class="qa-work-row"><label class="qa-field"><span>深度</span><input type="number" min="0" data-draft="position-depth" value="${escapeHtml(view.positionDraft.depth)}"></label><label class="qa-field"><span>角色</span><select data-draft="position-role">${roleOptions}</select></label></div>`:'';
      return `<div class="qa-workbench-head"><div class="qa-workbench-head-copy"><h3 class="qa-side-title">批量操作</h3><div class="qa-side-muted">已选 ${ids.length} 条</div></div><button data-action="desktop-workbench-close" aria-label="收起批量操作">×</button></div><ul class="qa-selected-list">${namesHtml}</ul><div class="qa-side-actions"><button data-action="desktop-enabled" data-enabled="true">启用</button><button data-action="desktop-enabled" data-enabled="false">停用</button><button class="qa-wide" data-action="desktop-select-clear">清空选择</button></div><div class="qa-side-block"><strong>统一修改位置</strong><div class="qa-work-fields"><label class="qa-field"><span>位置</span><select data-draft="position-type">${positionOptions}</select></label>${depthControls}<button class="qa-primary" data-action="desktop-apply-position">应用到所选 ${ids.length} 条</button></div></div><div class="qa-side-block"><strong>统一修改顺序</strong><div class="qa-work-fields"><label class="qa-field"><span>顺序</span><input type="number" data-draft="order-start" value="${escapeHtml(view.orderDraft.start)}"></label><button class="qa-primary" data-action="desktop-apply-order">应用到所选 ${ids.length} 条</button></div></div>`;
    }
    function desktopFooterHtml(view){
      const summary=pendingSummary(view).text,dirty=isDirty(view);
      return `<span class="qa-pending">${escapeHtml(summary)}</span><div class="qa-foot-actions"><button data-action="desktop-undo"${view.undo.length&&!view.busy?'':' disabled'}>撤销</button><button data-action="desktop-discard"${dirty&&!view.busy?'':' disabled'}>放弃本轮调整</button><button class="qa-primary" data-action="desktop-save"${dirty&&!view.busy?'':' disabled'}>${view.busy==='save'?'保存中…':'保存全部'}</button></div>`;
    }
    function renderModal(view){
      if(view.discardConfirmOpen)return `<div class="qa-modal-card" role="dialog" aria-modal="true" aria-labelledby="qa-desktop-discard-title"><h3 id="qa-desktop-discard-title">放弃本轮调整？</h3><p>所有尚未保存的修改都会恢复到最近一次读取或保存的状态。</p><div class="qa-modal-actions"><button data-action="desktop-discard-cancel">取消</button><button class="qa-danger" data-action="desktop-discard-accept">确认放弃</button></div></div>`;
      if(view.leaveIntent)return `<div class="qa-modal-card" role="dialog" aria-modal="true" aria-labelledby="qa-desktop-leave-title"><h3 id="qa-desktop-leave-title">存在未保存修改</h3><p>${view.leaveError?escapeHtml(view.leaveError):'请先决定如何处理本轮修改。'}</p><div class="qa-modal-actions"><button data-action="desktop-leave-cancel">继续编辑</button><button class="qa-danger" data-action="desktop-leave-discard">不保存</button><button class="qa-primary" data-action="desktop-leave-save">保存后继续</button></div></div>`;
      if(view.guideOpen)return `<div class="qa-modal-card qa-guide-card" role="dialog" aria-modal="true" aria-labelledby="qa-desktop-guide-title"><header><h3 id="qa-desktop-guide-title">功能简介</h3><button data-action="desktop-guide-close" aria-label="关闭功能简介">×</button></header><div class="qa-guide-content"><section class="qa-guide-section"><h4>条目管理</h4><p>编辑条目名称、关键词、正文、启用状态、递归、位置、深度、角色与顺序。</p></section><section class="qa-guide-section"><h4>快捷组合</h4><p>建立和管理常用条目组合，并调整组合与成员排列。</p></section><section class="qa-guide-section"><h4>批量整理</h4><p>批量启停、修改位置与顺序，并按位置、顺序或名称整理列表。</p></section><section class="qa-guide-section"><h4>查找与替换</h4><p>查找名称、UID、关键词与正文，并替换正文中的匹配内容。</p></section><section class="qa-guide-section"><h4>跨书管理</h4><p>从其他世界书导入条目，或在世界书之间复制、移动条目。</p></section><section class="qa-guide-section"><h4>修改保护</h4><p>未保存修改保留在工作副本中，可撤销、放弃或统一保存。</p></section><section class="qa-guide-section qa-guide-about"><h4>关于</h4><p>世界书观测台 v${APP.version}｜三端适配｜作者：砚梨</p><p>相关项目：<a href="https://github.com/yanxu-orange/ST-Orange-Yancang" target="_blank" rel="noopener noreferrer">砚藏存卡 APK ↗</a> · <a href="https://github.com/yanxu-orange/ST-Orange-Lantai-Benmo" target="_blank" rel="noopener noreferrer">兰台记忆插件 ↗</a></p></section></div></div>`;
      return '';
    }
    function setHtml(view,slot,html){const node=view.root?.querySelector(`[data-slot="${slot}"]`);if(node)node.innerHTML=html}
    function refreshMain(view){setHtml(view,'scroll',renderMain(view))}
    function refreshSearchResults(view){const node=view.root?.querySelector('[data-slot="desktop-search-results"]');if(node)node.innerHTML=searchResultsHtml(view);else refreshMain(view)}
    function restoreMainScroll(view,scrollTop){Promise.resolve().then(()=>{const scroll=view.root?.querySelector('[data-slot="scroll"]');if(scroll)scroll.scrollTop=Number(scrollTop)||0;});}
    function captureTaskListScroll(view,draft){const list=view.root?.querySelector('[data-slot="desktop-task-list"]');draft.listScrollTop=Number(list?.scrollTop)||0;return draft.listScrollTop;}
    function restoreTaskListScroll(view,draft){Promise.resolve().then(()=>{const list=view.root?.querySelector('[data-slot="desktop-task-list"]');if(list)list.scrollTop=Number(draft.listScrollTop)||0;});}
    function refreshTaskKeepingScroll(view,draft){captureTaskListScroll(view,draft);refresh(view);restoreTaskListScroll(view,draft);}
    function updateSearchResults(view){
      refreshSearchResults(view);
      setHtml(view,'desktop-right',renderRight(view));
      const button=view.root?.querySelector('[data-action="desktop-search-replace"]');
      if(button){const matches=searchWorkspaceResults(view).reduce((sum,result)=>sum+result.count,0);button.textContent=`替换匹配结果（${matches} 处）`;button.disabled=!matches||Boolean(view.busy);}
    }
    async function loadDesktopImportSource(view,source){
      view.importDraft={source,entries:null,selected:new Set(),previewed:new Set(),query:'',filter:'all',listScrollTop:0,loading:Boolean(source),error:''};refresh(view);if(!source)return;
      try{const entries=await readWorldbookEntries(source);if(view.importDraft.source===source)view.importDraft.entries=entries;}
      catch(error){if(view.importDraft.source===source)view.importDraft.error=error instanceof Error?error.message:String(error);toast('error',error instanceof Error?error.message:String(error),'来源书读取失败');}
      finally{if(view.importDraft.source===source){view.importDraft.loading=false;refresh(view);}}
    }
    function refresh(view){
      if(!view?.root)return;
      if(tabletMode)view.root.classList.toggle('has-tablet-workbench',view.workspace!=='edit'||view.panel==='filters'||view.panel==='selection');
      setHtml(view,'desktop-header',renderHeader(view));setHtml(view,'desktop-left',renderLeft(view));setHtml(view,'scroll',renderMain(view));setHtml(view,'desktop-right',renderRight(view));setHtml(view,'desktop-footer',desktopFooterHtml(view));
      const modal=view.root.querySelector('[data-slot="desktop-modal"]');if(modal){modal.innerHTML=renderModal(view);modal.hidden=!view.discardConfirmOpen&&!view.leaveIntent&&!view.guideOpen;}
    }
    function mutateEntryFields(view,id,field,value){
      const labels={name:'编辑条目名称',keys:'编辑主关键词',content:'编辑条目正文','entry-position':'修改单条原生位置','entry-depth':'修改单条深度','entry-role':'修改单条深度角色','entry-order':'修改单条顺序'};
      if(field.startsWith('entry-'))return applyWorking(view,labels[field],()=>inlineFieldMutation(view.working,id,field,value));
      return applyWorking(view,labels[field],()=>{
        const next=cloneJson(view.working),entry=next.find(candidate=>entryId(candidate)===id);if(!entry)throw new Error('没有找到要编辑的条目。');
        if(field==='name')entry.name=String(value);
        else if(field==='content')entry.content=String(value);
        else if(field==='keys'){entry.strategy=entry.strategy&&typeof entry.strategy==='object'&&!Array.isArray(entry.strategy)?entry.strategy:{};entry.strategy.keys=String(value).split(/[\n,，]/).map(item=>item.trim()).filter(Boolean);}
        return next;
      });
    }
    function undo(view){const snapshot=view.undo.pop();if(!snapshot)return false;if(snapshot.kind==='transfer')restoreTransferSnapshot(view,snapshot);else view.working=cloneJson(snapshot.working);if(snapshot.entryGroups)view.entryGroups=cloneJson(snapshot.entryGroups);toast('info',`已撤销：${snapshot.label}`);refresh(view);return true}
    function discard(view){if(view.transferStates?.size)discardTransferChanges(view);else{view.working=cloneJson(view.baseline);view.undo=[];}view.entryGroups=cloneJson(view.entryGroupBaseline||[]);view.discardConfirmOpen=false;toast('info','已放弃本轮全部未保存修改。');refresh(view)}
    async function act(view,action,target){
      try{
        if(action==='desktop-expand'){const id=target.dataset.entryId;view.expanded.has(id)?view.expanded.delete(id):view.expanded.add(id);refresh(view);}
        else if(action==='desktop-task-preview'){
          const draft=target.dataset.kind==='import'?view.importDraft:view.transferDraft,id=target.dataset.entryId;if(!draft?.previewed||!id)return;
          captureTaskListScroll(view,draft);draft.previewed.has(id)?draft.previewed.delete(id):draft.previewed.add(id);refresh(view);restoreTaskListScroll(view,draft);
        }
        else if(action==='desktop-nav-entries'){const scroll=view.desktopReturnScroll;view.workspace='edit';view.panel=null;view.selected.clear();refresh(view);restoreMainScroll(view,scroll);}
        else if(action==='desktop-tool-open'){
          const tool=String(target.dataset.tool||'');if(!['import','transfer','arrange'].includes(tool)||!view.book||!view.working)return;view.desktopReturnScroll=view.root?.querySelector('[data-slot="scroll"]')?.scrollTop||0;view.workspace='tools';view.panel=null;view.toolTask=tool;view.selected.clear();
          if(view.toolTask==='arrange'){view.arrangeDraft=effectiveArrangeRules(view.working,loadArrangeRules(view.book));view.nameArrangeDraft=readNameArrangePreference(view);}refresh(view);
        }
        else if(action==='desktop-import-select-visible'){visibleImportEntries(view).forEach(entry=>view.importDraft.selected.add(entryId(entry)));refresh(view);}
        else if(action==='desktop-import-clear'){view.importDraft.selected.clear();refresh(view);}
        else if(action==='desktop-import-apply'){
          const ids=[...view.importDraft.selected],source=view.importDraft.entries||[];if(!ids.length)return;
          const result=importEntriesAtTop(view.working,source,ids);applyWorking(view,'从其他书导入条目',()=>result.entries);view.importDraft.selected.clear();toast('success',`已导入 ${result.importedIds.length} 条到当前书工作副本。`);refresh(view);
        }
        else if(action==='desktop-transfer-select-visible'){visibleTransferEntries(view).forEach(entry=>view.transferDraft.selected.add(entryId(entry)));refresh(view);}
        else if(action==='desktop-transfer-clear'){view.transferDraft.selected.clear();refresh(view);}
        else if(action==='desktop-transfer-apply'){
          view.transferDraft.loading=true;refresh(view);try{const result=await applyTransfer(view,target.dataset.mode,view.transferDraft.target);toast('success',`已${result.mode==='move'?'移动':'复制'} ${result.count} 条到《${result.targetName}》工作副本。`);}finally{view.transferDraft.loading=false;refresh(view);}
        }
        else if(action==='desktop-arrange-track'){const index=Number(target.dataset.index),direction=target.dataset.direction==='down'?1:-1,next=index+direction;if(index>=0&&next>=0&&next<view.arrangeDraft.length){const [rule]=view.arrangeDraft.splice(index,1);view.arrangeDraft.splice(next,0,rule);refresh(view);}}
        else if(action==='desktop-arrange-reset'){view.arrangeDraft=defaultArrangeRules(view.working);view.nameArrangeDraft={mode:'position',direction:'asc'};refresh(view);}
        else if(action==='desktop-arrange-save'){saveNameArrangePreference(view);saveArrangeRules(view.book,view.arrangeDraft);toast('success','已保存本书整理设置，列表排列未改变。');refresh(view);}
        else if(action==='desktop-arrange-save-apply'){const pref=saveNameArrangePreference(view);saveArrangeRules(view.book,view.arrangeDraft);applyWorking(view,pref.mode==='name'?'按名称整理列表排列':'按本书设置整理列表排列',()=>pref.mode==='name'?arrangeNamesByDirection(view.working,pref.direction):stableAutoArrange(view.working,view.arrangeDraft),{noOpMessage:'当前列表已经符合整理设置。'});refresh(view);}
        else if(action==='desktop-disable-recursion'){applyWorking(view,'禁止本书全部递归',()=>disableAllRecursion(view.working));}
        else if(action==='desktop-reload'){if(view.book&&!showLeavePrompt(view,{kind:'switch',book:view.book},refresh))await loadBook(view,view.book);}
        else if(action==='desktop-fault-copy'){const copied=await faultReportCopy(view);copied?toast('success','故障信息已复制。'):toast('error','无法自动复制故障信息，请换用支持剪贴板的页面。','故障信息');}
        else if(action==='desktop-guide-open'){view.guideOpen=true;refresh(view);}
        else if(action==='desktop-guide-close'){view.guideOpen=false;refresh(view);}
        else if(action==='desktop-theme'){applyTheme(view,String(target.dataset.theme||DEFAULT_THEME));refresh(view);}
        else if(action==='desktop-nav-combos'){if(view.book&&view.working){view.desktopReturnScroll=view.root?.querySelector('[data-slot="scroll"]')?.scrollTop||0;view.workspace='combos';view.panel=null;view.comboGroupId='__all__';view.comboNameDraft='';view.comboRenameDraft='';view.comboTargetGroupId=view.entryGroups?.[0]?.id||'';view.comboNavExpanded=false;view.selected.clear();view.renderLimit=APP.chunkSize;refresh(view);}}
        else if(action==='desktop-combo-nav-toggle'){view.comboNavExpanded=!view.comboNavExpanded;refresh(view);}
        else if(action==='desktop-combo-group'){const id=String(target.dataset.groupId||'__all__');if(id==='__all__'||id==='__ungrouped__'||view.entryGroups.some(group=>group.id===id)){view.comboGroupId=id;view.comboRenameDraft=view.entryGroups.find(group=>group.id===id)?.name||'';view.selected.clear();view.renderLimit=APP.chunkSize;refresh(view);}}
        else if(action==='desktop-combo-target'){const id=String(target.dataset.groupId||'');if(view.entryGroups.some(group=>group.id===id)){view.comboTargetGroupId=id;refresh(view);}}
        else if(action==='desktop-combo-create'){const ids=comboSelectedIds(view),result=createEntryGroupWithMembers(view,view.comboNameDraft,ids);view.comboGroupId=result.group.id;view.comboNameDraft='';view.comboRenameDraft=result.group.name;view.comboTargetGroupId=result.group.id;view.selected.clear();toast('success',`已创建组合“${result.group.name}”。`);refresh(view);}
        else if(action==='desktop-combo-add'){const ids=comboSelectedIds(view),groupId=view.comboTargetGroupId||view.entryGroups[0]?.id;if(ids.length&&groupId&&addEntriesToGroup(view,groupId,ids,false)){view.selected.clear();toast('info',`已将 ${ids.length} 条加入组合。`);refresh(view);}}
        else if(action==='desktop-combo-remove'){const ids=comboSelectedIds(view);if(ids.length&&addEntriesToGroup(view,view.comboGroupId,ids,true)){view.selected.clear();refresh(view);}}
        else if(action==='desktop-combo-enabled'){setEntryGroupEnabled(view,view.comboGroupId,target.dataset.enabled==='true',current=>refresh(current));}
        else if(action==='desktop-combo-rename'){if(renameEntryGroup(view,view.comboGroupId,view.comboRenameDraft)){toast('info','已重命名组合。');refresh(view);}}
        else if(action==='desktop-combo-delete'){const removed=deleteEntryGroupFromView(view,view.comboGroupId);if(removed){view.comboGroupId='__all__';view.comboRenameDraft='';view.selected.clear();toast('info',`已解散组合“${removed.name}”。`);refresh(view);}}
        else if(action==='desktop-combo-group-move'){if(moveEntryGroupByDirection(view,view.comboGroupId,target.dataset.direction)){refresh(view);}}
        else if(action==='desktop-combo-member-move'){const ids=comboSelectedIds(view);if(ids.length&&moveComboSelection(view,ids,target.dataset.direction)){refresh(view);}}
        else if(action==='desktop-nav-search'){if(view.book&&view.working){view.desktopReturnScroll=view.root?.querySelector('[data-slot="scroll"]')?.scrollTop||0;view.workspace='search';view.panel=null;view.searchFind=view.searchFind||view.query||'';view.renderLimit=APP.chunkSize;refresh(view);}}
        else if(action==='desktop-search-back'){const scroll=view.desktopReturnScroll;view.workspace='edit';view.panel=null;refresh(view);restoreMainScroll(view,scroll);}
        else if(action==='desktop-search-kind'){view.searchKind=target.dataset.kind==='body'?'body':'metadata';view.renderLimit=APP.chunkSize;refresh(view);}
        else if(action==='desktop-search-replace'){if(replaceBodySearchResults(view))refresh(view);}
        else if(action==='desktop-filter-open'){if(view.book&&view.working){view.workspace='edit';view.panel='filters';refresh(view);}}
        else if(action==='desktop-filter-close'){view.panel=null;refresh(view);}
        else if(action==='desktop-filter-clear'){view.query='';view.stateFilter='all';view.positionFilter='all';view.renderLimit=APP.chunkSize;refresh(view);}
        else if(action==='desktop-arrange-position'){applyWorking(view,'按位置与顺序整理列表排列',()=>stableAutoArrange(view.working,loadArrangeRules(view.book)),{noOpMessage:'当前列表已经符合位置与顺序规则。'});}
        else if(action==='desktop-arrange-name'){const direction=target.dataset.direction==='desc'?'desc':'asc';applyWorking(view,direction==='desc'?'按名称 Z 到 A 整理列表排列':'按名称 A 到 Z 整理列表排列',()=>arrangeNamesByDirection(view.working,direction),{noOpMessage:'当前列表已经符合名称排列。'});}
        else if(action==='desktop-more'){view.renderLimit+=APP.chunkSize;view.workspace==='search'?refreshSearchResults(view):refreshMain(view);}
        else if(action==='desktop-workbench-close'){view.panel=null;view.selectionWorkbenchDismissed=true;refresh(view);}
        else if(action==='desktop-workbench-open'){if(view.selected.size>=2){view.panel='selection';view.selectionWorkbenchDismissed=false;refresh(view);}}
        else if(action==='desktop-select-clear'){view.selected.clear();view.panel=null;view.selectionWorkbenchDismissed=false;refresh(view);}
        else if(action==='desktop-enabled'){batchSetEnabledSelected(view,target.dataset.enabled==='true',current=>refresh(current));}
        else if(action==='desktop-apply-position'){const depth=Number(view.positionDraft.depth);applyWorking(view,'批量修改原生位置',()=>mutatePosition(view.working,[...view.selected],view.positionDraft.type,depth,view.positionDraft.role));}
        else if(action==='desktop-apply-order'){applyWorking(view,'批量修改顺序',()=>mutateOrder(view.working,[...view.selected],'same',Number(view.orderDraft.start),0));}
        else if(action==='desktop-undo')undo(view);
        else if(action==='desktop-discard'){if(isDirty(view)&&!view.busy){view.discardConfirmOpen=true;refresh(view);}}
        else if(action==='desktop-discard-cancel'){view.discardConfirmOpen=false;refresh(view);}
        else if(action==='desktop-discard-accept'){if(view.discardConfirmOpen&&isDirty(view)&&!view.busy)discard(view);}
        else if(action==='desktop-save')await saveAll(view);
        else if(action==='desktop-leave-cancel')cancelLeavePrompt(view,refresh);
        else if(action==='desktop-leave-discard')await completeLeave(view,false,{loadBook,renderLeaveModal:refresh});
        else if(action==='desktop-leave-save')await completeLeave(view,true,{saveAll,loadBook,renderLeaveModal:refresh});
      }catch(error){toast('error',error instanceof Error?error.message:String(error),'操作失败');refresh(view);}
    }
    function bind(view,resources){
      resources.listen(view.root,'click',event=>{const target=event.target?.closest?.('[data-action]');if(target)void act(view,target.dataset.action,target);});
      resources.listen(view.root,'change',event=>{const target=event.target;
        if(target?.dataset?.control==='desktop-book'){const requested=String(target.value||'');if(!requested||requested===view.book)return;if(!showLeavePrompt(view,{kind:'switch',book:requested},refresh)){view.comboGroupId='__all__';view.comboNameDraft='';view.comboRenameDraft='';view.comboTargetGroupId='';view.comboNavExpanded=false;view.workspace='edit';view.toolTask='';view.importDraft={source:'',entries:null,selected:new Set(),previewed:new Set(),query:'',filter:'all',listScrollTop:0,loading:false,error:''};void loadBook(view,requested);}}
        else if(target?.dataset?.control==='desktop-select'){const previousSize=view.selected.size,id=target.dataset.entryId;target.checked?view.selected.add(id):view.selected.delete(id);if(view.workspace==='combos'){view.panel=null;}else{const nextSize=view.selected.size;if(nextSize<2){view.panel=null;view.selectionWorkbenchDismissed=false;}else if(previousSize<2&&!view.selectionWorkbenchDismissed)view.panel='selection';}refresh(view);}
        else if(target?.dataset?.control==='desktop-import-source'){void loadDesktopImportSource(view,String(target.value||''));}
        else if(target?.dataset?.control==='desktop-import-select'){const id=target.dataset.entryId;target.checked?view.importDraft.selected.add(id):view.importDraft.selected.delete(id);refreshTaskKeepingScroll(view,view.importDraft);}
        else if(target?.dataset?.control==='desktop-import-filter'){view.importDraft.filter=['enabled','disabled'].includes(target.value)?target.value:'all';refresh(view);}
        else if(target?.dataset?.control==='desktop-transfer-select'){const id=target.dataset.entryId;target.checked?view.transferDraft.selected.add(id):view.transferDraft.selected.delete(id);refreshTaskKeepingScroll(view,view.transferDraft);}
        else if(target?.dataset?.control==='desktop-transfer-filter'){view.transferDraft.filter=['enabled','disabled'].includes(target.value)?target.value:'all';refresh(view);}
        else if(target?.dataset?.control==='desktop-transfer-target'){view.transferDraft.target=String(target.value||'');refresh(view);}
        else if(target?.dataset?.control==='desktop-arrange-direction'){const index=Number(target.dataset.index);if(view.arrangeDraft[index])view.arrangeDraft[index].direction=target.value==='desc'?'desc':'asc';refresh(view);}
        else if(target?.dataset?.control==='desktop-arrange-method'){view.nameArrangeDraft=normalizeNameArrangePreference({...view.nameArrangeDraft,mode:target.value});refresh(view);}
        else if(target?.dataset?.control==='desktop-name-arrange-direction'){view.nameArrangeDraft=normalizeNameArrangePreference({...view.nameArrangeDraft,direction:target.value});refresh(view);}
        else if(target?.dataset?.control==='desktop-state-filter'){view.stateFilter=['selected','changed'].includes(target.value)?target.value:'all';view.renderLimit=APP.chunkSize;refresh(view);}
        else if(target?.dataset?.control==='desktop-position-filter'){view.positionFilter=POSITION_TYPES.includes(target.value)?target.value:'all';view.renderLimit=APP.chunkSize;refresh(view);}
        else if(target?.dataset?.field)mutateEntryFields(view,target.dataset.entryId,target.dataset.field,target.value);
        else if(target?.dataset?.draft){const key=target.dataset.draft;if(key==='position-type')view.positionDraft.type=target.value;else if(key==='position-depth')view.positionDraft.depth=target.value;else if(key==='position-role')view.positionDraft.role=target.value;else if(key==='order-start')view.orderDraft.start=target.value;refresh(view);}
      });
      resources.listen(view.root,'input',event=>{const target=event.target,control=target?.dataset?.control;
        if(control==='desktop-filter-query'){view.query=String(target.value||'');resources.timeout('desktop-filter-query',()=>{view.renderLimit=APP.chunkSize;refreshMain(view);},180);}
        else if(control==='desktop-search-find'){view.searchFind=String(target.value||'');resources.timeout('desktop-search-find',()=>{view.renderLimit=APP.chunkSize;updateSearchResults(view);},180);}
        else if(control==='desktop-search-replace')view.searchReplace=String(target.value??'');
        else if(control==='desktop-import-query'){view.importDraft.query=String(target.value||'');view.importDraft.listScrollTop=0;resources.timeout('desktop-import-query',()=>refresh(view),120);}
        else if(control==='desktop-transfer-query'){view.transferDraft.query=String(target.value||'');view.transferDraft.listScrollTop=0;resources.timeout('desktop-transfer-query',()=>refresh(view),120);}
        else if(control==='desktop-combo-name'){view.comboNameDraft=String(target.value??'').slice(0,60);const button=view.root?.querySelector('[data-action="desktop-combo-create"]');if(button){button.disabled=!view.comboNameDraft.trim();button.textContent=comboSelectedIds(view).length?`将已选 ${comboSelectedIds(view).length} 条存为组合`:'新建空组合';}}
        else if(control==='desktop-combo-rename')view.comboRenameDraft=String(target.value??'').slice(0,60);
      });
    }
    function mount(view,popup,resources){
      view.root=popup.dlg?.querySelector('#iwb-qa-root');if(!view.root)throw new Error('原生弹窗已打开，但未找到 PC 编辑容器。');
      view.popup=popup;view.popupDialog=popup.dlg||null;applyTheme(view,readThemePreference(),false);requireDesktopSession(view);bind(view,resources);refresh(view);return true;
    }
    function unmount(view){view.popupDialog=null;view.popup=null;view.root=null}
    async function canClose(view){if(view.guideOpen){view.guideOpen=false;refresh(view);return false;}if(view.busy)return false;if(view.forceClose||!isDirty(view))return true;showLeavePrompt(view,{kind:'close'},refresh);return false}
    const parts={list:refresh,panel:refresh,workspacePanel:refresh,footer:refresh,leaveModal:refresh,action:act,bind:()=>{},syncFooterState:refresh,syncTopControls:refresh};
    const adapter={id:adapterId,createState:createDesktopViewState,template:templateHtml,mount,refresh,canClose,unmount,parts};
    if(typeof TEST_MODE!=='undefined'&&TEST_MODE)adapter.inspection=Object.freeze({DESKTOP_STYLES,createDesktopViewState,renderHeader,renderLeft,renderMain,renderRight,desktopFooterHtml,renderModal,cardHtml,editorHtml,searchResultsHtml,searchControlsHtml,searchPageHtml,searchWorkbenchHtml,filterWorkbenchHtml});
    return Object.freeze(adapter);
  }
  function createTabletUiAdapter(ports) {
    const TABLET_STYLES=String.raw`
#iwb-qa-root.qa-tablet-root{width:calc(100dvw - 16px);height:min(940px,calc(100dvh - 48px));max-height:calc(100dvh - 48px);font-size:15px}
.iwb-qa-host{width:calc(100dvw - 12px)!important;max-width:calc(100dvw - 12px)!important;padding:0!important;overflow:visible!important}
#iwb-qa-root.qa-tablet-root button{min-height:44px;padding:9px 12px;touch-action:manipulation}
#iwb-qa-root.qa-tablet-root input,#iwb-qa-root.qa-tablet-root select{min-height:44px}
#iwb-qa-root.qa-tablet-root .qa-desktop-shell{grid-template-columns:minmax(150px,180px) minmax(0,1fr) minmax(220px,260px)}
#iwb-qa-root.qa-tablet-root .qa-desktop-left,#iwb-qa-root.qa-tablet-root .qa-desktop-right{padding:14px}
#iwb-qa-root.qa-tablet-root .qa-desktop-head{padding:14px 16px;gap:12px}
#iwb-qa-root.qa-tablet-root .qa-desktop-main{padding:14px 16px;scrollbar-gutter:auto}
#iwb-qa-root.qa-tablet-root .qa-desktop-foot{padding:10px 16px}
#iwb-qa-root.qa-tablet-root .qa-card-summary{grid-template-columns:38px minmax(0,1fr) 44px;padding:12px}
#iwb-qa-root.qa-tablet-root .qa-card-check{width:24px;height:24px}
#iwb-qa-root.qa-tablet-root .qa-card-expand{width:44px;min-width:44px;min-height:44px}
#iwb-qa-root.qa-tablet-root .qa-card-editor{grid-template-columns:1fr;gap:12px}
#iwb-qa-root.qa-tablet-root .qa-field-wide{grid-column:auto}
#iwb-qa-root.qa-tablet-root .qa-inline-grid{grid-template-columns:minmax(150px,1fr) repeat(3,minmax(68px,92px))}
#iwb-qa-root.qa-tablet-root .qa-inline-grid.is-basic{grid-template-columns:minmax(150px,1fr) minmax(68px,92px)}
#iwb-qa-root.qa-tablet-root .qa-field textarea{min-height:180px}
#iwb-qa-root.qa-tablet-root .qa-search-toolbar,#iwb-qa-root.qa-tablet-root .qa-search-toolbar.is-body{grid-template-columns:1fr;margin:-14px -16px 0;padding:12px 16px}
#iwb-qa-root.qa-tablet-root .qa-search-toolbar.is-body .qa-primary{grid-column:auto}
#iwb-qa-root.qa-tablet-root .qa-task-toolbar{grid-template-columns:minmax(150px,1fr) minmax(150px,1fr);margin:-14px -16px 0;padding:12px 16px}
#iwb-qa-root.qa-tablet-root .qa-task-toolbar>*:last-child{grid-column:1/-1}
#iwb-qa-root.qa-tablet-root .qa-arrange-row{grid-template-columns:minmax(0,1fr) 110px auto}
@media (max-width:767px){
  #iwb-qa-root.qa-tablet-root{width:calc(100dvw - 8px);height:calc(100dvh - 32px);max-height:calc(100dvh - 32px)}
  #iwb-qa-root.qa-tablet-root .qa-desktop-shell{position:relative;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);grid-template-areas:"nav" "main"}
  #iwb-qa-root.qa-tablet-root .qa-desktop-left{grid-area:nav;padding:8px 10px;overflow:hidden;border-bottom:1px solid var(--iwb-line)}
  #iwb-qa-root.qa-tablet-root .qa-desktop-left>h3,#iwb-qa-root.qa-tablet-root .qa-desktop-left>.qa-side-stat,#iwb-qa-root.qa-tablet-root .qa-desktop-left>.qa-side-muted,#iwb-qa-root.qa-tablet-root .qa-desktop-left>.qa-side-block{display:none}
  #iwb-qa-root.qa-tablet-root .qa-desktop-nav{display:flex;gap:6px;margin:0;padding:0;border:0;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:thin}
  #iwb-qa-root.qa-tablet-root .qa-desktop-nav>button,#iwb-qa-root.qa-tablet-root .qa-desktop-nav-section{flex:0 0 auto}
  #iwb-qa-root.qa-tablet-root .qa-desktop-nav-section{display:flex;gap:6px;margin:0;padding:0;border:0}
  #iwb-qa-root.qa-tablet-root .qa-desktop-nav-label,#iwb-qa-root.qa-tablet-root .qa-theme-choices{display:none}
  #iwb-qa-root.qa-tablet-root .qa-combo-nav{flex:0 0 min(320px,75vw);display:flex;margin:0;padding:0;border:0;overflow-x:auto}
  #iwb-qa-root.qa-tablet-root .qa-combo-nav-label{display:none}
  #iwb-qa-root.qa-tablet-root .qa-combo-nav button{flex:0 0 auto}
  #iwb-qa-root.qa-tablet-root .qa-desktop-center{grid-area:main;border:0}
  #iwb-qa-root.qa-tablet-root .qa-desktop-right{display:none;position:absolute;z-index:12;inset:auto 0 0 0;width:auto;height:min(46%,380px);padding:16px;border-top:1px solid var(--iwb-line);box-shadow:0 -12px 30px #0003}
  #iwb-qa-root.qa-tablet-root.has-tablet-workbench .qa-desktop-right{display:block}
  #iwb-qa-root.qa-tablet-root .qa-desktop-head{align-items:stretch;flex-direction:column;padding:10px 12px}
  #iwb-qa-root.qa-tablet-root .qa-book-select{width:100%}
  #iwb-qa-root.qa-tablet-root .qa-desktop-main{padding:10px 12px}
  #iwb-qa-root.qa-tablet-root .qa-inline-grid,#iwb-qa-root.qa-tablet-root .qa-inline-grid.is-basic{grid-template-columns:1fr 1fr}
  #iwb-qa-root.qa-tablet-root .qa-desktop-foot{align-items:stretch;flex-direction:column;gap:6px;padding:8px 12px}
  #iwb-qa-root.qa-tablet-root .qa-foot-actions{display:grid;grid-template-columns:repeat(3,1fr)}
  #iwb-qa-root.qa-tablet-root .qa-task-toolbar{grid-template-columns:1fr}
  #iwb-qa-root.qa-tablet-root .qa-task-toolbar>*:last-child{grid-column:auto}
  #iwb-qa-root.qa-tablet-root .qa-arrange-row{grid-template-columns:minmax(0,1fr) auto auto}
}
`;
    return createDesktopUiAdapter(ports,{id:'tablet-v1',mode:'tablet',extraStyles:TABLET_STYLES});
  }
  // Selection uses the host viewport BEFORE Popup/center layout changes it.
  // Preserve the existing phone boundary; >480 remains explicit old compatibility.
  function readObserverOpeningWidth() {
    const outer=hostWindow();
    for(const value of [outer.innerWidth,outer.document?.documentElement?.clientWidth,outer.visualViewport?.width]) {
      const width=Number(value);if(Number.isFinite(width)&&width>0)return width;
    }
    return 0;
  }
  function observerUiKind(width) {
    if(Number.isFinite(width)&&width>0&&width<=480)return 'mobile';
    if(Number.isFinite(width)&&width>=1025)return 'desktop';
    if(Number.isFinite(width)&&width>=481&&width<=1024)return 'tablet';
    return 'compat';
  }
  function prepareObserverUi(width=readObserverOpeningWidth()) {
    const kind=observerUiKind(width);
    const adapter=kind==='mobile'?createMobileUiAdapter(createMobileServicePort()):kind==='tablet'?createTabletUiAdapter(createTabletServicePort()):kind==='desktop'?createDesktopUiAdapter(createDesktopServicePort()):createLegacyUiAdapter();
    const view=kind==='mobile'||kind==='tablet'||kind==='desktop'?adapter.createState():createLegacyViewState();
    view.layoutAtOpen=Object.freeze({kind,width});
    view.uiSession=createUiSession(view,adapter);
    return view;
  }
  function finalizeView(view) {
    if (!view || view.closed) return;
    view.closed = true;
    const errors = [];
    try {
      if (view.uiSession) errors.push(...view.uiSession.dispose());
      else releaseLegacyUi(view); // Explicit legacy view without a mounted session.
    } catch (error) { errors.push(error); }
    try { view.root?.remove(); } catch (error) { errors.push(error); }
    if (currentView === view) currentView = null;
    if (errors.length) console.warn('[世界书观测台] UI cleanup errors', errors);
  }

  async function openObserver() {
    if (currentView && !currentView.closed) return;
    const api = sillyTavernApi();
    if (!api?.Popup || !api?.POPUP_TYPE) throw new Error('当前环境没有提供 SillyTavern.Popup 稳定接口。');
    const doc = hostDocument();
    const view = prepareObserverUi();
    const holder = doc.createElement('div');
    holder.innerHTML = view.uiSession.template();
    const displayType = api.POPUP_TYPE.DISPLAY ?? api.POPUP_TYPE.TEXT;
    view.popup = new api.Popup(holder.firstElementChild.outerHTML, displayType, '', {
      okButton: false, cancelButton: false, wide: true, wider: true, large: true, transparent: true,
      allowHorizontalScrolling: false, allowVerticalScrolling: false, leftAlign: true,
      allowEscapeClose: true,
      onClosing: () => view.uiSession.canClose(),
      onOpen: async popup => {
        if (view.closed) return;
        popup.dlg?.classList.add('iwb-qa-host');
        if (!view.uiSession.mount(popup)) return;
        view.uiSession.refresh({ list: true });
        try { await readNames(view); }
        catch (error) {
          if (view.closed) return;
          view.error = error instanceof Error ? error.message : String(error);
          view.uiSession.refresh({ list: true });
        }
      },
      onClose: async () => finalizeView(view),
    });
    currentView = view;
    try {
      Promise.resolve(view.popup.show()).catch(error => {
        finalizeView(view);
        toast('error', error instanceof Error ? error.message : String(error), '打开失败');
      });
    } catch (error) { finalizeView(view); throw error; }
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
    uiPresentationParts: createLegacyUiParts(),
    toastComboCreated, captureComboNavScroll, restoreComboNavScroll, reorderComboGroups, startComboNavDrag, moveComboNavDrag, endComboNavDrag, mobileComboHeaderHtml, normalizeNameArrangePreference, nameArrangeScope, readNameArrangePreference, saveNameArrangePreference, arrangeNamesByDirection, nameArrangeSettingsHtml, comboDensityHtml, comboManagementHtml, isWideDesktopLayout, syncWideDesktopWorkbench, searchWorkspaceActive, textOccurrenceCount, searchWorkspaceResults, openSearchWorkspace, closeSearchWorkspace, searchWorkspaceHeaderHtml, searchWorkspaceResultHtml, replaceBodySearchResults, updateBodySearchInput, searchSafetyFooterHtml,
    moveComboSelection, comboWorkspaceActive, comboOrderedEntries, openComboWorkspace, closeComboWorkspace, comboWorkspaceHeaderHtml, addEntriesToGroup, reorderComboMembers, moveComboMember, comboCardContextHtml, comboAssignmentHtml, comboSelectedIds, startDrag, updateDragDropTarget, endDrag,
    isDirty, saveAll, saveAllWithGroups, worldbookIsDirty, groupRelationsDirty, ensureGroupWorkingCopy, applyGroupRelations, renameEntryGroup, replaceGroupMembers, readGroupDocument, groupMemberReference, inheritCopiedGroupMembers, syncDeletedGroupMembers, handleAction, mobileFooterHtml, mobileBatchPanelHtml, openMobileCombos, workbenchStyles: MOBILE_WORKBENCH_STYLES, mobileEntryCardHtml, mobileCardFieldsHtml, mobileCardEditorHtml, commitCardContentInput, cardStyles: MOBILE_CARD_STYLES, cloneJson, entryId, decodeEntryId, assertUniqueEntries, positionInfo, moveEntries, dropEntries, plainEntry, mixedEntry, mixedGroups, mixedDirtyBooks, mixedSlotSequence, defaultMixedSlots, resolveMixedSlots, refreshMixedBookIndexes, effectiveMixedArrangeRules, arrangeMixedWorking, loadMixedArrangeRules, saveMixedArrangeRules, initializeMixedWorking, reflowMixedHardGroups, copyMixedEntry, dedupeActiveSources, sourceLabel, activeSourceText, selectorSourceLabel, selectorSourceLabels, bookSelectorLabel, selectorPrimarySourceRank, bookSelectorGroups, bookSelectorOptionsHtml, refreshBookCatalog, bookPickerMatches, bookPickerItemHtml, bookPickerResultsHtml, bookPickerTriggerLabel, renderBookPickerResults, renderBookOptions, closeBookPicker, toggleBookPicker, requestBookSwitch, selectedGlobalSourcesFromDom, collectWorldInfoEvidence, sourcesFromWorldInfoEvidence, discoverActiveBooks, compareMixedEntries, rebuildMixedBaseline, mixedChangedIds, singleChangeSummary, pendingSummary, mobilePendingSummary, pendingChangeCount, inlineFieldMutation, commitInlineField,
    mutatePosition, mutateOrder, changedIds, jsonText, jsonStructurallyEqual, inactiveCharacterFilter, postSaveWorldbookEquivalent, persistWorkingCopy, primaryKeys, visibleEntries, hasActiveListFilters, listSelectionScope, selectListScope, listContextHtml,
    allocateUidFromUsedKeys, importEntriesAtTop, normalizeEntryGroups, readEntryGroupStore, entryGroupBookKey, loadEntryGroups, saveEntryGroups, upsertEntryGroup, removeEntryGroup, entryGroupMembership, createOrUpdateEntryGroup, saveEditedEntryGroup, selectEntryGroup, setEntryGroupEnabled, entryGroupIdSets, groupModeFilterIds, groupModeBarHtml, batchSetEnabledEntries, batchSetEnabledSelected, batchDeleteEntries, batchDeleteSelected, transferEntriesAtTop, transferDirtyBooks, transferSnapshot, restoreTransferSnapshot, discardTransferChanges, visibleTransferEntries, transferWorkspaceHtml, applyTransfer, saveTransfer, createTransferDraft, captureTransferListScroll, restoreTransferListScroll, renderTransferSelection, isLockedTransferBookControl, blockTransferBookControl, arrangeTrack, discoverArrangeTracks, defaultArrangeRules, loadArrangeRules, saveArrangeRules, effectiveArrangeRules, stableAutoArrange, stableNameArrange, disableAllRecursion, recursionStatusHtml, visibleImportEntries, importResultsHtml,
    editableActivationType, enabledPresentation, parsePrimaryKeys, normalizePrimaryKeys, mergePrimaryKeys, removePrimaryKey, allocateUid, createMinimalEntry, copyEntry, mutateEntry,
    computeDragAutoScrollSpeed, templateHtml, STYLES, applyWorkingQuiet, toggleEnabledInPlace, compactPositionLabel, compactSummary,
    contentPreviewText, createContentEditorState, applyContentDraft, contentEditorChanged, contentEditorTitleHtml, contentEditorKeysHtml, sourcePreviewRow, renderImportSelection, toggleSourcePreview, arrangeDraftChanged, moveArrangeDraft, resetArrangeDraft, syncArrangeResetButton, renderArrangeDraft, clearArrangeDragFeedback, flashArrangeTrack, clearEntryDragFeedback, markEntryDragSource, clearEntryMoveFeedback, flashMovedEntries, moveModeLabel, anchoredScrollTop, nameButtonHtml, canEditTitle, isDesktopLayout, startNameEdit, finishNameEdit, bindView, inlineFieldsHtml, keywordEditorContents, guideHtml, editorHtml, cardHtml, renderPanel, importWorkspaceHtml, footerHtml, leaveModalHtml, discardConfirmHtml, renderLeaveModal, showLeavePrompt, cancelLeavePrompt, completeLeave, syncTopControls, cancelActivePanel, clearImportSelection, cancelImportWorkspace, loadBook, renderDynamic,
  });
  if (TEST_MODE) {
    globalThis.__IWB_QA_MOBILE_TEST_API__ = Object.freeze({createMobileUiAdapter,createMobileServicePort,readObserverOpeningWidth,observerUiKind});
    globalThis.__IWB_QA_DESKTOP_TEST_API__ = Object.freeze({createDesktopUiAdapter,createDesktopServicePort});
    globalThis.__IWB_QA_TABLET_TEST_API__ = Object.freeze({createTabletUiAdapter,createTabletServicePort});
    globalThis.__IWB_QA_TEST_API__ = TEST_API;
    globalThis.__IWB_QA_ENTRY_ENABLED_TEST_API__ = Object.freeze({ runSetEntriesEnabled, legacyEntryDataPort });
    globalThis.__IWB_FAULT_REPORT_TEST_API__ = Object.freeze({ faultReportHashText, faultReportCanonical, faultReportSummary, faultReportDiff, faultReportStart, faultReportMutation, faultReportCaptureDrafts, faultReportExport });
    globalThis.__IWB_QA_LIFECYCLE_TEST_API__ = Object.freeze({
      createUiResources, createUiSession, createLegacyUiAdapter, ensureLegacyUiSession,
      createLegacyViewState, legacyCanClose, prepareObserverUi, openObserver, finalizeView,
      installMobileViewport, removeMobileViewport, scheduleTokenCounts, updateContentEditorToken,
      scheduleContentEditorToken, scheduleSearch, readNames, legacyUiFrame,
      getCurrentView: () => currentView,
    });
    return;
  }

  registerButton(true);
  if (typeof $ === 'function') $(() => registerButton(false));
  else if (hostDocument().readyState === 'loading') hostDocument().addEventListener('DOMContentLoaded', () => registerButton(false), { once: true });
  else registerButton(false);
})();
