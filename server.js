/**
 * server.js — 局域网欢乐斗地主 WebSocket 服务端
 * 职责：静态文件服务 + 房间管理 + 游戏流程编排 + AI 调度
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const engine = require('./game-engine');

const PORT = process.env.PORT || 9888;
const ROOT = path.join(__dirname, 'public');

/* ---------------- 静态文件服务 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({ server });

/** 客户端连接对象 */
class Client {
  constructor(ws) {
    this.ws = ws;
    this.id = Math.random().toString(36).slice(2, 10);
    this.name = '';
    this.roomId = null;
    this.playerIndex = -1;
  }
  send(type, data = {}) {
    if (this.ws.readyState === 1) {
      // 信封 type 放在展开之后，避免 payload 中的同名字段覆盖消息类型
      this.ws.send(JSON.stringify({ ...data, type }));
    }
  }
}

const clients = new Map();   // id -> Client
const rooms = new Map();     // roomId -> Room

/* ================= 玩家战绩（按昵称记录，持久化到 stats.json） ================= */
const STATS_FILE = path.join(__dirname, 'stats.json');
let stats = {};
try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) || {}; } catch { stats = {}; }
function saveStats() {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); } catch { /* 忽略写入失败 */ }
}

/* ================= 房间与游戏状态 ================= */
const ROLE = { UNKNOWN: 0, LANDLORD: 1, FARMER: 2 };

class Room {
  constructor(id, hostName) {
    this.id = id;
    this.hostId = null;
    this.players = [null, null, null]; // seat 站位 0/1/2，元素为 Client 或 ai 对象
    this.aiSlots = [];                 // 座位号数组
    this.aiNames = ['机器人 · 阿福', '机器人 · 阿喜', '机器人 · 阿财'];
    this.aiLevels = ['初级', '中级', '高级'];   // AI 技术等级（影响叫分/出牌策略与反应速度）
    this.state = 'waiting';            // waiting | bidding | playing | over
    this.turn = -1;                    // 当前出牌座位
    this.askBid = -1;                  // 当前叫分座位
    this.landlordSeat = -1;
    this.hands = [[], [], []];         // 每人手牌 id 数组
    this.bottomCards = [];             // 底牌
    this.lastPlaySeat = -1;            // 上一手出牌座位
    this.lastPlayCards = [];           // 上一手牌
    this.lastAnalysis = null;
    this.bidSeatStart = 0;
    this.bids = [];                    // {seat,bid}
    this.passCount = 0;
    this.multiplier = 1;
    this.baseBid = 0;
    this.aiTimer = null;
  }

  playerAt(seat) { return this.players[seat]; }
  humanCount() { return this.players.filter(p => p && !p.isAI).length; }
  fillName(seat) { return this.players[seat] ? this.players[seat].name : '空位'; }

  sendAll(type, data = {}) {
    for (const p of this.players) if (p && !p.isAI) p.send(type, data);
  }
  sendSeat(seat, type, data = {}) {
    const p = this.players[seat];
    if (p && !p.isAI) p.send(type, data);
  }
  // 向每个真人玩家下发房间状态，附带各自的座位号
  sendRoomState() {
    for (let s = 0; s < 3; s++) {
      const p = this.players[s];
      if (p && !p.isAI) p.send('roomState', { room: publicRoom(this), youSeat: s });
    }
  }
}

/* ================= 生成仅含公共信息的玩家视图 ================= */
function publicRoom(r) {
  return {
    roomId: r.id,
    state: r.state,
    players: r.players.map(p => p ? { name: p.name, isAI: !!p.isAI } : null),
    hostId: r.hostId
  };
}

/* ================= 房间查找 ================= */
function findRoom(id) { return rooms.get(id); }

function makeRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = '';
    for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(id));
  return id;
}

/* ================= 消息处理 ================= */
wss.on('connection', (ws) => {
  const c = new Client(ws);
  clients.set(c.id, c);
  c.send('welcome', { id: c.id });
  c.send('roomList', { rooms: listRooms() });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleMessage(c, msg);
  });

  ws.on('close', () => {
    onLeave(c);
    clients.delete(c.id);
  });
});

function listRooms() {
  const out = [];
  for (const r of rooms.values()) {
    if (r.state === 'waiting') {
      const count = r.players.filter(Boolean).length; // 含 AI，真实反映房间人数
      out.push({ roomId: r.id, players: count, isFull: count >= 3 });
    }
  }
  return out;
}
function broadcastRoomList() {
  const data = { type: 'roomList', rooms: listRooms() };
  for (const c of clients.values()) c.send('roomList', { rooms: listRooms() });
}

function handleMessage(c, msg) {
  switch (msg.type) {
    case 'setName': {
      c.name = String(msg.name || '').slice(0, 12) || '玩家' + c.id.slice(0, 4);
      c.send('setName', { name: c.name });
      break;
    }
    case 'createRoom': {
      if (c.roomId) break;
      const r = new Room(makeRoomId());
      r.players[0] = c; r.hostId = c.id;
      c.roomId = r.id; c.playerIndex = 0;
      rooms.set(r.id, r);
      r.sendRoomState();
      broadcastRoomList();
      break;
    }
    case 'joinRoom': {
      if (c.roomId) break;
      const r = findRoom(msg.roomId);
      if (!r || r.state !== 'waiting') { c.send('error', { message: '房间不存在或已开战' }); break; }
      const seat = r.players.indexOf(null);
      if (seat < 0) { c.send('error', { message: '房间已满' }); break; }
      if (!c.name) c.name = '玩家' + c.id.slice(0, 4);
      r.players[seat] = c;
      c.roomId = r.id; c.playerIndex = seat;
      r.sendRoomState();
      broadcastRoomList();
      break;
    }
    case 'leaveRoom': {
      onLeave(c);
      break;
    }
    case 'addAI': {
      const r = findRoom(c.roomId);
      if (!r || r.state !== 'waiting') break;
      const seat = r.players.indexOf(null);
      if (seat < 0) { c.send('error', { message: '房间已满' }); break; }
      const ai = makeAI(r, seat);
      r.players[seat] = ai;
      r.aiSlots.push(seat);
      r.sendRoomState();
      broadcastRoomList();
      break;
    }
    case 'removeAI': {
      const r = findRoom(c.roomId);
      if (!r || r.state !== 'waiting') break;
      const seat = Number(msg.seat);
      if (r.players[seat] && r.players[seat].isAI) {
        r.players[seat] = null;
        r.aiSlots = r.aiSlots.filter(s => s !== seat);
        r.sendRoomState();
        broadcastRoomList();
      }
      break;
    }
    case 'startGame': {
      const r = findRoom(c.roomId);
      if (!r || r.state !== 'waiting') break;
      if (r.players.filter(p => p).length !== 3) { c.send('error', { message: '需要 3 名玩家' }); break; }
      startGame(r);
      break;
    }
    case 'bid': {
      const r = findRoom(c.roomId);
      if (!r || r.state !== 'bidding') break;
      if (r.askBid !== c.playerIndex) break;
      const bid = Number(msg.bid); // 0 = 不叫
      doBid(r, c.playerIndex, bid);
      break;
    }
    case 'play': {
      const r = findRoom(c.roomId);
      if (!r || r.state !== 'playing') break;
      if (r.turn !== c.playerIndex) break;
      const cards = Array.isArray(msg.cards) ? msg.cards.map(Number) : [];
      doPlay(r, c.playerIndex, cards);
      break;
    }
    case 'pass': {
      const r = findRoom(c.roomId);
      if (!r || r.state !== 'playing') break;
      if (r.turn !== c.playerIndex) break;
      doPass(r, c.playerIndex);
      break;
    }
    case 'restart': {
      const r = findRoom(c.roomId);
      if (!r || r.state !== 'over') break;
      startGame(r);
      break;
    }
    case 'getPlayerInfo': {
      // 点击头像查询玩家信息：AI 返回技术等级，真人返回胜率战绩
      const r = findRoom(c.roomId);
      if (!r) break;
      const seat = Number(msg.seat);
      const p = r.players[seat];
      if (!p) { c.send('playerInfo', { seat, exists: false }); break; }
      if (p.isAI) {
        c.send('playerInfo', { seat, name: p.name, isAI: true, level: p.level || '中级' });
      } else {
        const st = stats[p.name] || { games: 0, wins: 0 };
        c.send('playerInfo', { seat, name: p.name, isAI: false, games: st.games, wins: st.wins });
      }
      break;
    }
    default: break;
  }
}

function seatOf(r, c) {
  return r.players.indexOf(c);
}

/** 创建 AI 玩家（名字与等级按座位固定对应：阿福=初级、阿喜=中级、阿财=高级） */
function makeAI(r, seat) {
  const i = seat % 3;
  return { isAI: true, seat, name: r.aiNames[i], level: r.aiLevels[i], id: 'ai' + seat };
}

function onLeave(c) {
  if (!c.roomId) return;
  const r = findRoom(c.roomId);
  if (!r) { c.roomId = null; c.playerIndex = -1; return; }
  const seat = r.players.indexOf(c);
  if (seat >= 0) {
    if (c.id === r.hostId) {
      // 房主离开：解散
      r.sendAll('roomClosed', {});
      clearAiTimer(r);
      rooms.delete(r.id);
    } else {
      r.players[seat] = null;
      if (r.aiSlots.includes(seat)) r.aiSlots = r.aiSlots.filter(s => s !== seat);
      if (r.state !== 'waiting') {
        // 游戏中离开：该座位由 AI 接管
        const ai = makeAI(r, seat);
        r.players[seat] = ai;
        r.aiSlots.push(seat);
        r.sendAll('system', { message: `${c.name} 离开，由 AI 接管` });
        r.sendRoomState();
      } else {
        r.sendRoomState();
      }
      continueIfNeeded(r);
    }
  }
  c.roomId = null; c.playerIndex = -1;
  broadcastRoomList();
}

/* ================= 游戏初始化 ================= */
function startGame(r) {
  clearAiTimer(r);
  r.state = 'bidding';
  // 洗牌发牌（先清空上一局手牌，避免 restart/重新发牌时重复累加）
  r.hands = [[], [], []];
  const deck = engine.shuffle(engine.createDeck());
  for (let i = 0; i < 17; i++) {
    for (let s = 0; s < 3; s++) r.hands[s].push(deck[i * 3 + s]);
  }
  r.bottomCards = deck.slice(51, 54);
  for (let s = 0; s < 3; s++) r.hands[s] = engine.sortHand(r.hands[s]);

  r.landlordSeat = -1;
  r.lastPlaySeat = -1;
  r.lastPlayCards = [];
  r.lastAnalysis = null;
  r.passCount = 0;
  r.multiplier = 1;
  r.baseBid = 0;
  r.bids = [];
  r.bidSeatStart = Math.floor(Math.random() * 3);
  r.askBid = r.bidSeatStart;

  for (const s of [0, 1, 2]) {
    const p = r.players[s];
    if (!p) continue;
    r.sendSeat(s, 'gameStart', { seat: s, hand: r.hands[s], bottomCount: 3, callingSeat: r.askBid });
  }
  r.sendAll('bidTurn', { seat: r.askBid });
  maybeAiBid(r);
}

/* ================= 叫分 ================= */
function doBid(r, seat, bid) {
  if (seat !== r.askBid || r.state !== 'bidding') return;
  const b = Math.floor(Number(bid));
  if (!Number.isInteger(b) || b < 0 || b > 3) {
    r.sendSeat(seat, 'error', { message: '叫分必须是 0-3 的整数' });
    return;
  }
  r.bids.push({ seat, bid: b });
  const p = r.players[seat];
  r.sendAll('bidResult', { seat, name: p ? p.name : '', bid: b });

  if (b > r.baseBid) { r.baseBid = b; r.landlordSeat = seat; }

  // 三人叫完 或 有人叫 3 分即定
  if (r.bids.length >= 3 || r.baseBid === 3) {
    finishBidding(r);
    return;
  }
  r.askBid = (seat + 1) % 3;
  r.sendAll('bidTurn', { seat: r.askBid });
  maybeAiBid(r);
}

function finishBidding(r) {
  if (r.landlordSeat < 0) {
    // 都不叫：重新发牌
    r.sendAll('system', { message: '无人叫地主，重新发牌' });
    startGame(r);
    return;
  }
  r.state = 'playing';
  r.landlordSeat = r.landlordSeat;
  r.multiplier = 1; // 倍数只随炸弹/王炸翻倍，底分(叫分)不折入倍数，结算时 base×multiplier
  // 底牌给地主
  r.hands[r.landlordSeat].push(...r.bottomCards);
  r.hands[r.landlordSeat] = engine.sortHand(r.hands[r.landlordSeat]);

  for (const s of [0, 1, 2]) {
    const p = r.players[s];
    if (p && !p.isAI) {
      r.sendSeat(s, 'landlordSet', {
        landlordSeat: r.landlordSeat,
        bottomCards: r.bottomCards,
        hand: r.hands[s],
        seat: s
      });
    }
  }
  r.sendAll('system', {
    message: `${r.fillName(r.landlordSeat)} 成为地主，叫 ${r.baseBid} 分`
  });
  // 地主先出
  r.turn = r.landlordSeat;
  r.lastPlaySeat = -1;
  r.sendAll('playTurn', { seat: r.turn, lastPlay: null, lastSeat: -1 });
  maybeAiPlay(r);
}

/* ================= 出牌 ================= */
function doPlay(r, seat, cards) {
  if (seat !== r.turn || r.state !== 'playing') return;
  // 校验牌在手
  const hand = r.hands[seat];
  const copy = hand.slice();
  const ok = cards.every(id => {
    const idx = copy.indexOf(id);
    if (idx < 0) return false;
    copy.splice(idx, 1);
    return true;
  });
  if (!ok || cards.length === 0) { r.sendSeat(seat, 'invalid', { message: '出牌不合法' }); return; }
  const analysis = engine.analyze(cards);
  if (!analysis) { r.sendSeat(seat, 'invalid', { message: '无效牌型' }); return; }

  // 是否必须管上（上家可被压时）
  const mustBeat = r.lastPlaySeat !== seat; // 自己不是上一手，需压过
  if (mustBeat) {
    if (!engine.canBeat(cards, r.lastAnalysis)) {
      r.sendSeat(seat, 'invalid', { message: '打不过，无法管上' });
      return;
    }
  } else {
    // 自己上一手（其他人都没过），可自由出
    r.lastAnalysis = null;
  }

  // 通过
  r.hands[seat] = copy;
  r.lastPlaySeat = seat;
  r.lastPlayCards = cards;
  r.lastAnalysis = analysis;
  r.passCount = 0;

  if (analysis.type === engine.T.BOMB) r.multiplier *= 2;
  if (analysis.type === engine.T.ROCKET) r.multiplier *= 2;

  r.sendAll('played', {
    seat,
    name: r.fillName(seat),
    cards,
    typeName: engine.describePlay(cards),
    typeKey: analysis.type,
    multiplier: r.multiplier
  });

  // 判断胜利
  if (r.hands[seat].length === 0) {
    endGame(r, seat);
    return;
  }

  nextTurn(r, seat);
}

function doPass(r, seat) {
  if (seat !== r.turn || r.state !== 'playing') return;
  if (r.lastPlaySeat === -1 || r.lastPlaySeat === seat) {
    r.sendSeat(seat, 'invalid', { message: '必须出牌' });
    return;
  }
  r.sendAll('passed', { seat, name: r.fillName(seat) });
  r.passCount++;
  // 其余两家都过 -> 上一手玩家获得自由出牌权
  if (r.passCount >= 2) {
    r.turn = r.lastPlaySeat;
    r.lastAnalysis = null;
    r.sendAll('playTurn', { seat: r.turn, lastPlay: null, lastSeat: -1 });
    maybeAiPlay(r);
    return;
  }
  nextTurn(r, seat);
}

function nextTurn(r, fromSeat) {
  r.turn = (fromSeat + 1) % 3;
  r.sendAll('playTurn', {
    seat: r.turn,
    lastPlay: r.lastPlayCards.length ? r.lastPlayCards : null,
    lastSeat: r.lastAnalysis ? r.lastPlaySeat : -1
  });
  // 仅告知行动者本人“能否管上”（不泄露给其他玩家），用于前端按钮优化
  const actor = r.players[r.turn];
  if (actor && !actor.isAI && r.lastAnalysis) {
    r.sendSeat(r.turn, 'canFollow', { value: engine.canFollowAny(r.hands[r.turn], r.lastAnalysis) });
  }
  // 若轮到 AI 且场面已稳定，稍后自动出牌
  maybeAiPlay(r);
}

function continueIfNeeded(r) {
  // 换人/补位后，若正在等待某座位操作且该座位是 AI，触发
  if (r.state === 'bidding') maybeAiBid(r);
  else if (r.state === 'playing') maybeAiPlay(r);
}

function clearAiTimer(r) {
  if (r.aiTimer) { clearTimeout(r.aiTimer); r.aiTimer = null; }
}

/** AI 反应速度：等级越高思考越快 */
function aiDelay(level) {
  if (level === '高级') return 650 + Math.random() * 500;
  if (level === '初级') return 1200 + Math.random() * 900;
  return 900 + Math.random() * 700;
}

/** AI 漏跟失误率（能管上却选择不出）：等级越低越容易失误 */
function aiMistChance(level) {
  if (level === '初级') return 0.18;
  if (level === '中级') return 0.07;
  return 0;
}

function maybeAiBid(r) {
  if (r.state !== 'bidding') return;
  clearAiTimer(r);
  const p = r.players[r.askBid];
  if (!p || !p.isAI) return;
  r.aiTimer = setTimeout(() => {
    r.aiTimer = null;
    const hand = r.hands[r.askBid];
    const strength = engine.handStrength(hand);
    // 技术等级影响叫分策略：初级保守、中级标准、高级积极
    let bid = 0;
    if (p.level === '高级') {
      if (strength >= 3) bid = 3;
      else if (strength >= 2) bid = 2;
      else if (strength >= 1) bid = 1;
    } else if (p.level === '初级') {
      if (strength >= 5) bid = 3;
      else if (strength >= 3) bid = 2;
    } else {
      if (strength >= 4) bid = 3;
      else if (strength >= 2) bid = 2;
      else if (strength >= 1) bid = 1;
    }
    doBid(r, r.askBid, bid);
  }, aiDelay(p.level));
}

function maybeAiPlay(r) {
  if (r.state !== 'playing') return;
  clearAiTimer(r);
  const p = r.players[r.turn];
  if (!p || !p.isAI) return;
  r.aiTimer = setTimeout(() => {
    r.aiTimer = null;
    const hand = r.hands[r.turn];
    if (r.lastPlaySeat === r.turn || r.lastAnalysis === null) {
      // 自由出牌
      doPlay(r, r.turn, engine.aiLead(hand));
    } else {
      let cards = engine.aiFollow(hand, r.lastAnalysis);
      // 低等级 AI 偶尔漏跟（能管上却不出）
      if (cards && Math.random() < aiMistChance(p.level)) cards = null;
      if (cards) doPlay(r, r.turn, cards);
      else doPass(r, r.turn);
    }
  }, aiDelay(p.level));
}

function endGame(r, winnerSeat) {
  clearAiTimer(r);
  r.state = 'over';
  const winnerIsLandlord = winnerSeat === r.landlordSeat;
  const base = r.baseBid || 1;
  const delta = base * r.multiplier;
  // 结算（零和）：农民各 ±delta，地主 ∓2×delta
  const score = {};
  for (let s = 0; s < 3; s++) score[s] = 0;
  for (let s = 0; s < 3; s++) {
    const isLandlord = s === r.landlordSeat;
    const winSide = winnerIsLandlord ? isLandlord : !isLandlord;
    if (isLandlord) score[s] = winSide ? 2 * delta : -2 * delta;
    else score[s] = winSide ? delta : -delta;
  }

  // 真人玩家战绩累计（按昵称，供头像信息弹窗展示胜率），持久化到 stats.json
  for (let s = 0; s < 3; s++) {
    const p = r.players[s];
    if (p && !p.isAI) {
      const st = stats[p.name] || (stats[p.name] = { games: 0, wins: 0 });
      st.games++;
      const win = winnerIsLandlord ? s === r.landlordSeat : s !== r.landlordSeat;
      if (win) st.wins++;
    }
  }
  saveStats();

  r.sendAll('gameOver', {
    winnerSeat,
    landlordSeat: r.landlordSeat,
    winnerIsLandlord,
    multiplier: r.multiplier,
    base: r.baseBid,
    score,
    revealHands: {
      0: r.hands[0], 1: r.hands[1], 2: r.hands[2]
    }
  });
}

server.listen(PORT, () => {
  console.log('============================================');
  console.log('  欢乐斗地主 局域网服务器已启动');
  console.log(`  本机访问:   http://localhost:${PORT}`);
  console.log('  局域网访问: http://<本机IP>:' + PORT + '  (浏览器打开)');
  console.log('============================================');
});