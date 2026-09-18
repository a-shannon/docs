import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash, ECDH } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
function shape(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length!==fields.length || fields.some(key=>{
        const descriptor=Object.getOwnPropertyDescriptor(value,key);
        return !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor,'value');
      })) throw Error(label + ':schema');
}
function text(value, label) {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw Error(label + ':text');
}
function hex(value, bytes, label) {
  if (typeof value !== 'string' || !new RegExp('^[0-9a-f]{' + bytes * 2 + '}$').test(value)) throw Error(label + ':hex');
}
export function canonicalAssignment(value) {
  const normalize = item => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (Number.isSafeInteger(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (item && Object.getPrototypeOf(item) === Object.prototype)
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    throw Error('canonical:value');
  };
  return JSON.stringify(normalize(value));
}
function configBytes(config) {
  const backed=Object.hasOwn(config ?? {},'backingPolicy');
  shape(config, ['custodyDomain','guardKey','committeeKeys','quorum','maxFaults','activationId','policyEpoch','policyDigest',...(backed?['backingPolicy']:[])], 'config');
  if(backed && !['single-deposit-v1','single-deposit-v2'].includes(config.backingPolicy))throw Error('config:backing-policy');
  for (const name of ['custodyDomain','activationId','policyEpoch']) text(config[name], name);
  hex(config.policyDigest, 32, 'policyDigest');
  if (!Array.isArray(config.committeeKeys) || config.committeeKeys.length !== 4 ||
      config.quorum !== 3 || config.maxFaults !== 1 ||
      2 * config.quorum <= config.committeeKeys.length + config.maxFaults) throw Error('config:quorum');
  for (const key of config.committeeKeys) {
    hex(key, 33, 'committeeKey');
    if (!/^(02|03)/.test(key)) throw Error('committeeKey:encoding');
    try { if (ECDH.convertKey(key, 'secp256k1', 'hex', 'hex', 'compressed') !== key) throw Error(); }
    catch { throw Error('committeeKey:point'); }
  }
  if (new Set(config.committeeKeys).size !== 4 || !config.committeeKeys.includes(config.guardKey)) throw Error('config:guard');
  return canonicalAssignment(config);
}
export function assignmentConfigDigest(config) { return hash(configBytes(config)); }
export function committeeConfigDigest(config) {
  configBytes(config);
  const {guardKey: _guardKey, ...common}=config;
  return hash(canonicalAssignment(common));
}
/** Exact stable descriptor from fresh native/proof admission, not its mutable snapshot.
 * Monero's committee digest is retained separately from the Ergo binding digest.
 * Source verification remains the guard's responsibility before assignment. */
function v2BackingIdentity(backing) {
  shape(backing, ['version','genesis','committeeDigest','vaultSpend','vaultAddress',
    'intentHash','txId','blockHash','blockHeight','outputIndex','globalIndex',
    'outputKey','keyImage','amountAtomic','destinationNetwork','destinationAsset',
    'recipient','creditedAtomic'], 'backing');
  if (backing.version !== 2) throw Error('backing:version');
  for (const name of ['genesis','committeeDigest','vaultSpend','intentHash','txId',
    'blockHash','outputKey','keyImage','destinationAsset']) hex(backing[name],32,'backing:'+name);
  for (const name of ['vaultAddress','destinationNetwork','recipient']) text(backing[name],'backing:'+name);
  for (const name of ['blockHeight','outputIndex','globalIndex']) {
    if (!Number.isSafeInteger(backing[name]) || backing[name] < 0 || Object.is(backing[name],-0))
      throw Error('backing:'+name+':safe-integer');
  }
  for (const name of ['amountAtomic','creditedAtomic']) {
    if (typeof backing[name] !== 'string' || !/^[1-9][0-9]{0,19}$/.test(backing[name]) ||
        BigInt(backing[name]) > 18446744073709551615n) throw Error('backing:'+name+':uint64');
  }
  // Neither committee epoch nor block occurrence may reset economic uniqueness.
  return `monero:key-image:${backing.genesis}:${backing.vaultSpend}:${backing.keyImage}`;
}
function v2BackingNullifier(backing, outputs, binding) {
  const identity=v2BackingIdentity(backing);
  if (outputs.length !== 1 || backing.outputKey !== outputs[0].publicKey ||
      backing.intentHash !== binding.sourceIntentDigest) throw Error('backing:request-binding');
  return identity;
}
function requestBytes(request, config, committeeDigest) {
  const backed=['single-deposit-v1','single-deposit-v2'].includes(config.backingPolicy);
  shape(request, ['binding','outputs',...(backed?['backing']:[])], 'request');
  shape(request.binding, ['obligationId','creditTransactionDigest','sourceIntentDigest','triggerBoxId','policyDigest','committeeDigest'], 'binding');
  const b = request.binding;
  text(b.obligationId, 'obligationId');
  for (const name of ['creditTransactionDigest','sourceIntentDigest','triggerBoxId','policyDigest','committeeDigest']) hex(b[name],32,name);
  if (b.policyDigest !== config.policyDigest || b.committeeDigest !== committeeDigest) throw Error('binding:context');
  if (!Array.isArray(request.outputs) || !request.outputs.length || request.outputs.length > 128) throw Error('outputs:count');
  const outputs = request.outputs.map(output => {
    shape(output, ['sourceNetwork','publicKey'], 'output');
    if (!['mainnet','testnet','stagenet'].includes(output.sourceNetwork)) throw Error('output:network');
    hex(output.publicKey,32,'outputKey');
    return { sourceNetwork:output.sourceNetwork, publicKey:output.publicKey,
      economicId:`monero:output-key:${output.sourceNetwork}:${output.publicKey}` };
  }).sort((a,b) => a.economicId < b.economicId ? -1 : a.economicId > b.economicId ? 1 : 0);
  if (new Set(outputs.map(o => o.economicId)).size !== outputs.length) throw Error('outputs:duplicate');
  let nullifierId;
  if(config.backingPolicy==='single-deposit-v2'){
    nullifierId=v2BackingNullifier(request.backing,outputs,b);
  }else if(backed){
    const x=request.backing;
    shape(x,['version','genesis','vaultSpend','vaultAddress','intentHash','txid','outputIndex','globalIndex','publicKey','keyImage','amountAtomic','destinationNetwork','destinationAsset','recipient','creditedAtomic'],'backing');
    if(x.version!==1)throw Error('backing:version');
    for(const name of ['genesis','vaultSpend','intentHash','txid','publicKey','keyImage','destinationAsset'])hex(x[name],32,'backing:'+name);
    for(const name of ['vaultAddress','destinationNetwork','recipient'])text(x[name],'backing:'+name);
    for(const name of ['outputIndex','globalIndex','amountAtomic','creditedAtomic']){
      if(typeof x[name]!=='string' || !/^(0|[1-9][0-9]{0,19})$/.test(x[name]) || BigInt(x[name])>18446744073709551615n ||
        (['amountAtomic','creditedAtomic'].includes(name) && x[name]==='0'))throw Error('backing:'+name+':uint64');
    }
    if(outputs.length!==1 || x.publicKey!==outputs[0].publicKey || x.intentHash!==b.sourceIntentDigest)throw Error('backing:request-binding');
    nullifierId=`monero:key-image:${x.genesis}:${x.vaultSpend}:${x.keyImage}`;
  }
  const bytes = canonicalAssignment({binding:b,outputs,...(backed?{backing:request.backing}:{})});
  return {bytes,digest:hash(bytes),outputs,binding:b,nullifierId};
}
function settlementBytes(value){
  const names=['reservationId','reservationHash','requestDigest','selectionDigest','bindingDigest','expectationDigest'];
  shape(value,names,'settlement');for(const name of names)hex(value[name],32,'settlement:'+name);
  const bytes=canonicalAssignment(value);return {bytes,digest:hash(bytes)};
}

/** Guard-owned durable anti-equivocation state. Caller owns source/payment verification.
 * No release, epoch migration, standalone signing authority, or rollback detection. */
export class MoneroCreditAssignment {
  #db; #config; #configBytes; #digest; #committeeDigest; #path; #identity; #readOnly; #closed = false;
  static create(file, config) { return new MoneroCreditAssignment(file, config, true); }
  static open(file, config) { return new MoneroCreditAssignment(file, config, false); }
  static openReadOnly(file, config) { return new MoneroCreditAssignment(file, config, false, true); }
  constructor(file, config, create, readOnly=false) {
    const bytes = configBytes(config);
    if (typeof readOnly!=='boolean' || (readOnly && create)) throw Error('custody:read-only');
    if (typeof file !== 'string' || !isAbsolute(file)) throw Error('custody:absolute-path');
    // Exclusive creation is explicit; open never interprets missing state as fresh.
    const fd = openSync(file, create ? 'wx' : readOnly ? 'r' : 'r+'); closeSync(fd);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('custody:regular-file');
    this.#path=file; this.#identity={dev:stat.dev,ino:stat.ino}; this.#readOnly=readOnly;
    this.#config=structuredClone(config); this.#configBytes=bytes; this.#digest=hash(bytes); this.#committeeDigest=committeeConfigDigest(config);
    const db = new DatabaseSync(file,{readOnly}); this.#db=db;
    try {
      db.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;');
      if (!readOnly) db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=EXTRA;');
      if ((!readOnly && db.prepare('PRAGMA synchronous').get().synchronous !== 3) ||
          db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') throw Error('custody:durability');
      if (create) this.#transaction(() => {
        db.exec(`CREATE TABLE metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,config TEXT NOT NULL,revision INTEGER NOT NULL);
          CREATE TABLE claims(obligationId TEXT PRIMARY KEY,requestDigest TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('assigned','invalidated')),reason TEXT NOT NULL,settlementDigest TEXT);
          CREATE TABLE outputs(economicId TEXT PRIMARY KEY,obligationId TEXT NOT NULL REFERENCES claims(obligationId));
          CREATE TABLE nullifiers(nullifierId TEXT PRIMARY KEY,obligationId TEXT NOT NULL UNIQUE REFERENCES claims(obligationId));
          CREATE TABLE settlements(obligationId TEXT PRIMARY KEY REFERENCES claims(obligationId),settlementDigest TEXT NOT NULL,settlement TEXT NOT NULL);`);
        db.prepare('INSERT INTO metadata VALUES(1,2,?,0)').run(bytes);
      });
      this.#readTransaction(() => this.#verify());
    } catch (error) { db.close(); this.#closed=true; throw error; }
  }
  #live() {
    if (this.#closed) throw Error('custody:closed');
    const stat=lstatSync(this.#path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev!==this.#identity.dev || stat.ino!==this.#identity.ino) throw Error('custody:file-replaced');
  }
  #verify() {
    this.#live();
    const m=this.#db.prepare('SELECT * FROM metadata').all();
    if (m.length!==1 || m[0].singleton!==1 || m[0].version!==2 || m[0].config!==this.#configBytes ||
        !Number.isSafeInteger(m[0].revision) || m[0].revision<0) throw Error('custody:config-drift');
    if (this.#db.prepare('PRAGMA quick_check').get().quick_check!=='ok' ||
        this.#db.prepare('PRAGMA foreign_key_check').all().length) throw Error('custody:integrity');
    const claims=this.#db.prepare('SELECT * FROM claims').all();
    const outputs=this.#db.prepare('SELECT * FROM outputs ORDER BY economicId').all();
    const nullifiers=this.#db.prepare('SELECT * FROM nullifiers ORDER BY nullifierId').all();
    const settlements=this.#db.prepare('SELECT * FROM settlements').all();
    for (const c of claims) {
      const parsed=JSON.parse(c.request), request=requestBytes({binding:parsed.binding,outputs:parsed.outputs.map(({sourceNetwork,publicKey})=>({sourceNetwork,publicKey})),
        ...(Object.hasOwn(parsed,'backing')?{backing:parsed.backing}:{})},this.#config,this.#committeeDigest);
      if (request.bytes!==c.request || request.digest!==c.requestDigest || request.binding.obligationId!==c.obligationId ||
          !['assigned','invalidated'].includes(c.status) || (c.status==='assigned' ? c.reason!=='' : !c.reason)) throw Error('custody:claim-integrity');
      const actual=outputs.filter(o=>o.obligationId===c.obligationId).map(o=>o.economicId);
      if (canonicalAssignment(actual)!==canonicalAssignment(request.outputs.map(o=>o.economicId))) throw Error('custody:output-integrity');
      const images=nullifiers.filter(n=>n.obligationId===c.obligationId).map(n=>n.nullifierId);
      if(canonicalAssignment(images)!==canonicalAssignment(request.nullifierId?[request.nullifierId]:[]))throw Error('custody:nullifier-integrity');
      const rows=settlements.filter(s=>s.obligationId===c.obligationId);
      if(c.settlementDigest===null){if(rows.length)throw Error('custody:settlement-integrity');}
      else{
        hex(c.settlementDigest,32,'custody:settlement-digest');
        if(!request.nullifierId || rows.length!==1)throw Error('custody:settlement-integrity');
        const stored=settlementBytes(JSON.parse(rows[0].settlement));
        if(stored.bytes!==rows[0].settlement || stored.digest!==rows[0].settlementDigest || stored.digest!==c.settlementDigest)throw Error('custody:settlement-integrity');
      }
    }
  }
  #transaction(fn) {
    this.#writable(); this.#db.exec('BEGIN IMMEDIATE');
    try { const result=fn(); this.#db.exec('COMMIT'); return result; }
    catch(error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #writable() {
    this.#live();
    if (this.#readOnly) throw Error('custody:read-only');
  }
  #readTransaction(fn) {
    this.#live(); this.#db.exec('BEGIN');
    try { const result=fn(); this.#live(); this.#db.exec('COMMIT'); return result; }
    catch(error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #bump() {
    if (this.#db.prepare('UPDATE metadata SET revision=revision+1 WHERE singleton=1 AND revision<9007199254740991').run().changes!==1) throw Error('custody:revision-exhausted');
  }
  get configDigest() { return this.#digest; }
  /** Current economic membership only, never a reservation or signing authority. */
  inspectNovelty(value) {
    this.#live(); shape(value,['sourceNetwork','backing'],'novelty');
    if (this.#config.backingPolicy!=='single-deposit-v2') throw Error('novelty:profile');
    if (!['mainnet','testnet','stagenet'].includes(value.sourceNetwork)) throw Error('output:network');
    const nullifierId=v2BackingIdentity(value.backing);
    if (this.#config.custodyDomain!=='local-monero-genesis:'+value.backing.genesis) throw Error('novelty:custody-domain');
    const economicId=`monero:output-key:${value.sourceNetwork}:${value.backing.outputKey}`;
    return this.#readTransaction(() => {
      this.#verify();
      const output=this.#db.prepare('SELECT obligationId FROM outputs WHERE economicId=?').get(economicId);
      const image=this.#db.prepare('SELECT obligationId FROM nullifiers WHERE nullifierId=?').get(nullifierId);
      return {status:output || image?'claimed':'new',checkpoint:this.#checkpoint(),identity:{...this.#identity}};
    });
  }
  #observe(r){
    const claim=this.#db.prepare('SELECT * FROM claims WHERE obligationId=?').get(r.binding.obligationId);
    if(!claim){
      const find=this.#db.prepare('SELECT obligationId FROM outputs WHERE economicId=?');
      const image=r.nullifierId && this.#db.prepare('SELECT obligationId FROM nullifiers WHERE nullifierId=?').get(r.nullifierId);
      throw Error(image || r.outputs.some(o=>find.get(o.economicId))?'assignment:conflict':'assignment:missing');
    }
    if(claim.request!==r.bytes || claim.requestDigest!==r.digest)throw Error('assignment:conflict');
    return {status:claim.status,requestDigest:r.digest,obligationId:claim.obligationId,reason:claim.reason};
  }
  /** Exact custody observation only; terminal state is not usable authorization. */
  observeAssignment(request) {
    this.#live(); const r=requestBytes(request,this.#config,this.#committeeDigest);
    this.#db.exec('BEGIN');
    try {
      this.#verify();
      const observation=this.#observe(r);
      this.#db.exec('COMMIT');return observation;
    } catch(error) {this.#db.exec('ROLLBACK');throw error;}
  }
  /** Never assigns or recreates a claim, including after restart. */
  assertAssigned(request) {
    const observation=this.observeAssignment(request);
    if (observation.status!=='assigned') throw Error('assignment:invalidated');
    return observation;
  }
  assign(request) {
    this.#writable(); const r=requestBytes(request,this.#config,this.#committeeDigest);
    return this.#transaction(() => {
      this.#verify();
      const previous=this.#db.prepare('SELECT * FROM claims WHERE obligationId=?').get(r.binding.obligationId);
      if (previous) {
        if (previous.request!==r.bytes || previous.requestDigest!==r.digest) return {status:'conflict'};
        if (previous.status==='invalidated') return {status:'invalidated',requestDigest:r.digest};
        return {status:'existing',requestDigest:r.digest};
      }
      const find=this.#db.prepare('SELECT obligationId FROM outputs WHERE economicId=?');
      if (r.outputs.some(o=>find.get(o.economicId))) return {status:'conflict'};
      if(r.nullifierId && this.#db.prepare('SELECT obligationId FROM nullifiers WHERE nullifierId=?').get(r.nullifierId))return {status:'conflict'};
      this.#db.prepare("INSERT INTO claims VALUES(?,?,?,'assigned','',NULL)").run(r.binding.obligationId,r.digest,r.bytes);
      const insert=this.#db.prepare('INSERT INTO outputs VALUES(?,?)');
      for (const output of r.outputs) insert.run(output.economicId,r.binding.obligationId);
      if(r.nullifierId)this.#db.prepare('INSERT INTO nullifiers VALUES(?,?)').run(r.nullifierId,r.binding.obligationId);
      this.#bump(); return {status:'assigned',requestDigest:r.digest};
    });
  }
  #settlement(request,settlement,mode){
    this.#writable();
    const r=requestBytes(request,this.#config,this.#committeeDigest),s=settlementBytes(settlement);
    if(!r.nullifierId)throw Error('settlement:backing-required');
    return this.#transaction(()=>{
      this.#verify();const observation=this.#observe(r);
      if(mode!=='observe' && observation.status!=='assigned')throw Error('assignment:invalidated');
      const previous=this.#db.prepare('SELECT * FROM settlements WHERE obligationId=?').get(r.binding.obligationId);
      if(previous){
        if(previous.settlement!==s.bytes || previous.settlementDigest!==s.digest)throw Error('settlement:conflict');
      }else{
        if(mode!=='reserve')throw Error('settlement:missing');
        this.#db.prepare('INSERT INTO settlements VALUES(?,?,?)').run(r.binding.obligationId,s.digest,s.bytes);
        this.#db.prepare('UPDATE claims SET settlementDigest=? WHERE obligationId=?').run(s.digest,r.binding.obligationId);
        this.#bump();
      }
      return Object.freeze({...observation,status:mode==='reserve'?(previous?'existing':'reserved'):observation.status,
        settlementDigest:s.digest,settlement:Object.freeze(JSON.parse(s.bytes))});
    });
  }
  /** Permanently encumber this backed claim with one exact retained withdrawal. */
  reserveSettlement(request,settlement){return this.#settlement(request,settlement,'reserve');}
  assertSettlement(request,settlement){return this.#settlement(request,settlement,'assert');}
  /** Retained observation after invalidation never restores signing authority. */
  observeSettlement(request,settlement){return this.#settlement(request,settlement,'observe');}
  invalidate(obligationId, reason) {
    this.#writable();
    text(obligationId,'obligationId'); text(reason,'reason');
    return this.#transaction(() => {
      this.#verify();
      const claim=this.#db.prepare('SELECT status FROM claims WHERE obligationId=?').get(obligationId);
      if (!claim) return {status:'missing'};
      if (claim.status!=='invalidated') {
        this.#db.prepare("UPDATE claims SET status='invalidated',reason=? WHERE obligationId=?").run(reason,obligationId); this.#bump();
      }
      return {status:'invalidated'};
    });
  }
  /** Observation for caller continuity; a valid older snapshot cannot be detected locally. */
  checkpoint() {
    return this.#readTransaction(() => {
      this.#verify(); return this.#checkpoint();
    });
  }
  #checkpoint() {
      const revision=this.#db.prepare('SELECT revision FROM metadata').get().revision;
      const claims=this.#db.prepare('SELECT * FROM claims ORDER BY obligationId').all().map(row=>({...row}));
      const outputs=this.#db.prepare('SELECT * FROM outputs ORDER BY economicId').all().map(row=>({...row}));
      const nullifiers=this.#db.prepare('SELECT * FROM nullifiers ORDER BY nullifierId').all().map(row=>({...row}));
      const settlements=this.#db.prepare('SELECT * FROM settlements ORDER BY obligationId').all().map(row=>({...row}));
      return {configDigest:this.#digest,revision,claims:claims.length,outputs:outputs.length,nullifiers:nullifiers.length,settlements:settlements.length,
        stateDigest:hash(canonicalAssignment({configDigest:this.#digest,revision,claims,outputs,nullifiers,settlements}))};
  }
  close() { if (!this.#closed) { this.#db.close(); this.#closed=true; } }
}
