import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleAt } from './helpers.mjs';
const owner = '11111111111111111111111111111112', coin = '11111111111111111111111111111113', tokenAccount = '11111111111111111111111111111114';
const SYS = '11111111111111111111111111111111', TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const { api } = await moduleAt('src/core/txcheck.js', { './rpc.js': { rpc() { throw new Error('Tests must not use a live RPC'); } }, './vault.js': { b58decode: () => [], b58encode: () => '' }, './util.js': { isMint: (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s), short: (s) => s } });
const msg = { staticAccountKeys: [owner, tokenAccount, SYS], compiledInstructions: [], addressTableLookups: [] };
const token = (amount) => ({ accountIndex: 1, owner, mint: coin, uiTokenAmount: { amount: String(amount), decimals: 6 } });
const result = () => ({ err: null, preBalances: [1000, 0, 0], postBalances: [890, 0, 0], preTokenBalances: [token(0)], postTokenBalances: [token(500)], innerInstructions: [], accounts: [{ owner: SYS, executable: false, space: 0 }], fee: 10 });
const expect = { purpose: 'swap', spendMint: 'SOL', maxSpendRaw: '100', receiveMint: coin, minReceiveRaw: '500', maxFeeLamports: 10 };
test('simulation permits the reviewed spend, receipt and fee bounds', () => assert.equal(api.judge(msg, result(), owner, expect), true));
test('simulation rejects overspend', () => { const v = result(); v.postBalances[0] = 889; assert.throws(() => api.judge(msg, v, owner, expect), /more than/); });
test('simulation rejects an output below the quoted minimum', () => { const v = result(); v.postTokenBalances = [token(499)]; assert.throws(() => api.judge(msg, v, owner, expect), /less than/); });
test('simulation rejects delegate approval hidden in inner instructions', () => { const v = result(); v.innerInstructions = [{ index: 0, instructions: [{ programId: TOKEN, parsed: { type: 'approve', info: { owner, delegate: coin } } }] }]; assert.throws(() => api.judge(msg, v, owner, expect), /another account spend/); });
test('simulation rejects changed token-account ownership', () => { const v = result(); v.postTokenBalances[0].owner = coin; assert.throws(() => api.judge(msg, v, owner, expect), /hand one of your token accounts/); });
test('incomplete or failed simulations fail closed', () => { const v = result(); delete v.preTokenBalances; assert.throws(() => api.judge(msg, v, owner, expect), /check this transaction/); const failed = result(); failed.err = 'failed'; assert.throws(() => api.judge(msg, failed, owner, expect), /fail on-chain/); });

async function ordersHarness() {
  let stored = [], fail = false, signed = 0;
  const events = new Map();
  const tradeExports = Object.fromEntries('SOL_MINT JUP JUP_API jfetch txFromB64 quote trade sellPct holding settle txLink decimalsOf rememberDecimals mintDecimals mintInfo SIG_FEE ATA_RENT FEE_SLACK'.split(' ').map((k) => [k, () => {}]));
  Object.assign(tradeExports, { SOL_MINT: 'So11111111111111111111111111111111111111112', SIG_FEE: 5000, ATA_RENT: 2000000, FEE_SLACK: 5000000, trade: async () => { signed++; return {status:'ok'}; }, quote: async () => ({outAmount:'1'}) });
  const {api} = await moduleAt('src/core/orders.js', {
    './util.js': { LS: { get: () => structuredClone(stored), set: (k,v) => { if(fail)return false;stored=structuredClone(v);return true; } }, emit(){},on: (k,fn)=>{events.set(k,fn);return()=>events.delete(k);},toast(){},esc:(x)=>x,short:(x)=>x,sleep:async()=>{},isMint:()=>true,usd:(x)=>x },
    './settings.js': { settings:{presets:[{}],preset:0} },'./wallet.js':{wallet:{owner},needWallet(){},signAndSend(){signed++;}},
    './trade.js':tradeExports,'./store.js':{tokens:new Map()},'./price.js':{solUsd:()=>100,pricesFor:async()=>new Map()},'./jup.js':{jp:{},jt:{},coolLeft:()=>0}
  }, {navigator:{locks:{request:async(name,opts,fn)=>fn({}),query:async()=>({held:[]})}}});
  return {api,events,setFail:()=>{fail=true;},signed:()=>signed};
}
test('an unsaved armed order is rejected before it is presented as armed', async()=>{
 const h=await ordersHarness();h.setFail();await assert.rejects(h.api.armed.add({kind:'migrate-buy',mint:coin,sol:.1,owner}),/storage/);assert.equal(h.signed(),0);
});
test('a failed firing-state save prevents all trade submission', async()=>{
 const h=await ordersHarness();await h.api.armed.add({kind:'migrate-buy',mint:coin,sol:.1,owner});h.api.startOrderEngine();h.setFail();h.events.get('migrate')({mint:coin});await new Promise(r=>setTimeout(r,10));assert.equal(h.signed(),0);
});
