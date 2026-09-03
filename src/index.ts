import { createRemoteJWKSet, jwtVerify } from 'jose';

interface Env {
  ASSETS: Fetcher;
  OCR_SPACE_ENDPOINT: string;
  OCR_API_KEY_1?: string;
  OCR_API_KEY_2?: string;
  OCR_RELAY_URL?: string;
  OCR_RELAY_TOKEN?: string;
  AUTH_SUPABASE_A_URL?: string;
  AUTH_SUPABASE_A_ANON_KEY?: string;
  ALLOWED_ORIGINS?: string;
  OCR_DAILY_LIMIT?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  GEMINI_API_1_URL?: string;
  GEMINI_API_2_URL?: string;
  GEMINI_TIMEOUT_MS?: string;
  ROUND_ROBIN?: DurableObjectNamespace;
}

type FailureStage = 'validation' | 'authentication' | 'proxy' | 'ocr' | 'deepseek' | 'comparison' | 'configuration';

type ActivityRecord = {
  request_id: string;
  submission_id?: string;
  question_id?: string;
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
  comparison_engine: 'deepseek' | 'gemini';
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

function sanitizeOcrFailure(value: unknown): string {
  const message = sanitizeText(value, 120).toLowerCase();
  if (!message) return 'لم يُرجع مزود OCR سببًا واضحًا للفشل.';
  if (message.includes('relay_auth')) {
    return 'تعذر التحقق من اتصال مسار Vercel الاحتياطي.';
  }
  if (message.includes('relay_payload_too_large')) {
    return 'حجم الصورة أكبر من الحد الذي يقبله مسار Vercel الاحتياطي.';
  }
  if (message.includes('relay_quota')) {
    return 'تجاوز مسار Vercel أو مزود OCR حد الاستخدام.';
  }
  if (message.includes('relay_network')) {
    return 'تعذر الاتصال بمسار Vercel الاحتياطي.';
  }
  if (message.includes('provider_quota') || message.includes('ocr_quota') || message.includes('rate_limit')) {
    return 'تجاوز حد الاستخدام أو معدل الطلبات لدى مزود OCR.';
  }
  if (message.includes('provider_auth') || message.includes('provider_key') || message.includes('provider_configuration')) {
    return 'رفض مزود OCR الطلب بسبب إعداد المفتاح أو صلاحيته.';
  }
  if (message.includes('provider_network') || message.includes('timeout')) {
    return 'تعذر الاتصال بمزود OCR.';
  }
  if (message.includes('provider_invalid_image')) {
    return 'الصورة المرسلة غير صالحة للقراءة لدى مزود OCR.';
  }
  if (message.includes('provider_empty_text') || message.includes('provider_processing_empty') || message.includes('no_text')) {
    return 'لم يتمكن مزود OCR من قراءة نص واضح في الصورة.';
  }
  if (message.includes('provider_http') || message.includes('provider_processing')) {
    return 'رفض مزود OCR معالجة الصورة.';
  }
  return 'فشل مزود OCR في معالجة الصورة دون إظهار تفاصيل حساسة.';
}

function extractOcrText(payload: any): string {
  const parsed = Array.isArray(payload?.ParsedResults) ? payload.ParsedResults : [];
  return parsed
    .map((item: any) => typeof item?.ParsedText === 'string' ? item.ParsedText.trim() : '')
    .filter(Boolean)
    .join('\n')
    .slice(0, 40_000);
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

type GeminiSlot = { id: string; url: string };

let geminiRoundRobinCursor = 0;

async function getNextGeminiIndex(env: Env, slotCount: number): Promise<number> {
  if (slotCount <= 1) return 0;
  if (env.ROUND_ROBIN) {
    const id = env.ROUND_ROBIN.idFromName('gemini-primary');
    const response = await env.ROUND_ROBIN.get(id).fetch('https://round-robin/next');
    const value = Number(await response.text());
    if (Number.isInteger(value) && value >= 0) return value % slotCount;
  }
  const fallback = geminiRoundRobinCursor % slotCount;
  geminiRoundRobinCursor = (geminiRoundRobinCursor + 1) % slotCount;
  return fallback;
}

function getGeminiSlots(env: Env): GeminiSlot[] {
  const slots: GeminiSlot[] = [];
  const first = sanitizeText(env.GEMINI_API_1_URL, 500);
  const second = sanitizeText(env.GEMINI_API_2_URL, 500);
  if (first) slots.push({ id: 'gemini-1', url: first });
  if (second) slots.push({ id: 'gemini-2', url: second });
  return slots;
}

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

function classifyOcrProviderFailure(status: number, payload: Record<string, any>): string {
  const nestedErrors = Array.isArray(payload?.ParsedResults)
    ? payload.ParsedResults.flatMap((item: any) => [item?.ErrorMessage, item?.ErrorDetails])
    : [];
  const raw = sanitizeText([
    payload?.ErrorMessage,
    payload?.ErrorDetails,
    payload?.Message,
    ...nestedErrors,
  ].flat().join(' '), 1000).toLowerCase();
  const exitCode = String(payload?.OCRExitCode ?? '').trim();
  const pageCodes = Array.isArray(payload?.ParsedResults)
    ? payload.ParsedResults.map((item: any) => String(item?.FileParseExitCode ?? '')).join(' ')
    : '';
  if (status === 401 || status === 403 || raw.includes('api key') || raw.includes('apikey') || raw.includes('invalid key') || raw.includes('expired key') || raw.includes('license') || raw.includes('unauthorized') || raw.includes('forbidden') || raw.includes('authentication')) {
    return 'provider_auth';
  }
  if (status === 429 || raw.includes('quota') || raw.includes('rate limit') || raw.includes('daily limit') || raw.includes('limit exceeded') || raw.includes('too many requests') || raw.includes('maximum requests')) {
    return 'provider_quota';
  }
  if (raw.includes('not a valid base64') || raw.includes('unable to recognize the file type') || raw.includes('invalid image') || raw.includes('unsupported image') || raw.includes('corrupt') || raw.includes('file type') || exitCode === '99' || pageCodes.includes('-30')) {
    return 'provider_invalid_image';
  }
  if (raw.includes('no text') || raw.includes('empty') || raw.includes('unreadable') || raw.includes('unable to recognize') || exitCode === '3') {
    return 'provider_empty_text';
  }
  if (exitCode === '4' || pageCodes.includes('-20')) return 'provider_processing';
  if (!status || status < 200 || status >= 300) return 'provider_http';
  return 'provider_processing';
}

async function callOcrSpace(imageBase64: string, language: string, apiKey: string, env: Env): Promise<{ text: string; raw: any }> {
  const form = new FormData();
  form.append('base64Image', normalizeBase64(imageBase64));
  form.append('language', language || 'ara');
  form.append('OCREngine', '3');
  form.append('filetype', 'JPG');
  form.append('detectOrientation', 'true');
  form.append('scale', 'true');
  form.append('isOverlayRequired', 'false');

  // The Worker creates a fresh server-to-server request; no browser identity headers are forwarded.
  const headers = new Headers({ apikey: apiKey });
  let response: Response;
  try {
    response = await fetch(env.OCR_SPACE_ENDPOINT || 'https://api.ocr.space/parse/image', {
      method: 'POST',
      headers,
      body: form,
    });
  } catch {
    throw new Error('provider_network');
  }
  const payload = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok || payload.IsErroredOnProcessing || payload.OCRExitCode === '3' || payload.OCRExitCode === 4) {
    throw new Error(classifyOcrProviderFailure(response.status, payload));
  }
  const text = extractOcrText(payload);
  if (!text) throw new Error('provider_empty_text');
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
  if (!response.ok || payload?.success === false) {
    if (response.status === 401 || response.status === 403) throw new Error('relay_auth');
    if (response.status === 413) throw new Error('relay_payload_too_large');
    if (response.status === 429) throw new Error('relay_quota');
    throw new Error(sanitizeOcrFailure(payload?.failure_reason || payload?.error || 'فشل مسار Vercel الثانوي'));
  }
  const text = sanitizeText(payload?.extracted_text || payload?.text, 40_000);
  if (!text) throw new Error('provider_empty_text');
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
  if (!apiKey) throw new Error('deepseek_not_configured');
  const prompt = [
    'قيّم إجابة الطالب باللغة العربية وفق السؤال والإجابة النموذجية.',
    'أعد JSON صالحًا فقط بهذه المفاتيح: {"score":number,"percentage":number,"feedback":string,"identifiedTextOrSteps":string[],"strengths":string[],"recommendations":string[]}',
    `الدرجة الكاملة: ${maxScore}`,
    `السؤال: ${question || 'غير متوفر'}`,
    `الإجابة النموذجية: ${modelAnswer || 'غير متوفرة'}`,
    `النص المستخرج من ورقة الطالب: ${extracted}`,
  ].join('\\n\\n');
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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
  if (!response.ok) throw new Error('deepseek_http');
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = typeof content === 'string' ? parseJsonContent(content) : null;
  if (!parsed) throw new Error('deepseek_invalid_response');
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

function base64ToBlob(value: string): Blob {
  const normalized = normalizeBase64(value);
  const match = normalized.match(/^data:([^;]+);base64,(.*)$/s);
  const mime = match?.[1] || 'image/jpeg';
  const encoded = match?.[2] || normalized;
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

function normalizeGeminiResult(payload: any, maxScore: number): EvaluationResult {
  const result = payload?.result || payload;
  const extractedText = sanitizeText(result?.extractedText || result?.extracted_text || result?.studentAnswer || result?.student_answer, 40_000);
  const rawScore = Number(result?.score);
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(maxScore, Math.round(rawScore))) : 0;
  const suppliedPercentage = Number(result?.percentage ?? result?.similarity_score);
  const percentage = Number.isFinite(suppliedPercentage)
    ? Math.max(0, Math.min(100, Math.round(suppliedPercentage)))
    : Math.round((score / maxScore) * 100);
  const list = (value: unknown): string[] => Array.isArray(value)
    ? value.map((item) => sanitizeText(item, 500)).filter(Boolean).slice(0, 20)
    : [];
  const pageResults = Array.isArray(payload?.pages)
    ? payload.pages.map((page: any) => sanitizeText(page?.result, 2000)).filter(Boolean).join('\\n')
    : '';
  return {
    score,
    max_score: maxScore,
    percentage,
    feedback: sanitizeText(result?.feedback, 3000) || pageResults || 'تمت معالجة الصورة عبر Gemini.',
    identifiedTextOrSteps: list(result?.identifiedTextOrSteps || result?.steps || (extractedText ? [extractedText] : pageResults ? [pageResults] : [])),
    strengths: list(result?.strengths),
    recommendations: list(result?.recommendations),
    comparison_engine: 'gemini',
    extracted_text: extractedText || pageResults,
  };
}

async function callGeminiSlot(slot: GeminiSlot, imageBase64: string, question: string, modelAnswer: string, maxScore: number, requestId: string, body: any, env: Env): Promise<EvaluationResult> {
  const form = new FormData();
  form.append('payload', JSON.stringify({
    question,
    modelAnswer,
    maxScore,
    request_id: requestId,
    source: sanitizeText(body?.source, 40),
    subject: sanitizeText(body?.subject, 120),
    lesson: sanitizeText(body?.lesson || body?.lessonTitle, 240),
  }));
  form.append('image', base64ToBlob(imageBase64), 'student-answer.jpg');
  const controller = new AbortController();
  const timeoutMs = Math.max(5_000, Math.min(60_000, Number(env.GEMINI_TIMEOUT_MS) || 45_000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(slot.url, { method: 'POST', body: form, signal: controller.signal });
    const payload = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok || payload?.ok === false || payload?.success === false) {
      throw new Error(`gemini_http_${response.status}`);
    }
    return normalizeGeminiResult(payload, maxScore);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('gemini_timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

  let body: any;
  try { body = await request.json(); } catch {
    return json({ success: false, request_id: requestId, failure_stage: 'validation', error: 'بيانات الطلب ليست JSON صحيحة.' }, 400, cors);
  }

  const source = sanitizeText(body?.source, 40);
  if (source !== 'daily_exam' && source !== 'educational_test') {
    return json({ success: false, request_id: requestId, failure_stage: 'validation', code: 'SOURCE_NOT_ALLOWED', error: 'هذا المسار مخصص للاختبارات التعليمية فقط.' }, 403, cors);
  }

  const submissionId = sanitizeText(body?.submission_id || body?.submissionId, 120) || requestId;
  const questionId = sanitizeText(body?.question_id || body?.questionId, 120) || 'question';
  const question = sanitizeText(body?.questionText || body?.question_text || body?.question, 10_000);
  const modelAnswer = sanitizeText(body?.modelAnswer || body?.model_answer, 10_000);
  const maxScore = Math.max(1, Math.min(1000, Number(body?.maxScore || body?.max_score) || 5));
  const imageBase64 = sanitizeText(body?.imageBase64 || body?.image_base64 || body?.base64Image, 12_000_000);
  const language = sanitizeText(body?.language, 10) || 'ara';

  if (!imageBase64) return json({ success: false, request_id: requestId, failure_stage: 'validation', error: 'صورة الإجابة مطلوبة.' }, 400, cors);
  if (imageBase64.length > 12_000_000) return json({ success: false, request_id: requestId, failure_stage: 'validation', error: 'حجم الصورة أكبر من الحد المسموح.' }, 413, cors);

  const geminiSlots = getGeminiSlots(env);
  const slots = getOcrSlots(env);
  const geminiFailures: Array<{ provider_slot: string; reason: string }> = [];

  // Gemini is the primary full-image evaluator. Requests alternate between
  // the configured endpoints; each endpoint is attempted at most once.
  if (geminiSlots.length) {
    const startIndex = await getNextGeminiIndex(env, geminiSlots.length);
    for (let offset = 0; offset < geminiSlots.length; offset += 1) {
      const index = (startIndex + offset) % geminiSlots.length;
      const slot = geminiSlots[index];
      try {
        const evaluation = await callGeminiSlot(slot, imageBase64, question, modelAnswer, maxScore, requestId, body, env);
        addActivity({ request_id: requestId, submission_id: submissionId, question_id: questionId, provider_slot: slot.id, success: true, duration_ms: Date.now() - startedAt, created_at: new Date().toISOString() });
        return json({
          success: true,
          request_id: requestId,
          submission_id: submissionId,
          question_id: questionId,
          selected_provider_slot: geminiSlots[startIndex].id,
          provider_slot: slot.id,
          ocr_provider: slot.id,
          extracted_text: evaluation.extracted_text,
          result: evaluation,
          attempts: offset + 1,
          distribution: 'round_robin_gemini',
        }, 200, cors);
      } catch (error) {
        geminiFailures.push({ provider_slot: slot.id, reason: sanitizeOcrFailure(error instanceof Error ? error.message : 'فشل Gemini') });
      }
    }
  }

  if (!slots.length) {
    addActivity({ request_id: requestId, provider_slot: geminiFailures.length ? 'gemini-exhausted' : 'none', success: false, failure_stage: 'configuration', error: 'لم يتم ضبط مسارات المعالجة الاحتياطية', duration_ms: Date.now() - startedAt, created_at: new Date().toISOString() });
    return json({ success: false, request_id: requestId, failure_stage: 'configuration', failure_reasons: geminiFailures, error: 'تعذر تشغيل مسارات المعالجة ولم يتم إعداد مسار احتياطي في موقع C.' }, 503, cors);
  }

  // Choose the starting legacy OCR provider by round-robin. The other provider is only
  // attempted for this request when the selected provider fails.
  const startIndex = roundRobinCursor % slots.length;
  roundRobinCursor = (roundRobinCursor + 1) % slots.length;
  let extracted = '';
  let usedSlot = slots[0].id;
  const ocrFailures: Array<{ provider_slot: string; reason: string }> = [...geminiFailures];

  for (let offset = 0; offset < slots.length; offset += 1) {
    const index = (startIndex + offset) % slots.length;
    const slot = slots[index];
    usedSlot = slot.id;
    try {
      const ocr = await callOcrSlot(slot, imageBase64, language, requestId, env);
      extracted = ocr.text;
      break;
    } catch (error) {
      const reason = sanitizeOcrFailure(error instanceof Error ? error.message : 'فشل OCR');
      ocrFailures.push({ provider_slot: usedSlot, reason });
      if (offset === slots.length - 1) {
        addActivity({ request_id: requestId, provider_slot: usedSlot, success: false, failure_stage: 'ocr', error: reason, duration_ms: Date.now() - startedAt, created_at: new Date().toISOString() });
        return json({ success: false, request_id: requestId, selected_provider_slot: slots[startIndex].id, provider_slot: usedSlot, failure_stage: 'ocr', error: 'فشل استخراج النص من المسارات الأساسية والاحتياطية المتاحة.', failure_reasons: ocrFailures, attempts: geminiFailures.length + slots.length }, 502, cors);
      }
    }
  }

  let comparison: EvaluationResult;
  try {
    comparison = await compareWithDeepSeek(extracted, question, modelAnswer, maxScore, env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'deepseek_unavailable';
    const code = reason === 'deepseek_not_configured'
      ? 'DEEPSEEK_NOT_CONFIGURED'
      : reason === 'deepseek_invalid_response'
        ? 'DEEPSEEK_INVALID_RESPONSE'
        : 'DEEPSEEK_UNAVAILABLE';
    addActivity({ request_id: requestId, submission_id: submissionId, question_id: questionId, provider_slot: usedSlot, success: false, failure_stage: 'comparison', error: code, duration_ms: Date.now() - startedAt, created_at: new Date().toISOString() });
    return json({
      success: false,
      request_id: requestId,
      submission_id: submissionId,
      question_id: questionId,
      selected_provider_slot: slots[startIndex].id,
      provider_slot: usedSlot,
      extracted_text: extracted,
      failure_stage: 'comparison',
      code,
      error: 'تم استخراج النص، لكن تعذر تقييم الإجابة حاليًا.',
      attempts: ocrFailures.length + 1,
    }, 502, cors);
  }

  addActivity({ request_id: requestId, submission_id: submissionId, question_id: questionId, provider_slot: usedSlot, success: true, duration_ms: Date.now() - startedAt, created_at: new Date().toISOString() });
  return json({
    success: true,
    request_id: requestId,
    submission_id: submissionId,
    question_id: questionId,
    selected_provider_slot: slots[startIndex].id,
    provider_slot: usedSlot,
    ocr_provider: usedSlot,
    extracted_text: extracted,
    result: comparison,
    attempts: ocrFailures.length + 1,
    distribution: 'round_robin',
  }, 200, cors);
}

export class RoundRobinCounter {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/next') return new Response('Not found', { status: 404 });
    const current = (await this.state.storage.get<number>('cursor')) || 0;
    await this.state.storage.put('cursor', (current + 1) % 2);
    return new Response(String(current));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/api/health') {
      const slots = getOcrSlots(env);
      return json({ success: true, service: 'C-OCR', status: 'ready', configured_ocr_slots: slots.length, ocr_routes: slots.map((slot) => slot.id), ocr_distribution: 'round_robin', deepseek_configured: Boolean(env.DEEPSEEK_API_KEY) }, 200, cors);
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
      return json({ success: true, service: 'C-OCR', configured_ocr_slots: slots.length, ocr_routes: slots.map((slot) => slot.id), recent_requests: activity.length }, 200, cors);
    }

    if ((url.pathname === '/api/v1/ocr/process' || url.pathname === '/api/ocr/process') && request.method === 'POST') {
      return processOcr(request, env);
    }

    if (url.pathname.startsWith('/api/')) return json({ success: false, error: 'المسار غير موجود.' }, 404, cors);

    const response = await env.ASSETS.fetch(request);
    return response;
  },
};
