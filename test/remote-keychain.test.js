import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudflareTokenStore } from '../src/remote/keychain.js';

const service = 'com.sirawat.agent-remote.cloudflare';
const account = 'user-api-token';

function createExecFile(respond) {
  const calls = [];
  return {
    calls,
    execFile(command, args, options, callback) {
      calls.push({ command, args, options });
      queueMicrotask(() => respond({ command, args, options, callback }));
    },
  };
}

function securityError(message, code = 1) {
  const error = new Error(message);
  error.code = code;
  return error;
}

test('treats a missing Keychain item as absent for reads, checks, and deletion', async () => {
  const fake = createExecFile(({ callback }) => {
    callback(securityError('The specified item could not be found in the keychain.', 44), '', '');
  });
  const store = createCloudflareTokenStore({ execFile: fake.execFile, platform: 'darwin' });

  assert.equal(await store.has(), false);
  assert.equal(await store.read(), undefined);
  assert.equal(await store.remove(), false);
  assert.deepEqual(fake.calls.map(({ command, args }) => ({ command, args })), [
    {
      command: '/usr/bin/security',
      args: ['find-generic-password', '-s', service, '-a', account, '-w'],
    },
    {
      command: '/usr/bin/security',
      args: ['find-generic-password', '-s', service, '-a', account, '-w'],
    },
    {
      command: '/usr/bin/security',
      args: ['delete-generic-password', '-s', service, '-a', account],
    },
  ]);
});

test('reads a Cloudflare token from the macOS Keychain', async () => {
  const fake = createExecFile(({ callback }) => callback(null, 'cf-token\n', ''));
  const store = createCloudflareTokenStore({ execFile: fake.execFile, platform: 'darwin' });

  assert.equal(await store.read(), 'cf-token');
  assert.equal(await store.has(), true);
});

test('adds or updates a trimmed token and never returns it from write', async () => {
  const fake = createExecFile(({ callback }) => callback(null, '', ''));
  const store = createCloudflareTokenStore({ execFile: fake.execFile, platform: 'darwin' });

  assert.equal(await store.write('  cf-token  \n'), undefined);
  assert.equal(await store.remove(), true);
  assert.deepEqual(fake.calls.map(({ command, args }) => ({ command, args })), [
    {
      command: '/usr/bin/security',
      args: ['add-generic-password', '-s', service, '-a', account, '-w', 'cf-token', '-U'],
    },
    {
      command: '/usr/bin/security',
      args: ['delete-generic-password', '-s', service, '-a', account],
    },
  ]);
});

test('reduces Keychain cancellation and unexpected security failures to safe errors', async () => {
  const cancelled = createExecFile(({ callback }) => {
    callback(securityError('User canceled the request.', -128), '', '');
  });
  const cancellationStore = createCloudflareTokenStore({ execFile: cancelled.execFile, platform: 'darwin' });
  await assert.rejects(cancellationStore.read(), (error) => {
    assert.equal(error.code, 'KEYCHAIN_CANCELLED');
    assert.doesNotMatch(error.message, /canceled the request/i);
    return true;
  });

  const token = 'super-secret-cloudflare-token';
  const broken = createExecFile(({ callback }) => {
    callback(securityError(`security failed while writing ${token}`), '', '');
  });
  const brokenStore = createCloudflareTokenStore({ execFile: broken.execFile, platform: 'darwin' });
  await assert.rejects(brokenStore.write(token), (error) => {
    assert.equal(error.code, 'KEYCHAIN_ERROR');
    assert.doesNotMatch(error.message, /super-secret-cloudflare-token/);
    return true;
  });
});

test('validates token size without disclosing it and declines unsupported platforms', async () => {
  const fake = createExecFile(({ callback }) => callback(null, '', ''));
  const store = createCloudflareTokenStore({ execFile: fake.execFile, platform: 'darwin' });
  const oversized = `token-${'x'.repeat(4_096)}`;

  await assert.rejects(store.write(' \n '), (error) => {
    assert.equal(error.code, 'TOKEN_INVALID');
    assert.doesNotMatch(error.message, /token/);
    return true;
  });
  await assert.rejects(store.write(oversized), (error) => {
    assert.equal(error.code, 'TOKEN_INVALID');
    assert.doesNotMatch(error.message, /x{20}/);
    return true;
  });
  assert.equal(fake.calls.length, 0);

  const unsupported = createCloudflareTokenStore({ execFile: fake.execFile, platform: 'linux' });
  await assert.rejects(unsupported.has(), (error) => {
    assert.equal(error.code, 'REMOTE_UNSUPPORTED');
    return true;
  });
  assert.equal(fake.calls.length, 0);
});
