const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../games/GamblingCasino.js'), 'utf8');
/**
 * Load a fresh casino game with stubbed Sprig APIs and manually advanced timeouts.
 * @returns {{run: (code: string) => *, step: () => void}} Game evaluator and timeout stepper.
 */
function setup() {
  let id = 0;
  const timeouts = new Map();
  const noop = () => {};
  const ctx = vm.createContext({
    bitmap: String.raw, map: String.raw, tune: String.raw, color: String.raw,
    setLegend: noop, setSolids: noop, setBackground: noop, setMap: noop,
    addSprite: noop, clearText: noop, addText: noop, onInput: noop,
    getAll: () => [], getFirst: () => ({x: 0, y: 0}),
    playTune: () => ({end: noop}),
    setInterval: () => ++id, clearInterval: noop,
    setTimeout: (fn) => { timeouts.set(++id, fn); return id; },
    clearTimeout: (key) => timeouts.delete(key),
  });
  const run = code => vm.runInContext(code, ctx);
  run(source);
  return {run,
    /** Run the oldest queued timeout, failing if no timeout is pending. */
    step() { const next = timeouts.entries().next().value; assert.ok(next); timeouts.delete(next[0]); next[1](); }};
}
let failures = 0;
/**
 * Run a synchronous test, logging its result and counting failures for the exit status.
 * @param {string} name - Description included in the result log.
 * @param {() => void} fn - Test body whose thrown errors count as failures.
 */
function test(name, fn) {
  try { fn(); console.log('PASS: ' + name); }
  catch(e) { failures++; console.log('FAIL: ' + name + '\n' + e.message); }
}
test('natural blackjack records a win and the 25-chip payout', () => {
  const {run, step} = setup();
  run(`UIState.state = 'blackjack';
    bjDeck = Array.from({length: 20}, () => ({v: 2, s: bjHeart}));
    bjDeck.push({v: 10, s: bjHeart}, {v: 9, s: bjHeart}, {v: 1, s: bjHeart}, {v: 10, s: bjHeart});
    bjAction();`);
  for(let i = 0; i < 4; i++) step();
  assert.equal(run('PlayerState.bank'), 165);
  assert.equal(run('SessionStats.handsPlayed'), 1);
  const observed = run('JSON.stringify({wins: CareerStats.handsWon, maxPay: SessionStats.biggestPayout})');
  assert.deepEqual(JSON.parse(observed), {wins: 1, maxPay: 25});
});
test('slot half-stake refund records a loss', () => {
  const {run} = setup();
  run(`UIState.state = 'slot'; spendStake(); SlotState.reels = [cherry, cherry, lemon]; scoreSlot();`);
  assert.equal(run('PlayerState.bank'), 145);
  assert.equal(run('SessionStats.handsPlayed'), 1);
  const observed = JSON.parse(run('JSON.stringify({wins: CareerStats.handsWon, losses: CareerStats.handsLost})'));
  assert.deepEqual(observed, {wins: 0, losses: 1});
});
test('roulette mixed bets with a net loss record a loss', () => {
  const {run} = setup();
  run(`UIState.state = 'roulette'; stakes = [10, 25]; stakeIndex = 0;
    rouTypeIndex = rouTypes.indexOf('RED'); InputStateHandlers.roulette.l();
    stakeIndex = 1; rouTypeIndex = rouTypes.indexOf('BLACK'); InputStateHandlers.roulette.l();
    spinRoulette(); randInt = () => 1; finishRoulette();`);
  assert.equal(run('PlayerState.bank'), 135);
  assert.equal(run('SessionStats.handsPlayed'), 1);
  assert.equal(run('SessionStats.totalWagered'), 35);
  const observed = JSON.parse(run('JSON.stringify({wins: CareerStats.handsWon, losses: CareerStats.handsLost})'));
  assert.deepEqual(observed, {wins: 0, losses: 1});
});
test('rebuy resets session stats and retains career stats', () => {
  const {run} = setup();
  run(`SessionStats.totalWagered = 100; SessionStats.handsPlayed = 10;
    CareerStats.handsWon = 3; CareerStats.handsLost = 7; CareerStats.peakCash = 600;
    CareerStats.playTimeSec = 120; UIState.state = 'bust'; handleInput('j');`);
  assert.equal(run('UIState.state'), 'lobby');
  assert.equal(run('PlayerState.bank'), 150);
  assert.equal(run('SessionStats.totalWagered'), 0);
  assert.equal(run('SessionStats.handsPlayed'), 0);
  assert.equal(run('CareerStats.busts'), 1);
  assert.equal(run('CareerStats.handsWon'), 3);
  assert.equal(run('CareerStats.handsLost'), 7);
  assert.equal(run('CareerStats.peakCash'), 600);
  assert.equal(run('CareerStats.playTimeSec'), 120);
});
for (const [name, payout, wins, losses] of [
  ['profit', 20, 1, 0], ['push', 10, 0, 0], ['partial refund', 5, 0, 1]
]) {
  test('shared payout accounting: ' + name, () => {
    const {run} = setup();
    run(`UIState.state = 'slot'; spendStake(); payWin(${payout}, 'RESULT', false);`);
    assert.equal(run('CareerStats.handsWon'), wins);
    assert.equal(run('CareerStats.handsLost'), losses);
    assert.equal(run('SessionStats.biggestPayout'), payout);
  });
}
for (const [name, blackStake, result, wins, losses] of [
  ['profit', 5, 1, 1, 0], ['push', 10, 1, 0, 0], ['total loss', 10, 0, 0, 1]
]) {
  test('roulette accounting: ' + name, () => {
    const {run} = setup();
    run(`UIState.state = 'roulette'; stakes = [10, ${blackStake}]; stakeIndex = 0;
      rouTypeIndex = rouTypes.indexOf('RED'); InputStateHandlers.roulette.l();
      stakeIndex = 1; rouTypeIndex = rouTypes.indexOf('BLACK'); InputStateHandlers.roulette.l();
      spinRoulette(); randInt = () => ${result}; finishRoulette();`);
    assert.equal(run('CareerStats.handsWon'), wins);
    assert.equal(run('CareerStats.handsLost'), losses);
    assert.equal(run('SessionStats.handsPlayed'), 1);
    assert.equal(run('SessionStats.totalWagered'), 10 + blackStake);
  });
}
test('natural blackjack push records payout without a win or loss', () => {
  const {run, step} = setup();
  run(`UIState.state = 'blackjack';
    bjDeck = Array.from({length: 20}, () => ({v: 2, s: bjHeart}));
    bjDeck.push({v: 10, s: bjHeart}, {v: 1, s: bjHeart}, {v: 1, s: bjHeart}, {v: 10, s: bjHeart});
    bjAction();`);
  for(let i = 0; i < 4; i++) step();
  assert.equal(run('PlayerState.bank'), 150);
  assert.equal(run('CareerStats.handsWon'), 0);
  assert.equal(run('CareerStats.handsLost'), 0);
  assert.equal(run('SessionStats.biggestPayout'), 10);
});
process.exitCode = failures ? 1 : 0;
