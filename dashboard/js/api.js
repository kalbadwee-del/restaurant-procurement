// dashboard/js/api.js — fetch wrapper
export async function api(path, opts = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !path.startsWith('/auth')) { window.location.hash = '#/login'; throw new Error('unauthenticated'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data?.error?.message_en ?? `HTTP ${res.status}`); e.code = data?.error?.code; e.ar = data?.error?.message_ar; throw e; }
  return data;
}
