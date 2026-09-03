import gql from 'graphql-tag';

export const adminApiExtensions = gql`
    type PimSyncErrorDetail {
        mpn: String!
        sku: String
        error: String!
    }

    type PimLastCompletedSync {
        triggeredAt: String!
        completedAt: String!
        syncMode: String!
        productsTotal: Int!
        productsCreated: Int!
        productsUpdated: Int!
        variantsTotal: Int!
        variantsCreated: Int!
        variantsUpdated: Int!
        errors: Int!
        priceStockIncluded: Boolean
        pricesUpdated: Int
        stockUpdated: Int
    }

    type PimSyncStatus {
        state: String!
        triggeredAt: String
        completedAt: String
        productsTotal: Int!
        productsCreated: Int!
        productsUpdated: Int!
        variantsTotal: Int!
        variantsCreated: Int!
        variantsUpdated: Int!
        errors: Int!
        message: String
        errorDetails: [PimSyncErrorDetail!]
        syncMode: String
        sinceDate: String
        priceStockIncluded: Boolean
        pricesUpdated: Int
        stockUpdated: Int
        lastCompletedSync: PimLastCompletedSync
    }

    extend type Query {
        getPimSyncStatus: PimSyncStatus!
    }

    extend type Mutation {
        triggerPimSync(includePriceStock: Boolean): PimSyncStatus!
        triggerPimDeltaSync(includePriceStock: Boolean): PimSyncStatus!
    }
`;
