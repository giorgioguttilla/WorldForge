import { describe, expect, it } from 'vitest';
import { R16HeightmapCodec } from './r16Codec';

describe('R16HeightmapCodec', () => {
  it('round-trips little-endian Uint16 samples', () => {
    const source = new Uint16Array([0, 1, 256, 65535]);
    const encoded = R16HeightmapCodec.encode(source);
    const bytes = new Uint8Array(encoded);
    expect(bytes[2]).toBe(1);
    expect(bytes[3]).toBe(0);
    expect(R16HeightmapCodec.decode(encoded, 2)).toEqual(source);
  });

  it('rejects invalid tile byte lengths', () => {
    expect(() => R16HeightmapCodec.decode(new ArrayBuffer(6), 2)).toThrow(/Invalid R16/);
  });
});
