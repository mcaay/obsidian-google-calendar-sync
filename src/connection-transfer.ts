import { base64url, fromBase64url } from './encoding';

export interface ConnectionTransfer {
    version: 1;
    expires: number;
    iv: string;
    encrypted: string;
}

interface Credentials { clientId: string; clientSecret: string; refresh: string }
const encoder = new TextEncoder();

async function transferKey(code: string): Promise<CryptoKey> {
    const normalized = code.toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z2-7]{20}$/.test(normalized)) throw new Error('Enter the complete setup code shown on your computer.');
    // A generated 100-bit code, not a user password or a short numeric PIN.
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(normalized));
    return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * How to read this code:
 * 1. GoogleAuth.shareConnection() in src/auth.ts calls encryptConnection(). Only
 *    ciphertext goes into plugin settings for Obsidian Sync; the code stays on
 *    the exporting device's screen and is never persisted.
 * 2. GoogleAuth.importConnection() decrypts with the code typed on the phone,
 *    verifies the token with Google, then stores it in local SecretStorage.
 * Ordinary: Sync carries the package; one setup code connects the phone.
 * Tricky: an incorrect code, modified package, or expired transfer leaves the
 * existing connection intact. Import removes the shared package, but copies in
 * Sync history are not remotely revocable. Revoke Google access to invalidate it.
 */
export async function encryptConnection(credentials: Credentials, now = Date.now()): Promise<{ transfer: ConnectionTransfer; code: string }> {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const code = Array.from(crypto.getRandomValues(new Uint8Array(20)), byte => alphabet[byte & 31]).join('').match(/.{4}/g)!.join('-');
    const expires = now + 30 * 60 * 1000;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
        additionalData: encoder.encode(`gdn-connection:1:${expires}`) }, await transferKey(code), encoder.encode(JSON.stringify(credentials)));
    return { code, transfer: { version: 1, expires, iv: base64url(iv), encrypted: base64url(new Uint8Array(encrypted)) } };
}

export async function decryptConnection(transfer: ConnectionTransfer, code: string, now = Date.now()): Promise<Credentials> {
    if (transfer.version !== 1 || !Number.isFinite(transfer.expires) || transfer.expires <= now) throw new Error('Setup code expired. Create a new one on your computer.');
    const key = await transferKey(code);
    try {
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(transfer.iv),
            additionalData: encoder.encode(`gdn-connection:1:${transfer.expires}`) }, key, fromBase64url(transfer.encrypted));
        const credentials = JSON.parse(new TextDecoder().decode(decrypted)) as Credentials;
        if (!credentials.clientId?.endsWith('.apps.googleusercontent.com') || !credentials.refresh || typeof credentials.clientSecret !== 'string') throw new Error('Invalid connection');
        return credentials;
    } catch { throw new Error('Incorrect setup code or damaged connection package. Try again.'); }
}
