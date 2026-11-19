'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const logger = require('./utils/logger');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const healthRoutes = require('./modules/health/health.routes');
const authRoutes = require('./modules/auth/auth.routes');
const usersRoutes = require('./modules/users/users.routes');
const { router: friendsRoutes, reportsRouter } = require('./modules/friends/friends.routes');
const gamesRoutes = require('./modules/games/games.routes');
const conversationsRoutes = require('./modules/messaging/conversations.routes');
const roomsRoutes = require('./modules/analysis-rooms/rooms.routes');
const analysisSessionsRoutes = require('./modules/analysis-sessions/sessions.routes');
const { walletRouter, storeRouter } = require('./modules/economy/economy.routes');
const purchasesRoutes = require('./modules/purchases/purchases.routes');
const notificationsRoutes = require('./modules/notifications/notifications.routes');
const tournamentsRoutes = require('./modules/tournaments/tournaments.routes');
const adminRoutes = require('./modules/admin/admin.routes');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Render sits behind one reverse proxy; needed for correct client IPs in rate limiting.
  app.set('trust proxy', 1);

  app.use(helmet());

  // The Android app sends no Origin header, so it is always allowed.
  // Browsers are only allowed from origins listed in CORS_ORIGINS.
  app.use(
    cors({
      origin(origin, callback) {
        callback(null, !origin || config.corsOrigins.includes(origin));
      },
    })
  );

  // Lightweight request log (path only, never the query string: it may hold tokens).
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      logger.info({ method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) }, 'http');
    });
    next();
  });

  // Health routes come before rate limiting and body parsing.
  app.use('/health', healthRoutes);

  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
    })
  );

  app.use(express.json({ limit: '100kb' }));

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/users', usersRoutes);
  app.use('/api/v1/friends', friendsRoutes);
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api/v1/games', gamesRoutes);
  app.use('/api/v1/conversations', conversationsRoutes);
  app.use('/api/v1/rooms', roomsRoutes);
  app.use('/api/v1/analysis-sessions', analysisSessionsRoutes);
  app.use('/api/v1/wallet', walletRouter);
  app.use('/api/v1/store', storeRouter);
  app.use('/api/v1/purchases', purchasesRoutes);
  app.use('/api/v1/notifications', notificationsRoutes);
app.use('/api/v1/tournaments', tournamentsRoutes);
app.use('/api/v1/admin', adminRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
