import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../customer-availability.js',import.meta.url),'utf8');
function harness({ count=1, status=200, timestamp=-99999999 }={}) {
  let monotonic=100, clock=90000000, interval, calls=0;
  const title={}, detail={}, events={};
  const root={dataset:{backend:'https://example.test'},querySelector:s=>s==='strong'?title:detail};
  const document={visibilityState:'visible',getElementById:()=>root,addEventListener:(name,handler)=>events[name]=handler};
  const urls=[];
  const context=vm.createContext({document,window:{addEventListener:(name,handler)=>events[name]=handler},performance:{now:()=>monotonic},Date:{now:()=>clock},AbortController,setTimeout:()=>1,clearTimeout:()=>{},setInterval:handler=>interval=handler,
    fetch:async url=>{calls++;urls.push(url);return {ok:status===200,json:async()=>({ok:true,counts:{conchal:count},updatedAt:timestamp})};}});
  vm.runInContext(source,context);
  return {root,title,detail,events,urls,tick:ms=>monotonic+=ms,clock:value=>clock=value,run:()=>interval(),calls:()=>calls,document};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('fresh responses are accepted despite a different server clock; requests bypass cached URLs',async()=>{
  const h=harness();await settle();assert.match(h.title.textContent,/1 motoboy online/);assert.match(h.urls[0],/\?t=/);
  h.tick(20000);h.clock(-500000);h.run();await settle();assert.equal(h.calls(),2);assert.match(h.title.textContent,/1 motoboy online/);
});
test('a hidden page does not poll and stale counts are hidden before returning to the app',async()=>{
  const h=harness();await settle();h.document.visibilityState='hidden';h.tick(60000);h.run();await settle();assert.equal(h.calls(),1);
  assert.equal(h.root.dataset.state,'unknown');h.document.visibilityState='visible';h.events.visibilitychange();await settle();assert.equal(h.calls(),2);
});
test('request failures show unknown availability, while a confirmed zero remains distinct',async()=>{
  const zero=harness({count:0});await settle();assert.match(zero.title.textContent,/Nenhum motoboy/);
  const error=harness({status:503});await settle();assert.match(error.title.textContent,/não confirmada/);
});
test('negative, fractional or excessive counts are rejected without displaying them',async()=>{
  for(const count of [-1,1.5,2001]){const h=harness({count});await settle();assert.equal(h.root.dataset.state,'unknown');}
});

