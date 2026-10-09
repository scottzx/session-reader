/** Collapses whitespace and clips to `max` characters. */
export declare function oneLine(text: string | undefined, max?: number): string;
export declare function clip(text: string | undefined, max: number): string;
/** Strips the wrapper tags and ambient blocks agents inject around a real request. */
export declare function stripPromptEnvelope(text: string): string;
/** Boilerplate the agents prepend to the first turn — never a real request. */
export declare function looksLikeInstructions(text: string): boolean;
