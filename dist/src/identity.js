/** Exact IDs win; a prefix may never silently choose among multiple sessions. */
export function selectSession(rows, input) {
    const needle = input.toLowerCase();
    const colon = needle.indexOf(':');
    const provider = colon >= 0 ? needle.slice(0, colon) : undefined;
    const native = colon >= 0 ? needle.slice(colon + 1) : needle;
    const scope = rows.filter((row) => !provider || row.provider === provider);
    const exact = scope.filter((row) => row.id.toLowerCase() === needle || row.native_id.toLowerCase() === native);
    const matches = exact.length ? exact : native.length >= 6 ? scope.filter((row) => row.native_id.toLowerCase().startsWith(native)) : [];
    if (matches.length > 1)
        throw new Error(`ambiguous session ID ${input}: ${matches.map((row) => row.id).join(', ')}`);
    return matches[0];
}
