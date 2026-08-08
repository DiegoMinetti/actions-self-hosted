import 'dotenv/config';
import { z } from 'zod';

/**
 * Validación de variables de entorno con Zod.
 * Falla rápido en arranque si falta algo crítico.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  DB_PATH: z.string().default('data/runners.db'),
  DOCKER_SOCKET: z.string().optional(),
  /** Compose project name usado como label en containers/volúmenes
   *  que crea la app. Aparece como grupo en Docker Desktop. */
  COMPOSE_PROJECT_NAME: z.string().default('actions-self-hosted'),
  PANEL_USER: z.string().optional(),
  PANEL_PASSWORD: z.string().optional(),
  /**
   * Master key para encriptar los GitHub PATs en la DB. AES-256-GCM.
   * Si está vacía, se genera una nueva al arranque (dev only — en
   * producción SIEMPRE tiene que estar seteada o se pierden los PATs
   * al reiniciar la app).
   * Formato esperado: hex de 64 chars (32 bytes).
   */
  APP_ENCRYPTION_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;
