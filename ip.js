// Addresses as numbers, for masking and for sorting.

// bits returns an address as a number, and its size in bits.
export function bits(ip) {
  ip = ip.split('%')[0] // an IPv6 zone like %en0
  if (!ip.includes(':')) return [ip.split('.').reduce((n, b) => (n << 8n) + BigInt(b), 0n), 32]
  ip = new URL(`http://[${ip}]`).hostname.slice(1, -1) // traceroute6 writes some addresses with an IPv4 tail, like ::8.8.8.8
  const [head, tail] = ip.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  return [groups.reduce((n, g) => (n << 16n) + BigInt('0x' + g), 0n), 128]
}

function address(n, size) {
  if (size === 32) return [24n, 16n, 8n, 0n].map(s => (n >> s) & 255n).join('.')
  const groups = Array.from({ length: 8 }, (_, i) => ((n >> BigInt(112 - 16 * i)) & 0xffffn).toString(16))
  return new URL(`http://[${groups.join(':')}]`).hostname.slice(1, -1) // URL shortens IPv6
}

// block returns the len-bit network ip is in, like 154.54.64.0/19, and the IPv4 netmask.
export function block(ip, len) {
  const [n, size] = bits(ip)
  const mask = ((1n << BigInt(size)) - 1n) ^ ((1n << BigInt(size - len)) - 1n)
  return { net: `${address(n & mask, size)}/${len}`, mask: size === 32 ? address(mask, 32) : undefined }
}

// key returns an address as big-endian bytes, which sort in address order.
export function key(ip) {
  const [n, size] = bits(ip)
  return Buffer.from(Array.from({ length: size / 8 }, (_, i) => Number((n >> BigInt(size - 8 - 8 * i)) & 255n)))
}
