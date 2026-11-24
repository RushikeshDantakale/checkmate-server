'use strict';

/**
 * Game variants (D-062). The server does not check move legality (D-021), so a variant only
 * has to be (a) stored on the game, (b) announced identically to both players, and
 * (c) for Chess960, started from the same shuffled position on both phones.
 *
 *  - standard : normal chess
 *  - dice     : Dice Chess (the mover's phone rolls; the opponent just receives the move)
 *  - chess960 : Fischer Random; the server picks the start position so both phones agree
 */
const VARIANTS = ['standard', 'dice', 'chess960'];
const DEFAULT_VARIANT = 'standard';

function isValidVariant(v) {
  return VARIANTS.includes(v);
}

/** Random Chess960 start position as a FEN (castling letters KQkq are valid because rooks start outermost). */
function randomChess960Fen(rand = Math.random) {
  const back = new Array(8).fill(null);
  const pick = (n) => Math.floor(rand() * n);
  const free = () => back.map((p, i) => (p === null ? i : -1)).filter((i) => i >= 0);

  // Bishops on opposite-coloured squares (odd and even file indexes).
  back[pick(4) * 2 + 1] = 'b';
  back[pick(4) * 2] = 'b';
  // Queen and two knights on random free squares.
  for (const piece of ['q', 'n', 'n']) {
    const f = free();
    back[f[pick(f.length)]] = piece;
  }
  // The last three free squares get rook, king, rook (king between the rooks).
  const rest = free();
  back[rest[0]] = 'r';
  back[rest[1]] = 'k';
  back[rest[2]] = 'r';

  const black = back.join('');
  return `${black}/pppppppp/8/8/8/8/PPPPPPPP/${black.toUpperCase()} w KQkq - 0 1`;
}

module.exports = { VARIANTS, DEFAULT_VARIANT, isValidVariant, randomChess960Fen };
