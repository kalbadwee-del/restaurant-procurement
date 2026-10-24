# KEYS.md — المفاتيح والموارد المطلوبة (تُدخل عند النشر)

## 1. متغير بيئة واحد (المرساة الإجبارية — D-S1 في DECISIONS.md)

| المتغير | أين | القيمة |
|---|---|---|
| `DATABASE_URL` | Koyeb → Service → Settings → Environment Variables (أو docker-compose) | سلسلة اتصال **Neon pooled** بمشروعك (منطقة سنغافورة): `postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require` |

> لماذا هذا الوحيد؟ كل الأسرار تُخزن مشفرة **داخل** القاعدة — فيجب معرفة عنوان القاعدة قبل قراءة أي سر. لا يوجد ملف .env في المشروع إطلاقًا.

## 2. ما تُدخله في Setup Wizard (أول فتح للـ Dashboard)

| # | الحقل | من أين تحصل عليه | إلزامي؟ |
|---|---|---|---|
| 1 | حساب المالك الأول (username + password) | تختاره أنت | ✅ |
| 2 | **Telegram Bot Token** | @BotFather → /newbot | ✅ للوضع الحقيقي |
| 3 | **Telegram Webhook Secret** | أي نص عشوائي قوي — الزر يولّده لك | ✅ (يولَّد تلقائيًا) |
| 4 | **Gemini API Key** | aistudio.google.com → Get API key (مقيد تلقائيًا بـ Generative Language API) | اختياري — بدونه يبقى مزود AI = mock |
| 5 | **R2**: Account ID + Access Key ID + Secret + Bucket | Cloudflare → R2 → Manage API Tokens (نطاق Object Read & Write) + إنشاء bucket خاص | اختياري — بدونه التخزين = mock في `/tmp/local-storage` |
| 6 | حدود AI (سقوف C3) | قيم مقترحة معبأة: global 120/يوم، per-user 20/يوم، burst 10/دقيقة، تحذير 80% | ✅ (افتراضيات جاهزة) |

## 3. خطوات إنشاء الموارد (مرة واحدة — تخص المالك)

1. **Neon**: neon.com → New Project → Region: **Singapore** → انسخ الـ **pooled connection string**.
2. **Telegram**: @BotFather → /newbot → احفظ التوكن → أضف البوت لمجموعة كل فرع ومجموعة الطلبات (صلاحيات إرسال رسائل).
3. **Gemini**: aistudio.google.com → API key (مجاني، بلا بطاقة).
4. **R2**: يتطلب إضافة **بطاقة** عند تفعيل R2 (قرار معتمد 2026-10-24 — بلا خصم ضمن الحصة) → Create bucket (خاص) → Create API Token (Object Read & Write).
5. **UptimeRobot**: حساب مجاني → Add Monitor: HTTP(s) → `https://<your-app>.koyeb.app/health` كل 5 دقائق + بريد التنبيه (بعد أول نشر).
6. **Koyeb**: حساب → Create Service من GitHub/Docker → أضف `DATABASE_URL` → Instance: **Free** → Region: Frankfurt.

## 4. ما يولَّد تلقائيًا ويُخزن مشفرًا (لا تدخله يدويًا)

`jwt_secret` • `backup_encryption_key` — يُنشآن عند إتمام الـwizard ويُخزنان AES-256-GCM في `app_secrets`.

## 5. استبدال mock بالوضع الحقيقي لاحقًا

Dashboard → Settings/Services → لكل خدمة (Telegram/Gemini/R2): أدخل المفتاح → **Test Connection** → فعّل الوضع الحقيقي → Save. البديل mock يبقى متاحًا للاختبار في أي وقت.
