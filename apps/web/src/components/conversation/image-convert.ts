import { ERROR_CODES } from '@aion/shared';
// Recodificação local: elimina metadados e limita o custo de rede antes do upload.
/** Mantém a proporção, sem ampliar imagens pequenas. */
export function imageSize(width: number, height: number): { width: number; height: number } {
  const ratio = Math.min(1, 2000 / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

/** Decodifica no navegador e grava JPEG sem EXIF, com transparência sobre branco. */
export async function convertImage(file: File): Promise<Blob> {
  if (file.size > 10 * 1024 * 1024) throw new Error(ERROR_CODES.ATTACHMENT_TOO_LARGE.message);
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error(ERROR_CODES.ATTACHMENT_UNREADABLE.message); });
  try {
    const size = imageSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error(ERROR_CODES.ATTACHMENT_UNREADABLE.message);
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error(ERROR_CODES.ATTACHMENT_UNREADABLE.message)), 'image/jpeg', 0.85));
    if (blob.size > 5 * 1024 * 1024) throw new Error(ERROR_CODES.ATTACHMENT_TOO_LARGE.message);
    return blob;
  } catch (error) {
    // Falhas nativas de canvas não expõem nomes internos nem detalhes do arquivo na interface.
    if (error instanceof Error && error.message === ERROR_CODES.ATTACHMENT_TOO_LARGE.message) throw error;
    throw new Error(ERROR_CODES.ATTACHMENT_UNREADABLE.message);
  } finally { bitmap.close(); }
}
