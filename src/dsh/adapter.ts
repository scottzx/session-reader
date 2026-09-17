import type { NormalizedSession } from '../types.js';

export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  surfaceOp?: 'append';
  data: Record<string, unknown>;
}

export interface ConvertOptions {
  /** Initial sequence number, defaults to 0 (DSH 0-based sequence convention). */
  startSeq?: number;
}

/**
 * Converts a normalized session from @1agents/session-reader (across Claude, Codex,
 * Antigravity, Grok, or DSH) into an ordered sequence of DSH SessionEvents suitable
 * for direct ingestion and rendering by DSH Client UI (@deepseek-ai/dsh-client-ui-chat).
 */
export function convertSessionToDshEvents(
  session: NormalizedSession,
  options: ConvertOptions = {}
): DshSessionEvent[] {
  const events: DshSessionEvent[] = [];
  let seq = options.startSeq ?? 0;
  let currentTurn = 1;
  let currentStep = 1;
  let turnOpen = false;
  let stepOpen = false;

  const defaultTime = session.ref.createdAt
    ? Date.parse(session.ref.createdAt)
    : Date.now();

  function parseTime(timestamp?: string): number {
    if (!timestamp) return defaultTime;
    const parsed = Date.parse(timestamp);
    return isNaN(parsed) ? defaultTime : parsed;
  }

  function emit(type: string, data: Record<string, unknown>, time: number, surfaceOp?: 'append'): void {
    events.push({
      type,
      seq: seq++,
      time,
      ...(surfaceOp ? { surfaceOp } : {}),
      data,
    });
  }

  function ensureTurnStart(turnNum: number, time: number): void {
    if (!turnOpen) {
      emit('turn/start', { turn: turnNum }, time);
      turnOpen = true;
    }
  }

  function ensureStepStart(turnNum: number, stepNum: number, time: number): void {
    ensureTurnStart(turnNum, time);
    if (!stepOpen) {
      emit('step/start', { turn: turnNum, step: stepNum }, time);
      stepOpen = true;
    }
  }

  function closeStep(turnNum: number, stepNum: number, time: number): void {
    if (stepOpen) {
      emit('step/end', { turn: turnNum, step: stepNum }, time);
      stepOpen = false;
    }
  }

  function closeTurn(turnNum: number, time: number, reason: string = 'completed'): void {
    closeStep(turnNum, currentStep, time);
    if (turnOpen) {
      emit('turn/end', { turn: turnNum, reason: { kind: reason } }, time);
      turnOpen = false;
    }
  }

  const providerName = session.ref.provider || 'external';
  const modelName = session.stats.models[0] || 'assistant';

  if (session.ref.title && session.ref.title.trim()) {
    emit(
      'session/title',
      {
        title: session.ref.title.trim(),
        messageSeqs: [],
        source: { kind: 'user' },
      },
      defaultTime
    );
  }

  for (let i = 0; i < session.turns.length; i++) {
    const turnEvent = session.turns[i]!;
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

        emit(
          'user/message',
          {
            id: `msg-${turnEvent.id}`,
            role: 'user',
            content: [{ type: 'text', text: turnEvent.text ?? '' }],
            source: { kind: 'user' },
          },
          eventTime,
          'append'
        );
        break;
      }

      case 'thinking': {
        ensureStepStart(currentTurn, currentStep, eventTime);
        const thinkingText = turnEvent.text ?? '';
        if (thinkingText.trim()) {
          emit(
            'assistant/message',
            {
              turn: currentTurn,
              step: currentStep,
              message: {
                id: `asst-think-${turnEvent.id}`,
                role: 'assistant',
                content: [{ type: 'reasoning', text: thinkingText }],
                source: { kind: 'model', provider: providerName, model: modelName },
              },
              stream: [
                {
                  type: 'chunk',
                  time: eventTime,
                  chunk: {
                    type: 'reasoning-delta',
                    index: 0,
                    text: thinkingText,
                  },
                },
              ],
            },
            eventTime,
            'append'
          );
        }
        break;
      }

      case 'tool_call': {
        ensureStepStart(currentTurn, currentStep, eventTime);
        const callId = turnEvent.id;
        const toolName = turnEvent.toolName ?? 'tool';
        const toolArgsStr = typeof turnEvent.toolArgs === 'string'
          ? turnEvent.toolArgs
          : JSON.stringify(turnEvent.toolArgs ?? {});

        emit(
          'tool/call',
          {
            turn: currentTurn,
            step: currentStep,
            callId,
            name: toolName,
            arguments: toolArgsStr,
          },
          eventTime
        );
        break;
      }

      case 'tool_result': {
        ensureStepStart(currentTurn, currentStep, eventTime);
        const callId = turnEvent.id;
        const toolName = turnEvent.toolName ?? 'tool';
        const resultContent = turnEvent.toolResult ?? '';

        emit(
          'tool/result',
          {
            turn: currentTurn,
            step: currentStep,
            message: {
              id: `tool-res-${callId}`,
              role: 'user',
              source: { kind: 'tool', callId, tool: toolName },
              content: [
                {
                  type: 'tool-result',
                  toolCallId: callId,
                  content: [{ type: 'text', text: resultContent }],
                  ...(turnEvent.isError ? { isError: true } : {}),
                },
              ],
            },
            ...(turnEvent.exitCode !== undefined ? { meta: { exitCode: turnEvent.exitCode } } : {}),
          },
          eventTime,
          'append'
        );

        // Tool execution concludes a step; next action starts a new step
        closeStep(currentTurn, currentStep, eventTime);
        currentStep++;
        break;
      }

      case 'assistant': {
        ensureStepStart(currentTurn, currentStep, eventTime);
        const text = turnEvent.text ?? '';

        emit(
          'assistant/message',
          {
            turn: currentTurn,
            step: currentStep,
            message: {
              id: `asst-${turnEvent.id}`,
              role: 'assistant',
              content: [{ type: 'text', text }],
              source: { kind: 'model', provider: providerName, model: modelName },
            },
            stream: [
              {
                type: 'chunk',
                time: eventTime,
                chunk: {
                  type: 'text-delta',
                  index: 0,
                  text,
                },
              },
            ],
          },
          eventTime,
          'append'
        );

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
    const lastTime = events.length > 0 ? events[events.length - 1]!.time : defaultTime;
    closeTurn(currentTurn, lastTime);
  }

  return events;
}
