import { describe, expect, it } from 'vitest';
import { Utils } from '../js/utils.js';

describe('Utils.hide', () => {
    it('escapes text and quotes so it is safe inside attribute values', () => {
        expect(Utils.hide(`" onmouseover='x' <b>&`)).toBe('&quot; onmouseover=&#39;x&#39; &lt;b&gt;&amp;');
    });

    it('leaves plain text alone and returns an empty string for empty input', () => {
        expect(Utils.hide('King St W')).toBe('King St W');
        expect(Utils.hide('')).toBe('');
        expect(Utils.hide(null)).toBe('');
    });
});
