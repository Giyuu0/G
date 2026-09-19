# Atria Earning System — النسخة الأولى (MVP)

هذه أول نسخة فعلية قابلة للنشر الآن. تغطي حالياً:
- وكيل اكتشاف واحد يعمل بالكامل: مكافآت الكود على GitHub/Algora
- محرك تقييم (نفس قاعدة "الركود التنافسي" التي اتفقنا عليها)
- وكيل تنفيذ يصوغ حل الكود فعلياً عبر Atria، ويطلب مراجعتك قبل نشر أي PR (أمان أولي، يمكن تفعيل النشر التلقائي لاحقاً بعد ما تثق بالجودة)
- بوت تليجرام متصل بالكامل (إشعارات + أوامر `/scan` و`/status`)
- تشغيل تلقائي كل ساعة عبر Cron

باقي الفئات (الترجمة، منصات العروض، الهاكاثونات، المدونة، المنتجات الرقمية، وكيل الاستكشاف، الجودة، تحليل الفجوات) ستُضاف تباعاً على نفس الهيكل — هذا الأساس مصمم ليتوسع دون إعادة كتابة.

## خطوات التشغيل (يمكن إنجازها خلال ساعات)

### 1. المتطلبات
- حساب Cloudflare (مجاني)
- Node.js مثبت على جهازك أو أي بيئة طرفية (Termux على أندرويد يعمل)
- بوت تليجرام: أرسل `/newbot` لـ [@BotFather](https://t.me/BotFather) واحفظ الـ token
- معرف الدردشة (chat_id): أرسل أي رسالة للبوت بعد إنشائه، ثم افتح
  `https://api.telegram.org/bot<TOKEN>/getUpdates` وابحث عن `"chat":{"id":...}`
- مفتاح Atria API من `https://api.atria-asi.ai/console/keys`

### 2. التثبيت
```bash
npm install
npx wrangler login
```

### 3. إنشاء قاعدة البيانات
```bash
npx wrangler d1 create atria-earning-db
```
انسخ `database_id` من المخرجات، والصقه في `wrangler.toml` مكان
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

ثم أنشئ الجداول:
```bash
npm run db:init
```

### 4. تفعيل Workers AI (النموذج المجاني الاحتياطي)
في `wrangler.toml` أضف (إن لم يكن موجوداً تلقائياً):
```toml
[ai]
binding = "AI"
```

### 5. حفظ المفاتيح السرية (ثلاثة حسابات Atria)
```bash
npx wrangler secret put ATRIA_API_KEY_1
npx wrangler secret put ATRIA_API_KEY_2
npx wrangler secret put ATRIA_API_KEY_3
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put ADMIN_SECRET
```
(`GITHUB_TOKEN` اختياري، يرفع حد طلبات GitHub إن أردت لاحقاً)

بعد النشر (الخطوة التالية)، فعّل الرصيد الفعلي لكل حساب في قاعدة البيانات:
```bash
npx wrangler d1 execute atria-earning-db --remote --command \
  "UPDATE token_accounts SET total_tokens = 100000000 WHERE account_key = 'ATRIA_API_KEY_1';
   UPDATE token_accounts SET total_tokens = 100000000 WHERE account_key = 'ATRIA_API_KEY_2';
   UPDATE token_accounts SET total_tokens = 100000000 WHERE account_key = 'ATRIA_API_KEY_3';"
```
بدون هذه الخطوة، وكيل الخزينة يرفض كل الطلبات تلقائياً (حماية مقصودة ضد الصرف من رصيد غير مُهيَّأ).

### 6. النشر
```bash
npm run deploy
```
سيعطيك رابطاً مثل: `https://atria-earning-system.<your-subdomain>.workers.dev`

### 7. ربط بوت تليجرام بالووركر
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://atria-earning-system.<your-subdomain>.workers.dev/telegram/webhook"
```

### 8. اختبار فوري
أرسل `/scan` للبوت في تليجرام — يجب أن يبدأ البحث فوراً ويرسل لك أي مكافآت وُجدت.
أرسل `/balance` في أي وقت لمعرفة المتبقي من كل حساب من الحسابات الثلاثة.

## وكيل الخزينة (Token Treasury)
- كل وكيل تنفيذ يطلب إذناً من الخزينة قبل أي استدعاء لـAtria — لا استثناء
- فرصة عالية التقييم → سقف 4000 توكن، متوسطة → 1500، ضعيفة → رفض تلقائي بدون صرف
- الخزينة تختار تلقائياً الحساب الثلاثة الأقل استهلاكاً لكل طلب (يوازن الاستهلاك ويرفع سرعة المعالجة الكلية)
- إذا وصلت الحسابات الثلاثة لأقل من 5% من رصيدها، تتجمد كل التنفيذات تلقائياً ويصلك تنبيه عاجل

### 9. الفحص الدوري
لا حاجة لأي إجراء إضافي — Cron Trigger مضبوط مسبقاً ليعمل كل ساعة تلقائياً.

## ملاحظات أمان مهمة قبل التشغيل الفعلي
- النظام لا يفتح Pull Request تلقائياً حالياً — فقط يصوغ الحل ويرسله لك للمراجعة عبر D1/تليجرام. هذا مقصود حتى تراجع جودة أول عدة حلول بنفسك.
- لا يوجد ربط GitHub لفتح PR فعلي بعد — هذه الخطوة التالية بعد أن تتأكد من جودة المسودات.
- عدّل `SCORE_THRESHOLD_FOR_EXECUTION` في `src/index.js` حسب ما تراه من نتائج فعلية.
