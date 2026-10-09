export function toolArgsOf(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
