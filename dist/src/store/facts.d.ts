import type { DatabaseSync } from 'node:sqlite';
import type { NormalizedSession } from '../types.js';
/**
 * Materializes L2. The rules themselves stay in `ledger.ts` — this only moves
 * their output into rows, so a stored fact and a freshly computed one can
 * never disagree.
 */
export declare function deriveFacts(db: DatabaseSync, id: string, session: NormalizedSession): void;
