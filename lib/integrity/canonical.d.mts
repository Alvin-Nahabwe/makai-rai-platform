import type { SealManifestV1 } from '../../types/seal';

export function canonicalJson(value: unknown): string;
export function saltedDigestHex(salt: Uint8Array, fieldName: string, text: string): string;
export function fingerprintHex(bytes: Uint8Array): string;
export function canonicalManifestBytes(m: SealManifestV1): Uint8Array;
