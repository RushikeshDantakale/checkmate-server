'use strict';

/**
 * Central configuration. All environment variables are read and validated
 * here, once, at startup. Nothing else in the codebase reads process.env.
 */
require('dotenv').config({ quiet: true });
const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  MONGODB_URI: z.string().min(1).optional(),
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  CORS_ORIGINS: z.string().default(''),
  WS_MAX_PAYLOAD_BYTES: z.coerce.number().int().min(256).max(1048576).default(16384),
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(30000),
  WS_AUTH_TIMEOUT_MS: z.coerce.number().int().min(100).default(10000),
  WS_REAUTH_GRACE_MS: z.coerce.number().int().min(0).default(30000),
  WS_TOKEN_WARNING_MS: z.coerce.number().int().min(0).default(30000),
  JWT_ACCESS_SECRET: z.string().min(32).optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  GAME_RECONNECT_GRACE_MS: z.coerce.number().int().min(10).default(60000),
  GAME_PAUSED_HOLD_MS: z.coerce.number().int().min(10).default(300000),
  GAME_CHECKPOINT_INTERVAL_MS: z.coerce.number().int().min(10).default(5000),
  INVITE_TTL_MS: z.coerce.number().int().min(10).default(60000),
  MATCH_TICK_MS: z.coerce.number().int().min(10).default(2000),
  // Voice (D-027): STUN only by default; TURN is added later through these variables, no code change.
  ICE_STUN_URLS: z.string().default('stun:stun.l.google.com:19302'),
  TURN_URLS: z.string().default(''),
  TURN_USERNAME: z.string().optional(), // static credentials (Metered or any provider)
  TURN_CREDENTIAL: z.string().optional(),
  TURN_SECRET: z.string().min(16).optional(), // time-limited credentials (coturn "use-auth-secret" style)
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),
  VOICE_RING_TIMEOUT_MS: z.coerce.number().int().min(10).default(45000),
  // Analysis rooms (D-035 to D-040). The member limit (10) is a fixed rule, not a setting.
  ROOM_MAX_NODES: z.coerce.number().int().min(5).max(2000).default(300),
  ROOM_MAX_HOSTED: z.coerce.number().int().min(1).max(50).default(3),
  ROOM_IDLE_CLOSE_MS: z.coerce.number().int().min(50).default(24 * 60 * 60 * 1000),
  ROOM_RETENTION_DAYS: z.coerce.number().min(0.0001).max(365).default(7),
  ROOM_SWEEP_INTERVAL_MS: z.coerce.number().int().min(20).default(60000),
  // Spectators and saved analysis (D-042, D-044).
  SPECTATOR_MAX_PER_GAME: z.coerce.number().int().min(1).max(100).default(20),
  ANALYSIS_SESSIONS_MAX: z.coerce.number().int().min(1).max(500).default(50),
  // Storage watch (D-028): Atlas M0 has 512 MB.
  STORAGE_LIMIT_MB: z.coerce.number().min(1).default(512),
  STORAGE_CHECK_INTERVAL_MS: z.coerce.number().int().min(1000).default(3600000),
  // Retention (D-060): the cleanup job. Deleting is irreversible, so the day limits have a floor.
  RETENTION_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  RETENTION_DRY_RUN: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  RETENTION_INTERVAL_MS: z.coerce.number().int().min(1000).default(6 * 60 * 60 * 1000),
  RETENTION_FIRST_RUN_MS: z.coerce.number().int().min(0).default(60000),
  RETENTION_GAME_MOVES_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  RETENTION_REPORTS_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
  RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(200),
  // Economy and purchases (D-046 to D-050).
  DAILY_REWARD_COINS: z.coerce.number().int().min(0).max(1000).default(20),
  WALLET_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(10).default(30000),
  WALLET_PENDING_AGE_MS: z.coerce.number().int().min(0).default(60000), // a pending ledger row older than this is reconciled
  PURCHASE_VERIFIER: z.enum(['disabled', 'fake', 'google']).default('disabled'),
  GOOGLE_PLAY_PACKAGE_NAME: z.string().min(1).optional(),
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: z.string().min(2).optional(), // the service-account key file contents, as one line of JSON
  // Tournaments (D-052 to D-055).
  TOURNAMENT_SHOW_UP_MS: z.coerce.number().int().min(10).default(180000), // a player who is not there this long after the round started forfeits the pairing
  TOURNAMENT_ROUND_BREAK_MS: z.coerce.number().int().min(0).default(30000), // pause between the last result of a round and the next round
  TOURNAMENT_MIN_LEAD_MS: z.coerce.number().int().min(0).default(60000), // a tournament must start at least this long after it is created
  TOURNAMENT_MAX_LEAD_DAYS: z.coerce.number().int().min(1).max(60).default(7), // ... and at most this many days after
  TOURNAMENT_MAX_HOSTED: z.coerce.number().int().min(1).max(10).default(1), // open tournaments (registration or running) one user may host at a time
});

const parsed = schema.safeParse(process.env);

function fail(lines) {
  // Never print values: they may be secrets.
  console.error(`Invalid environment configuration:\n${lines.join('\n')}`);
  process.exit(1);
}

if (!parsed.success) {
  fail(parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`));
}

const env = parsed.data;
const isTest = env.NODE_ENV === 'test';

if (!isTest) {
  const missing = [];
  if (!env.MONGODB_URI) missing.push('  - MONGODB_URI: required');
  if (!env.JWT_ACCESS_SECRET) missing.push('  - JWT_ACCESS_SECRET: required (at least 32 characters)');
  if (missing.length) fail(missing);
}

const splitList = (value) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const turnUrls = splitList(env.TURN_URLS);
if (turnUrls.length) {
  const hasStatic = Boolean(env.TURN_USERNAME && env.TURN_CREDENTIAL);
  if (!hasStatic && !env.TURN_SECRET) {
    fail(['  - TURN_URLS is set: also set TURN_USERNAME + TURN_CREDENTIAL, or TURN_SECRET']);
  }
}

if (env.PURCHASE_VERIFIER === 'fake' && env.NODE_ENV === 'production') {
  fail(['  - PURCHASE_VERIFIER=fake is only for development and tests; it would let anyone give themselves purchases']);
}
if (env.PURCHASE_VERIFIER === 'google') {
  const lines = [];
  if (!env.GOOGLE_PLAY_PACKAGE_NAME) lines.push('  - GOOGLE_PLAY_PACKAGE_NAME: required when PURCHASE_VERIFIER=google');
  if (!env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) {
    lines.push('  - GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: required when PURCHASE_VERIFIER=google');
  } else {
    try {
      const key = JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
      if (!key.client_email || !key.private_key) lines.push('  - GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: must contain client_email and private_key');
    } catch {
      lines.push('  - GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: is not valid JSON');
    }
  }
  if (lines.length) fail(lines);
}

module.exports = Object.freeze({
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest,
  port: env.PORT,
  logLevel: isTest ? 'silent' : env.LOG_LEVEL,
  mongodb: Object.freeze({
    uri: env.MONGODB_URI,
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
  }),
  corsOrigins: env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  ws: Object.freeze({
    maxPayloadBytes: env.WS_MAX_PAYLOAD_BYTES,
    heartbeatIntervalMs: env.WS_HEARTBEAT_INTERVAL_MS,
    authTimeoutMs: env.WS_AUTH_TIMEOUT_MS, // unauthenticated sockets are closed (4001) after this
    reauthGraceMs: env.WS_REAUTH_GRACE_MS, // after token expiry the socket is closed (4002) unless re-authed
    tokenWarningMs: env.WS_TOKEN_WARNING_MS, // "auth.expiring" is sent this long before expiry
  }),
  auth: Object.freeze({
    accessSecret: env.JWT_ACCESS_SECRET || 'test-only-secret-test-only-secret-1234',
    accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlMs: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    bcryptRounds: isTest ? 4 : 12,
    // A refresh token that was just rotated may be retried by a client that lost
    // the response; inside this window it is rejected but the session is NOT revoked.
    refreshReuseGraceMs: isTest ? 0 : 10000,
    rateLimitMax: isTest ? 1000 : 20, // login/register/refresh attempts per IP per 15 min
  }),
  game: Object.freeze({
    // D-013: a player who disconnects while the server is healthy has this long to come back.
    reconnectGraceMs: env.GAME_RECONNECT_GRACE_MS,
    // D-012/D-013: how long a paused game (both players gone, or server recovery) waits before it is settled.
    pausedHoldMs: env.GAME_PAUSED_HOLD_MS,
    // Clock snapshots are written to the database this often while a game is active (D-012).
    checkpointIntervalMs: env.GAME_CHECKPOINT_INTERVAL_MS,
    inviteTtlMs: env.INVITE_TTL_MS,
    matchTickMs: env.MATCH_TICK_MS,
    startingRating: 1200,
    ratingK: 32,
    // Matchmaking rating window: base + perSecond * secondsWaited (D-023).
    ratingWindowBase: 100,
    ratingWindowPerSecond: 20,
  }),
  voice: Object.freeze({
    stunUrls: splitList(env.ICE_STUN_URLS),
    turnUrls,
    turnUsername: env.TURN_USERNAME,
    turnCredential: env.TURN_CREDENTIAL,
    turnSecret: env.TURN_SECRET,
    turnCredentialTtlSeconds: env.TURN_CREDENTIAL_TTL_SECONDS,
    ringTimeoutMs: env.VOICE_RING_TIMEOUT_MS, // an unanswered offer is cancelled after this long
  }),
  rooms: Object.freeze({
    maxMembers: 10, // brief: at most 10 participants per analysis room
    maxInvites: 20,
    maxNodes: env.ROOM_MAX_NODES,
    maxHosted: env.ROOM_MAX_HOSTED,
    idleCloseMs: env.ROOM_IDLE_CLOSE_MS,
    retentionMs: env.ROOM_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    sweepIntervalMs: env.ROOM_SWEEP_INTERVAL_MS,
  }),
  spectators: Object.freeze({
    maxPerGame: env.SPECTATOR_MAX_PER_GAME,
  }),
  analysisSessions: Object.freeze({
    maxPerUser: env.ANALYSIS_SESSIONS_MAX,
  }),
  storage: Object.freeze({
    limitMb: env.STORAGE_LIMIT_MB,
    checkIntervalMs: env.STORAGE_CHECK_INTERVAL_MS,
    warnPercent: 80,
    criticalPercent: 90,
  }),
  retention: Object.freeze({
    // Never runs inside tests (like the process guards, D-057): tests call the service directly.
    enabled: env.RETENTION_ENABLED && env.NODE_ENV !== 'test',
    dryRun: env.RETENTION_DRY_RUN,
    intervalMs: env.RETENTION_INTERVAL_MS,
    firstRunMs: env.RETENTION_FIRST_RUN_MS,
    gameMovesDays: env.RETENTION_GAME_MOVES_DAYS,
    reportsDays: env.RETENTION_REPORTS_DAYS,
    batchSize: env.RETENTION_BATCH_SIZE,
  }),
  economy: Object.freeze({
    dailyRewardCoins: env.DAILY_REWARD_COINS,
    reconcileIntervalMs: env.WALLET_RECONCILE_INTERVAL_MS,
    pendingAgeMs: env.WALLET_PENDING_AGE_MS,
  }),
  tournament: Object.freeze({
    showUpMs: env.TOURNAMENT_SHOW_UP_MS,
    roundBreakMs: env.TOURNAMENT_ROUND_BREAK_MS,
    minLeadMs: env.TOURNAMENT_MIN_LEAD_MS,
    maxLeadMs: env.TOURNAMENT_MAX_LEAD_DAYS * 24 * 60 * 60 * 1000,
    maxHosted: env.TOURNAMENT_MAX_HOSTED,
    maxEntryFee: 500,
  }),
  purchases: Object.freeze({
    verifier: env.PURCHASE_VERIFIER,
    googlePackageName: env.GOOGLE_PLAY_PACKAGE_NAME,
    googleServiceAccountJson: env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,
  }),
});
