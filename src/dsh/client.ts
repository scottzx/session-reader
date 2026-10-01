// Browser client entry for @1agents/session-reader in DSH Web
import { renderMarkdown } from '@1agents/chat-ui';
import { continuationCopy, continuationDictionaries } from './copy.js';
import { agentReference, sessionKey } from '../web/references.js';
import { selectedWorkspace } from './workspace.js';
import type { SessionRef, TurnSummary } from '../types.js';
import type { SearchMatch, SearchHit } from '../search.js';
import type { ContentItem } from '../reader.js';
import type { callsIn } from '../calls.js';

const CSS_TEXT = `
/* Match DSH SidebarRoot panel rows in expanded and collapsed layouts. */
[data-dsh-session-reader-entry] {
  box-sizing: border-box;
  flex: none;
  min-height: 36px;
  margin: 0 2px 4px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  white-space: nowrap;
  background: transparent;
  border: none;
  border-radius: var(--dsw-radius-md);
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  font: inherit;
  line-height: 22px;
  text-align: left;
  display: flex;
}
[data-dsh-session-reader-entry]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
[data-dsh-session-reader-entry]:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
[data-dsh-session-reader-entry] .sr-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
[data-dsh-session-reader-entry] .sr-icon svg {
  width: 16px;
  height: 16px;
}
[data-dsh-session-reader-entry] .sr-label {
  min-width: 0;
  text-overflow: ellipsis;
  overflow: hidden;
}
[data-dsh-frame][data-sidebar-collapsed] [data-dsh-session-reader-entry],
[data-sidebar-collapsed] [data-dsh-session-reader-entry] {
  justify-content: center;
  width: 36px;
  height: 36px;
  margin: 0 0 12px;
  padding: 0;
}
[data-sidebar-collapsed] [data-dsh-session-reader-entry] .sr-icon svg {
  width: 18px;
  height: 18px;
}
[data-dsh-frame][data-sidebar-collapsed] [data-dsh-session-reader-entry] .sr-label,
[data-sidebar-collapsed] [data-dsh-session-reader-entry] .sr-label {
  display: none;
}

/* Reader: search, confirm the original, and copy a portable reference. */
.sr-overlay {
  --sr-bg: var(--dsw-alias-bg-base, #fff);
  --sr-surface: var(--dsw-alias-bg-layer-1, #f6f7f9);
  --sr-text: var(--dsw-alias-label-primary, #202633);
  --sr-muted: var(--dsw-alias-label-secondary, #687386);
  --sr-border: var(--dsw-alias-border-l1, #e3e7ee);
  --sr-accent: var(--dsw-alias-state-business-primary, #315cd6);
  position: fixed; inset: 0; z-index: 99999;
  background: var(--dsw-alias-bg-mask-2, #0006); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  color: var(--sr-text); font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
body[data-ds-dark-theme] .sr-overlay {
  --sr-bg: #1e1e20; --sr-surface: #252528; --sr-text: #e5e5ea;
  --sr-muted: #a6adbb; --sr-border: #3a3a3e; --sr-accent: #8aaaff;
}
.sr-overlay * { box-sizing: border-box; }
.sr-card {
  width: min(1360px, 96vw); height: min(900px, 92vh); min-height: 0;
  background: var(--sr-bg); border: 1px solid var(--sr-border); border-radius: 12px;
  box-shadow: 0 20px 60px #0004; display: flex; flex-direction: column; overflow: hidden;
}
.sr-header { padding: 14px 18px; border-bottom: 1px solid var(--sr-border); }
.sr-header-top, .sr-header-actions, .sr-search-row, .sr-item-header, .sr-message-header, .sr-reader-toolbar {
  display: flex; align-items: center; gap: 8px;
}
.sr-header-top { justify-content: space-between; }
.sr-header-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; }
.sr-header-hint, .sr-item-time, .sr-item-ws, .sr-header-path, .sr-status, .sr-message-meta {
  font-size: 12px; color: var(--sr-muted);
}
.sr-search-row { margin-top: 12px; flex-wrap: wrap; }
.sr-search-input, .sr-select, .sr-btn {
  height: 34px; border: 1px solid var(--sr-border); border-radius: 6px; color: inherit;
  background: var(--sr-bg); font: inherit; padding: 0 10px;
}
.sr-search-input { flex: 1; min-width: 200px; }
.sr-btn { cursor: pointer; white-space: nowrap; }
.sr-btn:hover, .sr-select:hover { background: var(--sr-surface); }
.sr-btn:disabled { cursor: default; opacity: .5; }
.sr-btn.sr-primary { background: var(--sr-accent); border-color: var(--sr-accent); color: var(--sr-bg); }
.sr-overlay button:focus-visible, .sr-overlay input:focus-visible, .sr-overlay select:focus-visible,
.sr-overlay summary:focus-visible { outline: 2px solid var(--sr-accent); outline-offset: 2px; }
.sr-btn-close { width: 32px; padding: 0; }
.sr-main { flex: 1; min-height: 0; display: flex; overflow: hidden; }
.sr-sidebar { width: 330px; flex: none; overflow: auto; background: var(--sr-surface); border-right: 1px solid var(--sr-border); }
.sr-list-heading { padding: 12px 16px; color: var(--sr-muted); font-size: 12px; }
.sr-session-item { border-bottom: 1px solid var(--sr-border); padding: 12px 16px; }
.sr-session-item.active { background: var(--sr-bg); box-shadow: inset 3px 0 var(--sr-accent); }
.sr-session-select { display: block; width: 100%; text-align: left; border: 0; padding: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; }
.sr-item-header { justify-content: space-between; margin-bottom: 6px; }
.sr-badge { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px; text-transform: uppercase; background: var(--sr-border); }
.sr-badge-antigravity { background: #f3e8ff; color: #7e22ce; }
.sr-badge-claude { background: #ffedd5; color: #c2410c; }
.sr-badge-grok { background: #e0f2fe; color: #0369a1; }
.sr-badge-codex { background: #dcfce7; color: #15803d; }
.sr-badge-dsh { background: #dbeafe; color: #1d4ed8; }
.sr-item-title { font-weight: 600; overflow-wrap: anywhere; margin-bottom: 4px; }
.sr-item-ws { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-match { display: block; width: 100%; text-align: left; font: inherit; color: inherit; background: var(--sr-bg); border: 1px solid var(--sr-border); border-radius: 6px; padding: 8px 10px; margin-top: 8px; cursor: pointer; overflow-wrap: anywhere; }
.sr-match:hover { border-color: var(--sr-accent); }
.sr-match small { display: block; color: var(--sr-muted); margin-bottom: 4px; }
.sr-overlay mark { background: #ffe399; color: #352b0c; border-radius: 2px; }
.sr-list-more { padding: 14px 16px; }
.sr-list-more .sr-btn { width: 100%; }
.sr-content { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.sr-content-header { border-bottom: 1px solid var(--sr-border); padding: 16px 20px 10px; }
.sr-header-title-text { margin: 0; flex: 1; min-width: 0; font-size: 16px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-header-actions { flex-wrap: wrap; }
.sr-header-path { margin-top: 6px; overflow-wrap: anywhere; }
.sr-reader-toolbar { padding-top: 10px; flex-wrap: wrap; }
.sr-content-header .sr-header-actions { flex-wrap: wrap; }
.sr-reader-toolbar .sr-btn { height: 28px; font-size: 12px; }
.sr-status { min-height: 20px; margin-left: auto; }
.sr-reading-layout { display: flex; flex: 1; min-height: 0; overflow: hidden; }
.sr-turn-nav { width: 190px; flex: none; overflow: auto; padding: 12px 8px; border-right: 1px solid var(--sr-border); }
.sr-turn-nav button { font: inherit; display: block; width: 100%; border: 0; color: inherit; text-align: left; background: transparent; border-radius: 6px; padding: 8px; cursor: pointer; overflow-wrap: anywhere; }
.sr-turn-nav button:hover, .sr-turn-nav button.active { background: var(--sr-surface); color: var(--sr-accent); }
.sr-turn-nav small { display: block; color: var(--sr-muted); }
.sr-reading-column { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.sr-dialogue { flex: 1; min-height: 0; overflow: auto; padding: 12px 24px 30px; scroll-behavior: auto; }
.sr-turn { max-width: 840px; margin: 0 auto 26px; }
.sr-turn-heading { font-size: 12px; color: var(--sr-muted); padding: 12px 0; border-bottom: 1px solid var(--sr-border); margin-bottom: 18px; }
.sr-message { margin: 0 0 22px; padding: 12px 14px; border-radius: 8px; border: 1px solid transparent; scroll-margin-top: 12px; }
.sr-message-user { background: var(--sr-surface); }
.sr-message.is-target { border-color: var(--sr-accent); }
.sr-message-header { justify-content: space-between; margin-bottom: 10px; flex-wrap: wrap; }
.sr-message-header strong { font-size: 12px; }
.sr-message-header .sr-btn { height: 26px; font-size: 11px; }
.sr-markdown { overflow-wrap: anywhere; line-height: 1.75; }
.sr-markdown > :first-child { margin-top: 0; }
.sr-markdown > :last-child { margin-bottom: 0; }
.sr-markdown p { white-space: pre-wrap; }
.sr-markdown pre, .sr-inspection pre { overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; background: var(--sr-surface); border-radius: 6px; font-size: 12px; }
.sr-markdown code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
.sr-markdown :not(pre) > code { background: var(--sr-surface); padding: 2px 4px; border-radius: 3px; }
.sr-markdown a { color: var(--sr-accent); }
.sr-markdown img { max-width: 100%; }
.sr-markdown table { display: block; overflow: auto; border-collapse: collapse; }
.sr-markdown th, .sr-markdown td { border: 1px solid var(--sr-border); padding: 6px 10px; }
.sr-markdown blockquote { border-left: 3px solid var(--sr-border); padding-left: 12px; margin-left: 0; color: var(--sr-muted); }
.chat-code-header { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: var(--sr-surface); font-size: 11px; }
.chat-code-copy-btn { color: inherit; background: transparent; border: 1px solid var(--sr-border); border-radius: 4px; cursor: pointer; }
.sr-tools { border-top: 1px solid var(--sr-border); padding-top: 8px; color: var(--sr-muted); font-size: 12px; }
.sr-tools summary, .sr-detail-panel summary { cursor: pointer; }
.sr-tool-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.sr-detail-panel { flex: none; width: 290px; border-left: 1px solid var(--sr-border); padding: 16px; overflow: auto; background: var(--sr-surface); }
.sr-detail-panel details { margin-bottom: 18px; }
.sr-detail-panel p { font-size: 12px; overflow-wrap: anywhere; }
.sr-detail-panel .sr-btn { height: auto; min-height: 28px; white-space: normal; text-align: left; margin-top: 6px; max-width: 100%; }
.sr-inspection { max-height: 45%; flex: none; overflow: auto; padding: 12px 20px; border-bottom: 1px solid var(--sr-border); }
.sr-inspection .sr-markdown { margin-top: 12px; }
.sr-inspection strong { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.sr-empty { margin: auto; padding: 40px 24px; text-align: center; color: var(--sr-muted); }
.sr-empty strong { display: block; font-size: 16px; color: var(--sr-text); margin-bottom: 8px; }
.sr-error { color: #dc3655; }
.sr-standalone.sr-overlay { background: var(--sr-bg); backdrop-filter: none; }
.sr-standalone .sr-card { width: 100%; height: 100%; border: 0; border-radius: 0; box-shadow: none; }
.sr-standalone .sr-btn-close { display: none; }
@media (max-width: 1100px) {
  .sr-sidebar { width: 290px; }
  .sr-header-top { align-items: flex-start; flex-wrap: wrap; }
  .sr-header-hint { display: none; }
  .sr-turn-nav { width: 150px; }
  .sr-detail-panel { position: absolute; right: 0; top: 0; bottom: 0; z-index: 2; box-shadow: -8px 0 20px #0001; }
  .sr-reading-layout { position: relative; }
}
@media (max-width: 700px) {
  .sr-header { padding: 10px; }
  .sr-sidebar { width: 36%; min-width: 150px; }
  .sr-content-header { padding: 12px; }
  .sr-content-header > .sr-header-top { flex-direction: column; align-items: stretch; }
  .sr-header-title-text { width: 100%; white-space: normal; overflow-wrap: anywhere; }
  .sr-turn-nav { position: absolute; z-index: 2; top: 0; bottom: 0; background: var(--sr-bg); box-shadow: 8px 0 20px #0001; }
  .sr-dialogue { padding: 10px; }
  .sr-header-actions .sr-btn { font-size: 11px; }
  .sr-item-time { font-size: 10px; }
  .sr-session-item { padding: 10px; }
  .sr-detail-panel { width: min(290px, 100%); }
}
`;

const ICON_SVG = `<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><polyline points="8 4.2 8 8 10.5 9.5"/></svg>`;

export const inject = ['sessions', 'workspaces', 'uiWorkspace', 'uiSession', 'locale'];

interface UiSession extends SessionRef {
  searchMatches?: SearchMatch[];
  totalMatches?: number;
  hasMore?: boolean;
  nextCursor?: string;
}

interface TurnPage {
  items: ContentItem[];
  tools: ReturnType<typeof callsIn>;
  nextCursor?: string;
}

interface SessionView {
  ref: SessionRef;
  turns: TurnSummary[];
  loaded: Map<number, TurnPage>;
  scrollTop: number;
  currentTurn: number;
  details?: any;
  detailsError?: string;
  continuation?: any;
  continuationError?: string;
  continuationBusy?: boolean;
}

interface Inspection {
  label: string;
  params: URLSearchParams;
  items: ContentItem[];
  nextCursor?: string;
  artifactPath?: string;
  loading: boolean;
  error?: string;
}

interface SrUiBoot {
  mode?: string;
  cwd?: string;
  title?: string;
  defaultScope?: 'cwd' | 'global';
}

function getBoot(): SrUiBoot {
  if (typeof window === 'undefined') return {};
  return ((window as any).__SR_UI__ ?? {}) as SrUiBoot;
}

function isStandalone(): boolean {
  return getBoot().mode === 'standalone';
}

export function apply(_ctx: any = {}) {
  if (typeof document === 'undefined') return;
  if (_ctx.locale) _ctx.effect(() => _ctx.locale.register('sessionReaderContinuation', continuationDictionaries));
  const translate = _ctx.locale?.bind('sessionReaderContinuation');
  const getContinuationCopy = () => continuationCopy(translate);

  // 1. Inject Styles
  if (!document.getElementById('dsh-session-reader-css')) {
    const style = document.createElement('style');
    style.id = 'dsh-session-reader-css';
    style.textContent = CSS_TEXT;
    document.head.appendChild(style);
  }

  // 2. Modal Controller
  let overlayEl: HTMLElement | null = null;
  let activeSessionId: string | null = null;
  let cachedSessions: UiSession[] = [];
  let activeSessionData: SessionView | null = null;
  const sessionViews = new Map<string, SessionView>();
  let queryParams = new URLSearchParams();
  let queryText = '';
  let listHasMore = false;
  let listNextCursor: string | undefined;
  let listNextOffset = 0;
  let showDirectory = false;
  let showDetails = false;
  let inspection: Inspection | null = null;
  let selectedMatch = -1;
  let readerBusy = false;
  let readerError = '';
  let detailError = '';
  let readAbort: AbortController | null = null;
  let inspectionAbort: AbortController | null = null;
  let detailsAbort: AbortController | null = null;
  let listAbort: AbortController | null = null;
  let detailAbort: AbortController | null = null;
  let activeWorkspaceKey = '';
  const LIST_TIMEOUT_MS = 12_000;
  const DETAIL_TIMEOUT_MS = 60_000;

  const dshCtx = _ctx;
  if (typeof window !== 'undefined' && _ctx && Object.keys(_ctx).length > 0) {
    (window as any).__DSH_SESSION_READER_CTX__ = _ctx;
  }

  function getActiveWorkspaceInfo(): { cwd?: string; title?: string; workspaceId?: string } {
    if (isStandalone()) {
      const boot = getBoot();
      return {
        cwd: boot.cwd,
        title: boot.title || (boot.cwd ? boot.cwd.split('/').pop() : undefined) || '当前工作区',
      };
    }
    try {
      const sessions = dshCtx?.get ? (dshCtx.get('sessions') ?? dshCtx.sessions) : dshCtx?.sessions;
      const sessionSnapshot = sessions?.list?.getSnapshot?.();
      const uiSession = dshCtx?.get ? dshCtx.get('uiSession') : dshCtx?.uiSession;
      const currentSessionId = uiSession?.adapter?.current?.getSnapshot?.().key;
      const workspaces = dshCtx?.get ? (dshCtx.get('workspaces') ?? dshCtx.workspaces) : dshCtx?.workspaces;
      const wsSnapshot = workspaces?.list?.getSnapshot?.();
      return selectedWorkspace(currentSessionId, sessionSnapshot?.byId ?? {}, wsSnapshot?.items ?? []);
    } catch (err) {
      console.warn('[session-reader] getActiveWorkspaceInfo error:', err);
    }
    return {};
  }

  function closePanel() {
    listAbort?.abort();
    detailAbort?.abort();
    listAbort = null;
    detailAbort = null;
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
    activeSessionId = null;
    activeSessionData = null;
    cachedSessions = [];
    sessionViews.clear();
    readAbort?.abort();
    inspectionAbort?.abort();
    detailsAbort?.abort();
    readAbort = null;
    inspectionAbort = null;
    detailsAbort = null;
    inspection = null;
    showDetails = false;
    showDirectory = false;
    document.removeEventListener('keydown', onEscape);
  }

  async function openInDshChat(sessionId: string, provider?: string) {
    const copy = getContinuationCopy();
    const view = activeSessionData;
    if (!view || view.continuationBusy) return;
    view.continuationBusy = true;
    view.continuationError = undefined;
    renderModalBody();
    try {
      const res = await fetch('/api/session-reader/open-in-dsh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, provider }),
      });
      const result = await res.json();
      if (!res.ok || !result.success) throw new Error(result.error || res.statusText);
      const sessions = dshCtx?.get ? (dshCtx.get('sessions') ?? dshCtx.sessions) : dshCtx?.sessions;
      const navigation = dshCtx?.get ? dshCtx.get('uiWorkspace') : dshCtx?.uiWorkspace;
      if (!navigation) throw new Error(copy.navigationUnavailable);
      await sessions.refresh();
      navigation.openSession(result.dshSessionId);
      closePanel();
    } catch (err: any) {
      view.continuationError = copy.failed + (err?.message || err);
      if (activeSessionData === view) {
        renderModalBody();
      }
    } finally {
      view.continuationBusy = false;
      if (activeSessionData === view) renderModalBody();
    }
  }

  function onEscape(event: KeyboardEvent) {
    if (event.key === 'Escape' && !isStandalone()) closePanel();
  }

  function saveReadingPosition() {
    const pane = overlayEl?.querySelector<HTMLElement>('.sr-dialogue');
    if (pane && activeSessionData && pane.dataset.session === activeSessionId) {
      activeSessionData.scrollTop = pane.scrollTop;
    }
  }

  async function requestJson(url: string, signal?: AbortSignal) {
    const response = await fetch(url, { signal, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
    return data;
  }

  async function copyText(value: string, button: HTMLButtonElement) {
    try {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        const field = document.createElement('textarea');
        field.value = value;
        field.style.cssText = 'position:fixed;left:-9999px;top:0;';
        overlayEl!.appendChild(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        button.focus();
        if (!copied) throw new Error('复制失败，请重试');
      }
      button.textContent = '已复制';
      const status = overlayEl?.querySelector('.sr-status');
      if (status) status.textContent = '引用已复制，可粘贴给 Agent';
    } catch (error) {
      const status = overlayEl?.querySelector('.sr-status');
      if (status) status.textContent = String(error instanceof Error ? error.message : error);
    }
  }

  function highlightHtml(value: string): string {
    if (!queryText) return escapeHtml(value);
    const lower = value.toLowerCase();
    const needle = queryText.toLowerCase();
    let html = '';
    let offset = 0;
    let at = lower.indexOf(needle);
    while (at >= 0) {
      html += escapeHtml(value.slice(offset, at)) + '<mark>' + escapeHtml(value.slice(at, at + needle.length)) + '</mark>';
      offset = at + needle.length;
      at = lower.indexOf(needle, offset);
    }
    return html + escapeHtml(value.slice(offset));
  }

  function markdownBody(text: string): HTMLElement {
    const body = document.createElement('div');
    body.className = 'sr-markdown';
    const template = document.createElement('template');
    template.innerHTML = renderMarkdown(text);
    // Session text is untrusted. Keep formatting, never executable markup.
    const tags = new Set('P BR HR H1 H2 H3 H4 H5 H6 UL OL LI STRONG EM DEL S B I U PRE CODE BLOCKQUOTE TABLE THEAD TBODY TFOOT TR TH TD A IMG DIV SPAN BUTTON INPUT DETAILS SUMMARY MARK'.split(' '));
    for (const element of Array.from(template.content.querySelectorAll('*'))) {
      if (!tags.has(element.tagName)) {
        element.replaceWith(document.createTextNode(element.textContent ?? ''));
        continue;
      }
      for (const attr of Array.from(element.attributes)) {
        if (!['class', 'href', 'src', 'alt', 'title', 'data-copy', 'type', 'disabled', 'checked', 'start', 'colspan', 'rowspan'].includes(attr.name)) element.removeAttribute(attr.name);
      }
      if (element.tagName === 'A') {
        const href = element.getAttribute('href') ?? '';
        if (!/^https?:\/\//i.test(href)) element.removeAttribute('href');
        else {
          element.setAttribute('target', '_blank');
          element.setAttribute('rel', 'noopener noreferrer');
        }
      }
      if (element.tagName === 'IMG' && !/^(https?:\/\/|data:image\/(?:png|jpe?g|gif|webp);base64,)/i.test(element.getAttribute('src') ?? '')) element.removeAttribute('src');
      if (element.tagName === 'INPUT') {
        element.setAttribute('type', 'checkbox');
        element.setAttribute('disabled', '');
      }
      if (element.tagName === 'BUTTON') element.setAttribute('type', 'button');
    }
    body.appendChild(template.content);
    if (queryText) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      for (const node of nodes) {
        if (node.parentElement?.closest('button')) continue;
        const html = highlightHtml(node.data);
        if (!html.includes('<mark>')) continue;
        const marked = document.createElement('template');
        marked.innerHTML = html;
        node.replaceWith(marked.content);
      }
    }
    body.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach((button) => {
      button.addEventListener('click', () => copyText(decodeURIComponent(button.dataset.copy!), button));
    });
    return body;
  }

  function mergeItems(items: ContentItem[], more: ContentItem[]) {
    for (const item of more) {
      const existing = items.find((entry) => entry.index === item.index && entry.field === item.field);
      if (existing) existing.content += item.content;
      else items.push({ ...item });
    }
  }

  function currentMatches(): SearchMatch[] {
    return cachedSessions.find((session) => sessionKey(session) === activeSessionId)?.searchMatches ?? [];
  }

  async function loadSessionDetail(sessionId: string, match?: SearchMatch) {
    saveReadingPosition();
    detailAbort?.abort();
    readAbort?.abort();
    inspectionAbort?.abort();
    detailsAbort?.abort();
    const ac = new AbortController();
    detailAbort = ac;
    const timer = window.setTimeout(() => ac.abort(), DETAIL_TIMEOUT_MS);
    activeSessionId = sessionId;
    activeSessionData = sessionViews.get(sessionId) ?? null;
    detailError = '';
    readerError = '';
    readerBusy = false;
    inspection = null;
    selectedMatch = match ? currentMatches().indexOf(match) : -1;
    renderModalBody();
    renderSessionList();
    try {
      if (!activeSessionData) {
        const directory = await requestJson('/api/session-reader/session/' + encodeURIComponent(sessionId) + '/directory', ac.signal);
        if (detailAbort !== ac) return;
        const view: SessionView = {
          ref: directory.session, turns: directory.turns, loaded: new Map(),
          scrollTop: 0, currentTurn: directory.turns[0]?.no ?? 0,
        };
        sessionViews.set(sessionId, view);
        activeSessionData = view;
      }
      renderModalBody();
      if (match) {
        if (!match.turn && activeSessionData.loaded.size === 0 && activeSessionData.currentTurn) await loadTurn(activeSessionData.currentTurn);
        if (detailAbort !== ac) return;
        await jumpToMatch(match);
      }
      else if (activeSessionData.loaded.size === 0 && activeSessionData.currentTurn) await loadTurn(activeSessionData.currentTurn);
      if (detailAbort !== ac) return;
      if (showDetails) void loadDetails();
      if (!isStandalone() && !activeSessionData.continuation) {
        try {
          activeSessionData.continuation = await requestJson('/api/session-reader/continuation?provider=' + encodeURIComponent(activeSessionData.ref.provider), ac.signal);
        } catch (error) {
          if (detailAbort !== ac) return;
          activeSessionData.continuation = { available: false, reason: String(error) };
        }
        if (detailAbort !== ac) return;
        renderModalBody();
      }
    } catch (error: any) {
      if (detailAbort !== ac) return;
      detailError = error?.name === 'AbortError' ? '加载超时，请重试' : error.message;
      renderModalBody();
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function loadTurn(no: number, mode: 'replace' | 'before' | 'after' = 'replace', more = false) {
    const view = activeSessionData;
    if (!view) return;
    saveReadingPosition();
    readAbort?.abort();
    const ac = new AbortController();
    readAbort = ac;
    const timer = window.setTimeout(() => ac.abort(), DETAIL_TIMEOUT_MS);
    const pane = overlayEl?.querySelector<HTMLElement>('.sr-dialogue');
    const height = pane?.scrollHeight ?? 0;
    const scroll = view.scrollTop;
    readerBusy = true;
    readerError = '';
    if (mode === 'replace' && !more) {
      view.currentTurn = no;
      view.scrollTop = 0;
      const existing = view.loaded.get(no);
      view.loaded = new Map(existing ? [[no, existing]] : []);
    }
    renderModalBody(false);
    try {
      const params = new URLSearchParams({ turns: String(no) });
      if (more) params.set('cursor', view.loaded.get(no)!.nextCursor!);
      if (!view.loaded.has(no) || more) {
        const page = await requestJson('/api/session-reader/session/' + encodeURIComponent(sessionKey(view.ref)) + '/content?' + params, ac.signal);
        if (activeSessionData !== view || readAbort !== ac) return;
        if (more) {
          const existing = view.loaded.get(no)!;
          mergeItems(existing.items, page.items);
          existing.nextCursor = page.nextCursor;
        } else view.loaded.set(no, { items: page.items, tools: page.tools ?? [], nextCursor: page.nextCursor });
      }
      if (activeSessionData !== view || readAbort !== ac) return;
      readerBusy = false;
      renderModalBody();
      const nextPane = overlayEl?.querySelector<HTMLElement>('.sr-dialogue');
      if (nextPane && mode === 'before') nextPane.scrollTop = scroll + nextPane.scrollHeight - height;
    } catch (error: any) {
      if (activeSessionData !== view || readAbort !== ac) return;
      readerBusy = false;
      readerError = error?.name === 'AbortError' ? '读取超时，请重试' : error.message;
      renderModalBody();
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function jumpToMatch(match: SearchMatch) {
    const view = activeSessionData;
    if (!view) return;
    selectedMatch = currentMatches().indexOf(match);
    const selection = selectedMatch;
    const navigation = detailAbort;
    inspection = null;
    if (match.turn) await loadTurn(match.turn);
    if (activeSessionData !== view || detailAbort !== navigation || selectedMatch !== selection) return;
    if (match.kind === 'artifact') {
      if (match.artifactPath) await inspectContent(new URLSearchParams({ artifact: match.artifactPath }), '产物 · ' + match.artifactPath.split('/').pop(), match.artifactPath);
    } else if (match.kind === 'tool_call' || match.kind === 'tool_result') {
      const params = match.callId ? new URLSearchParams({ call: match.callId })
        : new URLSearchParams({ event: match.locator ?? String(match.index) });
      await inspectContent(params, '工具记录 · 第 ' + match.turn + ' 轮');
    } else if (match.kind === 'metadata') {
      showDetails = true;
      await loadDetails();
    } else {
      const rangeStart = match.fields?.find((field) => field.field === 'text')?.ranges[0]?.[0] ?? 0;
      let item = view.loaded.get(match.turn)?.items.find((entry) => entry.index === match.index);
      while (item && item.content.length <= rangeStart && view.loaded.get(match.turn)?.nextCursor) {
        const length = item.content.length;
        await loadTurn(match.turn, 'after', true);
        if (activeSessionData !== view || detailAbort !== navigation || selectedMatch !== selection) return;
        item = view.loaded.get(match.turn)?.items.find((entry) => entry.index === match.index);
        if (!item || item.content.length <= length) break;
      }
      const element = Array.from(overlayEl?.querySelectorAll<HTMLElement>('.sr-message') ?? [])
        .find((message) => message.dataset.eventIndex === String(match.index));
      if (element) {
        element.classList.add('is-target');
        (element.querySelector('mark') ?? element).scrollIntoView({ block: 'start' });
      } else {
        // A hit can be past the first page of a long turn; read it exactly.
        await inspectContent(new URLSearchParams({ event: match.locator ?? String(match.index) }), '命中消息 · 第 ' + match.turn + ' 轮');
      }
    }
  }

  async function inspectContent(params: URLSearchParams, label: string, artifactPath?: string, more = false) {
    const view = activeSessionData;
    if (!view) return;
    inspectionAbort?.abort();
    const ac = new AbortController();
    inspectionAbort = ac;
    const timer = window.setTimeout(() => ac.abort(), DETAIL_TIMEOUT_MS);
    if (!more) inspection = { label, params, items: [], artifactPath, loading: true };
    const target = inspection!;
    target.loading = true;
    target.error = '';
    const nextParams = new URLSearchParams(params);
    if (more) nextParams.set('cursor', target.nextCursor!);
    renderModalBody();
    try {
      const page = await requestJson('/api/session-reader/session/' + encodeURIComponent(sessionKey(view.ref)) + '/content?' + nextParams, ac.signal);
      if (activeSessionData !== view || inspectionAbort !== ac || inspection !== target) return;
      mergeItems(target.items, page.items);
      target.nextCursor = page.nextCursor;
    } catch (error: any) {
      if (activeSessionData !== view || inspectionAbort !== ac || inspection !== target) return;
      target.error = error?.name === 'AbortError' ? '读取超时，请重试' : error.message;
    } finally {
      window.clearTimeout(timer);
      if (activeSessionData === view && inspectionAbort === ac) {
        target.loading = false;
        renderModalBody();
      }
    }
  }

  async function loadDetails() {
    const view = activeSessionData;
    if (!view) return;
    if (view.details) { renderModalBody(); return; }
    detailsAbort?.abort();
    const ac = new AbortController();
    detailsAbort = ac;
    const timer = window.setTimeout(() => ac.abort(), DETAIL_TIMEOUT_MS);
    view.detailsError = '';
    renderModalBody();
    try {
      const data = await requestJson('/api/session-reader/session/' + encodeURIComponent(sessionKey(view.ref)) + '/details', ac.signal);
      if (activeSessionData !== view || detailsAbort !== ac) return;
      view.details = data;
    } catch (error: any) {
      if (activeSessionData !== view || detailsAbort !== ac) return;
      view.detailsError = error?.name === 'AbortError' ? '详情加载超时，请重试' : error.message;
    } finally {
      window.clearTimeout(timer);
      if (activeSessionData === view && detailsAbort === ac) renderModalBody();
    }
  }

  function searchRow(hit: SearchHit): UiSession {
    return { ...hit.session, searchMatches: hit.matches, totalMatches: hit.totalMatches, hasMore: hit.hasMore, nextCursor: hit.nextCursor };
  }

  function mergeSearchRows(rows: UiSession[]) {
    for (const row of rows) {
      const existing = cachedSessions.find((session) => sessionKey(session) === sessionKey(row));
      if (!existing) { cachedSessions.push(row); continue; }
      const matches = existing.searchMatches ?? [];
      for (const match of row.searchMatches ?? []) {
        if (!matches.some((entry) => entry.index === match.index && entry.kind === match.kind && entry.locator === match.locator && entry.artifactPath === match.artifactPath)) matches.push(match);
      }
      Object.assign(existing, row, { searchMatches: matches });
      existing.hasMore = matches.length < (row.totalMatches ?? 0);
    }
  }

  async function fetchSessions(append = false, matchSession?: UiSession) {
    listAbort?.abort();
    const ac = new AbortController();
    listAbort = ac;
    const timer = window.setTimeout(() => ac.abort(), LIST_TIMEOUT_MS);
    const listEl = overlayEl?.querySelector('.sr-sidebar');
    if (!append) {
      const value = (selector: string) => overlayEl!.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!.value;
      queryText = value('.sr-search-input').trim();
      queryParams = new URLSearchParams({ limit: '50', scope: value('.sr-select-scope'), area: value('.sr-select-area') });
      const workspace = getActiveWorkspaceInfo().cwd;
      if (queryParams.get('scope') === 'cwd' && !workspace) {
        cachedSessions = [];
        listHasMore = false;
        detailAbort?.abort(); readAbort?.abort(); inspectionAbort?.abort(); detailsAbort?.abort();
        activeSessionId = null;
        activeSessionData = null;
        inspection = null;
        detailError = '';
        renderModalBody();
        listEl!.innerHTML = '<div class="sr-empty">请先在 DSH 中选择工作区，或切换为全部工作区。</div>';
        window.clearTimeout(timer);
        return;
      }
      if (queryParams.get('scope') === 'cwd' && workspace) queryParams.set('workspace', workspace);
      if (value('.sr-select-provider')) queryParams.set('provider', value('.sr-select-provider'));
      const since = value('.sr-select-since');
      if (since) queryParams.set('since', new Date(Date.now() - Number(since) * 86400000).toISOString());
      if (queryText) queryParams.set('q', queryText);
      selectedMatch = -1;
    }
    const params = new URLSearchParams(queryParams);
    if (append) {
      if (queryText) params.set('cursor', matchSession?.nextCursor ?? listNextCursor!);
      else params.set('offset', String(listNextOffset));
    }
    if (matchSession) params.set('limit', '1');
    listEl?.querySelectorAll<HTMLButtonElement>('.sr-load-more, .sr-more-matches').forEach((button) => { button.disabled = true; });
    if (!append && listEl) listEl.innerHTML = '<div class="sr-empty">正在查找会话…</div>';
    try {
      const endpoint = queryText ? '/search' : '/sessions';
      const data = await requestJson('/api/session-reader' + endpoint + '?' + params, ac.signal);
      if (listAbort !== ac) return;
      const hits: SearchHit[] = (data.hits ?? []).filter((hit: SearchHit) => !hit.self);
      const rows = data.sessions ?? hits.map(searchRow);
      if (append) mergeSearchRows(rows);
      else cachedSessions = rows;
      if (!matchSession) {
        listNextCursor = hits.at(-1)?.nextCursor;
        listNextOffset = data.nextOffset ?? cachedSessions.length;
        listHasMore = queryText ? Boolean(listNextCursor) : Boolean(data.hasMore);
      }
      if (activeSessionId && !cachedSessions.some((session) => sessionKey(session) === activeSessionId)) {
        saveReadingPosition();
        detailAbort?.abort(); readAbort?.abort(); inspectionAbort?.abort(); detailsAbort?.abort();
        activeSessionId = null;
        activeSessionData = null;
        detailError = '';
      }
      renderSessionList();
      renderModalBody();
    } catch (error: any) {
      if (listAbort !== ac) return;
      renderSessionList();
      const notice = document.createElement('div');
      notice.className = 'sr-empty sr-error';
      notice.textContent = error?.name === 'AbortError' ? '查找超时，请缩小范围后重试' : error.message;
      const retry = document.createElement('button');
      retry.className = 'sr-btn';
      retry.textContent = '重试';
      retry.addEventListener('click', () => fetchSessions(append, matchSession));
      notice.appendChild(retry);
      listEl?.prepend(notice);
    } finally {
      window.clearTimeout(timer);
    }
  }

  function renderSessionList() {
    const listEl = overlayEl?.querySelector('.sr-sidebar');
    if (!listEl) return;
    const scrollTop = listEl.scrollTop;
    listEl.innerHTML = '<div class="sr-list-heading">' + (queryText ? '匹配会话' : '最近会话') + ' · 已显示 ' + cachedSessions.length + '</div>';
    if (!cachedSessions.length) {
      listEl.insertAdjacentHTML('beforeend', '<div class="sr-empty">暂无匹配会话<br>试试调整关键词、时间或工作区</div>');
      return;
    }
    for (const session of cachedSessions) {
      const item = document.createElement('div');
      item.className = 'sr-session-item' + (sessionKey(session) === activeSessionId ? ' active' : '');
      const time = session.updatedAt ? new Date(session.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '时间未记录';
      item.innerHTML = '<button type="button" class="sr-session-select">' +
        '<div class="sr-item-header">' +
        '<span class="sr-badge sr-badge-' + escapeHtml(session.provider) + '">' + escapeHtml(session.provider) + '</span>' +
        '<span class="sr-item-time">' + escapeHtml(time) + '</span>' +
        '</div>' +
        '<div class="sr-item-title">' + highlightHtml(session.title || '未命名会话') + '</div>' +
        '<div class="sr-item-ws" title="' + escapeHtml(session.workspace || '') + '">' + escapeHtml(session.workspace?.split('/').pop() || '未记录项目') + '</div>' +
        '</button>';
      item.querySelector('button')!.addEventListener('click', () => loadSessionDetail(sessionKey(session), session.searchMatches?.[0]));
      if (session.searchMatches?.length) {
        const count = document.createElement('div');
        count.className = 'sr-message-meta';
        count.textContent = '命中 ' + session.totalMatches + ' 处 · 已显示 ' + session.searchMatches.length;
        item.appendChild(count);
        for (const match of session.searchMatches) {
          const button = document.createElement('button');
          button.className = 'sr-match';
          const role = match.kind === 'user' ? '用户' : match.kind === 'assistant' ? '助手' : match.kind === 'metadata' ? '标题 / 摘要' : match.kind === 'artifact' ? '产物' : '工具记录';
          button.innerHTML = '<small>' + (match.turn ? '第 ' + match.turn + ' 轮 · ' : '') + role + '</small>' + highlightHtml(match.excerpt);
          button.addEventListener('click', () => loadSessionDetail(sessionKey(session), match));
          item.appendChild(button);
        }
        if (session.hasMore) {
          const button = document.createElement('button');
          button.className = 'sr-btn sr-more-matches';
          button.textContent = '更多命中';
          button.addEventListener('click', () => fetchSessions(true, session));
          item.appendChild(button);
        }
      }
      listEl.appendChild(item);
    }
    if (listHasMore) {
      const footer = document.createElement('div');
      footer.className = 'sr-list-more';
      footer.innerHTML = '<button class="sr-btn sr-load-more">加载更多' + (queryText ? '搜索结果' : '会话') + '</button>';
      footer.querySelector('button')!.addEventListener('click', () => fetchSessions(true));
      listEl.appendChild(footer);
    }
    listEl.scrollTop = scrollTop;
  }

  function renderMessage(item: ContentItem, ref: SessionRef): HTMLElement {
    const message = document.createElement('article');
    message.className = 'sr-message sr-message-' + item.kind;
    message.dataset.eventIndex = String(item.index);
    message.dataset.locator = item.locator ?? '';
    const selected = currentMatches()[selectedMatch];
    if (selected?.index === item.index && selected.kind === item.kind) message.classList.add('is-target');
    const time = item.timestamp ? new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    message.innerHTML = '<div class="sr-message-header"><strong>' + (item.kind === 'user' ? '用户' : '助手') + '</strong><span class="sr-message-meta">' + escapeHtml(time) + '</span><button class="sr-btn sr-copy-reference"' + (item.locator ? '' : ' disabled title="此消息缺少定位信息"') + '>复制引用</button></div>';
    const copy = message.querySelector<HTMLButtonElement>('button')!;
    copy.addEventListener('click', () => {
      const range = selected?.index === item.index ? selected.fields?.find((field) => field.field === 'text')?.ranges[0] : undefined;
      const excerpt = range ? item.content.slice(Math.max(0, range[0] - 100), range[1] + 300) : item.content;
      void copyText(agentReference(ref, { locator: item.locator, excerpt }), copy);
    });
    message.appendChild(markdownBody(item.content));
    if (item.truncationNote) {
      const note = document.createElement('p');
      note.className = 'sr-message-meta';
      note.textContent = item.truncationNote;
      message.appendChild(note);
    }
    return message;
  }

  function renderModalBody(savePosition = true) {
    if (savePosition) saveReadingPosition();
    const content = overlayEl?.querySelector<HTMLElement>('.sr-content');
    if (!content) return;
    if (!activeSessionId) {
      content.innerHTML = '<div class="sr-empty"><strong>找到那次关键讨论</strong>搜索关键词，阅读原文确认后，复制引用交给 Agent。</div>';
      return;
    }
    if (detailError) {
      content.innerHTML = '<div class="sr-empty sr-error">' + escapeHtml(detailError) + '<br><button class="sr-btn">重新加载</button></div>';
      content.querySelector('button')!.addEventListener('click', () => loadSessionDetail(activeSessionId!));
      return;
    }
    const view = activeSessionData;
    if (!view) {
      content.innerHTML = '<div class="sr-empty">正在读取会话目录…</div>';
      return;
    }
    const { ref } = view;
    const matches = currentMatches();
    content.innerHTML = '<div class="sr-content-header">' +
      '<div class="sr-header-top">' +
      '<h1 class="sr-header-title-text" title="' + escapeHtml(ref.title || '') + '">' + escapeHtml(ref.title || '未命名会话') + '</h1>' +
      '<div class="sr-header-actions">' +
      '<button class="sr-btn" id="sr-copy-id">复制会话 ID</button>' +
      '<button class="sr-btn sr-primary" id="sr-copy-agent">复制引用给 Agent</button>' +
      '</div>' +
      '</div>' +
      '<div class="sr-header-path">' + escapeHtml(ref.provider) + ' · ' + escapeHtml(ref.workspace?.split('/').pop() || '未记录项目') + (ref.createdAt ? ' · ' + new Date(ref.createdAt).toLocaleDateString('zh-CN') : '') + ' · ' + view.turns.length + ' 轮</div>' +
      '<div class="sr-reader-toolbar">' +
      '<button class="sr-btn" id="sr-toggle-directory" aria-expanded="' + showDirectory + '">轮次目录</button>' +
      '<button class="sr-btn" id="sr-toggle-details" aria-expanded="' + showDetails + '">辅助详情</button>' + (matches.length ? '<span class="sr-message-meta">命中 ' + (selectedMatch >= 0 ? selectedMatch + 1 : '—') + ' / ' + matches.length + '</span>' +
      '<button class="sr-btn" id="sr-prev-match"' + (selectedMatch <= 0 ? ' disabled' : '') + '>上一处</button>' +
      '<button class="sr-btn" id="sr-next-match"' + (selectedMatch >= matches.length - 1 ? ' disabled' : '') + '>下一处</button>' : '') + '<span class="sr-status" role="status">' + escapeHtml(readerError || (readerBusy ? '正在读取原文…' : '')) + '</span>' +
      '</div>' +
      '</div>' +
      '<div class="sr-reading-layout">' + (showDirectory ? '<nav class="sr-turn-nav" aria-label="轮次目录">' +
      '</nav>' : '') + '<div class="sr-reading-column">' + (inspection ? '<section class="sr-inspection" aria-label="定位内容">' +
      '</section>' : '') + '<div class="sr-dialogue" aria-label="对话原文">' +
      '</div>' +
      '</div>' + (showDetails ? '<aside class="sr-detail-panel" aria-label="辅助详情">' +
      '</aside>' : '') + '</div>';
    const bind = (selector: string, callback: (button: HTMLButtonElement) => void) => {
      const button = content.querySelector<HTMLButtonElement>(selector);
      button?.addEventListener('click', () => callback(button));
    };
    bind('#sr-copy-id', (button) => copyText(sessionKey(ref), button));
    bind('#sr-copy-agent', (button) => copyText(agentReference(ref), button));
    if (!isStandalone()) {
      const copy = getContinuationCopy();
      const button = document.createElement('button');
      button.className = 'sr-btn';
      button.id = 'sr-continue-dsh';
      button.disabled = !view.continuation?.available || Boolean(view.continuationBusy);
      button.textContent = view.continuationBusy ? copy.loading : ref.provider === 'dsh' ? copy.openDsh : copy.continue;
      button.addEventListener('click', () => openInDshChat(ref.path || sessionKey(ref), ref.provider));
      content.querySelector('#sr-copy-agent')!.after(button);
      const reason = view.continuationError || view.continuation?.reason;
      if (reason) {
        button.title = reason;
        const notice = document.createElement('p');
        notice.className = view.continuationError ? 'sr-message-meta sr-error' : 'sr-message-meta';
        notice.textContent = reason;
        content.querySelector('.sr-content-header')!.appendChild(notice);
      }
    }
    bind('#sr-toggle-directory', () => { showDirectory = !showDirectory; renderModalBody(); });
    bind('#sr-toggle-details', () => { showDetails = !showDetails; renderModalBody(); if (showDetails) void loadDetails(); });
    bind('#sr-prev-match', () => jumpToMatch(matches[selectedMatch - 1]!));
    bind('#sr-next-match', () => jumpToMatch(matches[selectedMatch + 1]!));
    const nav = content.querySelector('.sr-turn-nav');
    for (const turn of view.turns) {
      if (!nav) break;
      const button = document.createElement('button');
      button.className = turn.no === view.currentTurn ? 'active' : '';
      button.innerHTML = '<small>第 ' + turn.no + ' 轮</small>' + escapeHtml(turn.prompt.slice(0, 90) || '未记录请求');
      button.addEventListener('click', () => { inspection = null; selectedMatch = -1; void loadTurn(turn.no); });
      nav.appendChild(button);
    }
    const pane = content.querySelector<HTMLElement>('.sr-dialogue')!;
    pane.dataset.session = sessionKey(ref);
    const loaded = [...view.loaded.keys()].sort((a, b) => a - b);
    const pageButton = (label: string, callback: () => void) => {
      const button = document.createElement('button');
      button.className = 'sr-btn';
      button.textContent = label;
      button.disabled = readerBusy;
      button.addEventListener('click', callback);
      return button;
    };
    const first = view.turns.findIndex((turn) => turn.no === loaded[0]);
    const last = view.turns.findIndex((turn) => turn.no === loaded.at(-1));
    if (first > 0) pane.appendChild(pageButton('加载前一轮', () => loadTurn(view.turns[first - 1]!.no, 'before')));
    for (const no of loaded) {
      const page = view.loaded.get(no)!;
      const summary = view.turns.find((turn) => turn.no === no)!;
      const turn = document.createElement('section');
      turn.className = 'sr-turn';
      turn.dataset.turn = String(no);
      turn.innerHTML = '<div class="sr-turn-heading">第 ' + no + ' 轮' + (summary.startedAt ? ' · ' + new Date(summary.startedAt).toLocaleString('zh-CN') : '') + '</div>';
      for (const item of page.items) turn.appendChild(renderMessage(item, ref));
      if (page.nextCursor) turn.appendChild(pageButton('继续读取本轮原文', () => loadTurn(no, 'after', true)));
      if (page.tools.length) {
        const tools = document.createElement('details');
        tools.className = 'sr-tools';
        tools.innerHTML = '<summary>工具记录 · ' + page.tools.length + ' 次</summary>';
        for (const call of page.tools) {
          const row = document.createElement('div');
          row.className = 'sr-tool-row';
          const label = document.createElement('span');
          label.textContent = (call.toolName ?? '工具') + ' · ' + (call.status === 'failed' ? '失败' : call.status === 'completed' ? '已完成' : '结果未确认');
          row.appendChild(label);
          row.appendChild(pageButton('查看记录', () => inspectContent(new URLSearchParams({ call: call.id }), '工具 · ' + (call.toolName ?? '未命名'))));
          tools.appendChild(row);
        }
        turn.appendChild(tools);
      }
      pane.appendChild(turn);
    }
    if (last >= 0 && last < view.turns.length - 1) pane.appendChild(pageButton('加载后一轮', () => loadTurn(view.turns[last + 1]!.no, 'after')));
    if (!loaded.length && !readerBusy) {
      pane.innerHTML = '<div class="sr-empty">' + (view.turns.length ? '尚未读取原文' : '此会话未记录可见对话') + '</div>';
      if (view.turns.length) pane.appendChild(pageButton('读取对话', () => loadTurn(view.currentTurn)));
    }
    if (readerError && view.currentTurn) pane.appendChild(pageButton('重试读取当前轮次', () => loadTurn(view.currentTurn)));
    pane.scrollTop = view.scrollTop;
    pane.addEventListener('scroll', () => { view.scrollTop = pane.scrollTop; }, { passive: true });
    if (inspection) renderInspection(content.querySelector('.sr-inspection')!, inspection, ref);
    if (showDetails) renderDetails(content.querySelector('.sr-detail-panel')!, view);
  }

  function renderInspection(container: Element, target: Inspection, ref: SessionRef) {
    container.innerHTML = '<div class="sr-header-top"><strong>' + escapeHtml(target.label) + '</strong><div class="sr-header-actions"><button class="sr-btn sr-inspect-copy">复制引用</button><button class="sr-btn sr-inspect-close">收起</button></div></div>';
    const button = container.querySelector<HTMLButtonElement>('.sr-inspect-copy')!;
    button.disabled = !target.items.length && !target.artifactPath;
    button.addEventListener('click', () => copyText(agentReference(ref, {
      artifactPath: target.artifactPath, locator: target.items[0]?.locator,
      callId: target.items[0]?.callId, excerpt: target.items.map((item) => item.content).join('\n'),
    }), button));
    container.querySelector('.sr-inspect-close')!.addEventListener('click', () => { inspectionAbort?.abort(); inspection = null; renderModalBody(); });
    if (!target.items.length) {
      const note = document.createElement('p');
      note.textContent = target.error || (target.loading ? '正在读取定位内容…' : '未记录可读文本');
      container.appendChild(note);
    }
    for (const item of target.items) {
      if (item.field === 'text' && item.kind !== 'tool_result') container.appendChild(markdownBody(item.content));
      else {
        const pre = document.createElement('pre');
        pre.textContent = (item.field === 'arguments' ? '参数\n' : item.field === 'result' ? '结果\n' : '') + item.content;
        container.appendChild(pre);
      }
      if (item.truncationNote) {
        const note = document.createElement('p');
        note.textContent = item.truncationNote;
        container.appendChild(note);
      }
    }
    if (target.nextCursor || target.error) {
      const more = document.createElement('button');
      more.className = 'sr-btn';
      more.textContent = target.nextCursor ? '继续读取' : '重试';
      more.disabled = target.loading;
      more.addEventListener('click', () => inspectContent(target.params, target.label, target.artifactPath, Boolean(target.nextCursor)));
      container.appendChild(more);
    }
  }

  function renderDetails(container: Element, view: SessionView) {
    const { ref } = view;
    const stats = view.details?.overview?.stats;
    container.innerHTML = '<details open>' +
      '<summary>会话信息</summary>' +
      '<p>会话 ID<br>' + escapeHtml(sessionKey(ref)) + '</p>' +
      '<p>项目路径<br>' + escapeHtml(ref.workspace || '未记录') + '</p>' +
      '<p>创建：' + escapeHtml(ref.createdAt || '未记录') + '<br>更新：' + escapeHtml(ref.updatedAt || '未记录') + '</p>' + (ref.summary ? '<div class="sr-saved-summary">' +
      '</div>' : '') + (stats ? '<p>' + stats.turns + ' 轮 · ' + stats.filesChanged + ' 个文件 · ' + stats.commands + ' 条命令<br>模型：' + escapeHtml(stats.models?.join('、') || '未记录') + '<br>分支：' + escapeHtml(stats.branches?.join('、') || '未记录') + '</p>' : '<p>正在读取辅助详情…</p>') + '</details>' +
      '<details class="sr-file-details">' +
      '<summary>文件记录</summary>' +
      '</details>' +
      '<details class="sr-artifact-details">' +
      '<summary>产物</summary>' +
      '</details>';
    if (ref.summary) container.querySelector('.sr-saved-summary')!.appendChild(markdownBody(ref.summary));
    const info = container.querySelector('details')!;
    for (const title of ref.titles ?? []) {
      const label = document.createElement('p');
      label.innerHTML = '<span class="sr-message-meta">已保存标题 · ' + escapeHtml(title.source) + '</span><br>' + highlightHtml(title.text);
      info.appendChild(label);
    }
    if (view.detailsError) {
      const notice = document.createElement('p');
      notice.className = 'sr-error';
      notice.textContent = view.detailsError;
      const retry = document.createElement('button');
      retry.className = 'sr-btn';
      retry.textContent = '重试加载详情';
      retry.addEventListener('click', () => loadDetails());
      info.append(notice, retry);
    }
    const files = container.querySelector('.sr-file-details')!;
    for (const file of view.details?.files ?? []) {
      const button = document.createElement('button');
      button.className = 'sr-btn';
      button.textContent = 'T' + file.turn + ' · ' + (file.displayPath || file.path);
      button.title = file.operation + ' · ' + file.path;
      button.addEventListener('click', async () => {
        selectedMatch = -1;
        await loadTurn(file.turn);
        if (activeSessionData !== view) return;
        await inspectContent(new URLSearchParams({ event: String(file.eventIndex) }), '文件操作 · ' + file.path);
      });
      files.appendChild(button);
    }
    const artifacts = container.querySelector('.sr-artifact-details')!;
    for (const artifact of stats?.artifacts ?? []) {
      const button = document.createElement('button');
      button.className = 'sr-btn';
      button.textContent = artifact.name;
      button.addEventListener('click', () => inspectContent(new URLSearchParams({ artifact: artifact.path }), '产物 · ' + artifact.name, artifact.path));
      artifacts.appendChild(button);
    }
    if (view.details && !(view.details.files?.length)) files.insertAdjacentHTML('beforeend', '<p>未记录文件写入</p>');
    if (stats && !stats.artifacts?.length) artifacts.insertAdjacentHTML('beforeend', '<p>未记录产物</p>');
  }

  function openPanel() {
    if (overlayEl) return;
    const activeWs = getActiveWorkspaceInfo();
    activeWorkspaceKey = JSON.stringify(activeWs);
    const wsDisplay = activeWs.title || activeWs.cwd?.split('/').pop() || '当前';
    overlayEl = document.createElement('div');
    overlayEl.className = 'sr-overlay' + (isStandalone() ? ' sr-standalone' : '');
    if (!isStandalone()) {
      overlayEl.setAttribute('role', 'dialog');
      overlayEl.setAttribute('aria-modal', 'true');
      overlayEl.setAttribute('aria-label', '历史会话');
    }
    overlayEl.innerHTML = '<div class="sr-card">' +
      '<header class="sr-header">' +
      '<div class="sr-header-top">' +
      '<div class="sr-header-title">' + ICON_SVG + '<span>历史会话 · Session Reader</span>' +
      '</div>' +
      '<span class="sr-header-hint">找到关键对话，确认后交给 Agent</span>' +
      '<button class="sr-btn sr-btn-close" aria-label="关闭">✕</button>' +
      '</div>' +
      '<div class="sr-search-row">' +
      '<input type="search" class="sr-search-input" aria-label="搜索关键词" placeholder="搜索对话中的关键词…" />' +
      '<button class="sr-btn sr-primary sr-btn-search">搜索</button>' +
      '<select class="sr-select sr-select-scope" aria-label="工作区">' +
      '<option value="cwd">当前工作区 (' + escapeHtml(wsDisplay) + ')</option>' +
      '<option value="global">全部工作区</option>' +
      '</select>' +
      '<select class="sr-select sr-select-provider" aria-label="Agent 来源">' +
      '<option value="">全部 Agent</option>' +
      '<option value="antigravity">Antigravity</option>' +
      '<option value="claude">Claude Code</option>' +
      '<option value="grok">Grok</option>' +
      '<option value="codex">Codex</option>' +
      '<option value="dsh">DSH</option>' +
      '</select>' +
      '<select class="sr-select sr-select-since" aria-label="更新时间">' +
      '<option value="">全部时间</option>' +
      '<option value="1">最近一天</option>' +
      '<option value="7">最近一周</option>' +
      '<option value="30">最近一月</option>' +
      '</select>' +
      '<select class="sr-select sr-select-area" aria-label="搜索范围">' +
      '<option value="dialogue">对话 / 标题</option>' +
      '<option value="tools">工具记录</option>' +
      '<option value="artifacts">产物</option>' +
      '<option value="all">全部内容</option>' +
      '</select>' +
      '<button class="sr-btn sr-btn-refresh">刷新</button>' +
      '</div>' +
      '</header>' +
      '<div class="sr-main">' +
      '<aside class="sr-sidebar" aria-label="候选会话">' +
      '</aside>' +
      '<main class="sr-content">' +
      '</main>' +
      '</div>' +
      '</div>';
    document.body.appendChild(overlayEl);
    overlayEl.querySelector('.sr-btn-close')!.addEventListener('click', closePanel);
    if (!isStandalone()) overlayEl.addEventListener('click', (event) => { if (event.target === overlayEl) closePanel(); });
    document.addEventListener('keydown', onEscape);
    const doQuery = () => {
      const area = overlayEl!.querySelector<HTMLSelectElement>('.sr-select-area')!.value;
      const hints: Record<string, string> = {
        dialogue: '搜索对话中的关键词…', tools: '搜索工具名、参数或结果…',
        artifacts: '搜索产物名称或内容…', all: '搜索对话、工具和产物…',
      };
      overlayEl!.querySelector<HTMLInputElement>('.sr-search-input')!.placeholder = hints[area]!;
      void fetchSessions();
    };
    overlayEl.querySelector('.sr-search-input')!.addEventListener('keydown', (event) => { if ((event as KeyboardEvent).key === 'Enter') doQuery(); });
    overlayEl.querySelector('.sr-search-input')!.addEventListener('search', doQuery);
    overlayEl.querySelectorAll('select').forEach((select) => select.addEventListener('change', doQuery));
    overlayEl.querySelector('.sr-btn-search')!.addEventListener('click', doQuery);
    overlayEl.querySelector('.sr-btn-refresh')!.addEventListener('click', doQuery);
    if (getBoot().defaultScope === 'global') overlayEl.querySelector<HTMLSelectElement>('.sr-select-scope')!.value = 'global';
    renderModalBody();
    doQuery();
  }

  function syncWorkspace() {
    if (!overlayEl) return;
    const workspace = getActiveWorkspaceInfo();
    const key = JSON.stringify(workspace);
    if (key === activeWorkspaceKey) return;
    activeWorkspaceKey = key;
    const scope = overlayEl.querySelector<HTMLSelectElement>('.sr-select-scope')!;
    scope.querySelector('option[value="cwd"]')!.textContent = '当前工作区 (' + (workspace.title || '未选择') + ')';
    if (scope.value === 'cwd') void fetchSessions();
  }

  if (!isStandalone()) {
    _ctx.effect(() => {
      const sources = [
        _ctx.get('uiSession').adapter.current,
        _ctx.get('sessions').list,
        _ctx.get('workspaces').list,
      ];
      const disposers = sources.map(source => source.subscribe(syncWorkspace));
      return () => { disposers.forEach(dispose => dispose()); closePanel(); };
    });
  }

  if (isStandalone()) {
    openPanel();
    return;
  }

  // 3. Mount Sidebar Entry
  function tryMountSidebar() {
    if (document.querySelector('[data-dsh-session-reader-entry]')) return;

    // Look for sidebar root
    const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
    if (!column) return;
    const root = column.querySelector('[class*="logoRow"]')?.parentElement ?? column.firstElementChild;
    if (!root) return;

    // Look for New Session button
    let newSessionBtn = root.querySelector('button[class*="newSession"]');
    if (!newSessionBtn) {
      for (const child of Array.from(root.children)) {
        if (child.tagName === 'BUTTON') {
          newSessionBtn = child;
          break;
        }
      }
    }
    if (!newSessionBtn) return;

    // Create entry button
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.setAttribute('data-dsh-session-reader-entry', '');
    entry.setAttribute('data-dsh-plugin', 'session-reader');
    entry.setAttribute('data-dsh-part', 'sidebar-entry');
    entry.setAttribute('title', '历史会话 (Session Reader)：查看跨Agent历史对话与会话详情');
    entry.setAttribute('aria-label', '历史会话');

    entry.innerHTML = `
      <span class="sr-icon">${ICON_SVG}</span>
      <span class="sr-label">历史会话</span>
    `;

    entry.addEventListener('click', openPanel);

    // Position after other family items (task-board, skill-explorer, etc.)
    const familySelectors = [
      '[data-dsh-taskboard-entry]',
      '[data-dsh-ssh-entry]',
      '[data-dsh-skill-explorer-entry]',
      '[data-dsh-session-reader-entry]'
    ];
    const family = Array.from(root.children).filter(el => el instanceof HTMLElement && el.matches(familySelectors.join(', ')));
    const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : (newSessionBtn.closest('[class*="logoRow"]') ?? newSessionBtn).nextElementSibling;
    root.insertBefore(entry, anchor);
  }

  // Observe DOM for sidebar rendering
  const observer = new MutationObserver(() => {
    tryMountSidebar();
  });
  const target = document.body ?? document.documentElement;
  if (target) {
    observer.observe(target, { childList: true, subtree: true });
  }
}

function escapeHtml(str: string) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
