import assert from 'node:assert/strict';
import test from 'node:test';

import { createCloudflareClient } from '../src/remote/cloudflare.js';

const apiBase = 'https://cloudflare.test/client/v4';
const token = 'sensitive-cloudflare-token';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchRecorder(replies) {
  const requests = [];
  return {
    requests,
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      const next = replies.shift();
      return typeof next === 'function' ? next(url, options) : next;
    },
  };
}

test('authorizes requests, verifies the token, and paginates zones', async () => {
  const { fetch, requests } = fetchRecorder([
    response({ success: true, result: { id: 'token-id', status: 'active' } }),
    response({
      success: true,
      result: [{ id: 'zone-1', name: 'one.example', account: { id: 'account-1' } }],
      result_info: { page: 1, total_pages: 2 },
    }),
    response({
      success: true,
      result: [{ id: 'zone-2', name: 'two.example', account: { id: 'account-2' } }],
      result_info: { page: 2, total_pages: 2 },
    }),
  ]);
  const client = createCloudflareClient({ fetch, token, apiBase });

  await client.verifyToken();
  const zones = await client.listZones();

  assert.deepEqual(zones.map(({ id }) => id), ['zone-1', 'zone-2']);
  assert.equal(requests[0].url, `${apiBase}/user/tokens/verify`);
  assert.equal(requests[0].options.headers.authorization, `Bearer ${token}`);
  assert.equal(new URL(requests[1].url).searchParams.get('page'), '1');
  assert.equal(new URL(requests[2].url).searchParams.get('page'), '2');
  for (const request of requests) {
    assert.equal(request.options.headers.authorization, `Bearer ${token}`);
    assert.equal(request.url.includes(token), false);
  }
});

test('reduces Cloudflare errors without exposing the token', async () => {
  const { fetch } = fetchRecorder([
    response({
      success: false,
      errors: [{ code: 1000, message: `bad token ${token}` }],
    }, 403),
  ]);
  const client = createCloudflareClient({ fetch, token, apiBase });

  await assert.rejects(client.verifyToken(), (error) => {
    assert.equal(error.code, 'TOKEN_INVALID');
    assert.equal(error.status, 403);
    assert.equal(error.message.includes(token), false);
    assert.match(error.message, /Cloudflare rejected the API token/i);
    return true;
  });
});

test('creates and configures Cloudflare-managed tunnels and proxied DNS routes', async () => {
  const { fetch, requests } = fetchRecorder([
    response({ success: true, result: { id: 'tunnel-1', name: 'agent-remote', config_src: 'cloudflare' } }),
    response({ success: true, result: {} }),
    response({ success: true, result: 'tunnel-run-token' }),
    response({ success: true, result: { id: 'dns-1', type: 'CNAME', name: 'remote.example.com' } }),
  ]);
  const client = createCloudflareClient({ fetch, token, apiBase });

  const tunnel = await client.createTunnel('account-1', 'agent-remote');
  await client.configureTunnel('account-1', 'tunnel-1', 'remote.example.com', 'http://127.0.0.1:3001');
  const tunnelToken = await client.getTunnelToken('account-1', 'tunnel-1');
  const record = await client.createDnsRoute('zone-1', 'remote.example.com', 'tunnel-1');

  assert.equal(tunnel.id, 'tunnel-1');
  assert.equal(tunnelToken, 'tunnel-run-token');
  assert.equal(record.id, 'dns-1');
  assert.equal(requests[0].url, `${apiBase}/accounts/account-1/cfd_tunnel`);
  assert.deepEqual(JSON.parse(requests[0].options.body), { name: 'agent-remote', config_src: 'cloudflare' });
  assert.equal(requests[1].url, `${apiBase}/accounts/account-1/cfd_tunnel/tunnel-1/configurations`);
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    config: {
      ingress: [
        { hostname: 'remote.example.com', service: 'http://127.0.0.1:3001' },
        { service: 'http_status:404' },
      ],
    },
  });
  assert.equal(requests[2].url, `${apiBase}/accounts/account-1/cfd_tunnel/tunnel-1/token`);
  assert.equal(requests[3].url, `${apiBase}/zones/zone-1/dns_records`);
  assert.deepEqual(JSON.parse(requests[3].options.body), {
    type: 'CNAME',
    name: 'remote.example.com',
    content: 'tunnel-1.cfargotunnel.com',
    proxied: true,
    ttl: 1,
  });
});

test('looks up exact hostnames and resources, then deletes only supplied IDs', async () => {
  const { fetch, requests } = fetchRecorder([
    response({ success: true, result: [{ id: 'dns-1', name: 'remote.example.com', type: 'CNAME' }] }),
    response({ success: true, result: { id: 'tunnel-1', name: 'agent-remote' } }),
    response({ success: true, result: { id: 'dns-1', name: 'remote.example.com' } }),
    response({ success: true, result: {} }),
    response({ success: true, result: {} }),
  ]);
  const client = createCloudflareClient({ fetch, token, apiBase });

  const hostname = await client.checkHostname('zone-1', 'remote.example.com');
  assert.deepEqual(hostname, {
    hostname: 'remote.example.com',
    records: [{ id: 'dns-1', name: 'remote.example.com', type: 'CNAME' }],
  });
  assert.equal((await client.getTunnel('account-1', 'tunnel-1')).id, 'tunnel-1');
  assert.equal((await client.getDnsRecord('zone-1', 'dns-1')).id, 'dns-1');
  await client.deleteDnsRoute('zone-1', 'dns-1');
  await client.deleteTunnel('account-1', 'tunnel-1');

  const lookup = new URL(requests[0].url);
  assert.equal(lookup.pathname, '/client/v4/zones/zone-1/dns_records');
  assert.equal(lookup.searchParams.get('name'), 'remote.example.com');
  assert.equal(lookup.searchParams.get('per_page'), '100');
  assert.equal(requests[3].options.method, 'DELETE');
  assert.equal(requests[4].options.method, 'DELETE');
});

test('throws safe errors for non-success responses and accepts only supported API bases', async () => {
  const { fetch } = fetchRecorder([
    response({ success: false, errors: [{ message: `backend detail ${token}` }] }, 500),
  ]);
  const client = createCloudflareClient({ fetch, token, apiBase });

  await assert.rejects(client.deleteTunnel('account-1', 'tunnel-1'), (error) => {
    assert.equal(error.code, 'CLOUDFLARE_API_ERROR');
    assert.equal(error.status, 500);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  assert.throws(() => createCloudflareClient({ fetch, token, apiBase: 'https://example.invalid/v4' }), /api base/i);
});

test('uses the official API base by default and rejects oversized responses before parsing', async () => {
  const { fetch, requests } = fetchRecorder([
    new Response('{}', { status: 200, headers: { 'content-length': String(64 * 1024 + 1) } }),
  ]);
  const client = createCloudflareClient({ fetch, token });

  await assert.rejects(client.verifyToken(), /oversized response/i);
  assert.equal(requests[0].url, 'https://api.cloudflare.com/client/v4/user/tokens/verify');
});
