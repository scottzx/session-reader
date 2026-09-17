// Browser client entry for @1agents/session-reader in DSH Web
import { mountConversation, renderMarkdown } from '@1agents/chat-ui';

const CSS_TEXT = `
[data-dsh-session-reader-entry] {
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  color: var(--dsw-alias-label-secondary, #666);
  cursor: pointer;
  white-space: nowrap;
  background: transparent;
  border: none;
  border-radius: 8px;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  font-size: 13px;
  display: flex;
  transition: background 0.15s ease, color 0.15s ease;
}
[data-dsh-session-reader-entry]:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05));
  color: var(--dsw-alias-label-primary, #111);
}
body[data-ds-dark-theme] [data-dsh-session-reader-entry]:hover {
  background: rgba(255,255,255,0.08);
  color: #fff;
}
[data-dsh-session-reader-entry] .sr-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
}
[data-dsh-session-reader-entry] .sr-label {
  text-overflow: ellipsis;
  overflow: hidden;
}
[data-dsh-frame][data-sidebar-collapsed] [data-dsh-session-reader-entry],
[data-sidebar-collapsed] [data-dsh-session-reader-entry] {
  border-radius: 50%;
  justify-content: center;
  width: 36px;
  height: 36px;
  margin: 0 auto 12px;
  padding: 0;
}
[data-dsh-frame][data-sidebar-collapsed] [data-dsh-session-reader-entry] .sr-label,
[data-sidebar-collapsed] [data-dsh-session-reader-entry] .sr-label {
  display: none;
}

/* Modal Overlay */
.sr-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: var(--dsw-alias-bg-mask-2, rgba(0,0,0,0.45));
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--dsw-alias-label-primary, #1c1e26);
}
.sr-card {
  width: min(1140px, 94vw);
  height: min(820px, 90vh);
  background: var(--dsw-alias-bg-overlay, #ffffff);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
}
body[data-ds-dark-theme] .sr-card {
  background: #1e1e20;
  border-color: #333336;
  color: #e5e5ea;
}

/* Header */
.sr-header {
  height: 56px;
  padding: 0 18px;
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--dsw-alias-bg-base, #ffffff);
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
}
body[data-ds-dark-theme] .sr-header {
  background: #252528;
  border-color: #333336;
}
.sr-header-title {
  font-size: 15px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.sr-search-input {
  flex: 1;
  max-width: 320px;
  height: 32px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1, #d1d5db);
  background: var(--dsw-alias-bg-layer-1, #f9fafb);
  color: inherit;
  font-size: 13px;
}
body[data-ds-dark-theme] .sr-search-input {
  background: #18181a;
  border-color: #3a3a3e;
}
.sr-select {
  height: 32px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1, #d1d5db);
  background: var(--dsw-alias-bg-layer-1, #f9fafb);
  color: inherit;
  font-size: 12px;
}
body[data-ds-dark-theme] .sr-select {
  background: #18181a;
  border-color: #3a3a3e;
}
.sr-btn {
  height: 32px;
  padding: 0 12px;
  border-radius: 6px;
  border: none;
  background: var(--dsw-alias-interactive-bg-hover, #f3f4f6);
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
body[data-ds-dark-theme] .sr-btn {
  background: #2e2e33;
}
.sr-btn:hover {
  filter: brightness(0.95);
}
.sr-btn-close {
  width: 32px;
  height: 32px;
  padding: 0;
  justify-content: center;
  font-size: 16px;
}

/* Layout Split */
.sr-main {
  flex: 1;
  display: flex;
  overflow: hidden;
}
.sr-sidebar {
  width: 330px;
  flex: none;
  border-right: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  overflow-y: auto;
  background: var(--dsw-alias-bg-layer-1, #fafafa);
}
body[data-ds-dark-theme] .sr-sidebar {
  background: #18181a;
  border-color: #333336;
}
.sr-session-item {
  padding: 12px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06));
  cursor: pointer;
  transition: background 0.12s ease;
}
body[data-ds-dark-theme] .sr-session-item {
  border-color: rgba(255,255,255,0.06);
}
.sr-session-item:hover {
  background: rgba(0,0,0,0.03);
}
body[data-ds-dark-theme] .sr-session-item:hover {
  background: rgba(255,255,255,0.04);
}
.sr-session-item.active {
  background: var(--dsw-alias-state-business-secondary, #eff6ff);
  border-left: 3px solid var(--dsw-alias-state-business-primary, #3b82f6);
}
body[data-ds-dark-theme] .sr-session-item.active {
  background: #1e283d;
  border-left-color: #60a5fa;
}
.sr-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.sr-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  text-transform: uppercase;
}
.sr-badge-antigravity { background: #f3e8ff; color: #7e22ce; }
.sr-badge-claude { background: #ffedd5; color: #c2410c; }
.sr-badge-grok { background: #e0f2fe; color: #0369a1; }
.sr-badge-codex { background: #dcfce7; color: #15803d; }
.sr-badge-dsh { background: #dbeafe; color: #1d4ed8; }

.sr-item-time {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #888);
}
.sr-item-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  margin-bottom: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sr-item-ws {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #888);
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}

/* Detail & Chat Pane */
.sr-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--dsw-alias-bg-base, #ffffff);
}
body[data-ds-dark-theme] .sr-content {
  background: #1e1e20;
}
.sr-content-header {
  padding: 10px 18px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  display: flex;
  flex-direction: column;
  gap: 5px;
}
body[data-ds-dark-theme] .sr-content-header {
  border-color: #333336;
}
.sr-header-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
}
.sr-header-title-text {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-primary, #111);
}
body[data-ds-dark-theme] .sr-header-title-text {
  color: #fff;
}
.sr-header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.sr-header-path {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #888);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  width: 100%;
}
.sr-header-provider {
  font-weight: 600;
  text-transform: uppercase;
}
.sr-tabs {
  display: flex;
  gap: 8px;
}
.sr-tab-btn {
  padding: 6px 12px;
  font-size: 12px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #666);
}
.sr-tab-btn.active {
  background: var(--dsw-alias-interactive-bg-hover, #f3f4f6);
  color: var(--dsw-alias-label-primary, #111);
  font-weight: 600;
}
body[data-ds-dark-theme] .sr-tab-btn.active {
  background: #2e2e33;
  color: #fff;
}
.sr-open-dsh-btn {
  background: var(--dsw-alias-brand-primary, #3b82f6);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: opacity 0.15s ease, transform 0.1s ease;
  white-space: nowrap;
}
.sr-open-dsh-btn:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}
.sr-open-dsh-btn:active {
  transform: translateY(0);
}
.sr-open-dsh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.sr-scroll-area {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}
.sr-scroll-area-flow {
  overflow: auto;
  padding: 16px 18px;
}

/* Standalone 1session web — full viewport, no DSH chrome */
.sr-standalone.sr-overlay {
  background: #f4f5f7;
  backdrop-filter: none;
  padding: 0;
}
.sr-standalone .sr-card {
  width: 100%;
  height: 100%;
  max-width: none;
  border-radius: 0;
  box-shadow: none;
  border: none;
}
.sr-standalone .sr-btn-close,
.sr-standalone .sr-open-dsh-btn {
  display: none;
}
.sr-file-group {
  margin-bottom: 18px;
}
.sr-file-group-title {
  font-size: 12px;
  font-weight: 600;
  color: #666;
  margin-bottom: 8px;
}
.sr-file-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(0,0,0,0.06);
  font-size: 13px;
}
.sr-file-turn {
  flex: none;
  font-size: 11px;
  color: #888;
  min-width: 32px;
}
.sr-file-path {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sr-file-op {
  flex: none;
  font-size: 11px;
  color: #888;
}
`;

const ICON_SVG = `<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><polyline points="8 4.2 8 8 10.5 9.5"/></svg>`;

export const inject = ['sessions', 'workspaces'];

type SrTab = 'chat' | 'overview' | 'files';

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

export function apply(_ctx: any) {
  if (typeof document === 'undefined') return;

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
  let cachedSessions: any[] = [];
  let currentTab: SrTab = 'chat';
  let activeSessionData: any = null;
  let listAbort: AbortController | null = null;
  let detailAbort: AbortController | null = null;
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
      const currentSessionId = sessionSnapshot?.current;
      const sessionCwd = currentSessionId ? sessionSnapshot?.byId?.[currentSessionId]?.cwd : undefined;

      const workspaces = dshCtx?.get ? (dshCtx.get('workspaces') ?? dshCtx.workspaces) : dshCtx?.workspaces;
      const wsSnapshot = workspaces?.list?.getSnapshot?.();
      const items = wsSnapshot?.items || [];

      // 1. If current session is active, find its workspace
      if (currentSessionId) {
        const matched = items.find((w: any) => w.sessionIds?.includes(currentSessionId));
        if (matched) {
          return {
            cwd: matched.path,
            title: matched.title || matched.path.split('/').pop() || '当前工作区',
            workspaceId: matched.workspaceId,
          };
        }
      }

      // 2. If current session has cwd directly
      if (sessionCwd) {
        const matched = items.find((w: any) => w.path === sessionCwd);
        return {
          cwd: sessionCwd,
          title: matched?.title || sessionCwd.split('/').pop() || '当前工作区',
          workspaceId: matched?.workspaceId,
        };
      }

      // 3. Fallback: first workspace in items
      if (items.length > 0) {
        return {
          cwd: items[0].path,
          title: items[0].title || items[0].path.split('/').pop() || '当前工作区',
          workspaceId: items[0].workspaceId,
        };
      }
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
    currentTab = 'chat';
  }

  async function openInDshChat(sessionId: string, btn?: HTMLElement) {
    if (btn) {
      btn.innerHTML = '⏳ 正在加载到 DSH...';
      (btn as any).disabled = true;
    }
    try {
      const activeWs = getActiveWorkspaceInfo();
      const res = await fetch('/api/session-reader/open-in-dsh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          currentCwd: activeWs.cwd,
          workspaceId: activeWs.workspaceId,
        }),
      });
      const result = await res.json();
      if (!res.ok || !result.success) {
        alert('接入 DSH 失败: ' + (result.error || res.statusText));
        if (btn) {
          btn.innerHTML = '🚀 在 DSH 官方 Chat 中打开';
          (btn as any).disabled = false;
        }
        return;
      }
      const dshSessionId = result.dshSessionId;
      closePanel();

      const sessions = dshCtx?.get ? (dshCtx.get('sessions') ?? dshCtx.sessions) : dshCtx?.sessions;
      if (sessions) {
        if (typeof sessions.refresh === 'function') {
          await sessions.refresh();
        }
        if (typeof sessions.open === 'function') {
          sessions.open(dshSessionId);
        }
      } else {
        console.warn('[session-reader] Could not obtain DSH sessions service from ctx');
      }
    } catch (err: any) {
      alert('请求出错: ' + (err?.message || err));
      if (btn) {
        btn.innerHTML = '🚀 在 DSH 官方 Chat 中打开';
        (btn as any).disabled = false;
      }
    }
  }

  async function loadSessionDetail(sessionId: string) {
    detailAbort?.abort();
    const ac = new AbortController();
    detailAbort = ac;
    const timer = window.setTimeout(() => ac.abort(), DETAIL_TIMEOUT_MS);

    activeSessionId = sessionId;
    activeSessionData = null;
    renderModalBody();
    renderSessionList();
    try {
      const res = await fetch(`/api/session-reader/session/${encodeURIComponent(sessionId)}`, {
        signal: ac.signal,
        cache: 'no-store',
      });
      if (!res.ok) {
        let extra = '';
        try {
          const body = await res.json();
          extra = body?.error ? `: ${body.error}` : '';
        } catch { /* ignore */ }
        throw new Error(`HTTP ${res.status}${extra}`);
      }
      const data = await res.json();
      if (detailAbort !== ac) return;
      activeSessionData = data;
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        if (detailAbort === ac) {
          activeSessionData = { error: '加载超时，请稍后重试或换一个会话' };
        } else {
          return;
        }
      } else {
        if (detailAbort !== ac) return;
        activeSessionData = { error: err.message };
      }
    } finally {
      window.clearTimeout(timer);
    }
    if (detailAbort !== ac) return;
    renderModalBody();
  }

  async function fetchSessions(q = '', scope = 'cwd', provider = '') {
    const listEl = overlayEl?.querySelector('.sr-sidebar');
    const firstLoad = cachedSessions.length === 0;
    if (firstLoad && listEl) {
      listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#888;font-size:12px;">加载会话中...</div>';
    }

    listAbort?.abort();
    const ac = new AbortController();
    listAbort = ac;
    const timer = window.setTimeout(() => ac.abort(), LIST_TIMEOUT_MS);

    try {
      const activeWs = getActiveWorkspaceInfo();
      const params = new URLSearchParams();
      params.set('limit', '50');
      params.set('scope', scope);
      if (scope === 'cwd' && activeWs.cwd) {
        params.set('workspace', activeWs.cwd);
      }
      if (provider) {
        params.set('provider', provider);
      }
      if (q) {
        params.set('q', q);
      }
      const endpoint = q ? '/api/session-reader/search' : '/api/session-reader/sessions';
      const res = await fetch(`${endpoint}?${params.toString()}`, {
        signal: ac.signal,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (listAbort !== ac) return;
      cachedSessions = data.sessions ?? (data.hits ? data.hits.map((h: any) => h.session) : []);
      if (activeSessionId && !cachedSessions.some((s: any) => s.id === activeSessionId)) {
        activeSessionId = null;
        activeSessionData = null;
      }
      renderSessionList();
      // Lazy: list metadata only. Full parse happens when the user clicks a row.
      renderModalBody();
    } catch (err: any) {
      if (err?.name === 'AbortError' && listAbort !== ac) return;
      const message = err?.name === 'AbortError' ? '加载超时，请缩小范围或稍后重试' : err.message;
      if (listEl) listEl.innerHTML = `<div style="padding:20px;text-align:center;color:#e11d48;font-size:12px;">加载失败: ${message}</div>`;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function renderSessionList() {
    const listEl = overlayEl?.querySelector('.sr-sidebar');
    if (!listEl) return;
    if (cachedSessions.length === 0) {
      listEl.innerHTML = '<div style="padding:30px 16px;text-align:center;color:#888;font-size:12px;line-height:1.6;">当前工作区下暂无匹配的历史会话<br/><span style="font-size:11px;color:#aaa;margin-top:6px;display:inline-block;">可切换上方下拉框选择「全部工作区」查看</span></div>';
      return;
    }
    listEl.innerHTML = '';
    cachedSessions.forEach((s) => {
      const item = document.createElement('div');
      item.className = `sr-session-item ${s.id === activeSessionId ? 'active' : ''}`;
      const badgeClass = `sr-badge sr-badge-${s.provider.toLowerCase().replace(/[^a-z]/g, '')}`;
      const timeStr = s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const wsName = s.workspace ? s.workspace.split('/').pop() : '';

      item.innerHTML = `
        <div class="sr-item-header">
          <span class="${badgeClass}">${s.provider}</span>
          <span class="sr-item-time">${timeStr}</span>
        </div>
        <div class="sr-item-title" title="${escapeHtml(s.title || '')}">${escapeHtml(s.title || 'Untitled Session')}</div>
        <div class="sr-item-ws" title="${escapeHtml(s.workspace || '')}">📁 ${escapeHtml(wsName || s.workspace || '')}</div>
      `;
      item.addEventListener('click', () => {
        overlayEl?.querySelectorAll('.sr-session-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        loadSessionDetail(s.id);
      });
      item.addEventListener('dblclick', () => {
        openInDshChat(s.id);
      });
      listEl.appendChild(item);
    });
  }

  function renderModalBody() {
    const contentEl = overlayEl?.querySelector('.sr-content');
    if (!contentEl) return;

    if (!activeSessionId) {
      contentEl.innerHTML = `<div style="padding:60px;text-align:center;color:#888;font-size:13px;">请在左侧选择一个会话查看</div>`;
      return;
    }

    if (!activeSessionData) {
      contentEl.innerHTML = `<div style="padding:60px;text-align:center;color:#888;font-size:13px;">正在解析会话事件与结构...</div>`;
      return;
    }

    if (activeSessionData.error) {
      contentEl.innerHTML = `<div style="padding:60px;text-align:center;color:#e11d48;font-size:13px;">加载失败: ${activeSessionData.error}</div>`;
      return;
    }

    const { ref, overview, turns, files } = activeSessionData;
    const standalone = isStandalone();
    const body =
      currentTab === 'chat'
        ? '<div id="sr-chat-root" style="width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;"></div>'
        : currentTab === 'files'
          ? renderFilesView(files)
          : renderOverviewView(overview);

    contentEl.innerHTML = `
      <div class="sr-content-header">
        <div class="sr-header-top">
          <div class="sr-header-title-text" title="${escapeHtml(ref.title || 'Untitled')}">
            ${escapeHtml(ref.title || 'Untitled')}
          </div>
          <div class="sr-header-actions">
            ${standalone ? '' : `<button class="sr-open-dsh-btn" id="sr-btn-open-dsh" title="将此历史会话接入并在 DSH 官方主聊天窗口中查看">
              🚀 在 DSH 官方 Chat 中打开
            </button>`}
            <div class="sr-tabs">
              <button class="sr-tab-btn ${currentTab === 'chat' ? 'active' : ''}" data-tab="chat">💬 快速预览</button>
              <button class="sr-tab-btn ${currentTab === 'files' ? 'active' : ''}" data-tab="files">📁 文件 ${Array.isArray(files) ? files.length : ''}</button>
              <button class="sr-tab-btn ${currentTab === 'overview' ? 'active' : ''}" data-tab="overview">📊 会话概览</button>
            </div>
          </div>
        </div>
        <div class="sr-header-path" title="${escapeHtml(ref.path || '')}">
          <span class="sr-header-provider">${ref.provider}</span> · 路径: ${escapeHtml(ref.path || '')}
        </div>
      </div>
      <div class="sr-scroll-area ${currentTab === 'chat' ? '' : 'sr-scroll-area-flow'}">
        ${body}
      </div>
    `;

    const openDshBtn = contentEl.querySelector('#sr-btn-open-dsh');
    if (openDshBtn) {
      openDshBtn.addEventListener('click', () => {
        openInDshChat(activeSessionId!, openDshBtn as HTMLElement);
      });
    }

    contentEl.querySelectorAll('.sr-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentTab = btn.getAttribute('data-tab') as SrTab;
        renderModalBody();
      });
    });

    if (currentTab === 'chat') {
      const chatRoot = contentEl.querySelector('#sr-chat-root') as HTMLElement;
      if (chatRoot) {
        mountConversation(chatRoot, {
          turns,
          cwd: ref.workspace || getActiveWorkspaceInfo().cwd,
          lang: 'zh-CN',
          emptyHint: '该会话暂无提取到的轮次记录。',
        });
      }
    }
  }

  function renderFilesView(files: any[] | undefined) {
    if (!files || files.length === 0) {
      return `<div style="padding:40px;text-align:center;color:#888;font-size:13px;">该会话没有记录到写入的文件</div>`;
    }
    const groups: Record<string, any[]> = { project: [], runtime: [], log: [] };
    for (const file of files) {
      const group = file.group && groups[file.group] ? file.group : 'runtime';
      groups[group]!.push(file);
    }
    const labels: Record<string, string> = {
      project: '项目文件',
      runtime: '运行时 / 工作区外',
      log: '日志与临时文件',
    };
    return Object.entries(groups)
      .filter(([, rows]) => rows.length > 0)
      .map(
        ([group, rows]) => `
        <div class="sr-file-group">
          <div class="sr-file-group-title">${labels[group] ?? group} · ${rows.length}</div>
          ${rows
            .map(
              (file) => `
            <div class="sr-file-row">
              <span class="sr-file-turn">T${file.turn ?? '?'}</span>
              <span class="sr-file-path" title="${escapeHtml(file.path || '')}">${escapeHtml(file.displayPath || file.path || '')}</span>
              <span class="sr-file-op">${escapeHtml(file.operation || '')}</span>
            </div>`,
            )
            .join('')}
        </div>`,
      )
      .join('');
  }

  function renderOverviewView(overview: any) {
    if (!overview) return '<div style="color:#888;">暂无概览数据</div>';
    const stats = overview.stats || {};
    return `
      <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;">
        <div style="background:rgba(0,0,0,0.03);border-radius:8px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1, #e5e7eb);font-size:12px;">
          <div style="color:#888;">总轮次</div>
          <div style="font-size:16px;font-weight:600;margin-top:2px;">${stats.turns ?? 0}</div>
        </div>
        <div style="background:rgba(0,0,0,0.03);border-radius:8px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1, #e5e7eb);font-size:12px;">
          <div style="color:#888;">改动文件</div>
          <div style="font-size:16px;font-weight:600;margin-top:2px;">${stats.fileChanges ?? 0}</div>
        </div>
        <div style="background:rgba(0,0,0,0.03);border-radius:8px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1, #e5e7eb);font-size:12px;">
          <div style="color:#888;">执行命令</div>
          <div style="font-size:16px;font-weight:600;margin-top:2px;">${stats.commands ?? 0}</div>
        </div>
        <div style="background:rgba(0,0,0,0.03);border-radius:8px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1, #e5e7eb);font-size:12px;">
          <div style="color:#888;">后台任务</div>
          <div style="font-size:16px;font-weight:600;margin-top:2px;">${stats.backgroundTasks ?? 0}</div>
        </div>
      </div>
      <div style="margin-top:16px;">
        ${renderMarkdown(overview.markdown || '')}
      </div>
    `;
  }

  function openPanel() {
    if (overlayEl) return;
    const activeWs = getActiveWorkspaceInfo();
    const wsDisplay = activeWs.title || (activeWs.cwd ? activeWs.cwd.split('/').pop() : '') || '当前';

    overlayEl = document.createElement('div');
    overlayEl.className = isStandalone() ? 'sr-overlay sr-standalone' : 'sr-overlay';
    overlayEl.innerHTML = `
      <div class="sr-card">
        <div class="sr-header">
          <div class="sr-header-title">
            ${ICON_SVG}
            <span>历史会话 · Session Reader</span>
          </div>
          <input type="text" class="sr-search-input" placeholder="搜索会话关键词、文件名、报错..." />
          <select class="sr-select sr-select-scope">
            <option value="cwd">当前工作区 (${escapeHtml(wsDisplay)})</option>
            <option value="global">全部工作区</option>
          </select>
          <select class="sr-select sr-select-provider">
            <option value="">全部 Agent</option>
            <option value="antigravity">Antigravity</option>
            <option value="claude">Claude Code</option>
            <option value="grok">Grok</option>
            <option value="codex">Codex</option>
            <option value="dsh">DSH</option>
          </select>
          <button class="sr-btn sr-btn-refresh">刷新</button>
          <button class="sr-btn sr-btn-close">✕</button>
        </div>
        <div class="sr-main">
          <div class="sr-sidebar"></div>
          <div class="sr-content"></div>
        </div>
      </div>
    `;

    document.body.appendChild(overlayEl);

    overlayEl.querySelector('.sr-btn-close')?.addEventListener('click', closePanel);
    if (!isStandalone()) {
      overlayEl.addEventListener('click', (e) => {
        if (e.target === overlayEl) closePanel();
      });
    }

    const searchInput = overlayEl.querySelector('.sr-search-input') as HTMLInputElement;
    const scopeSelect = overlayEl.querySelector('.sr-select-scope') as HTMLSelectElement;
    const providerSelect = overlayEl.querySelector('.sr-select-provider') as HTMLSelectElement;
    const refreshBtn = overlayEl.querySelector('.sr-btn-refresh') as HTMLButtonElement;

    const doQuery = () => {
      fetchSessions(searchInput.value.trim(), scopeSelect.value, providerSelect.value);
    };

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doQuery();
    });
    scopeSelect.addEventListener('change', doQuery);
    providerSelect.addEventListener('change', doQuery);
    refreshBtn.addEventListener('click', doQuery);

    if (getBoot().defaultScope === 'global') {
      scopeSelect.value = 'global';
    }

    renderModalBody();
    fetchSessions();
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
