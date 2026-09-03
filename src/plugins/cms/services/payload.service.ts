import { Inject, Injectable } from "@nestjs/common";
import {
  Collection,
  LanguageCode,
  Logger,
} from "@vendure/core";
import { CMS_PLUGIN_OPTIONS } from "../constants";
import { OperationType, PluginInitOptions } from "../types";
import { TranslationUtils } from "../utils/translation.utils";

const PAYLOAD_COLLECTION = "product-collections";

@Injectable()
export class PayloadService {
  private readonly payloadBaseUrl = "http://localhost:3002/sites/api";
  private readonly translationUtils = new TranslationUtils();
  private lastApiCallTime = 0;
  private readonly rateLimitDelay = 100;

  constructor(
    @Inject(CMS_PLUGIN_OPTIONS) private options: PluginInitOptions,
  ) {}

  async syncCollection({
    collection,
    defaultLanguageCode,
    operationType,
  }: {
    collection: Collection;
    defaultLanguageCode: LanguageCode;
    operationType: OperationType;
  }) {
    try {
      this.translationUtils.validateTranslations(
        collection.translations,
        defaultLanguageCode,
      );

      Logger.info(`Syncing collection ${collection.id} (${operationType}) to Payload`);

      switch (operationType) {
        case "create":
          await this.createCollection(collection, defaultLanguageCode);
          break;
        case "update":
          await this.updateCollection(collection, defaultLanguageCode);
          break;
        case "delete":
          await this.deleteCollection(collection, defaultLanguageCode);
          break;
        default:
          Logger.error(`Unknown operation type: ${operationType}`);
      }

      Logger.info(`Successfully synced collection ${collection.id} (${operationType}) to Payload`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      Logger.error(`Failed to sync collection ${collection.id} (${operationType}) to Payload: ${errorMessage}`);
      throw error;
    }
  }

  private async findCollectionByVendureId(vendureId: string): Promise<any> {
    try {
      const response = await this.makePayloadRequest({
        method: "GET",
        endpoint: `${PAYLOAD_COLLECTION}?where[vendureCollectionId][equals]=${encodeURIComponent(vendureId)}`,
      });
      return response.docs?.[0] || null;
    } catch (error) {
      Logger.error(`Failed to find Payload collection by vendureId ${vendureId}`, String(error));
      return null;
    }
  }

  private getTranslationData(collection: Collection, defaultLanguageCode: LanguageCode) {
    const translation = this.translationUtils.getTranslationByLanguage(
      collection.translations,
      defaultLanguageCode,
    );
    if (!translation) return null;
    return {
      name: translation.name ?? "",
      slug: translation.slug ?? "",
      description: translation.description ?? "",
    };
  }

  private getImageUrl(collection: Collection): string {
    if (!collection.featuredAsset) return "";
    const preview = collection.featuredAsset.preview;
    return preview ? `${preview}` : "";
  }

  private buildVendureData(collection: Collection, defaultLanguageCode: LanguageCode) {
    const t = this.getTranslationData(collection, defaultLanguageCode);
    if (!t) return null;
    return {
      name: t.name,
      slug: t.slug,
      description: t.description,
      imageUrl: this.getImageUrl(collection),
    };
  }

  private async createCollection(
    collection: Collection,
    defaultLanguageCode: LanguageCode,
  ): Promise<void> {
    const t = this.getTranslationData(collection, defaultLanguageCode);
    if (!t) {
      Logger.error(`No translation for collection ${collection.id}, skipping create`);
      return;
    }

    const result = await this.makePayloadRequest({
      method: "POST",
      endpoint: PAYLOAD_COLLECTION,
      data: {
        vendureCollectionId: collection.id.toString(),
        title: t.name,
        slug: t.slug,
        vendureData: this.buildVendureData(collection, defaultLanguageCode),
        status: "active",
      },
    });

    Logger.info(`Created Payload product-collection for Vendure collection ${collection.id} (Payload ID: ${result.doc?.id})`);
  }

  private async updateCollection(
    collection: Collection,
    defaultLanguageCode: LanguageCode,
  ): Promise<void> {
    const existing = await this.findCollectionByVendureId(collection.id.toString());

    if (!existing) {
      Logger.warn(`No Payload document found for Vendure collection ${collection.id}, creating instead`);
      await this.createCollection(collection, defaultLanguageCode);
      return;
    }

    const vendureData = this.buildVendureData(collection, defaultLanguageCode);
    if (!vendureData) {
      Logger.error(`No translation for collection ${collection.id}, skipping update`);
      return;
    }

    await this.makePayloadRequest({
      method: "PATCH",
      endpoint: `${PAYLOAD_COLLECTION}/${existing.id}`,
      data: { vendureData },
    });

    Logger.info(`Updated vendureData for Payload product-collection ${existing.id} (Vendure collection ${collection.id})`);
  }

  private async deleteCollection(
    collection: Collection,
    defaultLanguageCode: LanguageCode,
  ): Promise<void> {
    const existing = await this.findCollectionByVendureId(collection.id.toString());

    if (!existing) {
      Logger.warn(`No Payload document found for Vendure collection ${collection.id}, nothing to delete`);
      return;
    }

    await this.makePayloadRequest({
      method: "DELETE",
      endpoint: `${PAYLOAD_COLLECTION}/${existing.id}`,
    });

    Logger.info(`Deleted Payload product-collection ${existing.id} for Vendure collection ${collection.id}`);
  }

  private getPayloadHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.options.cmsApiKey) {
      headers.Authorization = `Bearer ${this.options.cmsApiKey}`;
    }
    return headers;
  }

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastApiCallTime;
    if (timeSinceLastCall < this.rateLimitDelay) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.rateLimitDelay - timeSinceLastCall),
      );
    }
    this.lastApiCallTime = Date.now();
  }

  private async makePayloadRequest({
    method,
    endpoint,
    data,
  }: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    endpoint: string;
    data?: any;
  }): Promise<any> {
    const url = `${this.payloadBaseUrl}/${endpoint}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const config: RequestInit = {
      method,
      headers: this.getPayloadHeaders(),
      signal: controller.signal,
    };
    if (data && (method === "POST" || method === "PATCH")) {
      config.body = JSON.stringify(data);
    }

    await this.enforceRateLimit();

    Logger.debug(`Payload API: ${method} ${url}`);
    let response: Response;
    try {
      response = await fetch(url, config);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Payload API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    if (method === "DELETE") {
      return {};
    }

    return response.json();
  }
}
