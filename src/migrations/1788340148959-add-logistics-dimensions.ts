import {MigrationInterface, QueryRunner} from "typeorm";

export class AddLogisticsDimensions1788340148959 implements MigrationInterface {

   public async up(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query(`ALTER TABLE "product_variant" ADD "customFieldsDimensionweightg" integer`, undefined);
        await queryRunner.query(`ALTER TABLE "product_variant" ADD "customFieldsDimensionlengthmm" integer`, undefined);
        await queryRunner.query(`ALTER TABLE "product_variant" ADD "customFieldsDimensionwidthmm" integer`, undefined);
        await queryRunner.query(`ALTER TABLE "product_variant" ADD "customFieldsDimensionheightmm" integer`, undefined);
        await queryRunner.query(`ALTER TABLE "product_variant" ADD "customFieldsDimensionvolumetricweightg" integer`, undefined);
   }

   public async down(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query(`ALTER TABLE "product_variant" DROP COLUMN "customFieldsDimensionvolumetricweightg"`, undefined);
        await queryRunner.query(`ALTER TABLE "product_variant" DROP COLUMN "customFieldsDimensionheightmm"`, undefined);
        await queryRunner.query(`ALTER TABLE "product_variant" DROP COLUMN "customFieldsDimensionwidthmm"`, undefined);
        await queryRunner.query(`ALTER TABLE "product_variant" DROP COLUMN "customFieldsDimensionlengthmm"`, undefined);
        await queryRunner.query(`ALTER TABLE "product_variant" DROP COLUMN "customFieldsDimensionweightg"`, undefined);
   }

}
