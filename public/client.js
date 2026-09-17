/* ============================================================
 * client.js — 欢乐斗地主 前端逻辑
 * WebSocket 通信 + 大厅/房间/游戏渲染 + 本地牌型校验与提示
 * ============================================================ */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  /* ---------------- 卡片工具（与 game-engine.js 保持一致） ---------------- */
  const SYMBOL = ['♠', '♥', '♣', '♦'];

  function cardValue(id) {
    if (id < 52) return Math.floor(id / 4) + 3;
    return id === 52 ? 16 : 17;
  }
  function isRed(id) {
    if (id < 52) return id % 4 === 1 || id % 4 === 2;
    return id === 53;
  }
  function valueLabel(v) {
    if (v <= 10) return String(v);
    if (v === 11) return 'J';
    if (v === 12) return 'Q';
    if (v === 13) return 'K';
    if (v === 14) return 'A';
    if (v === 15) return '2';
    if (v === 16) return '小王';
    return '大王';
  }
  function sortHand(cards) {
    return cards.slice().sort((a, b) => {
      const va = cardValue(a), vb = cardValue(b);
      if (va !== vb) return va - vb;
      return (a % 4) - (b % 4);
    });
  }
  function buildCounts(cards) {
    const c = {};
    for (const x of cards) { const v = cardValue(x); c[v] = (c[v] || 0) + 1; }
    return c;
  }
  function takeByValue(cards, v, cnt) {
    const out = [];
    for (const x of cards) { if (cardValue(x) === v && out.length < cnt) out.push(x); }
    return out;
  }

  const T = {
    SINGLE: 'single', PAIR: 'pair', TRIPLE: 'triple', TRIPLE_ONE: 'triple1',
    TRIPLE_PAIR: 'triple2', STRAIGHT: 'straight', PAIRS: 'pairs',
    AIRPLANE: 'airplane', AIRPLANE_ONE: 'airplane1', AIRPLANE_PAIR: 'airplane2',
    FOUR_TWO: 'four2', FOUR_TWO_PAIRS: 'four2pairs', BOMB: 'bomb', ROCKET: 'rocket'
  };

  function analyze(cards) {
    const n = cards.length;
    if (n === 0) return null;
    const vals = cards.map(cardValue).sort((a, b) => a - b);
    const cnt = {};
    for (const v of vals) cnt[v] = (cnt[v] || 0) + 1;
    const uv = Object.keys(cnt).map(Number).sort((a, b) => a - b);
    const uc = uv.length;

    if (n === 2 && vals[0] === 16 && vals[1] === 17)
      return { type: T.ROCKET, weight: 1000, length: 2 };

    if (uc === 1) {
      const c = cnt[uv[0]];
      if (c === 1) return { type: T.SINGLE, weight: uv[0], length: 1 };
      if (c === 2) return { type: T.PAIR, weight: uv[0], length: 2 };
      if (c === 3) return { type: T.TRIPLE, weight: uv[0], length: 3 };
      if (c === 4) return { type: T.BOMB, weight: uv[0], length: 4 };
      return null;
    }

    const consecutive = uv.every((v, i) => i === 0 || v === uv[i - 1] + 1);
    const noHigh = uv[uv.length - 1] <= 14;

    if (n >= 5 && uc === n && consecutive && noHigh)
      return { type: T.STRAIGHT, weight: uv[uc - 1], length: n };
    if (n >= 6 && uc === n / 2 && uv.every(v => cnt[v] === 2) && consecutive && noHigh)
      return { type: T.PAIRS, weight: uv[uc - 1], length: n };
    if (n >= 6 && uc === n / 3 && uv.every(v => cnt[v] === 3) && consecutive && noHigh)
      return { type: T.AIRPLANE, weight: uv[uc - 1], length: n };

    if (n === 4 || n === 5) {
      const cvals = uv.map(v => cnt[v]).sort((a, b) => a - b).join(',');
      if (n === 4 && cvals === '1,3') { const t = uv.find(v => cnt[v] === 3); return { type: T.TRIPLE_ONE, weight: t, length: 4 }; }
      if (n === 5 && cvals === '2,3') { const t = uv.find(v => cnt[v] === 3); return { type: T.TRIPLE_PAIR, weight: t, length: 5 }; }
      return null;
    }

    if (n === 6) {
      const cvals = uv.map(v => cnt[v]).sort((a, b) => a - b).join(',');
      if (cvals === '1,1,4') { const f = uv.find(v => cnt[v] === 4); return { type: T.FOUR_TWO, weight: f, length: 6 }; }
      return null;
    }
    if (n === 8) {
      const cvals = uv.map(v => cnt[v]).sort((a, b) => a - b).join(',');
      const quads = uv.filter(v => cnt[v] === 4);
      if ((cvals === '2,2,4' || cvals === '4,4') && quads.length) {
        const f = Math.max(...quads);
        return { type: T.FOUR_TWO_PAIRS, weight: f, length: 8 };
      }
    }

    // 飞机带翼：主体为连续三张段（≥2 组、不含 2/王，某值有 4 张时取其中 3 张），翼牌任意
    if (n >= 8) {
      const triples = uv.filter(v => cnt[v] >= 3).sort((a, b) => a - b);
      const cands = [];
      for (let i = 0; i < triples.length; i++) {
        let j = i;
        while (j + 1 < triples.length && triples[j + 1] === triples[j] + 1) j++;
        for (let top = triples[j]; top - 1 >= triples[i]; top--) cands.push({ t: top - triples[i] + 1, top });
        i = j;
      }
      cands.sort((a, b) => b.t - a.t || b.top - a.top);
      for (const { t, top } of cands) {
        if (t < 2 || top > 14) continue;
        const rem = n - t * 3;
        // 带单：剩余正好 t 张（任意牌）
        if (rem === t) return { type: T.AIRPLANE_ONE, weight: top, length: n };
        // 带对：剩余正好 t 对（各值剩余张数须全为偶数）
        if (rem === t * 2) {
          let pairsOk = true;
          for (const v of uv) {
            const left = cnt[v] - ((v >= top - t + 1 && v <= top) ? 3 : 0);
            if (left % 2 !== 0) { pairsOk = false; break; }
          }
          if (pairsOk) return { type: T.AIRPLANE_PAIR, weight: top, length: n };
        }
      }
    }
    return null;
  }

  function canBeat(newCards, lastAnalysis) {
    const A = analyze(newCards);
    if (!A) return false;
    if (!lastAnalysis) return true;
    if (A.type === T.ROCKET) return true;
    if (lastAnalysis.type === T.ROCKET) return false;
    if (A.type === T.BOMB && lastAnalysis.type === T.BOMB) return A.weight > lastAnalysis.weight;
    if (A.type === T.BOMB) return true;
    if (lastAnalysis.type === T.BOMB) return false;
    if (A.type !== lastAnalysis.type) return false;
    if (A.length !== lastAnalysis.length) return false;
    return A.weight > lastAnalysis.weight;
  }

  /* ---------------- 全局状态 ---------------- */
  const state = {
    id: null,
    name: '',
    youSeat: -1,
    phase: 'lobby', // lobby | waiting | bidding | playing | over
    room: null,
    hand: [],
    selected: new Set(),
    turn: -1,
    askBid: -1,
    landlordSeat: -1,
    bottomCards: [],
    lastPlaySeat: -1,
    lastPlayCards: [],
    counts: [0, 0, 0],
    scores: [0, 0, 0],     // 房间内累计积分（按座位，跨局累加）
    baseBid: 0,            // 当前局底分（最高叫分）
    multiplier: 1,         // 当前局倍数
    canFollow: null,       // 服务端判定“能否管上”（仅轮到自己时有效）
    played: [null, null, null], // 每座位最近出牌（数组）或 [] 表示不出
    playedFx: ['', '', '']      // 每座位最近出牌的特效类名
  };

  let ws = null;

  /* ---------------- DOM 引用 ---------------- */
  const el = {};
  function mapIds() {
    ['myName','nameInput','btnCreate','btnJoin','joinInput','roomList',
     'lobby','game','roomCode','gameState','btnLeave',
     'waitingPanel','waitingCode','waitingSeats','btnAddAI','btnStart',
     'pl-left','pl-top','pl-self',
     'name-left','count-left','role-left',
     'name-top','count-top','role-top',
     'name-self','count-self','role-self',
     'played-left','played-top','played-self',
     'deckArea','deckCards','bidArea','bidBtns','bidInfo','effectLayer',
     'scoreList','scoreMeta',
     'actionBar','btnPlay','btnPass','btnHint','myHand',
     'overlay','overTitle','overSub','overBody','btnRestart','btnQuitRoom','toast',
      'infoOverlay','infoBody','btnInfoClose'
    ].forEach(id => el[id] = $(id));
  }

  /* ---------------- 工具 ---------------- */
  function inGame() {
    return state.phase === 'bidding' || state.phase === 'playing' || state.phase === 'over';
  }
  /* 上家(+2)显示在左上角，下家(+1)显示在右上角，自己在底部 */
  function orderMap() {
    return { left: (state.youSeat + 2) % 3, top: (state.youSeat + 1) % 3, self: state.youSeat };
  }
  function seatName(seat) {
    const p = state.room && state.room.players[seat];
    return p ? p.name : '空位';
  }

  let toastTimer = null;
  function toast(msg) {
    if (!msg) return;
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2200);
  }
  function send(type, data = {}) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, ...data }));
  }
  function currentName() {
    const v = el.nameInput.value.trim();
    return v || ('玩家' + (state.id || '').slice(0, 4));
  }
  function hideOverlay() { el.overlay.classList.add('hidden'); }

  /* ---------------- 出牌特效 ---------------- */
  function fxClassFor(cards) {
    const A = analyze(cards);
    if (!A) return '';
    switch (A.type) {
      case T.ROCKET: return 'fx-rocket';
      case T.BOMB: return 'fx-bomb';
      case T.STRAIGHT: return 'fx-straight';
      case T.PAIRS: return 'fx-pairs';
      case T.AIRPLANE: case T.AIRPLANE_ONE: case T.AIRPLANE_PAIR: return 'fx-plane';
      default: return '';
    }
  }
  let effectTimer = null;
  function showEffect(cards) {
    const A = analyze(cards);
    if (!A) return;
    const conf = {
      [T.BOMB]: { text: '炸弹', cls: 't-bomb', big: true, flash: true },
      [T.ROCKET]: { text: '王炸', cls: 't-rocket', big: true, flash: true },
      [T.STRAIGHT]: { text: '顺子', cls: 't-straight' },
      [T.PAIRS]: { text: '连对', cls: 't-pairs' },
      [T.AIRPLANE]: { text: '飞机', cls: 't-plane' },
      [T.AIRPLANE_ONE]: { text: '飞机', cls: 't-plane' },
      [T.AIRPLANE_PAIR]: { text: '飞机', cls: 't-plane' }
    }[A.type];
    if (!conf) return;
    el.effectLayer.innerHTML =
      (conf.flash ? '<div class="flash"></div>' : '') +
      `<div class="effect-text ${conf.cls}${conf.big ? ' big' : ''}">${conf.text}</div>`;
    clearTimeout(effectTimer);
    effectTimer = setTimeout(() => { el.effectLayer.innerHTML = ''; }, 1500);
  }

  /* ---------------- 渲染 ---------------- */
  /* 手牌与桌面牌同构：角标(点数+花色) + 大花色，内边距由 CSS 等比对齐；大小王仅竖排 JOKER */
  function cardHTML(id) {
    const color = isRed(id) ? 'red' : 'black';
    const sel = state.selected.has(id) ? ' selected' : '';
    if (id >= 52) {
      return `<div class="card joker ${color}${sel}" data-id="${id}"><span class="jokertxt">JOKER</span></div>`;
    }
    const label = valueLabel(cardValue(id));
    const s = SYMBOL[id % 4];
    return `<div class="card ${color}${sel}" data-id="${id}">` +
           `<div class="corner"><b>${label}</b><i>${s}</i></div><div class="big">${s}</div></div>`;
  }
  /* 牌面：角标(点数+花色) + 大花色，用于出牌展示与底牌；大小王仅竖排 JOKER */
  function pcardHTML(id, i) {
    const v = cardValue(id);
    const color = isRed(id) ? 'red' : 'black';
    const st = i === undefined ? '' : ` style="--i:${i}"`;
    if (id >= 52) {
      return `<div class="pcard joker ${color}"${st}><span class="jokertxt">JOKER</span></div>`;
    }
    const label = valueLabel(v);
    const s = SYMBOL[id % 4];
    return `<div class="pcard ${color}"${st}><div class="corner"><b>${label}</b><i>${s}</i></div><div class="big">${s}</div></div>`;
  }

  function renderPlayed(node, cards, fx, base) {
    const sig = (cards ? cards.join(',') : 'null') + '|' + (fx || '');
    if (node.dataset.sig === sig) return; // 内容未变则不重建，避免动画重播
    node.dataset.sig = sig;
    node.className = fx ? base + ' ' + fx : base;
    if (!cards) { node.innerHTML = ''; return; }
    if (cards.length === 0) { node.innerHTML = '<span class="pass-txt">不出</span>'; return; }
    node.innerHTML = cards.map((c, i) => pcardHTML(c, i)).join('');
  }
  function renderSlots() {
    const m = orderMap();
    renderPlayed(el['played-left'], state.played[m.left], state.playedFx[m.left], 'seat-played');
    renderPlayed(el['played-top'], state.played[m.top], state.playedFx[m.top], 'seat-played');
    renderPlayed(el['played-self'], state.played[state.youSeat], state.playedFx[state.youSeat], 'self-played');
  }

  function renderSeats() {
    const room = state.room;
    if (!room) return;
    const m = orderMap();
    const defs = [
      { seat: m.left, row: 'pl-left', name: 'name-left', count: 'count-left', role: 'role-left' },
      { seat: m.top, row: 'pl-top', name: 'name-top', count: 'count-top', role: 'role-top' },
      { seat: state.youSeat, row: 'pl-self', name: 'name-self', count: 'count-self', role: 'role-self', self: true }
    ];
    const activeSeat = state.phase === 'playing' ? state.turn
      : state.phase === 'bidding' ? state.askBid : -1;
    for (const d of defs) {
      const row = el[d.row];
      if (row) row.classList.toggle('turn', d.seat === activeSeat);
      const p = room.players[d.seat];
      el[d.name].textContent = p ? p.name : '空位';
      if (d.count) {
        const n = d.self ? state.hand.length : state.counts[d.seat];
        el[d.count].textContent = inGame() ? n + ' 张' : '';
      }
      const role = el[d.role];
      role.classList.remove('landlord', 'farmer');
      if (inGame()) {
        if (state.landlordSeat === d.seat) { role.textContent = '地主'; role.classList.add('landlord'); }
        else { role.textContent = '农民'; role.classList.add('farmer'); }
      } else {
        role.textContent = '';
      }
    }
    renderSlots();
  }

  function renderHand() {
    el.myHand.innerHTML = state.hand.map(cardHTML).join('');
  }

  /* 底牌：叫分中显示牌背，定地主后亮牌面 */
  function renderDeck() {
    const area = el.deckArea, b = el.deckCards;
    if (state.phase === 'bidding') {
      area.classList.remove('hidden');
      b.innerHTML = '<div class="pcard back"></div><div class="pcard back"></div><div class="pcard back"></div>';
    } else if ((state.phase === 'playing' || state.phase === 'over') && state.bottomCards.length) {
      area.classList.remove('hidden');
      b.innerHTML = state.bottomCards.map((c, i) => pcardHTML(c, i)).join('');
    } else {
      area.classList.add('hidden');
      b.innerHTML = '';
    }
  }

  /* 叫分：只有轮到自己叫分时才显示叫分按钮；bidInfo 在整个叫分阶段可见 */
  function renderBid() {
    const bidding = state.phase === 'bidding';
    const myTurn = bidding && state.askBid === state.youSeat;
    el.bidArea.classList.toggle('hidden', !myTurn);
    el.bidInfo.classList.toggle('hidden', !bidding);
    if (!bidding) { el.bidInfo.textContent = ''; return; }
    el.bidBtns.innerHTML = '';
    const opts = [[0, '不叫'], [1, '1 分'], [2, '2 分'], [3, '3 分']];
    for (const [v, label] of opts) {
      const btn = document.createElement('button');
      btn.className = 'btn' + (v > 0 ? ' primary' : '');
      btn.textContent = label;
      btn.onclick = () => send('bid', { bid: v });
      el.bidBtns.appendChild(btn);
    }
  }

  /* 右侧积分面板 */
  function renderScores() {
    const room = state.room;
    if (!room) return;
    const m = orderMap();
    const rows = [
      { seat: m.left, tag: '上家' },
      { seat: m.top, tag: '下家' },
      { seat: state.youSeat, tag: '我', me: true }
    ];
    el.scoreList.innerHTML = rows.map(r => {
      const p = room.players[r.seat];
      const sc = state.scores[r.seat] || 0;
      const role = inGame() ? (state.landlordSeat === r.seat ? '地主' : '农民') : '';
      const cls = sc > 0 ? 'score-win' : (sc < 0 ? 'score-lose' : '');
      return `<div class="score-row${r.me ? ' me' : ''}">` +
        `<span class="sn">${r.tag}·${p ? p.name : '空位'}</span>` +
        (role ? `<span class="srole">${role}</span>` : '') +
        `<span class="sc ${cls}">${sc > 0 ? '+' : ''}${sc}</span></div>`;
    }).join('');
    let meta = '暂无对局';
    if (state.phase === 'bidding') meta = state.baseBid > 0 ? `当前叫分 ${state.baseBid} 分` : '等待叫分';
    else if (state.phase === 'playing' || state.phase === 'over')
      meta = `底分 ${state.baseBid || 1} × 倍数 ${state.multiplier}`;
    el.scoreMeta.textContent = meta;
  }

  /* 操作按钮：仅自己回合显示；自由出牌不显示「不出」；管不上只显示「不要」 */
  function renderActions() {
    const show = state.phase === 'playing' && state.turn === state.youSeat;
    el.actionBar.classList.toggle('hidden', !show);
    if (!show) return;
    // 自由出牌（地主首出 / 两家不要后）不显示「不出」
    const free = state.lastPlaySeat === -1 || state.lastPlaySeat === state.youSeat;
    // 服务端判定管不上：只显示「不要」
    const noFollow = !free && state.canFollow === false;
    el.btnHint.classList.toggle('hidden', noFollow);
    el.btnPlay.classList.toggle('hidden', noFollow);
    el.btnPass.classList.toggle('hidden', free);
    el.btnPass.textContent = noFollow ? '不要' : '不出';
  }

  function renderWaiting() {
    const show = state.phase === 'waiting';
    el.waitingPanel.classList.toggle('hidden', !show);
    if (!show) return;
    el.waitingCode.textContent = state.room.roomId;
    const isHost = state.room.hostId === state.id;
    const seats = el.waitingSeats;
    seats.innerHTML = '';
    for (let s = 0; s < 3; s++) {
      const p = state.room.players[s];
      const div = document.createElement('div');
      div.className = 'waiting-seat';
      let inner = `<div class="seat-label">座位 ${s + 1}</div>`;
      if (p) {
        inner += `<div class="seat-name">${p.name}</div>`;
        if (p.isAI) {
          inner += `<div class="ai-tag">AI 占位</div>`;
          if (isHost) inner += `<button class="btn small">移除</button>`;
        }
      } else {
        inner += `<div class="seat-name empty">空位</div>`;
      }
      div.innerHTML = inner;
      const rm = div.querySelector('.btn');
      if (rm) rm.onclick = () => send('removeAI', { seat: s });
      seats.appendChild(div);
    }
    el.btnAddAI.classList.toggle('hidden', !isHost || !state.room.players.includes(null));
    el.btnStart.classList.toggle('hidden', !isHost);
    el.btnStart.disabled = state.room.players.filter(p => p).length !== 3;
  }

  function renderRoomList(rooms) {
    const ul = el.roomList;
    ul.innerHTML = '';
    if (!rooms || !rooms.length) {
      ul.innerHTML = '<li style="justify-content:center;cursor:default;">暂无房间，快去创建一个吧</li>';
      return;
    }
    for (const r of rooms) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="code">${r.roomId}</span><span class="meta">${r.players}/3 人${r.isFull ? ' · 已满' : ''}</span>`;
      if (r.isFull) li.style.cursor = 'default';
      li.onclick = () => {
        if (!r.isFull) { el.joinInput.value = r.roomId; send('joinRoom', { roomId: r.roomId }); }
      };
      ul.appendChild(li);
    }
  }

  function renderAll() {
    const inRoom = state.phase !== 'lobby';
    el.lobby.classList.toggle('hidden', inRoom);
    // 等待阶段只显示等待面板，游戏界面隐藏，避免重复占位与滚动
    el.game.classList.toggle('hidden', !inRoom || state.phase === 'waiting');
    if (!inRoom) return;
    el.roomCode.textContent = state.room ? state.room.roomId : '';
    renderWaiting();
    renderSeats();
    renderScores();
    renderDeck();
    renderHand();
    renderBid();
    renderActions();
  }

  /* ---------------- 消息处理 ---------------- */
  function onRoomState(msg) {
    state.room = msg.room;
    state.youSeat = msg.youSeat;
    if (state.phase === 'lobby') {
      state.phase = 'waiting';
      state.scores = [0, 0, 0];
      state.baseBid = 0;
      state.multiplier = 1;
      state.canFollow = null;
      el.gameState.textContent = '等待玩家加入';
    } else if (msg.room.state === 'waiting') {
      state.phase = 'waiting';
      el.gameState.textContent = '等待玩家加入';
    }
  }

  function onGameStart(msg) {
    state.phase = 'bidding';
    state.youSeat = msg.seat;
    state.hand = sortHand(msg.hand);
    state.landlordSeat = -1;
    state.bottomCards = [];
    state.lastPlaySeat = -1;
    state.lastPlayCards = [];
    state.counts = [17, 17, 17];
    state.played = [null, null, null];
    state.playedFx = ['', '', ''];
    state.selected.clear();
    state.baseBid = 0;
    state.multiplier = 1;
    state.canFollow = null;
    state.askBid = msg.callingSeat;
    hideOverlay();
    el.effectLayer.innerHTML = '';
    el.gameState.textContent = '叫分阶段';
    el.bidInfo.textContent = msg.callingSeat === state.youSeat
      ? '轮到你叫分'
      : '等待 ' + seatName(msg.callingSeat) + ' 叫分';
  }

  function onBidTurn(msg) {
    state.askBid = msg.seat;
    state.turn = msg.seat;
    el.bidInfo.textContent = msg.seat === state.youSeat
      ? '轮到你叫分'
      : '等待 ' + seatName(msg.seat) + ' 叫分';
  }

  function onBidResult(msg) {
    el.bidInfo.textContent = msg.name + (msg.bid === 0 ? ' 不叫' : ' 叫 ' + msg.bid + ' 分');
    if (msg.bid > state.baseBid) state.baseBid = msg.bid;
  }

  function onLandlordSet(msg) {
    state.phase = 'playing';
    state.landlordSeat = msg.landlordSeat;
    state.bottomCards = sortHand(msg.bottomCards.slice());
    state.youSeat = msg.seat;
    state.hand = sortHand(msg.hand);
    state.counts[state.landlordSeat] += 3;
    state.selected.clear();
    el.gameState.textContent = '出牌阶段';
  }

  function onPlayTurn(msg) {
    state.turn = msg.seat;
    state.lastPlaySeat = msg.lastSeat;
    state.lastPlayCards = msg.lastPlay ? msg.lastPlay.slice() : [];
    state.canFollow = null; // 等待服务端补发 canFollow 判定
    if (msg.lastSeat === -1) { state.played = [null, null, null]; state.playedFx = ['', '', '']; }
    el.gameState.textContent = '轮到 ' + seatName(msg.seat) + ' 出牌';
  }

  function onPlayed(msg) {
    state.played[msg.seat] = msg.cards.slice();
    state.playedFx[msg.seat] = fxClassFor(msg.cards);
    state.counts[msg.seat] -= msg.cards.length;
    if (msg.multiplier) state.multiplier = msg.multiplier;
    if (msg.seat === state.youSeat) {
      const c = new Set(msg.cards);
      state.hand = sortHand(state.hand.filter(id => !c.has(id)));
      state.selected.clear();
    }
    showEffect(msg.cards);
  }

  function onPassed(msg) {
    state.played[msg.seat] = [];
    state.playedFx[msg.seat] = '';
  }

  function onGameOver(msg) {
    state.phase = 'over';
    // 累计积分（按座位，跨局累加）
    for (let s = 0; s < 3; s++) state.scores[s] = (state.scores[s] || 0) + (msg.score[s] || 0);
    state.baseBid = msg.base || state.baseBid;
    state.multiplier = msg.multiplier || state.multiplier;
    // 结算亮牌：未出完手的玩家剩余牌直接展示在各自出牌区
    const rh = msg.revealHands || {};
    for (let s = 0; s < 3; s++) {
      const rest = rh[s] || [];
      if (rest.length) { state.played[s] = sortHand(rest.slice()); state.playedFx[s] = ''; }
    }
    const Iwin = msg.winnerIsLandlord
      ? state.youSeat === msg.landlordSeat
      : state.youSeat !== msg.landlordSeat;
    // 大标题 + 小标题
    el.overTitle.textContent = Iwin ? '胜利' : '败北';
    el.overTitle.className = 'over-title ' + (Iwin ? 'win' : 'lose');
    el.overSub.textContent = Iwin ? '我不解释' : '再战再战';
    el.overSub.className = 'over-sub ' + (Iwin ? 'win' : 'lose');
    // 地主 / 农民两张小卡片
    const groups = { landlord: [], farmer: [] };
    for (let s = 0; s < 3; s++) {
      const p = state.room.players[s];
      groups[s === msg.landlordSeat ? 'landlord' : 'farmer'].push({
        name: p ? p.name : '空位',
        d: msg.score[s] || 0
      });
    }
    const roleCard = (cls, tag, list) =>
      `<div class="over-card ${cls}"><div class="oc-head">${tag}</div>` +
      list.map(x => `<div class="oc-row"><span class="oc-name">${x.name}</span>` +
        `<span class="${x.d >= 0 ? 'score-win' : 'score-lose'}">${x.d >= 0 ? '+' : ''}${x.d}</span></div>`).join('') +
      `</div>`;
    el.overBody.innerHTML = roleCard('landlord', '地主', groups.landlord) + roleCard('farmer', '农民', groups.farmer);
    el.overlay.classList.remove('hidden');
  }

  /* ---------------- 玩家信息弹窗（点击头像触发） ---------------- */
  function showPlayerInfo(msg) {
    if (msg.exists === false) { toast('该座位暂无玩家'); return; }
    const role = inGame() ? (msg.seat === state.landlordSeat ? '地主' : '农民') : '';
    let rows = '';
    if (msg.isAI) {
      rows += `<div class="info-kv">类型：<b>AI 机器人</b></div>`;
      rows += `<div class="info-kv">技术等级：<b>${msg.level || '中级'}</b></div>`;
    } else {
      const g = msg.games || 0, w = msg.wins || 0;
      const rate = g > 0 ? Math.round(w / g * 100) + '%' : '—';
      rows += `<div class="info-kv">类型：<b>真人玩家</b></div>`;
      rows += `<div class="info-kv">胜率：<b>${rate}</b>（${w} 胜 / ${g} 局）</div>`;
    }
    if (role) rows += `<div class="info-kv">本局身份：<b>${role}</b></div>`;
    el.infoBody.innerHTML =
      `<div><span class="info-name">${msg.name}</span>` +
      `<span class="info-tag${msg.isAI ? ' ai' : ''}">${msg.isAI ? 'AI' : '真人'}</span></div>` +
      rows;
    el.infoOverlay.classList.remove('hidden');
  }

  function resetToLobby() {
    state.phase = 'lobby';
    state.room = null;
    state.youSeat = -1;
    state.hand = [];
    state.selected.clear();
    state.scores = [0, 0, 0];
    state.baseBid = 0;
    state.multiplier = 1;
    state.canFollow = null;
    hideOverlay();
  }

  function handle(msg) {
    switch (msg.type) {
      case 'welcome': state.id = msg.id; break;
      case 'roomList': renderRoomList(msg.rooms); break;
      case 'setName': state.name = msg.name; el.myName.textContent = msg.name; break;
      case 'error': toast(msg.message || '出错'); break;
      case 'system': toast(msg.message || ''); break;
      case 'roomState': onRoomState(msg); break;
      case 'roomClosed': toast('房间已解散'); resetToLobby(); break;
      case 'gameStart': onGameStart(msg); break;
      case 'bidTurn': onBidTurn(msg); break;
      case 'bidResult': onBidResult(msg); break;
      case 'landlordSet': onLandlordSet(msg); break;
      case 'playTurn': onPlayTurn(msg); break;
      case 'canFollow': state.canFollow = !!msg.value; break;
      case 'played': onPlayed(msg); break;
      case 'passed': onPassed(msg); break;
      case 'invalid': toast(msg.message || '操作无效'); break;
      case 'gameOver': onGameOver(msg); break;
      case 'playerInfo': showPlayerInfo(msg); break;
    }
    renderAll();
  }

  /* ---------------- 交互：底部动作 ---------------- */
  /* 出牌规整排序（仅在发送与展示层面，服务端仍会重新校验）：
   * - 顺子/连对/纯飞机/炸弹/王炸/单/对/三张 → 按点数从小到大
   * - 三带一/三带对 → 三张在前，翼牌在后
   * - 四带二/四带两对 → 四张在前
   * - 飞机带单/带对 → 主体三张段在前（analyze 的 weight 即主体最高值），翼牌在后 */
  function planOrder(cards) {
    const byVal = (a, b) => cardValue(a) - cardValue(b);
    const A = analyze(cards);
    if (!A) return cards.slice().sort(byVal);
    const splitBody = (bodyIds) => {
      const set = new Set(bodyIds);
      return [...bodyIds, ...cards.filter(id => !set.has(id)).sort(byVal)];
    };
    const takeN = (val, n) => cards.filter(id => cardValue(id) === val).slice(0, n);
    switch (A.type) {
      case T.TRIPLE_ONE:
      case T.TRIPLE_PAIR:
        return splitBody(takeN(A.weight, 3));
      case T.FOUR_TWO:
      case T.FOUR_TWO_PAIRS:
        return splitBody(takeN(A.weight, 4));
      case T.AIRPLANE_ONE:
      case T.AIRPLANE_PAIR: {
        const k = Math.round((A.type === T.AIRPLANE_ONE ? A.length / 4 : A.length / 5));
        const body = [];
        for (let v = A.weight - k + 1; v <= A.weight; v++) body.push(...takeN(v, 3));
        return splitBody(body);
      }
      default:
        return cards.slice().sort(byVal);
    }
  }

  function doPlay() {
    if (state.phase !== 'playing' || state.turn !== state.youSeat) return;
    const cards = [...state.selected];
    if (!cards.length) { toast('请先选择要出的牌'); return; }
    const A = analyze(cards);
    if (!A) { toast('无效牌型'); return; }
    if (state.lastPlaySeat !== -1 && state.lastPlaySeat !== state.youSeat) {
      const L = analyze(state.lastPlayCards);
      if (!canBeat(cards, L)) { toast('打不过上家的牌'); return; }
    }
    send('play', { cards: planOrder(cards) });
  }

  function findHint() {
    const hand = state.hand;
    if (!hand.length) return [];
    if (state.lastPlaySeat === -1 || state.lastPlaySeat === state.youSeat) {
      return [hand[0]]; // 自由出：出最小单张
    }
    const L = analyze(state.lastPlayCards);
    if (!L) return [hand[0]];
    const counts = buildCounts(hand);
    const vs = Object.keys(counts).map(Number).sort((a, b) => a - b);
    let pick = null;

    if (L.type === T.SINGLE) {
      const t = vs.find(v => v > L.weight && counts[v] >= 1);
      if (t !== undefined) pick = takeByValue(hand, t, 1);
    } else if (L.type === T.PAIR) {
      const t = vs.find(v => v > L.weight && counts[v] >= 2);
      if (t !== undefined) pick = takeByValue(hand, t, 2);
    } else if (L.type === T.TRIPLE) {
      const t = vs.find(v => v > L.weight && counts[v] >= 3);
      if (t !== undefined) pick = takeByValue(hand, t, 3);
    } else if (L.type === T.TRIPLE_ONE) {
      const t = vs.find(v => v > L.weight && counts[v] >= 3);
      if (t !== undefined) {
        const k = vs.find(v => v !== t && counts[v] >= 1);
        if (k !== undefined) pick = [...takeByValue(hand, t, 3), ...takeByValue(hand, k, 1)];
      }
    } else if (L.type === T.TRIPLE_PAIR) {
      const t = vs.find(v => v > L.weight && counts[v] >= 3);
      if (t !== undefined) {
        const k = vs.find(v => v !== t && counts[v] >= 2);
        if (k !== undefined) pick = [...takeByValue(hand, t, 3), ...takeByValue(hand, k, 2)];
      }
    } else if (L.type === T.STRAIGHT) {
      for (let top = L.weight + 1; top <= 14; top++) {
        const start = top - L.length + 1;
        if (start < 3) continue;
        let ok = true;
        for (let v = start; v <= top; v++) if (!counts[v]) { ok = false; break; }
        if (ok) {
          const out = [];
          for (let v = start; v <= top; v++) out.push(...takeByValue(hand, v, 1));
          pick = out; break;
        }
      }
    } else if (L.type === T.PAIRS) {
      const need = L.length / 2;
      for (let top = L.weight + 1; top <= 14; top++) {
        const start = top - need + 1;
        if (start < 3) continue;
        let ok = true;
        for (let v = start; v <= top; v++) if ((counts[v] || 0) < 2) { ok = false; break; }
        if (ok) {
          const out = [];
          for (let v = start; v <= top; v++) out.push(...takeByValue(hand, v, 2));
          pick = out; break;
        }
      }
    } else if (L.type === T.BOMB) {
      const t = vs.find(v => v > L.weight && counts[v] === 4);
      if (t !== undefined) pick = takeByValue(hand, t, 4);
    }

    if (!pick) {
      const b = vs.find(v => counts[v] === 4);
      if (b !== undefined && L.type !== T.ROCKET) pick = takeByValue(hand, b, 4);
    }
    if (!pick) {
      const hasS = hand.find(x => cardValue(x) === 16);
      const hasB = hand.find(x => cardValue(x) === 17);
      if (hasS !== undefined && hasB !== undefined && L.type !== T.ROCKET) pick = [hasS, hasB];
    }
    return pick || [];
  }

  function doHint() {
    if (state.phase !== 'playing' || state.turn !== state.youSeat) return;
    state.selected = new Set(findHint());
    renderHand();
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    el.btnCreate.onclick = () => {
      send('setName', { name: currentName() });
      send('createRoom');
    };
    el.btnJoin.onclick = () => {
      const rid = el.joinInput.value.trim().toUpperCase();
      if (!rid) { toast('请输入房间号'); return; }
      send('setName', { name: currentName() });
      send('joinRoom', { roomId: rid });
    };
    el.btnLeave.onclick = () => { send('leaveRoom'); resetToLobby(); };
    el.btnAddAI.onclick = () => send('addAI');
    el.btnStart.onclick = () => send('startGame');
    el.btnRestart.onclick = () => { hideOverlay(); send('restart'); };
    el.btnQuitRoom.onclick = () => { hideOverlay(); send('leaveRoom'); resetToLobby(); };
    el.btnPass.onclick = () => {
      state.selected.clear(); // 不出时取消已选中的牌
      renderHand();
      send('pass');
    };
    el.btnPlay.onclick = doPlay;
    el.btnHint.onclick = doHint;

    /* 点击头像查看玩家信息（AI→技术等级，真人→胜率） */
    el.btnInfoClose.onclick = () => el.infoOverlay.classList.add('hidden');
    el.infoOverlay.addEventListener('click', (e) => {
      if (e.target === el.infoOverlay) el.infoOverlay.classList.add('hidden');
    });
    const rowSeat = {
      'pl-left': () => orderMap().left,
      'pl-top': () => orderMap().top,
      'pl-self': () => state.youSeat
    };
    for (const row of Object.keys(rowSeat)) {
      const av = el[row] && el[row].querySelector('.avatar');
      if (av) av.onclick = () => send('getPlayerInfo', { seat: rowSeat[row]() });
    }

    /* 滑动连选：按住左键滑过多张牌可连续选中/取消 */
    let dragSel = null; // { target: boolean } 滑选目标状态
    const applySelect = (id, on) => {
      const has = state.selected.has(id);
      if (on === has) return;
      if (on) state.selected.add(id); else state.selected.delete(id);
      renderHand();
    };
    el.myHand.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const card = e.target.closest('.card');
      if (!card || state.phase !== 'playing') return;
      e.preventDefault();
      const id = Number(card.dataset.id);
      dragSel = { target: !state.selected.has(id) };
      applySelect(id, dragSel.target);
    });
    el.myHand.addEventListener('mouseover', (e) => {
      if (!dragSel) return;
      const card = e.target.closest('.card');
      if (!card) return;
      applySelect(Number(card.dataset.id), dragSel.target);
    });
    const endDrag = () => { dragSel = null; };
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('mouseleave', endDrag);

    el.joinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.btnJoin.click();
    });
  }

  /* ---------------- 连接 ---------------- */
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => send('setName', { name: currentName() });
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      handle(m);
    };
    ws.onclose = () => {
      toast('连接断开，正在重连…');
      setTimeout(connect, 1500);
    };
    ws.onerror = () => {};
  }

  /* ---------------- 启动 ---------------- */
  mapIds();
  bindEvents();
  renderAll();
  connect();
})();