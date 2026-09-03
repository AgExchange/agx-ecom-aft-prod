import { LanguageCode } from '@vendure/common/lib/generated-types';
import { DEFAULT_CHANNEL_CODE } from '@vendure/common/lib/shared-constants';
import { EntityHydrator, idsAreEqual, ShippingEligibilityChecker } from '@vendure/core';

let entityHydrator: EntityHydrator;

/**
 * A ShippingMethod is eligible if it is assigned to a seller Channel (i.e. assigned to exactly
 * one non-default Channel besides the default Channel every entity always belongs to) AND at
 * least one OrderLine belongs to that same seller Channel. This is calculator-agnostic — it
 * composes underneath whichever ShippingCalculator an admin assigns to a seller's ShippingMethod
 * (flat rate, the existing shipping-by-weight plugin's calculator, or a future rate-table
 * calculator), so different sellers can run entirely different rate tables.
 */
export const mvShippingEligibilityChecker = new ShippingEligibilityChecker({
    code: 'multivendor-shipping-eligibility-checker',
    description: [{ languageCode: LanguageCode.en, value: 'Multivendor Shipping Eligibility Checker' }],
    args: {},
    init(injector) {
        entityHydrator = injector.get(EntityHydrator);
    },
    check: async (ctx, order, args, method) => {
        await entityHydrator.hydrate(ctx, method, { relations: ['channels'] });
        await entityHydrator.hydrate(ctx, order, { relations: ['lines.sellerChannel'] });
        const sellerChannel = method.channels.find(c => c.code !== DEFAULT_CHANNEL_CODE);
        if (!sellerChannel) {
            return false;
        }
        for (const line of order.lines) {
            if (line.sellerChannelId && idsAreEqual(line.sellerChannelId, sellerChannel.id)) {
                return true;
            }
        }
        return false;
    },
});
