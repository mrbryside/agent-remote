import assert from 'node:assert/strict';
import test from 'node:test';
import { originAllowed, sameOrigin, trustedRequestAuthority } from '../src/server/http.js';

function request({ host, origin, localAddress = '127.0.0.1', localPort = 4312, encrypted = false } = {}) {
  return {
    headers: { ...(host ? { host } : {}), ...(origin ? { origin } : {}) },
    socket: { localAddress, localPort, encrypted },
  };
}

test('rejects a DNS-rebinding Host and Origin even when they agree with each other', () => {
  const config = { host: '127.0.0.1', allowedOrigins: [] };
  const attackerRequest = request({
    host: 'attacker.example:4312',
    origin: 'http://attacker.example:4312',
  });

  assert.equal(trustedRequestAuthority(attackerRequest, config), undefined);
  assert.equal(sameOrigin(attackerRequest, config), false);
  assert.equal(originAllowed(attackerRequest, config), false);
});

test('accepts legitimate loopback aliases on the listener port only', () => {
  const config = { host: '127.0.0.1', allowedOrigins: [] };
  const localhostRequest = request({
    host: 'localhost:4312',
    origin: 'http://localhost:4312',
  });

  assert.equal(trustedRequestAuthority(localhostRequest, config)?.host, 'localhost:4312');
  assert.equal(sameOrigin(localhostRequest, config), true);
  assert.equal(originAllowed(localhostRequest, config), true);
  assert.equal(originAllowed(request({
    host: 'localhost:4313', origin: 'http://localhost:4313',
  }), config), false);
});

test('allows explicitly configured origins without trusting an arbitrary request Host', () => {
  const config = {
    host: '127.0.0.1',
    allowedOrigins: ['https://workspace.example.test'],
  };
  const configuredOriginRequest = request({
    host: '127.0.0.1:4312',
    origin: 'https://workspace.example.test',
  });

  assert.equal(originAllowed(configuredOriginRequest, config), true);
  assert.equal(originAllowed(request({
    host: 'attacker.example:4312', origin: 'https://workspace.example.test',
  }), config), false);
});

test('accepts the configured non-loopback bind authority and wildcard listener address', () => {
  const configuredHost = request({
    host: 'workspace.lan:4312',
    origin: 'http://workspace.lan:4312',
    localAddress: '192.0.2.15',
  });
  assert.equal(originAllowed(configuredHost, { host: 'workspace.lan', allowedOrigins: [] }), true);

  const wildcardListener = request({
    host: '192.0.2.15:4312',
    origin: 'http://192.0.2.15:4312',
    localAddress: '192.0.2.15',
  });
  assert.equal(originAllowed(wildcardListener, { host: '0.0.0.0', allowedOrigins: [] }), true);
});
