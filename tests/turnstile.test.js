import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTurnstileClient, TURNSTILE_ACTION } from '../js/shared/turnstile.js';

function fakeEnvironment() {
    const scripts = [];
    const win = {
        setTimeout: (...args) => setTimeout(...args),
        clearTimeout: id => clearTimeout(id),
        console: { warn: vi.fn() },
    };
    const doc = {
        createElement: () => ({}),
        head: { appendChild: script => scripts.push(script) },
    };
    const widget = { options: null, executes: 0, resets: 0 };
    const api = {
        render: vi.fn((container, options) => { widget.options = options; return 'widget-1'; }),
        reset: vi.fn(() => { widget.resets += 1; }),
        execute: vi.fn(() => { widget.executes += 1; }),
    };
    function finishLoad() {
        win.turnstile = api;
        win[scripts[0].src.split('onload=')[1]]();
    }
    return { win, doc, scripts, widget, api, finishLoad };
}

describe('Turnstile client', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('loads the script with explicit render and an onload callback, never relying on turnstile.ready()', async () => {
        const env = fakeEnvironment();
        const client = createTurnstileClient({ win: env.win, doc: env.doc, container: {}, siteKey: 'k' });
        const loading = client.load();
        expect(env.scripts).toHaveLength(1);
        expect(env.scripts[0].src).toMatch(/^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit&onload=\w+$/);
        expect(env.scripts[0].async).toBeUndefined();
        env.finishLoad();
        await expect(loading).resolves.toBe(env.api);
    });

    it('renders once with valid options and gets a fresh token for every request', async () => {
        const env = fakeEnvironment();
        const client = createTurnstileClient({ win: env.win, doc: env.doc, container: {}, siteKey: 'k' });
        client.load();
        env.finishLoad();

        const first = client.getToken();
        await vi.waitFor(() => expect(env.widget.executes).toBe(1));
        env.widget.options.callback('token-1');
        await expect(first).resolves.toBe('token-1');

        const second = client.getToken();
        await vi.waitFor(() => expect(env.widget.executes).toBe(2));
        env.widget.options.callback('token-2');
        await expect(second).resolves.toBe('token-2');

        expect(env.api.render).toHaveBeenCalledTimes(1);
        expect(env.widget.resets).toBe(2);
        expect(env.widget.options).toMatchObject({
            sitekey: 'k',
            action: TURNSTILE_ACTION,
            execution: 'execute',
            appearance: 'interaction-only',
        });
        expect(env.widget.options.size).toBeUndefined();
    });

    it('resolves to an empty token on a widget error or timeout so the server can decide', async () => {
        const env = fakeEnvironment();
        const client = createTurnstileClient({ win: env.win, doc: env.doc, container: {}, siteKey: 'k' });
        client.load();
        env.finishLoad();

        const errored = client.getToken();
        await vi.waitFor(() => expect(env.widget.executes).toBe(1));
        env.widget.options['error-callback']('200500');
        await expect(errored).resolves.toBe('');

        const timedOut = client.getToken();
        await vi.waitFor(() => expect(env.widget.executes).toBe(2));
        vi.advanceTimersByTime(15000);
        await expect(timedOut).resolves.toBe('');
    });

    it('gives an interactive challenge longer before giving up', async () => {
        const env = fakeEnvironment();
        const client = createTurnstileClient({ win: env.win, doc: env.doc, container: {}, siteKey: 'k' });
        client.load();
        env.finishLoad();

        const pending = client.getToken();
        await vi.waitFor(() => expect(env.widget.executes).toBe(1));
        env.widget.options['before-interactive-callback']();
        vi.advanceTimersByTime(60000);
        env.widget.options.callback('solved');
        await expect(pending).resolves.toBe('solved');
    });

    it('resolves to an empty token when the script is blocked, and retries the load next time', async () => {
        const env = fakeEnvironment();
        const client = createTurnstileClient({ win: env.win, doc: env.doc, container: {}, siteKey: 'k' });
        const blocked = client.getToken();
        env.scripts[0].onerror();
        await expect(blocked).resolves.toBe('');

        client.getToken();
        expect(env.scripts).toHaveLength(2);
    });
});
