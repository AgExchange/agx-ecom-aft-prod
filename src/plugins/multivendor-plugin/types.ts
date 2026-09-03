import { ID } from '@vendure/common/lib/shared-types';

export type PayoutStatus = 'pending' | 'paid';

/** Shared by both onboarding entry points once a Seller entity already exists in scope. */
export interface ProvisionVendorInfrastructureInput {
    token?: string;
    sellerEmail: string;
    shippingPreferenceNote?: string;
}

/** Admin-facing: onboards a pre-existing Seller (created via the native Sellers screen). */
export interface OnboardSellerServiceInput extends ProvisionVendorInfrastructureInput {
    sellerId: ID;
}

/** Public shop-facing: still the only path that creates the Seller itself. */
export interface RegisterSellerServiceInput extends ProvisionVendorInfrastructureInput {
    shopName: string;
}

declare module '@vendure/core/dist/entity/custom-entity-fields' {
    interface CustomOrderFields {
        payoutStatus: PayoutStatus | null;
    }

    interface CustomSellerFields {
        sellerOnboardingNote: string | null;
        /** Percentage of this Seller's Order subTotalWithTax deducted as a platform-fee Surcharge. */
        platformFeePercent: number;
    }
}
