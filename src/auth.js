import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'wa_bridge_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

function hashPin(pin) {
  return createHash('sha256').update(pin).digest();
}

function readCookie(request) {
  const cookieHeader = request.headers.cookie || '';
  const prefix = `${COOKIE_NAME}=`;

  for (const cookie of cookieHeader.split(';')) {
    const value = cookie.trim();
    if (value.indexOf(prefix) === 0) {
      return value.slice(prefix.length);
    }
  }

  return null;
}

function originMatchesHost(origin, host) {
  if (!origin) return true;
  if (!host) return false;

  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function createAuth(configuredPin, secureCookie = false) {
  if (
    typeof configuredPin !== 'string' ||
    configuredPin.length < 4 ||
    configuredPin === 'CHANGE_ME'
  ) {
    throw new Error('Set WA_PIN to a private PIN of at least 4 characters.');
  }

  const configuredPinHash = hashPin(configuredPin);
  const sessions = new Map();
  const loginFailures = new Map();

  function findSession(token) {
    if (!token) return null;

    const session = sessions.get(token);
    if (!session) return null;

    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }

    return session;
  }

  function setSessionCookie(response, token) {
    const secure = secureCookie ? '; Secure' : '';
    response.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
    );
  }

  function clearSessionCookie(response) {
    const secure = secureCookie ? '; Secure' : '';
    response.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`
    );
  }

  function getClientKey(request) {
    return request.ip || request.socket.remoteAddress || 'unknown';
  }

  function checkLoginLimit(request, response) {
    const key = getClientKey(request);
    const record = loginFailures.get(key);
    const now = Date.now();

    if (!record) return true;

    if (record.blockedUntil > now) {
      response.setHeader(
        'Retry-After',
        String(Math.ceil((record.blockedUntil - now) / 1000))
      );
      response.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
      return false;
    }

    if (record.blockedUntil && record.blockedUntil <= now) {
      loginFailures.delete(key);
    }

    return true;
  }

  function recordLoginFailure(request) {
    const key = getClientKey(request);
    const record = loginFailures.get(key) || { failures: 0, blockedUntil: 0 };
    record.failures += 1;

    if (record.failures >= MAX_LOGIN_FAILURES) {
      record.blockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    }

    loginFailures.set(key, record);
  }

  function ensureSameOrigin(request, response, next) {
    if (
      !originMatchesHost(
        request.headers.origin,
        request.headers.host
      )
    ) {
      response.status(403).json({ error: 'Permintaan lintas origin ditolak.' });
      return;
    }

    next();
  }

  return {
    ensureSameOrigin,

    login(request, response) {
      if (!checkLoginLimit(request, response)) return;

      const submittedPin = request.body && request.body.pin;
      if (typeof submittedPin !== 'string' || submittedPin.length > 128) {
        response.status(400).json({ error: 'PIN tidak valid.' });
        return;
      }

      const submittedPinHash = hashPin(submittedPin);
      if (!timingSafeEqual(configuredPinHash, submittedPinHash)) {
        recordLoginFailure(request);
        response.status(401).json({ error: 'PIN salah.' });
        return;
      }

      loginFailures.delete(getClientKey(request));
      const token = randomBytes(32).toString('hex');
      const expiresAt = Date.now() + SESSION_TTL_MS;
      sessions.set(token, { expiresAt });
      setSessionCookie(response, token);
      response.json({ authenticated: true });
    },

    sessionStatus(request, response) {
      const token = readCookie(request);
      const session = findSession(token);

      if (!session && token) {
        clearSessionCookie(response);
      }

      response.json({ authenticated: Boolean(session) });
    },

    requireAuth(request, response, next) {
      const token = readCookie(request);
      if (findSession(token)) {
        next();
        return;
      }

      response.status(401).json({ error: 'Autentikasi diperlukan.' });
    },

    socketAuth(socket, next) {
      const headers = socket.handshake.headers;
      if (!originMatchesHost(headers.origin, headers.host)) {
        next(new Error('Unauthorized'));
        return;
      }

      const request = { headers };
      const token = readCookie(request);
      if (!findSession(token)) {
        next(new Error('Unauthorized'));
        return;
      }

      socket.data.sessionToken = token;
      next();
    },

    getSessionForSocket(socket) {
      return findSession(socket.data.sessionToken);
    },

    revokeSession(request, response) {
      const token = readCookie(request);
      if (token) sessions.delete(token);
      clearSessionCookie(response);
      return token;
    },
  };
}
