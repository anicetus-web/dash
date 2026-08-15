import { config, DEAL_CATEGORY_2D_BIM } from '../config.js';
import { valueOf } from '../lib/records.js';

export class BitrixClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || config.vibeApiKey;
    this.baseUrl = options.baseUrl || config.vibeBaseUrl;
  }

  async request(path, options = {}) {
    if (!this.apiKey) {
      const error = new Error('VIBE_API_KEY is not configured');
      error.code = 'NO_API_KEY';
      throw error;
    }

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || 45000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          'X-Api-Key': this.apiKey,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {})
        }
      });
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { success: false, error: { message: text || `HTTP ${res.status}` } };
      }
      if (!res.ok || body?.success === false) {
        const error = new Error(body?.error?.message || body?.message || `HTTP ${res.status}`);
        error.code = body?.error?.code || 'API_ERROR';
        error.status = res.status;
        throw error;
      }
      return body;
    } catch (error) {
      if (error.name === 'AbortError') {
        const wrapped = new Error('Bitrix24 API timed out');
        wrapped.code = 'API_TIMEOUT';
        throw wrapped;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async list(entity, params = {}, options = {}) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
    }
    const suffix = qs.toString() ? `?${qs}` : '';
    const body = await this.request(`/${entity}${suffix}`, options);
    return Array.isArray(body.data) ? body.data : [];
  }

  async search(entity, payload = {}, options = {}) {
    const body = await this.request(`/${entity}/search`, {
      ...options,
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return Array.isArray(body.data) ? body.data : [];
  }
}

export function categoryId(category) {
  return Number(valueOf(category, ['id', 'ID', 'categoryId', 'CATEGORY_ID'], DEAL_CATEGORY_2D_BIM));
}

export function statusEntityId(status) {
  return String(valueOf(status, ['entityId', 'ENTITY_ID'], ''));
}

export function statusId(status) {
  return String(valueOf(status, ['statusId', 'STATUS_ID', 'id', 'ID'], ''));
}

export function statusName(status) {
  return String(valueOf(status, ['name', 'title', 'NAME', 'TITLE', 'statusName', 'STATUS_NAME'], ''));
}
