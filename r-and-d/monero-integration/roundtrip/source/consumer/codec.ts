import { createHash } from 'node:crypto';
export const U64 = (1n << 64n) - 1n;
export function decimal(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) throw Error('Invalid decimal');
  const n = BigInt(value); if (n > U64) throw Error('Overflow'); return n;
}
export function hex(value: string, maxBytes: number, exact?: number): Buffer {
  if (typeof value !== 'string' || value.length > maxBytes*2 || !/^(?:[0-9a-f]{2})+$/.test(value) || (exact !== undefined && value.length !== exact*2)) throw Error('Invalid hex');
  const bytes = Buffer.from(value, 'hex'); if (bytes.toString('hex') !== value) throw Error('Noncanonical hex'); return bytes;
}
export function frame(value: string) {
  const bytes = hex(value,8400); if (bytes.length < 203 || !bytes.subarray(0,7).equals(Buffer.from([87,49,72,67,1,1,1]))) throw Error('Invalid frame profile');
  const length = bytes.readUInt32LE(135); if (!length || length >8192 || bytes.length !==203+length) throw Error('Invalid frame length');
  const id = createHash('sha256').update('W1h/local-native-proposal/v1\0','ascii').update(bytes.subarray(0,-32)).digest('hex');
  if (id !== bytes.subarray(-32).toString('hex')) throw Error('Invalid proposal checksum');
  return {bytes,eventId:bytes.subarray(39,71).toString('hex'),id};
}
export function canonical(eventId: string, txBytes: string, txId: string): string {
  return JSON.stringify({eventId,network:'monero',txBytes,txId,txType:'payment'});
}
// Full five-field validation occurs before the original serializer's first parse.
export function boundJson(text: string) {
  if (typeof text !== 'string' || text.length > 17200 || !/^[\x20-\x7e]+$/.test(text)) throw Error('Invalid JSON bounds');
  const p: unknown = JSON.parse(text);
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('Invalid JSON object');
  const x = p as Record<string,unknown>;
  if (Object.keys(x).join(',') !== 'eventId,network,txBytes,txId,txType' || x.network !== 'monero' || x.txType !== 'payment' || typeof x.eventId !== 'string' || typeof x.txId !== 'string' || typeof x.txBytes !== 'string') throw Error('Invalid fields');
  hex(x.eventId,32,32); hex(x.txId,32,32); const parsed=frame(x.txBytes);
  if (parsed.eventId !== x.eventId || parsed.id !== x.txId || text !== canonical(x.eventId,x.txBytes,x.txId)) throw Error('Noncanonical JSON');
  return {json:text,...parsed};
}
export class ResponseFramer {
  #chunks: Buffer[]=[]; #size=0; #lines=0; #done=false;
  push(raw: Buffer): string[] | undefined {
    if (this.#done || !raw.length || this.#size+raw.length>18000) throw Error('Unexpected response data');
    for (const b of raw) { if (b ===10) this.#lines++; else if(b<33 || b>126) throw Error('Invalid response ASCII'); }
    this.#size+=raw.length; this.#chunks.push(Buffer.from(raw));
    if(this.#lines>13) throw Error('Trailing response');
    if(this.#lines===13) {
      if(raw[raw.length-1]!==10) throw Error('Trailing response');
      this.#done=true; const all=Buffer.concat(this.#chunks); this.#chunks=[]; return all.toString('ascii').slice(0,-1).split('\n');
    }
    return undefined;
  }
}
