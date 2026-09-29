import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketClient } from '../features/markets/ui/market-client.mjs';

test('older running service gives a restart instruction instead of a generic missing API error', async () => {
  const client = createMarketClient({ fetchImpl: async () => new Response(JSON.stringify({ ok: false, message: 'API bulunamadı.' }), { status: 404 }) });
  await assert.rejects(client.status(), error => error.code === 'SERVICE_OUTDATED' && error.message.includes('Start-RoutePilot.cmd'));
});
