import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';

export const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://ais-dev-otqa5wcswbgfkhdzicq52h-754219174890.asia-east1.run.app',
  'https://ais-pre-otqa5wcswbgfkhdzicq52h-754219174890.asia-east1.run.app',
];

export const DEFAULT_PROD_ORIGINS = [
  'https://ais-dev-otqa5wcswbgfkhdzicq52h-754219174890.asia-east1.run.app',
  'https://ais-pre-otqa5wcswbgfkhdzicq52h-754219174890.asia-east1.run.app',
];

/**
 * Mendapatkan daftar origin yang diizinkan berdasarkan environment
 */
export function getAllowedOrigins(isProd = process.env.NODE_ENV === 'production'): (string | RegExp)[] {
  if (process.env.ALLOWED_ORIGINS) {
    const parsed = process.env.ALLOWED_ORIGINS
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  if (isProd) {
    return [
      ...DEFAULT_PROD_ORIGINS,
      /^https:\/\/ais-[a-z0-9-]+-[0-9]+\.[a-z0-9-]+\.run\.app$/,
    ];
  }

  return [
    ...DEFAULT_DEV_ORIGINS,
    /^https:\/\/ais-[a-z0-9-]+-[0-9]+\.[a-z0-9-]+\.run\.app$/,
  ];
}

/**
 * Mengecek apakah suatu origin diizinkan berdasarkan whitelist
 */
export function isOriginAllowed(origin: string, allowedOrigins: (string | RegExp)[]): boolean {
  if (!origin) return false;
  return allowedOrigins.some((allowed) => {
    if (typeof allowed === 'string') {
      return allowed.toLowerCase() === origin.toLowerCase();
    }
    if (allowed instanceof RegExp) {
      return allowed.test(origin);
    }
    return false;
  });
}

/**
 * Membuat konfigurasi CORS yang aman untuk Express
 */
export function createCorsOptions(isProd = process.env.NODE_ENV === 'production'): cors.CorsOptions {
  return {
    origin: (origin, callback) => {
      // Izinkan request tanpa origin (seperti curl, mobile native, same-server requests, cron)
      if (!origin) {
        return callback(null, true);
      }

      const allowed = isOriginAllowed(origin, getAllowedOrigins(isProd));
      if (allowed) {
        return callback(null, true);
      }

      // Menolak origin yang tidak sah (tidak menghasilkan Access-Control-Allow-Origin)
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    credentials: true,
    optionsSuccessStatus: 200,
  };
}

/**
 * Membuat rate limiter untuk endpoint Gemini AI Planning.
 * Dibatasi per IP (default: 20 requests per menit).
 */
export function createAiPlanRateLimiter(options?: {
  windowMs?: number;
  max?: number;
}) {
  const windowMs =
    options?.windowMs ??
    (process.env.AI_RATE_LIMIT_WINDOW_MS
      ? parseInt(process.env.AI_RATE_LIMIT_WINDOW_MS, 10)
      : 60 * 1000);

  const max =
    options?.max ??
    (process.env.AI_RATE_LIMIT_MAX
      ? parseInt(process.env.AI_RATE_LIMIT_MAX, 10)
      : 20);

  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req: Request, res: Response) => {
      return res.status(429).json({
        success: false,
        errorCode: 'RATE_LIMIT_EXCEEDED',
        error:
          'Terlalu banyak permintaan penyusunan jadwal. Silakan tunggu beberapa saat sebelum mencoba kembali.',
        category: 'rate_limit',
        providerStatus: 429,
      });
    },
  });
}
