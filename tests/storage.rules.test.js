import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assertFails, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { getBytes, ref, uploadBytes } from 'firebase/storage';

// Storage is locked down for every client. The prediction models under models/
// are read only by Cloud Functions (Admin SDK), which these rules don't govern.
let testEnv;

beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
        projectId: 'transit-stats-storage-rules-test',
        storage: { rules: readFileSync(resolve(process.cwd(), 'storage.rules'), 'utf8') },
    });
});

afterAll(async () => {
    if (testEnv) await testEnv.cleanup();
});

describe('storage.rules: everything is denied to clients', () => {
    const clients = {
        anonymous: () => testEnv.unauthenticatedContext().storage(),
        'signed-in user': () => testEnv.authenticatedContext('user_1', { email: 'user@example.com', email_verified: true }).storage(),
    };

    for (const [name, storage] of Object.entries(clients)) {
        test(`${name} cannot read models/`, async () => {
            await assertFails(getBytes(ref(storage(), 'models/model_v4.json')));
        });

        test(`${name} cannot write models/`, async () => {
            await assertFails(uploadBytes(ref(storage(), 'models/model_v4.json'), new Uint8Array([1, 2, 3])));
        });

        test(`${name} cannot read or write anywhere else`, async () => {
            await assertFails(getBytes(ref(storage(), 'anything/else.txt')));
            await assertFails(uploadBytes(ref(storage(), 'anything/else.txt'), new Uint8Array([1])));
        });
    }
});
