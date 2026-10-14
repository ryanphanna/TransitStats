import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Project rule: no all-caps text anywhere, so no CSS may uppercase it.
function cssFiles(dir) {
    return readdirSync(dir).flatMap(name => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? cssFiles(path) : (path.endsWith('.css') ? [path] : []);
    });
}

describe('no all-caps styling', () => {
    it('no stylesheet uses text-transform: uppercase', () => {
        const offenders = cssFiles(resolve(process.cwd(), 'styles'))
            .filter(path => /text-transform\s*:\s*uppercase/i.test(readFileSync(path, 'utf8')));
        expect(offenders).toEqual([]);
    });

    it('no page or inline style uppercases text', () => {
        const pages = readdirSync(process.cwd()).filter(name => name.endsWith('.html'));
        const offenders = pages.filter(name => /text-transform\s*:\s*uppercase/i.test(readFileSync(name, 'utf8')));
        expect(offenders).toEqual([]);
    });
});
