import { Module } from '@nestjs/common';
import {
  AdminController,
  PublicConfigController,
  PublicStatsController,
} from './admin.controller';
import { AdminService } from './admin.service';
import { PlatformStatsService } from './platform-stats.service';
import { PayoutEmailService } from '../settlements/payout-email.service';
import { CommissionInvoicePdfService } from '../settlements/commission-invoice-pdf.service';
import { CommissionInvoiceService } from '../settlements/commission-invoice.service';
import { OrdersModule } from '../orders/orders.module';
import { SellersModule } from '../sellers/sellers.module';
import { MailModule } from '../mail/mail.module';
import { ProductsModule } from '../products/products.module';
import { InvoicingModule } from '../invoicing/invoicing.module';
import { SeoModule } from '../seo/seo.module';

@Module({
  imports: [
    OrdersModule,
    SellersModule,
    MailModule,
    ProductsModule,
    InvoicingModule,
    SeoModule,
  ],
  controllers: [AdminController, PublicConfigController, PublicStatsController],
  providers: [
    AdminService,
    PlatformStatsService,
    PayoutEmailService,
    CommissionInvoiceService,
    CommissionInvoicePdfService,
  ],
})
export class AdminModule {}

