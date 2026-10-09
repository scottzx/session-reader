/**
 * `node:sqlite` is still flagged experimental and prints a warning on load.
 * Filtering just that one message keeps every other warning intact — far less
 * rude than `removeAllListeners('warning')`.
 */
export async function importSqlite() {
    const original = process.emitWarning;
    process.emitWarning = ((warning, ...rest) => {
        const text = typeof warning === 'string' ? warning : (warning?.message ?? '');
        if (text.includes('SQLite is an experimental feature'))
            return;
        return original.call(process, warning, ...rest);
    });
    try {
        return await import('node:sqlite');
    }
    finally {
        process.emitWarning = original;
    }
}
