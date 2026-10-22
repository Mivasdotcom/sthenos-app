// Shared validation rules for dojo logo uploads.
// Used by the client (fast feedback) and re-verified on the server.

export const LOGO_BUCKET = "dojo-logos";
export const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2MB
export const LOGO_MAX_DIMENSION = 2048;
export const LOGO_ACCEPT = "image/png,image/jpeg,image/webp";

export type LogoImageType = "png" | "jpeg" | "webp";

export const LOGO_EXTENSION: Record<LogoImageType, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
};

export const LOGO_MIME: Record<LogoImageType, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/**
 * Detect the real image type from the file's magic bytes.
 * Never trust the file extension or the client-supplied MIME type:
 * SVG (which can carry scripts) and everything else return null.
 */
export function sniffImageType(bytes: Uint8Array): LogoImageType | null {
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length > 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

function u16be(b: Uint8Array, i: number) {
  return (b[i] << 8) | b[i + 1];
}
function u32be(b: Uint8Array, i: number) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}
function u24le(b: Uint8Array, i: number) {
  return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
}

/** Read pixel dimensions straight from the file header. Returns null when unknown. */
export function readImageDimensions(
  bytes: Uint8Array,
  type: LogoImageType,
): { width: number; height: number } | null {
  try {
    if (type === "png") {
      if (bytes.length < 24) return null;
      return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
    }
    if (type === "jpeg") {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = bytes[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = u16be(bytes, i + 2);
        const isSof =
          marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
          return { height: u16be(bytes, i + 5), width: u16be(bytes, i + 7) };
        }
        i += 2 + len;
      }
      return null;
    }
    // WEBP
    const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (fourcc === "VP8 ") {
      return {
        width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
        height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
      };
    }
    if (fourcc === "VP8L") {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === "VP8X") {
      return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
    }
    return null;
  } catch {
    return null;
  }
}

/** Full validation. Returns the detected type or throws a user-facing message. */
export function validateLogoBytes(bytes: Uint8Array): LogoImageType {
  if (bytes.byteLength === 0) throw new Error("That file is empty.");
  if (bytes.byteLength > LOGO_MAX_BYTES) {
    throw new Error(
      `That file is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)}MB. Logos must be 2MB or smaller.`,
    );
  }
  const type = sniffImageType(bytes);
  if (!type) {
    throw new Error("Only PNG, JPG or WEBP images are allowed (SVG files are not accepted).");
  }
  const dims = readImageDimensions(bytes, type);
  if (dims && (dims.width > LOGO_MAX_DIMENSION || dims.height > LOGO_MAX_DIMENSION)) {
    throw new Error(
      `That image is ${dims.width}x${dims.height}px. Logos must be at most ${LOGO_MAX_DIMENSION}x${LOGO_MAX_DIMENSION}px.`,
    );
  }
  return type;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
