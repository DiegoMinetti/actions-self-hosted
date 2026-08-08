import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from './env.js';

/**
 * AES-256-GCM helpers para encriptar secretos en la DB (GitHub PATs).
 *
 * Formato del ciphertext almacenado: `iv:tag:encrypted` en hex.
 *   - iv: 12 bytes random por encrypt (recomendado para GCM)
 *   - tag: 16 bytes (GCM auth tag)
 *   - encrypted: variable
 *
 * La master key viene de `APP_ENCRYPTION_KEY` (env). Si no está seteada,
 * se genera una al arranque y se loguea un warning. En producción SIEMPRE
 * tiene que estar seteada, sino los PATs encriptados se vuelven ilegibles
 * al reiniciar la app.
 */

let _key: Buffer | null = null;
let _warningLogged = false;

function getKey(): Buffer {
  if (_key) return _key;

  const fromEnv = env.APP_ENCRYPTION_KEY;
  if (fromEnv && /^[0-9a-fA-F]{64}$/.test(fromEnv)) {
    _key = Buffer.from(fromEnv, 'hex');
    return _key;
  }

  // Sin key (o malformada): generamos una nueva. En dev esto está OK porque
  // la DB se borra; en prod perderíamos acceso a los PATs existentes.
  _key = randomBytes(32);
  if (!_warningLogged) {
    console.warn(
      '\n⚠️  APP_ENCRYPTION_KEY no está seteada (o es inválida). ' +
        'Se generó una clave nueva en memoria.\n' +
        '   Esto está OK en dev, pero en PRODUCCIÓN los PATs encriptados ' +
        'se volverán ilegibles al reiniciar.\n' +
        "   Generá una con: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n",
    );
    _warningLogged = true;
  }
  return _key;
}

/**
 * Encripta un string. Devuelve `iv:tag:encrypted` en hex.
 * IV random de 12 bytes por encrypt (recomendado para GCM).
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Desencripta un string encriptado con `encrypt()`. Lanza si el formato
 * es inválido o si el auth tag no matchea (clave incorrecta o ciphertext
 * corrupto).
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Formato de ciphertext inválido');
  }
  const ivHex = parts[0] ?? '';
  const tagHex = parts[1] ?? '';
  const encryptedHex = parts[2] ?? '';
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Helper: genera una master key nueva (para que el user la pegue en
 * su `.env` en producción). 32 bytes en hex = 64 chars.
 */
export function generateMasterKey(): string {
  return randomBytes(32).toString('hex');
}
