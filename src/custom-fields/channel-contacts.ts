import { LanguageCode, VendureConfig } from '@vendure/core';

type ChannelCustomFields = NonNullable<NonNullable<VendureConfig['customFields']>['Channel']>;

/**
 * Per-channel contact addresses.
 *
 * Consumed by:
 *   - contact  reads `infoEmail` as the recipient for contact form submissions,
 *              falling back to the CONTACT_ADMIN_EMAIL env var
 *
 * agx-stores declares four more fields on Channel — `storefrontUrl`,
 * `orderNotificationEmail`, `shippingContactEmail` and `financeContactEmail`.
 * They are deliberately left out until the plugin that reads each one is ported,
 * so no column lands without a consumer. Add them to this module as those ports
 * happen.
 *
 * `public: false` keeps these off the Shop API — they are internal routing
 * addresses, not storefront content.
 */
export const channelContactFields: ChannelCustomFields = [
    {
        name: 'infoEmail',
        type: 'string',
        nullable: true,
        label: [{ languageCode: LanguageCode.en, value: 'Info / Contact Email' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'Recipient for customer contact form submissions from this channel.',
        }],
        public: false,
    },
];
