/**
 * game-engine.js — 欢乐斗地主核心逻辑（卡片、牌型、AI、房间状态机）
 * 服务端权威逻辑，不依赖 ws，便于测试。
 */

/* ============================ 卡片定义 ============================ */
// 牌 id: 0..51 => 普通牌 (value = floor(id/4)+3, 即 3..15, 其中 11=J 12=Q 13=K 14=A 15=2)
//         52    => 小王 (value 16)
//         53    => 大王 (value 17)
const SUIT_SYMBOL = ['♠', '♥', '♣', '♦'];
const SUIT_COLOR = ['black', 'red', 'black', 'red'];

function cardValue(id) {
  if (id < 52) return Math.floor(id / 4) + 3;
  return id === 52 ? 16 : 17;
}
function cardSuit(id) {
  return id < 52 ? id % 4 : -1;
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
function cardLabel(id) {
  return valueLabel(cardValue(id));
}

function createDeck() {
  const deck = [];
  for (let i = 0; i < 54; i++) deck.push(i);
  return deck;
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function sortHand(cards) {
  // 按牌值升序，同值按花色
  return cards.slice().sort((a, b) => {
    const va = cardValue(a), vb = cardValue(b);
    if (va !== vb) return va - vb;
    return cardSuit(a) - cardSuit(b);
  });
}

/* ============================ 牌型识别 ============================ */
const T = {
  SINGLE: 'single',
  PAIR: 'pair',
  TRIPLE: 'triple',
  TRIPLE_ONE: 'triple1',   // 三带一
  TRIPLE_PAIR: 'triple2',  // 三带对
  STRAIGHT: 'straight',    // 顺子
  PAIRS: 'pairs',          // 连对
  AIRPLANE: 'airplane',    // 飞机（纯）
  AIRPLANE_ONE: 'airplane1', // 飞机带单
  AIRPLANE_PAIR: 'airplane2',// 飞机带对
  FOUR_TWO: 'four2',       // 四带二（两单）
  FOUR_TWO_PAIRS: 'four2pairs', // 四带两对
  BOMB: 'bomb',
  ROCKET: 'rocket'
};

const TYPE_NAME = {
  single: '单张', pair: '对子', triple: '三张', triple1: '三带一', triple2: '三带二',
  straight: '顺子', pairs: '连对', airplane: '飞机', airplane1: '飞机带单',
  airplane2: '飞机带对', four2: '四带二', four2pairs: '四带两对', bomb: '炸弹', rocket: '王炸'
};

function analyze(cards) {
  const n = cards.length;
  if (n === 0) return null;
  const vals = cards.map(cardValue).sort((a, b) => a - b);
  const cnt = {};
  for (const v of vals) cnt[v] = (cnt[v] || 0) + 1;
  const uv = Object.keys(cnt).map(Number).sort((a, b) => a - b);
  const uc = uv.length;

  // 王炸
  if (n === 2 && vals[0] === 16 && vals[1] === 17)
    return { type: T.ROCKET, weight: 1000, length: 2 };

  // 单种牌（单/对/三/炸）
  if (uc === 1) {
    const c = cnt[uv[0]];
    if (c === 1) return { type: T.SINGLE, weight: uv[0], length: 1 };
    if (c === 2) return { type: T.PAIR, weight: uv[0], length: 2 };
    if (c === 3) return { type: T.TRIPLE, weight: uv[0], length: 3 };
    if (c === 4) return { type: T.BOMB, weight: uv[0], length: 4 };
    return null;
  }

  const consecutive = uv.every((v, i) => i === 0 || v === uv[i - 1] + 1);
  const noHigh = uv[uv.length - 1] <= 14; // 顺子/连对/飞机不含 2 与王

  // 顺子
  if (n >= 5 && uc === n && consecutive && noHigh)
    return { type: T.STRAIGHT, weight: uv[uc - 1], length: n };

  // 连对
  if (n >= 6 && uc === n / 2 && uv.every(v => cnt[v] === 2) && consecutive && noHigh)
    return { type: T.PAIRS, weight: uv[uc - 1], length: n };

  // 飞机（纯三连，不带翼）
  if (n >= 6 && uc === n / 3 && uv.every(v => cnt[v] === 3) && consecutive && noHigh)
    return { type: T.AIRPLANE, weight: uv[uc - 1], length: n };

  // 三带一 / 三带对
  if (n === 4 || n === 5) {
    const cvals = uv.map(v => cnt[v]).sort((a, b) => a - b).join(',');
    if (n === 4 && cvals === '1,3') {
      const t = uv.find(v => cnt[v] === 3);
      return { type: T.TRIPLE_ONE, weight: t, length: 4 };
    }
    if (n === 5 && cvals === '2,3') {
      const t = uv.find(v => cnt[v] === 3);
      return { type: T.TRIPLE_PAIR, weight: t, length: 5 };
    }
    return null;
  }

  // 四带二（两单）
  if (n === 6) {
    const cvals = uv.map(v => cnt[v]).sort((a, b) => a - b).join(',');
    if (cvals === '1,1,4') {
      const f = uv.find(v => cnt[v] === 4);
      return { type: T.FOUR_TWO, weight: f, length: 6 };
    }
    return null;
  }
  // 四带两对（其余 8 张组合继续向下尝试飞机带翼，如 333444+5+6）
  if (n === 8) {
    const cvals = uv.map(v => cnt[v]).sort((a, b) => a - b).join(',');
    const quads = uv.filter(v => cnt[v] === 4);
    if ((cvals === '2,2,4' || cvals === '4,4') && quads.length) {
      // 两对牌均为四张时（如 33334444），取较大的四张为主体、其余拆作两对
      const f = Math.max(...quads);
      return { type: T.FOUR_TWO_PAIRS, weight: f, length: 8 };
    }
  }

  // 飞机带翼：主体为连续三张段（≥2 组、不含 2/王，某值有 4 张时取其中 3 张）
  //   AAABBB+X...（带单，翼牌任意 t 张）/ AAABBB+XX...（带对，翼牌任意 t 对）
  if (n >= 8) {
    const triples = uv.filter(v => cnt[v] >= 3).sort((a, b) => a - b);
    // 枚举所有连续三张段的全部子段（长段优先、高点优先，优先匹配最大主体）
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

function isRocket(cards) { const a = analyze(cards); return a && a.type === T.ROCKET; }

/* ============================ 牌面描述 ============================ */
function describePlay(cards) {
  const a = analyze(cards);
  if (!a) return '无效牌型';
  if (a.type === T.SINGLE || a.type === T.PAIR || a.type === T.TRIPLE || a.type === T.BOMB) {
    return `${TYPE_NAME[a.type]}`;
  }
  return TYPE_NAME[a.type];
}

/* ============================ AI ============================ */
function handStrength(cards) {
  let s = 0;
  const cnt = {};
  for (const c of cards) {
    const v = cardValue(c);
    cnt[v] = (cnt[v] || 0) + 1;
  }
  for (const v in cnt) {
    const c = cnt[v];
    if (c === 4) s += 4;          // 炸弹
    if (v === '15') s += 1;       // 2
    if (v === '16') { s += 2; if (cnt['17']) s += 2; } // 小王（有王炸再加）
    if (v === '17') s += 3;       // 大王
    if (c === 3) s += 1;          // 三张
  }
  return s;
}

// 生成从 hand（牌 id 数组）出发、指定长度的顺子（值域 3..14）
function straightRuns(counts, minLen) {
  const runs = [];
  for (let start = 3; start <= 14; start++) {
    for (let len = minLen; start + len - 1 <= 14; len++) {
      let ok = true;
      for (let v = start; v < start + len; v++) if (!counts[v]) { ok = false; break; }
      if (ok) runs.push({ start, len, top: start + len - 1 });
      else break;
    }
  }
  return runs;
}
function pairRuns(counts, minLen) {
  const runs = [];
  for (let start = 3; start <= 14; start++) {
    for (let len = minLen; start + len - 1 <= 14; len++) {
      let ok = true;
      for (let v = start; v < start + len; v++) if ((counts[v] || 0) < 2) { ok = false; break; }
      if (ok) runs.push({ start, len, top: start + len - 1 });
      else break;
    }
  }
  return runs;
}
// 从 id 数组中取出 value === v 的 cnt 张
function takeByValue(cards, v, cnt) {
  const out = [];
  for (const c of cards) if (cardValue(c) === v && out.length < cnt) out.push(c);
  return out;
}

function buildCounts(cards) {
  const counts = {};
  for (const c of cards) counts[cardValue(c)] = (counts[cardValue(c)] || 0) + 1;
  return counts;
}

function findRocket(cards) {
  const hasS = cards.find(c => cardValue(c) === 16);
  const hasB = cards.find(c => cardValue(c) === 17);
  return hasS !== undefined && hasB !== undefined ? [hasS, hasB] : null;
}

// AI 出牌：先手
function aiLead(cards) {
  const counts = buildCounts(cards);
  const vs = Object.keys(counts).map(Number).sort((a, b) => a - b);

  // 连对（小优先）
  const pruns = pairRuns(counts, 3);
  if (pruns.length) {
    const r = pruns[0];
    const out = [];
    for (let v = r.start; v <= r.top; v++) out.push(...takeByValue(cards, v, 2));
    return out;
  }
  // 顺子（短优先，小优先）
  const sruns = straightRuns(counts, 5);
  if (sruns.length) {
    const r = sruns.sort((a, b) => a.len - b.len || a.top - b.top)[0];
    const out = [];
    for (let v = r.start; v <= r.top; v++) out.push(...takeByValue(cards, v, 1));
    return out;
  }
  // 三带一 / 三带对 / 三张
  const triples = vs.filter(v => counts[v] === 3).sort((a, b) => a - b);
  if (triples.length) {
    const t = triples[0];
    const pairKick = vs.find(v => v !== t && counts[v] === 2);
    if (pairKick !== undefined) {
      return [...takeByValue(cards, t, 3), ...takeByValue(cards, pairKick, 2)];
    }
    const singleKick = vs.find(v => v !== t && counts[v] === 1);
    if (singleKick !== undefined) {
      return [...takeByValue(cards, t, 3), ...takeByValue(cards, singleKick, 1)];
    }
    return takeByValue(cards, t, 3);
  }
  // 对子
  const pairs = vs.filter(v => counts[v] === 2 || counts[v] === 3 || counts[v] === 4).sort((a, b) => a - b);
  if (pairs.length) {
    return takeByValue(cards, pairs[0], 2);
  }
  // 单张（最小）
  return [sortHand(cards)[0]];
}

// 出牌 AI：跟牌（须大于 lastAnalysis）
function aiFollow(cards, lastAnalysis) {
  const counts = buildCounts(cards);
  const vs = Object.keys(counts).map(Number).sort((a, b) => a - b);
  const L = lastAnalysis;
  if (!L) return null;

  // 同型候选
  let pick = null;
  const tryPick = (cardsArr) => {
    if (!pick && cardsArr && canBeat(cardsArr, L)) pick = cardsArr;
  };

  switch (L.type) {
    case T.SINGLE: {
      const t = vs.find(v => v > L.weight && counts[v] >= 1);
      if (t !== undefined) pick = takeByValue(cards, t, 1);
      break;
    }
    case T.PAIR: {
      const t = vs.find(v => v > L.weight && counts[v] >= 2);
      if (t !== undefined) pick = takeByValue(cards, t, 2);
      break;
    }
    case T.TRIPLE: {
      const t = vs.find(v => v > L.weight && counts[v] >= 3);
      if (t !== undefined) pick = takeByValue(cards, t, 3);
      break;
    }
    case T.TRIPLE_ONE: {
      const t = vs.find(v => v > L.weight && counts[v] >= 3);
      if (t !== undefined) {
        const kick = vs.find(v => v !== t && counts[v] >= 1);
        if (kick !== undefined) pick = [...takeByValue(cards, t, 3), ...takeByValue(cards, kick, 1)];
      }
      break;
    }
    case T.TRIPLE_PAIR: {
      const t = vs.find(v => v > L.weight && counts[v] >= 3);
      if (t !== undefined) {
        const kick = vs.find(v => v !== t && counts[v] >= 2);
        if (kick !== undefined) pick = [...takeByValue(cards, t, 3), ...takeByValue(cards, kick, 2)];
      }
      break;
    }
    case T.STRAIGHT: {
      const runs = straightRuns(counts, 5)
        .filter(r => r.len === L.length && r.top > L.weight)
        .sort((a, b) => a.top - b.top);
      if (runs.length) {
        const r = runs[0];
        const out = [];
        for (let v = r.start; v <= r.top; v++) out.push(...takeByValue(cards, v, 1));
        pick = out;
      }
      break;
    }
    case T.PAIRS: {
      const runs = pairRuns(counts, 3)
        .filter(r => r.len === L.length / 2 && r.top > L.weight)
        .sort((a, b) => a.top - b.top);
      if (runs.length) {
        const r = runs[0];
        const out = [];
        for (let v = r.start; v <= r.top; v++) out.push(...takeByValue(cards, v, 2));
        pick = out;
      }
      break;
    }
    case T.BOMB: {
      const t = vs.find(v => v > L.weight && counts[v] === 4);
      if (t !== undefined) pick = takeByValue(cards, t, 4);
      break;
    }
    case T.AIRPLANE:
    case T.AIRPLANE_ONE:
    case T.AIRPLANE_PAIR: {
      // 飞机跟牌：从高到低找更大的连续三张段；带单翼牌任意、带对翼牌须成对
      const k = L.type === T.AIRPLANE ? L.length / 3
        : (L.type === T.AIRPLANE_ONE ? L.length / 4 : L.length / 5);
      const wingsNeed = L.type === T.AIRPLANE ? 0 : (L.type === T.AIRPLANE_ONE ? k : k * 2);
      for (let top = 14; top - k + 1 >= 3; top--) {
        if (top <= L.weight) break;
        let ok = true;
        for (let v = top - k + 1; v <= top; v++) if ((counts[v] || 0) < 3) { ok = false; break; }
        if (!ok) continue;
        const body = [];
        for (let v = top - k + 1; v <= top; v++) body.push(...takeByValue(cards, v, 3));
        const bodySet = new Set(body);
        const pool = cards.filter(c => !bodySet.has(c));
        if (pool.length < wingsNeed) continue;
        let cand = body;
        if (wingsNeed) {
          const rc = buildCounts(pool);
          const wings = [];
          let taken = 0;
          if (L.type === T.AIRPLANE_ONE) {
            // 翼牌任意：从小到大取
            for (const v of Object.keys(rc).map(Number).sort((a, b) => a - b)) {
              while (rc[v] > 0 && taken < wingsNeed) { wings.push(...takeByValue(pool, v, 1)); rc[v]--; taken++; }
              if (taken >= wingsNeed) break;
            }
          } else {
            // 翼牌须成对：从小对开始取
            for (const v of Object.keys(rc).map(Number).sort((a, b) => a - b)) {
              while (rc[v] >= 2 && taken < wingsNeed) { wings.push(...takeByValue(pool, v, 2)); rc[v] -= 2; taken += 2; }
              if (taken >= wingsNeed) break;
            }
          }
          if (wings.length < wingsNeed) continue;
          cand = [...body, ...wings];
        }
        // 终检：同型同长且主体更大（防止主体吸收翼牌后变成纯飞机等异型）
        const pa = analyze(cand);
        if (pa && pa.type === L.type && pa.length === L.length && pa.weight > L.weight) { pick = cand; break; }
      }
      break;
    }
    // 四带二等复杂牌型：AI 简化处理，跳过（可炸弹 / 王炸 / 过）
    default:
      break;
  }

  if (pick) return pick;

  // 无法同型 -> 炸弹
  const bombs = vs.filter(v => counts[v] === 4).sort((a, b) => a - b);
  if (bombs.length && L.type !== T.ROCKET) return takeByValue(cards, bombs[0], 4);

  // 王炸
  const rocket = findRocket(cards);
  if (rocket && L.type !== T.ROCKET) return rocket;

  return null; // 过
}

/* ============================ 跟牌判定 ============================ */
// 是否存在长度 k、最高值 > minTop 的连续三张段（飞机用）
function hasTripleRun(counts, k, minTop) {
  if (k < 2) return false;
  for (let top = 14; top >= 3 + k - 1; top--) {
    if (top <= minTop) return false;
    let ok = true;
    for (let v = top - k + 1; v <= top; v++) if ((counts[v] || 0) < 3) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

// 判断 hand 中是否存在任意能压过 lastAnalysis 的出牌（服务端权威判定，供前端按钮优化）
function canFollowAny(cards, L) {
  if (!L) return true; // 自由出牌
  const counts = buildCounts(cards);
  const vs = Object.keys(counts).map(Number).sort((a, b) => a - b);

  switch (L.type) {
    case T.SINGLE:
      if (vs.some(v => v > L.weight)) return true;
      break;
    case T.PAIR:
      if (vs.some(v => v > L.weight && counts[v] >= 2)) return true;
      break;
    case T.TRIPLE:
      if (vs.some(v => v > L.weight && counts[v] >= 3)) return true;
      break;
    case T.TRIPLE_ONE:
      for (const t of vs) {
        if (t > L.weight && counts[t] >= 3 && vs.some(v => v !== t)) return true;
      }
      break;
    case T.TRIPLE_PAIR:
      for (const t of vs) {
        if (t > L.weight && counts[t] >= 3 && vs.some(v => v !== t && counts[v] >= 2)) return true;
      }
      break;
    case T.STRAIGHT:
      for (let top = 14; top - L.length + 1 >= 3; top--) {
        if (top <= L.weight) break;
        let ok = true;
        for (let v = top - L.length + 1; v <= top; v++) if (!counts[v]) { ok = false; break; }
        if (ok) return true;
      }
      break;
    case T.PAIRS: {
      const need = L.length / 2;
      for (let top = 14; top - need + 1 >= 3; top--) {
        if (top <= L.weight) break;
        let ok = true;
        for (let v = top - need + 1; v <= top; v++) if ((counts[v] || 0) < 2) { ok = false; break; }
        if (ok) return true;
      }
      break;
    }
    case T.AIRPLANE:
    case T.AIRPLANE_ONE:
    case T.AIRPLANE_PAIR: {
      const k = L.type === T.AIRPLANE ? L.length / 3
        : L.type === T.AIRPLANE_ONE ? L.length / 4 : L.length / 5;
      if (hasTripleRun(counts, k, L.weight)) {
        if (L.type === T.AIRPLANE) return true;
        // 带翼：宽松判断剩余牌数足够作翼（宁可多显示按钮，最终由服务端校验）
        let total = 0;
        for (const v of vs) total += counts[v];
        const needK = k * (L.type === T.AIRPLANE_ONE ? 1 : 2);
        if (total - k * 3 >= needK) return true;
      }
      break;
    }
    case T.FOUR_TWO:
    case T.FOUR_TWO_PAIRS:
      // 更大的四带二：其四张本身即可作炸弹压过
      if (vs.some(v => v > L.weight && counts[v] === 4)) return true;
      break;
    case T.BOMB:
      if (vs.some(v => v > L.weight && counts[v] === 4)) return true;
      break;
    case T.ROCKET:
      return false;
  }

  // 兜底：任意炸弹 / 王炸可压非王炸
  if (L.type !== T.ROCKET) {
    if (vs.some(v => counts[v] === 4)) return true;
    if (counts[16] && counts[17]) return true;
  }
  return false;
}

/* ============================ 房间状态机 ============================ */
module.exports = {
  cardValue, cardSuit, cardLabel, valueLabel, sortHand, createDeck, shuffle,
  analyze, canBeat, describePlay, isRocket, TYPE_NAME, T, SUIT_SYMBOL, SUIT_COLOR,
  handStrength, aiLead, aiFollow, canFollowAny
};