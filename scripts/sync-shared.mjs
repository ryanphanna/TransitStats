// Generates CommonJS copies of the dependency-free shared modules in js/shared
// for the Cloud Functions (which deploy without access to js/).
// Usage: node scripts/sync-shared.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SHARED_MODULES = ['ride-merge', 'presto-trips'];

export function toCommonJs(source, name) {
    const exported = [...source.matchAll(/^export (?:const|function) (\w+)/gm)].map(match => match[1]);
    const body = source.replace(/^export (const|function) /gm, '$1 ');
    return `// GENERATED from js/shared/${name}.js by scripts/sync-shared.mjs. Do not edit.\n${body}\nmodule.exports = { ${exported.join(', ')} };\n`;
}

export function generated(name) {
    return toCommonJs(readFileSync(resolve(root, `js/shared/${name}.js`), 'utf8'), name);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const check = process.argv.includes('--check');
    let stale = false;
    for (const name of SHARED_MODULES) {
        const target = resolve(root, `functions/lib/${name}.js`);
        const next = generated(name);
        let current = '';
        try { current = readFileSync(target, 'utf8'); } catch { /* missing */ }
        if (current === next) continue;
        if (check) { stale = true; console.error(`functions/lib/${name}.js is out of date`); }
        else writeFileSync(target, next);
    }
    if (stale) process.exit(1);
}
