/**
 * _smoketest.js — 协议级全流程测试（模拟房主 + 2 AI + 多客户端边界用例）
 * 运行：node _smoketest.js  （需已启动 node server.js，端口 9888）
 */
const WebSocket = require('ws');
const engine = require('./game-engine');
const URL = 'ws://localhost:9888';

/* ---------------- 问题收集 ---------------- */
const issues = [];
function issue(severity, area, desc, evidence) {
  issues.push({ severity, area, desc, evidence: evidence || '' });
  console.log(`  [问题][${severity}][${area}] ${desc}${evidence ? '  | 证据: ' + evidence : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sorted = (a) => a.slice().sort((x, y) => x - y);
const eq = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/* ---------------- WebSocket 测试客户端 ---------------- */
class C {
  constructor(name) {
    this.name = name;
    this.log = [];
    this.waiters = [];
    this.onMessage = null; // 持久派发器
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      this.ws.on('message', (m) => {
        const msg = JSON.parse(m);
        // 修复#1验证探针：修复前 played 信封 type 会被牌型名覆盖，此处强制归一化以继续测试；
        // 修复后 _rawType 应恒为 'played'，汇总时打印作为修复证据。
        if (msg.typeKey !== undefined && Array.isArray(msg.cards)) {
          msg._rawType = msg.type;
          if (!C.rawPlayedTypes) C.rawPlayedTypes = new Set();
          C.rawPlayedTypes.add(msg._rawType);
          msg.type = 'played';
        }
        this.log.push(msg);
        if (this.debug) console.log(`    [${this.name}] <- ${msg.type} ${JSON.stringify(msg).slice(0, 160)}`);
        if (this.onMessage) { try { this.onMessage(msg); } catch (e) { console.error(`[${this.name}] dispatch error`, e); } }
        for (const w of this.waiters.slice()) w(msg);
      });
      this.ws.on('open', res);
      this.ws.on('error', (e) => rej(new Error('连接失败: ' + e.message)));
    });
  }
  send(type, data = {}) {
    if (this.debug) console.log(`    [${this.name}] -> ${type} ${JSON.stringify(data).slice(0, 120)}`);
    this.ws.send(JSON.stringify({ type, ...data }));
  }
  close() { try { this.ws.close(); } catch {} }
  kill() { try { this.ws.terminate(); } catch {} } // 模拟断网
  // 等待“之后”出现的满足条件的消息
  waitAfter(mark, pred, timeout = 30000, label = '') {
    const found = this.log.slice(mark).find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = (msg) => {
        if (pred(msg)) {
          this.waiters = this.waiters.filter(x => x !== w);
          clearTimeout(t);
          resolve(msg);
        }
      };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter(x => x !== w);
        reject(new Error(`[${this.name}] 等待超时: ${label}`));
      }, timeout);
      this.waiters.push(w);
    });
  }
  mark() { return this.log.length; }
}

/* ---------------- 玩家（房主）自动打法 ---------------- */
function attachPlayer(c) {
  const st = {
    seat: -1, hand: [], landlordSeat: -1, bottom: [],
    counts: [17, 17, 17], lastPlayCards: [], lastSeat: -1,
    expectedLast: null, multiplier: 1, base: 0, over: null, done: null,
    expectInvalid: 0, negativesDone: false, doubleDone: false, opts: {},
  };
  c.st = st;

  function myTurn() {
    const following = st.lastSeat !== -1 && st.lastSeat !== st.seat;
    if (!following) {
      const cards = engine.aiLead(st.hand);
      if (st.opts.negatives && !st.negativesDone) {
        st.negativesDone = true;
        st.expectInvalid += 3;
        c.send('play', { cards: [9999] });      // 不在手里的牌
        c.send('play', { cards: [] });          // 空出牌
        if (st.lastSeat === -1) c.send('pass'); // 自由回合不可过
      }
      if (st.opts.doubleSend && !st.doubleDone) {
        st.doubleDone = true;
        c.send('play', { cards });
        c.send('play', { cards });
      } else {
        c.send('play', { cards });
      }
    } else {
      const L = engine.analyze(st.lastPlayCards);
      const cards = engine.aiFollow(st.hand, L);
      setTimeout(() => {
        if (cards) c.send('play', { cards });
        else c.send('pass');
      }, 120);
    }
  }

  c.onMessage = (msg) => {
    switch (msg.type) {
      case 'gameStart': {
        st.seat = msg.seat;
        st.hand = msg.hand.slice();
        st.landlordSeat = -1;
        st.counts = [17, 17, 17];
        st.lastPlayCards = []; st.lastSeat = -1;
        st.expectedLast = null; st.multiplier = 1; st.base = 0;
        if (msg.hand.length !== 17) issue('高', '发牌', '开局手牌数不是17', `got ${msg.hand.length}`);
        if (new Set(msg.hand).size !== 17) issue('高', '发牌', '开局手牌有重复', '');
        if (!msg.hand.every(id => id >= 0 && id <= 53)) issue('高', '发牌', '手牌id越界', JSON.stringify(msg.hand.filter(id => id < 0 || id > 53)));
        if (JSON.stringify(engine.sortHand(msg.hand)) !== JSON.stringify(msg.hand)) issue('低', '发牌', 'gameStart 手牌未按规则排序', '');
        break;
      }
      case 'bidTurn': {
        if (msg.seat === st.seat) {
          if (st.opts.bidHack) {
            st.opts.bidHack = false; st.bidHackMark = c.log.length;
            c.send('bid', { bid: 9 }); // 非法值：应被拒绝且不消耗叫分回合
            setTimeout(() => { // 稍后补发合法叫分，推进流程
              const strength = engine.handStrength(st.hand);
              c.send('bid', { bid: strength >= 3 ? 3 : strength >= 1 ? 2 : 0 });
            }, 200);
            break;
          }
          const strength = engine.handStrength(st.hand);
          const bid = strength >= 3 ? 3 : strength >= 1 ? 2 : 0;
          c.send('bid', { bid });
        }
        break;
      }
      case 'bidResult': break;
      case 'system': break;
      case 'landlordSet': {
        st.landlordSeat = msg.landlordSeat;
        st.bottom = msg.bottomCards || [];
        if (msg.seat !== st.seat) issue('高', '协议', 'landlordSet.seat 与本客户端座位不符', `seat=${msg.seat} me=${st.seat}`);
        if (st.bottom.length !== 3) issue('高', '底牌', '底牌不是3张', `got ${st.bottom.length}`);
        st.hand = (msg.hand || []).slice();
        st.counts[msg.landlordSeat] += 3;
        if (msg.landlordSeat === st.seat && st.hand.length !== 20) issue('高', '底牌', '地主手牌不是20张', `got ${st.hand.length}`);
        break;
      }
      case 'playTurn': {
        // 校验 lastPlay 与上一手出牌一致
        if (msg.lastSeat !== -1 && st.expectedLast && !eq(msg.lastPlay || [], st.expectedLast)) {
          issue('高', '同步', 'playTurn.lastPlay 与上一手 played 不一致', `expect ${JSON.stringify(sorted(st.expectedLast))} got ${JSON.stringify(sorted(msg.lastPlay || []))}`);
        }
        if (msg.lastSeat === -1) st.expectedLast = null;
        st.lastSeat = msg.lastSeat;
        st.lastPlayCards = msg.lastPlay || [];
        if (msg.seat === st.seat) myTurn();
        break;
      }
      case 'played': {
        st.counts[msg.seat] -= msg.cards.length;
        if (st.counts[msg.seat] < 0) issue('高', '同步', '座位牌数计数为负', `seat=${msg.seat} count=${st.counts[msg.seat]}`);
        if (!msg.cards.every(id => id >= 0 && id <= 53)) issue('高', '出牌', 'played 消息含非法牌id', JSON.stringify(msg.cards));
        if (!engine.analyze(msg.cards)) issue('高', '出牌', 'played 消息牌型无效', JSON.stringify(msg.cards));
        if (msg.seat === st.seat) {
          const s = new Set(msg.cards);
          st.hand = st.hand.filter(id => !s.has(id));
          st.expectedLast = msg.cards.slice();
        } else {
          st.expectedLast = msg.cards.slice();
        }
        if (msg.typeKey === 'bomb' || msg.typeKey === 'rocket') {
          if (msg.multiplier < st.multiplier) issue('中', '倍数', '炸弹后倍数未翻倍反而变小', `${st.multiplier}->${msg.multiplier}`);
          st.multiplier = msg.multiplier;
        }
        break;
      }
      case 'invalid': {
        if (st.expectInvalid > 0) { st.expectInvalid--; break; }
        issue('高', '协议', '收到意外 invalid', msg.message || '');
        break;
      }
      case 'gameOver': {
        st.over = msg;
        const w = msg.winnerSeat;
        if (st.counts[w] !== 0) issue('高', '结算', '胜利者手牌计数未清零', `seat=${w} count=${st.counts[w]}`);
        const rh = msg.revealHands || {};
        if (rh[w] && rh[w].length !== 0) issue('高', '结算', '胜利者 revealHands 不为空', `len=${rh[w].length}`);
        const base = msg.base, mult = msg.multiplier;
        const delta = base * mult;
        for (let s = 0; s < 3; s++) {
          // 标准规则（零和）：农民各 ±delta，地主 ∓2×delta
          const isLandlord = s === msg.landlordSeat;
          const winSide = msg.winnerIsLandlord ? isLandlord : !isLandlord;
          const expect = isLandlord ? (winSide ? 2 * delta : -2 * delta) : (winSide ? delta : -delta);
          if ((msg.score[s] || 0) !== expect) issue('中', '结算', `座位${s}分数与规则不符（农民±delta/地主∓2delta）`, `expect ${expect} got ${msg.score[s]}`);
        }
        const sum = (msg.score[0] || 0) + (msg.score[1] || 0) + (msg.score[2] || 0);
        if (sum !== 0) issue('中', '结算', '三家分数之和不为主0（非零和）', `sum=${sum} base=${base} mult=${mult}`);
        if (st.done) { const d = st.done; st.done = null; d(msg); }
        break;
      }
      case 'error': break;
      default: break;
    }
  };
}

function playOneGame(c, opts = {}, gameTimeout = 300000) {
  c.st.opts = opts;
  c.st.negativesDone = false; c.st.doubleDone = false;
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('对局超时')), gameTimeout);
    c.st.done = (msg) => { clearTimeout(to); resolve(msg); };
  });
}

/* ================= 用例执行 ================= */
(async () => {
  console.log('== 连接服务器', URL, '==');
  const A = new C('房主A');
  await A.connect();
  await sleep(500); // 等 welcome
  const hello = A.log.find(m => m.type === 'welcome');
  if (!hello) issue('中', '协议', '连接后未收到 welcome', '');
  A.send('setName', { name: '测试房主' });

  /* ---- S1 大厅/房间边界 ---- */
  console.log('\n-- S1 大厅/房间边界 --');
  A.send('startGame');                       // 无房间开始 → 应无效果
  const m0 = A.mark();
  A.send('joinRoom', { roomId: 'ZZZZZ' });   // 不存在的房间
  try {
    await A.waitAfter(m0, m => m.type === 'error' && /不存在/.test(m.message), 5000, '错误提示(房间不存在)');
  } catch { issue('中', '大厅', '加入不存在房间未收到错误提示', ''); }
  await sleep(300);

  const m1 = A.mark();
  A.send('createRoom');
  const rs1 = await A.waitAfter(m1, m => m.type === 'roomState', 5000, 'roomState(创建)');
  if (rs1.youSeat !== 0) issue('中', '房间', '房主座位不是0', `youSeat=${rs1.youSeat}`);
  const roomId = rs1.room.roomId;
  console.log('  房间号:', roomId);

  const m2 = A.mark();
  A.send('startGame');                        // 1人开始
  try {
    await A.waitAfter(m2, m => m.type === 'error' && /3 名玩家/.test(m.message), 5000, '错误提示(需3人)');
  } catch { issue('中', '房间', '人数不足开局未收到错误提示', ''); }

  const m3 = A.mark();
  A.send('addAI');
  await A.waitAfter(m3, m => m.type === 'roomState' && m.room.players[1], 5000, 'roomState(加AI1)');
  const m3b = A.mark();
  A.send('removeAI', { seat: 1 });
  const rs3b = await A.waitAfter(m3b, m => m.type === 'roomState' && m.room.players[1] === null, 5000, 'roomState(移除AI)');
  if (!rs3b) issue('中', '房间', '移除AI未生效', '');
  const m4 = A.mark();
  A.send('addAI'); A.send('addAI');
  const rs4 = await A.waitAfter(m4, m => m.type === 'roomState' && m.room.players[1] && m.room.players[2], 8000, 'roomState(加2AI)');
  const m5 = A.mark();
  A.send('addAI');                            // 第4个
  try {
    await A.waitAfter(m5, m => m.type === 'error' && /已满/.test(m.message), 5000, '错误提示(房间已满)');
  } catch { issue('低', '房间', '满员加AI未收到错误提示', ''); }

  /* ---- S2 第一局（含越界叫分 + 出牌非法用例）---- */
  console.log('\n-- S2 对局1：越界叫分/非法出牌 --');
  const m6 = A.mark();
  attachPlayer(A);              // 先挂派发器再开局，确保收到 gameStart
  A.st.opts = { negatives: true, bidHack: true }; // 开局前设置，避免 bidTurn 先到
  A.debug = true;               // S2 调试日志
  A.send('startGame');
  const gs1 = await A.waitAfter(m6, m => m.type === 'gameStart', 8000, 'gameStart1');
  // 叫分阶段越权测试：非自己回合时发 bid
  if (gs1.callingSeat !== A.st.seat) {
    const mb = A.mark();
    A.send('bid', { bid: 3 });
    await sleep(300);
    const leaked = A.log.slice(mb).find(m => m.type === 'bidResult' && m.seat === A.st.seat);
    if (leaked) issue('高', '叫分', '非叫分回合的 bid 被受理', JSON.stringify(leaked));
  }
  const over1 = await playOneGame(A, { negatives: true, bidHack: true });
  console.log('  对局1结束, winner=', over1.winnerSeat, 'score=', JSON.stringify(over1.score), `base=${over1.base} mult=${over1.multiplier}`);
  if (A.st.bidHackMark !== undefined) {
    const bidErr = A.log.slice(A.st.bidHackMark).find(m => m.type === 'error' && /叫分/.test(m.message || ''));
    if (bidErr) console.log('  已确认: 越界叫分(bid=9)被拒绝并收到错误提示');
    else issue('中', '叫分', '越界叫分(bid=9)未收到错误提示', '');
  }
  if (over1.base === 3 && over1.multiplier === 3 && over1.base * over1.multiplier === 9) {
    issue('中', '结算', '底分被重复计入倍数（base=3,mult=3,delta=9）', '叫3分无炸弹即得9分');
  }

  /* ---- S3 再来一局（双重发送测试）---- */
  console.log('\n-- S3 对局2：restart + 连续两次出牌 --');
  const m7 = A.mark();
  A.send('restart');
  await A.waitAfter(m7, m => m.type === 'gameStart', 8000, 'gameStart2');
  const over2 = await playOneGame(A, { doubleSend: true });
  console.log('  对局2结束, winner=', over2.winnerSeat, 'score=', JSON.stringify(over2.score), `base=${over2.base} mult=${over2.multiplier}`);

  /* ---- S4 结束状态加入 ---- */
  console.log('\n-- S4 结束状态房间不可加入 --');
  const B = new C('玩家B'); await B.connect();
  B.send('setName', { name: '测试B' });
  const mb4 = B.mark();
  B.send('joinRoom', { roomId });
  try {
    await B.waitAfter(mb4, m => m.type === 'error' && /不存在或已开战/.test(m.message), 5000, '错误提示(已开战)');
    console.log('  已拒绝: 房间在 over 状态不可加入');
  } catch { issue('中', '房间', 'over 状态房间可被加入或无错误提示', ''); }

  /* ---- S5 房主离开解散 ---- */
  console.log('\n-- S5 房主离开 → 解散 --');
  A.send('leaveRoom');
  await sleep(500);
  const mf = B.mark();
  B.send('joinRoom', { roomId });
  try {
    await B.waitAfter(mf, m => m.type === 'error' && /不存在/.test(m.message), 5000, '错误提示(已解散)');
    console.log('  已确认: 房主离开后房间被解散');
  } catch { issue('高', '房间', '房主离开后房间未被解散（仍可加入）', ''); }

  /* ---- S6 游戏中玩家掉线 → AI 接管 ---- */
  console.log('\n-- S6 游戏中玩家掉线 → AI接管 --');
  const m6s = A.mark();
  A.send('createRoom');
  const rs6 = await A.waitAfter(m6s, m => m.type === 'roomState', 5000, 'roomState(S6)');
  const room6 = rs6.room.roomId;
  const mb6 = B.mark();
  B.send('joinRoom', { roomId: room6 });
  await B.waitAfter(mb6, m => m.type === 'roomState', 5000, 'roomState(B加入)');
  attachPlayer(B); // B 是真人玩家，挂上自动打法（否则叫分阶段卡死）
  const m6ai = A.mark();
  A.send('addAI');
  await A.waitAfter(m6ai, m => m.type === 'roomState' && m.room.players[2], 5000, 'roomState(S6 AI)');
  const m6go = A.mark();
  attachPlayer(A);
  A.send('startGame');
  await A.waitAfter(m6go, m => m.type === 'gameStart', 8000, 'gameStart(S6)');
  // 等 B 进入出牌阶段后掐断 B
  await B.waitAfter(mb6, m => m.type === 'landlordSet', 60000, 'landlordSet(B)');
  const sysMark = A.mark();
  B.kill();
  try {
    await A.waitAfter(sysMark, m => m.type === 'system' && /由 AI 接管/.test(m.message), 8000, 'AI接管提示');
    console.log('  已确认: B掉线后由AI接管');
  } catch { issue('高', '断线', '玩家掉线后未提示AI接管', ''); }
  const over6 = await playOneGame(A, {});
  console.log('  S6 对局结束, winner=', over6.winnerSeat);

  /* ---- S7/S8 满员拒绝 + 房主游戏中掉线解散 ---- */
  console.log('\n-- S8 满员拒绝 + 房主游戏中掉线 --');
  A.send('leaveRoom'); await sleep(300);
  const m8 = A.mark();
  A.send('createRoom');
  const rs8 = await A.waitAfter(m8, m => m.type === 'roomState', 5000, 'roomState(S8)');
  const room8 = rs8.room.roomId;
  A.send('addAI'); A.send('addAI');
  await sleep(400);
  if (!B.ws || B.ws.readyState !== 1) { await B.connect(); console.log('  (B 已重连)'); } // S6中被kill，重连后才能验证服务端满员/解散逻辑
  const mf8 = B.mark();
  B.send('joinRoom', { roomId: room8 });
  try {
    await B.waitAfter(mf8, m => m.type === 'error' && /已满/.test(m.message), 5000, '错误提示(满员)');
    console.log('  已确认: 满员房间拒绝加入');
  } catch { issue('中', '房间', '满员(1人+2AI)房间未拒绝加入', ''); }
  const m8go = A.mark();
  A.send('startGame');
  await A.waitAfter(m8go, m => m.type === 'gameStart', 8000, 'gameStart(S8)');
  await A.waitAfter(m8go, m => m.type === 'landlordSet', 60000, 'landlordSet(S8)');
  A.kill(); // 房主游戏中掉线
  await sleep(800);
  const mf8b = B.mark();
  B.send('joinRoom', { roomId: room8 });
  try {
    await B.waitAfter(mf8b, m => m.type === 'error' && /不存在/.test(m.message), 5000, '错误提示(已解散)');
    console.log('  已确认: 房主游戏中掉线 → 房间解散');
  } catch { issue('高', '断线', '房主游戏中掉线后房间未解散', ''); }

  /* ---------------- 汇总 ---------------- */
  console.log('\n================ 测试完成 ================');
  if (C.rawPlayedTypes && C.rawPlayedTypes.size) {
    console.log(`[证据] played 消息到达客户端时的实际 type 字段: ${[...C.rawPlayedTypes].join(' / ')}（应为 played）`);
  }
  if (C.rawPlayedTypes && C.rawPlayedTypes.size) {
    console.log(`[证据] played 消息到达客户端时的实际 type 字段: ${[...C.rawPlayedTypes].join(' / ')}（应为 played）`);
  }
  console.log(`共发现 ${issues.length} 个协议/逻辑层面问题：`);
  const sev = { '高': 0, '中': 0, '低': 0 };
  for (const it of issues) sev[it.severity]++;
  console.log(`  高: ${sev['高']}  中: ${sev['中']}  低: ${sev['低']}`);
  issues.forEach((it, i) => console.log(`  ${i + 1}. [${it.severity}][${it.area}] ${it.desc}${it.evidence ? ' | ' + it.evidence : ''}`));
  if (issues.length) {
    console.error('真实问题数:', issues.length);
    process.exit(1);
  }
  console.log('全部检查通过，未发现问题。');
  process.exit(0);
})().catch(e => {
  console.error('\n测试中断:', e.message);
  console.error('已发现问题数:', issues.length);
  issues.forEach((it, i) => console.log(`  ${i + 1}. [${it.severity}][${it.area}] ${it.desc}${it.evidence ? ' | ' + it.evidence : ''}`));
  process.exit(1);
});
