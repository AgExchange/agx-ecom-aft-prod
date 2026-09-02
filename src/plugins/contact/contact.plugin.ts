import { Controller, Post, Body, Req, Res, HttpStatus } from '@nestjs/common';
import { EventBus, RequestContextService, VendurePlugin, PluginCommonModule } from '@vendure/core';
import { ContactUsEvent, ContactInput } from '../../events';

@Controller('contact')
export class ContactController {
    constructor(
        private eventBus: EventBus,
        private requestContextService: RequestContextService,
    ) {}

    @Post()
    async submitContact(@Body() body: any, @Req() req: any, @Res() res: any) {
        const { firstName, lastName, email, phone, message } = body ?? {};
        if (!firstName || !lastName || !email || !phone || !message) {
            return res.status(HttpStatus.BAD_REQUEST).json({ success: false, message: 'All fields are required' });
        }
        try {
            const channelToken = req.headers?.['vendure-token'] as string | undefined;
            const ctx = await this.requestContextService.create({ apiType: 'shop', req, channelOrToken: channelToken });
            const recipientEmail =
                (ctx.channel as any)?.customFields?.infoEmail ||
                process.env.CONTACT_ADMIN_EMAIL ||
                'devstack@agxchange.co.za';
            const contact: ContactInput = { firstName, lastName, email, phone, message, submittedAt: new Date(), recipientEmail };
            await this.eventBus.publish(new ContactUsEvent(ctx, contact));
            return res.json({ success: true });
        } catch {
            return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ success: false, message: 'Failed to submit contact request' });
        }
    }
}

@VendurePlugin({
    compatibility: '^3.0.0',
    imports: [PluginCommonModule],
    controllers: [ContactController],
})
export class ContactPlugin {}
