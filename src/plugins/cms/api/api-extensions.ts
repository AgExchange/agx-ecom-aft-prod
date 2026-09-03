import gql from "graphql-tag";

export const adminApiExtensions = gql`
  type CmsSyncResult {
    success: Boolean!
    message: String!
    entityId: String!
    entityType: String!
  }

  type CmsSyncError {
    entityId: String!
    entityType: String!
    error: String!
    attempts: Int!
  }

  type BulkCmsSyncResult {
    success: Boolean!
    totalEntities: Int!
    successCount: Int!
    errorCount: Int!
    message: String!
    entityType: String!
    errors: [CmsSyncError!]!
  }

  extend type Query {
    getCmsSyncStatus: String!
  }

  extend type Mutation {
    syncCollectionToCms(id: ID!): CmsSyncResult!
    syncAllCollectionsToCms: BulkCmsSyncResult!
  }
`;
