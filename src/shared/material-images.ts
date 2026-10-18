export const materialImageLimit = 2 * 1024 * 1024;
export const materialImagePayloadLimit = Math.ceil(materialImageLimit / 3) * 4 + 64;
export const materialImagePrefix = "assets/specloom/materials/";
export const materialImagePath = /^assets\/specloom\/materials\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/;
