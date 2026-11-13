export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
export class NetworkError extends Error { constructor(m = 'No internet connection or the server is unreachable.') { super(m); } }

export async function api(method, url, body, { timeout = 12000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body), signal: ctl.signal, credentials: 'same-origin' });
  } catch { throw new NetworkError(); } finally { clearTimeout(t); }
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('bm-unauthorized'));
    throw new ApiError(res.status, (data && data.error) || `Server error (${res.status})`);
  }
  return data;
}
export const get = (u) => api('GET', u);
export const post = (u, b) => api('POST', u, b ?? {});
export const put = (u, b) => api('PUT', u, b ?? {});
export const del = (u) => api('DELETE', u, {});
export const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
