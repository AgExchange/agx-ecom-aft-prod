import { OnModuleInit, Type } from '@nestjs/common';
import {
    Job,
    JobQueue,
    JobQueueService,
    Logger,
    PluginCommonModule,
    VendurePlugin,
} from '@vendure/core';
import { adminApiExtensions } from './api/api-extensions';
import { PimSyncResolver } from './api/pim-sync.resolver';
import { PIM_SYNC_OPTIONS, loggerCtx, SYNC_QUEUE_NAME } from './constants';
import { AssetSyncService } from './services/asset-sync.service';
import { FacetSyncService } from './services/facet-sync.service';
import { PimApiService } from './services/pim-api.service';
import { PimSyncService } from './services/pim-sync.service';
import { PriceStockSyncService } from './services/price-stock-sync.service';
import { ProductUpsertService } from './services/product-upsert.service';
import { PimSyncOptions, SyncJobData } from './types';

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [
        { provide: PIM_SYNC_OPTIONS, useFactory: () => PimSyncPlugin.options },
        PimApiService,
        AssetSyncService,
        FacetSyncService,
        PriceStockSyncService,
        ProductUpsertService,
        PimSyncService,
    ],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [PimSyncResolver],
    },
    dashboard: './dashboard/index.tsx',
    compatibility: '^3.0.0',
})
export class PimSyncPlugin implements OnModuleInit {
    static options: PimSyncOptions;

    private syncQueue!: JobQueue<SyncJobData>;

    constructor(
        private jobQueueService: JobQueueService,
        private pimSyncService: PimSyncService,
    ) {}

    async onModuleInit(): Promise<void> {
        this.syncQueue = await this.jobQueueService.createQueue({
            name: SYNC_QUEUE_NAME,
            process: async (job: Job<SyncJobData>) => {
                return this.pimSyncService.runSync(job.data, job);
            },
        });
        this.pimSyncService.setJobQueue(this.syncQueue);
        Logger.info('PimSyncPlugin initialized', loggerCtx);
    }

    static init(options: PimSyncOptions): Type<PimSyncPlugin> {
        this.options = options;
        return PimSyncPlugin;
    }
}
