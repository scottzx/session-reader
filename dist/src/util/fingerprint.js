import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
/** Side-file identity includes names, sizes and mtimes, including nested goal/step files. */
export async function auxiliaryFingerprint(roots) {
    const records = [];
    async function visit(file) {
        const stat = await fs.stat(file).catch(() => undefined);
        if (!stat)
            return;
        if (stat.isFile())
            records.push(`${file}:${stat.size}:${stat.mtimeMs}`);
        else if (stat.isDirectory())
            for (const name of await fs.readdir(file))
                await visit(path.join(file, name));
    }
    for (const root of roots)
        await visit(root);
    return createHash('sha256').update(records.sort().join('\n')).digest('hex');
}
