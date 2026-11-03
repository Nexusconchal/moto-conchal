import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import * as deposit from '../src/company-deposit.js';
import * as completion from '../src/delivery-completion.js';
export const source = fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
export const companyId = '19999990000', driverCpf = '12345678901';
export function harness(entries = {}) {
  const records = new Map(Object.entries(entries)); const calls = []; const routes = new Map(); let queue = Promise.resolve();
  const ref = path => ({ path, id:path.split('/').at(-1), get:async()=>snap(path),
    collection:name=>({doc:id=>ref(`${path}/${name}/${id}`)}), set:async(data)=>records.set(path,{...records.get(path),...data}) });
  const snap = path => ({ id:path.split('/').at(-1), exists:records.has(path), data:()=>records.get(path),ref:ref(path) });
  const db = {collection:name=>({doc:id=>ref(`${name}/${id || 'generated'}`)}), runTransaction:fn=>{
    const run = queue.then(async()=>{
      const writes=[]; let writing=false;
      const result=await fn({get:async r=>{assert.equal(writing,false,'all transaction reads must precede writes');return snap(r.path);},
        set:(r,data)=>{writing=true;writes.push([r,data]);},create:(r,data)=>{assert.equal(records.has(r.path),false);writing=true;writes.push([r,data]);},update:(r,data)=>{writing=true;writes.push([r,data]);}});
      writes.forEach(([r,data])=>records.set(r.path,{...records.get(r.path),...data})); return result;
    }); queue=run.catch(()=>{}); return run;
  }};
  const money=value=>Math.round(Number(value||0)*100)/100;
  const context=vm.createContext({...deposit,...completion,db,console,URL,Map,Set,Date,Number,String,Math,
    crypto,hashSecret:value=>crypto.createHash('sha256').update(value).digest('hex'),
    onlyDigits:value=>String(value||'').replace(/\D/g,''),money,cleanText:value=>String(value||'').trim(),timestampMs:Number,
    serializeFirestore:value=>value,adminStateCache:null,process:{env:{MP_OWNER_ACCESS_TOKEN:'test-only-token'}},
    requiredEnv:()=> 'test-only-token', mpFetch:async(path,options)=>{calls.push({path,options}); return context.provider(path,options);},
    provider:()=>{throw new Error('unexpected provider call');},
    admin:{firestore:{FieldValue:{serverTimestamp:()=>Date.now(),delete:()=>null},Timestamp:{fromMillis:value=>value}}},
    companyBalance:data=>({saldo:data.saldo||0,reservado:data.reservado||0,disponivel:(data.saldo||0)-(data.reservado||0)}),
    companyRefFromPhone:id=>ref(`empresas/${id}`),ledgerRef:id=>ref(`ledger/${id}-${records.size}`),
    driverEarningEvent:(_kind,id,data)=>({id,ganho:data.ganhoMotoboy}),recordDriverEarning:async(tx,cpf,event)=>tx.set(ref(`earnings/${cpf}/${event.id}`),event),
    deliverySplit:data=>({driverAmount:money(data.valor-data.paradas*(data.tipoEntrega==='Plano Diario MotoJa Pro'?1:1.5)),appFee:money(data.paradas*(data.tipoEntrega==='Plano Diario MotoJa Pro'?1:1.5)),driverPercent:0.7,appPercent:0.3}),
    coordinateDistanceKm:()=>0,deliveryStopCount:value=>Number(value||1),manualDeliveryPerformedAtMs:()=>Date.now(),
    emitDeliveryTracking:()=>{},getDriverWithProof:async(cpf)=>{if(cpf!==driverCpf)throw new Error('proof');},
    depositPublicData:body=>({...body,valor:money(body.valor)}),
    createCompanyDepositPreference:async id=>{calls.push({preference:id}); return {preferenceId:'pref',initPoint:'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref'};},
    assertCompany:'auth',assertCompanyApproved:'approved',assertOwner:'owner',createRideLimiter:'limit',
    rateLimit:()=> 'rate-limit', app:{post:(url,...handlers)=>routes.set(`POST ${url}`,handlers),get:(url,...handlers)=>routes.set(`GET ${url}`,handlers)}
  });
  function run(start,end) {const a=source.indexOf(start);assert.ok(a>=0,start); const b=source.indexOf(end,a+start.length);assert.ok(b>a,end);vm.runInContext(source.slice(a,b),context);}
  function fn(name) {const prefix=`async function ${name}(`; const a=source.indexOf(prefix);const b=source.indexOf('\n}',a)+2;assert.ok(a>=0);vm.runInContext(source.slice(a,b),context);}
  async function call(method,url,body={},extra={}) {
    const handlers=routes.get(`${method} ${url}`); assert.ok(handlers, url);let error,result,status=200;
    const response={set:()=>{},status:value=>{status=value;return response;},json:value=>{result=value;return response;}};
    await handlers.at(-1)({body,query:{},params:{deliveryId:'d'},companyId,company:records.get(`empresas/${companyId}`)||{},companySnap:snap(`empresas/${companyId}`),...extra},response,e=>{error=e;});
    if(error)throw error;return {status,data:result};
  }
  return {records,context,ref,calls,routes,run,fn,call};
}
