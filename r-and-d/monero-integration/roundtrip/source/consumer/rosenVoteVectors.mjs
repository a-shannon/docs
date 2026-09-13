import {ECDSA} from '@rosen-bridge/encryption';
import {Communicator} from '@rosen-bridge/communication';
import {blake2b} from 'blakejs';
import {randomBytes,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const destination=process.argv[2];
if(!destination)throw Error('Vector destination required');
const digest=text=>Buffer.from(blake2b(text,undefined,32)).toString('hex');
const txJson=JSON.stringify({eventId:'11'.repeat(32),network:'monero',txBytes:'00',txId:'22'.repeat(32),txType:'payment'});
const txDataHash=digest(txJson),timestamp=1789300800,protocolVersion='1.0.0';
const signer=new ECDSA(randomBytes(32).toString('hex'));
const publicKey=await signer.getPk();
const payload=Communicator.generatePayloadToSign({txDataHash},timestamp,publicKey,protocolVersion);
if(payload!==JSON.stringify({txDataHash})+timestamp+publicKey+protocolVersion)throw Error('Upstream vote encoding drift');
const signature=await signer.sign(payload);
const changed=Buffer.from(signature,'hex');changed[10]^=1;
const order=BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const highS=signature.slice(0,64)+(order-BigInt('0x'+signature.slice(64))).toString(16).padStart(64,'0');
const variants=[['valid',signature,payload,publicKey],['signature-mutated',changed.toString('hex'),payload,publicKey],
  ['payload-mutated',signature,payload+'0',publicKey],['high-s',highS,payload,publicKey],['truncated',signature.slice(2),payload,publicKey]];
const cases=[];
for(const [name,sig,message,key]of variants){let accepted=false,throws=false;try{accepted=await signer.verify(message,sig,key);}catch{throws=true;}
  cases.push({name,signature:sig,payload:message,publicKey:key,accepted,throws});}
if(!cases[0].accepted||cases[1].accepted||cases[2].accepted||cases[4].accepted)throw Error('Unexpected verifier result');
const source=fileURLToPath(import.meta.resolve('@rosen-bridge/encryption'));
const result={schema:'rosen-vote-differential/v1',encryptionVersion:'1.0.1',entrySha256:createHash('sha256').update(readFileSync(source)).digest('hex'),
  txJson,txDataHash,timestamp,protocolVersion,publicKey,payload,prehash:digest(payload),signature,cases};
writeFileSync(destination,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({cases:cases.map(({name,accepted,throws})=>({name,accepted,throws})),privateMaterialExported:false}));
