import {boundJson,decimal,frame,hex,ResponseFramer} from './codec';
describe('bounded public ingress and raw framing',()=>{
 it.each(['00','01','-1','+1','1.0',' 1','18446744073709551616','1'.repeat(21)])('rejects decimal %s',v=>expect(()=>decimal(v)).toThrow());
 it('accepts full u64 exactly',()=>expect(decimal('18446744073709551615')).toBe((1n<<64n)-1n));
 it.each(['A0','a','gg','00\n','0x00'])('rejects noncanonical hex %s',v=>expect(()=>hex(v,32)).toThrow());
 it('rejects frame and JSON bounds before decoding',()=>{expect(()=>frame('00'.repeat(8401))).toThrow();expect(()=>boundJson(' '.repeat(17201))).toThrow();expect(()=>boundJson('{"network":"é"}')).toThrow();});
 it.each([Buffer.from([0]),Buffer.from([13]),Buffer.from([128]),Buffer.alloc(18001,65)])('rejects hostile raw bytes',raw=>expect(()=>new ResponseFramer().push(raw)).toThrow());
 it('buffers copies and accepts one exact response',()=>{const f=new ResponseFramer();const first=Buffer.from('A\n');expect(f.push(first)).toBeUndefined();first.fill(0);expect(f.push(Buffer.from('B\n'.repeat(12))))?.toHaveLength(13);expect(()=>f.push(Buffer.from('C'))).toThrow();});
 it('rejects same-chunk trailing data and duplicate lines',()=>{expect(()=>new ResponseFramer().push(Buffer.from('A\n'.repeat(13)+'B'))).toThrow();expect(()=>new ResponseFramer().push(Buffer.from('A\n'.repeat(14)))).toThrow();});
});
