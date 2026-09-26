import { describe, expect, it } from 'vitest';
import { decryptConnection, encryptConnection } from '../src/connection-transfer';

const credentials = { clientId: 'test.apps.googleusercontent.com', clientSecret: 'private-client-secret', refresh: 'private-refresh-token' };

describe('encrypted setup through Obsidian Sync', () => {
    it('syncs only ciphertext and decrypts with the separate setup code', async () => {
        const { transfer, code } = await encryptConnection(credentials);
        const shared = JSON.stringify(transfer);
        for (const value of [...Object.values(credentials), code]) expect(shared).not.toContain(value);
        expect(await decryptConnection(JSON.parse(shared), code.toLowerCase().replace(/-/g, ' '))).toEqual(credentials);
        expect((await encryptConnection(credentials)).transfer.encrypted).not.toBe(transfer.encrypted);
    });
    it('rejects wrong codes, tampering, and expired packages', async () => {
        const { transfer, code } = await encryptConnection(credentials, 1000);
        await expect(decryptConnection(transfer, 'AAAA-AAAA-AAAA-AAAA-AAAA', 1001)).rejects.toThrow('Incorrect');
        await expect(decryptConnection({ ...transfer, expires: transfer.expires + 1 }, code, 1001)).rejects.toThrow('Incorrect');
        await expect(decryptConnection({ ...transfer, encrypted: transfer.encrypted.slice(2) }, code, 1001)).rejects.toThrow('Incorrect');
        await expect(decryptConnection(transfer, code, transfer.expires)).rejects.toThrow('expired');
    });
});
