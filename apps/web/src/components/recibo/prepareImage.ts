import { JPEG_QUALITY, MAX_SIDE, fitWithin } from './reciboLogic.ts';

export interface PreparedImage {
  /** JPEG en base64, sin el prefijo `data:` (es lo que espera `parse-receipt`). */
  base64: string;
  /** La misma imagen como data URL, lista para un <img>. */
  previewUrl: string;
  width: number;
  height: number;
}

/** El archivo no se pudo abrir como imagen (formato no soportado, dañado o demasiado grande). */
export class ImageUnreadableError extends Error {
  constructor(reason: string) {
    super(`No se pudo abrir la imagen: ${reason}`);
    this.name = 'ImageUnreadableError';
  }
}

/** La foto pesa más de lo razonable para decodificarla en el celular. */
export class ImageTooLargeError extends ImageUnreadableError {
  constructor() {
    super('archivo demasiado grande');
    this.name = 'ImageTooLargeError';
  }
}

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ImageUnreadableError('decodificación'));
    img.src = url;
  });
}

/**
 * Foto del celular -> JPEG liviano para el lector: lado mayor <= 1600 px y calidad 0.8.
 * El navegador aplica la orientación EXIF al dibujar, así que la boleta sale derecha.
 */
export async function prepareReceiptImage(file: File): Promise<PreparedImage> {
  if (file.size > MAX_FILE_BYTES) throw new ImageTooLargeError();
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const size = fitWithin(img.naturalWidth, img.naturalHeight, MAX_SIDE);
    if (!size) throw new ImageUnreadableError('medidas');

    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ImageUnreadableError('canvas');

    // JPEG no tiene transparencia: sin este fondo un PNG con alfa saldría negro.
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, size.width, size.height);

    const previewUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    canvas.width = 0; // suelta la memoria del bitmap cuanto antes
    canvas.height = 0;

    const comma = previewUrl.indexOf(',');
    if (!previewUrl.startsWith('data:image/jpeg') || comma < 0 || comma === previewUrl.length - 1) {
      throw new ImageUnreadableError('codificación');
    }
    return { base64: previewUrl.slice(comma + 1), previewUrl, width: size.width, height: size.height };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
