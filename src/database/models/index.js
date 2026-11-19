'use strict';

// Registers every model so indexes can be created in one place.
module.exports = {
  User: require('./user.model'),
  Session: require('./session.model'),
  UserSettings: require('./userSettings.model'),
  Friendship: require('./friendship.model'),
  Block: require('./block.model'),
  Report: require('./report.model'),
  Game: require('./game.model'),
  GameEvent: require('./gameEvent.model'),
  MatchmakingEntry: require('./matchmakingEntry.model'),
  Invitation: require('./invitation.model'),
  Conversation: require('./conversation.model'),
  PersonalMessage: require('./personalMessage.model'),
  AnalysisRoom: require('./analysisRoom.model'),
  AnalysisSession: require('./analysisSession.model'),
  Wallet: require('./wallet.model'),
  Transaction: require('./transaction.model'),
  Entitlement: require('./entitlement.model'),
  Purchase: require('./purchase.model'),
  Notification: require('./notification.model'),
  Tournament: require('./tournament.model'),
  TournamentPlayer: require('./tournamentPlayer.model'),
  AdminAction: require('./adminAction.model'),
};
