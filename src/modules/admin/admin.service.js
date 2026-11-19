'use strict';

/**
 * Administrator tools (D-059). Every state-changing function runs through `audited`: the audit row is
 * written first, the action second, and the row is closed with `done` or `failed`. All of them are safe
 * to repeat (a retry never applies a change twice).
 */
const { AppError } = require('../../utils/errors');
const { withDb } = require('../../utils/db');
const authService = require('../auth/auth.service');
const wallet = require('../economy/wallet.service');
const store = require('../economy/store.service');
const catalogue = require('../economy/catalogue');
const tournaments = require('../tournaments/tournaments.service');
const { audited } = require('./admin.audit');
const { User, Report, AdminAction, Entitlement } = require('../../database/models');

const same = (a, b) => String(a) === String(b);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- views

function userView(u) {
  return {
    id: String(u._id),
    username: u.username,
    displayName: u.displayName || null,
    email: u.email, // administrators only
    emailVerified: Boolean(u.emailVerified),
    status: u.status,
    role: u.role,
    statusReason: u.statusReason || null,
    statusChangedAt: u.statusChangedAt || null,
    statusChangedBy: u.statusChangedBy ? String(u.statusChangedBy) : null,
    rating: u.rating ?? 1200,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
    lastSeenAt: u.lastSeenAt || null,
  };
}

function auditView(a) {
  return {
    id: String(a._id),
    adminId: a.adminId ? String(a.adminId) : null,
    action: a.action,
    targetType: a.targetType,
    targetId: a.targetId ? String(a.targetId) : null,
    details: a.details || {},
    status: a.status,
    errorCode: a.errorCode || null,
    createdAt: a.createdAt,
    finishedAt: a.finishedAt || null,
  };
}

async function reportViews(rows) {
  const ids = Array.from(new Set(rows.flatMap((r) => [String(r.reporter), String(r.reported)])));
  const users = await User.find({ _id: { $in: ids } }).select('username status').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const totals = rows.length
    ? await Report.aggregate([
        { $match: { reported: { $in: rows.map((r) => r.reported) } } },
        { $group: { _id: '$reported', total: { $sum: 1 } } },
      ])
    : [];
  const totalOf = new Map(totals.map((t) => [String(t._id), t.total]));
  const who = (id) => {
    const u = byId.get(String(id));
    return { id: String(id), username: u ? u.username : null, status: u ? u.status : null };
  };
  return rows.map((r) => ({
    id: String(r._id),
    reason: r.reason,
    details: r.details || null,
    status: r.status,
    createdAt: r.createdAt,
    reporter: { id: String(r.reporter), username: who(r.reporter).username },
    reported: { ...who(r.reported), totalReports: totalOf.get(String(r.reported)) || 0 },
    reviewedBy: r.reviewedBy ? String(r.reviewedBy) : null,
    reviewedAt: r.reviewedAt || null,
    note: r.note || null,
  }));
}

function page(rows, limit) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? String(items[items.length - 1]._id) : null };
}

// ---------------------------------------------------------------- users

async function loadTarget(adminId, userId, { protectAdmins = false } = {}) {
  if (same(adminId, userId)) throw new AppError(409, 'CANNOT_TARGET_SELF', 'Administrators cannot do this to their own account');
  const user = await User.findById(userId).lean();
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  if (protectAdmins && user.role === 'admin') {
    throw new AppError(403, 'CANNOT_TARGET_ADMIN', 'The status of another administrator cannot be changed here');
  }
  return user;
}

async function searchUsers({ search, status, limit, cursor }) {
  return withDb(async () => {
    const filter = {};
    if (search) filter.usernameLower = { $regex: `^${escapeRegex(search.toLowerCase())}` };
    if (status) filter.status = status;
    if (cursor) filter._id = { $lt: cursor };
    const rows = await User.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
    const { items, nextCursor } = page(rows, limit);
    return { items: items.map(userView), nextCursor };
  }, 'admin search users');
}

async function getUser(userId) {
  return withDb(async () => {
    const user = await User.findById(userId).lean();
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    const [coins, entitlements, against, made, recent] = await Promise.all([
      wallet.getBalance(userId),
      store.getEntitlements(userId),
      Report.countDocuments({ reported: userId }),
      Report.countDocuments({ reporter: userId }),
      AdminAction.find({ targetId: userId }).sort({ _id: -1 }).limit(10).lean(),
    ]);
    return {
      user: userView(user),
      coins,
      entitlements,
      reports: { against, made },
      recentAdminActions: recent.map(auditView),
    };
  }, 'admin get user');
}

/** Suspend, ban or restore an account. Sessions are revoked and live sockets closed at once. */
async function setStatus(adminId, userId, { status, reason }) {
  return withDb(async () => {
    const target = await loadTarget(adminId, userId, { protectAdmins: true });
    return audited(
      { adminId, action: 'user_status', targetType: 'user', targetId: userId, details: { from: target.status, to: status, reason } },
      async () => {
        const res = await User.updateOne(
          { _id: userId, role: 'user' },
          { $set: { status, statusReason: reason, statusChangedAt: new Date(), statusChangedBy: adminId } }
        );
        if (res.matchedCount === 0) throw new AppError(403, 'CANNOT_TARGET_ADMIN', 'The status of an administrator cannot be changed here');
        if (status !== 'active') await authService.logoutAll(userId); // also repeated on a retry: harmless
        return { user: userView(await User.findById(userId).lean()), duplicate: target.status === status };
      }
    );
  }, 'admin set status');
}

// ---------------------------------------------------------------- coins and entitlements

/** Grants (amount > 0) or revokes (amount < 0) coins. `requestId` makes a retry apply once. */
async function adjustCoins(adminId, userId, { amount, reason, requestId }) {
  return withDb(async () => {
    await loadTarget(adminId, userId);
    return audited(
      {
        adminId,
        action: amount > 0 ? 'coins_grant' : 'coins_revoke',
        targetType: 'user',
        targetId: userId,
        details: { amount, reason, requestId },
        key: `coins:${requestId}`,
      },
      async () => {
        const out = await wallet.apply({
          key: `admin:${requestId}`,
          userId,
          delta: amount,
          reason: amount > 0 ? 'admin_grant' : 'admin_revoke',
          ref: String(adminId),
        });
        return { userId: String(userId), balance: out.balance, transactionId: String(out.tx._id), duplicate: out.duplicate };
      }
    );
  }, 'admin adjust coins');
}

async function modifyEntitlement(userId, update, upsert) {
  try {
    await Entitlement.updateOne({ userId }, update, { upsert });
  } catch (err) {
    // Two first writes at the same moment: the second upsert lost the race, run it again.
    if (upsert && err && err.code === 11000) await Entitlement.updateOne({ userId }, update, { upsert });
    else throw err;
  }
}

async function setEntitlements(adminId, userId, { premium, grantPacks = [], revokePacks = [], reason }) {
  return withDb(async () => {
    await loadTarget(adminId, userId);
    for (const id of [...grantPacks, ...revokePacks]) {
      if (!catalogue.findPack(id)) throw new AppError(400, 'UNKNOWN_PACK', `Unknown pack: ${id}`);
    }
    if (grantPacks.some((id) => revokePacks.includes(id))) {
      throw new AppError(400, 'VALIDATION_ERROR', 'A pack cannot be granted and revoked in the same request');
    }
    if (premium === undefined && grantPacks.length === 0 && revokePacks.length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Nothing to change');
    }
    return audited(
      { adminId, action: 'entitlements', targetType: 'user', targetId: userId, details: { premium, grantPacks, revokePacks, reason } },
      async () => {
        if (revokePacks.length) await modifyEntitlement(userId, { $pull: { packs: { $in: revokePacks } } }, false);
        if (grantPacks.length) await modifyEntitlement(userId, { $addToSet: { packs: { $each: grantPacks } } }, true);
        if (premium !== undefined) await modifyEntitlement(userId, { $set: { premium } }, true);
        return { userId: String(userId), entitlements: await store.getEntitlements(userId) };
      }
    );
  }, 'admin set entitlements');
}

// ---------------------------------------------------------------- reports

async function listReports({ status, limit, cursor }) {
  return withDb(async () => {
    const filter = status === 'all' ? {} : { status };
    if (cursor) filter._id = { $lt: cursor };
    const rows = await Report.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
    const { items, nextCursor } = page(rows, limit);
    return { items: await reportViews(items), nextCursor };
  }, 'admin list reports');
}

async function resolveReport(adminId, reportId, { status, note }) {
  return withDb(async () => {
    const report = await Report.findById(reportId).lean();
    if (!report) throw new AppError(404, 'REPORT_NOT_FOUND', 'Report not found');
    const view = async () => (await reportViews([await Report.findById(reportId).lean()]))[0];
    if (report.status !== 'open') {
      if (report.status === status) return { report: await view(), duplicate: true };
      throw new AppError(409, 'REPORT_ALREADY_RESOLVED', `This report was already marked ${report.status}`);
    }
    return audited(
      { adminId, action: 'report_resolve', targetType: 'report', targetId: reportId, details: { status, note, reported: String(report.reported) } },
      async () => {
        const res = await Report.updateOne(
          { _id: reportId, status: 'open' },
          { $set: { status, reviewedBy: adminId, reviewedAt: new Date(), ...(note ? { note } : {}) } }
        );
        if (res.modifiedCount === 0) {
          const current = await Report.findById(reportId).lean();
          if (current.status !== status) throw new AppError(409, 'REPORT_ALREADY_RESOLVED', `This report was already marked ${current.status}`);
          return { report: await view(), duplicate: true };
        }
        return { report: await view(), duplicate: false };
      }
    );
  }, 'admin resolve report');
}

// ---------------------------------------------------------------- tournaments

async function repairTournament(adminId, tournamentId) {
  return audited(
    { adminId, action: 'tournament_repair', targetType: 'tournament', targetId: tournamentId },
    () => tournaments.repair(tournamentId)
  );
}

async function cancelTournament(adminId, tournamentId, { reason }) {
  return audited(
    { adminId, action: 'tournament_cancel', targetType: 'tournament', targetId: tournamentId, details: { reason } },
    () => tournaments.adminCancel(tournamentId, `admin: ${reason}`.slice(0, 200))
  );
}

// ---------------------------------------------------------------- audit log

async function listAudit({ adminId, targetId, action, limit, cursor }) {
  return withDb(async () => {
    const filter = {};
    if (adminId) filter.adminId = adminId;
    if (targetId) filter.targetId = targetId;
    if (action) filter.action = action;
    if (cursor) filter._id = { $lt: cursor };
    const rows = await AdminAction.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
    const { items, nextCursor } = page(rows, limit);
    return { items: items.map(auditView), nextCursor };
  }, 'admin list audit');
}

module.exports = {
  searchUsers,
  getUser,
  setStatus,
  adjustCoins,
  setEntitlements,
  listReports,
  resolveReport,
  repairTournament,
  cancelTournament,
  listAudit,
};
