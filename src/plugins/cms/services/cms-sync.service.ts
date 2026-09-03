import { Inject, Injectable } from "@nestjs/common";
import {
  ChannelService,
  Collection,
  ID,
  LanguageCode,
  Logger,
  ProcessContext,
  RequestContextService,
  TransactionalConnection,
} from "@vendure/core";
import { CMS_PLUGIN_OPTIONS, loggerCtx } from "../constants";
import { PluginInitOptions, SyncJobData, SyncResponse } from "../types";
import { PayloadService } from "./payload.service";

@Injectable()
export class CmsSyncService {
  constructor(
    @Inject(CMS_PLUGIN_OPTIONS) private options: PluginInitOptions,
    private readonly connection: TransactionalConnection,
    private readonly channelService: ChannelService,
    private readonly requestContextService: RequestContextService,
    private readonly payloadService: PayloadService,
    private processContext: ProcessContext,
  ) {}

  private async getDefaultLanguageCode(): Promise<LanguageCode> {
    const defaultChannel = await this.channelService.getDefaultChannel();
    return defaultChannel.defaultLanguageCode;
  }

  private async isLevelOne(collectionId: any): Promise<boolean> {
    const collection = await this.connection.rawConnection
      .getRepository(Collection)
      .findOne({
        where: { id: collectionId },
        relations: ["parent"],
      });
    return !!collection?.parent?.isRoot;
  }

  async syncCollectionToCms(jobData: SyncJobData): Promise<SyncResponse> {
    try {
      const collection = await this.connection.rawConnection
        .getRepository(Collection)
        .findOne({
          where: { id: jobData.entityId as any },
          relations: ["translations", "parent", "featuredAsset"],
        });

      if (!collection) {
        throw new Error(`Collection with ID ${jobData.entityId} not found`);
      }

      if (!collection.parent?.isRoot) {
        Logger.debug(`[${loggerCtx}] Skipping collection ${jobData.entityId} — not a level 1 collection`);
        return { success: true, message: "Skipped: not a level 1 collection" };
      }

      const defaultLanguageCode = await this.getDefaultLanguageCode();

      await this.payloadService.syncCollection({
        collection,
        defaultLanguageCode,
        operationType: jobData.operationType,
      });

      return {
        success: true,
        message: `Collection ${jobData.operationType} synced successfully`,
        timestamp: new Date(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const errorStack = error instanceof Error ? error.stack : "";
      Logger.error(`[${loggerCtx}] Collection sync failed: ${errorMessage}`, errorStack);
      return {
        success: false,
        message: `Collection sync failed: ${errorMessage}`,
      };
    }
  }

  async syncAllCollectionsToCms(): Promise<{
    success: boolean;
    totalCollections: number;
    successCount: number;
    errorCount: number;
    errors: Array<{ collectionId: ID; error: string }>;
  }> {
    let successCount = 0;
    let errorCount = 0;
    const errors: Array<{ collectionId: ID; error: string }> = [];

    const allCollections = await this.connection.rawConnection
      .getRepository(Collection)
      .find({
        relations: ["translations", "parent", "featuredAsset"],
        order: { id: "ASC" },
      });

    const collections = allCollections.filter((c) => c.parent?.isRoot);

    Logger.info(`[${loggerCtx}] Bulk syncing ${collections.length} level 1 collections to Payload`);

    for (const collection of collections) {
      try {
        await this.syncCollectionToCms({
          entityType: "Collection",
          entityId: collection.id,
          operationType: "update",
          timestamp: new Date().toISOString(),
          retryCount: 0,
        });
        successCount++;
      } catch (error) {
        errorCount++;
        errors.push({
          collectionId: collection.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    Logger.info(`[${loggerCtx}] Bulk sync complete: ${successCount}/${collections.length} successful`);

    return {
      success: errorCount === 0,
      totalCollections: collections.length,
      successCount,
      errorCount,
      errors,
    };
  }
}
