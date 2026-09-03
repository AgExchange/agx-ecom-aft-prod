import {
  EventBus,
  JobQueueService,
  Logger,
  PluginCommonModule,
  Collection,
  CollectionEvent,
  Type,
  VendurePlugin,
  JobQueue,
} from "@vendure/core";
import { OnModuleInit } from "@nestjs/common";

import { CMS_PLUGIN_OPTIONS, loggerCtx } from "./constants";
import { PluginInitOptions, SyncJobData } from "./types";
import { CmsSyncService } from "./services/cms-sync.service";
import { PayloadService } from "./services/payload.service";
import { CmsSyncAdminResolver } from "./api/cms-sync-admin.resolver";
import { adminApiExtensions } from "./api/api-extensions";
import { syncCmsTask } from "./config/sync-cms-task";

@VendurePlugin({
  imports: [PluginCommonModule],
  providers: [
    { provide: CMS_PLUGIN_OPTIONS, useFactory: () => CmsPlugin.options },
    CmsSyncService,
    PayloadService,
  ],
  configuration: (config) => {
    config.schedulerOptions.tasks.push(syncCmsTask);
    return config;
  },
  compatibility: "^3.0.0",
  dashboard: "./dashboard/index.tsx",
  adminApiExtensions: {
    schema: adminApiExtensions,
    resolvers: [CmsSyncAdminResolver],
  },
})
export class CmsPlugin implements OnModuleInit {
  static options: PluginInitOptions;
  private collectionSyncQueue: JobQueue<SyncJobData>;

  constructor(
    private eventBus: EventBus,
    private jobQueueService: JobQueueService,
    private cmsSyncService: CmsSyncService,
  ) {}

  async onModuleInit() {
    this.collectionSyncQueue = await this.jobQueueService.createQueue({
      name: "cms-collection-sync",
      process: async (job) => {
        return this.cmsSyncService.syncCollectionToCms(job.data);
      },
    });

    this.eventBus.ofType(CollectionEvent).subscribe(async (event) => {
      try {
        Logger.info(`[${loggerCtx}] Collection event: ${event.type} for collection ${event.entity.id}`);
        await this.collectionSyncQueue.add({
          entityType: Collection.name,
          entityId: event.entity.id,
          operationType: this.mapEventType(event.type),
          timestamp: new Date().toISOString(),
          retryCount: 0,
        });
      } catch (error) {
        Logger.error(
          `[${loggerCtx}] Failed to queue collection sync: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    });

    Logger.info(`[${loggerCtx}] CMS Plugin initialized (collection sync only)`);
  }

  private mapEventType(eventType: string): "create" | "update" | "delete" {
    switch (eventType) {
      case "created": return "create";
      case "deleted": return "delete";
      default: return "update";
    }
  }

  static init(options: PluginInitOptions): Type<CmsPlugin> {
    this.options = options;
    return CmsPlugin;
  }
}
