'use strict';

// Pure tournament rules: no database and no server are started by this file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/modules/tournaments/tournaments.logic');

const players = (n, ratings) =>
  Array.from({ length: n }, (_, i) => ({ userId: `u${i + 1}`, rating: ratings ? ratings[i] : 1200, order: i + 1 }));

// A finished pairing as the service stores it.
const game = (whiteId, blackId, result, extra = {}) => {
  const [whiteScore, blackScore] = L.scoresForResult(result);
  return { kind: 'game', whiteId, blackId, status: 'done', whiteScore, blackScore, gameId: `g-${whiteId}-${blackId}`, ...extra };
};
const bye = (userId) => ({ kind: 'bye', whiteId: userId, blackId: null, status: 'done', whiteScore: 1, blackScore: 0 });

test('scores: win 1, draw 0.5, loss 0, and a game the server aborted counts 0.5 each', () => {
  assert.deepEqual(L.scoresForResult('1-0'), [1, 0]);
  assert.deepEqual(L.scoresForResult('0-1'), [0, 1]);
  assert.deepEqual(L.scoresForResult('1/2-1/2'), [0.5, 0.5]);
  assert.deepEqual(L.scoresForResult(undefined), [0.5, 0.5]);
});

test('default number of rounds is ceil(log2(players)) and never more than players - 1', () => {
  assert.equal(L.defaultRounds(4), 2);
  assert.equal(L.defaultRounds(5), 3);
  assert.equal(L.defaultRounds(8), 3);
  assert.equal(L.defaultRounds(9), 4);
  assert.equal(L.defaultRounds(32), 5);
  assert.equal(L.defaultRounds(2), 1);
});

test('standings: scores add up, byes and forfeits count as points, order breaks the last tie', () => {
  const ps = players(4);
  const pairings = [
    game('u1', 'u2', '1-0'),
    game('u3', 'u4', '1/2-1/2'),
    { kind: 'game', whiteId: 'u1', blackId: 'u3', status: 'done', whiteScore: 1, blackScore: 0 }, // forfeit: no gameId
    bye('u2'),
  ];
  const table = L.standings(ps, pairings);
  assert.deepEqual(table.map((r) => [r.userId, r.score]), [['u1', 2], ['u2', 1], ['u3', 0.5], ['u4', 0.5]], 'u3 and u4 tie on every tie-break, so join order decides');
  assert.equal(table.find((r) => r.userId === 'u1').score, 2);
  assert.equal(table.find((r) => r.userId === 'u2').score, 1);
  assert.equal(table.find((r) => r.userId === 'u3').score, 0.5);
  assert.equal(table.find((r) => r.userId === 'u4').score, 0.5);
  assert.deepEqual(table.map((r) => r.place), [1, 2, 3, 4]);
  assert.equal(table[0].userId, 'u1');
});

test('standings ignore pairings that are not done', () => {
  const ps = players(2);
  const table = L.standings(ps, [{ ...game('u1', 'u2', '1-0'), status: 'playing' }]);
  assert.deepEqual(table.map((r) => r.score), [0, 0]);
});

test('Buchholz breaks a tie in score, and only games that were really played count', () => {
  // u1 and u2 both end on 1 point. u1 beat u3 (who has 1), u2 beat u4 (who has 0).
  const ps = players(4);
  const pairings = [game('u1', 'u3', '1-0'), game('u2', 'u4', '1-0'), game('u3', 'u4', '1-0')];
  const table = L.standings(ps, pairings);
  const u1 = table.find((r) => r.userId === 'u1');
  const u2 = table.find((r) => r.userId === 'u2');
  assert.equal(u1.score, 1);
  assert.equal(u2.score, 1);
  assert.equal(u1.buchholz, 1, "u1's opponent u3 has 1 point");
  assert.equal(u2.buchholz, 0, "u2's opponent u4 has 0 points");
  assert.ok(u1.place < u2.place, 'higher Buchholz ranks first');

  // A forfeit has no game: it adds the point but not the opponent's score to Buchholz.
  const forfeit = L.standings(players(2), [{ kind: 'game', whiteId: 'u1', blackId: 'u2', status: 'done', whiteScore: 1, blackScore: 0 }]);
  assert.equal(forfeit.find((r) => r.userId === 'u1').buchholz, 0);
  assert.equal(forfeit.find((r) => r.userId === 'u1').played, 0);
});

test('after Buchholz the higher start rating ranks first, then the earlier join order', () => {
  const byRating = L.standings(players(2, [1100, 1500]), []);
  assert.deepEqual(byRating.map((r) => r.userId), ['u2', 'u1']);
  const byOrder = L.standings(players(2), []);
  assert.deepEqual(byOrder.map((r) => r.userId), ['u1', 'u2']);
});

test('round 1 with 4 players pairs the nearest-ranked players; every player appears once', () => {
  const ranked = L.standings(players(4), []);
  const pairs = L.pairRound(ranked, L.history([]));
  assert.equal(pairs.length, 2);
  assert.ok(pairs.every((p) => p.kind === 'game'));
  const ids = pairs.flatMap((p) => [p.whiteId, p.blackId]).sort();
  assert.deepEqual(ids, ['u1', 'u2', 'u3', 'u4']);
  const sets = pairs.map((p) => [p.whiteId, p.blackId].sort().join(','));
  assert.deepEqual(sets.sort(), ['u1,u2', 'u3,u4']);
});

test('nobody meets the same opponent again while a new one exists', () => {
  const ps = players(4);
  const round1 = [game('u1', 'u2', '1-0'), game('u3', 'u4', '1-0')];
  const ranked = L.standings(ps, round1); // u1 and u3 lead with 1 point
  const pairs = L.pairRound(ranked, L.history(round1));
  const sets = pairs.map((p) => [p.whiteId, p.blackId].sort().join(',')).sort();
  assert.deepEqual(sets, ['u1,u3', 'u2,u4'], 'winners meet, losers meet');
  for (const p of pairs) assert.equal(L.history(round1).met.has(L.pairKey(p.whiteId, p.blackId)), false);
});

test('a rematch happens only as a last resort', () => {
  // 2 players, round 2: the only possible opponent is the one already met.
  const ps = players(2);
  const round1 = [game('u1', 'u2', '1-0')];
  const pairs = L.pairRound(L.standings(ps, round1), L.history(round1));
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].whiteId, pairs[0].blackId].sort(), ['u1', 'u2']);
  assert.equal(pairs[0].whiteId, 'u2', 'u1 already had white, so u2 gets it');
});

test('an odd number of players: the lowest-ranked player without a bye sits out', () => {
  const ps = players(5);
  const ranked = L.standings(ps, []);
  const pairs = L.pairRound(ranked, L.history([]));
  const byes = pairs.filter((p) => p.kind === 'bye');
  assert.equal(byes.length, 1);
  assert.equal(byes[0].whiteId, 'u5');
  assert.equal(byes[0].blackId, null);
  assert.equal(pairs.filter((p) => p.kind === 'game').length, 2);

  // u5 already had a bye: the next lowest-ranked player (u4) gets it.
  const round1 = [...pairs.filter((p) => p.kind === 'game').map((p) => game(p.whiteId, p.blackId, '1-0')), bye('u5')];
  const next = L.pairRound(L.standings(ps, round1), L.history(round1));
  const byeAgain = next.find((p) => p.kind === 'bye');
  assert.notEqual(byeAgain.whiteId, 'u5', 'nobody gets a second bye while someone has none');
});

test('colours: the player with fewer whites so far gets white', () => {
  const ps = players(2);
  const round1 = [game('u1', 'u2', '1/2-1/2')];
  const [p] = L.pairRound(L.standings(ps, round1), L.history(round1));
  assert.equal(p.whiteId, 'u2');
  assert.equal(p.blackId, 'u1');
});

test('a full 4-player, 3-round Swiss: nobody plays anybody twice and everybody plays every round', () => {
  const ps = players(4);
  let all = [];
  for (let round = 1; round <= 3; round += 1) {
    const pairs = L.pairRound(L.standings(ps, all), L.history(all));
    assert.equal(pairs.length, 2, `round ${round}`);
    assert.equal(new Set(pairs.flatMap((p) => [p.whiteId, p.blackId])).size, 4, `round ${round}: all players appear`);
    all = all.concat(pairs.map((p) => game(p.whiteId, p.blackId, '1-0')));
  }
  const keys = all.map((p) => L.pairKey(p.whiteId, p.blackId));
  assert.equal(new Set(keys).size, 6, 'three rounds of four players are all different pairs (a full round robin)');
});

test('the same data always gives the same pairings (needed for recovery)', () => {
  const ps = players(8, [1500, 1400, 1300, 1250, 1200, 1100, 1000, 900]);
  const history1 = [game('u1', 'u2', '1-0'), game('u3', 'u4', '0-1'), game('u5', 'u6', '1/2-1/2'), game('u7', 'u8', '1-0')];
  const a = L.pairRound(L.standings(ps, history1), L.history(history1));
  const b = L.pairRound(L.standings(ps, history1), L.history(history1));
  assert.deepEqual(a, b);
});

test('prize shares: 60/40 for 2 to 7 players, 50/30/20 for 8 or more, remainder to first place', () => {
  assert.deepEqual(L.prizeShares(4, 100), [60, 40]);
  assert.deepEqual(L.prizeShares(7, 100), [60, 40]);
  assert.deepEqual(L.prizeShares(8, 100), [50, 30, 20]);
  assert.deepEqual(L.prizeShares(4, 10), [6, 4]);
  assert.deepEqual(L.prizeShares(4, 33), [20, 13], '19 + 1 remainder to first place');
  assert.deepEqual(L.prizeShares(8, 101), [51, 30, 20]);
  assert.deepEqual(L.prizeShares(1, 50), [50]);
  assert.deepEqual(L.prizeShares(8, 0), []);
  for (const pool of [1, 2, 3, 7, 99, 1000, 16000]) {
    for (const n of [4, 8, 32]) assert.equal(L.prizeShares(n, pool).reduce((a, b) => a + b, 0), pool, `pool ${pool}, ${n} players is paid out completely`);
  }
});
