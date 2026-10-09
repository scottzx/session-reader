import type { NormalizedSession, SessionOverview } from './types.js';
/**
 * Tier one of the three-level view: everything about a session that is worth
 * knowing before deciding which turn to open.
 */
export declare function buildOverview(session: NormalizedSession): SessionOverview;
