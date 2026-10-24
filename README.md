# Procurement System — Smart Multi-Branch Restaurant Procurement (Malaysia)

نظام إدارة مشتريات المطاعم متعددة الفروع: بوت Telegram + API + لوحة تحكم ثنائية اللغة (EN/AR + RTL) — **مونوليث بخدمة واحدة** على Koyeb (الحزمة أ المجانية $0/شهر) وفق التصميم المعتمد (`/design/`).

**Stack:** Node.js 22 (ESM) • Fastify • Knex (SQLite للاختبارات / Neon PostgreSQL للإنتاج — D-S3) • grammY • Gemini (mock/real) • Puppeteer headless-shell (C1) • SheetJS • Chart.js • SPA بدون build (D-S4).

---

## التشغيل السريع (محلي، كل شيء mocks — بلا أي مفاتيح)

```bash
npm install
npm run seed        # migrations + units + الفئات الخمس
npm start           # → http://localhost:8080  (/health → {"status":"ok"})
npm test            # 79 اختبارًا عبر 10 مجموعات (الحالات الـ28 من الوثيقة + حراس C1/C2/C3)
```

- أول فتح للـDashboard يعرض **Setup Wizard**: أنشئ حساب المالك → (اختياري) أدخل مفاتيح Telegram/Gemini/R2 مع زر **Test Connection** لكل خدمة → Finish. بلا مفاتيح يبقى النظام كامل الوظائف في وضع mock (`/dev/mock-telegram/*` لاختبار البوت).
- بلا `DATABASE_URL` يستخدم التطبيق SQLite محليًا في `data/app.db` (تطوير فقط). في الإنتاج: `DATABASE_URL` هو **متغير البيئة الوحيد** (D-S1 — انظر `DECISIONS.md`).

## النشر على Koyeb خطوة بخطوة

1. **Neon**: neon.com → New Project → Region: **Singapore** → انسخ الـ **pooled connection string**.
2. **Koyeb**: أنشئ Service من هذا المستودع (Dockerfile مرفق) → Instance: **Free** → Region: Frankfurt → أضف Environment Variable: `DATABASE_URL=<pooled-url>`.
3. بعد أول نشر: افتح `https://<app>.koyeb.app` → Setup Wizard → أنشئ المالك → أدخل مفاتيحك (انظر `KEYS.md` للقائمة الكاملة ومصادر كل مفتاح) → Finish.
4. **UptimeRobot** (مجاني): HTTP(s) monitor → `https://<app>.koyeb.app/health` كل 5 دقائق + بريد التنبيه. (C2: المسار بلا DB — 288 نداء/يوم بلا تأثير CU-h).
5. **Telegram**: @BotFather → /newbot → التوكن في الـWizard → أضف البوت لمجموعة فواتير لكل فرع ومجموعة الطلبات → اربطها من Dashboard (Branches + Users → pair code).
6. تحقق: `/health` 200 • فاتورة اصطناعية عبر المجموعة • تقرير PDF عربي من Reports.

> الشروط المقفلة المعمّقة في الكود: **C1** PDF عبر `headless:'shell'` + طابور تزامن=1 • **C2** `/health` بلا DB/AI/IO • **C3** سقوف AI + سلسلة تراجع 3.8→3.6→3.5-lite. المحفزات الرقابية: `research/limits-recheck-U0.md` + `design/README.md` §8.

## الملفات المرجعية

| ملف | المحتوى |
|---|---|
| `DECISIONS.md` | 17 قرارًا تنفيذيًا موثقًا (D-S1…D-S17) بمبرراتها |
| `KEYS.md` | قائمة المفاتيح المطلوبة + من أين تحصل على كل واحد |
| `docs/TEST-GUIDE.md` | كيف تشغّل الـ28 حالة + خريطة الحالة→الاختبار |
| `docs/DEPLOY-KOYEB.md` | دليل النشر المفصل + استكشاف الأخطاء |
| `docs/MIGRATION-VPS.md` | كيف تنتقل من Koyeb إلى VPS لاحقًا (§12.5) |
| `../design/` | حزمة التصميم المعتمدة (10 ملفات — المرجع المعماري) |

## بنة المشروع

```
src/
  server.js        # composition root: /health + API + static + webhook + jobs
  ai.js            # واجهة المزود + mock/Gemini + rate-limiter (C3)
  queue.js         # pending_ai_tasks: backoff → إعادة كل 2د → dead_letter (F4)
  telegram/        # intake (idempotency F1) + handlers (وضع صامت F2) + transport mock/real
  services/        # invoices (F3-F6) + matching (F7) + requests + prices + alerts
  db/migrations/   # 001_core.js (26 جدولًا + views + partial-unique) + 002_seed.js
  api/             # كل مسارات /api/v1 + حارس الصلاحيات على كل نداء
  backup.js        # pg_dump/JSON → AES-256-GCM → R2 + manifest (F13)
  pdf.js excel.js reports.js jobs.js settings.js permissions.js auth.js audit.js logging.js
dashboard/         # SPA ثنائية اللغة بلا build (12 شاشة) + Chart.js
test/              # 10 مجموعات — 79 اختبارًا
```
