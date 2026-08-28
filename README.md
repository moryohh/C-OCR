# C OCR

بوابة مستقلة لاستخراج النص من صور الإجابات القادمة من موقع A. يدير C مسارين فقط: `api_ocr1` بمفتاح OCR الأول داخل Cloudflare، و`api_ocr2` عبر Vercel بمفتاح OCR الثاني. يوزّع C الطلبات بالتناوب بين المسارين، ولا يوجد مسار أساسي ثابت. عند فشل المسار الذي اختاره الطلب، ينتقل الطلب نفسه إلى المسار الآخر، ثم يعيد النص المستخرج إلى A. لا ينفذ C تقييمًا أو مقارنة أو اتصالًا بـDeepSeek.

## المسار

```text
موقع A → C OCR Worker على Cloudflare
              ├─ api_ocr1 → OCR.Space بالمفتاح الأول
              └─ api_ocr2 → Vercel Relay → OCR.Space بالمفتاح الثاني
                         ↓
                 extracted_text إلى A
```

موقع B-Community خارج هذا المشروع تمامًا.

## أسرار الخادم

لا تضع القيم السرية في GitHub أو في `public/index.html` أو في موقع A. في وضع التوزيع بين Cloudflare وVercel، أضف في Cloudflare Worker Secrets:

```text
OCR_API_KEY_1
OCR_RELAY_TOKEN
AUTH_SUPABASE_A_URL
AUTH_SUPABASE_A_ANON_KEY
```

وأضف في مشروع Vercel الثانوي:

```text
OCR_API_KEY_2
C_OCR_RELAY_TOKEN
```

يجب أن تكون قيمة `C_OCR_RELAY_TOKEN` متطابقة في Cloudflare وVercel، لكنها لا تُكتب في GitHub أو الواجهة. لا تضف `OCR_API_KEY_2` في Cloudflare عند تفعيل مسار Vercel؛ يحتفظ بها Vercel فقط.

تُستخدم قيم Supabase فقط لحماية واجهات الإدارة إن لزم الأمر، وليس شرطًا لطلب OCR العام القادم من A. لا يُعاد أي مفتاح في استجابة API.

في Cloudflare أضف كذلك متغيرًا نصيًا غير سري باسم `OCR_RELAY_URL` وقيمته رابط Function الخاصة بـVercel:

```text
https://your-vercel-project.vercel.app/api/ocr
```

يمكن ضبط:

```text
OCR_DAILY_LIMIT=500
OCR_DISTRIBUTION=round_robin
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

يُفضل أن يكون رمز Cloudflare محدود الصلاحية إلى Workers Scripts: Edit للحساب المحدد فقط. بعد النشر، أضف `OCR_API_KEY_1` و`OCR_RELAY_TOKEN` من Cloudflare Dashboard، وليس من ملف GitHub.

## الواجهات

- `GET /api/health`: حالة الخدمة وعدد خانات OCR المهيأة، دون قيم سرية.
- `POST /api/v1/ocr/process`: المعالجة الأساسية المتوافقة مع عقد موقع A.
- `POST /api/ocr/process`: مسار مختصر متوافق.
- `GET /api/admin/activity`: آخر نشاط مختصر دون الصور أو المفاتيح أو عنوان IP الخام.
- `GET /api/admin/status`: حالة المفاتيح وعدد العمليات الأخيرة دون القيم.

## الحماية

تُحذف الترويسات التي قد تعرّف موقع A قبل طلب OCR، ولا تُحفظ الصور في سجل النشاط. يُستخدم محدد طلبات مؤقت ببصمة غير قابلة للعكس بدل حفظ عنوان IP الخام. C هو المدير الوحيد للمسارين: api_ocr1 داخل Cloudflare وapi_ocr2 عبر Vercel. يوزّع الطلبات بالتناوب بينهما، ولا تتم تجربة المسار الآخر إلا عند فشل المسار الذي اختاره الطلب. يجب عدم استخدام المسار الثانوي لتجاوز حدود مزود OCR.Space.

## ملاحظة عن الخطة المجانية

يمكن استخدام Cloudflare Workers Free ضمن حدوده الحالية، لكن حدود الطلبات والاستخدام قد تتغير. يجب متابعة لوحة Cloudflare، وعدم استخدام مفتاحي OCR لتجاوز شروط مزود OCR.Space أو حدود حساباته.
