'use strict';
const sharp = require('sharp');

async function main() {
  const rows = [];
  for (const format of ['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif']) {
    try {
      const buffer = await sharp({
        create: { width: 24, height: 16, channels: 3, background: '#659aa5' },
      })
        .toFormat(format)
        .toBuffer();
      const metadata = await sharp(buffer).metadata();
      await sharp(buffer).resize(8, 8).raw().toBuffer();
      rows.push({
        format,
        decode: '通过',
        size: `${metadata.width} × ${metadata.height}`,
      });
    } catch (error) {
      rows.push({ format, decode: error.message });
      process.exitCode = 1;
    }
  }
  console.table(rows);
  console.log('HEIC/HEIF、BMP 和相机 RAW 不在默认支持范围内；GIF 只分析首帧。');
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
