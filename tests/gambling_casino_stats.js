// After building engine/: node --test tests/gambling_casino_stats.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { baseEngine } from '../engine/dist/base/index.js';

const source = readFileSync(new URL('../games/GamblingCasino.js', import.meta.url), 'utf8');

// Run the full game with the real map engine and manually driven timers.
function game() {
  const { api, state } = baseEngine();
  const timers = new Map();
  const text = [];
  let timerId = 0;
  const context = vm.createContext({
    ...api,
    onInput() {},
    setLegend: (...bitmaps) => { state.legend = bitmaps; },
    playTune: () => ({ end() {} }),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
    setInterval: () => ++timerId,
    clearInterval() {},
    clearText: () => { text.length = 0; },
    addText: (value, options) => text.push({ value, ...options }),
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  return {
    run, text,
    transition() {
      const id = run('TimerState.transition');
      const fn = timers.get(id);
      assert.ok(fn, 'expected a scheduled game transition');
      timers.delete(id);
      fn();
    },
    stats() {
      return JSON.parse(run('JSON.stringify({session: SessionStats, career: CareerStats, bank: PlayerState.bank})'));
    },
  };
}

function assertHands(g, name, count) {
  assert.equal(g.stats().session.handsPlayed, count);
  assert.equal(g.stats().session.gameCounts[name], count);
}

const hand = values => values.map(v => ({ v, s: '&' }));

test('blackjack double-down counts one resolved hand and preserves both wagers', () => {
  const g = game();
  g.run(`UIState.state = 'blackjack'; stakes = [10]; stakeIndex = 0;
    spendStake(); bjActive = true;
    bjPlayer = ${JSON.stringify(hand([5, 6]))}; bjDealer = ${JSON.stringify(hand([10, 8]))};
    bjDeck = Array.from({length: 20}, () => ({v: 10, s: '&'})); bjDoubleDown();`);
  assertHands(g, 'blackjack', 0);
  assert.equal(g.stats().session.totalWagered, 20);
  g.transition();
  assertHands(g, 'blackjack', 1);
  assert.equal(g.stats().career.handsWon, 1);
  assert.equal(g.stats().bank, 170);
});

for (const dealer of [[10, 8], [1, 10]]) {
  test(`natural blackjack resolves once against dealer ${dealer}`, () => {
    const g = game();
    const cards = [dealer[0], 1, dealer[1], 10].reverse();
    g.run(`UIState.state = 'blackjack'; stakes = [10]; stakeIndex = 0;
      bjDeck = [...Array.from({length: 20}, () => ({v: 2, s: '&'})), ...${JSON.stringify(hand(cards))}];
      bjStartDeal(spendStake());`);
    assertHands(g, 'blackjack', 0);
    for (let i = 0; i < 4; i++) g.transition();
    assertHands(g, 'blackjack', 1);
    assert.equal(g.stats().career.handsWon, dealer[0] === 1 ? 0 : 1);
    assert.equal(g.stats().bank, dealer[0] === 1 ? 150 : 165);
  });
}

for (const [first, second, won, lost, payout] of [
  [[10, 10], [10, 6], 1, 1, 20],
  [[10, 10], [10, 9], 2, 0, 40],
  [[10, 6], [10, 7], 0, 2, 0],
  [[10, 8], [10, 8], 0, 0, 20],
  [[10, 8], [10, 9], 1, 0, 30],
  [[10, 8], [10, 7], 0, 1, 10],
]) {
  test(`split blackjack ${first} / ${second} records each outcome`, () => {
    const g = game();
    g.run(`UIState.state = 'blackjack'; PlayerState.bank = 100;
      PlayerState.lastStake = 10; bjSplitStake = 10; bjActive2 = true;
      bjDealer = ${JSON.stringify(hand([10, 8]))};
      bjPlayer = ${JSON.stringify(hand(first))}; bjPlayer2 = ${JSON.stringify(hand(second))}; bjResolve();`);
    assertHands(g, 'blackjack', 2);
    assert.equal(g.stats().career.handsWon, won);
    assert.equal(g.stats().career.handsLost, lost);
    assert.equal(g.stats().bank, 100 + payout);
  });
}

test('manual and automatic roulette count each resolution once for multiple bets', () => {
  const g = game();
  g.run(`UIState.state = 'roulette'; stakes = [10]; stakeIndex = 0;
    InputStateHandlers.roulette.l(); rouTypeIndex = 1; InputStateHandlers.roulette.l();
    randInt = () => 1;`);
  assertHands(g, 'roulette', 0);
  assert.equal(g.stats().session.totalWagered, 20);
  g.run('spinRoulette(); finishRoulette();');
  assertHands(g, 'roulette', 1);
  assert.equal(g.stats().bank, 150);
  g.run('ShopState.upgrades.autoRoulOn = true;');
  // The auto callback is the final timeout, separate from the transition timer.
  // Capture it through the timer API while preserving the production callback.
  g.run('setTimeout = fn => { globalThis.autoCallback = fn; }; rouletteAutoSpinCheck(); autoCallback();');
  assertHands(g, 'roulette', 1);
  assert.equal(g.stats().session.totalWagered, 40);
  g.run('finishRoulette();');
  assertHands(g, 'roulette', 2);
  assert.equal(g.stats().bank, 150);
});

test('roulette number picker hides the auto label and retains W/S controls', () => {
  const g = game();
  g.run(`UIState.state = 'roulette'; ShopState.upgrades.autoRoul = true;
    rouTypeIndex = 9; rouPick = 7; drawRoulette();`);
  assert.ok(g.text.some(t => t.value === 'W/S 7'));
  assert.ok(!g.text.some(t => t.value.includes('AUTO:')));
  g.run('InputStateHandlers.roulette.w();');
  assert.equal(g.run('rouPick'), 6);
  assert.ok(!g.run('ShopState.upgrades.autoRoulOn'));
  g.run('InputStateHandlers.roulette.s(); rouTypeIndex = 0; drawRoulette();');
  assert.equal(g.run('rouPick'), 7);
  assert.ok(g.text.some(t => t.value === 'W AUTO:OFF'));
  g.run('InputStateHandlers.roulette.w();');
  assert.equal(g.run('ShopState.upgrades.autoRoulOn'), true);
});

for (const [symbol, multiplier, refund] of [
  ['cherry', 1, 5], ['lemon', 1, 8], ['bell', 1, 5],
  ['cherry', 5, 25], ['lemon', 5, 40], ['bell', 5, 25],
]) {
  test(`slot ${symbol} pair with multiplier ${multiplier} classifies its actual refund`, () => {
    const g = game();
    g.run(`PlayerState.bank = 100; PlayerState.lastStake = 10;
      PlayerState.sharkDealType = ${multiplier === 5 ? 2 : 0}; PlayerState.sharkDeadline = 5;
      SlotState.reels = [${symbol}, ${symbol}, bar]; scoreSlot();`);
    assertHands(g, 'slot', 1);
    assert.equal(g.stats().bank, 100 + refund);
    assert.equal(g.stats().session.biggestPayout, refund);
    assert.equal(g.stats().career.handsWon, refund > 10 ? 1 : 0);
    assert.equal(g.stats().career.handsLost, refund < 10 ? 1 : 0);
  });
}

test('equal refunds and default stake returns are pushes; larger payouts win', () => {
  const g = game();
  // No current upgrade produces an equal pair refund, so supply that boundary multiplier.
  g.run(`PlayerState.lastStake = 10; sharkMult = () => 2;
    SlotState.reels = [cherry, cherry, bar]; scoreSlot();`);
  assert.equal(g.stats().bank, 160);
  assert.equal(g.stats().career.handsWon, 0);
  assert.equal(g.stats().career.handsLost, 0);
  const jackpot = g.run('PlayerState.jackpot');
  g.run(`payWin(10, 'PUSH', false, false);`);
  assert.equal(g.stats().bank, 170);
  assert.equal(g.stats().career.handsWon, 0);
  assert.equal(g.stats().career.handsLost, 0);
  g.run(`payWin(100, 'WIN', true, false);`);
  assert.equal(g.stats().bank, 270);
  assert.equal(g.stats().career.handsWon, 1);
  assert.equal(g.run('PlayerState.jackpot'), jackpot);
});

for (const [name, resolve, bank] of [
  ['card', "CardState.current = 5; CardState.next = 8; resolveCardGame('high', 10);", 171],
  ['wheel', "wheel = [{kind: 'mult', mult: 1}]; WheelState.index = 0; wheelBoost = 2; finishWheel();", 170],
]) {
  test(`${name} payout above stake counts a default-outcome win`, () => {
    const g = game();
    g.run(`PlayerState.lastStake = 10; ${resolve}`);
    assertHands(g, name, 1);
    assert.equal(g.stats().bank, bank);
    assert.equal(g.stats().career.handsWon, 1);
  });
}

for (const [name, resolve] of [
  ['slot', 'SlotState.reels = [cherry, lemon, bell]; scoreSlot();'],
  ['card', "CardState.current = 5; CardState.next = 4; resolveCardGame('high', 10);"],
  ['wheel', "wheel = [{kind: 'skull'}]; WheelState.index = 0; finishWheel();"],
]) {
  for (const bank of [0, 100]) {
    test(`${name} loss with bank ${bank} is counted once before bust rendering`, () => {
      const g = game();
      g.run(`PlayerState.bank = ${bank}; PlayerState.debt = 1; PlayerState.lastStake = 10; ${resolve}`);
      assertHands(g, name, 1);
      assert.equal(g.stats().career.handsLost, 1);
      assert.equal(g.stats().career.busts, bank === 0 ? 1 : 0);
      assert.equal(g.stats().bank, bank);
      if (bank === 0) assert.ok(g.text.some(t => t.value === 'CAREER BUSTS: 1'));
    });
  }
}

test('wheel boost continuation counts only its final resolution, including a push', () => {
  const g = game();
  g.run(`PlayerState.lastStake = 10; wheel = [{kind: 'spark'}]; WheelState.index = 0; finishWheel();`);
  assertHands(g, 'wheel', 0);
  g.run(`wheel = [{mult: 1}]; wheelBoost = 1; finishWheel();`);
  assertHands(g, 'wheel', 1);
  assert.equal(g.stats().bank, 160);
});

for (const ending of ['draw', 'extra', 'leave', 'win']) {
  test(`bingo ${ending} counts one completed game`, () => {
    const g = game();
    g.run(`UIState.state = 'bingo'; stakes = [10]; stakeIndex = 0; startBingoRound();`);
    assertHands(g, 'bingo', 0);
    assert.equal(g.stats().session.totalWagered, 10);
    if (ending === 'draw') g.run('BingoState.balls = Array(40).fill(1); bingoDrawBall(); bingoDrawBall();');
    if (ending === 'extra') g.run('BingoState.balls = Array(45).fill(1); InputStateHandlers.bingo.l();');
    if (ending === 'leave') g.run('InputStateHandlers.bingo.k(); InputStateHandlers.bingoConfirm.j();');
    if (ending === 'win') g.run(`BingoState.marks[0] = [true, true, true, true, false];
      BingoState.r = 0; BingoState.c = 4; BingoState.balls = [BingoState.card[0][4]]; bingoAction();`);
    assertHands(g, 'bingo', 1);
    assert.equal(g.stats().career.handsWon, ending === 'win' ? 1 : 0);
    assert.equal(g.stats().career.handsLost, ending === 'win' ? 0 : 1);
  });
}

test('bust entry counts immediately, restart does not; insurance and loan offers are not busts', () => {
  const g = game();
  g.run('PlayerState.bank = 0; ShopState.upgrades.insurance = true; goBust();');
  assert.equal(g.run('UIState.state'), 'insurance_notif');
  assert.equal(g.stats().career.busts, 0);
  g.run('PlayerState.bank = 0; goBust();');
  assert.equal(g.run('UIState.state'), 'loan_shark');
  assert.equal(g.stats().career.busts, 0);
  g.run('InputStateHandlers.loan_shark.k();');
  assert.equal(g.stats().career.busts, 1);
  assert.ok(g.text.some(t => t.value === 'CAREER BUSTS: 1'));
  g.run("titleOrBust('j');");
  assert.equal(g.stats().career.busts, 1);
  g.run('goBust(true);');
  assert.equal(g.stats().career.busts, 2);
  assert.ok(g.text.some(t => t.value === 'CAREER BUSTS: 2'));
});
