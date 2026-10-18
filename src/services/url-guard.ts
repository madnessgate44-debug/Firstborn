import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';


function isPrivateAddress(addr: string, allowLoopback: boolean): boolean {
  const a = addr.toLowerCase();
  if (a.includes(':')) {
    if (a === '::1') return !allowLoopback;
    if (a === '::') return true;
    if (a.startsWith('::ffff:')) {
      // WHATWG URL normalizes the embedded IPv4 to hex ([::ffff:10.0.0.1] becomes
      // [::ffff:a00:1]), so accept both notations or the dotted check never runs.
      const tail = a.slice(7);
      if (tail.includes('.')) return isPrivateAddress(tail, allowLoopback);
      const [hi, lo] = tail.split(':').map((g) => Number.parseInt(g, 16));
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return isPrivateAddress(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`, allowLoopback);
      }
      return true;
    }
    return a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80');
  }
  const [x, y] = a.split('.').map(Number);
  if (x === 127) return !allowLoopback;
  return x === 0 || x === 10 || (x === 169 && y === 254) ||
    (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) ||
    (x === 100 && y >= 64 && y <= 127);
}


export async function assertPublicHttpUrl(raw: string, opts: { allowLoopback?: boolean } = {}): Promise<URL> {
  const allowLoopback = opts.allowLoopback ?? false;
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a, allowLoopback))) {
    throw new Error('Private, link-local or metadata addresses are blocked.');
  }
  return u;
}
