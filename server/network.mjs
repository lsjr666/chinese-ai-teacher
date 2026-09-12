import os from 'node:os';

const ignoredPrefixes = ['127.', '169.254.', '198.18.', '100.64.'];

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

export function pickLanAddresses(interfaces = os.networkInterfaces()) {
  return Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter(
      (entry) =>
        entry.family === 'IPv4' &&
        !entry.internal &&
        !ignoredPrefixes.some((prefix) => entry.address.startsWith(prefix)) &&
        isPrivateIpv4(entry.address),
    )
    .map((entry) => entry.address)
    .filter((address, index, all) => all.indexOf(address) === index);
}

export function getConnectionInfo(port = 8787) {
  const addresses = pickLanAddresses();
  return {
    port,
    addresses,
    urls: addresses.map((address) => `http://${address}:${port}`),
  };
}
