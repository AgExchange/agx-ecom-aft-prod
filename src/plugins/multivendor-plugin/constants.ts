export const loggerCtx = 'MultivendorPlugin';

// PaymentMethodHandler code for the internal, no-op "settlement" payment used on Seller
// Orders. Never a real gateway call — see config/mv-settlement-payment-handler.ts.
export const SETTLEMENT_HANDLER_CODE = 'mv-internal-settlement';

// Fixed code for the single PaymentMethod row using the settlement handler, auto-provisioned
// on plugin bootstrap. Never assigned to any Channel's available payment methods.
export const SETTLEMENT_PAYMENT_METHOD_CODE = 'mv-internal-settlement-method';

export const PLATFORM_FEE_SURCHARGE_SKU = 'PLATFORM_FEE';
export const PLATFORM_FEE_SURCHARGE_DESCRIPTION = 'Platform fee';
