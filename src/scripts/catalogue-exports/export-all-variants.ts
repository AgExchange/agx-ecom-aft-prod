import { bootstrapWorker, Logger, RequestContextService } from '@vendure/core';

import { config } from '../vendure-config';
import { ProductInfoService } from '../plugins/product-info/services/product-info.service';

if (require.main === module) {
  exportAllVariants()
    .then(() => process.exit(0))
    .catch((err) => {
      Logger.error(err?.message ?? String(err), err?.stack, 'ExportAllVariants');
      process.exit(1);
    });
}

async function exportAllVariants() {
  const { app } = await bootstrapWorker(config);
  const productInfoService = app.get(ProductInfoService);
  const ctx = await app.get(RequestContextService).create({
    apiType: 'admin',
  });

  const csvFilePath = await productInfoService.exportAllVariantsToCsv(ctx);

  Logger.info(`All variants export complete! File saved at: ${csvFilePath}`);
}
