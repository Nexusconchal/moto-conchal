import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code=fs.readFileSync(new URL('../../company-deposits.js',import.meta.url),'utf8');
function ui(search='') {
  const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',style:{},hidden:false,disabled:false,removeAttribute(){},focus(){}});return nodes.get(id);};
  const storage=new Map([['motojaRecarga:company',JSON.stringify({depositId:'dep'})]]), calls=[],locations=[],balances=[],listeners={};let who='company',authed=true,mode='mercadopago',api=async()=>({available:true,deposit:null});
  const context=vm.createContext({window:{},document:{getElementById:$,querySelectorAll:()=>[],visibilityState:'visible',addEventListener:(name,fn)=>{listeners[name]=fn;}},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
    URL,URLSearchParams,Date,Number,String,Event,crypto:{randomUUID:()=> '12345678-1234-1234-1234-123456789012'},location:{search,pathname:'/empresa.html',hash:''},history:{replaceState(){}},
  });context.window.dispatchEvent=()=>{};vm.runInContext(code,context);
  const controller=context.window.MotojaCompanyDeposits.create({account:()=>who,authenticated:()=>authed,mode:()=>mode,balance:value=>balances.push(value),navigate:value=>locations.push(value),api:async(path,body)=>{calls.push({path,body});return api(path,body);}});
  return {$,controller,calls,locations,balances,storage,listeners,setMode:value=>{mode=value;controller.refreshMode();},setApi:value=>{api=value;},logout:()=>{authed=false;controller.reset();},switchAccount:()=>{who='different';controller.reset();}};
}
test('redirect status approved cannot grant balance; only the server receipt can display paid credit',async()=>{
  const h=ui('?deposito=ok&depositId=dep&status=approved');
  h.setApi(async()=>({deposit:{id:'dep',valor:30,status:'pending'},balance:{saldo:7,reservado:0,disponivel:7}}));
  await h.controller.load();assert.match(h.$('recargaTitulo').textContent,/pendente/);assert.equal(h.balances.at(-1).saldo,7);
  assert.equal(h.calls.length,2);assert.ok(h.calls[1].path.endsWith('/verify'));
});
test('invalid amounts and a malicious checkout cannot redirect a company; retries retain the same request id',async()=>{
  const h=ui();for(const value of [9,5001,Infinity,NaN]) await assert.rejects(h.controller.start(value));assert.equal(h.calls.length,0);
  h.setApi(async()=>{throw new Error('timeout');});await assert.rejects(h.controller.start(30));await assert.rejects(h.controller.start(30));
  assert.equal(h.calls[0].body.requestId,h.calls[1].body.requestId);
  h.setApi(async()=>({depositId:'dep',initPoint:'https://evil.com/checkout/'}));await assert.rejects(h.controller.start(30),/checkout/);assert.equal(h.locations.length,0);
});
test('late recarga responses cannot leak into another account or redirect a logged-out company',async()=>{
  for(const operation of ['load','start']) {
    const h=ui();let resolve;h.setApi(()=>new Promise(done=>{resolve=done;}));const waiting=operation==='load'?h.controller.load():h.controller.start(30);
    h.logout();resolve({deposit:{id:'dep',status:'aprovado',creditado:true,valorCreditado:30},depositId:'dep',initPoint:'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref',balance:{saldo:300}});await waiting;
    assert.equal(h.locations.length,0);assert.equal(h.balances.length,0);
  }
});

test('manual Pix never displays or checks a previous automatic receipt',async()=>{
  const h=ui();h.setApi(async()=>({deposit:{id:'old20',valor:20,status:'pending'}}));
  await h.controller.load();assert.equal(h.$('recargaAutomatica').style.display,'grid');
  h.setMode('pix_manual');assert.equal(h.$('recargaAutomatica').style.display,'none');assert.equal(h.$('recargaValores').style.display,'none');
  const count=h.calls.length;await h.controller.load(true);await h.$('conferirRecarga').onclick();h.listeners.visibilitychange();
  await assert.rejects(h.controller.start(30),/Automático/);assert.equal(h.calls.length,count);
});

test('automatic awaiting-payment panel appears only after a requested checkout, using its amount',async()=>{
  const h=ui();h.storage.clear();await h.controller.load();assert.equal(h.calls.length,0);assert.equal(h.$('recargaAutomatica').style.display,'none');
  h.setApi(async()=>({depositId:'new30',initPoint:'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=new30'}));
  await h.controller.start(30);assert.match(h.$('recargaTexto').textContent,/30,00/);assert.match(h.$('recargaTitulo').textContent,/Aguardando pagamento/);
  assert.equal(h.$('recargaAutomatica').style.display,'grid');assert.equal(h.$('recargaCodigo').textContent,'Código: new30');
});

test('requesting 30 supersedes a slow old-20 receipt instead of silently dropping the new request',async()=>{
  const h=ui();let oldResolve,newResolve;
  h.setApi((path)=>new Promise(done=>{if(path.includes('deposit-preference'))newResolve=done;else oldResolve=done;}));
  const old=h.controller.load();const fresh=h.controller.start(30);
  assert.match(h.$('recargaTexto').textContent,/30,00/);assert.equal(h.$('conferirRecarga').hidden,true);
  newResolve({depositId:'new30',initPoint:'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=new30'});await fresh;
  oldResolve({deposit:{id:'old20',valor:20,status:'pending'}});await old;
  assert.match(h.$('recargaTexto').textContent,/30,00/);assert.equal(h.$('recargaCodigo').textContent,'Código: new30');assert.equal(h.locations.length,1);
});

test('switching to manual while automatic checkout is pending prevents stale redirects and panels',async()=>{
  const h=ui();let resolve;h.setApi(()=>new Promise(done=>{resolve=done;}));const waiting=h.controller.start(30);
  h.setMode('pix_manual');resolve({depositId:'new30',initPoint:'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=new30'});await waiting;
  assert.equal(h.locations.length,0);assert.equal(h.$('recargaAutomatica').style.display,'none');assert.equal(h.balances.length,0);
});
