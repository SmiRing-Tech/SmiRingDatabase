import heic2any from 'heic2any';

/**
 * HEIC/HEIF ファイルを JPEG に変換する。
 *
 * 変換戦略:
 *  1. heic2any で変換を試みる（多くのケースで動作）
 *  2. 失敗した場合、<img> + Canvas 経由で変換する（Safari ネイティブデコードを利用）
 *  3. 両方失敗した場合は、元のファイルをそのまま返す（フォールバック）
 */
export function isHeicFile(file: File): boolean {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return (
    name.endsWith('.heic') ||
    name.endsWith('.heif') ||
    type === 'image/heic' ||
    type === 'image/heif'
  );
}

async function convertViaCanvas(file: File): Promise<File> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas context is not available'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Canvas toBlob returned null'));
            return;
          }
          const newName = file.name.replace(/\.(heic|heif)$/i, '.jpg');
          resolve(new File([blob], newName, { type: 'image/jpeg' }));
        },
        'image/jpeg',
        0.85
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Browser could not decode HEIC via <img>'));
    };

    img.src = url;
  });
}

export async function convertHeicToJpeg(file: File): Promise<File> {
  if (!isHeicFile(file)) return file;

  console.log(`[HEIC] Converting ${file.name}...`);

  // Strategy 1: heic2any
  try {
    const resultBlob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
    const blob = Array.isArray(resultBlob) ? resultBlob[0] : resultBlob;
    const newName = file.name.replace(/\.(heic|heif)$/i, '.jpg');
    console.log(`[HEIC] ✅ Converted via heic2any: ${file.name}`);
    return new File([blob], newName, { type: 'image/jpeg' });
  } catch (err1) {
    console.warn(`[HEIC] heic2any failed, trying canvas fallback...`, err1);
  }

  // Strategy 2: Canvas (<img> ネイティブデコード)
  try {
    const result = await convertViaCanvas(file);
    console.log(`[HEIC] ✅ Converted via Canvas: ${file.name}`);
    return result;
  } catch (err2) {
    console.error(`[HEIC] ❌ Both strategies failed for ${file.name}:`, err2);
  }

  // Strategy 3: フォールバック（元ファイルをそのまま返す）
  return file;
}
