import assert from 'assert';
import express, { Request, Response } from 'express';
import cors from 'cors';
import http from 'http';
import {
  getAllowedOrigins,
  isOriginAllowed,
  createCorsOptions,
  createAiPlanRateLimiter,
  DEFAULT_DEV_ORIGINS,
  DEFAULT_PROD_ORIGINS,
} from '../src/server/securityConfig';

/**
 * Suite Pengujian Phase 1 Security Hardening:
 * 1. CORS Origin Restriction & Whitelist
 * 2. Rate Limiting on POST /api/gemini/plan
 * 3. Isolation of /api/health from Rate Limiter
 * 4. Error response contract compliance
 */
export async function runSecurityPhase1Tests(): Promise<void> {
  console.log('================================================================');
  console.log('🛡️  MENJALANKAN SUITE PHASE 1: SECURITY HARDENING AUDIT 🛡️');
  console.log('================================================================\n');

  // --- AREA 1: CORS Whitelist & Origin Validation ---
  console.log('--- [CORS 1] Origin Whitelist Validation ---');
  {
    const devOrigins = getAllowedOrigins(false);
    assert.ok(isOriginAllowed('http://localhost:3000', devOrigins), 'localhost:3000 harus diizinkan di dev');
    assert.ok(isOriginAllowed('http://127.0.0.1:3000', devOrigins), '127.0.0.1:3000 harus diizinkan di dev');
    assert.ok(isOriginAllowed('https://ais-dev-otqa5wcswbgfkhdzicq52h-754219174890.asia-east1.run.app', devOrigins), 'Cloud Run dev URL harus diizinkan');
    assert.ok(isOriginAllowed('https://ais-pre-otqa5wcswbgfkhdzicq52h-754219174890.asia-east1.run.app', devOrigins), 'Cloud Run pre URL harus diizinkan');

    // Penolakan origin tidak dikenal / penyerang
    assert.strictEqual(isOriginAllowed('https://evil-attacker.com', devOrigins), false, 'Origin tidak sah harus ditolak');
    assert.strictEqual(isOriginAllowed('http://localhost:8080', devOrigins), false, 'Port yang tidak terdaftar harus ditolak');
    assert.strictEqual(isOriginAllowed('https://phishing-even.net', devOrigins), false, 'Domain phishing harus ditolak');
    assert.strictEqual(isOriginAllowed('', devOrigins), false, 'Empty origin string harus ditolak');

    console.log('  ✅ [PASS] CORS 1: Origin whitelist development & Cloud Run terverifikasi aman.');
  }

  console.log('\n--- [CORS 2] Production Strict Whitelist & No Wildcard ---');
  {
    const prodOrigins = getAllowedOrigins(true);
    assert.strictEqual(isOriginAllowed('http://localhost:3000', prodOrigins), false, 'localhost tidak boleh diizinkan di mode production default');
    assert.ok(isOriginAllowed('https://ais-dev-otqa5wcswbgfkhdzicq52h-754219174890.asia-east1.run.app', prodOrigins), 'Production Cloud Run dev harus diizinkan');
    assert.ok(isOriginAllowed('https://ais-pre-otqa5wcswbgfkhdzicq52h-754219174890.asia-east1.run.app', prodOrigins), 'Production Cloud Run pre harus diizinkan');
    assert.strictEqual(isOriginAllowed('https://malicious-site.org', prodOrigins), false, 'Malicious site ditolak di production');

    // Pastikan tidak ada '*' wildcard di dalam prod origins
    const hasWildcard = prodOrigins.some((o) => o === '*');
    assert.strictEqual(hasWildcard, false, 'Production TIDAK BOLEH mengandung wildcard *');

    console.log('  ✅ [PASS] CORS 2: Production mode bebas dari wildcard * dan mematuhi whitelist ketat.');
  }

  console.log('\n--- [CORS 3] ALLOWED_ORIGINS Environment Variable Override ---');
  {
    const originalEnv = process.env.ALLOWED_ORIGINS;
    try {
      process.env.ALLOWED_ORIGINS = 'https://even-planner.com, https://app.even.internal';
      const customOrigins = getAllowedOrigins(true);
      assert.ok(isOriginAllowed('https://even-planner.com', customOrigins), 'Custom domain 1 diizinkan');
      assert.ok(isOriginAllowed('https://app.even.internal', customOrigins), 'Custom domain 2 diizinkan');
      assert.strictEqual(isOriginAllowed('https://ais-dev-otqa5wcswbgfkhdzicq52h-754219174890.asia-east1.run.app', customOrigins), false, 'Default URL di-override saat env disetel');
      console.log('  ✅ [PASS] CORS 3: ALLOWED_ORIGINS environment variable override bekerja akurat.');
    } finally {
      if (originalEnv !== undefined) {
        process.env.ALLOWED_ORIGINS = originalEnv;
      } else {
        delete process.env.ALLOWED_ORIGINS;
      }
    }
  }

  console.log('\n--- [CORS 4] Preflight & Header Options Handshake ---');
  {
    const corsOpts = createCorsOptions(false);
    assert.strictEqual(corsOpts.credentials, true, 'Credentials harus diizinkan untuk session otentik');
    assert.ok(corsOpts.methods?.includes('POST'), 'POST method harus diizinkan');
    assert.ok(corsOpts.methods?.includes('OPTIONS'), 'OPTIONS method harus diizinkan');
    assert.ok(corsOpts.allowedHeaders?.includes('Content-Type'), 'Content-Type harus diizinkan');
    assert.ok(corsOpts.allowedHeaders?.includes('X-Request-ID'), 'X-Request-ID harus diizinkan');

    // Callback execution check
    let allowedCallbackResult: any = null;
    (corsOpts.origin as any)('http://localhost:3000', (err: any, allow: any) => {
      allowedCallbackResult = { err, allow };
    });
    assert.strictEqual(allowedCallbackResult?.err, null);
    assert.strictEqual(allowedCallbackResult?.allow, true, 'Origin valid harus di-callback dengan true');

    let rejectedCallbackResult: any = null;
    (corsOpts.origin as any)('https://untrusted.com', (err: any, allow: any) => {
      rejectedCallbackResult = { err, allow };
    });
    assert.strictEqual(rejectedCallbackResult?.err, null);
    assert.strictEqual(rejectedCallbackResult?.allow, false, 'Origin tidak sah harus di-callback dengan false (no ACAO)');

    let noOriginCallbackResult: any = null;
    (corsOpts.origin as any)(undefined, (err: any, allow: any) => {
      noOriginCallbackResult = { err, allow };
    });
    assert.strictEqual(noOriginCallbackResult?.allow, true, 'Request tanpa header origin (curl/kesehatan) harus diizinkan');

    console.log('  ✅ [PASS] CORS 4: Preflight configuration dan origin callback handshake valid.');
  }

  // --- AREA 2: Rate Limiting & Route Isolation Test with Live In-Memory Express ---
  console.log('\n--- [RATE LIMIT 1] Rate Limiter Threshold Enforcement & 429 Status ---');
  {
    // Buat Express app terisolasi untuk menguji perilaku HTTP secara nyata
    const testApp = express();
    testApp.set('trust proxy', 1);

    // Limit kecil untuk pengujian cepat: 3 requests per 5 detik
    const testLimiter = createAiPlanRateLimiter({
      windowMs: 5000,
      max: 3,
    });

    let aiHandlerCallCount = 0;

    testApp.get('/api/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', service: 'EVEN AI Planner' });
    });

    testApp.post('/api/gemini/plan', testLimiter, (_req: Request, res: Response) => {
      aiHandlerCallCount++;
      res.json({ success: true, message: 'Plan generated' });
    });

    const server = http.createServer(testApp);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Request 1, 2, 3: Harap sukses (di bawah limit 3)
      for (let i = 1; i <= 3; i++) {
        const resp = await fetch(`${baseUrl}/api/gemini/plan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userPrompt: 'Belajar matematika 60 menit' }),
        });
        assert.strictEqual(resp.status, 200, `Request ke-${i} harus berhasil (HTTP 200)`);
      }
      assert.strictEqual(aiHandlerCallCount, 3, 'Handler AI harus dieksekusi tepat 3 kali');

      // Request 4: Melebihi limit, harus mengembalikan HTTP 429 Too Many Requests
      const respOver = await fetch(`${baseUrl}/api/gemini/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPrompt: 'Request melebihi batas' }),
      });

      assert.strictEqual(respOver.status, 429, 'Request ke-4 harus mengembalikan HTTP 429');
      assert.strictEqual(aiHandlerCallCount, 3, 'Handler AI TIDAK BOLEH dipanggil saat terkena rate limit');

      const bodyOver = await respOver.json();
      assert.strictEqual(bodyOver.success, false, 'Response body success harus false');
      assert.strictEqual(bodyOver.errorCode, 'RATE_LIMIT_EXCEEDED', 'errorCode harus RATE_LIMIT_EXCEEDED');
      assert.strictEqual(bodyOver.category, 'rate_limit', 'category harus rate_limit');
      assert.strictEqual(bodyOver.providerStatus, 429, 'providerStatus harus 429');
      assert.ok(typeof bodyOver.error === 'string' && bodyOver.error.includes('Terlalu banyak permintaan'), 'Pesan error harus berbahasa Indonesia');

      // Periksa header rate limit
      const rateLimitPolicy = respOver.headers.get('ratelimit-policy') || respOver.headers.get('ratelimit-limit') || respOver.headers.get('retry-after');
      assert.ok(rateLimitPolicy !== null, 'Header rate limit (RateLimit-* atau Retry-After) harus tersedia');

      console.log('  ✅ [PASS] RATE LIMIT 1: Limit 3 req terpicu presisi, status 429 dan handler AI terlindungi.');

      // --- AREA 3: Route Isolation (/api/health not affected) ---
      console.log('\n--- [RATE LIMIT 2] Route Isolation: /api/health Bebas dari Rate Limit ---');
      const healthResp = await fetch(`${baseUrl}/api/health`);
      assert.strictEqual(healthResp.status, 200, '/api/health harus tetap HTTP 200 meskipun endpoint AI terblokir');
      const healthBody = await healthResp.json();
      assert.strictEqual(healthBody.status, 'ok', 'Status health harus ok');
      console.log('  ✅ [PASS] RATE LIMIT 2: Endpoint /api/health beroperasi normal tanpa terpengaruh pembatasan AI.');

      // --- AREA 4: Information Leakage Prevention ---
      console.log('\n--- [SECURITY 3] Zero Information Leakage on Error ---');
      const responseStr = JSON.stringify(bodyOver);
      assert.strictEqual(responseStr.includes('stack'), false, 'Stack trace tidak boleh bocor');
      assert.strictEqual(responseStr.includes('AIza'), false, 'API key tidak boleh bocor');
      assert.strictEqual(responseStr.includes('token'), false, 'Token tidak boleh bocor');
      console.log('  ✅ [PASS] SECURITY 3: Respon error bersih dari kebocoran rahasia atau stack trace.');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  console.log('\n================================================================');
  console.log('🎉 SELURUH PENGUJIAN KEAMANAN FASE 1 BERHASIL 100%! 🎉');
  console.log('================================================================\n');
}

// Jalankan mandiri jika dipanggil via node/tsx
if (process.argv[1]?.endsWith('securityPhase1.test.ts')) {
  runSecurityPhase1Tests().catch((err) => {
    console.error('❌ GAGAL PENGUJIAN SECURITY FASE 1:', err);
    process.exit(1);
  });
}
