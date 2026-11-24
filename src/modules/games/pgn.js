'use strict';

/**
 * PGN generation from the stored move list (SAN supplied by the client, D-021).
 * Built by hand: no chess library is used on the server.
 */
function pgnDate(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
}

function header(name, value) {
  return `[${name} "${String(value).replace(/["\\]/g, '')}"]`;
}

/** Builds a PGN string for a game document (lean or hydrated). */
function buildPgn(game, result, reason) {
  const resultToken = result || '*';
  const lines = [
    header('Event', game.rated ? 'Rated game' : 'Casual game'),
    header('Site', 'Checkmate'),
    header('Date', pgnDate(game.startedAt || game.createdAt || Date.now())),
    header('White', game.whiteName),
    header('Black', game.blackName),
    header('Result', resultToken),
    header('WhiteElo', game.whiteRating),
    header('BlackElo', game.blackRating),
    header('TimeControl', `${game.timeControl.baseMs / 1000}+${game.timeControl.incrementMs / 1000}`),
    header('Termination', reason || 'unterminated'),
  ];
  if (game.variant === 'chess960') {
    lines.push(header('Variant', 'Chess960'));
    if (game.startFen) lines.push(header('SetUp', '1'), header('FEN', game.startFen));
  } else if (game.variant === 'dice') {
    lines.push(header('Variant', 'Dice Chess'));
  }
  lines.push('');
  const parts = [];
  game.moves.forEach((m, i) => {
    if (i % 2 === 0) parts.push(`${i / 2 + 1}.`);
    parts.push(m.san);
  });
  parts.push(resultToken);
  return `${lines.join('\n')}\n${parts.join(' ')}\n`;
}

module.exports = { buildPgn };
