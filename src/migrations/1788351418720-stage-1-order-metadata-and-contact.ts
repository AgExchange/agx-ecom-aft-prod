import {MigrationInterface, QueryRunner} from "typeorm";

export class Stage1OrderMetadataAndContact1788351418720 implements MigrationInterface {

   public async up(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsMetadatacategory" character varying(255)`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsMachinebrand" character varying(255)`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsMachinemodel" character varying(255)`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsSerialnumber" character varying(255)`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsSerialnumberphotoassetid" character varying(255)`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsEngineapplication" character varying(255)`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsEnginenumber" character varying(255)`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsFilterairinner" boolean NOT NULL DEFAULT false`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsFilterairouter" boolean NOT NULL DEFAULT false`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsFilterfuel" boolean NOT NULL DEFAULT false`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsFilterhydraulic" boolean NOT NULL DEFAULT false`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsFilteroil" boolean NOT NULL DEFAULT false`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsFiltersteering" boolean NOT NULL DEFAULT false`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsFiltertransmission" boolean NOT NULL DEFAULT false`, undefined);
        await queryRunner.query(`ALTER TABLE "channel" ADD "customFieldsInfoemail" character varying(255)`, undefined);
   }

   public async down(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query(`ALTER TABLE "channel" DROP COLUMN "customFieldsInfoemail"`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsFiltertransmission"`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsFiltersteering"`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsFilteroil"`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsFilterhydraulic"`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsFilterfuel"`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsFilterairouter"`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsFilterairinner"`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsEnginenumber"`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsEngineapplication"`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsSerialnumberphotoassetid"`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsSerialnumber"`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsMachinemodel"`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsMachinebrand"`, undefined);
        await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsMetadatacategory"`, undefined);
   }

}
