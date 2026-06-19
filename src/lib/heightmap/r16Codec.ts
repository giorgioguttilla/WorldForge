export class R16HeightmapCodec {
  static expectedByteLength(tileSize: number): number {
    return tileSize * tileSize * Uint16Array.BYTES_PER_ELEMENT;
  }

  static encode(samples: Uint16Array): ArrayBuffer {
    const buffer = new ArrayBuffer(samples.length * Uint16Array.BYTES_PER_ELEMENT);
    const view = new DataView(buffer);
    for (let i = 0; i < samples.length; i += 1) {
      view.setUint16(i * 2, samples[i], true);
    }
    return buffer;
  }

  static decode(buffer: ArrayBuffer, tileSize: number): Uint16Array {
    const expected = R16HeightmapCodec.expectedByteLength(tileSize);
    if (buffer.byteLength !== expected) {
      throw new Error(`Invalid R16 tile length ${buffer.byteLength}; expected ${expected}.`);
    }
    const view = new DataView(buffer);
    const samples = new Uint16Array(tileSize * tileSize);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = view.getUint16(i * 2, true);
    }
    return samples;
  }
}
