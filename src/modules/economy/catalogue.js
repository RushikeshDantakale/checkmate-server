'use strict';

/**
 * The shop (D-048). Lives in code so a price cannot be changed by accident; changing it is a
 * deploy. IDs are stable strings: the Android app sends them, so never rename one that shipped.
 *
 * !!! The pack names and all prices below are PLACEHOLDERS. Replace them with the real commentator
 * packs and prices of the Android app, and create matching products in the Google Play Console
 * (`playProductId` must equal the product id created there).
 */
const coinBundles = [
  { id: 'coins_100', coins: 100, playProductId: 'coins_100' },
  { id: 'coins_500', coins: 500, playProductId: 'coins_500' },
  { id: 'coins_1200', coins: 1200, playProductId: 'coins_1200' },
];

const packs = [
  { id: 'pack_classic', name: 'Classic commentator', coinPrice: 300, playProductId: 'pack_classic' },
  { id: 'pack_grandmaster', name: 'Grandmaster commentator', coinPrice: 600, playProductId: 'pack_grandmaster' },
  { id: 'pack_comedy', name: 'Comedy commentator', coinPrice: 300, playProductId: 'pack_comedy' },
];

const premium = { id: 'premium', name: 'Premium', playProductId: 'premium' };

function findPack(packId) {
  return packs.find((p) => p.id === packId) || null;
}

/** Finds what a Google Play product id gives: { kind, item } or null. */
function findByPlayProduct(productId) {
  const bundle = coinBundles.find((b) => b.playProductId === productId);
  if (bundle) return { kind: 'coin_bundle', item: bundle };
  const pack = packs.find((p) => p.playProductId === productId);
  if (pack) return { kind: 'pack', item: pack };
  if (premium.playProductId === productId) return { kind: 'premium', item: premium };
  return null;
}

/** What the app may show. `playProductId` is included so the app knows what to ask Google Play for. */
function publicCatalogue() {
  return {
    coinBundles: coinBundles.map((b) => ({ id: b.id, coins: b.coins, playProductId: b.playProductId })),
    packs: packs.map((p) => ({ id: p.id, name: p.name, coinPrice: p.coinPrice ?? null, playProductId: p.playProductId || null })),
    premium: { id: premium.id, name: premium.name, playProductId: premium.playProductId },
  };
}

module.exports = { coinBundles, packs, premium, findPack, findByPlayProduct, publicCatalogue };
