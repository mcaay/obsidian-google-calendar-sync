// Browser APIs keep row identities byte-for-byte compatible with desktop IDs.
export function base64url(bytes: Uint8Array): string {
    return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
}
