/**
 * Typed GraphQL error results returned by the quote mutations. The corresponding
 * `ErrorCode` enum values are added to the schema via `extend enum ErrorCode { ... }`
 * in `api-extensions.ts`, so the `errorCode` strings below are valid at the GraphQL
 * layer. Each class carries a `__typename` so Apollo can resolve the result unions.
 *
 * Note: these intentionally do not `implements ErrorResult` from `@vendure/core`,
 * because that interface types `errorCode` as the generated `ErrorCode` enum which does
 * not (at compile time) include our plugin-specific codes. The structural shape
 * (`__typename` + `errorCode` + `message`) is what the GraphQL types require.
 */

export class QuoteRequiresLoginError {
    readonly __typename = 'QuoteRequiresLoginError' as const;
    readonly errorCode = 'QUOTE_REQUIRES_LOGIN_ERROR' as const;
    readonly message: string;
    constructor(message = 'You must be logged in to request a quote.') {
        this.message = message;
    }
}

export class QuoteExpiredError {
    readonly __typename = 'QuoteExpiredError' as const;
    readonly errorCode = 'QUOTE_EXPIRED_ERROR' as const;
    readonly message: string;
    constructor(message = 'This quote has expired and can no longer be accepted.') {
        this.message = message;
    }
}

export class QuoteNotFoundError {
    readonly __typename = 'QuoteNotFoundError' as const;
    readonly errorCode = 'QUOTE_NOT_FOUND_ERROR' as const;
    readonly message: string;
    constructor(message = 'No quote was found for the given code.') {
        this.message = message;
    }
}
