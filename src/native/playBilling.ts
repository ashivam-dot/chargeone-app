// Google Play Billing for the Android app. Play requires its own billing for digital plans sold
// inside a Play-installed app, so the Android app never offers UPI or cards directly.
import type { PlanId } from '../shared/plans.ts';

/** Matches the Play Console setup the server checks against (worker/play.ts). */
const PRODUCT: Record<Exclude<PlanId, 'free'>, { id: string; basePlan?: string }> = {
  trip_pass: { id: 'trip_pass' },
  plus_monthly: { id: 'plus', basePlan: 'monthly' },
  plus_yearly: { id: 'plus', basePlan: 'yearly' },
};

export interface PlayPurchase {
  productId: string;
  purchaseToken: string;
}

export async function buyOnPlay(plan: Exclude<PlanId, 'free'>, appAccountToken: string): Promise<PlayPurchase> {
  const { NativePurchases, PURCHASE_TYPE } = await import('@capgo/native-purchases');
  const p = PRODUCT[plan];
  const t = await NativePurchases.purchaseProduct({
    productIdentifier: p.id,
    productType: p.basePlan ? PURCHASE_TYPE.SUBS : PURCHASE_TYPE.INAPP,
    planIdentifier: p.basePlan,
    appAccountToken,
    // A Trip Pass can be bought again for the next trip, so its purchase is consumed.
    isConsumable: !p.basePlan,
  });
  if (!t.purchaseToken) throw new Error('Google Play did not return a purchase.');
  return { productId: p.id, purchaseToken: t.purchaseToken };
}

/** Purchases already on this Google account, for "Restore purchases". */
export async function playPurchases(appAccountToken: string): Promise<PlayPurchase[]> {
  const { NativePurchases, PURCHASE_TYPE } = await import('@capgo/native-purchases');
  const { purchases } = await NativePurchases.getPurchases({ productType: PURCHASE_TYPE.SUBS, appAccountToken });
  return purchases.filter((t) => t.purchaseToken).map((t) => ({ productId: t.productIdentifier, purchaseToken: t.purchaseToken! }));
}
