import gql from 'graphql-tag';

/**
 * Registers the custom `DSV_SADC_TRACKING` member on the `HistoryEntryType`
 * enum. Without this, the Admin API cannot serialise history entries of this
 * type (GraphQL rejects enum values not declared in the schema) and the
 * order-history query would error.
 */
export const historyApiExtensions = gql`
    extend enum HistoryEntryType {
        DSV_SADC_TRACKING
    }
`;
