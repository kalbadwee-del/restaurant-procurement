// src/permissions.js — role/action matrix (design/06 §2), server-side on EVERY call (§13).
export const ROLES = ['owner', 'operations_manager', 'accountant', 'central_purchaser', 'branch_manager', 'employee'];
export const ACTIONS = {
  SUBMIT_REQUEST: 'request.submit',
  SUBMIT_INVOICE: 'invoice.submit',
  CORRECT_INVOICE: 'invoice.correct',
  APPROVE_INVOICE: 'invoice.approve',
  AMEND_APPROVED: 'invoice.amend',
  MANAGE_PRODUCTS: 'products.manage',
  RECORD_OBSERVED_PRICE: 'prices.observed',
  MANAGE_TRIPS: 'trips.manage',
  VIEW_REPORTS: 'reports.view',
  EXPORT_REPORTS: 'reports.export',
  MANAGE_USERS: 'users.manage',
  MANAGE_BRANCHES: 'branches.manage',
  MANAGE_AI: 'ai.manage',
  VIEW_LOGS: 'logs.view',
  BACKUP: 'backup.manage',
  VIEW_SUMMARY: 'summary.view',
};

const ALL = ROLES.slice(0, 5); // owner..branch_manager (not employee)
const MGMT = ['owner', 'operations_manager'];
const FIN = ['owner', 'accountant'];

// action -> roles allowed; branch-scoped actions see scope rules below
export const MATRIX = {
  [ACTIONS.SUBMIT_REQUEST]: ROLES,
  [ACTIONS.SUBMIT_INVOICE]: ALL,
  [ACTIONS.CORRECT_INVOICE]: ['owner', 'operations_manager', 'accountant', 'branch_manager'],
  [ACTIONS.APPROVE_INVOICE]: ['owner', 'operations_manager', 'accountant', 'branch_manager'],
  [ACTIONS.AMEND_APPROVED]: FIN, // Q2 decision: accountant/owner only
  [ACTIONS.MANAGE_PRODUCTS]: ['owner', 'operations_manager', 'accountant', 'central_purchaser'],
  [ACTIONS.RECORD_OBSERVED_PRICE]: ALL,
  [ACTIONS.MANAGE_TRIPS]: ['owner', 'operations_manager', 'central_purchaser'],
  [ACTIONS.VIEW_REPORTS]: [...ALL],
  [ACTIONS.EXPORT_REPORTS]: ALL,
  [ACTIONS.MANAGE_USERS]: MGMT,
  [ACTIONS.MANAGE_BRANCHES]: MGMT,
  [ACTIONS.MANAGE_AI]: MGMT,
  [ACTIONS.VIEW_LOGS]: MGMT,
  [ACTIONS.BACKUP]: ['owner'],
  [ACTIONS.VIEW_SUMMARY]: [...ALL],
};

// Scope: which branches a user may act on. null = all branches.
export function branchScope(user) {
  if (user.role === 'branch_manager' || user.role === 'employee') return user.branch_id ? [user.branch_id] : [];
  return null; // all
}
export function inScope(user, branchId) {
  const scope = branchScope(user);
  if (scope === null) return true;
  return scope.includes(Number(branchId));
}

export function effectivePermissions(user) {
  const base = Object.keys(MATRIX).filter((a) => MATRIX[a].includes(user.role));
  const overrides = user.permissions_override && typeof user.permissions_override === 'object' ? user.permissions_override : {};
  const granted = new Set(base);
  for (const [action, allow] of Object.entries(overrides)) {
    if (allow === true) granted.add(action);
    else if (allow === false) granted.delete(action);
  }
  return granted;
}

export function can(user, action) {
  return effectivePermissions(user).has(action);
}

export function permissionCheck(user, action, { branchId = null } = {}) {
  if (!user || !user.is_active) return { ok: false, reason: 'inactive' };
  if (!can(user, action)) return { ok: false, reason: 'forbidden' };
  if (branchId !== null && !inScope(user, branchId)) return { ok: false, reason: 'out_of_scope' };
  return { ok: true };
}
