import gql from 'graphql-tag';
import { DocumentNode } from 'graphql';

export const shopApiExtensions: DocumentNode = gql`
  # PayFast payment method codes (all 16):
  # ef=EFT, cc=Credit Card, dc=Debit Card, mp=Masterpass, mc=Mobicred, sc=SCode,
  # ss=SnapScan, zp=Zapper, mt=MoreTyme, rc=Store Card, mu=Mukuru,
  # ap=Apple Pay, sp=Samsung Pay, cp=Capitec Pay, gp=Google Pay, pf=Payflex
  enum PayfastPaymentMethod {
    ef
    cc
    dc
    mp
    mc
    sc
    ss
    zp
    mt
    rc
    mu
    ap
    sp
    cp
    gp
    pf
  }

  type PayfastMethodOption {
    code: String!
    label: String!
    description: String!
  }

  input PayfastPaymentIntentInput {
    redirectUrl: String!
    paymentMethod: PayfastPaymentMethod
  }

  type PayfastPaymentIntent {
    url: String!
  }

  type PayfastPaymentIntentError implements ErrorResult {
    errorCode: ErrorCode!
    message: String!
  }

  union PayfastPaymentIntentResult =
      PayfastPaymentIntent
    | PayfastPaymentIntentError

  extend type Query {
    payfastAvailablePaymentMethods: [PayfastMethodOption!]!
  }

  extend type Mutation {
    createPayfastPaymentIntent(
      input: PayfastPaymentIntentInput!
    ): PayfastPaymentIntentResult!
  }
`;
