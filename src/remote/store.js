import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function settingsRow(row) {
  return {
    installationId: row.installation_id,
    accountId: row.account_id,
    zoneId: row.zone_id,
    zoneName: row.zone_name,
    hostname: row.hostname,
    tunnelId: row.tunnel_id,
    tunnelName: row.tunnel_name,
    dnsRecordId: row.dns_record_id,
    dnsTarget: row.dns_target,
    desiredState: row.desired_state,
    updatedAt: row.updated_at,
  };
}

function deviceRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    publicKeyJwk: JSON.parse(row.public_key_jwk),
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function serializePublicKeyJwk(publicKeyJwk) {
  if (!publicKeyJwk || typeof publicKeyJwk !== 'object' || Array.isArray(publicKeyJwk)) {
    throw new TypeError('publicKeyJwk must be an object');
  }
  const serialized = canonicalJson(publicKeyJwk);
  if (serialized === undefined) throw new TypeError('publicKeyJwk must be JSON-serializable');
  return serialized;
}

export function createRemoteStore(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS remote_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      installation_id TEXT NOT NULL UNIQUE,
      account_id TEXT,
      zone_id TEXT,
      zone_name TEXT,
      hostname TEXT,
      tunnel_id TEXT,
      tunnel_name TEXT,
      dns_record_id TEXT,
      dns_target TEXT,
      desired_state TEXT NOT NULL DEFAULT 'stopped'
        CHECK (desired_state IN ('stopped', 'running')),
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remote_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      public_key_jwk TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    );
  `);

  const statements = {
    getSettings: database.prepare('SELECT * FROM remote_settings WHERE singleton = 1'),
    insertSettings: database.prepare('INSERT OR IGNORE INTO remote_settings (singleton, installation_id, updated_at) VALUES (1, ?, ?)'),
    saveNamedTunnel: database.prepare(`
      UPDATE remote_settings SET
        account_id = ?, zone_id = ?, zone_name = ?, hostname = ?,
        tunnel_id = ?, tunnel_name = ?, dns_record_id = ?, dns_target = ?, updated_at = ?
      WHERE singleton = 1
    `),
    setDesiredState: database.prepare('UPDATE remote_settings SET desired_state = ?, updated_at = ? WHERE singleton = 1'),
    clearNamedTunnel: database.prepare(`
      UPDATE remote_settings SET
        account_id = NULL, zone_id = NULL, zone_name = NULL, hostname = NULL,
        tunnel_id = NULL, tunnel_name = NULL, dns_record_id = NULL, dns_target = NULL,
        desired_state = 'stopped', updated_at = ?
      WHERE singleton = 1
    `),
    listDevices: database.prepare('SELECT * FROM remote_devices ORDER BY created_at DESC, id ASC'),
    getActiveDevice: database.prepare('SELECT * FROM remote_devices WHERE id = ? AND revoked_at IS NULL'),
    insertDevice: database.prepare(`
      INSERT INTO remote_devices (id, name, public_key_jwk, fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    getDevice: database.prepare('SELECT * FROM remote_devices WHERE id = ?'),
    touchDevice: database.prepare('UPDATE remote_devices SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL'),
    revokeDevice: database.prepare('UPDATE remote_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
  };

  function transaction(action) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  transaction(() => statements.insertSettings.run(randomUUID(), Date.now()));

  return {
    getSettings() {
      return settingsRow(statements.getSettings.get());
    },

    saveNamedTunnel({
      accountId, zoneId, zoneName, hostname, tunnelId, tunnelName, dnsRecordId, dnsTarget,
    }) {
      transaction(() => statements.saveNamedTunnel.run(
        accountId, zoneId, zoneName, hostname, tunnelId, tunnelName, dnsRecordId, dnsTarget, Date.now(),
      ));
      return this.getSettings();
    },

    setDesiredState(state) {
      if (state !== 'stopped' && state !== 'running') throw new TypeError('desired state must be stopped or running');
      transaction(() => statements.setDesiredState.run(state, Date.now()));
    },

    clearNamedTunnel() {
      transaction(() => statements.clearNamedTunnel.run(Date.now()));
    },

    listDevices() {
      return statements.listDevices.all().map(deviceRow);
    },

    getActiveDevice(id) {
      return deviceRow(statements.getActiveDevice.get(id));
    },

    registerDevice({ id, name, publicKeyJwk, fingerprint, createdAt = Date.now() }) {
      const serializedJwk = serializePublicKeyJwk(publicKeyJwk);
      transaction(() => statements.insertDevice.run(id, name, serializedJwk, fingerprint, createdAt));
      return deviceRow(statements.getDevice.get(id));
    },

    touchDevice(id, usedAt = Date.now()) {
      return transaction(() => statements.touchDevice.run(usedAt, id).changes > 0);
    },

    revokeDevice(id, revokedAt = Date.now()) {
      return transaction(() => statements.revokeDevice.run(revokedAt, id).changes > 0);
    },

    close() {
      database.close();
    },
  };
}
