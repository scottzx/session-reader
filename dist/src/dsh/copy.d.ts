/** Copy for native continuation, shared by the embedded browser entry. */
export declare const continuationDictionaries: {
    zh: {
        continue: string;
        openDsh: string;
        readOnly: string;
        loading: string;
        failed: string;
        unavailable: string;
        navigationUnavailable: string;
    };
    en: {
        continue: string;
        openDsh: string;
        readOnly: string;
        loading: string;
        failed: string;
        unavailable: string;
        navigationUnavailable: string;
    };
};
type Copy = {
    [K in keyof typeof continuationDictionaries.zh]: string;
};
export declare function continuationCopy(translate?: (key: keyof Copy) => string): Copy;
export {};
