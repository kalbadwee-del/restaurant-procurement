# DEPLOY-KOYEB.md — دليل النشر المفصل على Koyeb (الحزمة أ — $0/شهر)

## 1. المتطلبات التمهيدية (قرارات المالك المعتمدة)

| الخدمة | الإجراء | ملاحظة |
|---|---|---|
| Neon | حساب → New Project → **Singapore** → pooled connection string | مجاني بلا بطاقة |
| Cloudflare R2 | تفعيل (**بطاقة** — قرار معتمد، لا خصم ضمن الحصة) → bucket خاص → API Token (Object Read & Write) | تُدخل في الـWizard |
| Gemini | aistudio.google.com → API key (مجاني بلا بطاقة) | مقيد تلقائيًا بـ Generative Language API |
| Telegram | @BotFather → /newbot → التوكن | أضف البوت للمجموعات بعد النشر |
| UptimeRobot | حساب مجاني + بريد التنبيهات | يُضبط بعد أول نشر |

## 2. النشر

1. ارفع المستودع إلى GitHub (خاص).
2. Koyeb → **Create Service** → GitHub → اختر المستودع → Builder: **Dockerfile**.
3. Instance: **Free** (0.1 vCPU / 512MB) → Region: **Frankfurt** → Port: `8080`.
4. Environment Variables: `DATABASE_URL` فقط (pooled Neon). اختياري: `BASE_URL` (يُسجل الـwebhook تلقائيًا في الوضع الحقيقي)، `NODE_ENV=production`.
5. Deploy — البناء الأول ~3-5 دقائق (تنزيل chrome-headless-shell).

## 3. الإعداد الأول (Setup Wizard)

1. افتح `https://<app>.koyeb.app` → الـWizard يظهر تلقائيًا (D-S16: يقفل بعد إنشاء المالك).
2. أنشئ حساب المالك (اسم مستخدم + كلمة مرور 8+).
3. لكل خدمة (Telegram/Gemini/R2): أدخل المفتاح → **Test Connection** → أخضر = أكمل.
4. Finish — يُخزن كل شيء مشفرًا AES-256-GCM في القاعدة، ويتحول النظام من mock للوضع الحقيقي تلقائيًا لكل خدمة أدخلت مفتاحها.

## 4. ربط المجموعات والمستخدمين

1. Dashboard → Branches: أضف فروعك.
2. أنشئ مجموعة Telegram لفواتير كل فرع + مجموعة طلبات مشتركة → أضف البوت فيها.
3. Dashboard → Users: أضف المستخدمين → زر **pair** لكل واحد → المستخدم يرسل `PAIR <code>` للبوت في خاص.
4. Dashboard: اربط كل مجموعة فواتير بفرعها (سكربت إعداد المجموعات أو عبر قاعدة البيانات مباشرة — جدول `telegram_groups`).

## 5. UptimeRobot (إلزامي — §2.1)

1. Add Monitor → HTTP(s) → `https://<app>.koyeb.app/health` → Interval: 5 دقائق.
2. Alert: أضف بريدك — تنبيه بعد فشل دورة واحدة.
3. موصى به: مراقب ثانٍ على `https://<app>.koyeb.app/` لتمييز انقطاع الخدمة عن انقطاع المسار.
4. تحقق بعد ساعتين من الخمول: لا cold start (T22).

## 6. التحقق النهائي بعد النشر (Go-Live)

- [ ] `/health` يعيد `{"status":"ok"}` حرفيًا
- [ ] فاتورة اصطناعية (`scripts/task3/invoices/`) عبر مجموعة الفواتير → استخراج → رموز (A)(B)(C) → تصحيح → اعتماد
- [ ] طلب من مجموعة الطلبات → تجميع → مطابقة
- [ ] تقرير PDF عربي من Dashboard → رابط مؤقت يعمل
- [ ] نسخة احتياطية من Dashboard → تنزيل → sha256 مطابق
- [ ] إيقاف 30 دقيقة من لوحة Koyeb → رسالة تيليجرام → تشغيل → التحديث الفائت عولج (T24)
- [ ] `npm test` أخضر محليًا على نفس الكود (79/79)

## 7. استكشاف الأخطاء

| العرض | السبب المحتمل | الحل |
|---|---|---|
| `DATABASE_URL is required in production` | متغير البيئة ناقص | أضف `DATABASE_URL` في Koyeb → Redeploy |
| Dashboard يفتح الـWizard من جديد | يخص النشر الأول فقط — بعد إنشاء المالك يقفل | — |
| فشل بناء puppeteer | شبكة النشر | يعيد Koyeb المحاولة تلقائيًا؛ تأكد Dockerfile لم يتغير |
| البوت صامت | الوضع mock أو webhook غير مسجل | Services → Test Telegram → تأكد `BASE_URL` مضبوط ثم أعد حفظ الإعدادات |
| PDF بطيء (12-25ث) | طبيعي على 0.1 vCPU (مقاس في POC) | محفز الترقية (ب) عند p95>30s لأسبوع — `design/README.md` §8 |
| 429 متكرر من Gemini | سقوف مجانية لكل مشروع | Dashboard → AI Settings → خفض السقوف؛ التراجع التلقائي 3.8→3.6→3.5-lite يعمل |
| CU-h مرتفع | تحقق: لا شيء يلمس DB من `/health` (مقفل كوديًا) | راجع Neon dashboard — التذكير الشهري يصل أول كل شهر |

## 8. المراجعة الدورية (قرار المالك: بعد شهرين)

- راجع المحفزات: `design/README.md` §8 (OOM/PDF p95/عدد الفواتير → الحزمة ب).
- راجع استخدام AI في Dashboard → AI Settings (نسبة السقف).
- دريل الاستعادة الشهري: `docs/TEST-GUIDE.md` + Dashboard → Backup → Import (تحقق فقط دون REPLACE).
