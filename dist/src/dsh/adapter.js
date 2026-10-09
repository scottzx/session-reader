/**
 * Converts a normalized session from @1agents/session-reader (across Claude, Codex,
 * Antigravity, Grok, or DSH) into an ordered sequence of DSH SessionEvents suitable
 * for direct ingestion and rendering by DSH Client UI (@deepseek-ai/dsh-client-ui-chat).
 */
export function convertSessionToDshEvents(session, options = {}) {
    const events = [];
    let seq = options.startSeq ?? 0;
    let currentTurn = 1;
    let currentStep = 1;
    let turnOpen = false;
    let stepOpen = false;
    let hasSystemHead = false;
    const defaultTime = session.ref.createdAt
        ? Date.parse(session.ref.createdAt)
        : Date.now();
    const fallbackTime = Number.isFinite(defaultTime) ? defaultTime : Date.now();
    function parseTime(timestamp) {
        if (!timestamp)
            return fallbackTime;
        const parsed = Date.parse(timestamp);
        return isNaN(parsed) ? fallbackTime : parsed;
    }
    function emit(type, data, time, surfaceOp) {
        events.push({
            type,
            seq: seq++,
            time,
            ...(surfaceOp ? { surfaceOp } : {}),
            data,
        });
    }
    function ensureTurnStart(turnNum, time) {
        if (!turnOpen) {
            emit('turn/start', { turn: turnNum }, time);
            turnOpen = true;
        }
    }
    function ensureStepStart(turnNum, stepNum, time) {
        ensureTurnStart(turnNum, time);
        if (!stepOpen) {
            emit('step/start', { turn: turnNum, step: stepNum }, time);
            stepOpen = true;
            if (!hasSystemHead) {
                emit('system/message', {
                    turn: turnNum, step: stepNum,
                    message: { id: `system-${session.ref.id}`, role: 'system', source: { kind: 'system-prompt' }, content: [] },
                }, time, 'append');
                hasSystemHead = true;
            }
        }
    }
    function closeStep(turnNum, stepNum, time) {
        if (stepOpen) {
            emit('step/end', { turn: turnNum, step: stepNum }, time);
            stepOpen = false;
        }
    }
    function closeTurn(turnNum, time, reason = 'completed') {
        closeStep(turnNum, currentStep, time);
        if (turnOpen) {
            emit('turn/end', { turn: turnNum, reason: { kind: reason } }, time);
            turnOpen = false;
        }
    }
    const providerName = session.ref.provider || 'external';
    const modelName = session.stats.models[0] || 'assistant';
    if (session.ref.title && session.ref.title.trim()) {
        emit('session/title', {
            title: session.ref.title.trim(),
            messageSeqs: [],
            source: { kind: 'user' },
        }, fallbackTime);
    }
    for (let i = 0; i < session.turns.length; i++) {
        const turnEvent = session.turns[i];
        const eventTime = parseTime(turnEvent.timestamp);
        switch (turnEvent.kind) {
            case 'user': {
                // A new user prompt begins a new turn
                if (turnOpen) {
                    closeTurn(currentTurn, eventTime);
                    currentTurn++;
                    currentStep = 1;
                }
                ensureStepStart(currentTurn, currentStep, eventTime);
                emit('user/message', {
                    id: `msg-${turnEvent.id}`,
                    role: 'user',
                    content: [{ type: 'text', text: turnEvent.text ?? '' }],
                    source: { kind: 'user' },
                }, eventTime, 'append');
                break;
            }
            case 'thinking': {
                ensureStepStart(currentTurn, currentStep, eventTime);
                const thinkingText = turnEvent.text ?? '';
                if (thinkingText.trim()) {
                    emit('assistant/message', {
                        turn: currentTurn,
                        step: currentStep,
                        message: {
                            id: `asst-think-${turnEvent.id}`,
                            role: 'assistant',
                            content: [{ type: 'reasoning', text: thinkingText }],
                            source: { kind: 'model', provider: providerName, model: modelName },
                        },
                        stream: [
                            { type: 'chunk', time: eventTime, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
                            {
                                type: 'chunk',
                                time: eventTime,
                                chunk: {
                                    type: 'reasoning-delta',
                                    index: 0,
                                    text: thinkingText,
                                },
                            },
                            { type: 'chunk', time: eventTime, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: thinkingText } } },
                        ],
                    }, eventTime, 'append');
                }
                break;
            }
            case 'tool_call':
            case 'tool_result': {
                ensureStepStart(currentTurn, currentStep, eventTime);
                const label = turnEvent.kind === 'tool_call' ? 'External tool call' : 'External tool result';
                const name = turnEvent.toolName ?? 'tool';
                const detail = turnEvent.kind === 'tool_call' ? JSON.stringify(turnEvent.toolArgs ?? {}) : turnEvent.toolResult ?? '';
                const status = `${turnEvent.isError ? ' · error' : ''}${turnEvent.exitCode !== undefined ? ` · exit ${turnEvent.exitCode}` : ''}`;
                const text = `[${label} · ${name}${status}]\n${detail}`;
                // Normalized providers do not preserve reliable call/result identities.
                // External activity remains read-only transcript, as in live ACP output.
                emit('assistant/message', {
                    turn: currentTurn, step: currentStep,
                    message: { id: `external-${i}-${turnEvent.id}`, role: 'assistant', source: { kind: 'model', provider: providerName, model: modelName }, content: [{ type: 'reasoning', text }] },
                    stream: [
                        { type: 'chunk', time: eventTime, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
                        { type: 'reasoning-chunks', time0: eventTime, index: 0, dt: [], texts: [text] },
                        { type: 'chunk', time: eventTime, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text } } },
                    ],
                }, eventTime, 'append');
                break;
            }
            case 'assistant': {
                ensureStepStart(currentTurn, currentStep, eventTime);
                const text = turnEvent.text ?? '';
                emit('assistant/message', {
                    turn: currentTurn,
                    step: currentStep,
                    message: {
                        id: `asst-${turnEvent.id}`,
                        role: 'assistant',
                        content: [{ type: 'text', text }],
                        source: { kind: 'model', provider: providerName, model: modelName },
                    },
                    stream: [
                        { type: 'chunk', time: eventTime, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
                        {
                            type: 'chunk',
                            time: eventTime,
                            chunk: {
                                type: 'text-delta',
                                index: 0,
                                text,
                            },
                        },
                        { type: 'chunk', time: eventTime, chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } },
                    ],
                }, eventTime, 'append');
                const nextEvent = session.turns[i + 1];
                if (!nextEvent || nextEvent.kind === 'user') {
                    closeTurn(currentTurn, eventTime);
                    currentTurn++;
                    currentStep = 1;
                }
                break;
            }
        }
    }
    // Final cleanup if the last turn was still open
    if (turnOpen) {
        const lastTime = events.length > 0 ? events[events.length - 1].time : fallbackTime;
        closeTurn(currentTurn, lastTime, 'interrupted');
    }
    return events;
}
