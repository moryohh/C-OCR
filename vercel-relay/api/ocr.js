const DEFAULT_OCR_ENDPOINT = 'https://api.ocr.space/parse/image';
const MAX_IMAGE_LENGTH = 12_000_000;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '5mb',
    },
  },
};

function sendJson(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(JSON.stringify(payload));
}

function cleanString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeBase64(value) {
  const trimmed = cleanString(value, MAX_IMAGE_LENGTH);
  if (trimmed.startsWith('data:')) return trimmed;
  return `data:image/jpeg;base64,${trimmed}`;
}

function extractOcrText(payload) {
  const parsed = Array.isArray(payload?.ParsedResults) ? payload.ParsedResults : [];
  return parsed
    .map((item) => (typeof item?.ParsedText === 'string' ? item.ParsedText.trim() : ''))
    .filter(Boolean)
    .join('\n')
    .slice(0, 40_000);
}

function safeTokenEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function isAuthorized(req) {
  const expected = cleanString(process.env.C_OCR_RELAY_TOKEN, 512);
  const supplied = cleanString(req.headers['x-c-ocr-relay-token'], 512);
  return Boolean(expected && supplied && safeTokenEqual(expected, supplied));
}

function classifyProviderFailure(status, payload) {
  const nestedErrors = Array.isArray(payload?.ParsedResults)
    ? payload.ParsedResults.flatMap((item) => [item?.ErrorMessage, item?.ErrorDetails])
    : [];
  const raw = [payload?.ErrorMessage, payload?.ErrorDetails, payload?.Message, ...nestedErrors]
    .flat()
    .filter((value) => typeof value === 'string')
    .join(' ')
    .slice(0, 1000)
    .toLowerCase();
  const exitCode = String(payload?.OCRExitCode ?? '').trim();
  const pageCodes = Array.isArray(payload?.ParsedResults)
    ? payload.ParsedResults.map((item) => String(item?.FileParseExitCode ?? '')).join(' ')
    : '';

  if (!process.env.OCR_API_KEY_2) return 'provider_configuration';
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

async function callOcrSpace(imageBase64, language) {
  const apiKey = cleanString(process.env.OCR_API_KEY_2, 512);
  if (!apiKey) throw new Error('provider_configuration');

  const form = new FormData();
  form.append('base64Image', normalizeBase64(imageBase64));
  form.append('language', cleanString(language, 10) || 'ara');
  form.append('OCREngine', '2');
  form.append('filetype', 'JPG');
  form.append('detectOrientation', 'true');
  form.append('scale', 'true');
  form.append('isOverlayRequired', 'false');

  let response;
  try {
    response = await fetch(process.env.OCR_SPACE_ENDPOINT || DEFAULT_OCR_ENDPOINT, {
      method: 'POST',
      headers: { apikey: apiKey },
      body: form,
    });
  } catch {
    throw new Error('provider_network');
  }
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload?.IsErroredOnProcessing || payload?.OCRExitCode === '3' || payload?.OCRExitCode === 4) {
    throw new Error(classifyProviderFailure(response.status, payload));
  }

  const extractedText = extractOcrText(payload);
  if (!extractedText) throw new Error('provider_empty_text');
  return extractedText;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return sendJson(res, 200, {
      success: true,
      service: 'C-OCR Vercel relay',
      status: 'ready',
      ocr_configured: Boolean(cleanString(process.env.OCR_API_KEY_2, 512)),
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { success: false, error: 'Method not allowed.' });
  }

  if (!isAuthorized(req)) {
    return sendJson(res, 401, { success: false, failure_stage: 'authentication', error: 'Unauthorized relay request.' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch {
    return sendJson(res, 400, { success: false, failure_stage: 'validation', error: 'Invalid JSON request.' });
  }
  const imageBase64 = cleanString(body.imageBase64 || body.image_base64 || body.base64Image, MAX_IMAGE_LENGTH);
  const language = cleanString(body.language, 10) || 'ara';
  const requestId = cleanString(body.request_id, 160);

  if (!imageBase64) {
    return sendJson(res, 400, { success: false, request_id: requestId, failure_stage: 'validation', error: 'Image is required.' });
  }
  if (imageBase64.length > MAX_IMAGE_LENGTH) {
    return sendJson(res, 413, { success: false, request_id: requestId, failure_stage: 'validation', error: 'Image is too large.' });
  }

  try {
    const extractedText = await callOcrSpace(imageBase64, language);
    return sendJson(res, 200, {
      success: true,
      request_id: requestId,
      provider_slot: 'ocr-2-vercel',
      extracted_text: extractedText,
    });
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : 'OCR provider request failed';
    return sendJson(res, 502, {
      success: false,
      request_id: requestId,
      provider_slot: 'ocr-2-vercel',
      failure_stage: 'ocr',
      error: 'The secondary OCR service failed.',
      failure_reason: failureReason.slice(0, 300),
    });
  }
}
