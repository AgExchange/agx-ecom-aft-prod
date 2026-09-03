import { Injectable } from '@nestjs/common';
import { ConfigService, Order, RequestContext, RequestContextService, TransactionalConnection, User } from '@vendure/core';

/**
 * The webhook (BackURL) and redirect (RedirectURL) controllers have no customer session
 * to rely on — this directly replaces the old implementation's undocumented dependency
 * on ActiveOrderService session state (see plugin's HOW-IT-WORKS.md, "session-dependent
 * confirm step"). Builds a system RequestContext acting as the superadmin, following the
 * exact pattern documented on RequestContextService.create() for stand-alone scripts.
 */
@Injectable()
export class DpoRequestContextHelper {
  constructor(
    private connection: TransactionalConnection,
    private requestContextService: RequestContextService,
    private configService: ConfigService,
  ) {}

  async getSystemRequestContextForOrder(order: Order): Promise<RequestContext> {
    const { superadminCredentials } = this.configService.authOptions;
    const superAdminUser = await this.connection.rawConnection.getRepository(User).findOneOrFail({
      where: { identifier: superadminCredentials.identifier },
      relations: { roles: { channels: true } },
    });
    const channelToken = order.channels?.[0]?.token;
    return this.requestContextService.create({
      apiType: 'admin',
      user: superAdminUser,
      ...(channelToken ? { channelOrToken: channelToken } : {}),
    });
  }
}
