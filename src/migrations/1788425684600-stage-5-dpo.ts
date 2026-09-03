import {MigrationInterface, QueryRunner} from "typeorm";

/**
 * Stage 5 — dpo-plugin.
 *
 * Creates the three DPO tables: dpo_transaction, dpo_transaction_event and
 * dpo_refund, with 11 indexes and 5 foreign keys.
 *
 * TWO GENERATED STATEMENTS WERE DELETED BY HAND, as in stage 4:
 *   up():   DROP INDEX "public"."IDX_product_customFieldsMpn"
 *   down(): CREATE INDEX "IDX_product_customFieldsMpn" ...
 * See docs/plugins/pim-sync.md for why this recurs on every generation.
 *
 * Column types worth noting, both checked rather than skimmed:
 *  - Money goes through entities/decimal-transformer.ts and lands as numeric(14,2)
 *    for paymentAmount / refundAmount and numeric(14,4) for the transaction amounts,
 *    which keeps FX-converted values at four decimal places.
 *  - `status` on both dpo_transaction and dpo_refund is `character varying` with a
 *    string default, NOT a Postgres enum. That is the intended state after
 *    agx-stores commit 810ac4f "fix enum column types".
 *
 * Foreign keys: orderId and dpoTransactionId cascade on delete; paymentId and
 * vendureRefundId are SET NULL, so removing a Vendure payment or refund leaves the
 * DPO audit row intact.
 */

export class Stage5Dpo1788425684600 implements MigrationInterface {

   public async up(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query(`CREATE TABLE "dpo_transaction" ("createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "companyRef" character varying NOT NULL, "transToken" character varying, "transRef" character varying, "serviceType" character varying NOT NULL, "serviceDescription" character varying, "paymentAmount" numeric(14,2) NOT NULL, "paymentCurrency" character varying(3) NOT NULL, "redirectUrl" text NOT NULL, "backUrl" text NOT NULL, "ptlValue" integer, "ptlType" character varying, "ptlExpiresAt" TIMESTAMP, "status" character varying NOT NULL DEFAULT 'pending_redirect', "lastResultCode" character varying, "lastResultExplanation" text, "paymentDate" TIMESTAMP, "paymentDateRaw" character varying(32), "verifyTokenConfirmedAt" TIMESTAMP, "transactionCreatedDate" TIMESTAMP, "transactionExpiryDate" TIMESTAMP, "transactionSettlementDate" date, "customerName" character varying, "approvalNumber" character varying, "cardType" character varying, "cardLastFour" character varying(4), "cardFirstSix" character varying(8), "transactionAmount" numeric(14,4), "transactionCurrency" character varying(3), "transactionFinalAmount" numeric(14,4), "transactionFinalCurrency" character varying(3), "partPaymentRef" character varying, "fraudAlertCode" character varying, "fraudExplanation" text, "id" SERIAL NOT NULL, "orderId" integer, "paymentId" integer, CONSTRAINT "PK_cc9d35b6c6094a28cbb78432937" PRIMARY KEY ("id"))`, undefined);
        await queryRunner.query(`CREATE INDEX "IDX_1f22a443aae36cda5fbf19ae03" ON "dpo_transaction" ("orderId") `, undefined);
        await queryRunner.query(`CREATE INDEX "IDX_ea180e2b627ab53c40fd5f1c3a" ON "dpo_transaction" ("paymentId") `, undefined);
        await queryRunner.query(`CREATE INDEX "IDX_18a858a75334f9d689169e23b2" ON "dpo_transaction" ("companyRef") `, undefined);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_739dab502288a192967c78892b" ON "dpo_transaction" ("transToken") `, undefined);
        await queryRunner.query(`CREATE INDEX "IDX_8ba34975e5cc2d8f3f8ce6ce35" ON "dpo_transaction" ("status") `, undefined);
        await queryRunner.query(`CREATE INDEX "IDX_63212738bb93a9c890775648ed" ON "dpo_transaction" ("paymentDate") `, undefined);
        await queryRunner.query(`CREATE TABLE "dpo_transaction_event" ("createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "eventType" character varying NOT NULL, "resultCode" character varying, "resultExplanation" text, "rawRequestXml" text, "rawResponseXml" text, "startedAt" TIMESTAMP, "durationMs" integer, "httpStatus" integer, "occurredAt" TIMESTAMP NOT NULL, "id" SERIAL NOT NULL, "dpoTransactionId" integer, CONSTRAINT "PK_e9a1f7945fe5e41d3239c4217e8" PRIMARY KEY ("id"))`, undefined);
        await queryRunner.query(`CREATE INDEX "IDX_e6e336fa063992e399878f016a" ON "dpo_transaction_event" ("dpoTransactionId") `, undefined);
        await queryRunner.query(`CREATE INDEX "IDX_db7a14f4f978bfc9986489e77b" ON "dpo_transaction_event" ("eventType") `, undefined);
        await queryRunner.query(`CREATE INDEX "IDX_3f3be61ac6dcadb2fd36c68460" ON "dpo_transaction_event" ("occurredAt") `, undefined);
        await queryRunner.query(`CREATE TABLE "dpo_refund" ("createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "refundAmount" numeric(14,2) NOT NULL, "refundDetails" text, "status" character varying NOT NULL DEFAULT 'requested', "resultCode" character varying, "resultExplanation" text, "requestedAt" TIMESTAMP NOT NULL, "completedAt" TIMESTAMP, "id" SERIAL NOT NULL, "dpoTransactionId" integer, "vendureRefundId" integer, CONSTRAINT "PK_e706d66f303aa809c4187c06ab4" PRIMARY KEY ("id"))`, undefined);
        await queryRunner.query(`CREATE INDEX "IDX_c9c346f7c0131c8888894c79a1" ON "dpo_refund" ("dpoTransactionId") `, undefined);
        await queryRunner.query(`CREATE INDEX "IDX_c783dc6725c57653e628369eb0" ON "dpo_refund" ("status") `, undefined);
        await queryRunner.query(`ALTER TABLE "dpo_transaction" ADD CONSTRAINT "FK_1f22a443aae36cda5fbf19ae03e" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE NO ACTION`, undefined);
        await queryRunner.query(`ALTER TABLE "dpo_transaction" ADD CONSTRAINT "FK_ea180e2b627ab53c40fd5f1c3a9" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON DELETE SET NULL ON UPDATE NO ACTION`, undefined);
        await queryRunner.query(`ALTER TABLE "dpo_transaction_event" ADD CONSTRAINT "FK_e6e336fa063992e399878f016a4" FOREIGN KEY ("dpoTransactionId") REFERENCES "dpo_transaction"("id") ON DELETE CASCADE ON UPDATE NO ACTION`, undefined);
        await queryRunner.query(`ALTER TABLE "dpo_refund" ADD CONSTRAINT "FK_c9c346f7c0131c8888894c79a13" FOREIGN KEY ("dpoTransactionId") REFERENCES "dpo_transaction"("id") ON DELETE CASCADE ON UPDATE NO ACTION`, undefined);
        await queryRunner.query(`ALTER TABLE "dpo_refund" ADD CONSTRAINT "FK_733bf22546e3e73f58ad8001d00" FOREIGN KEY ("vendureRefundId") REFERENCES "refund"("id") ON DELETE SET NULL ON UPDATE NO ACTION`, undefined);
   }

   public async down(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query(`ALTER TABLE "dpo_refund" DROP CONSTRAINT "FK_733bf22546e3e73f58ad8001d00"`, undefined);
        await queryRunner.query(`ALTER TABLE "dpo_refund" DROP CONSTRAINT "FK_c9c346f7c0131c8888894c79a13"`, undefined);
        await queryRunner.query(`ALTER TABLE "dpo_transaction_event" DROP CONSTRAINT "FK_e6e336fa063992e399878f016a4"`, undefined);
        await queryRunner.query(`ALTER TABLE "dpo_transaction" DROP CONSTRAINT "FK_ea180e2b627ab53c40fd5f1c3a9"`, undefined);
        await queryRunner.query(`ALTER TABLE "dpo_transaction" DROP CONSTRAINT "FK_1f22a443aae36cda5fbf19ae03e"`, undefined);
        await queryRunner.query(`DROP INDEX "public"."IDX_c783dc6725c57653e628369eb0"`, undefined);
        await queryRunner.query(`DROP INDEX "public"."IDX_c9c346f7c0131c8888894c79a1"`, undefined);
        await queryRunner.query(`DROP TABLE "dpo_refund"`, undefined);
        await queryRunner.query(`DROP INDEX "public"."IDX_3f3be61ac6dcadb2fd36c68460"`, undefined);
        await queryRunner.query(`DROP INDEX "public"."IDX_db7a14f4f978bfc9986489e77b"`, undefined);
        await queryRunner.query(`DROP INDEX "public"."IDX_e6e336fa063992e399878f016a"`, undefined);
        await queryRunner.query(`DROP TABLE "dpo_transaction_event"`, undefined);
        await queryRunner.query(`DROP INDEX "public"."IDX_63212738bb93a9c890775648ed"`, undefined);
        await queryRunner.query(`DROP INDEX "public"."IDX_8ba34975e5cc2d8f3f8ce6ce35"`, undefined);
        await queryRunner.query(`DROP INDEX "public"."IDX_739dab502288a192967c78892b"`, undefined);
        await queryRunner.query(`DROP INDEX "public"."IDX_18a858a75334f9d689169e23b2"`, undefined);
        await queryRunner.query(`DROP INDEX "public"."IDX_ea180e2b627ab53c40fd5f1c3a"`, undefined);
        await queryRunner.query(`DROP INDEX "public"."IDX_1f22a443aae36cda5fbf19ae03"`, undefined);
        await queryRunner.query(`DROP TABLE "dpo_transaction"`, undefined);
   }

}
