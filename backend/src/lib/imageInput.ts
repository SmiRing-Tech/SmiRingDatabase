const heicConvert = require('heic-convert');

/**
 * iPhone uploads arrive as HEIC/HEIF, which sharp cannot decode. Convert those to
 * JPEG first; everything else is passed through untouched.
 *
 * On conversion failure the original buffer is returned so the caller can still
 * try — a sharp error downstream is a clearer signal than an opaque failure here.
 */
export async function ensureJpegBuffer(
  buffer: Buffer,
  mimetype: string,
  originalname: string,
): Promise<Buffer> {
  const name = originalname.toLowerCase();
  const isHeic =
    mimetype === 'image/heic' ||
    mimetype === 'image/heif' ||
    name.endsWith('.heic') ||
    name.endsWith('.heif');

  if (!isHeic) return buffer;

  console.log(`[Backend HEIC] Converting ${originalname}...`);
  try {
    const outputBuffer = await heicConvert({
      buffer,
      format: 'JPEG',
      quality: 1, // Highest quality for the intermediate buffer
    });
    console.log(`[Backend HEIC] ✅ Successfully converted ${originalname}`);
    return Buffer.from(outputBuffer);
  } catch (err) {
    console.error(`[Backend HEIC Error] Conversion failed for ${originalname}:`, err);
    return buffer;
  }
}
