import { execFile as defaultExecFile } from 'node:child_process';

const SECURITY_COMMAND = '/usr/bin/security';
const SERVICE = 'com.sirawat.agent-remote.cloudflare';
const ACCOUNT = 'user-api-token';
const MAX_TOKEN_BYTES = 4 * 1024;

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorText(error) {
  return [error?.message, error?.stderr, error?.stdout]
    .filter((value) => typeof value === 'string')
    .join('\n');
}

function isMissingItem(error) {
  if (Number(error?.code) === 44 || error?.code === 'errSecItemNotFound') return true;
  return /errSecItemNotFound|item (?:could not be found|not found)|specified item/i.test(errorText(error));
}

function isCancellation(error) {
  if (Number(error?.code) === -128 || error?.code === 'errSecUserCanceled') return true;
  return /errSecUserCanceled|user (?:cancelled|canceled)|(?:cancelled|canceled) the request/i.test(errorText(error));
}

function reduceSecurityError(error) {
  if (isCancellation(error)) {
    return createError('KEYCHAIN_CANCELLED', 'Keychain access was cancelled.');
  }
  return createError('KEYCHAIN_ERROR', 'Unable to access the macOS Keychain.');
}

function runSecurity(execFile, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, stdout = '', stderr = '') => {
      if (settled) return;
      settled = true;
      if (error) {
        const failure = new Error(typeof error?.message === 'string' ? error.message : 'security failed');
        failure.code = error?.code;
        failure.stdout = typeof error?.stdout === 'string' ? error.stdout : stdout;
        failure.stderr = typeof error?.stderr === 'string' ? error.stderr : stderr;
        reject(failure);
      } else {
        resolve({ stdout, stderr });
      }
    };

    try {
      const result = execFile(
        SECURITY_COMMAND,
        args,
        { encoding: 'utf8', maxBuffer: 16 * 1024 },
        finish,
      );
      if (result && typeof result.then === 'function') {
        result.then(
          (value) => finish(null, value?.stdout ?? value ?? '', value?.stderr ?? ''),
          finish,
        );
      }
    } catch (error) {
      finish(error);
    }
  });
}

function validateToken(value) {
  if (typeof value !== 'string') {
    throw createError('TOKEN_INVALID', 'Cloudflare credential is invalid.');
  }
  const token = value.trim();
  if (!token || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
    throw createError('TOKEN_INVALID', 'Cloudflare credential is invalid.');
  }
  return token;
}

/**
 * Provides the macOS Keychain-backed storage for the Cloudflare user API token.
 * No alternate or plaintext store is used on unsupported platforms.
 */
export function createCloudflareTokenStore({ execFile = defaultExecFile, platform = process.platform } = {}) {
  function assertSupported() {
    if (platform !== 'darwin') {
      throw createError('REMOTE_UNSUPPORTED', 'Remote access is supported only on macOS.');
    }
  }

  async function read() {
    assertSupported();
    try {
      const { stdout } = await runSecurity(execFile, [
        'find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w',
      ]);
      return String(stdout).trim() || undefined;
    } catch (error) {
      if (isMissingItem(error)) return undefined;
      throw reduceSecurityError(error);
    }
  }

  return {
    async has() {
      return (await read()) !== undefined;
    },

    read,

    async write(value) {
      assertSupported();
      const token = validateToken(value);
      try {
        await runSecurity(execFile, [
          'add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', token, '-U',
        ]);
      } catch (error) {
        throw reduceSecurityError(error);
      }
    },

    async remove() {
      assertSupported();
      try {
        await runSecurity(execFile, [
          'delete-generic-password', '-s', SERVICE, '-a', ACCOUNT,
        ]);
        return true;
      } catch (error) {
        if (isMissingItem(error)) return false;
        throw reduceSecurityError(error);
      }
    },
  };
}
