export interface ErrorAnalysis {
  status: number;
  category:
    | 'transient_unavailable'
    | 'rate_limited'
    | 'timeout'
    | 'auth_error'
    | 'permission_denied'
    | 'invalid_request'
    | 'internal_error';
  isRetryable: boolean;
  errorCode: string;
  userMessage: string;
}

export interface RetryOptions {
  maxRetries?: number; // Default 2 additional retries (3 attempts total)
  totalTimeoutMs?: number; // Default 16000ms
  initialBackoffMs?: number; // Default 400ms
  maxBackoffMs?: number; // Default 2000ms
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}

/**
 * Classifies an error from Gemini SDK or HTTP layer.
 * Identifies HTTP status, whether it's retryable, safe error code, and user message.
 */
export function classifyGeminiError(err: any): ErrorAnalysis {
  let status = 500;
  const msg = String(err?.message || '');
  const errCode = String(err?.code || '');
  const name = String(err?.name || '');

  // Extract status if available in standard locations
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 600) {
    status = err.status;
  } else if (typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600) {
    status = err.statusCode;
  } else if (typeof err?.response?.status === 'number' && err.response.status >= 400 && err.response.status < 600) {
    status = err.response.status;
  } else if (/\b503\b|UNAVAILABLE|overloaded|high demand|temporarily unavailable/i.test(msg) || errCode === 'UNAVAILABLE') {
    status = 503;
  } else if (/\b429\b|RESOURCE_EXHAUSTED|rate limit|quota|too many requests/i.test(msg) || errCode === 'RESOURCE_EXHAUSTED') {
    status = 429;
  } else if (/\b401\b|UNAUTHENTICATED|API_KEY_INVALID|invalid api key/i.test(msg) || errCode === 'UNAUTHENTICATED') {
    status = 401;
  } else if (/\b403\b|PERMISSION_DENIED|forbidden/i.test(msg) || errCode === 'PERMISSION_DENIED') {
    status = 403;
  } else if (/\b400\b|INVALID_ARGUMENT|bad request/i.test(msg) || errCode === 'INVALID_ARGUMENT') {
    status = 400;
  } else if (/\b504\b|DEADLINE_EXCEEDED|timeout|timed out/i.test(msg) || name === 'AbortError' || errCode === 'DEADLINE_EXCEEDED') {
    status = 504;
  } else if (/\b502\b|bad gateway/i.test(msg)) {
    status = 502;
  }

  // 1. HTTP 503 (Unavailable / Overloaded)
  if (status === 503) {
    return {
      status: 503,
      category: 'transient_unavailable',
      isRetryable: true,
      errorCode: 'AI_TEMPORARILY_UNAVAILABLE',
      userMessage: 'Layanan AI sedang sibuk. Permintaan Anda belum diproses. Silakan coba lagi.',
    };
  }

  // 2. HTTP 429 (Rate limit / Quota)
  if (status === 429) {
    return {
      status: 429,
      category: 'rate_limited',
      isRetryable: true,
      errorCode: 'AI_RATE_LIMIT_EXCEEDED',
      userMessage: 'Layanan AI sedang sibuk karena banyaknya permintaan. Silakan tunggu sebentar dan coba lagi.',
    };
  }

  // 3. Timeout / 504
  if (status === 504 || name === 'AbortError' || /timeout|timed out/i.test(msg)) {
    return {
      status: 504,
      category: 'timeout',
      isRetryable: true,
      errorCode: 'AI_TIMEOUT',
      userMessage: 'Permintaan ke layanan AI melampaui batas waktu. Silakan coba lagi.',
    };
  }

  // 4. HTTP 401 (Auth / Invalid key) - Permanent
  if (status === 401) {
    return {
      status: 401,
      category: 'auth_error',
      isRetryable: false,
      errorCode: 'AI_AUTH_FAILED',
      userMessage: 'Autentikasi ke layanan AI gagal. Periksa konfigurasi API key server.',
    };
  }

  // 5. HTTP 403 (Permission denied) - Permanent
  if (status === 403) {
    return {
      status: 403,
      category: 'permission_denied',
      isRetryable: false,
      errorCode: 'AI_PERMISSION_DENIED',
      userMessage: 'Akses ke model AI ditolak oleh penyedia layanan.',
    };
  }

  // 6. HTTP 400 (Bad request / Invalid prompt format) - Permanent
  if (status === 400) {
    return {
      status: 400,
      category: 'invalid_request',
      isRetryable: false,
      errorCode: 'AI_INVALID_REQUEST',
      userMessage: 'Format permintaan tidak dapat diproses oleh AI.',
    };
  }

  // 7. HTTP 500 / 502 (Server error) - Retryable
  if (status === 500 || status === 502) {
    return {
      status,
      category: 'internal_error',
      isRetryable: true,
      errorCode: 'AI_SERVICE_ERROR',
      userMessage: 'Terjadi gangguan sementara pada server penyedia AI. Silakan coba lagi.',
    };
  }

  return {
    status,
    category: 'internal_error',
    isRetryable: false,
    errorCode: 'AI_UNKNOWN_ERROR',
    userMessage: 'Gagal memproses permintaan dengan AI. Silakan coba lagi.',
  };
}

/**
 * Calculates exponential backoff with full jitter to avoid thundering herds.
 * attempt is 1-indexed (1 for first retry, 2 for second retry).
 */
export function calculateBackoffWithJitter(
  attempt: number,
  initialBackoffMs: number = 400,
  maxBackoffMs: number = 2000
): number {
  const expFactor = Math.pow(2, Math.max(0, attempt - 1));
  const baseMs = Math.min(maxBackoffMs, initialBackoffMs * expFactor);
  // Full jitter: uniformly random between 0.5 * baseMs and 1.5 * baseMs
  const jitterFactor = 0.5 + Math.random();
  return Math.round(baseMs * jitterFactor);
}

export interface RetryExecutionResult<T> {
  result?: T;
  error?: any;
  analysis?: ErrorAnalysis;
  attempts: number; // 1 = succeeded on first try, 2 = 1 retry, 3 = 2 retries
  retryCount: number; // 0, 1, 2
  elapsedMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Executes an async operation with automatic retry on retryable errors (503, 429, 500, timeout).
 * Up to maxRetries additional attempts (default 2), with exponential backoff & jitter, bounded by totalTimeoutMs.
 * Permanent errors (400, 401, 403) are aborted immediately without retry.
 */
export async function executeWithRetryAndTimeout<T>(
  operation: (attempt: number, remainingMs: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryExecutionResult<T>> {
  const maxRetries = options.maxRetries ?? 2;
  const totalTimeoutMs = options.totalTimeoutMs ?? 16000;
  const initialBackoffMs = options.initialBackoffMs ?? 400;
  const maxBackoffMs = options.maxBackoffMs ?? 2000;
  const sleepFn = options.sleepFn ?? defaultSleep;
  const nowFn = options.nowFn ?? Date.now;

  const startTime = nowFn();
  let lastError: any = null;
  let lastAnalysis: ErrorAnalysis = {
    status: 500,
    category: 'internal_error',
    isRetryable: false,
    errorCode: 'AI_UNKNOWN_ERROR',
    userMessage: 'Gagal memproses permintaan dengan AI.',
  };

  let attemptsExecuted = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const elapsed = nowFn() - startTime;
    const remainingMs = totalTimeoutMs - elapsed;

    if (remainingMs <= 500) {
      lastError = new Error('Batas waktu total permintaan AI terlampaui.');
      lastAnalysis = classifyGeminiError(lastError);
      break;
    }

    attemptsExecuted = attempt + 1;

    try {
      const result = await operation(attempt, remainingMs);
      return {
        result,
        attempts: attemptsExecuted,
        retryCount: attempt,
        elapsedMs: nowFn() - startTime,
      };
    } catch (err: any) {
      lastError = err;
      lastAnalysis = classifyGeminiError(err);

      // If permanent error (e.g. 400, 401, 403), stop immediately
      if (!lastAnalysis.isRetryable) {
        break;
      }

      // If last attempt reached, don't sleep, exit
      if (attempt >= maxRetries) {
        break;
      }

      // Calculate backoff
      const backoffMs = calculateBackoffWithJitter(attempt + 1, initialBackoffMs, maxBackoffMs);
      const postBackoffElapsed = nowFn() - startTime + backoffMs;

      // If backoff would exceed total budget with at least 800ms for the next attempt, stop
      if (postBackoffElapsed + 800 > totalTimeoutMs) {
        break;
      }

      await sleepFn(backoffMs);
    }
  }

  return {
    error: lastError,
    analysis: lastAnalysis,
    attempts: attemptsExecuted,
    retryCount: Math.max(0, attemptsExecuted - 1),
    elapsedMs: nowFn() - startTime,
  };
}

/**
 * Maps error code or status to a friendly Indonesian user message.
 * Guaranteed never to return raw JSON or technical stack traces.
 */
export function formatUserErrorMessage(errorCode?: string, status?: number, fallbackMsg?: string): string {
  if (errorCode === 'AI_TEMPORARILY_UNAVAILABLE' || status === 503) {
    return 'Layanan AI sedang sibuk. Permintaan Anda belum diproses. Silakan coba lagi.';
  }
  if (errorCode === 'AI_RATE_LIMIT_EXCEEDED' || status === 429) {
    return 'Layanan AI sedang sibuk karena banyaknya permintaan. Silakan tunggu sebentar dan coba lagi.';
  }
  if (errorCode === 'AI_TIMEOUT' || status === 504) {
    return 'Permintaan ke layanan AI melampaui batas waktu. Silakan coba lagi.';
  }
  if (errorCode === 'AI_AUTH_FAILED' || status === 401) {
    return 'Autentikasi ke layanan AI gagal. Periksa konfigurasi API key server.';
  }
  if (errorCode === 'AI_PERMISSION_DENIED' || status === 403) {
    return 'Akses ke model AI ditolak oleh server.';
  }
  if (errorCode === 'AI_INVALID_REQUEST' || status === 400) {
    return 'Format permintaan tidak dapat diproses oleh AI.';
  }

  // Check if fallback message is raw JSON or technical
  if (fallbackMsg) {
    const trimmed = fallbackMsg.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.includes('{"error"') || trimmed.includes('"errorCode"')) {
      return 'Layanan AI sedang sibuk. Permintaan Anda belum diproses. Silakan coba lagi.';
    }
    return trimmed;
  }

  return 'Layanan AI sedang sibuk. Permintaan Anda belum diproses. Silakan coba lagi.';
}
