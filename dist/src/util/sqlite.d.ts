/**
 * `node:sqlite` is still flagged experimental and prints a warning on load.
 * Filtering just that one message keeps every other warning intact — far less
 * rude than `removeAllListeners('warning')`.
 */
export declare function importSqlite(): Promise<typeof import('node:sqlite')>;
