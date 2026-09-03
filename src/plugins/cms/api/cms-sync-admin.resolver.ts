import { Args, Mutation, Query, Resolver } from "@nestjs/graphql";
import { Permission } from "@vendure/common/lib/generated-types";
import { ID } from "@vendure/common/lib/shared-types";
import { Allow, Ctx, RequestContext } from "@vendure/core";
import { CmsSyncService } from "../services/cms-sync.service";

@Resolver()
export class CmsSyncAdminResolver {
  constructor(private cmsSyncService: CmsSyncService) {}

  @Query()
  @Allow(Permission.SuperAdmin)
  async getCmsSyncStatus(@Ctx() ctx: RequestContext): Promise<string> {
    return "CMS Sync service is ready";
  }

  @Mutation()
  @Allow(Permission.SuperAdmin)
  async syncCollectionToCms(
    @Ctx() ctx: RequestContext,
    @Args() args: { id: ID },
  ): Promise<{ success: boolean; message: string; entityId: string; entityType: string }> {
    const result = await this.cmsSyncService.syncCollectionToCms({
      entityType: "Collection",
      entityId: args.id,
      operationType: "update",
      timestamp: new Date().toISOString(),
      retryCount: 0,
    });
    return {
      success: result.success,
      message: result.message,
      entityId: args.id.toString(),
      entityType: "Collection",
    };
  }

  @Mutation()
  @Allow(Permission.SuperAdmin)
  async syncAllCollectionsToCms(@Ctx() ctx: RequestContext): Promise<{
    success: boolean;
    totalEntities: number;
    successCount: number;
    errorCount: number;
    message: string;
    entityType: string;
    errors: Array<{ entityId: string; entityType: string; error: string; attempts: number }>;
  }> {
    const result = await this.cmsSyncService.syncAllCollectionsToCms();
    return {
      success: result.success,
      totalEntities: result.totalCollections,
      successCount: result.successCount,
      errorCount: result.errorCount,
      message: result.success
        ? `Successfully synced ${result.successCount}/${result.totalCollections} collections`
        : `Synced ${result.successCount}/${result.totalCollections} collections, ${result.errorCount} failed`,
      entityType: "Collection",
      errors: result.errors.map((e) => ({
        entityId: e.collectionId.toString(),
        entityType: "Collection",
        error: e.error,
        attempts: 1,
      })),
    };
  }
}
