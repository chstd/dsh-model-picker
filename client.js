/**
 * dsh-model-picker — browser half.
 *
 * One composer control for provider / model / reasoning effort: a small trigger
 * in the composer tool row and, while open, a portalled two-column popover
 * (providers left, models right) with a discrete effort slider underneath.
 *
 * It renders over the shared per-session model directory (`ctx.modelDirectories`),
 * the same object the shipped `/model` popup and the replaced seat read, so a
 * switch made here and a switch made through `/model` stay consistent. The
 * catalog and the selection mutation stay Host-owned: this file never builds a
 * Remote call and never caches catalog data.
 *
 * Plain JavaScript: no JSX, no build step, no Harness client package import.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-model-picker',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');

    const h = React.createElement;
    const {
      useCallback,
      useEffect,
      useLayoutEffect,
      useMemo,
      useRef,
      useState,
      useSyncExternalStore,
    } = React;

    /** The composer seat this entry replaces (single slot; a dynamic entry wins). */
    const SLOT = 'conversation.input.model';

    /** Catalog id of the DeepSeek account provider, whose display name is localized. */
    const ACCOUNT_PROVIDER = 'deepseek-account';

    /** Snapshot used before a directory exists, so the hook always reads a stable object. */
    const EMPTY_STATE = Object.freeze({
      current: null,
      routable: null,
      groups: [],
      failures: [],
      status: 'idle',
      pending: null,
      error: null,
    });

    /** Locale snapshot used while the locale service is absent. */
    const NULL_LOCALE = Object.freeze({ active: 'en', locales: [], revision: 0 });

    // Everything the picker says lives here; the active locale picks the table.
    const COPY = {
      en: {
        selectModel: 'Select model',
        unavailable: 'Model selection is unavailable in this chat',
        loading: 'Loading…',
        dialogLabel: 'Model and reasoning effort',
        providerCaption: 'Provider',
        providerAccount: 'DeepSeek Account',
        providersFailed: 'Some providers failed to load',
        searchPlaceholder: 'Search models',
        noModels: 'No models',
        noResults: 'Nothing found',
        retry: 'Retry',
        loadFailed: 'The model catalog could not be loaded',
        effortLabel: 'Effort',
        effortDefault: 'Default',
        sessionInUse: 'This chat is held by another DSH window',
        rejected: 'The selection was rejected',
      },
      ru: {
        selectModel: 'Выберите модель',
        unavailable: 'Выбор модели недоступен в этом чате',
        loading: 'Загрузка…',
        dialogLabel: 'Модель и усилие рассуждений',
        providerCaption: 'Провайдер',
        providerAccount: 'DeepSeek Аккаунт',
        providersFailed: 'Часть провайдеров не загрузилась',
        searchPlaceholder: 'Поиск моделей',
        noModels: 'Нет моделей',
        noResults: 'Ничего не найдено',
        retry: 'Повторить',
        loadFailed: 'Не удалось загрузить каталог моделей',
        effortLabel: 'Усилие',
        effortDefault: 'По умолчанию',
        sessionInUse: 'Этот чат занят другим окном DSH',
        rejected: 'Выбор отклонён',
      },
      zh: {
        selectModel: '选择模型',
        unavailable: '此会话无法选择模型',
        loading: '加载中…',
        dialogLabel: '模型与推理强度',
        providerCaption: '提供方',
        providerAccount: 'DeepSeek 账号',
        providersFailed: '部分提供方加载失败',
        searchPlaceholder: '搜索模型',
        noModels: '没有可用模型',
        noResults: '未找到匹配项',
        retry: '重试',
        loadFailed: '无法加载模型目录',
        effortLabel: '强度',
        effortDefault: '默认',
        sessionInUse: '该会话正被另一个 DSH 窗口占用',
        rejected: '选择被拒绝',
      },
    };

    /** No-op used wherever a subscription or handler is optional. */
    function noop() {}

    /**
     * Normalize a locale id to the three copy tables.
     * @param {string} id - locale id such as `ru`, `ru-RU` or `zh-Hans`.
     * @returns {'en'|'ru'|'zh'} table key.
     */
    function localeTag(id) {
      const tag = String(id || '').toLowerCase();
      if (tag.startsWith('ru')) return 'ru';
      if (tag.startsWith('zh')) return 'zh';
      return 'en';
    }

    /**
     * Pick the copy table for the active locale; never throws.
     * @param {string} id - locale id.
     * @returns {object} copy table.
     */
    function pickCopy(id) {
      return COPY[localeTag(id)] || COPY.en;
    }

    /**
     * Resolve a catalog badge text, which is either a literal or a per-locale map.
     * @param {string|object} text - badge text from the catalog.
     * @param {string} tag - normalized locale tag.
     * @returns {string} text to display, or an empty string.
     */
    function resolveBadgeText(text, tag) {
      if (typeof text === 'string') return text;
      if (text && typeof text === 'object') {
        if (typeof text[tag] === 'string') return text[tag];
        if (typeof text.en === 'string') return text.en;
        const values = Object.keys(text);
        for (let index = 0; index < values.length; index += 1) {
          if (typeof text[values[index]] === 'string') return text[values[index]];
        }
      }
      return '';
    }

    /**
     * Rank one model name against a query: prefix first, then an ordered
     * subsequence match, then no match. Catalog order breaks every tie.
     * @param {string} name - model name.
     * @param {string} query - lowercased, trimmed query.
     * @returns {number} 0 for no match, 1 for a prefix match, 2 for a subsequence match.
     */
    function matchRank(name, query) {
      if (!query) return 1;
      const haystack = String(name || '').toLowerCase();
      if (haystack.startsWith(query)) return 1;
      let cursor = 0;
      for (let index = 0; index < haystack.length && cursor < query.length; index += 1) {
        if (haystack[index] === query[cursor]) cursor += 1;
      }
      return cursor === query.length ? 2 : 0;
    }

    /**
     * Filter and order one provider's models for the search field.
     * @param {Array} models - catalog models in catalog order.
     * @param {string} rawQuery - current query text.
     * @returns {Array} models to render, catalog order preserved inside each rank.
     */
    function rankModels(models, rawQuery) {
      const source = Array.isArray(models) ? models : [];
      const query = String(rawQuery || '').trim().toLowerCase();
      if (!query) return source.slice();
      const scored = [];
      for (let index = 0; index < source.length; index += 1) {
        const model = source[index];
        const rank = matchRank(model && model.name, query);
        if (rank > 0) scored.push({ model, rank, index });
      }
      scored.sort((left, right) => left.rank - right.rank || left.index - right.index);
      return scored.map((entry) => entry.model);
    }

    /**
     * Provider label for display; the account provider is localized.
     * @param {object|null} group - provider group.
     * @param {object} copy - active copy table.
     * @returns {string} label.
     */
    function providerLabel(group, copy) {
      if (!group) return '';
      if (group.id === ACCOUNT_PROVIDER) return copy.providerAccount;
      return group.name || group.id;
    }

    /**
     * Caption for the effort part of the trigger.
     * @param {object|null} model - current catalog model.
     * @param {object|null} current - current selection.
     * @param {object} copy - active copy table.
     * @returns {string} effort name, or an empty string when the model has no reasoning metadata.
     */
    function effortCaption(model, current, copy) {
      const reasoning = model && model.reasoning;
      if (!reasoning) return '';
      const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
      const selected = current && current.reasoningEffort !== undefined
        ? current.reasoningEffort
        : reasoning.defaultEffort;
      if (selected !== undefined && selected !== null) {
        for (let index = 0; index < efforts.length; index += 1) {
          const level = efforts[index];
          if (level && level.id === selected && level.name) return level.name;
        }
        if (typeof selected === 'string') return selected;
      }
      return copy.effortDefault;
    }

    /**
     * Progress stops for one model's effort block: advertised levels in order,
     * preceded by a provider-default stop when the model declares no default.
     * @param {object|null} reasoning - model reasoning metadata.
     * @param {object} copy - active copy table.
     * @returns {Array<{id: (string|undefined), name: string}>} stops.
     */
    function effortLevelsOf(reasoning, copy) {
      if (!reasoning) return [];
      const advertised = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
      const levels = [];
      if (reasoning.defaultEffort === undefined || reasoning.defaultEffort === null) {
        levels.push({ id: undefined, name: copy.effortDefault });
      }
      for (let index = 0; index < advertised.length; index += 1) {
        const level = advertised[index];
        if (level && typeof level.id === 'string') {
          levels.push({ id: level.id, name: level.name || level.id });
        }
      }
      return levels;
    }

    /**
     * Whether two selections point at the same provider, model and effort.
     * @param {object|null} left - first selection.
     * @param {object|null} right - second selection.
     * @returns {boolean} true when both carry the same values.
     */
    function sameSelection(left, right) {
      if (!left || !right) return false;
      if (left.provider !== right.provider || left.model !== right.model) return false;
      return (left.reasoningEffort === undefined ? undefined : left.reasoningEffort)
        === (right.reasoningEffort === undefined ? undefined : right.reasoningEffort);
    }

    /**
     * Build the selection for one result entry. The provider comes from the entry
     * itself, so a row found across providers selects its own provider. A switch
     * keeps the current reasoning level when the target model advertises it and
     * otherwise falls back to the model's declared default.
     * @param {string} providerId - provider owning the chosen model.
     * @param {object} model - catalog model entry.
     * @param {object|null} current - current selection.
     * @returns {{provider: string, model: string, reasoningEffort?: string}} selection.
     */
    function buildSelection(providerId, model, current) {
      const selection = { provider: providerId, model: model.id };
      const reasoning = model.reasoning;
      if (!reasoning) return selection;
      const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
      const carried = current && typeof current.reasoningEffort === 'string' ? current.reasoningEffort : undefined;
      if (carried !== undefined && efforts.some((level) => level && level.id === carried)) {
        selection.reasoningEffort = carried;
      } else if (reasoning.defaultEffort !== undefined) {
        selection.reasoningEffort = reasoning.defaultEffort;
      }
      return selection;
    }

    /** Two-column glyph shown in the compact trigger. */
    function ColumnGlyph() {
      return h(
        'svg',
        {
          className: 'dmp-trigger-glyph dmp_triggerIcon',
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', {
          x: 1.5, y: 2.5, width: 5, height: 11, rx: 1.5,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.2,
        }),
        h('rect', {
          x: 9.5, y: 2.5, width: 5, height: 11, rx: 1.5,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.2,
        }),
        h('circle', { cx: 4, cy: 6, r: 1, fill: 'currentColor' }),
      );
    }

    /** Disclosure chevron of the trigger. */
    function Chevron() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M4 6.5 L8 10.5 L12 6.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /** Check mark of the active provider or model row. */
    function Check() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M3 8.5 L6.4 12 L13 4.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /** Dotted activity glyph shown on a row whose selection is in flight. */
    function PendingDots() {
      return h('span', { className: 'dmp-dots', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'));
    }

    /** Structure-only stylesheet; every colour travels through a theme token. */
    const CSS = `
/*
 * Marker wrapper for the stock mobile selector CSS: its rules match
 * a class containing "_root" and align the seat at the composer's
 * right edge. This rule only keeps the desktop layout unchanged;
 * alignment belongs to that plugin.
 */
.dmp_model_root { display: flex; min-width: 0; align-items: center; }
/*
 * Touch/tablet alignment. The stock mobile rules only align a picker that is
 * a DIRECT child of trailing; ours sits inside standardControls. These scoped
 * rules mirror that alignment, but only fire when .dmp_model_root is mounted.
 */
[data-phase] [class*="_card"]:has(textarea, [data-composer-input]) [class*="_row"]:has([class*="_trailing"]):has(.dmp_model_root) > [class*="_trailing"] {
  justify-content: flex-end;
}
[data-phase] [class*="_card"]:has(textarea, [data-composer-input]) [class*="_row"]:has([class*="_trailing"]):has(.dmp_model_root) > [class*="_trailing"] > :first-child {
  margin-left: auto;
}
[data-phase] [class*="_card"]:has(textarea, [data-composer-input]) [class*="_row"]:has([class*="_trailing"]):has(.dmp_model_root) > [class*="_trailing"]:not(:has([class*="_trigger"][aria-haspopup="menu"])) > [class*="_primary"] {
  margin-left: 0;
}
[data-phase] [class*="_card"]:has(textarea, [data-composer-input]) [class*="_row"]:has([class*="_trailing"]):has(.dmp_model_root) [class*="_standardControls"]:has(> .dmp_model_root) {
  flex: none;
  min-width: 0;
}
.dmp-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 360px;
  height: 34px;
  margin: 0;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
  border-radius: 18px;
  background: var(--dsw-specific-selector, var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14)));
  color: var(--dsw-alias-label-secondary, #8b8f98);
  font: inherit;
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  cursor: pointer;
  outline: none;
}
@media (hover: hover) {
  .dmp-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-accent, rgba(128,128,128,.18)); }
}
.dmp-trigger:focus-visible { box-shadow: inset 0 0 0 2px var(--dsw-alias-brand-primary, #4176e6); }
.dmp-trigger.dmp-quiet:focus-visible { box-shadow: none; }
.dmp-trigger:disabled { color: var(--dsw-alias-label-dimmed, rgba(128,128,128,.7)); cursor: default; }
.dmp-trigger-label {
  display: var(--dsh-composer-model-text-display, block);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dmp-trigger-effort {
  display: var(--dsh-composer-model-text-display, block);
  min-width: 0;
  flex-shrink: 1000;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary, #8b8f98));
}
.dmp-trigger-glyph { display: var(--dsh-composer-model-icon-display, none); flex: none; }
.dmp-chevron { flex: none; color: var(--dsw-alias-label-caption, #8b8f98); }
.dmp-spinner {
  width: 12px;
  height: 12px;
  flex: none;
  border: 1.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
  border-top-color: var(--dsw-alias-state-business-primary, #4176e6);
  border-radius: 50%;
  animation: dmp-spin .8s linear infinite;
}
.dmp-popover {
  position: fixed;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 4px;
  overflow: hidden;
  color: var(--dsw-alias-label-primary, #e6e8ec);
  background: var(--dsw-alias-bg-layer-1, #232325);
  border: 1px solid var(--dsw-alias-border-inverted, rgba(255,255,255,.06));
  border-radius: 12px;
  box-shadow:
    0 0 1px 0 rgba(0,0,0,.2),
    0 0 4px 0 rgba(0,0,0,.02),
    0 12px 32px 0 rgba(0,0,0,.08);
}
.dmp-searchbar {
  display: flex;
  flex: none;
  padding: 6px 8px;
}
.dmp-body {
  display: flex;
  flex-direction: row;
  flex: 1;
  min-height: 0;
}
.dmp-left {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 208px;
  min-height: 0;
  box-sizing: border-box;
  padding: 0;
  border-right: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));
}
.dmp-caption {
  flex: none;
  padding: 4px 6px 6px;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9));
}
.dmp-group-caption { padding: 6px 7px 2px; }
.dmp-providers {
  display: flex;
  flex-direction: column;
  gap: 0;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.dmp-provider-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  box-sizing: border-box;
  min-height: 32px;
  margin: 0;
  padding: 4px 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  text-align: left;
  cursor: pointer;
  outline: none;
}
.dmp-provider-row[aria-current='true'] { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14)); }
.dmp-provider-row:focus-visible { box-shadow: inset 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6)); }
@media (hover: hover) {
  .dmp-provider-row:hover:not([aria-current='true']) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
}
.dmp-provider-row.dmp-provider-failed { color: var(--dsw-alias-label-dimmed, rgba(128,128,128,.7)); cursor: default; }
.dmp-provider-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dmp-check { display: grid; flex: 0 0 14px; place-items: center; color: var(--dsw-alias-label-primary, inherit); }
.dmp-warning {
  flex: none;
  padding: 4px 6px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-warn-label, #d97706));
}
.dmp-right {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 0;
}
.dmp-right-head { display: flex; flex-direction: column; flex: none; gap: 2px; padding: 0 2px 4px; }
.dmp-right-caption {
  padding: 2px 5px 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 22px;
  color: var(--dsw-alias-label-primary, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dmp-search {
  box-sizing: border-box;
  width: 100%;
  margin: 0;
  padding: 6px 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  outline: none;
}
@media (pointer: coarse) {
  .dmp-search { font-size: 16px; }
}
.dmp-search::placeholder { color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9)); }
.dmp-search:focus-visible { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dmp-models {
  display: flex;
  flex-direction: column;
  gap: 0;
  flex: 1;
  min-height: 0;
  padding: 2px 0;
  overflow-y: auto;
}
/*
 * Scrollbars: a 12px gutter whose thumb is inset to 6px and drawn at low
 * contrast, so the list reads as a clean edge while staying easy to grab.
 * The standard scrollbar-width/color properties are deliberately not set:
 * while they are present the browser ignores these pseudo-elements.
 */
.dmp-providers::-webkit-scrollbar,
.dmp-models::-webkit-scrollbar { width: 12px; height: 12px; }
.dmp-providers::-webkit-scrollbar-track,
.dmp-models::-webkit-scrollbar-track { background: transparent; }
.dmp-providers::-webkit-scrollbar-thumb,
.dmp-models::-webkit-scrollbar-thumb {
  min-height: 40px;
  border: 3px solid transparent;
  border-radius: 999px;
  background-color: rgba(128, 128, 128, .26);
  background-color: color-mix(in srgb, var(--dsw-alias-scrollbar-bg-l2, #545557) 62%, transparent);
  background-clip: padding-box;
}
.dmp-providers::-webkit-scrollbar-thumb:hover,
.dmp-models::-webkit-scrollbar-thumb:hover {
  background-color: rgba(128, 128, 128, .42);
  background-color: color-mix(in srgb, var(--dsw-alias-scrollbar-hover-l2, #65676b) 78%, transparent);
}
.dmp-providers::-webkit-scrollbar-thumb:active,
.dmp-models::-webkit-scrollbar-thumb:active {
  background-color: rgba(128, 128, 128, .55);
  background-color: color-mix(in srgb, var(--dsw-alias-scrollbar-hover-l2, #65676b) 92%, transparent);
}
.dmp-providers::-webkit-scrollbar-button,
.dmp-models::-webkit-scrollbar-button { display: none; }
.dmp-providers::-webkit-scrollbar-corner,
.dmp-models::-webkit-scrollbar-corner { background: transparent; }
.dmp-model-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  box-sizing: border-box;
  min-height: 32px;
  margin: 0;
  padding: 4px 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  text-align: left;
  cursor: pointer;
  outline: none;
}
.dmp-model-row[data-highlight='true'] { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dmp-model-row:focus-visible { box-shadow: inset 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6)); }
.dmp-model-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dmp-badge {
  flex: none;
  padding: 0 5px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary, #8b8f98);
  font-size: 10px;
  line-height: 14px;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.dmp-status {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9));
}
.dmp-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  flex: none;
  margin: 2px 2px 4px;
  padding: 6px 7px;
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(220,60,60,.12));
  color: var(--dsw-alias-state-error-primary, #e5484d);
  font-size: 11px;
  line-height: 16px;
}
.dmp-error-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dmp-retry {
  flex: none;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.dmp-retry:focus-visible { outline: none; text-decoration: underline; }
.dmp-effort {
  flex: none;
  margin-top: 4px;
  padding: 8px 6px 4px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));
}
.dmp-effort-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 14px;
  line-height: 22px;
}
.dmp-effort-label { flex: none; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9)); }
.dmp-effort-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, inherit);
}
.dmp-slider { padding: 12px 6px 14px; outline: none; }
.dmp-slider:focus-visible .dmp-rail {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6));
}
.dmp-rail {
  position: relative;
  height: 10px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l2, rgba(128,128,128,.35));
  cursor: pointer;
  touch-action: none;
}
/*
 * The gradient is painted across the whole track and clipped to the settled
 * level, so the colour at one stop never depends on how far the fill reaches:
 * the first stop is always the low end of the ramp, the last is always the high.
 */
.dmp-fill {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background-image: linear-gradient(90deg,
    var(--dsw-static-green-500, #22c55e) 0%,
    var(--dsw-static-deepseek-400, #7aaaff) 100%);
  clip-path: inset(0 calc(100% - var(--dmp-pct, 0%)) 0 0);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .2);
  pointer-events: none;
}
.dmp-thumb {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  box-sizing: border-box;
  border-radius: 50%;
  border: 2px solid var(--dsw-alias-state-business-primary, #4176e6);
  background: var(--dsw-alias-bg-layer-1, #232325);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .4);
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.dmp-stop {
  position: absolute;
  top: 50%;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-label-dimmed, rgba(128,128,128,.6));
  /* The 10px rail leaves a 2px gradient rim around the 6px stop at every side. */
  left: clamp(5px, var(--dmp-stop-left, 0%), calc(100% - 5px));
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.dmp-dots { display: inline-flex; align-items: center; gap: 2px; }
.dmp-dots span {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  animation: dmp-dot 1.1s ease-in-out infinite;
}
.dmp-dots span:nth-child(2) { animation-delay: .15s; }
.dmp-dots span:nth-child(3) { animation-delay: .3s; }
@keyframes dmp-spin { to { transform: rotate(360deg); } }
@keyframes dmp-dot { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .dmp-spinner, .dmp-dots span { animation: none; }
}
`;

    /**
     * Active copy table, refreshed when the locale service changes.
     * `ctx.get('locale')` may be absent; the English table is then used and the
     * subscription falls back to a no-op.
     * @param {object} ctx - client plugin context.
     * @returns {{copy: object, tag: string}} copy table and normalized locale tag.
     */
    function useLocaleCopy(ctx) {
      const face = useMemo(() => {
        try {
          const locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
          if (!locale || typeof locale.getSnapshot !== 'function' || typeof locale.subscribe !== 'function') {
            return null;
          }
          return locale;
        } catch (error) {
          return null;
        }
      }, [ctx]);
      const subscribe = useCallback((onChange) => (face ? face.subscribe(onChange) : noop), [face]);
      const read = useCallback(() => (face ? face.getSnapshot() : NULL_LOCALE), [face]);
      const snapshot = useSyncExternalStore(subscribe, read, read);
      const id = snapshot && typeof snapshot.active === 'string'
        ? snapshot.active
        : (snapshot && typeof snapshot.id === 'string' ? snapshot.id : '');
      const tag = localeTag(id);
      return { copy: COPY[tag] || COPY.en, tag };
    }

    /**
     * Resolve this session's shared model directory.
     * A session without a binding (or a missing service) resolves to `null` and
     * the trigger degrades to a disabled placeholder instead of throwing.
     * @param {object} ctx - client plugin context.
     * @param {string|null} sessionId - owning session.
     * @returns {{directory: object|null, reason: (string|null)}} directory and the reason it is missing.
     */
    function useDirectory(ctx, sessionId) {
      return useMemo(() => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return { directory: null, reason: 'no-session' };
        }
        let service = null;
        try {
          service = ctx && typeof ctx.get === 'function' ? ctx.get('modelDirectories') : null;
        } catch (error) {
          service = null;
        }
        if (!service) service = (ctx && ctx.modelDirectories) || null;
        if (!service || typeof service.directoryFor !== 'function') {
          return { directory: null, reason: 'no-service' };
        }
        try {
          const directory = service.directoryFor(sessionId);
          if (!directory || !directory.store
            || typeof directory.store.getSnapshot !== 'function'
            || typeof directory.store.subscribe !== 'function'
            || typeof directory.load !== 'function'
            || typeof directory.select !== 'function') {
            return { directory: null, reason: 'no-binding' };
          }
          return { directory, reason: null };
        } catch (error) {
          return { directory: null, reason: 'no-binding' };
        }
      }, [ctx, sessionId]);
    }

    /**
     * Client plugin context captured by `apply`. A bundle owns exactly one client
     * plugin context; the seat reads the locale service and the model directory
     * service from it, and registration happens after this is assigned.
     */
    let activeContext = null;

    /**
     * Entry point of the seat: an addressed subagent session has no independent
     * model-selection contract, so the picker renders nothing there (the shipped
     * seat does the same). The check sits before any directory resolution.
     * @param {object} props - slot props.
     * @returns {object|null} the picker, or null for a subagent session.
     */
    function Picker(props) {
      const useSession = typeof props.useSession === 'function' ? props.useSession : null;
      const subagent = useSession ? useSession((session) => (session ? session.subagent : null)) : null;
      if (subagent) return null;
      return h(PickerBody, {
        sessionId: props.sessionId,
        locked: props.locked === true,
      });
    }

    /**
     * The trigger and the popover.
     * @param {object} props - session id and the owner's locked flag.
     * @returns {object} rendered seat.
     */
    function PickerBody(props) {
      const sessionId = props.sessionId;
      const locked = props.locked;
      const { copy, tag } = useLocaleCopy(activeContext);
      const resolution = useDirectory(activeContext, sessionId);
      const directory = resolution.directory;
      const store = directory ? directory.store : null;

      const subscribe = useCallback((onChange) => (store ? store.subscribe(onChange) : noop), [store]);
      const readSnapshot = useCallback(() => (store ? store.getSnapshot() : EMPTY_STATE), [store]);
      const state = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);

      const [open, setOpen] = useState(false);
      const [query, setQuery] = useState('');
      const [highlighted, setHighlighted] = useState(null);
      const [providerChoice, setProviderChoice] = useState(null);
      const [position, setPosition] = useState(null);
      const [selectionError, setSelectionError] = useState(null);
      const [quietFocus, setQuietFocus] = useState(false);
      const [dragIndex, setDragIndex] = useState(null);
      const [optimistic, setOptimistic] = useState(null);

      const triggerRef = useRef(null);
      const popoverRef = useRef(null);
      const searchRef = useRef(null);
      const sliderRef = useRef(null);
      const railRef = useRef(null);
      const rowRefs = useRef([]);
      const draggingRef = useRef(false);
      const focusPendingRef = useRef(false);

      const groups = useMemo(
        () => (Array.isArray(state.groups) ? state.groups : []),
        [state.groups],
      );
      const failures = useMemo(
        () => (Array.isArray(state.failures) ? state.failures : []),
        [state.failures],
      );
      const current = state.current || null;
      const pending = state.pending || null;
      const busy = pending !== null;

      /** Provider column: an explicit choice, else the current provider, else the first one. */
      const activeProviderId = useMemo(() => {
        if (providerChoice !== null && groups.some((group) => group.id === providerChoice)) {
          return providerChoice;
        }
        if (current && groups.some((group) => group.id === current.provider)) {
          return current.provider;
        }
        const firstWithModels = groups.find((group) => Array.isArray(group.models) && group.models.length > 0);
        if (firstWithModels) return firstWithModels.id;
        return groups.length > 0 ? groups[0].id : null;
      }, [providerChoice, groups, current]);

      const activeGroup = useMemo(
        () => (activeProviderId === null ? null : groups.find((group) => group.id === activeProviderId) || null),
        [groups, activeProviderId],
      );
      const groupById = useMemo(() => {
        const map = new Map();
        for (let index = 0; index < groups.length; index += 1) map.set(groups[index].id, groups[index]);
        return map;
      }, [groups]);

      /** True while the search field holds a query; results then span every provider. */
      const searchQuery = query.trim();
      const searching = searchQuery.length > 0;

      /**
       * The one flattened list of selectable entries every consumer reads: rows,
       * keyboard highlight, Enter, index clamping and the current/pending checks.
       * With an empty query it is the active provider's models in catalog order;
       * with a query it is every provider's ranked hits, providers in catalog
       * order. Each entry carries the provider it came from.
       */
      const entries = useMemo(() => {
        if (!searching) {
          if (!activeGroup) return [];
          const models = Array.isArray(activeGroup.models) ? activeGroup.models : [];
          return models.map((model) => ({ providerId: activeGroup.id, model }));
        }
        const out = [];
        for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
          const group = groups[groupIndex];
          const models = Array.isArray(group.models) ? group.models : [];
          const hits = rankModels(models, searchQuery);
          for (let hitIndex = 0; hitIndex < hits.length; hitIndex += 1) {
            out.push({ providerId: group.id, model: hits[hitIndex] });
          }
        }
        return out;
      }, [searching, searchQuery, activeGroup, groups]);

      /** The current model, when it is present in the loaded catalog. */
      const currentModel = useMemo(() => {
        if (!current) return null;
        const group = groups.find((entry) => entry.id === current.provider);
        if (!group || !Array.isArray(group.models)) return null;
        return group.models.find((model) => model && model.id === current.model) || null;
      }, [groups, current]);

      /** The effort block describes the model on screen, which is the current one only in its own provider column. */
      const effortModel = currentModel && activeGroup && current.provider === activeGroup.id ? currentModel : null;
      const reasoning = effortModel && effortModel.reasoning ? effortModel.reasoning : null;
      const effortLevels = useMemo(() => effortLevelsOf(reasoning, copy), [reasoning, copy]);
      const effectiveEffortId = current && current.reasoningEffort !== undefined
        ? current.reasoningEffort
        : (reasoning && reasoning.defaultEffort !== undefined ? reasoning.defaultEffort : undefined);
      let activeEffortIndex = 0;
      for (let index = 0; index < effortLevels.length; index += 1) {
        if (effortLevels[index].id === effectiveEffortId) {
          activeEffortIndex = index;
          break;
        }
      }

      // Drop the optimistic stop once the shared directory reports it.
      useEffect(() => {
        if (optimistic !== null && optimistic.index === activeEffortIndex) setOptimistic(null);
      }, [optimistic, activeEffortIndex]);

      const previewRaw = dragIndex !== null
        ? dragIndex
        : (optimistic !== null ? optimistic.index : activeEffortIndex);
      const previewEffortIndex = effortLevels.length === 0
        ? 0
        : Math.max(0, Math.min(previewRaw, effortLevels.length - 1));

      /** Caption of the trigger, and its effort part. */
      const captionEffort = currentModel ? effortCaption(currentModel, current, copy) : '';
      const caption = useMemo(() => {
        if (currentModel) {
          return captionEffort ? currentModel.name + ' \u00b7 ' + captionEffort : currentModel.name;
        }
        if (!current && (state.status === 'idle' || state.status === 'loading')) return copy.loading;
        return copy.selectModel;
      }, [currentModel, captionEffort, current, copy, state.status]);

      const currentRowIndex = current
        ? entries.findIndex((entry) => entry.providerId === current.provider
          && entry.model && entry.model.id === current.model)
        : -1;
      // Always inside [0, entries.length - 1] when entries exist, and -1 when they do not.
      const highlightedIndex = entries.length === 0
        ? -1
        : Math.min(
          Math.max(0, highlighted === null ? Math.max(0, currentRowIndex) : highlighted),
          entries.length - 1,
        );
      const rowStopIndex = highlightedIndex;

      const measure = useCallback(() => {
        const trigger = triggerRef.current;
        if (!trigger) return;
        const rect = trigger.getBoundingClientRect();
        const viewportWidth = window.innerWidth || 0;
        const viewportHeight = window.innerHeight || 0;
        const margin = 12;
        const gap = 8;
        const width = Math.max(0, Math.min(720, viewportWidth - 32));
        const height = Math.max(0, Math.min(420, viewportHeight - 96));
        const maxLeft = Math.max(margin, viewportWidth - width - margin);
        const left = Math.min(Math.max(margin, rect.right - width), maxLeft);
        // Never flips below the trigger: the top edge is clamped into the viewport.
        const top = Math.max(margin, rect.top - gap - height);
        setPosition({ left, top, width, height });
      }, []);

      const closePopover = useCallback((restoreFocus) => {
        setOpen(false);
        setPosition(null);
        setQuery('');
        setHighlighted(null);
        setProviderChoice(null);
        setSelectionError(null);
        setDragIndex(null);
        setOptimistic(null);
        draggingRef.current = false;
        if (restoreFocus) {
          setQuietFocus(true);
          queueMicrotask(() => {
            const trigger = triggerRef.current;
            if (trigger) trigger.focus({ preventScroll: true });
          });
        }
      }, []);

      const reload = useCallback(() => {
        if (!directory) return;
        try {
          Promise.resolve(directory.load()).catch(noop);
        } catch (error) {
          // A synchronous throw from the directory is a failed load, not a crash.
        }
      }, [directory]);

      const runSelection = useCallback(async (selection) => {
        if (!directory) {
          setSelectionError(copy.unavailable);
          return false;
        }
        if (sameSelection(selection, pending)) return true;
        setSelectionError(null);
        try {
          const result = await directory.select(selection);
          if (result && result.ok === false) {
            const code = result.error && result.error.code;
            const message = result.error && result.error.message;
            setSelectionError(code === 'session/writer-held' ? copy.sessionInUse : (message || copy.rejected));
            return false;
          }
          return true;
        } catch (error) {
          setSelectionError(error && error.message ? error.message : copy.rejected);
          return false;
        }
      }, [directory, pending, copy]);

      const chooseModel = useCallback(async (entry) => {
        if (!entry || !entry.model) return;
        const providerId = entry.providerId;
        const model = entry.model;
        // Re-picking the current model keeps the panel open and resets nothing.
        if (current && current.provider === providerId && current.model === model.id) return;
        // The panel stays open after a pick: the effort slider below edits the same
        // selection, so someone choosing both should not have to reopen the menu.
        await runSelection(buildSelection(providerId, model, current));
      }, [current, runSelection]);

      const applyEffort = useCallback((index) => {
        if (!effortModel || !effortLevels[index]) return;
        const level = effortLevels[index];
        const provider = current && current.provider ? current.provider : null;
        if (!provider) return;
        setOptimistic({ index, id: level.id });
        const selection = { provider, model: effortModel.id };
        if (level.id !== undefined) selection.reasoningEffort = level.id;
        void runSelection(selection);
      }, [effortModel, effortLevels, current, runSelection]);

      // Load the shared catalog once the seat can select, and again on every open.
      useEffect(() => {
        if (!open) return;
        reload();
      }, [open, reload]);
      useEffect(() => {
        if (!directory) return;
        reload();
      }, [directory, reload]);

      useLayoutEffect(() => {
        if (!open) {
          setPosition(null);
          return;
        }
        measure();
      }, [open, measure]);

      useEffect(() => {
        if (!open) return undefined;
        const onViewportChange = () => measure();
        window.addEventListener('resize', onViewportChange);
        window.addEventListener('scroll', onViewportChange, true);
        return () => {
          window.removeEventListener('resize', onViewportChange);
          window.removeEventListener('scroll', onViewportChange, true);
        };
      }, [open, measure]);

      // Focus the search field once the panel has been placed, not on every resize.
      useEffect(() => {
        if (!open || !position || !focusPendingRef.current) return;
        focusPendingRef.current = false;
        const search = searchRef.current;
        if (search) search.focus({ preventScroll: true });
      }, [open, position]);

      // Outside mousedown closes the popover.
      useEffect(() => {
        if (!open) return undefined;
        const onMouseDown = (event) => {
          const popover = popoverRef.current;
          const trigger = triggerRef.current;
          if (popover && popover.contains(event.target)) return;
          if (trigger && trigger.contains(event.target)) return;
          closePopover(false);
        };
        document.addEventListener('mousedown', onMouseDown, true);
        return () => document.removeEventListener('mousedown', onMouseDown, true);
      }, [open, closePopover]);

      // A composer that becomes locked cannot keep an interactive panel open.
      useEffect(() => {
        if (locked && open) closePopover(false);
      }, [locked, open, closePopover]);

      // The composer can swap the addressed session without unmounting the seat.
      const lastSessionRef = useRef(sessionId);
      useEffect(() => {
        if (lastSessionRef.current === sessionId) return;
        lastSessionRef.current = sessionId;
        closePopover(false);
      }, [sessionId, closePopover]);

      const openPopover = useCallback(() => {
        if (locked || !directory) return;
        focusPendingRef.current = true;
        setSelectionError(null);
        setQuery('');
        setHighlighted(null);
        setProviderChoice(null);
        setOpen(true);
        reload();
      }, [locked, directory, reload]);

      const toggle = useCallback(() => {
        if (open) closePopover(true);
        else openPopover();
      }, [open, closePopover, openPopover]);

      const moveHighlight = useCallback((delta) => {
        if (entries.length === 0) return;
        const start = highlightedIndex < 0 ? 0 : highlightedIndex;
        const next = (start + delta + entries.length) % entries.length;
        setHighlighted(next);
        const node = rowRefs.current[next];
        if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
      }, [entries.length, highlightedIndex]);

      const switchProvider = useCallback((delta) => {
        if (groups.length < 2) return;
        const index = groups.findIndex((group) => group.id === activeProviderId);
        const next = (index < 0 ? 0 : (index + delta + groups.length) % groups.length);
        setProviderChoice(groups[next].id);
        setHighlighted(null);
      }, [groups, activeProviderId]);

      const cycleTab = useCallback((event) => {
        const stops = [];
        if (searchRef.current) stops.push(searchRef.current);
        if (sliderRef.current) stops.push(sliderRef.current);
        const row = rowRefs.current[rowStopIndex];
        if (row) stops.push(row);
        if (stops.length === 0) return;
        const active = document.activeElement;
        const index = stops.indexOf(active);
        const next = index < 0 ? 0 : (index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length;
        event.preventDefault();
        const target = stops[next];
        if (target === row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
        target.focus({ preventScroll: true });
      }, [rowStopIndex]);

      const indexFromPointer = useCallback((clientX) => {
        const rail = railRef.current;
        const count = effortLevels.length;
        if (!rail || count === 0) return 0;
        const rect = rail.getBoundingClientRect();
        if (!rect || rect.width <= 0) return 0;
        const ratio = (clientX - rect.left) / rect.width;
        const clamped = Math.max(0, Math.min(1, ratio));
        return Math.round(clamped * (count - 1));
      }, [effortLevels.length]);

      const onPopoverKeyDown = useCallback((event) => {
        if (event.defaultPrevented) return;
        const key = event.key;
        const sliderFocused = sliderRef.current !== null && document.activeElement === sliderRef.current;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 't' || key === 'T')) {
          if (sliderRef.current) {
            event.preventDefault();
            sliderRef.current.focus({ preventScroll: true });
          }
          return;
        }
        if (key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closePopover(true);
          return;
        }
        if (key === 'Tab') {
          cycleTab(event);
          return;
        }
        if (sliderFocused) return;
        if (key === 'ArrowDown') {
          event.preventDefault();
          moveHighlight(1);
          return;
        }
        if (key === 'ArrowUp') {
          event.preventDefault();
          moveHighlight(-1);
          return;
        }
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
          const editingQuery = event.target === searchRef.current && query.length > 0;
          if (editingQuery) return;
          event.preventDefault();
          switchProvider(key === 'ArrowLeft' ? -1 : 1);
          return;
        }
        if (key === 'Enter' && event.target === searchRef.current) {
          const entry = entries[highlightedIndex];
          if (entry) {
            event.preventDefault();
            void chooseModel(entry);
          }
        }
      }, [
        closePopover,
        cycleTab,
        moveHighlight,
        switchProvider,
        query,
        entries,
        highlightedIndex,
        chooseModel,
      ]);

      const onSliderKeyDown = useCallback((event) => {
        const count = effortLevels.length;
        if (count === 0) return;
        const key = event.key;
        if (key === 'ArrowRight' || key === 'ArrowUp') {
          event.preventDefault();
          event.stopPropagation();
          applyEffort(Math.min(previewEffortIndex + 1, count - 1));
          return;
        }
        if (key === 'ArrowLeft' || key === 'ArrowDown') {
          event.preventDefault();
          event.stopPropagation();
          applyEffort(Math.max(previewEffortIndex - 1, 0));
          return;
        }
        if (key === 'Home') {
          event.preventDefault();
          event.stopPropagation();
          applyEffort(0);
          return;
        }
        if (key === 'End') {
          event.preventDefault();
          event.stopPropagation();
          applyEffort(count - 1);
        }
      }, [effortLevels.length, previewEffortIndex, applyEffort]);

      const onRailPointerDown = useCallback((event) => {
        if (effortLevels.length === 0) return;
        event.preventDefault();
        const rail = railRef.current;
        if (rail && typeof rail.setPointerCapture === 'function') {
          try {
            rail.setPointerCapture(event.pointerId);
          } catch (error) {
            // Pointer capture is best-effort; dragging still works without it.
          }
        }
        draggingRef.current = true;
        setDragIndex(indexFromPointer(event.clientX));
      }, [effortLevels.length, indexFromPointer]);

      const onRailPointerMove = useCallback((event) => {
        if (!draggingRef.current) return;
        setDragIndex(indexFromPointer(event.clientX));
      }, [indexFromPointer]);

      const onRailPointerUp = useCallback((event) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        const index = indexFromPointer(event.clientX);
        setDragIndex(null);
        applyEffort(index);
      }, [indexFromPointer, applyEffort]);

      const onRailPointerCancel = useCallback(() => {
        draggingRef.current = false;
        setDragIndex(null);
      }, []);

      const disabled = locked || !directory;
      const triggerLabel = disabled && !directory ? copy.unavailable : caption;

      const trigger = h('button', {
        ref: triggerRef,
        type: 'button',
        className: 'dmp-trigger dmp_model_trigger' + (quietFocus ? ' dmp-quiet' : ''),
        disabled,
        title: triggerLabel,
        'aria-label': triggerLabel,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-busy': busy,
        onClick: toggle,
        onBlur: () => setQuietFocus(false),
        onKeyDown: (event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) openPopover();
          }
        },
      },
        h('span', { className: 'dmp-trigger-label dmp_triggerLabel' }, currentModel ? currentModel.name : triggerLabel),
        currentModel && captionEffort
          ? h('span', { className: 'dmp-trigger-effort' }, ' \u00b7 ' + captionEffort)
          : null,
        h(ColumnGlyph),
        busy ? h('span', { className: 'dmp-spinner' }) : h('span', { className: 'dmp-chevron' }, h(Chevron)),
      );

      if (!open || !position) return h('div', { className: 'dmp_model_root' }, trigger);

      const providerRows = [];
      for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        const active = group.id === activeProviderId;
        const pendingProvider = pending !== null && pending.provider === group.id;
        providerRows.push(h('button', {
          key: 'provider:' + group.id,
          type: 'button',
          className: 'dmp-provider-row',
          'aria-current': active ? 'true' : undefined,
          tabIndex: -1,
          onClick: () => {
            setProviderChoice(group.id);
            setHighlighted(null);
            // A column pick also leaves the cross-provider search results.
            if (searching) setQuery('');
          },
        },
          h('span', { className: 'dmp-provider-name' }, providerLabel(group, copy)),
          pendingProvider && !active
            ? h('span', { className: 'dmp-check' }, h(PendingDots))
            : (active ? h('span', { className: 'dmp-check' }, h(Check)) : null),
        ));
      }
      for (let index = 0; index < failures.length; index += 1) {
        const failure = failures[index];
        const label = failure.id === ACCOUNT_PROVIDER ? copy.providerAccount : (failure.name || failure.id);
        providerRows.push(h('div', {
          key: 'failure:' + String(failure.id),
          className: 'dmp-provider-row dmp-provider-failed',
          title: failure.message || label,
          'aria-disabled': 'true',
        },
          h('span', { className: 'dmp-provider-name' }, label),
        ));
      }

      /**
       * Rows of the flattened entry list. While searching, the first row of every
       * provider's result block is a caption naming that provider; a model row
       * itself carries the name and the optional badge only.
       */
      const listRows = [];
      let renderedProvider = null;
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const model = entry && entry.model;
        if (!model) continue;
        if (searching && entry.providerId !== renderedProvider) {
          renderedProvider = entry.providerId;
          listRows.push(h('div', {
            key: 'caption:' + entry.providerId,
            className: 'dmp-caption dmp-group-caption',
          }, providerLabel(groupById.get(entry.providerId) || null, copy)));
        }
        const isCurrent = current !== null && entry.providerId === current.provider
          && current.model === model.id;
        const isPending = pending !== null && entry.providerId === pending.provider
          && pending.model === model.id;
        const badge = model.badge && model.badge.text ? resolveBadgeText(model.badge.text, tag) : '';
        listRows.push(h('button', {
          key: 'model:' + entry.providerId + '/' + model.id,
          ref: (node) => {
            rowRefs.current[index] = node;
          },
          type: 'button',
          className: 'dmp-model-row',
          'data-highlight': index === highlightedIndex ? 'true' : undefined,
          'aria-current': isCurrent ? 'true' : undefined,
          tabIndex: index === rowStopIndex ? 0 : -1,
          onClick: () => {
            void chooseModel(entry);
          },
          onMouseEnter: () => setHighlighted(index),
        },
          h('span', { className: 'dmp-model-name' }, model.name || model.id),
          badge ? h('span', { className: 'dmp-badge', 'data-tone': model.badge.tone || undefined }, badge) : null,
          h('span', { className: 'dmp-check' }, isPending ? h(PendingDots) : (isCurrent ? h(Check) : null)),
        ));
      }

      let listBody;
      if (groups.length === 0) {
        if (state.status === 'error') {
          listBody = h('div', { className: 'dmp-status', role: 'status' },
            h('span', null, state.error || copy.loadFailed),
            h('button', { className: 'dmp-retry', type: 'button', onClick: reload }, copy.retry),
          );
        } else if (state.status === 'idle' || state.status === 'loading') {
          listBody = h('div', { className: 'dmp-status', role: 'status' }, copy.loading);
        } else {
          listBody = h('div', { className: 'dmp-status', role: 'status' }, copy.noModels);
        }
      } else if (entries.length === 0) {
        listBody = h('div', { className: 'dmp-status', role: 'status' },
          searching ? copy.noResults : copy.noModels,
        );
      } else {
        listBody = listRows;
      }

      const errorStrip = state.status === 'error' && groups.length > 0
        ? h('div', { className: 'dmp-error', role: 'status' },
          h('span', { className: 'dmp-error-text' }, state.error || copy.loadFailed),
          h('button', { className: 'dmp-retry', type: 'button', onClick: reload }, copy.retry),
        )
        : null;

      const selectionErrorStrip = selectionError
        ? h('div', { className: 'dmp-error', role: 'alert' },
          h('span', { className: 'dmp-error-text' }, selectionError),
        )
        : null;

      let effortBlock = null;
      // The slider edits the current selection, not the search results, so it is
      // present only while the panel lists the current model's own provider.
      if (!searching && effortModel && effortLevels.length > 0) {
        const count = effortLevels.length;
        const percent = count > 1 ? (Math.min(previewEffortIndex, count - 1) / (count - 1)) * 100 : 0;
        const stops = [];
        for (let index = 0; index < count; index += 1) {
          if (count > 1 && index === previewEffortIndex) continue;
          const stopPercent = count > 1 ? (index / (count - 1)) * 100 : 0;
          stops.push(h('span', {
            key: 'stop:' + index,
            className: 'dmp-stop',
            style: { '--dmp-stop-left': stopPercent + '%' },
          }));
        }
        effortBlock = h('div', { className: 'dmp-effort' },
          h('div', { className: 'dmp-effort-head' },
            h('span', { className: 'dmp-effort-label' }, copy.effortLabel),
            h('span', { className: 'dmp-effort-value' }, effortLevels[previewEffortIndex]
              ? effortLevels[previewEffortIndex].name
              : ''),
          ),
          h('div', {
            ref: sliderRef,
            className: 'dmp-slider',
            role: 'slider',
            tabIndex: 0,
            'aria-label': copy.effortLabel,
            'aria-orientation': 'horizontal',
            'aria-valuemin': 0,
            'aria-valuemax': count - 1,
            'aria-valuenow': previewEffortIndex,
            'aria-valuetext': effortLevels[previewEffortIndex] ? effortLevels[previewEffortIndex].name : '',
            'aria-keyshortcuts': 'Control+T',
            onKeyDown: onSliderKeyDown,
          },
            h('div', {
              ref: railRef,
              className: 'dmp-rail',
              onPointerDown: onRailPointerDown,
              onPointerMove: onRailPointerMove,
              onPointerUp: onRailPointerUp,
              onPointerCancel: onRailPointerCancel,
            },
              h('span', { className: 'dmp-fill', style: { '--dmp-pct': percent + '%' } }),
              stops,
              h('span', { className: 'dmp-thumb', style: { left: percent + '%' } }),
            ),
          ),
        );
      }

      const popover = createPortal(h('div', {
        ref: popoverRef,
        className: 'dmp-popover',
        role: 'dialog',
        'aria-label': copy.dialogLabel,
        style: {
          left: position.left + 'px',
          top: position.top + 'px',
          width: position.width + 'px',
          height: position.height + 'px',
        },
        onKeyDown: onPopoverKeyDown,
      },
        h('div', { className: 'dmp-searchbar' },
          h('input', {
            ref: searchRef,
            className: 'dmp-search',
            type: 'text',
            value: query,
            placeholder: copy.searchPlaceholder,
            'aria-label': copy.searchPlaceholder,
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => {
              setQuery(event.target.value);
              setHighlighted(null);
            },
          }),
        ),
        h('div', { className: 'dmp-body' },
          h('div', { className: 'dmp-left' },
            h('div', { className: 'dmp-caption' }, copy.providerCaption),
            h('div', { className: 'dmp-providers' }, providerRows),
            failures.length > 0 ? h('div', { className: 'dmp-warning' }, copy.providersFailed) : null,
          ),
          h('div', { className: 'dmp-right' },
            // The column caption names the listed provider, so it is shown only
            // while the list really is that provider's catalog slice.
            searching ? null : h('div', { className: 'dmp-right-head' },
              h('div', { className: 'dmp-right-caption' }, providerLabel(activeGroup, copy)),
            ),
            errorStrip,
            selectionErrorStrip,
            h('div', { className: 'dmp-models' }, listBody),
            effortBlock,
          ),
        ),
      ), document.body);

      return h('div', { className: 'dmp_model_root' }, trigger, popover);
    }

    return {
      inject: ['slots', 'modelDirectories'],
      /**
       * Client plugin body: inject the stylesheet once, then register the seat.
       * The style tag is removed with the plugin effect.
       * @param {object} context - client plugin context.
       */
      apply(context) {
        activeContext = context;
        context.effect(() => {
          const tag = document.createElement('style');
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => {
            if (tag.parentNode) tag.parentNode.removeChild(tag);
          };
        }, 'dsh-model-picker: styles');

        context.slots.inject(SLOT, () => context.slots.register(
          { name: SLOT },
          Picker,
        ));
      },
    };
  },
});
