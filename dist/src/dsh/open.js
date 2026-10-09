import { resolveSession } from '../resolver.js';
import { convertSessionToDshEvents } from './adapter.js';
/** Resolve the source once; missing/unsupported ACP leaves history readable without creating a DSH session. */
export async function continuationAvailability(ctx, ref) {
    if (ref.provider === 'dsh')
        return { available: true, agent: 'dsh' };
    const service = ctx.get?.('oneagentsAcpSessions');
    if (!service)
        return { available: false, reason: '续聊需要安装并启用 @1agents/acp-service；历史仍可只读查看' };
    return service.availability(ref.provider);
}
/** Open DSH's original identity or attach native history; ACP separately reports writing availability. */
export async function openSessionInDsh(ctx, request) {
    const resolved = await resolveSession(request.sessionId, request.provider);
    if (!resolved)
        throw new Error(`Session not found: ${request.sessionId}`);
    const ref = resolved.ref;
    if (ref.provider === 'dsh') {
        if (!ctx.sessionController || !ctx.workspaceRegistry)
            throw new Error('DSH session services are unavailable');
        const id = ref.id.startsWith('session-') ? ref.id : `session-${ref.id}`;
        const result = await ctx.sessionController.resolveAgent(id);
        if ('error' in result)
            throw result.error;
        const cwd = result.agent.session.header.cwd;
        if (!cwd)
            throw new Error('DSH session has no workspace');
        const workspace = await ctx.workspaceRegistry.create(cwd);
        await workspace.attachSession(id);
        return { success: true, dshSessionId: id, workspace: cwd, workspaceId: workspace.id, continuation: 'dsh' };
    }
    const available = await continuationAvailability(ctx, ref);
    if (!available.available)
        throw new Error(available.reason);
    const normalized = await resolved.adapter.parse(resolved.candidate);
    return ctx.get('oneagentsAcpSessions').importSession({
        provider: normalized.ref.provider, nativeSessionId: normalized.ref.id,
        cwd: normalized.ref.workspace ?? '', events: convertSessionToDshEvents(normalized),
    });
}
