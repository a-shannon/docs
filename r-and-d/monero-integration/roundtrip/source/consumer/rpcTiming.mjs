import assert from 'node:assert/strict';
import http from 'node:http';
import {performance} from 'node:perf_hooks';

const ROUTES=new Set(['/json_rpc','/get_transactions','/get_outs','/send_raw_transaction','/is_key_image_spent']);
const METHODS=new Set(['get_info','hard_fork_info','generateblocks','get_block','get_block_header_by_height','get_fee_estimate']);
const MAX_BODY=2097152;

/** Local diagnostic forwarding; telemetry contains no request or response payloads. */
export async function openRpcTimingProxy({targetPort,onEvent,maxEvents=512,timeoutMs=60000}){
  assert(Number.isInteger(targetPort)&&targetPort>0&&targetPort<=65535,'Local target port');assert(Number.isInteger(maxEvents)&&maxEvents>0&&maxEvents<=65536);assert(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=120000);assert(onEvent===undefined||typeof onEvent==='function');
  const events=[],connections=new Set(),upstreamRequests=new Set();let closed=false;
  const server=http.createServer({maxHeaderSize:8192},(request,response)=>{
    const started=performance.now();let method=ROUTES.has(request.url)?request.url.slice(1):'rejected-route',amount,recorded=false,upstream;
    const deadline=setTimeout(()=>{record(504,upstream?'upstream-timeout':'request-timeout');upstream?.destroy();if(!response.destroyed){const payload=Buffer.from('RPC timing proxy timeout\n');response.writeHead(504,{'Content-Length':payload.length,Connection:'close'});response.end(payload);}},timeoutMs);
    function record(status,errorCategory){if(recorded)return;recorded=true;clearTimeout(deadline);const event={method,...(method==='generateblocks'&&amount!==undefined?{amount_of_blocks:amount}:{}),elapsedMs:Math.round((performance.now()-started)*1000)/1000,status,errorCategory};events.push(event);if(events.length>maxEvents)events.shift();try{onEvent?.(Object.freeze({...event}));}catch{}}
    function reject(status,category){record(status,category);if(!response.destroyed){const body=Buffer.from('RPC timing proxy refused\n');response.writeHead(status,{'Content-Type':'text/plain','Content-Length':body.length,Connection:'close'});response.end(body);}request.resume();}
    response.once('close',()=>{if(!response.writableFinished){record(null,'client-aborted');upstream?.destroy();}});
    if(closed){reject(503,'proxy-closed');return;}
    if(request.method!=='POST'||!ROUTES.has(request.url)){reject(403,'request-route');return;}
    const length=request.headers['content-length'];if(typeof length!=='string'||!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>MAX_BODY||request.headers['transfer-encoding']){reject(413,'request-bound');return;}
    let body=Buffer.alloc(0),tooLarge=false;
    request.on('error',()=>{record(null,'client-aborted');upstream?.destroy();});
    request.on('data',chunk=>{if(tooLarge)return;if(body.length+chunk.length>MAX_BODY){tooLarge=true;reject(413,'request-bound');return;}body=Buffer.concat([body,chunk]);});
    request.on('end',()=>{
      if(tooLarge||recorded||response.destroyed)return;if(body.length!==Number(length)){reject(400,'request-length');return;}
      if(request.url==='/json_rpc'){
        let value;try{value=JSON.parse(body.toString('utf8'));}catch{method='rejected-json-rpc';reject(400,'request-json');return;}
        if(!value||!METHODS.has(value.method)){method='rejected-json-rpc';reject(403,'request-method');return;}method=value.method;
        if(method==='generateblocks'){const count=value.params?.amount_of_blocks;if(!Number.isInteger(count)||count<1||count>60){reject(400,'request-mining-bound');return;}amount=count;}
      }
      const headers={...request.headers,host:'127.0.0.1:'+targetPort,connection:'close','content-length':String(body.length)};delete headers['transfer-encoding'];delete headers.upgrade;
      upstream=http.request({hostname:'127.0.0.1',port:targetPort,method:request.method,path:request.url,headers,agent:false},incoming=>{
        let output=Buffer.alloc(0),failed=false;
        incoming.on('data',chunk=>{if(failed)return;if(output.length+chunk.length>MAX_BODY){failed=true;record(502,'response-bound');incoming.destroy();upstream.destroy();if(!response.destroyed)response.destroy();return;}output=Buffer.concat([output,chunk]);});
        incoming.on('aborted',()=>{record(502,'upstream-aborted');if(!response.destroyed)response.destroy();});
        incoming.on('error',()=>{record(502,'upstream-response');if(!response.destroyed)response.destroy();});
        incoming.on('end',()=>{if(failed||response.destroyed)return;const status=incoming.statusCode??502;response.writeHead(status,{'Content-Type':incoming.headers['content-type']??'application/json','Content-Length':output.length,Connection:'close'});response.end(output);record(status,status===200?null:'upstream-http');});
      });
      upstreamRequests.add(upstream);upstream.once('close',()=>upstreamRequests.delete(upstream));
      upstream.setTimeout(timeoutMs,()=>{record(504,'upstream-timeout');upstream.destroy();if(!response.destroyed){const payload=Buffer.from('RPC timing proxy timeout\n');response.writeHead(504,{'Content-Length':payload.length,Connection:'close'});response.end(payload);}});
      upstream.once('error',error=>{if(recorded)return;const category=error.code==='ECONNREFUSED'?'upstream-refused':'upstream-transport';reject(502,category);});upstream.end(body);
    });
  });
  server.requestTimeout=timeoutMs;server.headersTimeout=Math.min(timeoutMs,10000);server.on('connection',socket=>{connections.add(socket);socket.once('close',()=>connections.delete(socket));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  return {port:server.address().port,events:()=>events.map(event=>({...event})),async close(){if(closed)return;closed=true;for(const upstream of upstreamRequests)upstream.destroy();for(const socket of connections)socket.destroy();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
