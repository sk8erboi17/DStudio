// Original lossless RGB counterfactuals. Filenames and metadata reveal no label.
import zlib from 'node:zlib';

export function q36VisionPNG(index) {
  if (!Number.isInteger(index) || index < 0 || index > 3) throw new Error('Unknown pixel fixture');
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, payload, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(128); header.writeUInt32BE(128, 4);
  header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(128 * (128 * 3 + 1));
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const offset = y * (128 * 3 + 1) + 1 + x * 3;
    const blue = index === 1 || (index === 2 && x < 64);
    pixels[offset + (blue ? 2 : 0)] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
