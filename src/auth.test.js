import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from './auth.js';

function createRequest(options = {}) {
  const headers = {
    host: options.host || 'bridge.local:3000',
  };
  if (options.origin) headers.origin = options.origin;
  if (options.cookie) headers.cookie = options.cookie;

  return {
    headers,
    body: options.body || {},
    ip: options.ip || '192.168.1.20',
    socket: { remoteAddress: options.ip || '192.168.1.20' },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

function createAuthenticatedCookie(auth) {
  const request = createRequest({ body: { pin: '2468' } });
  const response = createResponse();
  auth.login(request, response);
  assert.equal(response.statusCode, 200);
  return response.headers['Set-Cookie'].split(';')[0];
}

test('PIN login grants a session accepted by protected middleware', () => {
  const auth = createAuth('2468');
  const cookie = createAuthenticatedCookie(auth);
  const response = createResponse();
  let allowed = false;

  auth.requireAuth(createRequest({ cookie }), response, () => {
    allowed = true;
  });

  assert.equal(allowed, true);
  assert.equal(response.statusCode, 200);
});

test('unauthenticated requests are denied and wrong PIN attempts are limited', () => {
  const auth = createAuth('2468');
  const deniedResponse = createResponse();
  auth.requireAuth(createRequest(), deniedResponse, () => {});
  assert.equal(deniedResponse.statusCode, 401);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = createResponse();
    auth.login(createRequest({ body: { pin: '0000' } }), response);
    assert.equal(response.statusCode, 401);
  }

  const blockedResponse = createResponse();
  auth.login(createRequest({ body: { pin: '2468' } }), blockedResponse);
  assert.equal(blockedResponse.statusCode, 429);
});

test('Socket.IO authentication requires a valid session and same-origin host', () => {
  const auth = createAuth('2468');
  const cookie = createAuthenticatedCookie(auth);
  const socket = {
    handshake: {
      headers: {
        host: 'bridge.local:3000',
        origin: 'http://bridge.local:3000',
        cookie,
      },
    },
    data: {},
  };

  auth.socketAuth(socket, (error) => {
    assert.equal(error, undefined);
  });
  assert.ok(auth.getSessionForSocket(socket));

  const foreignSocket = {
    handshake: {
      headers: {
        host: 'bridge.local:3000',
        origin: 'http://attacker.example',
        cookie,
      },
    },
    data: {},
  };

  auth.socketAuth(foreignSocket, (error) => {
    assert.ok(error);
  });
});
