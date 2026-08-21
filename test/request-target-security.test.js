import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseRequestTarget,
  parseRequestUrl,
  rejectInvalidRequestTarget,
  rejectInvalidUpgrade,
} from '../src/server/request-target.js';

test('parses only canonical origin-form request targets', () => {
  const url = parseRequestTarget('/api/sessions?token=example');
  assert.equal(url?.pathname, '/api/sessions');
  assert.equal(url?.searchParams.get('token'), 'example');
  assert.equal(parseRequestUrl({ url: '/health' })?.pathname, '/health');
});

test('rejects malformed and absolute-form request targets without throwing', () => {
  for (const target of [
    undefined,
    '',
    'http://[',
    'http://evil.example/api/sessions',
    '//evil.example/api/sessions',
    '/%',
    '/api/sessions#fragment',
    '/api/sessions with-space',
  ]) {
    assert.doesNotThrow(() => parseRequestTarget(target));
    assert.equal(parseRequestTarget(target), undefined, `target ${String(target)} should be rejected`);
  }
});

test('rejects paths whose URL parsing would normalise or decode a route boundary', () => {
  for (const target of [
    '/api/../sessions',
    '/api/%2e%2e/sessions',
    '/api%2fsessions',
    '/api%5Csessions',
  ]) {
    assert.equal(parseRequestTarget(target), undefined, `target ${target} should be rejected`);
  }
  assert.equal(parseRequestTarget('/api/%7Esession')?.pathname, '/api/%7Esession');
});

test('rejection helpers send a generic 400 response and close upgrade sockets', () => {
  const response = {
    writableEnded: false,
    destroyed: false,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.writableEnded = true; this.body = body; },
  };
  rejectInvalidRequestTarget(response);
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), { error: 'Invalid request target' });
  assert.equal(response.headers['x-content-type-options'], 'nosniff');

  const socket = {
    destroyed: false,
    data: undefined,
    write(value) { this.data = value; },
    destroy() { this.destroyed = true; },
  };
  rejectInvalidUpgrade(socket);
  assert.match(socket.data, /^HTTP\/1\.1 400 Bad Request\r\n/);
  assert.equal(socket.destroyed, true);
});
