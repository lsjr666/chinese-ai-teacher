import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLanAddresses } from './network.mjs';

test('network address selection ignores loopback and tunnel interfaces', () => {
  const addresses = pickLanAddresses({
    Ethernet: [
      { family: 'IPv4', address: '192.168.43.20', internal: false },
    ],
    Tunnel: [
      { family: 'IPv4', address: '198.18.0.1', internal: false },
    ],
    Loopback: [
      { family: 'IPv4', address: '127.0.0.1', internal: true },
    ],
  });

  assert.deepEqual(addresses, ['192.168.43.20']);
});
