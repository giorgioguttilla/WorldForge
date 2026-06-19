const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  writeUint32(chunk, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  writeUint32(chunk, 8 + data.length, crc32(chunk.slice(4, 8 + data.length)));
  return chunk;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (!globalThis.CompressionStream) {
    throw new Error('PNG export requires CompressionStream support in this browser.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeGrayscale16Png(width: number, height: number, samples: Uint16Array): Promise<Blob> {
  if (samples.length !== width * height) {
    throw new Error('PNG sample count does not match dimensions.');
  }

  const scanlineLength = 1 + width * 2;
  const raw = new Uint8Array(scanlineLength * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * scanlineLength;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const value = samples[y * width + x];
      const offset = row + 1 + x * 2;
      raw[offset] = value >>> 8;
      raw[offset + 1] = value & 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  writeUint32(ihdr, 0, width);
  writeUint32(ihdr, 4, height);
  ihdr[8] = 16;
  ihdr[9] = 0;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = await deflate(raw);
  const chunks = [PNG_SIGNATURE, makeChunk('IHDR', ihdr), makeChunk('IDAT', idat), makeChunk('IEND', new Uint8Array())];
  return new Blob(chunks, { type: 'image/png' });
}
