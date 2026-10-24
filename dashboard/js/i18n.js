// dashboard/js/i18n.js — EN/AR with full RTL direction switch (per-user language, §10/§13)
const DICT = {
  brand: ['Procurement System', 'نظام المشتريات'],
  logout: ['Logout', 'خروج'],
  lang: ['العربية', 'English'],
  // nav
  summary: ['Summary', 'الملخص'], invoices: ['Invoices', 'الفواتير'], requests: ['Requests', 'الطلبات'],
  products: ['Products', 'المنتجات'], prices: ['Prices & Stores', 'الأسعار والمتاجر'], reports: ['Reports', 'التقارير'],
  users: ['Users', 'المستخدمون'], branches: ['Branches', 'الفروع'], ais: ['AI Settings', 'إعدادات AI'],
  logs: ['Logs', 'السجلات'], backup: ['Backup', 'النسخ الاحتياطي'], services: ['Services', 'الخدمات'],
  // common
  save: ['Save', 'حفظ'], add: ['Add', 'إضافة'], status: ['Status', 'الحالة'], branch: ['Branch', 'الفرع'],
  total: ['Total', 'الإجمالي'], date: ['Date', 'التاريخ'], actions: ['Actions', 'إجراءات'], approve: ['Approve', 'اعتماد'],
  reject: ['Reject', 'رفض'], retry: ['Retry', 'إعادة محاولة'], search: ['Search', 'بحث'], store: ['Store', 'المتجر'],
  product: ['Product', 'المنتج'], qty: ['Qty', 'الكمية'], price: ['Price', 'السعر'], items: ['Items', 'البنود'],
  // summary
  approvedExp: ['Approved expenses (period)', 'المصروفات المعتمدة (الفترة)'], openReq: ['Open requests', 'طلبات مفتوحة'],
  pendInv: ['Invoices pending', 'فواتير بانتظار'], aiQueue: ['AI queue (failed/dead)', 'طابور AI (فاشل/ميت)'],
  byBranch: ['Expenses by branch', 'المصروفات حسب الفرع'],
  // invoices
  flags: ['Flags', 'تنبيهات'], dup: ['Duplicate', 'مكرر'], disc: ['Discrepancy', 'فرق'], review: ['Review', 'مراجعة'],
  inReview: ['In review', 'قيد المراجعة'], approved: ['Approved', 'معتمدة'], draft: ['Draft', 'مسودة'], rejected: ['Rejected', 'مرفوضة'],
  needsReview: ['Needs review', 'بحاجة مراجعة'], confirm: ['Confirm', 'تأكيد'], correct: ['Correct', 'تصحيح'],
  discNote: ['Discrepancy explanation', 'تفسير الفرق'],
  // ai
  queue: ['Queue', 'الطابور'], taskType: ['Task', 'المهمة'], attempts: ['Attempts', 'محاولات'], lastErr: ['Last error', 'آخر خطأ'],
  usage: ['Usage today', 'استخدام اليوم'], provider: ['Provider', 'المزود'], caps: ['Caps', 'السقوف'],
  testConn: ['Test connection', 'اختبار الاتصال'],
  // login / wizard
  username: ['Username', 'اسم المستخدم'], password: ['Password', 'كلمة مرور'], login: ['Login', 'دخول'],
  wizardTitle: ['First-time setup', 'الإعداد الأول'], createOwner: ['Create owner account', 'إنشاء حساب المالك'],
  finish: ['Finish setup', 'إتمام الإعداد'], botToken: ['Telegram bot token', 'توكن بوت تيليجرام'],
  geminiKey: ['Gemini API key', 'مفتاح Gemini'], r2Acc: ['R2 account ID', 'معرف حساب R2'],
  r2Key: ['R2 access key ID', 'مفتاح وصول R2'], r2Secret: ['R2 secret', 'سر R2'], r2Bucket: ['R2 bucket', 'حاوية R2'],
  mockNote: ['Leave empty to keep mock mode', 'اتركه فارغاً للبقاء في وضع المحاكاة'],
};
export const state = { lang: localStorage.getItem('lang') ?? 'en' };
export function t(key) {
  const e = DICT[key];
  return e ? (state.lang === 'ar' ? e[1] : e[0]) : key;
}
export function applyDir(root = document) {
  const rtl = state.lang === 'ar';
  root.documentElement.lang = state.lang;
  root.documentElement.dir = rtl ? 'rtl' : 'ltr';
}
export function setLang(l) { state.lang = l; localStorage.setItem('lang', l); applyDir(); }
