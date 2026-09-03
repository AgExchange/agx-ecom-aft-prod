import {MigrationInterface, QueryRunner} from "typeorm";

/**
 * Stage 4 — dsv-shipping-plugin, dsv-sadc-plugin, dsv-sadc-ui.
 *
 * Adds the Address geo coordinates that dsv-sadc-plugin reads off
 * order.shippingAddress.customFields for DSV's SubmitShipment <coordinates> block.
 *
 * TWO GENERATED STATEMENTS WERE DELETED BY HAND:
 *   up():   DROP INDEX "public"."IDX_product_customFieldsMpn"
 *   down(): CREATE INDEX "IDX_product_customFieldsMpn" ...
 *
 * That is the known drift documented in docs/plugins/pim-sync.md. Vendure custom
 * fields have no `index` option, so the mpn index is hand-written in the stage-2
 * migration and TypeORM's metadata does not know it exists — every generation from
 * now on will try to drop it. Leaving it in would have silently removed the index
 * the PIM sync relies on for its primary product lookup.
 *
 * Note: no order_address columns. Vendure stores the order's address snapshot as an
 * embedded structure rather than a separate table, so Address custom fields do not
 * produce a second set of columns.
 */

export class Stage4DsvGeo1788425213633 implements MigrationInterface {

   public async up(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query(`ALTER TABLE "address" ADD "customFieldsLatitude" double precision`, undefined);
        await queryRunner.query(`ALTER TABLE "address" ADD "customFieldsLongitude" double precision`, undefined);
   }

   public async down(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query(`ALTER TABLE "address" DROP COLUMN "customFieldsLongitude"`, undefined);
        await queryRunner.query(`ALTER TABLE "address" DROP COLUMN "customFieldsLatitude"`, undefined);
   }

}
