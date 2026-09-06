import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { ShiprocketService } from './shiprocket.service';
import { ShiprocketSyncService } from './shiprocket-sync.service';
import { CheckoutAbandonmentSweepService } from './checkout-abandonment-sweep.service';
import { InvoiceService } from './invoice.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoiceEmailService } from './invoice-email.service';
import { SellerOrderNotifierService } from './seller-order-notifier.service';
import { MailModule } from '../mail/mail.module';
import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';
import { IntegrationsModule } from '../integrations/integrations.module';

@Module({
  // ProductsModule for InventoryService (stock totals); IntegrationsModule so a
  // Yukizi sale can be pushed out to the seller's connected channels. Orders
  // depends on Integrations and never the reverse, so there is no cycle.
  imports: [MailModule, AuthModule, ProductsModule, IntegrationsModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    ShiprocketService,
    ShiprocketSyncService,
    CheckoutAbandonmentSweepService,
    InvoiceService,
    InvoicePdfService,
    InvoiceEmailService,
    SellerOrderNotifierService,
  ],
  exports: [
    OrdersService,
    ShiprocketService,
    InvoiceService,
    InvoicePdfService,
    InvoiceEmailService,
    SellerOrderNotifierService,
  ],
})
export class OrdersModule {}
