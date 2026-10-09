/** Missing native IDs mean unknown association, never an adjacent-result guess. */
export function toolResults(events, call) {
    return call.callId
        ? events.filter((event) => event.kind === 'tool_result' && event.callId === call.callId)
        : [];
}
export function callsIn(events) {
    return events.filter((event) => event.kind === 'tool_call').map((call) => {
        const results = toolResults(events, call);
        return {
            id: call.callId ?? call.locator ?? call.id,
            event: call.index,
            locator: call.locator,
            toolName: call.toolName,
            association: call.callId ? 'native_id' : 'unconfirmed',
            resultEvents: results.map((event) => event.index),
            status: !results.length ? 'unknown' : results.some((event) => event.isError || (event.exitCode ?? 0) !== 0)
                ? 'failed' : results.every((event) => event.isError === false || event.exitCode === 0) ? 'completed' : 'unknown',
        };
    });
}
