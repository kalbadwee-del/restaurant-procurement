# MIGRATION-VPS.md — الهجرة من Koyeb إلى VPS (§12.5)

النظام مصمم للنقل: SQL قياسي بلا ميزات مزود، تخزين عبر محول S3، AI عبر واجهة، PDF عبر محول.

## السيناريو أ: الإبقاء على Neon + نقل التطبيق فقط (الأسهل — 30 دقيقة)

1. VPS: ثبّت Docker → `docker compose up -d` مع نفس `DATABASE_URL`.
2. DNS: وجّه النطاق/النطاق الفرعي للـVPS (TLS عبر Caddy/Nginx).
3. حدّث `BASE_URL` → أعد حفظ إعدادات Telegram من Dashboard (إعادة تسجيل webhook بالضغط على Save في Settings/Services).
4. حدّث مراقب UptimeRobot للعنوان الجديد.
5. تحقق: `/health` + فاتورة تجريبية + تقرير PDF.

## السيناريو ب: مغادرة Neon أيضًا (PostgreSQL على الـVPS)

1. **أخذ نسخة**: Dashboard → Backup → Download (pg_dump custom مشفر). أو مباشرة: `pg_dump -Fc "$NEON_URL" -f pre.dump`.
2. VPS: `docker run postgres:16` → أنشئ قاعدة → `pg_restore -Fc -d procurement pre.dump` (عيّن `sslmode=disable` محليًا داخل الشبكة).
3. تحقق السلامة (نفس استعلامات §12.4): عدّادات الجداول مقابل manifest، مجاميع `approved_purchases` بالسنت، لا صفوف يتيمة:
   ```sql
   SELECT count(*) FROM approved_purchases;              -- قارن مع manifest.table_counts
   SELECT sum(line_total) FROM approved_purchases WHERE is_reversal = false;
   SELECT count(*) FROM invoices i LEFT JOIN branches b ON b.id=i.branch_id WHERE b.id IS NULL; -- = 0
   ```
4. حدّث `DATABASE_URL` للـVPS الجديد → أعد تشغيل التطبيق → الطابور يلتقط `pending_ai_tasks` تلقائيًا (§12.3).
5. **بعدها أعد تدوير الأسرار**: احذف المفاتيح من Dashboard وأعد إدخالها (مفتاح التشفير مشتق من DATABASE_URL — تغيّره يعني إعادة إدخال الأسرار — D-S1 موثق).
6. اجعل النسخ اليومي يرفع إلى R2 كما هو (لا تغيير) أو إلى قرص VPS + R2 معًا.

## السيناريو ج: VPS مع SQLite محلي (أصغر نشر)

- مدعوم: `DB_FILENAME=/data/app.db` بلا `DATABASE_URL` + حجم `procurement.json` مشفر عبر Dashboard → Import (confirm=REPLACE) → `restoreJsonInto` يعيد كل الجداول بمعرفاتها الأصلية.
- ملائم لجهاز واحد دائم؛ لا يوصى به للتشغيل الحرج (نسخ واحد) — وثّق قرارك.

## ما لا يتغير أبدًا

- مخطط القاعدة (SQL قياسي) • واجهة AI (تبديل المزود = إعدادات) • محول التخزين (R2 ↔ S3 آخر ↔ قرص) • قوالب PDF/Excel • كل منطق الأعمال.

## قائمة تحقق ما بعد الهجرة

- [ ] `/health` أخضر على العنوان الجديد
- [ ] تسجيل دخول Dashboard يعمل (الأسرار أُعيد إدخالها إذا تغير DATABASE_URL)
- [ ] webhook تيليجرام مسجل على النطاق الجديد (رسالة تجريبية تعالج فورًا)
- [ ] نسخة احتياطية يدوية جديدة تنجح وتُرفع
- [ ] `npm test` أخضر (يغطي نفس الكود)
- [ ] audit_log يظهر حدث الترحيل
