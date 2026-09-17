/* 确定性验证 修复#5：越界叫分(bid:9)必须被拒绝，且不消耗叫分回合 */
/* 思路：doBid 的回合检查在最前（回合外叫分被静默忽略），因此必须让本客户端成为
   首叫座位(callingSeat===0)才能触达范围校验。首叫座位随机，故循环换房重试。 */
const WebSocket = require('ws');
const URL = 'ws://localhost:9888';

function client(name) {
  const c = { name, log: [], waiters: [] };
  c.connect = () => new Promise((res, rej) => {
    c.ws = new WebSocket(URL);
    c.ws.on('message', (m) => { const msg = JSON.parse(m); c.log.push(msg); for (const w of c.waiters.slice()) w(msg); });
    c.ws.on('open', res);
    c.ws.on('error', rej);
  });
  c.send = (type, data = {}) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ type, ...data })); };
  c.mark = () => c.log.length;
  c.waitAfter = (fromIdx, pred, timeout, label) => new Promise((res, rej) => {
    for (let i = fromIdx; i < c.log.length; i++) if (pred(c.log[i])) return res(c.log[i]);
    const t = setTimeout(() => rej(new Error('等待超时: ' + label)), timeout);
    c.waiters.push((m) => { if (pred(m)) { clearTimeout(t); res(m); } });
  });
  c.close = () => { try { c.ws.close(); } catch (e) { /* ignore */ } };
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const A = client('叫分测试');
  await A.connect();
  let attempt = 0;
  for (;;) {
    attempt++;
    A.send('createRoom');
    await A.waitAfter(A.mark(), (m) => m.type === 'roomState', 5000, 'roomState');
    A.send('addAI'); A.send('addAI');
    await sleep(400);
    const m = A.mark();
    A.send('startGame');
    const gs = await A.waitAfter(m, (x) => x.type === 'gameStart', 8000, 'gameStart');
    if (gs.callingSeat !== 0) {
      console.log(`第${attempt}次: 首叫座位=${gs.callingSeat}（非本方），换房重试`);
      A.send('leaveRoom'); await sleep(300);
      continue;
    }
    console.log(`第${attempt}次: 本方为首叫座位 → 发送越界 bid:9`);
    const mk = A.mark();
    A.send('bid', { bid: 9 });
    const err = await A.waitAfter(mk, (x) => x.type === 'error' && /叫分/.test(x.message || ''), 5000, '越界叫分错误提示');
    console.log('  ✔ 被拒绝并收到错误提示:', err.message);
    const mk2 = A.mark();
    A.send('bid', { bid: 0 });
    const br = await A.waitAfter(mk2, (x) => x.type === 'bidResult' && x.seat === 0, 5000, '合法叫分bidResult');
    console.log('  ✔ 非法叫分未消耗回合，随后合法叫分被受理: bid =', br.bid);
    const accepted9 = A.log.slice(mk).find((x) => x.type === 'bidResult' && x.seat === 0 && x.bid === 9);
    console.log(accepted9 ? '  ✘ bid:9 被受理！' : '  ✔ 全程无 bid=9 的 bidResult（未被受理）');
    console.log(accepted9 ? 'FAIL: 修复#5 未生效' : 'PASS: 修复#5 验证通过');
    A.close();
    process.exit(accepted9 ? 1 : 0);
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
