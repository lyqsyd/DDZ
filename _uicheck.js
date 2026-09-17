/* _uicheck.js — 前端资源一致性检查：
 * 1) client.js mapIds 引用的每个 id 必须存在于 index.html
 * 2) style.css 必须包含本次 UI 改造的关键类
 */
const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9888, path }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

(async () => {
  const html = await get('/');
  const js = await get('/client.js');
  const css = await get('/style.css');
  let issues = 0;

  // 1) mapIds 列表中的 id 检查
  const m = js.match(/\[(?:\s*'[^']+',?\s*)+\]\s*\.\s*forEach/);
  const ids = m ? (m[0].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1)) : [];
  for (const id of ids) {
    if (!html.includes(`id="${id}"`)) { console.log(`FAIL: index.html 缺少 id="${id}"`); issues++; }
  }
  console.log(`mapIds 共 ${ids.length} 个 id，缺失 ${issues} 个`);

  // 2) 关键 CSS 类
  const needCss = ['.pcard', '.pcard .corner', '.pcard .big', '.count-badge', '.deck-area', '.deck-cards',
    '#effectLayer', '.effect-text', '.flash', '.fx-bomb', '.fx-rocket', '.fx-straight', '.fx-pairs', '.fx-plane',
    '.seat-played', '.self-played', '.player-row', '.played-grid', '.action-zone', '.score-row', '.game-body',
    '.bottom-zone', '.score-block', '.card .corner', '.card .big',
    '.jokertxt', '.card.joker .jokertxt', '.pcard.joker .jokertxt', '.info-dialog',
    '.over-dialog', '.over-title', '.over-sub', '.over-card', '.oc-head', '.score-win', '.score-lose',
    'pointer-events: none', 'width: 48px', 'margin-top: auto',
    '@keyframes flashFade',
    '@keyframes cardIn', '@keyframes effectPop', '@keyframes cardBoom', '@keyframes cardSweep',
    '@keyframes cardBounce', '@keyframes cardFly'];
  for (const c of needCss) {
    if (!css.includes(c)) { console.log(`FAIL: style.css 缺少 ${c}`); issues++; }
  }
  // 2a) 已废弃元素不得残留：出牌区提示文字 / 旧包裹层 / 旧王样式 / 旧结算行
  for (const gone of ['.slot-label', '.side-player-wrap', '.card.joker .big', '.pcard.joker .big', '.bottom-info', '.side-title', 'shake']) {
    if (css.includes(gone)) { console.log(`FAIL: style.css 残留已废弃样式 ${gone}`); issues++; }
  }

  // 2b) 全局无滚动条约束
  if (!css.includes('overflow: hidden')) { console.log('FAIL: style.css 缺少全局 overflow:hidden'); issues++; }

  // 3) HTML 结构关键节点
  const needHtml = ['id="deckArea"', 'id="deckCards"', 'id="effectLayer"', 'id="played-left"',
    'id="played-top"', 'id="played-self"', 'id="count-left"', 'id="count-top"', 'id="count-self"',
    'id="myHand"', 'id="actionBar"', 'id="pl-left"', 'id="pl-top"', 'id="pl-self"',
    'id="scoreList"', 'id="scoreMeta"', 'id="bidArea"',
    'class="seat-played"', 'class="self-played"', 'class="player-row"', 'class="played-slot"',
    'class="action-zone"', 'class="side side-left"', 'class="side side-right"', 'class="bottom-zone"',
    'class="score-block"', 'class="over-title win"', 'class="over-sub win"', 'class="over-cards"',
    'id="bidInfo"', 'id="infoOverlay"', 'id="infoBody"', 'id="btnInfoClose"',
    'id="btnRestart"', 'id="btnQuitRoom"'];
  for (const h of needHtml) {
    if (!html.includes(h)) { console.log(`FAIL: index.html 缺少 ${h}`); issues++; }
  }
  // 3a) 出牌区提示文字 / 旧积分面板标题 / 旧底部信息行必须已移除
  for (const goneHtml of ['slot-label', 'id="bottomInfo"', 'side-title']) {
    if (html.includes(goneHtml)) { console.log(`FAIL: index.html 仍残留 ${goneHtml}`); issues++; }
  }

  // 3b) 操作区按钮顺序：出牌 → 不出 → 提示（从左到右）
  const iPlay = html.indexOf('id="btnPlay"'), iPass = html.indexOf('id="btnPass"'), iHint = html.indexOf('id="btnHint"');
  if (!(iPlay !== -1 && iPlay < iPass && iPass < iHint)) { console.log('FAIL: 操作区按钮顺序应为 出牌→不出→提示'); issues++; }

  // 4) client.js 关键函数
  const needJs = ['function pcardHTML', 'function cardHTML', 'function renderPlayed', 'function renderSlots', 'function renderDeck',
    'function renderScores', 'function renderActions', 'function renderBid', 'function fxClassFor', 'function showEffect',
    "case 'played':", "case 'passed':", "case 'landlordSet':", "case 'canFollow':", "case 'playerInfo':",
    'function showPlayerInfo', "send('getPlayerInfo'",
    'function planOrder', "send('play', { cards: planOrder(cards) })",
    "el.btnQuitRoom.onclick = () => { hideOverlay(); send('leaveRoom'); resetToLobby(); }",
    'function onGameOver', 'revealHands', '我不解释', '再战再战',
    "addEventListener('mousedown'", "addEventListener('mouseover'",
    'state.selected.clear(); // 不出时取消已选中的牌',
    "state.phase === 'playing' && state.turn === state.youSeat"];
  for (const f of needJs) {
    if (!js.includes(f)) { console.log(`FAIL: client.js 缺少 ${f}`); issues++; }
  }
  // 4-1) 旧底部提示行 / 旧结算行必须已移除
  for (const goneJs of ['bottomInfo', '你的积分变化', 'shake']) {
    if (js.includes(goneJs)) { console.log(`FAIL: client.js 仍残留 ${goneJs}`); issues++; }
  }
  // 4a) 大小王牌面：仅竖排 JOKER，不得再有 王/大王/小王 字样节点
  if (!/card joker \$\{color\}\$\{sel\}" data-id="\$\{id\}"><span class="jokertxt">JOKER<\/span><\/div>/.test(js)) {
    console.log('FAIL: client.js 手牌大小王结构应为仅 jokertxt'); issues++;
  }
  if (!/pcard joker \$\{color\}"\$\{st\}><span class="jokertxt">JOKER<\/span><\/div>/.test(js)) {
    console.log('FAIL: client.js 桌面牌大小王结构应为仅 jokertxt'); issues++;
  }

  // 5) server.js：getPlayerInfo 接口 / 战绩持久化 / AI 等级
  const srv = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const needSrv = ["case 'getPlayerInfo'", 'STATS_FILE', 'function saveStats', 'saveStats();',
    'function makeAI', 'this.aiLevels', 'function aiDelay', 'function aiMistChance'];
  for (const f of needSrv) {
    if (!srv.includes(f)) { console.log(`FAIL: server.js 缺少 ${f}`); issues++; }
  }

  console.log(issues === 0 ? 'UI-CHECK-PASS: 资源一致性与关键节点全部通过' : `UI-CHECK-FAIL: 共 ${issues} 个问题`);
  process.exit(issues === 0 ? 0 : 1);
})().catch(e => { console.error('UI-CHECK-ERROR:', e.message); process.exit(2); });
