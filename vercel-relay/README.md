# C-OCR Vercel Relay

خدمة OCR ثانوية خاصة يستدعيها C-OCR فقط. لا تضع أي مفتاح داخل GitHub أو هذا المجلد.

## متغيرات Vercel السرية

أضفها من Project Settings → Environment Variables:

```text
OCR_API_KEY_2
C_OCR_RELAY_TOKEN
```

يمكن إضافة `OCR_SPACE_ENDPOINT` كمتغير عادي، لكن الكود يستخدم عنوان OCR.Space الرسمي افتراضيًا.

## نقطة الاتصال

بعد النشر، تكون الدالة على:

```text
https://your-vercel-project.vercel.app/api/ocr
```

يجب أن يستدعيها C-OCR فقط، مع إرسال الرأس:

```text
X-C-OCR-Relay-Token: نفس القيمة الموجودة في C_OCR_RELAY_TOKEN
```

الطلب يحتوي على `imageBase64` و`language` و`request_id` فقط. لا ترسل إلى Vercel الإجابة النموذجية أو بيانات DeepSeek؛ المقارنة تتم في C-OCR بعد استخراج النص.

## اختبار الصحة

```text
GET /api/ocr
```

يعيد حالة عامة فقط ولا يعرض قيمة المفتاح.
