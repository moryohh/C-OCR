import { createRemoteJWKSet, jwtVerify } from 'jose';

interface Env {
  ASSETS: Fetcher;
  OCR_SPACE_ENDPOINT: string;
  OCR_API_KEY_1?: string;
  OCR_API_KEY_2?: string;
  OCR_RELAY_URL?: string;
  OCR_RELAY_TOKEN?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  AUTH_SUPABASE_A_URL?: string;
  AUTH_SUPABASE_A_ANON_KEY?: string;
  ALLOWED_ORIGINS?: string;
  OCR_DAILY_LIMIT?: string;
}

type FailureStage = 'validation' | 'authentication' | 'proxy' | 'ocr' | 'deepseek' | 'comparison' | 'configuration';

type ActivityRecord = {
  request_id: string;
  provider_slot: string;
  success: boolean;
  failure_stage?: FailureStage;
  error?: string;
  duration_ms: number;
  created_at: string;
};

type EvaluationResult = {
  score: number;
  max_score: number;
  percentage: number;
  feedback: string;
  identifiedTextOrSteps: string[];
  strengths: string[];
  recommendations: string[];
  comparison_engine: string;
  extracted_text: string;
};

const activity: ActivityRecord[] = [];
let roundRobinCursor = 0;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksIssuer = '';
const ipBuckets = new Map<string, { startedAt: number; count: number }>();
const DAILY_LIMIT_DEFAULT = 500;
const WINDOW_MS = 60_000;
const WINDOW_LIMIT = 20;

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function getAllowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || 'https://moryohh.github.io')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get('Origin')?.replace(/\/$/, '');
  const allowed = origin && getAllowedOrigins(env).includes(origin) ? origin : '';
  return {
    ...(allowed ? { 'Access-Control-Allow-Origin': allowed, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Secure-File-Name',
    'Access-Control-Max-Age': '600',
  };
}

function getClientFingerprint(request: Request): string {
  const raw = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ip_${(hash >>> 0).toString(16)}`;
}

function isRateLimited(request: Request, env: Env): { limited: boolean; retryAfter: number } {
  const now = Date.now();
  const fingerprint = getClientFingerprint(request);
  const current = ipBuckets.get(fingerprint);
  const bucket = !current || now - current.startedAt >= WINDOW_MS
    ? { startedAt: now, count: 0 }
    : current;
  bucket.count += 1;
  ipBuckets.set(fingerprint, bucket);

  if (ipBuckets.size > 5000) {
    for (const [key, value] of ipBuckets) {
      if (now - value.startedAt >= WINDOW_MS) ipBuckets.delete(key);
    }
  }

  const configuredDailyLimit = Number(env.OCR_DAILY_LIMIT || DAILY_LIMIT_DEFAULT);
  const perWindowLimit = Math.max(5, Math.min(WINDOW_LIMIT, Math.ceil(configuredDailyLimit / 24)));
  const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - bucket.startedAt)) / 1000));
  return { limited: bucket.count > perWindowLimit, retryAfter };
}

function addActivity(record: ActivityRecord): void {
  activity.unshift(record);
  if (activity.length > 50) activity.length = 50;
}

function sanitizeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeBase64(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('data:')) return trimmed;
  return `data:image/jpeg;base64,${trimmed}`;
}

function extractOcrText(payload: any): string {
  const parsed = Array.isArray(payload?.ParsedResults) ? payload.ParsedResults : [];
  return parsed
    .map((item: any) => typeof item?.ParsedText === 'string' ? item.ParsedText.trim() : '')
    .filter(Boolean)
    .join('\n')
    .slice(0, 40_000);
}

function normalizeForCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ى]/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function localComparison(extracted: string, modelAnswer: string, maxScore: number): EvaluationResult {
  const expected = normalizeForCompare(modelAnswer);
  const actual = normalizeForCompare(extracted);
  const expectedTokens = new Set(expected.split(' ').filter((token) => token.length > 1));
  const actualTokens = new Set(actual.split(' ').filter((token) => token.length > 1));
  let matches = 0;
  for (const token of expectedTokens) if (actualTokens.has(token)) matches += 1;
  const percentage = expectedTokens.size ? Math.round((matches / expectedTokens.size) * 100) : 0;
  const score = Math.round((maxScore * percentage) / 100);
  return {
    score,
    max_score: maxScore,
    percentage,
    feedback: 'تمت المقارنة محليًا لأن خدمة DeepSeek لم تُرجع نتيجة. يمكنك إعادة المحاولة لاحقًا.',
    identifiedTextOrSteps: extracted ? [extracted.slice(0, 2000)] : [],
    strengths: matches > 0 ? ['تم التعرف على جزء من كلمات الإجابة النموذجية.'] : [],
    recommendations: ['تأكد من وضوح الصورة وترتيب خطوات الإجابة.'],
    comparison_engine: 'local-fallback',
    extracted_text: extracted,
  };
}

async function verifySupabaseToken(request: Request, env: Env): Promise<{ ok: boolean; userId?: string }> {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return { ok: false };
  const token = header.slice(7).trim();
  if (!token) return { ok: false };
  const baseUrl = (env.AUTH_SUPABASE_A_URL || '').replace(/\/$/, '');
  if (!baseUrl) return { ok: false };

  try {
    const issuer = `${baseUrl}/auth/v1`;
    if (!jwks || jwksIssuer !== issuer) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
      jwksIssuer = issuer;
    }
    try {
      const verified = await jwtVerify(token, jwks, { issuer, audience: 'authenticated' });
      return { ok: true, userId: typeof verified.payload.sub === 'string' ? verified.payload.sub : undefined };
    } catch {
      const anonKey = (env.AUTH_SUPABASE_A_ANON_KEY || '').trim();
      if (!anonKey) return { ok: false };
      const response = await fetch(`${baseUrl}/auth/v1/user`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
      });
      const user = await response.json().catch(() => ({})) as { id?: unknown };
      return response.ok && typeof user.id === 'string' ? { ok: true, userId: user.id } : { ok: false };
    }
  } catch {
    return { ok: false };
  }
}

type OcrSlot = {
  id: string;
  kind: 'cloudflare' | 'vercel';
  key?: string;
};

function getOcrSlots(env: Env): OcrSlot[] {
  const slots: OcrSlot[] = [];
  const firstKey = (env.OCR_API_KEY_1 || '').trim();
  if (firstKey) slots.push({ id: 'ocr-1-cloudflare', kind: 'cloudflare', key: firstKey });

  const relayUrl = (env.OCR_RELAY_URL || '').trim();
  const relayToken = (env.OCR_RELAY_TOKEN || '').trim();
  if (relayUrl && relayToken) {
    slots.push({ id: 'ocr-2-vercel', kind: 'vercel' });
  } else if (!relayUrl) {
    // Backward-compatible mode: use a second direct key only when no relay URL is configured.
    const secondKey = (env.OCR_API_KEY_2 || '').trim();
    if (secondKey) slots.push({ id: 'ocr-2-cloudflare', kind: 'cloudflare', key: secondKey });
  }
  return slots;
}

async function callOcrSpace(imageBase64: string, language: string, apiKey: string, env: Env): Promise<{ text: string; raw: any }> {
  const form = new FormData();
  form.append('base64Image', normalizeBase64(imageBase64));
  form.append('language', language || 'ara');
  form.append('OCREngine', '2');
  form.append('isOverlayRequired', 'false');

  // The Worker creates a fresh server-to-server request; no browser identity headers are forwarded.
  const headers = new Headers({ apikey: apiKey });

  const response = await fetch(env.OCR_SPACE_ENDPOINT || 'https://api.ocr.space/parse/image', {
    method: 'POST',
    headers,
    body: form,
  });
  const payload = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok || payload.IsErroredOnProcessing || payload.OCRExitCode === '3' || payload.OCRExitCode === 4) {
    const reason = sanitizeText(payload?.ErrorMessage || payload?.ErrorDetails || `OCR HTTP ${response.status}`, 500);
    throw new Error(reason || 'فشل استخراج النص من OCR.Space');
  }
  const text = extractOcrText(payload);
  if (!text) throw new Error('لم يتم التعرف على نص واضح في الصورة');
  return { text, raw: payload };
}

async function callOcrRelay(imageBase64: string, language: string, requestId: string, env: Env): Promise<{ text: string }> {
  const relayUrl = (env.OCR_RELAY_URL || '').trim();
  const relayToken = (env.OCR_RELAY_TOKEN || '').trim();
  if (!relayUrl || !relayToken) throw new Error('مسار Vercel غير مهيأ');

  const response = await fetch(relayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-C-OCR-Relay-Token': relayToken,
    },
    body: JSON.stringify({ imageBase64, language, request_id: requestId }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok || payload?.success === false) throw new Error('فشل مسار Vercel الثانوي');
  const text = sanitizeText(payload?.extracted_text || payload?.text, 40_000);
  if (!text) throw new Error('لم يُرجع مسار Vercel نصًا واضحًا');
  return { text };
}

async function callOcrSlot(slot: OcrSlot, imageBase64: string, language: string, requestId: string, env: Env): Promise<{ text: string }> {
  if (slot.kind === 'vercel') return callOcrRelay(imageBase64, language, requestId, env);
  const result = await callOcrSpace(imageBase64, language, slot.key || '', env);
  return { text: result.text };
}

function parseJsonContent(content: string): any | null {
  const cleaned = content.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function compareWithDeepSeek(extracted: string, question: string, modelAnswer: string, maxScore: number, env: Env): Promise<EvaluationResult> {
  const apiKey = (env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) throw new Error('مفتاح DeepSeek غير مهيأ في موقع C');

  const prompt = [
    'قيّم إجابة الطالب باللغة العربية وفق السؤال والإجابة النموذجية.',
    'أعد JSON صالحًا فقط دون Markdown بهذه المفاتيح:',
    '{"score":number,"percentage":number,"feedback":string,"identifiedTextOrSteps":string[],"strengths":string[],"recommendations":string[]}',
    `الدرجة الكاملة: ${maxScore}`,
    `السؤال: ${question || 'غير متوفر'}`,
    `الإجابة النموذجية: ${modelAnswer || 'غير متوفرة'}`,
    `النص المستخرج من ورقة الطالب: ${extracted}`,
  ].join('\n\n');

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL || 'deepseek-chat',
      temperature: 0,
      max_tokens: 700,
      messages: [
        { role: 'system', content: 'أنت مصحح تعليمي دقيق. أعد JSON فقط.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) throw new Error(sanitizeText(payload.error?.message || `DeepSeek HTTP ${response.status}`, 500));
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = typeof content === 'string' ? parseJsonContent(content) : null;
  if (!parsed) throw new Error('تعذر قراءة نتيجة DeepSeek بصيغة صحيحة');

  const percentage = Math.max(0, Math.min(100, Math.round(Number(parsed.percentage) || 0)));
  const score = Math.max(0, Math.min(maxScore, Math.round(Number(parsed.score) || (maxScore * percentage) / 100)));
  return {
    score,
    max_score: maxScore,
    percentage,
    feedback: sanitizeText(parsed.feedback, 3000) || 'تم تقييم الإجابة.',
    identifiedTextOrSteps: Array.isArray(parsed.identifiedTextOrSteps) ? parsed.identifiedTextOrSteps.map((item: unknown) => sanitizeText(item, 500)).filter(Boolean).slice(0, 20) : [],
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map((item: unknown) => sanitizeText(item, 500)).filter(Boolean).slice(0, 20) : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map((item: unknown) => sanitizeText(item, 500)).filter(Boolean).slice(0, 20) : [],
    comparison_engine: 'deepseek',
    extracted_text: extracted,
  };
}

async function processOcr(request: Request, env: Env): Promise<Response> {
  const startedAt = Date.now();
  const requestOrigin = request.headers.get('Origin')?.replace(/\/$/, '') || '';
  const cors = corsHeaders(request, env);
  const requestId = `cocr_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;

  if (requestOrigin && !getAllowedOrigins(env).includes(requestOrigin)) {
    return json({ success: false, request_id: requestId, failure_stage: 'authentication', error: 'مصدر الطلب غير مسموح.' }, 403, cors);
  }

  const rate = isRateLimited(request, env);
  if (rate.limited) {
    return json({ success: false, request_id: requestId, failure_stage: 'proxy', code: 'RATE_LIMITED', error: 'تم تجاوز عدد المحاولات مؤقتًا.', retry_after_seconds: rate.retryAfter }, 429, { ...cors, 'Retry-After': String(rate.retryAfter) });
  }

  const auth = await verifySupabaseToken(request, env);
  if (!auth.ok) {
    addActivity({ request_id: requestId, provider_slot: 'none', success: false, failure_stage: 'authentication', error: 'جلسة المستخدم غير صالحة', duration_ms: Date.now() - startedAt, created_at: new Date().toISOString() });
    return json({ success: false, request_id: requestId, failure_stage: 'authentication', error: 'يجب تسجيل الدخول قبل إرسال صورة OCR.' }, 401, cors);
  }

  let body: any;
  try { body = await request.json(); } catch {
    return json({ success: false, request_id: requestId, failure_stage: 'validation', error: 'بيانات الطلب ليست JSON صحيحة.' }, 400, cors);
  }

  const imageBase64 = sanitizeText(body?.imageBase64 || body?.image_base64 || body?.base64Image, 12_000_000);
  const question = sanitizeText(body?.questionText || body?.question_text || body?.question, 10_000);
  const modelAnswer = sanitizeText(body?.modelAnswer || body?.model_answer, 10_000);
  const language = sanitizeText(body?.language, 10) || 'ara';
  const maxScore = Math.max(1, Math.min(1000, Number(body?.maxScore || body?.max_score) || 5));

  if (!imageBase64) return json({ success: false, request_id: requestId, failure_stage: 'validation', error: 'صورة الإجابة مطلوبة.' }, 400, cors);
  if (imageBase64.length > 12_000_000) return json({ success: false, request_id: requestId, failure_stage: 'validation', error: 'حجم الصورة أكبر من الحد المسموح.' }, 413, cors);

  const slots = getOcrSlots(env);
  if (!slots.length) {
    addActivity({ request_id: requestId, provider_slot: 'none', success: false, failure_stage: 'configuration', error: 'لم يتم ضبط مسارات OCR', duration_ms: Date.now() - startedAt, created_at: new Date().toISOString() });
    return json({ success: false, request_id: requestId, failure_stage: 'configuration', error: 'لم يتم إعداد مسار OCR في موقع C.' }, 503, cors);
  }

  const startIndex = roundRobinCursor % slots.length;
  roundRobinCursor = (roundRobinCursor + 1) % slots.length;
  let extracted = '';
  let usedSlot = slots[0].id;
  let ocrError = '';

  for (let offset = 0; offset < slots.length; offset += 1) {
    const index = (startIndex + offset) % slots.length;
    const slot = slots[index];
    usedSlot = slot.id;
    try {
      const ocr = await callOcrSlot(slot, imageBase64, language, requestId, env);
      extracted = ocr.text;
      break;
    } catch (error) {
      ocrError = error instanceof Error ? error.message : 'فشل OCR';
      if (offset === slots.length - 1) {
        addActivity({ request_id: requestId, provider_slot: usedSlot, success: false, failure_stage: 'ocr', error: ocrError, duration_ms: Date.now() - startedAt, created_at: new Date().toISOString() });
        return json({ success: false, request_id: requestId, provider_slot: usedSlot, failure_stage: 'ocr', error: 'فشل استخراج النص من مسارات OCR المتاحة.', attempts: slots.length }, 502, cors);
      }
    }
  }

  let comparison: EvaluationResult;
  let failureStage: FailureStage | undefined;
  try {
    comparison = await compareWithDeepSeek(extracted, question, modelAnswer, maxScore, env);
  } catch (error) {
    failureStage = 'deepseek';
    comparison = localComparison(extracted, modelAnswer, maxScore);
    comparison.feedback = `${comparison.feedback} سبب التنبيه: ${error instanceof Error ? error.message : 'تعذر الاتصال بـDeepSeek'}`.slice(0, 3000);
  }

  addActivity({ request_id: requestId, provider_slot: usedSlot, success: true, ...(failureStage ? { failure_stage: failureStage, error: 'تم استخدام المقارنة المحلية الاحتياطية.' } : {}), duration_ms: Date.now() - startedAt, created_at: new Date().toISOString() });
  return json({
    success: true,
    request_id: requestId,
    provider_slot: usedSlot,
    failure_stage: failureStage,
    result: {
      ...comparison,
      maxScore,
      request_id: requestId,
      ocr_provider: usedSlot,
      comparison_engine: comparison.comparison_engine,
    },
  }, 200, cors);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/api/health') {
      const slots = getOcrSlots(env);
      return json({ success: true, service: 'C-OCR', status: 'ready', configured_ocr_slots: slots.length, ocr_routes: slots.map((slot) => slot.id), deepseek_configured: Boolean(env.DEEPSEEK_API_KEY) }, 200, cors);
    }

    if (url.pathname === '/api/admin/activity' && request.method === 'GET') {
      const auth = await verifySupabaseToken(request, env);
      if (!auth.ok) return json({ success: false, failure_stage: 'authentication', error: 'تسجيل الدخول مطلوب.' }, 401, cors);
      return json({ success: true, activity: activity.map((item) => ({ ...item, error: item.error?.slice(0, 300) })) }, 200, cors);
    }

    if (url.pathname === '/api/admin/status' && request.method === 'GET') {
      const auth = await verifySupabaseToken(request, env);
      if (!auth.ok) return json({ success: false, failure_stage: 'authentication', error: 'تسجيل الدخول مطلوب.' }, 401, cors);
      const slots = getOcrSlots(env);
      return json({ success: true, service: 'C-OCR', configured_ocr_slots: slots.length, ocr_routes: slots.map((slot) => slot.id), deepseek_configured: Boolean(env.DEEPSEEK_API_KEY), recent_requests: activity.length }, 200, cors);
    }

    if ((url.pathname === '/api/v1/ocr/process' || url.pathname === '/api/ocr/process') && request.method === 'POST') {
      return processOcr(request, env);
    }

    if (url.pathname.startsWith('/api/')) return json({ success: false, error: 'المسار غير موجود.' }, 404, cors);

    const response = await env.ASSETS.fetch(request);
    return response;
  },
};
