const MAX_BYTES = 12 * 1024 * 1024;
const TTL_SECONDS = 10 * 60;
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 10;
const SESSION_SECONDS = 12 * 60 * 60;
const AUTH_RATE_WINDOW = 5 * 60;
const AUTH_RATE_MAX = 5;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/auth/')) {
      if (url.pathname === '/api/auth/session' && request.method === 'GET') {
        return json({ authenticated: await hasValidSession(request, env) });
      }
      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        return login(request, env);
      }
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        return logout(request);
      }
      return json({ error: 'Not found' }, 404);
    }

    if (url.pathname === '/api/image') {
      if (request.method === 'POST') {
        if (!await hasValidSession(request, env)) return unauthorized();
        return uploadImage(request, env);
      }
      return json({ error: 'Method not allowed' }, 405);
    }

    if (url.pathname.startsWith('/api/image/')) {
      const id = url.pathname.slice('/api/image/'.length);
      if (!isValidId(id)) return new Response('Not found', { status: 404 });
      if (request.method === 'GET') return getImage(request, env);
      if (request.method === 'DELETE') {
        if (!await hasValidSession(request, env)) return unauthorized();
        return deleteImage(request, env);
      }
      return json({ error: 'Method not allowed' }, 405);
    }

    // Static assets contain no credentials or private data. The UI itself is gated by
    // the session endpoint; all privileged API operations are enforced above.
    return env.ASSETS.fetch(request);
  },
};

async function login(request, env) {
  if (!sameOrigin(request)) return json({ error: 'Invalid request origin.' }, 403);
  if (!env.AUTH_USERNAME || !env.AUTH_PASSWORD || !env.SESSION_SECRET) {
    return json({ error: '登入服務尚未完成設定，請檢查 Cloudflare 環境變數與 Secrets。' }, 503);
  }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const bucket = Math.floor(Date.now() / (AUTH_RATE_WINDOW * 1000));
  const rateKey = `auth-rate:${bucket}:${ip}`;
  const attempts = Number(await env.IMAGE_KV.get(rateKey) || 0);
  if (attempts >= AUTH_RATE_MAX) {
    const retryAfter = AUTH_RATE_WINDOW - Math.floor((Date.now() / 1000) % AUTH_RATE_WINDOW);
    return json({ error: `登入嘗試過多，請在 ${retryAfter} 秒後再試。` }, 429, { 'retry-after': String(retryAfter) });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const username = String(body.username || '');
  const password = String(body.password || '');
  const [userOk, passOk] = await Promise.all([
    constantTimeEqual(username, env.AUTH_USERNAME),
    constantTimeEqual(password, env.AUTH_PASSWORD),
  ]);

  if (!userOk || !passOk) {
    await env.IMAGE_KV.put(rateKey, String(attempts + 1), { expirationTtl: AUTH_RATE_WINDOW + 5 });
    return json({ error: '帳號或密碼錯誤。' }, 401);
  }

  await env.IMAGE_KV.delete(rateKey);
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(JSON.stringify({ sub: env.AUTH_USERNAME, iat: now, exp: now + SESSION_SECONDS }));
  const signature = await sign(payload, env.SESSION_SECRET);
  const token = `${payload}.${signature}`;
  return json({ authenticated: true }, 200, {
    'set-cookie': sessionCookie(token, SESSION_SECONDS),
  });
}

async function logout(request) {
  if (!sameOrigin(request)) return json({ error: 'Invalid request origin.' }, 403);
  return json({ authenticated: false }, 200, {
    'set-cookie': sessionCookie('', 0),
  });
}

async function hasValidSession(request, env) {
  if (!env.AUTH_USERNAME || !env.SESSION_SECRET) return false;
  const token = getCookie(request, 'ish_session');
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const expected = await sign(parts[0], env.SESSION_SECRET);
  if (!await constantTimeEqual(parts[1], expected)) return false;

  try {
    const payload = JSON.parse(base64UrlDecode(parts[0]));
    const now = Math.floor(Date.now() / 1000);
    return payload.sub === env.AUTH_USERNAME && Number(payload.exp) > now && Number(payload.iat) <= now + 60;
  } catch {
    return false;
  }
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

async function constantTimeEqual(a, b) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(a))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(b))),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

function getCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  const item = cookie.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  return item ? item.slice(name.length + 1) : '';
}

function sessionCookie(value, maxAge) {
  return `ish_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function sameOrigin(request) {
  return request.headers.get('origin') === new URL(request.url).origin;
}

function unauthorized() {
  return json({ error: '請先登入。' }, 401);
}

async function uploadImage(request, env) {
  const origin = request.headers.get('origin');
  const requestOrigin = new URL(request.url).origin;
  if (origin !== requestOrigin) return json({ error: 'Uploads must come from the same site.' }, 403);

  const rateLimit = await checkRateLimit(request, env);
  if (!rateLimit.allowed) {
    return new Response(JSON.stringify({ error: 'Too many uploads. Please try again later.' }), {
      status: 429,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': String(rateLimit.retryAfter),
        'x-ratelimit-limit': String(RATE_LIMIT_MAX),
        'x-ratelimit-remaining': '0',
      },
    });
  }

  const type = request.headers.get('content-type') || '';
  if (!type.startsWith('image/')) return json({ error: 'Only image/* uploads are accepted.' }, 415);
  const length = Number(request.headers.get('content-length') || 0);
  if (length && length > MAX_BYTES) return json({ error: 'Image exceeds the 12 MB limit.' }, 413);

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return json({ error: 'Image exceeds the 12 MB limit.' }, 413);

  const id = crypto.randomUUID();
  const expiresAt = Date.now() + TTL_SECONDS * 1000;
  await env.IMAGE_KV.put(`image:${id}`, body, {
    expirationTtl: TTL_SECONDS,
    metadata: { contentType: type, expiresAt },
  });

  const imageUrl = new URL(`/api/image/${id}`, request.url);
  return json({ url: imageUrl.toString(), expiresAt }, 200, {
    'x-ratelimit-limit': String(RATE_LIMIT_MAX),
    'x-ratelimit-remaining': String(rateLimit.remaining),
  });
}

async function checkRateLimit(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const bucket = Math.floor(Date.now() / (RATE_LIMIT_WINDOW * 1000));
  const key = `rate:${bucket}:${ip}`;
  const count = Number(await env.IMAGE_KV.get(key) || 0);
  if (count >= RATE_LIMIT_MAX) {
    const retryAfter = RATE_LIMIT_WINDOW - Math.floor((Date.now() / 1000) % RATE_LIMIT_WINDOW);
    return { allowed: false, remaining: 0, retryAfter };
  }
  await env.IMAGE_KV.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW + 5 });
  return { allowed: true, remaining: Math.max(0, RATE_LIMIT_MAX - count - 1), retryAfter: 0 };
}

async function getImage(request, env) {
  const id = new URL(request.url).pathname.slice('/api/image/'.length);
  const result = await env.IMAGE_KV.getWithMetadata(`image:${id}`, { type: 'arrayBuffer' });
  if (result.value === null) return new Response('Not found or expired', { status: 404 });

  const metadata = result.metadata || {};
  const expiresAt = Number(metadata.expiresAt || 0);
  if (expiresAt && Date.now() >= expiresAt) {
    await env.IMAGE_KV.delete(`image:${id}`);
    return new Response('Expired', { status: 410 });
  }
  return new Response(result.value, {
    headers: {
      'content-type': metadata.contentType || 'image/webp',
      'cache-control': 'public, max-age=600, s-maxage=600',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
    },
  });
}

async function deleteImage(request, env) {
  const id = new URL(request.url).pathname.slice('/api/image/'.length);
  await env.IMAGE_KV.delete(`image:${id}`);
  return new Response(null, { status: 204 });
}

function isValidId(id) {
  return /^[0-9a-f-]{36}$/i.test(id);
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}
