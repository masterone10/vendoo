/**
 * Safe fetch helper that ensures responses are JSON before parsing,
 * preventing SyntaxError ("Unexpected token <") when proxies/gateways return HTML.
 */
export async function safeFetchJson<T = any>(
  url: string,
  options?: RequestInit
): Promise<{ ok: boolean; data: T | null; status: number; error?: string }> {
  try {
    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';

    if (res.ok && contentType.includes('application/json')) {
      const data = await res.json();
      return { ok: true, data, status: res.status };
    }

    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      if (contentType.includes('application/json')) {
        try {
          const errData = await res.json();
          errMsg = errData.error || errData.message || errMsg;
        } catch {}
      }
      return { ok: false, data: null, status: res.status, error: errMsg };
    }

    // Response was OK (200) but not JSON (e.g. HTML gateway page during startup/reconnect)
    return {
      ok: false,
      data: null,
      status: res.status,
      error: 'Non-JSON response received',
    };
  } catch (err: any) {
    return { ok: false, data: null, status: 0, error: err?.message || 'Network error' };
  }
}
