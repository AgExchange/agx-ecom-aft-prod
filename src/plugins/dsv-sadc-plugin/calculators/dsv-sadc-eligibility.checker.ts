import { ShippingEligibilityChecker, LanguageCode, Injector, Logger } from '@vendure/core';
import { DsvSadcAddressService } from '../services/dsv-address.service';
import { isSadcCountry } from '../utils/address-converter';
import { loggerCtx } from '../constants';

let addressService: DsvSadcAddressService;

export const dsvSadcEligibilityChecker = new ShippingEligibilityChecker({
    code: 'dsv-sadc-eligibility',
    description: [
        { languageCode: LanguageCode.en, value: 'DSV SADC — checks order is eligible for ClientZone SADC shipping' },
    ],
    args: {
        orderMinimum: {
            type: 'int',
            defaultValue: 0,
            label: [{ languageCode: LanguageCode.en, value: 'Minimum order value' }],
            description: [{ languageCode: LanguageCode.en, value: 'Order must be at or above this total (in cents)' }],
            ui: { component: 'currency-form-input' },
        },
        enableAddressValidation: {
            type: 'boolean',
            defaultValue: false,
            label: [{ languageCode: LanguageCode.en, value: 'Validate address via DSV API' }],
            description: [{ languageCode: LanguageCode.en, value: 'Call DSV ValidateAddress to confirm delivery address is in DSV master list' }],
        },
    },

    init(injector: Injector) {
        addressService = injector.get(DsvSadcAddressService);
    },

    check: async (ctx, order, args) => {
        const addr = order.shippingAddress;
        // TEMP DIAGNOSTIC — remove after commissioning
        const dbg = `order=${order.code} state=${order.state} country=${addr?.countryCode} city=${addr?.city} ` +
            `province=${addr?.province} postal=${addr?.postalCode} subTotal=${order.subTotalWithTax} ` +
            `min=${args.orderMinimum} validate=${args.enableAddressValidation}`;
        if (!addr?.countryCode || !addr.city) {
            Logger.info(`[eligibility] FAIL missing country/city — ${dbg}`, loggerCtx);
            return false;
        }
        if (!isSadcCountry(addr.countryCode)) {
            Logger.info(`[eligibility] FAIL non-SADC country — ${dbg}`, loggerCtx);
            return false;
        }
        if (order.subTotalWithTax < (args.orderMinimum ?? 0)) {
            Logger.info(`[eligibility] FAIL below orderMinimum — ${dbg}`, loggerCtx);
            return false;
        }

        if (args.enableAddressValidation && addressService) {
            const match = await addressService.bestMatch(
                addr.countryCode,
                addr.city || '',
                addr.streetLine2 || '',
                addr.postalCode || '',
            );
            if (!match) {
                Logger.info(`[eligibility] FAIL no DSV address match — ${dbg}`, loggerCtx);
                return false;
            }
        }

        Logger.info(`[eligibility] PASS — ${dbg}`, loggerCtx);
        return true;
    },
});
