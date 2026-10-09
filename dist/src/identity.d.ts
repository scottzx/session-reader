/** Exact IDs win; a prefix may never silently choose among multiple sessions. */
export declare function selectSession<T extends {
    id: string;
    native_id: string;
    provider: string;
}>(rows: T[], input: string): T | undefined;
