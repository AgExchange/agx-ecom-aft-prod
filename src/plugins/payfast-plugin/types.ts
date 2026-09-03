export interface PayFastPluginOptions {
    /** Public URL of your Vendure server — used to build the ITN notify URL. */
    vendureHost: string;
}

/**
 * Per-PaymentMethod PayFast credentials. Resolved from `PaymentMethodHandler.args` —
 * each PaymentMethod entity using the `payfast` handler code configures its own values,
 * so "PayFast Live" and "PayFast Test" can coexist as separate, independently
 * channel-assignable PaymentMethods.
 */
export interface PayFastCredentials {
    merchantId: string;
    merchantKey: string;
    passphrase?: string;
    sandbox: boolean;
}

/** PayFast payment_method field values (all 16 supported codes). */
export type PayFastPaymentMethod =
    | 'ef' | 'cc' | 'dc' | 'mp' | 'mc' | 'sc'
    | 'ss' | 'zp' | 'mt' | 'rc' | 'mu'
    | 'ap' | 'sp' | 'cp' | 'gp' | 'pf';

/** Master list of all PayFast payment methods with display labels. */
export const ALL_PAYFAST_METHODS: Array<{ code: PayFastPaymentMethod; label: string; description: string }> = [
    { code: 'ef', label: 'EFT',          description: 'Electronic Funds Transfer' },
    { code: 'cc', label: 'Credit Card',  description: 'Visa, Mastercard, Amex' },
    { code: 'dc', label: 'Debit Card',   description: 'Visa, Mastercard debit' },
    { code: 'mp', label: 'Masterpass',   description: 'Masterpass Scan to Pay' },
    { code: 'mc', label: 'Mobicred',     description: 'Buy now, pay later' },
    { code: 'sc', label: 'SCode',        description: 'SCode payment' },
    { code: 'ss', label: 'SnapScan',     description: 'Scan to pay with SnapScan' },
    { code: 'zp', label: 'Zapper',       description: 'Scan to pay with Zapper' },
    { code: 'mt', label: 'MoreTyme',     description: 'Buy now, pay in 3' },
    { code: 'rc', label: 'Store Card',   description: 'Store card payment' },
    { code: 'mu', label: 'Mukuru',       description: 'Mukuru payment' },
    { code: 'ap', label: 'Apple Pay',    description: 'Pay with Apple Pay' },
    { code: 'sp', label: 'Samsung Pay',  description: 'Pay with Samsung Pay' },
    { code: 'cp', label: 'Capitec Pay',  description: 'Pay with Capitec Pay' },
    { code: 'gp', label: 'Google Pay',   description: 'Pay with Google Pay' },
    { code: 'pf', label: 'Payflex',      description: 'Buy Now, Pay Later' },
];

export interface PayFastFormData {
    merchant_id: string;
    merchant_key: string;
    return_url: string;
    cancel_url: string;
    notify_url: string;
    name_first?: string;
    name_last?: string;
    email_address?: string;
    m_payment_id: string;
    amount: string;
    item_name: string;
    /** Restricts the PayFast checkout to a specific payment method. Optional. */
    payment_method?: PayFastPaymentMethod;
    /** Vendure channel token — used by ITN webhook for multi-channel support. */
    custom_str1: string;
    signature: string;
    [key: string]: string | undefined;
}

/** PayFast ITN (Instant Transaction Notification) POST body. */
export interface PayFastITNPayload {
    m_payment_id: string;
    pf_payment_id: string;
    payment_status: string;
    item_name: string;
    item_description?: string;
    amount_gross: string;
    amount_fee: string;
    amount_net: string;
    custom_str1?: string;
    custom_str2?: string;
    custom_str3?: string;
    custom_str4?: string;
    custom_str5?: string;
    name_first?: string;
    name_last?: string;
    email_address?: string;
    merchant_id: string;
    signature: string;
    [key: string]: string | undefined;
}
