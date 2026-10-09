/** Copy for native continuation, shared by the embedded browser entry. */
export const continuationDictionaries = {
    zh: {
        continue: '在 DSH 中继续原会话', openDsh: '在 DSH 中打开', readOnly: '只读查看',
        loading: '正在恢复原会话…', failed: '续聊失败：', unavailable: '暂时无法检查续聊状态',
        navigationUnavailable: 'DSH 会话导航不可用，请重新打开历史面板',
    },
    en: {
        continue: 'Continue original session in DSH', openDsh: 'Open in DSH', readOnly: 'Read only',
        loading: 'Restoring session…', failed: 'Could not continue: ', unavailable: 'Continuation status is unavailable',
        navigationUnavailable: 'DSH navigation is unavailable; reopen the history panel',
    },
};
export function continuationCopy(translate) {
    if (translate)
        return Object.fromEntries(Object.keys(continuationDictionaries.zh).map(key => [key, translate(key)]));
    const locale = typeof document === 'undefined' ? 'zh' : document.documentElement.lang || navigator.language;
    return locale.startsWith('zh') ? continuationDictionaries.zh : continuationDictionaries.en;
}
