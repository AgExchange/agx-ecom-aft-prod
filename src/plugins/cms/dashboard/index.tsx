import { defineDashboardExtension } from "@vendure/dashboard";

// ---------------------------------------------------------------------------
// TODO: "Sync to CMS" action bar buttons — DISABLED during the stage-2 port.
//
// The code below is commented out verbatim from agx-stores. It is broken there
// too; this is not a porting defect.
//
// TWO SEPARATE PROBLEMS:
//
// 1. The mutation does not exist.
//    This document calls `syncEntityToCms(id, entityType)`. The server declares
//    only `syncCollectionToCms(id: ID!)` and `syncAllCollectionsToCms`
//    (see ../api/api-extensions.ts and ../api/cms-sync-admin.resolver.ts).
//    `syncEntityToCms` appears nowhere else in this repo OR in agx-stores —
//    confirmed by grep across both. Clicking any of these buttons fails with a
//    GraphQL validation error: "Cannot query field syncEntityToCms on type
//    Mutation".
//
// 2. Renaming the mutation would only fix one of the three buttons.
//    SyncButton is registered on product-detail, product-variant-detail AND
//    collection-detail. The CMS plugin syncs Collections only — its own startup
//    log says so: "CMS Plugin initialized (collection sync only)". There is no
//    server-side product or variant sync to call, under any name.
//
// TO RESTORE, pick one:
//
//   (a) Collection only — the small fix.
//       Change the document to `syncCollectionToCms(id: $id)`, drop the
//       `entityType` variable and the switch, and register the button on
//       `collection-detail` only. Note the server returns CmsSyncResult; check
//       its actual fields, as they may not match the four selected here.
//
//   (b) Full entity sync — the real feature.
//       Add a `syncEntityToCms` mutation server-side that dispatches on
//       entityType, plus the product/variant sync paths in CmsSyncService.
//       Then this file works as written.
//
// Option (a) is a few lines and makes the working case work. Option (b) is the
// feature someone originally intended and never finished.
//
// See docs/plugins/cms.md ("Known issues") for the full write-up.
// ---------------------------------------------------------------------------

// import {
//   api,
//   Button,
//   ContextMenu,
// } from "@vendure/dashboard";
// import { useState } from "react";
// import { graphql } from "@/gql";
// import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// import { toast } from "sonner";
//
// const syncEntityMutation = graphql(`
//   mutation SyncEntity($id: ID!, $entityType: String!) {
//     syncEntityToCms(id: $id, entityType: $entityType) {
//       success
//       message
//       entityId
//       entityType
//     }
//   }
// `);
//
// const SyncButton = ({ context }) => {
//   let entityType: string;
//   switch (context.pageId) {
//     case "product-detail":
//       entityType = "Product";
//       break;
//     case "product-variant-detail":
//       entityType = "ProductVariant";
//       break;
//     case "collection-detail":
//       entityType = "Collection";
//       break;
//     default:
//       throw new Error("Invalid pageId");
//   }
//
//   const mutation = useMutation({
//     mutationFn: api.mutate(syncEntityMutation),
//     onSuccess: () => {
//       // Invalidate and refetch product queries
//       toast.success(`${entityType} synced to CMS`);
//     },
//     onError: (error) => {
//       toast.error(`Failed to sync ${entityType} to CMS`, {
//         description: error.message,
//       });
//     },
//   });
//   return (
//     <Button
//       type="button"
//       variant="secondary"
//       onClick={() =>
//         mutation.mutate({ id: context.entity.id, entityType: entityType })
//       }
//     >
//       Sync to CMS
//     </Button>
//   );
// };

export default defineDashboardExtension({
  // TODO: restore once the mutation mismatch above is resolved.
  // actionBarItems: [
  //   { pageId: "product-detail", component: SyncButton },
  //   { pageId: "product-variant-detail", component: SyncButton },
  //   { pageId: "collection-detail", component: SyncButton },
  // ],
  actionBarItems: [],
});
