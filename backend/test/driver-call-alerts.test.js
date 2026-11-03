import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { callOfferExpiry, reconcileCallOffers, createCallPushDispatcher } from '../src/driver-call-alerts.js';
import { createOfferAlerts } from '../src/offer-alert.js';
const { createController } = createRequire(import.meta.url)('../../motoboy-call-alerts.js');
const base = Date.UTC(2026,9,31,15);
const created = { seconds: base / 1000 };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('alarme permanece por minutos, para após aceite confirmado e volta para outra entrega', async () => {
  let now=base, available=true, pending=true, loop=false;
  const timers=new Map(), states=[];
  const controller=createController({ now:()=>now, setTimer:fn=>{timers.set(1,fn);return 1;},clearTimer:id=>timers.delete(id),
    output:{update:offers=>{loop=offers.length>0;states.push(loop);},session(){},preference(){}},
    fetcher:async(_url,opts)=>({ok:true,json:async()=>({available,offers:pending?JSON.parse(opts.body).offers.map(o=>({...o,expiresAtMs:base+15*60000})):[]})}) });
  controller.start({backend:'https://test.example',getProof:()=>({driverCpf:'12345678901',driverToken:'test'}),canAlert:()=>available});
  controller.jobs({kind:'rides',scope:'pending',jobs:[{id:'r1',status:'pendente',criadaEm:created}]});
  await flush(); const at=states.length;
  for(let i=0;i<120;i++){now+=3000;await timers.get(1)();assert.equal(loop,true);}
  assert.ok(states.slice(at).every(Boolean),'Sem lacuna após 10 s, 30 s, 2 min ou 6 min.');
  // Uma tentativa de aceite ainda pendente não encerra o som.
  controller.changed({kind:'rides',id:'r1',status:'pendente'}); await flush(); assert.equal(loop,true);
  pending=false; controller.changed({kind:'rides',id:'r1',status:'encerrada'}); assert.equal(loop,false);
  pending=true; controller.jobs({kind:'deliveries',scope:'pending',jobs:[{id:'d1',status:'pendente',criadaEm:{seconds:now/1000}}]});
  await flush(); assert.equal(loop,true);
  available=false; controller.refresh(); assert.equal(loop,false);
  controller.stop(); assert.equal(timers.size,0);
});

test('aceite de outro motorista durante consulta atrasada não ressuscita o chamado', async()=>{
  let resolve,loop=false; const wait=new Promise(r=>resolve=r);
  const controller=createController({now:()=>base,setTimer:()=>1,clearTimer(){},
    output:{update:offers=>loop=!!offers.length,session(){},preference(){}},
    fetcher:()=>wait});
  controller.start({backend:'https://test',getProof:()=>({driverCpf:'12345678901'}),canAlert:()=>true});
  controller.jobs({kind:'rides',scope:'pending',jobs:[{id:'r1',status:'pendente',criadaEm:created}]});
  assert.equal(loop,true);
  controller.changed({kind:'rides',id:'r1',status:'encerrada'}); assert.equal(loop,false);
  resolve({ok:true,json:async()=>({available:true,offers:[{kind:'rides',id:'r1',expiresAtMs:base+600000}]})});
  await flush(); assert.equal(loop,false); controller.stop();
});

test('API reconcilia somente ofertas permitidas, pendentes e não expiradas', async()=>{
  const jobs={open:{status:'pendente',criadaEm:created},accepted:{status:'aceita',criadaEm:created},old:{status:'pendente',criadaEm:{seconds:1}},otherCity:{status:'pendente',criadaEm:created}};
  const offers=Object.keys(jobs).map(id=>({kind:'rides',id}));
  const result=await reconcileCallOffers(offers,{now:base,load:async(_kind,id)=>jobs[id],allowed:(_kind,job)=>job!==jobs.otherCity});
  assert.deepEqual(result.map(o=>o.id),['open']);
  await assert.rejects(()=>reconcileCallOffers([{kind:'companies',id:'secret'}],{load(){},allowed(){}}),/chamadas_invalidas/);
  await assert.rejects(()=>reconcileCallOffers(Array(31).fill(offers[0]),{load(){},allowed(){}}),/chamadas_invalidas/);
});

test('somente Android compatível recebe controle de loop; versões antigas mantêm a notificação', async()=>{
  const sent=[],changed=[];
  const push=createCallPushDispatcher({send:async message=>{sent.push(message);return{successCount:message.tokens.length,failureCount:0};},changed:(...args)=>changed.push(args),now:()=>base});
  push.remember('new',{plataforma:'android_nativo',callAlertVersion:1});
  push.remember('old',{plataforma:'android_nativo'}); push.remember('web',{plataforma:'web',callAlertVersion:1});
  const message={tokens:['new','old','web'],notification:{title:'Chamada',body:'Abra o app'},android:{notification:{channelId:'chamadas'}},data:{rideId:'r1',repeticao:'0'}};
  assert.equal((await push.offer(message,{kind:'rides',id:'r1',job:{criadaEm:created}})).successCount,3);
  const updated=sent.find(m=>m.tokens.includes('new')),legacy=sent.find(m=>m.tokens.includes('old'));
  assert.equal(updated.notification,undefined); assert.equal(updated.data.action,'available'); assert.equal(updated.android.priority,'high');
  assert.equal(legacy.notification.title,'Chamada'); assert.ok(legacy.tokens.includes('web'));
  assert.deepEqual(changed,[['rides','r1','pendente']]);
  sent.length=0; await push.closed('rides','r1'); assert.deepEqual(sent[0].tokens,['new']); assert.equal(sent[0].data.action,'removed');
});

test('repetições não terminam na oitava tentativa e um aceite durante a leitura cancela o próximo envio',async()=>{
  const timers=[];let sent=0, release;
  const alerts=createOfferAlerts({setTimer:fn=>{timers.push(fn);return fn;},clearTimer(){},loadPending:async()=>({}),send:async()=>sent++});
  alerts.start('rides','r1');for(let i=0;i<25;i++)await timers.shift()();assert.equal(sent,25);alerts.stop('rides','r1');
  const delayed=createOfferAlerts({setTimer:fn=>{timers.push(fn);return fn;},clearTimer(){},loadPending:()=>new Promise(r=>release=r),send:async()=>sent++});
  timers.length=0;delayed.start('rides','r2');const tick=timers.shift()();delayed.stop('rides','r2');release({});await tick;assert.equal(sent,25);
});

test('primeiro push com serverTimestamp ainda pendente pode ser validado, e os prazos configurados são respeitados', async()=>{
  const sent=[];
  const expiry=(kind,job)=>callOfferExpiry(kind,job,{rides:60000,deliveries:120000});
  const push=createCallPushDispatcher({now:()=>base,expiry,send:async message=>{sent.push(message);return{successCount:1};}});
  push.remember('native',{plataforma:'android_nativo',callAlertVersion:1});
  await push.offer({tokens:['native'],data:{}},{kind:'rides',id:'r1',job:{criadaEm:{_methodName:'serverTimestamp'}}});
  assert.equal(Number(sent[0].data.expiresAtMs),base+60000);
  const offers=await reconcileCallOffers([{kind:'rides',id:'r1'}],{now:base+61000,expiry,load:async()=>({status:'pendente',criadaEm:created}),allowed:()=>true});
  assert.deepEqual(offers,[]);
});

test('rede temporariamente indisponível não corta uma chamada válida; expiração e sessão inválida encerram', async()=>{
  let now=base,loop=false,mode='offline',tick;
  const controller=createController({now:()=>now,setTimer:fn=>(tick=fn),clearTimer(){},output:{update:offers=>loop=!!offers.length,session(){},preference(){}},fetcher:async()=>{if(mode==='offline')throw Error('sem rede');return{ok:false,status:401};}});
  const job={id:'r1',status:'pendente',criadaEm:created};
  const start=()=>controller.start({backend:'https://test',getProof:()=>({driverCpf:'12345678901'}),canAlert:()=>true});
  start();controller.jobs({kind:'rides',scope:'pending',jobs:[job]});await flush();assert.equal(loop,true);
  now+=30000;await tick();assert.equal(loop,true);
  now=base+600001;await tick();assert.equal(loop,false);
  now=base;start();mode='unauthorized';controller.jobs({kind:'rides',scope:'pending',jobs:[job]});await flush();assert.equal(loop,false);
  controller.jobs({kind:'rides',scope:'pending',jobs:[job]});assert.equal(loop,false);
});
