import type { UserTurnKind } from './types.js';

/** Pure "keep going" replies carry no instruction worth handing on. */
const NUDGE = /^(?:继续|再继续|contin|continue|go on|好的?|ok|okay|嗯+|再来|下一步|next|yes|是的|可以)[。.!！~]*$/i;

export function classifyUserTurn(text: string): UserTurnKind {
  const value = text.trim();
  if (NUDGE.test(value)) return 'nudge';
  // Long markdown reports are the user pasting an agent's own output back in.
  if (value.length > 300 && (/(^|\n)#{1,4}\s/.test(value) || /🎉|阶段性|全面完成/.test(value))) return 'paste';
  return 'correction';
}
