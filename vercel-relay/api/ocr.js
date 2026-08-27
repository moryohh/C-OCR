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

async function callOcrSpace(imageBase64, language) {
  const apiKey = cleanString(process.env.OCR_API_KEY_2, 512);
  if (!apiKey) throw new Error('OCR relay is not configured');

  const form = new FormData();
  form.append('base64Image', normalizeBase64(imageBase64));
  form.append('language', cleanString(language, 10) || 'ara');
  form.append('OCREngine', '2');
  form.append('isOverlayRequired', 'false');

  const response = await fetch(process.env.OCR_SPACE_ENDPOINT || DEFAULT_OCR_ENDPOINT, {
    method: 'POST',
    headers: { apikey: apiKey },
    body: form,
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload?.IsErroredOnProcessing || payload?.OCRExitCode === '3' || payload?.OCRExitCode === 4) {
    throw new Error('OCR provider request failed');
  }

  const extractedText = extractOcrText(payload);
  if (!extractedText) throw new Error('No readable text was found');
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

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
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
  } catch {
    return sendJson(res, 502, {
      success: false,
      request_id: requestId,
      provider_slot: 'ocr-2-vercel',
      failure_stage: 'ocr',
      error: 'The secondary OCR service failed.',
    });
  }
}
