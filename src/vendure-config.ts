import 'dotenv/config';
import path from 'path';
import {
    dummyPaymentHandler,
    DefaultJobQueuePlugin,
    DefaultSchedulerPlugin,
    DefaultSearchPlugin,
    VendureConfig,
} from '@vendure/core';
import {
    defaultEmailHandlers,
    EmailEventListener,
    EmailPlugin,
    FileBasedTemplateLoader,
} from '@vendure/email-plugin';
import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import { DashboardPlugin } from '@vendure/dashboard/plugin';
import { GraphiqlPlugin } from '@vendure/graphiql-plugin';
import { customFields } from './custom-fields';
import { ShippingByWeightPlugin } from './plugins/shipping-by-weight/shipping-by-weight.plugin';
import { ProductInfoPlugin } from './plugins/product-info/product-info.plugin';
import { OrderMetadataUiPlugin } from './plugins/order-metadata-ui/order-metadata-ui.plugin';
import { ContactPlugin } from './plugins/contact/contact.plugin';
import { ContactUsEvent } from './events';
import { CmsPlugin } from './plugins/cms/cms.plugin';
import { PimSyncPlugin } from './plugins/pim-sync';
import { QuotePlugin } from './plugins/quote-plugin';
import { MultivendorPlugin } from './plugins/multivendor-plugin';
import { PayFastPlugin } from './plugins/payfast-plugin';
import { DsvShippingPlugin } from './plugins/dsv-shipping-plugin';
import { DsvSadcPlugin } from './plugins/dsv-sadc-plugin';
import { DsvSadcUiPlugin } from './plugins/dsv-sadc-ui/dsv-sadc-ui.plugin';
import { DpoPayPlugin } from './plugins/dpo-plugin';

const IS_DEV = process.env.APP_ENV === 'dev';
// PORT wins because hosting platforms inject it into the environment at runtime, and that
// must take precedence over any value baked into the .env file at scaffold time.
const serverPort = +process.env.PORT || +process.env.VENDURE_SERVER_PORT || 3000;

// ---------------------------------------------------------------------------
// Contact Us — email handler for the event published by ContactPlugin.
//
// No plugin is required to listen: EmailPlugin subscribes to any VendureEvent
// via eventBus.ofType(handler.event). The recipient is resolved by the
// controller before publishing and carried on the event itself, so this handler
// does not need to re-read the channel.
//
// Template: static/email/templates/contact-admin-notification/body.hbs
// ---------------------------------------------------------------------------
const contactAdminNotificationHandler = new EmailEventListener('contact-admin-notification')
    .on(ContactUsEvent)
    .setRecipient(event => event.contact.recipientEmail)
    .setFrom('{{ fromAddress }}')
    .setSubject('New Contact Request from {{ contact.firstName }} {{ contact.lastName }}')
    .setTemplateVars(event => ({ contact: event.contact }));

export const config: VendureConfig = {
    apiOptions: {
        port: serverPort,
        adminApiPath: 'admin-api',
        shopApiPath: 'shop-api',
        trustProxy: IS_DEV ? false : 1,
        // The following options are useful in development mode,
        // but are best turned off for production for security
        // reasons.
        ...(IS_DEV ? {
            adminApiDebug: true,
            shopApiDebug: true,
        } : {}),
    },
    authOptions: {
        tokenMethod: ['bearer', 'cookie'],
        superadminCredentials: {
            identifier: process.env.SUPERADMIN_USERNAME,
            password: process.env.SUPERADMIN_PASSWORD,
        },
        cookieOptions: {
          secret: process.env.COOKIE_SECRET,
        },
    },
    dbConnectionOptions: {
        type: 'postgres',
        // See the README.md "Migrations" section for an explanation of
        // the `synchronize` and `migrations` options.
        synchronize: false,
        migrations: [path.join(__dirname, './migrations/*.+(js|ts)')],
        logging: false,
        database: process.env.DB_NAME,
        schema: process.env.DB_SCHEMA,
        host: process.env.DB_HOST,
        port: +process.env.DB_PORT,
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
    },
    paymentOptions: {
        paymentMethodHandlers: [dummyPaymentHandler],
    },
    // When adding or altering custom field definitions, the database will
    // need to be updated. See the "Migrations" section in README.md.
    customFields,
    plugins: [
        GraphiqlPlugin.init(),
        AssetServerPlugin.init({
            route: 'assets',
            assetUploadDir: path.join(__dirname, '../static/assets'),
            // For local dev, the correct value for assetUrlPrefix should
            // be guessed correctly, but for production it will usually need
            // to be set manually to match your production url.
            assetUrlPrefix: IS_DEV ? undefined : 'https://www.my-shop.com/assets/',
        }),
        DefaultSchedulerPlugin.init(),
        DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true }),
        DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true }),
        EmailPlugin.init({
            devMode: true,
            outputPath: path.join(__dirname, '../static/email/test-emails'),
            route: 'mailbox',
            handlers: [...defaultEmailHandlers, contactAdminNotificationHandler],
            templateLoader: new FileBasedTemplateLoader(path.join(__dirname, '../static/email/templates')),
            globalTemplateVars: {
                // The following variables will change depending on your storefront implementation.
                // Here we are assuming a storefront running at http://localhost:8080.
                fromAddress: '"example" <noreply@example.com>',
                verifyEmailAddressUrl: 'http://localhost:8080/verify',
                passwordResetUrl: 'http://localhost:8080/password-reset',
                changeEmailAddressUrl: 'http://localhost:8080/verify-email-address-change'
            },
        }),
        DashboardPlugin.init({
            route: 'dashboard',
            appDir: IS_DEV
                ? path.join(__dirname, '../dist/dashboard')
                : path.join(__dirname, 'dashboard'),
        }),
        ShippingByWeightPlugin.init({}),
        ProductInfoPlugin.init({}),
        // Registered bare (no .init()) — neither takes options.
        OrderMetadataUiPlugin,
        ContactPlugin,
        // Talks to a Payload CMS instance. Without PAYLOAD_API_URL/KEY the plugin
        // still loads and its scheduled task registers — outbound calls fail at
        // runtime only.
        CmsPlugin.init({
            cmsApiUrl: process.env.PAYLOAD_API_URL,
            cmsApiKey: process.env.PAYLOAD_API_KEY,
        }),
        // Talks to AtroPIM. Same caveat as CmsPlugin: no credentials in local dev,
        // so sync operations will fail until the VM deployment supplies them.
        PimSyncPlugin.init({
            pimUrl: process.env.PIM_URL!,
            pimUser: process.env.PIM_USER!,
            pimPassword: process.env.PIM_PASSWORD!,
            partTypeGroupCode: process.env.PIM_PART_TYPE_GROUP_CODE,
            pageSize: process.env.PIM_PAGE_SIZE ? parseInt(process.env.PIM_PAGE_SIZE) : undefined,
            fetchTimeoutMs: process.env.PIM_FETCH_TIMEOUT_MS ? parseInt(process.env.PIM_FETCH_TIMEOUT_MS) : undefined,
            imageFetchTimeoutMs: process.env.PIM_IMAGE_TIMEOUT_MS ? parseInt(process.env.PIM_IMAGE_TIMEOUT_MS) : undefined,
            statusFilePath: process.env.PIM_SYNC_STATUS_FILE,
            shopApiWarmupUrl: process.env.PIM_SHOP_API_WARMUP_URL,
            warmupDelayMs: process.env.PIM_WARMUP_DELAY_MS ? parseInt(process.env.PIM_WARMUP_DELAY_MS) : undefined,
        }),
        QuotePlugin.init({
            defaultQuoteValidityDays: process.env.QUOTE_VALIDITY_DAYS
                ? parseInt(process.env.QUOTE_VALIDITY_DAYS)
                : 7,
            quoteReferencePrefix: process.env.QUOTE_REFERENCE_PREFIX || 'Q',
        }),
        MultivendorPlugin.init(),
        // PayFast — South African payments. Per-PaymentMethod credentials (merchantId,
        // merchantKey, passphrase, sandbox) are configured in the dashboard as handler
        // args, so only the public host is needed here to build the ITN notify URL.
        PayFastPlugin.init({ vendureHost: process.env.API_HOST! }),
        // ── DSV ────────────────────────────────────────────────────────────
        // Both DSV plugins THROW at startup on missing config (validateOptions in
        // dsv-shipping-plugin/index.ts, and dsv-sadc.plugin.ts's own checks), so
        // .env carries obvious placeholders locally. `features` and `units` are
        // hardcoded here rather than env-driven, matching agx-stores exactly.
        DsvShippingPlugin.init({
            auth: {
                clientEmail: process.env.DSV_CLIENT_EMAIL!,
                clientPassword: process.env.DSV_CLIENT_PASSWORD!,
                accessTokenKey: process.env.DSV_ACCESS_TOKEN_KEY!,
                apiBaseUrl: process.env.DSV_API_BASE_URL!,
                tokenEndpoint: process.env.DSV_TOKEN_ENDPOINT!,
            },
            subscriptionKeys: {
                quote: process.env.DSV_QUOTE_API_KEY!,
                booking: process.env.DSV_BOOKING_API_KEY!,
            },
            apiEndpoints: {
                quote: process.env.DSV_QUOTE_ENDPOINT!,
                booking: process.env.DSV_BOOKING_ENDPOINT!,
            },
            testMdmAccount: process.env.DSV_TEST_MDM!,
            bookingDefaults: {
                product: process.env.DSV_DEFAULT_TRANSPORT_MODE! as 'Road',
                packageType: process.env.DSV_DEFAULT_PACKAGE_TYPE! as any,
                stackable: process.env.DSV_DEFAULT_STACKABLE! as 'STACKABLE',
                incoterms: {
                    code: process.env.DSV_DEFAULT_INCOTERMS_CODE!,
                    location: process.env.DSV_DEFAULT_INCOTERMS_LOCATION!,
                },
                pickupTime: {
                    start: process.env.DSV_DEFAULT_PICKUP_START!,
                    end: process.env.DSV_DEFAULT_PICKUP_END!,
                    daysFromNow: parseInt(process.env.DSV_DEFAULT_PICKUP_DAYS_FROM_NOW || '1'),
                },
                deliveryTime: {
                    start: process.env.DSV_DEFAULT_DELIVERY_START!,
                    end: process.env.DSV_DEFAULT_DELIVERY_END!,
                    daysFromNow: parseInt(process.env.DSV_DEFAULT_DELIVERY_DAYS_FROM_NOW || '3'),
                },
                units: {
                    dimension: 'CM',
                    weight: 'KG',
                    volume: 'M3',
                    loadingSpace: 'LM',
                    temperature: 'C',
                },
                insurance: {
                    enabled: process.env.DSV_INSURANCE_ENABLED === 'true',
                    category: process.env.DSV_INSURANCE_CATEGORY || 'STD',
                    currency: process.env.DSV_INSURANCE_CURRENCY || 'ZAR',
                },
            },
            features: {
                quote: true,
                booking: true,
                tracking: false,
                webhooks: false,
                labels: false,
            },
            quoteCacheTTL: parseInt(process.env.DSV_QUOTE_CACHE_TTL || '300'),
            debugMode: process.env.DSV_DEBUG_MODE === 'true',
        }),
        // DSV SADC (ClientZone SADC — SOAP/XML; ZA/BW/LS/NA/SZ).
        // NOTE: the loading address below is hardcoded business data, carried over
        // verbatim from agx-stores. It should probably move to env before the VM
        // deploy — see docs/plugins/dsv-sadc-plugin.md.
        DsvSadcPlugin.init({
            apiUrl: process.env.DSV_SADC_API_URL!,
            username: process.env.DSV_SADC_USERNAME,
            password: process.env.DSV_SADC_PASSWORD,
            ediCustomerNumber: process.env.DSV_SADC_CUSTOMER_NUMBER!,
            ediCustomerDepartment: process.env.DSV_SADC_CUSTOMER_DEPT!,
            shipperPrefix: process.env.DSV_SADC_SHIPPER_PREFIX!,
            relationNumber: process.env.DSV_SADC_RELATION_NUMBER!,
            warehouseSearchName: process.env.DSV_SADC_WAREHOUSE_SEARCH_NAME!,
            loadingAddress: {
                nameLine1:       'Landboupart',
                addressLine1:    '12 Wrench Road',
                cityName:        'Kempton Park',
                cityName2:       'Isando',
                postalCode:      '1600',
                countryCode:     'ZA',
                contactPerson:   'Customer Services',
                email:           'info@landboupart.com',
                telephoneNumber: '011 966 9200',
                xCoordinate:     '28.219288',
                yCoordinate:     '-26.137998',
            },
            defaults: {
                serviceLevel: 'eco',
                loadingTime: '08:00:00',
                loadingDaysFromNow: 1,
            },
            features: {
                labels: true,
                cancel: true,
                webhooks: true,
            },
            webhook: {
                path: '/shipping/dsv-sadc/webhook',
            },
            debugMode: process.env.DSV_SADC_DEBUG === 'true',
        }),
        // Dashboard-only: renders DSV_SADC_TRACKING history entries and labels.
        // Useless without DsvSadcPlugin above, which is what creates those entries.
        DsvSadcUiPlugin,
        // DPO — payments outside South Africa, and RSA as a fallback.
        // validateDpoPluginOptions() runs inside configuration() and THROWS on a
        // missing companyToken / serviceType / redirectUrl / backUrl, so .env must
        // be populated for the server to start.
        DpoPayPlugin.init({
            companyToken: process.env.DPO_COMPANY_TOKEN!,
            serviceType:  process.env.DPO_SERVICE_TYPE!,
            redirectUrl:  process.env.DPO_REDIRECT_URL!,
            backUrl:      process.env.DPO_BACK_URL!,
            apiUrlV6:     process.env.DPO_API_URL,
            apiUrlV7:     process.env.DPO_API_URL_V7,
            storefrontConfirmationUrlTemplate: process.env.DPO_STOREFRONT_CONFIRMATION_URL,
            useSandbox:   process.env.DPO_USE_SANDBOX !== 'false',
        }),
    ],
};
