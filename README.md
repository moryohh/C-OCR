# C OCR

بوابة مستقلة لمعالجة صور الإجابات من موقع A. تستقبل الطلب، تختار واحدًا من مفتاحي OCR.Space بالتناوب، تنتقل إلى المفتاح الآخر عند فشل OCR الحقيقي، ثم تستخدم DeepSeek لتقييم الإجابة ومقارنتها بالسؤال والإجابة النموذجية.

## المسار

```text
موقع A → C OCR Worker → OCR.Space
                         ↓
                      DeepSeek
```

موقع B-Community خارج هذا المشروع تمامًا.

## أسرار الخادم

لا تضع القيم السرية في GitHub أو في `public/index.html` أو في موقع A. في وضع التوزيع بين Cloudflare وVercel، أضف في Cloudflare Worker Secrets:

```text
OCR_API_KEY_1
OCR_RELAY_TOKEN
DEEPSEEK_API_KEY
AUTH_SUPABASE_A_URL
AUTH_SUPABASE_A_ANON_KEY
```

وأضف في مشروع Vercel الثانوي:

```text
OCR_API_KEY_2
C_OCR_RELAY_TOKEN
```

يجب أن تكون قيمة `C_OCR_RELAY_TOKEN` متطابقة في Cloudflare وVercel، لكنها لا تُكتب في GitHub أو الواجهة. لا تضف `OCR_API_KEY_2` في Cloudflare عند تفعيل مسار Vercel؛ يحتفظ بها Vercel فقط.

يُستخدم `AUTH_SUPABASE_A_URL` و`AUTH_SUPABASE_A_ANON_KEY` للتحقق من توكن جلسة Supabase المرسل من موقع A. لا يُعاد أي مفتاح في استجابة API.

في Cloudflare أضف كذلك متغيرًا نصيًا غير سري باسم `OCR_RELAY_URL` وقيمته رابط Function الخاصة بـVercel:

```text
https://your-vercel-project.vercel.app/api/ocr
```

يمكن ضبط:

```text
DEEPSEEK_MODEL=deepseek-chat
OCR_DAILY_LIMIT=500
```

## خدمة Vercel الثانوية

المجلد `vercel-relay/` هو خدمة منفصلة تُنشر من نفس المستودع مع ضبط **Root Directory** في Vercel على `vercel-relay`. تنفذ `api/ocr.js` استخراج النص فقط بالمفتاح الثاني، ولا تستقبل الإجابة النموذجية أو بيانات DeepSeek.

يجب أن تكون الدالة محمية بـ`C_OCR_RELAY_TOKEN`، حتى لا يستطيع زائر عادي استخدامها. بعد نشرها استخدم مسارها في Cloudflare كقيمة `OCR_RELAY_URL`.

## التشغيل المحلي

```bash
npm install
npm run typecheck
npm run dev
```

## النشر

يتطلب النشر ربط حساب Cloudflare بمشروع GitHub وإضافة أسرار GitHub التالية:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

يُفضل أن يكون رمز Cloudflare محدود الصلاحية إلى Workers Scripts: Edit للحساب المحدد فقط. بعد النشر، أضف أسرار OCR وDeepSeek من Cloudflare Dashboard، وليس من ملف GitHub.

## الواجهات

- `GET /api/health`: حالة الخدمة وعدد خانات OCR المهيأة، دون قيم سرية.
- `POST /api/v1/ocr/process`: المعالجة الأساسية المتوافقة مع عقد موقع A.
- `POST /api/ocr/process`: مسار مختصر متوافق.
- `GET /api/admin/activity`: آخر نشاط مختصر دون الصور أو المفاتيح أو عنوان IP الخام.
- `GET /api/admin/status`: حالة المفاتيح وعدد العمليات الأخيرة دون القيم.

## الحماية

تُحذف الترويسات التي قد تعرّف موقع A قبل طلب OCR، ولا تُحفظ الصور في سجل النشاط. يُستخدم محدد طلبات مؤقت ببصمة غير قابلة للعكس بدل حفظ عنوان IP الخام. في وضع التوزيع الجديد، كل صورة تستخدم مسار Cloudflare أو مسار Vercel، ولا تتم تجربة المسار الآخر إلا عند فشل الأول. يجب عدم استخدام المسار الثانوي لإخفاء استخدام غير مصرح أو لتجاوز حدود مزود OCR.Space.

## ملاحظة عن الخطة المجانية

يمكن استخدام Cloudflare Workers Free ضمن حدوده الحالية، لكن حدود الطلبات والاستخدام قد تتغير. يجب متابعة لوحة Cloudflare، وعدم استخدام مفتاحي OCR لتجاوز شروط مزود OCR.Space أو حدود حساباته.
