import gql from 'graphql-tag';
import { DocumentNode } from 'graphql';

/**
 * Shop API extensions: the customer-facing quote mutations and their typed error results.
 * NOTE: do NOT also `extend enum ErrorCode` here — Vendure's `generateErrorCodeEnum`
 * (api/config/generate-error-code-enum.js) automatically derives ErrorCode enum members
 * from every GraphQL type below that `implements ErrorResult` (camelCase type name ->
 * UPPER_SNAKE_CASE, e.g. QuoteRequiresLoginError -> QUOTE_REQUIRES_LOGIN_ERROR). A manual
 * `extend enum ErrorCode { QUOTE_REQUIRES_LOGIN_ERROR ... }` block here double-registers
 * the same enum values and crashes schema build at server boot with "Enum value ... already
 * exists in the schema. It cannot also be defined in this type extension." — this doesn't
 * surface at `tsc --noEmit`, only at runtime GraphQL schema construction.
 */
export const shopApiExtensions: DocumentNode = gql`
  "Returned when an unauthenticated caller attempts to request a quote."
  type QuoteRequiresLoginError implements ErrorResult {
    errorCode: ErrorCode!
    message: String!
  }

  "Returned when attempting to accept a quote whose validity has passed."
  type QuoteExpiredError implements ErrorResult {
    errorCode: ErrorCode!
    message: String!
  }

  "Returned when no quote exists for the supplied order code (or it is not the caller's)."
  type QuoteNotFoundError implements ErrorResult {
    errorCode: ErrorCode!
    message: String!
  }

  union RequestQuoteResult = Order | QuoteRequiresLoginError
  union AcceptQuoteResult = Order | QuoteExpiredError | QuoteNotFoundError
  union RejectQuoteResult = Order | QuoteNotFoundError
  union WithdrawQuoteResult = Order | QuoteNotFoundError

  extend type Query {
    "Looks up a quote by its human-readable reference (e.g. Q-2026-00042), owned by the caller."
    quoteByReference(reference: String!): Order
  }

  extend type Mutation {
    "Turns the authenticated customer's active order into a quote."
    requestQuote: RequestQuoteResult!
    "Withdraws an open quote request, handing the order back as an ordinary cart."
    withdrawQuoteRequest(orderCode: String!): WithdrawQuoteResult!
    "Accepts a quote, moving it forward into the normal checkout flow."
    acceptQuote(orderCode: String!): AcceptQuoteResult!
    "Rejects a quote (terminal)."
    rejectQuote(orderCode: String!): RejectQuoteResult!
  }
`;

/**
 * Admin API extensions: the team-facing quote management mutations.
 *
 * NOTE: `HistoryEntryType` is extended with `QUOTE_SENT` here too (rather than a separate
 * file) — see `../history-types.ts` for the corresponding TS declaration merge. Without
 * this the Admin API cannot serialise `sendQuote`'s history entries (GraphQL rejects enum
 * values not declared in the schema).
 */
export const adminApiExtensions: DocumentNode = gql`
  extend enum HistoryEntryType {
    QUOTE_SENT
  }

  extend type Query {
    "Lists every order that has ever been a quote (quoteReference is set), newest first."
    quotes(options: OrderListOptions): OrderList!
  }

  extend type Mutation {
    "Converts an existing native Draft Order (built via the Admin UI's own draft-order flow) into a quote."
    createQuote(orderId: ID!): Order!
    "Sends (or re-sends) a quote to the customer."
    sendQuote(id: ID!): Order!
    "Sets or extends the validity date of a quote."
    setQuoteValidity(id: ID!, validUntil: DateTime!): Order!
    "Edits the customer-facing notes on a quote."
    updateQuoteNotes(id: ID!, notes: String!): Order!
    "Accepts a sent quote on the customer's behalf (e.g. after a phone/email confirmation)."
    acceptQuote(id: ID!): Order!
  }
`;
