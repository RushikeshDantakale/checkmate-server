'use strict';

// Control characters (except tab and newline), and the invisible bidirectional overrides that
// can make text display in a misleading order (U+202A-202E, U+2066-2069).
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Cleans user-written chat text. Messages are plain text (the client must render them as text,
 * never as HTML), so this only removes characters that have no business in a chat message.
 */
function cleanText(value) {
  return String(value).replace(/\r\n?/g, '\n').replace(UNSAFE, '').trim();
}

module.exports = { cleanText };
