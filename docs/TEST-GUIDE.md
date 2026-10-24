# TEST-GUIDE.md — كيف تشغّل حالات الاختبار الـ28 (§15 من وثيقة المتطلبات)

## التشغيل

```bash
npm test          # كل المجموعات (79 اختبارًا / ~20 ثانية، كله mocks محلية)
node --test test/u8_approval.test.js   # مجموعة واحدة فقط
```

- كل مجموعة تعمل على **SQLite مؤقت معزول** + مزودات mock (D-S7) — بلا شبكة، بلا مفاتيح، بلا بيانات حقيقية (§15: بيانات اصطناعية فقط).
- خروج أي اختبار أحمر = لا انتقال (قاعدة الجودة #6).

## خريطة الحالات الـ28 → الاختبارات

| # | الحالة (§15) | أين |
|---|---|---|
| 1 | تسجيل فاتورة صحيحة واعتمادها | `u8` full cycle + `u10` expenses sums |
| 2 | كشف فاتورة مكررة محتملة | `u7` duplicate detection (unique + date+total) |
| 3 | كشف فرق جمع البنود/الإجمالي | `u6` discrepancy flag (variant 0) + `u1` sen math |
| 4 | تصحيح بند برمز (B) | `u7` correction via symbol + version++ |
| 5 | رفض منتج شخصي (لا يدخل المصروفات) | `u8` category classification + approval gate |
| 6 | إضافة منتج جديد بعد الموافقة | `u8` new product created only AFTER approval + aliases |
| 7 | تعديل طلب سابق بزيادة | `u4` add 2 kg → 7 + modification history |
| 8 | شراء جزئي وبقاء المتبقي | `u8` 6 من 10 → remaining 4 open |
| 9 | فائض كبند مستقل | `u8` excess → is_excess ledger row |
| 10 | توحيد منتجات دون دمج مختلفة | Dashboard unify (فقط بقرار بشري) + `u7` ambiguous asks |
| 11 | سعر بلا شراء لا يدخل المصروفات | `u8` observed price isolation |
| 12 | عرض الأسعار القديمة بتواريخها | `u8` price history record_type + dates |
| 13 | حساب تكلفة الرحلة والادخار | `u8` trip savings net calculation |
| 14 | منع موظف من تقارير الإدارة | `u9` employee denied (403) |
| 15 | حماية روابط التقارير | `u9` link token+identity+expiry (401/403/410) |
| 16 | تصدير PDF/Excel عربي | `u10` AR-RTL template + real PDF render + xlsx RTL view |
| 17 | إنشاء نسخة واستعادتها | `u11` backup → verify → restore scratch |
| 18 | استعادة بعد فشل مزود AI | `u6` dead_letter → manual retry → done + `u11` restore |
| 19 | لا تكرار عند إعادة المحاولة (idempotency) | `u4` duplicate update_id exactly once |
| 20 | ترحيل DB لبيئة أخرى | `u11` restore-to-scratch + `docs/MIGRATION-VPS.md` |
| 21 | `/health` <1ms بلا DB | `u1` exact body + latency + code review (C2) |
| 22 | UR يمنع scale-to-zero | يدوي على Koyeb (لا محاكاة نوم محليًا) — خطوات في DEPLOY-KOYEB §5 |
| 23 | Webhook يستقبل والخدمة نشطة | `u4`/`u5` mock intake + real-mode secret check |
| 24 | محاكاة توقف 30د → استعادة الفائت | `u4` idempotency + `src/telegram/transport.js` recoverMissedUpdates (F14) — محاكاة كاملة تتطلب توكن حقيقي (دليل يدوي أدناه) |
| 25 | محاكاة 429/500: backoff → طابور → تعافٍ | `u6` failing provider → dead_letter → retry → done |
| 26 | فاتورة ملايوي/صيني: كشف + مطابقة + تطبيع | `u6`/`u7` detected_language + Lada Hitam → Black Pepper |
| 27 | اعتمادان متزامنان → 409 | `u8` exactly one 200 + one 409 + single ledger row |
| 28 | سجلات منظمة قابلة للاستعلام | `u11` audit trail + logs API + T-S5 redaction |

## حراس شروط الحزمة (أ) — إضافية ملزمة

| الاختبار | الحالة |
|---|---|
| T-C1a/b (`u10`) | طابور PDF تزامن=1 + مخرجات PDF سليمة عبر headless-shell حقيقي |
| T-C2a/b (`u1`) | `/health` حرفي `{"status":"ok"}` بلا DB (فحص كودي + زمن) |
| T-C3a/b/c (`u6`) | سقوف يومية عالمية/للمستخدم + burst + سلسلة التراجع النموذجية |
| T-S1…S6 (`u4`/`u9`/`u11`) | webhook secret، قفل تسجيل الدخول، إبطال فوري، روابط، الحمر في السجلات، صلاحيات مباشرة |

## الحالات اليدوية الوحيدة (تتطلب بيئة حقيقية بعد النشر)

- **T22/T23/T24**: مراقبة keep-alive 2+ ساعات واستعادة الفائت — بمجرد النشر: أوقف الخدمة 30 دقيقة من لوحة Koyeb → أرسل رسالة للبوت → شغّل → تحقق من المعالجة (`docs/DEPLOY-KOYEB.md` §6).
- **جودة استخراج Gemini الفعلية**: بعد إدخال المفتاح في الـWizard — جرّب الفواتير الاصطناعية من `scripts/task3/invoices/` على المجموعة وراقب `ai_call_logs` والرموز (A)(B)(C).
