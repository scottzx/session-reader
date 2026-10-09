/** Canonical domain types shared by every provider parser. */
export function emptyProviderStats() {
    return {
        models: [],
        branches: [],
        fileChanges: [],
        uploads: [],
        backgroundTasks: [],
        turnBoundaries: [],
        commands: [],
        extras: {},
    };
}
