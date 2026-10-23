import dotenv from 'dotenv';
dotenv.config({ override: true });

export interface VendoorRawProduct {
  id: number;
  name: string;
  image_path?: string;
  pivot?: {
    order_id: number;
    product_id: number;
    quantity: number;
    size?: string;
    code?: string;
    price?: string;
    color?: string;
    commission?: number;
    pay_vendor?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface VendoorRawOrder {
  id: number;
  order_no: string | null;
  integration_shipping_name: string | null;
  order_type: string;
  created_at: string;
  chipping?: string;
  shipping_date?: string | null;
  printed_date?: string | null;
  affiliate_code: string;
  random_number: string;
  affiliate_name: string;
  full_name: string;
  total_price: number;
  shipping_cost: string;
  phone: string;
  governrate_name: string;
  address: string;
  total_order: string;
  status: string; // HTML button string with text e.g. " New", " Pending", " Printed"
  products?: VendoorRawProduct[];
  affiliate_id?: number;
  [key: string]: any;
}

export interface ParsedCustomerHistory {
  phone: string;
  totalOrders: number | null;
  deliveriesNum: number | null;
  deliveriesDenom: number | null;
  deliveryRate: number | null;
  cancelsNum: number | null;
  cancelsDenom: number | null;
  cancelRate: number | null;
  repetitionsCount: number | null;
  lastOrderStatus: string | null;
  lastOrderElapsed: string | null;
  warningText: string | null;
  rawProDetailsHtml?: string;
}

export interface ConfirmationRow {
  invoiceNo: string;
  orderType: string;
  printedDate: string;
  affiliateCode: string;
  randomNumber: string;
  affiliateName: string;
  customerName: string;
  phone: string;
  governorate: string;
  address: string;
  totalOrder: number;
  status: string;
}

export interface LogEntry {
  index: number;
  orderCode: string;
  actorName: string;
  rawActionText: string;
  eventTimestamp: string;
  vendoorOrderId?: number | null;
  orderHref?: string | null;
  rawHtml?: string | null;
}

class VendoorClient {
  private cookieMap: Map<string, string> = new Map();
  private isAuthenticated = false;
  private lastLoginTime = 0;
  private readonly baseUrl = 'https://aff.ven-door.com';
  private readonly userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  public isConfigured(): boolean {
    const em = process.env.VENDOOR_EMAIL;
    const pw = process.env.VENDOOR_PASSWORD;
    return Boolean(em && em.trim().length > 0 && pw && pw.trim().length > 0);
  }

  private get email(): string {
    const em = process.env.VENDOOR_EMAIL;
    if (!em || !em.trim()) {
      throw new Error('VENDOOR_EMAIL environment variable is not defined.');
    }
    return em.trim();
  }

  private get password(): string {
    const pw = process.env.VENDOOR_PASSWORD;
    if (!pw || !pw.trim()) {
      throw new Error('VENDOOR_PASSWORD environment variable is not defined.');
    }
    return pw.trim();
  }

  private getCookieHeader(): string {
    return Array.from(this.cookieMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private updateCookies(res: Response): void {
    const sc = typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : (res.headers.get('set-cookie') || '').split(/,(?=\s*[a-zA-Z0-9_-]+=)/);

    for (const c of sc) {
      if (!c) continue;
      const parts = c.split(';')[0].trim().split('=');
      if (parts[0]) {
        this.cookieMap.set(parts[0], parts.slice(1).join('='));
      }
    }
  }

  private async fetchWithTimeout(url: string | URL, options: RequestInit = {}, timeoutMs = 25000): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        ...options,
        signal: controller.signal,
      });
      return res;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async fetchWithRetry(
    url: string | URL,
    options: RequestInit = {},
    timeoutMs = 25000,
    maxRetries = 3
  ): Promise<Response> {
    let lastError: any = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.fetchWithTimeout(url, options, timeoutMs);
        this.updateCookies(res);

        // Re-authenticate if session expired or redirect to login (only for non-login endpoints)
        const urlStr = url.toString();
        const isLoginRequest = urlStr.includes('/login');
        if (
          !isLoginRequest &&
          (res.status === 401 ||
           res.status === 419 ||
           (res.url && res.url.includes('/login')))
        ) {
          if (attempt < maxRetries) {
            this.isAuthenticated = false;
            await this.login();
            const headers = new Headers(options.headers || {});
            headers.set('Cookie', this.getCookieHeader());
            options = { ...options, headers };
            await new Promise(r => setTimeout(r, 500 * attempt));
            continue;
          }
        }

        // Retry on temporary upstream gateway errors (502, 503, 504)
        if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 800 * attempt));
          continue;
        }

        return res;
      } catch (err: any) {
        lastError = err;
        const errMsg = String(err?.message || '');
        const isNetworkOrTimeout =
          err.name === 'AbortError' ||
          errMsg.includes('fetch failed') ||
          errMsg.includes('timed out') ||
          errMsg.includes('ECONNRESET') ||
          errMsg.includes('ETIMEDOUT') ||
          errMsg.includes('EAI_AGAIN') ||
          errMsg.includes('socket hang up') ||
          errMsg.includes('This operation was aborted') ||
          errMsg.includes('aborted');

        if (isNetworkOrTimeout && attempt < maxRetries) {
          const delay = 600 * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error(`Request failed after ${maxRetries} attempts: ${url}`);
  }

  public async fetchTextWithRetry(
    url: string | URL,
    options: RequestInit = {},
    timeoutMs = 18000,
    maxRetries = 2
  ): Promise<{ status: number; text: string; ok: boolean; url: string }> {
    let lastError: any = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url.toString(), {
          ...options,
          signal: controller.signal,
        });
        this.updateCookies(res);

        // Read text body while signal timeout is STILL actively guarding!
        const text = await res.text();
        clearTimeout(timeoutId);

        // Re-authenticate if session expired or redirect to login (only for non-login endpoints)
        const urlStr = url.toString();
        const isLoginRequest = urlStr.includes('/login');
        if (
          !isLoginRequest &&
          (res.status === 401 ||
           res.status === 419 ||
           (res.url && res.url.includes('/login')))
        ) {
          if (attempt < maxRetries) {
            this.isAuthenticated = false;
            await this.login();
            const headers = new Headers(options.headers || {});
            headers.set('Cookie', this.getCookieHeader());
            options = { ...options, headers };
            await new Promise(r => setTimeout(r, 500 * attempt));
            continue;
          }
        }

        // Retry on temporary upstream gateway errors (502, 503, 504)
        if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 800 * attempt));
          continue;
        }

        return {
          status: res.status,
          text,
          ok: res.ok,
          url: res.url,
        };
      } catch (err: any) {
        clearTimeout(timeoutId);
        lastError = err;
        const errMsg = String(err?.message || '');
        const isNetworkOrTimeout =
          err.name === 'AbortError' ||
          errMsg.includes('Request timed out') ||
          errMsg.includes('fetch failed') ||
          errMsg.includes('ECONNRESET') ||
          errMsg.includes('ETIMEDOUT') ||
          errMsg.includes('EAI_AGAIN') ||
          errMsg.includes('socket hang up') ||
          errMsg.includes('This operation was aborted') ||
          errMsg.includes('aborted');

        if (isNetworkOrTimeout && attempt < maxRetries) {
          const delay = 600 * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error(`Request failed after ${maxRetries} attempts: ${url}`);
  }

  public async ensureAuthenticated(): Promise<boolean> {
    const now = Date.now();
    // Re-check or re-authenticate after 45 minutes
    if (this.isAuthenticated && now - this.lastLoginTime < 45 * 60 * 1000) {
      return true;
    }
    return this.login();
  }

  private loginPromise: Promise<boolean> | null = null;

  public async login(): Promise<boolean> {
    if (!this.isConfigured()) {
      throw new Error('VENDOOR_EMAIL and VENDOOR_PASSWORD environment variables are not defined.');
    }

    if (this.loginPromise) {
      return this.loginPromise;
    }

    this.loginPromise = (async () => {
      try {
        this.cookieMap.clear();

        // Step 1: GET Login Page (15s timeout)
        const getRes = await this.fetchWithTimeout(`${this.baseUrl}/dashboard/login`, {
          headers: {
            'User-Agent': this.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        }, 15000);

        this.updateCookies(getRes);
        const html = await getRes.text();
        const tokenMatch = html.match(/<input[^>]+name=["']_token["'][^>]+value=["']([^"']+)["']/i) ||
                           html.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']_token["']/i) ||
                           html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i) ||
                           html.match(/name="_token"\s+value="([^"]+)"/);
        if (!tokenMatch) {
          throw new Error('CSRF token not found on Vendoor login page');
        }
        const csrfToken = tokenMatch[1];

        // Step 2: POST Login Form
        const bodyParams = new URLSearchParams();
        bodyParams.append('_token', csrfToken);
        bodyParams.append('email', this.email);
        bodyParams.append('password', this.password);
        bodyParams.append('remember', 'on');

        const postRes = await this.fetchWithTimeout(`${this.baseUrl}/dashboard/login`, {
          method: 'POST',
          headers: {
            'User-Agent': this.userAgent,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': this.getCookieHeader(),
            'Origin': this.baseUrl,
            'Referer': `${this.baseUrl}/dashboard/login`,
          },
          body: bodyParams.toString(),
          redirect: 'manual',
        }, 18000);

        this.updateCookies(postRes);

        const redirectLoc = postRes.headers.get('location') || '';

        if (redirectLoc.includes('/login') || postRes.status === 419 || postRes.status === 401) {
          throw new Error('بيانات الدخول غير صحيحة أو تم رفض تسجيل الدخول من Vendoor');
        }

        if (postRes.status === 302 || postRes.status === 200) {
          this.isAuthenticated = true;
          this.lastLoginTime = Date.now();
          return true;
        }

        throw new Error(`Vendoor login failed with status ${postRes.status}`);
      } catch (err: any) {
        this.isAuthenticated = false;
        throw new Error(`Vendoor authentication error: ${err.message}`);
      } finally {
        this.loginPromise = null;
      }
    })();

    return this.loginPromise;
  }

  public async fetchOrdersBatch(
    start = 0,
    length = 100,
    statusFilter = '',
    startDate = '',
    endDate = ''
  ): Promise<{
    recordsTotal: number;
    recordsFiltered: number;
    data: VendoorRawOrder[];
  }> {
    await this.ensureAuthenticated();

    const url = new URL(`${this.baseUrl}/dashboard/orders`);
    url.searchParams.set('draw', '1');
    url.searchParams.set('start', String(start));
    url.searchParams.set('length', String(length));
    if (statusFilter) {
      const statusMap: Record<string, string> = {
        'New': '1',
        'جديد': '1',
        'Processing': '2',
        'Pending': '3',
        'معلق': '3',
        'Shipped': '4',
        'Canceled': '12',
        'ملغي': '12',
        'Printed': '13',
        'مطبوع': '13',
        'Delivered': '8',
      };
      const mappedVal = statusMap[statusFilter] || statusFilter;
      url.searchParams.set('status_filter', mappedVal);
    }
    if (startDate) {
      url.searchParams.set('from_date', startDate);
      url.searchParams.set('start_date', startDate);
    }
    if (endDate) {
      url.searchParams.set('to_date', endDate);
      url.searchParams.set('end_date', endDate);
    }

    const result = await this.fetchTextWithRetry(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Cookie': this.getCookieHeader(),
        'Referer': `${this.baseUrl}/dashboard/orders`,
      },
    }, 35000, 3);

    if (!result.ok) {
      throw new Error(`Failed to fetch orders from Vendoor: HTTP ${result.status}`);
    }

    try {
      return JSON.parse(result.text);
    } catch {
      throw new Error(`Invalid JSON response from Vendoor orders endpoint (HTTP ${result.status}): ${result.text.slice(0, 120)}`);
    }
  }

  public async fetchCustomerIntelligence(phone: string, currentOrderId?: number): Promise<ParsedCustomerHistory> {
    await this.ensureAuthenticated();

    const cleanPhone = phone.trim();
    const query = currentOrderId ? `?current_order_id=${currentOrderId}` : '';
    const res = await this.fetchWithTimeout(`${this.baseUrl}/searchPhone/${cleanPhone}${query}`, {
      headers: {
        'User-Agent': this.userAgent,
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
        'Cookie': this.getCookieHeader(),
      },
    }, 8000);

    let activeRes = res;
    if (activeRes.status === 400 || activeRes.status === 401 || activeRes.status === 419 || activeRes.url.includes('/login')) {
      this.isAuthenticated = false;
      await this.login();
      activeRes = await this.fetchWithTimeout(`${this.baseUrl}/searchPhone/${cleanPhone}${query}`, {
        headers: {
          'User-Agent': this.userAgent,
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json',
          'Cookie': this.getCookieHeader(),
        },
      }, 8000);
      this.updateCookies(activeRes);
    }

    if (!activeRes.ok) {
      throw new Error(`Failed to query customer history for phone ${cleanPhone}: HTTP ${activeRes.status}`);
    }

    const json = await activeRes.json();

    const result: ParsedCustomerHistory = {
      phone: cleanPhone,
      totalOrders: null,
      deliveriesNum: null,
      deliveriesDenom: null,
      deliveryRate: null,
      cancelsNum: null,
      cancelsDenom: null,
      cancelRate: null,
      repetitionsCount: typeof json.data === 'number' ? json.data : null,
      lastOrderStatus: json.status_name || null,
      lastOrderElapsed: json.date ? json.date.trim() : null,
      warningText: null,
      rawProDetailsHtml: json.prodetails || '',
    };

    if (json.prodetails) {
      const html: string = json.prodetails;

      // Extract Total Orders: <b>📦 إجمالي الطلبات :</b> 5
      const totalMatch = html.match(/إجمالي الطلبات\s*:\s*<\/b>\s*(\d+)/i);
      if (totalMatch) {
        result.totalOrders = parseInt(totalMatch[1], 10);
      }

      // Extract Deliveries: <b>✅ التسليمات :</b> 0 من 1
      const delivMatch = html.match(/التسليمات\s*:\s*<\/b>\s*(\d+)\s*من\s*(\d+)/i);
      if (delivMatch) {
        result.deliveriesNum = parseInt(delivMatch[1], 10);
        result.deliveriesDenom = parseInt(delivMatch[2], 10);
      }

      // Extract Delivery Rate %: <b>📈 نسبة التسليم :</b> ... (\d+(?:\.\d+)?)%
      const delivRateMatch = html.match(/نسبة التسليم[\s\S]*?(\d+(?:\.\d+)?)\s*%/i);
      if (delivRateMatch) {
        result.deliveryRate = parseFloat(delivRateMatch[1]);
      }

      // Extract Cancels: <b>❌ الإلغاءات والمرتجعات :</b> 1 من 1
      const cancelMatch = html.match(/الإلغاءات والمرتجعات\s*:\s*<\/b>\s*(\d+)\s*من\s*(\d+)/i);
      if (cancelMatch) {
        result.cancelsNum = parseInt(cancelMatch[1], 10);
        result.cancelsDenom = parseInt(cancelMatch[2], 10);
      }

      // Extract Cancel Rate %: <b>📉 نسبة الإلغاء :</b> ... (\d+(?:\.\d+)?)%
      const cancelRateMatch = html.match(/نسبة الإلغاء[\s\S]*?(\d+(?:\.\d+)?)\s*%/i);
      if (cancelRateMatch) {
        result.cancelRate = parseFloat(cancelRateMatch[1]);
      }

      // Extract Warning badge e.g. 🔴 نسبة التسليمات منخفضة
      const warnMatch = html.match(/(🔴[^\n<]+)/);
      if (warnMatch) {
        result.warningText = warnMatch[1].trim();
      }
    }

    return result;
  }

  public async fetchConfirmationAgePage(
    category: 'one' | 'two' | 'three' | 'over_three',
    timeoutMs = 6000
  ): Promise<ConfirmationRow[]> {
    await this.ensureAuthenticated();

    const pathMap = {
      one: 'one/day/order/confirmation',
      two: 'two/day/order/confirmation',
      three: 'three/day/order/confirmation',
      over_three: 'over/three/day/order/confirmation',
    };

    const result = await this.fetchTextWithRetry(`${this.baseUrl}/dashboard/${pathMap[category]}`, {
      headers: {
        'User-Agent': this.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en;q=0.9',
        'Cookie': this.getCookieHeader(),
        'Referer': `${this.baseUrl}/dashboard`,
      },
    }, timeoutMs, 1);

    if (!result.ok) {
      throw new Error(`Failed to fetch confirmation page for ${category}: HTTP ${result.status}`);
    }

    const html = result.text;
    const rows: ConfirmationRow[] = [];

    // Parse table rows
    const trMatches = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    for (let i = 1; i < trMatches.length; i++) {
      const rowContent = trMatches[i][1];
      const tdMatches = [...rowContent.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
        m[1].replace(/<[^>]+>/g, '').trim()
      );

      if (tdMatches.length >= 12) {
        // Format: [index, invoiceNo, orderType, printedDate, affiliateCode, randomNumber/bill, affiliateName, customerName, phone, governorate, address, totalOrder, status]
        rows.push({
          invoiceNo: tdMatches[1],
          orderType: tdMatches[2] || 'اوردر جديد',
          printedDate: tdMatches[3],
          affiliateCode: tdMatches[4],
          randomNumber: tdMatches[5], // column labeled 'رقم البوليصة' contains the random code e.g. uq8853
          affiliateName: tdMatches[6],
          customerName: tdMatches[7],
          phone: tdMatches[8],
          governorate: tdMatches[9],
          address: tdMatches[10],
          totalOrder: parseFloat(tdMatches[11]) || 0,
          status: tdMatches[12] || 'Printed',
        });
      }
    }

    return rows;
  }

  public buildSystemLogsUrl(page = 1, startDate = '', endDate = ''): URL {
    const url = new URL(`${this.baseUrl}/dashboard/log/system`);
    url.searchParams.set('page', String(page));
    const cleanStart = (startDate || '').trim().slice(0, 10);
    const cleanEnd = (endDate || cleanStart).trim().slice(0, 10);
    if (cleanStart) {
      url.searchParams.set('start_date', cleanStart);
      url.searchParams.set('from_date', cleanStart);
    }
    if (cleanEnd) {
      url.searchParams.set('end_date', cleanEnd);
      url.searchParams.set('to_date', cleanEnd);
    }
    return url;
  }

  public buildExcelExportUrl(startDate = '', endDate = ''): URL {
    const url = new URL(`${this.baseUrl}/dashboard/log/xls/all`);
    const cleanStart = (startDate || '').trim().slice(0, 10);
    const cleanEnd = (endDate || cleanStart).trim().slice(0, 10);
    if (cleanStart) {
      url.searchParams.set('start_date', cleanStart);
      url.searchParams.set('from_date', cleanStart);
    }
    if (cleanEnd) {
      url.searchParams.set('end_date', cleanEnd);
      url.searchParams.set('to_date', cleanEnd);
    }
    return url;
  }

  public async fetchSystemLogs(page = 1, startDate = '', endDate = ''): Promise<{
    entries: LogEntry[];
    totalPages: number;
  }> {
    await this.ensureAuthenticated();

    const url = this.buildSystemLogsUrl(page, startDate, endDate);

    const res = await this.fetchWithRetry(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        'Cookie': this.getCookieHeader(),
      },
    }, 25000, 3);

    if (!res.ok) {
      throw new Error(`Failed to fetch system logs page ${page}: HTTP ${res.status}`);
    }

    const html = await res.text();
    const entries: LogEntry[] = [];

    // Parse log table rows
    const logTrMatches = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)];
    for (let i = 1; i < logTrMatches.length; i++) {
      const rowMatch = logTrMatches[i];
      const content = rowMatch[1];

      const rawTds = [...content.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
      const tds = rawTds.map(m => m[1].replace(/<[^>]+>/g, '').trim());

      if (tds.length >= 5) {
        const orderTdHtml = rawTds[1]?.[1] || '';
        const orderHrefMatch = orderTdHtml.match(/href=["']([^"']+)["']/i);
        const orderIdMatch = orderTdHtml.match(/orders\/(\d+)/i);
        const extractedOrderId = orderIdMatch ? parseInt(orderIdMatch[1], 10) : null;

        entries.push({
          index: parseInt(tds[0], 10) || 0,
          orderCode: tds[1],
          actorName: tds[2],
          rawActionText: tds[3],
          eventTimestamp: tds[4],
          vendoorOrderId: extractedOrderId,
          orderHref: orderHrefMatch ? orderHrefMatch[1] : null,
          rawHtml: rowMatch[0],
        });
      }
    }

    // Determine total pages from pagination
    let totalPages = page;
    const pageLinks = [...html.matchAll(/page=(\d+)/g)].map(m => parseInt(m[1], 10));
    if (pageLinks.length > 0) {
      totalPages = Math.max(...pageLinks);
    }

    return { entries, totalPages };
  }

  /**
   * Native Vendoor System Logs Excel Export:
   * Downloads the complete Excel file for a specified date range via /dashboard/log/xls/all
   * This is the exact action performed by clicking the green Export button in Vendoor System Logs.
   */
  public async exportSystemLogsExcel(startDate: string, endDate: string): Promise<Buffer> {
    await this.ensureAuthenticated();

    const url = this.buildExcelExportUrl(startDate, endDate);

    const res = await this.fetchWithRetry(
      url.toString(),
      {
        headers: {
          'User-Agent': this.userAgent,
          'Cookie': this.getCookieHeader(),
          'Referer': `${this.baseUrl}/dashboard/log/system`,
        },
      },
      45000,
      3
    );

    if (!res.ok) {
      throw new Error(`Failed to export system logs Excel from Vendoor: HTTP ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (!buffer || buffer.length === 0) {
      throw new Error('Exported system logs Excel file is empty');
    }

    return buffer;
  }

  public async fetchOrderDetailsEnrichment(vendoorOrderId: number): Promise<{
    success: boolean;
    anotherPhone: string;
    extraPhoneValid: boolean;
    merchantCodes: string[];
    vendorIds: string[];
    warehouseNames: string[];
  }> {
    try {
      await this.ensureAuthenticated();

      const result = await this.fetchTextWithRetry(
        `${this.baseUrl}/dashboard/super-admin/orders/${vendoorOrderId}/edit?type=refactor`,
        {
          headers: {
            'User-Agent': this.userAgent,
            'Cookie': this.getCookieHeader(),
          },
        },
        12000,
        2
      );

      if (!result.ok) {
        return { success: false, anotherPhone: '', extraPhoneValid: false, merchantCodes: [], vendorIds: [], warehouseNames: [] };
      }

      const html = result.text;

      // Extract another_phone
      const phoneMatch = html.match(/name="another_phone"[^>]*value="([^"]*)"/i) || html.match(/value="([^"]*)"[^>]*name="another_phone"/i);
      const anotherPhone = phoneMatch ? phoneMatch[1].trim() : '';

      // Validate extra phone: Egyptian mobile numbers must match 01[0125][0-9]{8}
      const cleanPhone = anotherPhone.replace(/[\s\-\+]/g, '');
      const extraPhoneValid = /^(01[0125]\d{8}|201[0125]\d{8})$/.test(cleanPhone);

      // Extract vendor IDs from data-vendor-id or vendor-id
      const vendorIds = [...html.matchAll(/(?:data-vendor-id|vendor-id|name="vendor_id(?:\[\])?")[^>]*value="([^"]+)"/gi)].map(m => m[1].trim());

      // Extract warehouse/vendor strings from product names (e.g. "مخزن Y2", "مخزن Te1")
      const warehouseMatches = [...html.matchAll(/\(\s*مخزن\s*([^)]+)\s*\)/gi)].map(m =>
        `مخزن ${m[1].trim()}`
      );

      // Distinct actual merchant identifiers (vendor IDs if present, otherwise explicit merchant codes)
      const distinctMerchantCodes = vendorIds.length > 0 ? [...new Set(vendorIds)] : [];

      return {
        success: true,
        anotherPhone,
        extraPhoneValid,
        merchantCodes: distinctMerchantCodes,
        vendorIds: [...new Set(vendorIds)],
        warehouseNames: [...new Set(warehouseMatches)],
      };
    } catch {
      return { success: false, anotherPhone: '', extraPhoneValid: false, merchantCodes: [], vendorIds: [], warehouseNames: [] };
    }
  }
}

export const vendoorClient = new VendoorClient();
