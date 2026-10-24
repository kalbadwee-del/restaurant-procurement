// src/telegram/i18n.js — bilingual EN/AR message catalog (Q3: groups always bilingual, private follows user language)
export const MESSAGES = {
  started: { en: 'Welcome! Send purchase requests here. I will record them.', ar: 'أهلاً بك! أرسل طلبات الشراء هنا وسأسجلها.' },
  help: { en: 'Commands:\n/ready — finish invoice entry\n/requests — open requests\n/list — latest invoices\n/help — this help', ar: 'الأوامر:\n/ready — إنهاء إدخال الفاتورة\n/requests — الطلبات المفتوحة\n/list — آخر الفواتير\n/help — المساعدة' },
  invoice_received: { en: 'Received — processing. I will notify you when ready.', ar: 'تم الاستلام — جارٍ المعالجة. سأخبرك عند الجهوزية.' },
  invoice_more: { en: 'Added to the current invoice draft. Send /ready when done.', ar: 'أُضيف إلى مسودة الفاتورة الحالية. أرسل /ready عند الانتهاء.' },
  invoice_new_draft: { en: 'Started a NEW invoice draft (a different file/number was detected). Previous draft kept separate.', ar: 'بدأت مسودة فاتورة جديدة (اكتُشف ملف/رقم مختلف). المسودة السابقة منفصلة.' },
  invoice_ready: { en: 'Preparing the review summary…', ar: 'جارٍ إعداد ملخص المراجعة…' },
  session_closed_idle: { en: 'Invoice entry closed after inactivity. Send the invoice again if needed.', ar: 'أُغلق إدخال الفاتورة بعد الخمول. أعد الإرسال إذا لزم.' },
  unverified: { en: 'I could not verify your identity. Please register or contact your manager.', ar: 'لم أتمكن من التحقق من هويتك. يرجى التسجيل أو التواصل مع مديرك.' },
  not_invoice_group: { en: 'This group is not configured for invoices.', ar: 'هذه المجموعة غير مهيأة لاستقبال الفواتير.' },
  request_recorded: { en: 'Request recorded: {product} {qty} {unit}.', ar: 'سُجل الطلب: {product} {qty} {unit}.' },
  request_modified: { en: 'Request updated: {product} now {qty} {unit} (was {old}).', ar: 'حُدث الطلب: {product} الآن {qty} {unit} (كان {old}).' },
  request_ambiguous: { en: 'I could not tell which request you mean. Please mention the product name.', ar: 'لم أستطع تحديد الطلب المقصود. يرجى ذكر اسم المنتج.' },
  correction_applied: { en: 'Correction applied to ({symbol}): {field} = {value}. Confirm with "confirm {symbol}".', ar: 'طُبق التصحيح على ({symbol}): {field} = {value}. أكد بـ "confirm {symbol}".' },
  correction_ambiguous: { en: 'Ambiguous correction — please specify item symbol (A), (B)… and the new value.', ar: 'تصحيح غامض — حدد رمز البند (A)، (B)… والقيمة الجديدة.' },
  duplicate_warning: { en: '⚠ Potential duplicate of invoice #{no} — review before approval.', ar: '⚠ فاتورة مكررة محتملة رقم #{no} — راجع قبل الاعتماد.' },
  ai_busy: { en: 'Processing your invoice, will notify you when ready.', ar: 'نعالج فاتورتك، وسنخبرك عند الجهوزية.' },
  denied: { en: 'You are not allowed to do this.', ar: 'لا تملك صلاحية لذلك.' },
  pair_ok: { en: 'Account linked. Welcome, {name}!', ar: 'تم ربط الحساب. أهلاً {name}!' },
  pair_code_invalid: { en: 'Pairing code invalid. Generate a new one from the Dashboard.', ar: 'رمز الاقتران غير صالح. أنشئ رمزاً جديداً من لوحة التحكم.' },
  manager_notify_dead: { en: 'AI task #{id} moved to dead-letter after {n} attempts. Manual retry available in Dashboard.', ar: 'مهمة AI #{id} انتقلت للقائمة الميتة بعد {n} محاولة. إعادة المحاولة اليدوية متاحة في اللوحة.' },
};

export function t(msg, lang = 'en', vars = {}) {
  const base = typeof msg === 'string' ? (MESSAGES[msg] ?? { en: msg, ar: msg }) : msg;
  let out = (lang === 'ar' ? base.ar : base.en) ?? base.en;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}
// Group messages: bilingual one-liner (Q3 decision)
export function tg(msg, vars = {}) { return `${t(msg, 'en', vars)}\n${t(msg, 'ar', vars)}`; }
