'use strict';

/**
 * Pure tournament rules (D-052, D-054, D-055): Swiss pairing, scoring, standings and prizes.
 * No database, no clock, no randomness, so the same stored data always gives the same answer.
 * That matters for recovery: after a restart the server recomputes standings and pairings from
 * the stored results instead of trusting counters that a crash could have left stale.
 *
 * Pairing is a simple greedy algorithm, NOT the full FIDE Dutch system (D-052): it is good enough
 * for a group of friends and is documented as such.
 */

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 32;

/** [whiteScore, blackScore] for a finished game result, or for a game the server aborted (D-055). */
function scoresForResult(result) {
  if (result === '1-0') return [1, 0];
  if (result === '0-1') return [0, 1];
  return [0.5, 0.5]; // draw, or aborted by the server (fewer than 2 moves)
}

/** Number of rounds when the creator did not choose: ceil(log2(players)), at most players - 1. */
function defaultRounds(players) {
  return Math.max(1, Math.min(players - 1, Math.ceil(Math.log2(players))));
}

const pairKey = (a, b) => [String(a), String(b)].sort().join(':');

/**
 * Facts about the finished pairings that the pairing algorithm needs.
 * `pairings` are the stored pairings of all rounds ({ kind, whiteId, blackId, status }).
 */
function history(pairings) {
  const met = new Set();
  const byes = new Set();
  const whites = new Map();
  for (const p of pairings) {
    if (p.kind === 'bye') {
      byes.add(String(p.whiteId));
    } else {
      met.add(pairKey(p.whiteId, p.blackId));
      whites.set(String(p.whiteId), (whites.get(String(p.whiteId)) || 0) + 1);
    }
  }
  return { met, byes, whites };
}

/**
 * Standings. `players`: [{ userId, rating, order }]. `pairings`: every stored pairing of every
 * round; only `status: 'done'` ones count. Returns players sorted best first with
 * { userId, score, buchholz, rating, order, place, played }.
 *
 * Scoring (D-055): win 1, draw 0.5, loss 0, bye 1, win by forfeit 1 (the absent player 0), a game
 * aborted by the server 0.5 each. Tie-breaks: Buchholz (sum of the final scores of the opponents
 * you actually PLAYED a game against, forfeits and byes excluded), then rating at the start,
 * then join order.
 */
function standings(players, pairings) {
  const row = new Map(players.map((p) => [String(p.userId), { userId: String(p.userId), score: 0, buchholz: 0, rating: p.rating, order: p.order, played: 0 }]));
  const opponents = new Map(players.map((p) => [String(p.userId), []]));
  for (const p of pairings) {
    if (p.status !== 'done') continue;
    const white = row.get(String(p.whiteId));
    if (white) white.score += p.whiteScore;
    if (p.kind === 'bye') continue;
    const black = row.get(String(p.blackId));
    if (black) black.score += p.blackScore;
    if (p.gameId) {
      if (white) white.played += 1;
      if (black) black.played += 1;
      if (opponents.has(String(p.whiteId))) opponents.get(String(p.whiteId)).push(String(p.blackId));
      if (opponents.has(String(p.blackId))) opponents.get(String(p.blackId)).push(String(p.whiteId));
    }
  }
  for (const [id, list] of opponents) {
    const r = row.get(id);
    r.buchholz = list.reduce((sum, opp) => sum + (row.get(opp) ? row.get(opp).score : 0), 0);
  }
  const sorted = Array.from(row.values()).sort(
    (a, b) => b.score - a.score || b.buchholz - a.buchholz || b.rating - a.rating || a.order - b.order
  );
  sorted.forEach((r, i) => {
    r.place = i + 1;
  });
  return sorted;
}

/**
 * The next round's pairings. `ranked` is the current standings (best first). Returns
 * [{ kind: 'game', whiteId, blackId } ... , { kind: 'bye', whiteId, blackId: null }?].
 *  - An odd number of players: the lowest-ranked player who has not had a bye gets one
 *    (the lowest-ranked player of all if everybody had one).
 *  - Everybody else: each player, best first, is paired with the nearest-ranked unpaired player
 *    they have NOT met. If there is none, the nearest unpaired player (a rematch) is the last resort.
 *  - White goes to the player who has had fewer whites so far; on a tie to the better-ranked one.
 */
function pairRound(ranked, hist) {
  const pool = ranked.map((r) => String(r.userId));
  let bye = null;
  if (pool.length % 2 === 1) {
    for (let i = pool.length - 1; i >= 0; i -= 1) {
      if (!hist.byes.has(pool[i])) {
        bye = pool[i];
        break;
      }
    }
    if (bye === null) bye = pool[pool.length - 1];
    pool.splice(pool.indexOf(bye), 1);
  }

  const out = [];
  const used = new Set();
  for (const a of pool) {
    if (used.has(a)) continue;
    used.add(a);
    let b = pool.find((x) => !used.has(x) && !hist.met.has(pairKey(a, x)));
    if (b === undefined) b = pool.find((x) => !used.has(x));
    used.add(b);
    const aWhites = hist.whites.get(a) || 0;
    const bWhites = hist.whites.get(b) || 0;
    const aWhite = aWhites <= bWhites;
    out.push({ kind: 'game', whiteId: aWhite ? a : b, blackId: aWhite ? b : a });
  }
  if (bye !== null) out.push({ kind: 'bye', whiteId: bye, blackId: null });
  return out;
}

/**
 * How the prize pool is shared (D-054): one player gets everything; 2 to 7 players pay 2 places
 * 60/40; 8 or more pay 3 places 50/30/20. The rounding remainder goes to first place.
 * Returns an array of amounts, first place first (empty when the pool is empty).
 */
function prizeShares(playerCount, pool) {
  if (!(pool > 0) || playerCount < 1) return [];
  if (playerCount === 1) return [pool];
  const percents = playerCount < 8 ? [60, 40] : [50, 30, 20];
  const shares = percents.map((p) => Math.floor((pool * p) / 100));
  shares[0] += pool - shares.reduce((a, b) => a + b, 0);
  return shares;
}

module.exports = {
  MIN_PLAYERS,
  MAX_PLAYERS,
  scoresForResult,
  defaultRounds,
  pairKey,
  history,
  standings,
  pairRound,
  prizeShares,
};
