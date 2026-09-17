/* _testengine.js — 飞机牌型专项测试 + 基础牌型回归（临时脚本，验证后可删） */
const E = require('./game-engine');
const { T } = E;

// value -> 取该牌值的前 cnt 张 id
const V = (v, cnt = 1) => {
  const out = [];
  for (let id = 0; id < 52; id++) {
    if (E.cardValue(id) === v && out.length < cnt) out.push(id);
  }
  return out;
};
let pass = 0, fail = 0;
function chk(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name} ${extra}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}
const typeOf = cards => (E.analyze(cards) || {}).type;

/* ---- 新飞机判定 ---- */
let c = E.analyze([...V(3,3), ...V(4,3), ...V(5,1), ...V(6,1)]);
chk('1. 333444+5+6 = 飞机带单', c && c.type === T.AIRPLANE_ONE && c.weight === 4 && c.length === 8, JSON.stringify(c));

c = E.analyze([...V(3,3), ...V(4,3), ...V(5,2)]);
chk('2. 333444+55 = 飞机带单(翼为对)', c && c.type === T.AIRPLANE_ONE && c.weight === 4, JSON.stringify(c));

c = E.analyze([...V(3,3), ...V(4,3), ...V(5,3), ...V(6,2), ...V(7,2), ...V(8,2)]);
chk('3. 333444555+66+77+88 = 飞机带对', c && c.type === T.AIRPLANE_PAIR && c.weight === 5 && c.length === 15, JSON.stringify(c));

c = E.analyze([...V(3,3), ...V(4,3), ...V(5,3), ...V(7,3)]);
chk('4. 333444555+777 = 飞机带单(翼为三张)', c && c.type === T.AIRPLANE_ONE && c.weight === 5 && c.length === 12, JSON.stringify(c));

c = E.analyze([...V(3,4), ...V(4,3), ...V(5,3), ...V(6,1), ...V(7,1)]);
chk('5. 3333(取三)444555+6+7 = 飞机带单(主体含四张取三)', c && c.type === T.AIRPLANE_ONE && c.weight === 5 && c.length === 12, JSON.stringify(c));

c = E.analyze([...V(3,4), ...V(4,4)]);
chk('6. 33334444 = 四带两对(优先于飞机)', c && c.type === T.FOUR_TWO_PAIRS, JSON.stringify(c));

c = E.analyze([...V(3,3), ...V(4,3), ...V(5,3), ...V(6,3), ...V(7,2)]);
chk('7. 14张混合组合 = null', c === null, JSON.stringify(c));

c = E.analyze([...V(3,3), ...V(4,3), ...V(5,3)]);
chk('8. 333444555 = 纯飞机', c && c.type === T.AIRPLANE && c.weight === 5, JSON.stringify(c));

c = E.analyze([...V(13,3), ...V(14,3), ...V(15,3), ...V(5,1), ...V(6,1)]);
chk('9. KKKAAA2+5+6 = null(主体含2)', c === null, JSON.stringify(c));

/* ---- canBeat ---- */
const low = [...V(3,3), ...V(4,3), ...V(5,1), ...V(6,1)];
const high = [...V(4,3), ...V(5,3), ...V(9,1), ...V(10,1)];
chk('10. 444555+9+10 压过 333444+5+6', E.canBeat(high, E.analyze(low)));
const high2 = [...V(3,3), ...V(4,3), ...V(7,1), ...V(8,1)];
chk('11. 333444+7+8 压不过 444555+9+10', !E.canBeat(high2, E.analyze(high)));

const p1 = [...V(3,3), ...V(4,3), ...V(5,2), ...V(6,2)];
const p2 = [...V(4,3), ...V(5,3), ...V(7,2), ...V(8,2)];
chk('12. 飞机带对互压', E.canBeat(p2, E.analyze(p1)) && E.analyze(p2).type === T.AIRPLANE_PAIR);
chk('13. 飞机带对压不了带单', !E.canBeat(p2, E.analyze(low)));

/* ---- AI 跟牌 ---- */
const hand1 = [...V(5,3), ...V(6,3), ...V(7,3), ...V(3,1), ...V(4,1), ...V(9,2), ...V(10,2)];
const f1 = E.aiFollow(hand1, E.analyze(low));
chk('14. AI跟飞机带单', f1 && E.analyze(f1).type === T.AIRPLANE_ONE && E.analyze(f1).weight > 4 && f1.length === 8, JSON.stringify(f1 && f1.map(E.cardValue)));

const L2 = E.analyze([...V(3,3), ...V(4,3), ...V(6,2), ...V(7,2)]);
const hand2 = [...V(5,3), ...V(6,3), ...V(7,3), ...V(3,2), ...V(4,2)];
const f2 = E.aiFollow(hand2, L2);
chk('15. AI跟飞机带对', f2 && E.analyze(f2).type === T.AIRPLANE_PAIR && E.analyze(f2).weight > 4, JSON.stringify(f2 && f2.map(E.cardValue)));

const L3 = E.analyze([...V(3,3), ...V(4,3)]);
const hand3 = [...V(6,3), ...V(7,3), ...V(8,1), ...V(9,1)];
const f3 = E.aiFollow(hand3, L3);
chk('16. AI跟纯飞机', f3 && E.analyze(f3).type === T.AIRPLANE, JSON.stringify(f3 && f3.map(E.cardValue)));

const L4 = E.analyze([...V(10,3), ...V(11,3)]);
const hand4 = [...V(3,3), ...V(4,3)];
chk('17. AI跟不上大飞机=过(null)', E.aiFollow(hand4, L4) === null, JSON.stringify(E.aiFollow(hand4, L4)));

/* ---- 基础牌型回归 ---- */
chk('18. 顺子', typeOf([...V(3,1), ...V(4,1), ...V(5,1), ...V(6,1), ...V(7,1)]) === T.STRAIGHT);
chk('19. 连对', typeOf([...V(3,2), ...V(4,2), ...V(5,2)]) === T.PAIRS);
chk('20. 三带一', typeOf([...V(5,3), ...V(9,1)]) === T.TRIPLE_ONE);
chk('21. 三带对', typeOf([...V(5,3), ...V(9,2)]) === T.TRIPLE_PAIR);
chk('22. 四带二', typeOf([...V(5,4), ...V(3,1), ...V(4,1)]) === T.FOUR_TWO);
chk('23. 炸弹', typeOf([...V(7,4)]) === T.BOMB);
chk('24. 王炸', typeOf([52, 53]) === T.ROCKET);
chk('25. 2不能进顺子', E.analyze([...V(10,1), ...V(11,1), ...V(12,1), ...V(13,1), ...V(14,1), ...V(15,1)]) === null);
chk('25b. 44445555 = 四带两对', typeOf([...V(4,4), ...V(5,4)]) === T.FOUR_TWO_PAIRS);
chk('25c. 44445555 压过 33334444', E.canBeat([...V(4,4), ...V(5,4)], E.analyze([...V(3,4), ...V(4,4)])));
chk('25d. 常规四带两对 5555+66+77', typeOf([...V(5,4), ...V(6,2), ...V(7,2)]) === T.FOUR_TWO_PAIRS);
chk('26. 333444 = 纯飞机(t=2)', typeOf([...V(3,3), ...V(4,3)]) === T.AIRPLANE);
chk('27. 单张', typeOf([...V(15,1)]) === T.SINGLE);
chk('28. 对2', typeOf([...V(15,2)]) === T.PAIR);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
