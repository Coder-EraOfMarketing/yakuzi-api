import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a notification for a user (called from other modules).
   */
  async createNotification(userId: string, message: string) {
    const notification = await this.prisma.notification.create({
      data: { userId, message },
    });
    this.logger.log(`Notification created for user ${userId}: ${message}`);
    return notification;
  }

  /**
   * Notify buyer when order is placed.
   */
  async notifyOrderPlaced(buyerId: string, orderId: string) {
    return this.createNotification(
      buyerId,
      `Your order ${orderId.slice(0, 8)}… has been placed successfully.`,
    );
  }

  /**
   * Notify buyer when order is accepted by seller.
   */
  async notifyOrderAccepted(buyerId: string, orderId: string) {
    return this.createNotification(
      buyerId,
      `Your order ${orderId.slice(0, 8)}… has been accepted by the seller.`,
    );
  }

  /**
   * Notify buyer when payment is confirmed by admin.
   */
  async notifyPaymentConfirmed(
    buyerId: string,
    orderId: string,
    amount: number,
  ) {
    return this.createNotification(
      buyerId,
      `Payment of ₹${amount.toFixed(2)} for order ${orderId.slice(0, 8)}… has been confirmed.`,
    );
  }

  /**
   * Notify buyer when the seller dispatches the order.
   */
  async notifyOrderDispatched(buyerId: string, orderId: string) {
    return this.createNotification(
      buyerId,
      `Your order ${orderId.slice(0, 8)}… has been dispatched by the seller.`,
    );
  }

  /**
   * Notify buyer when order is shipped.
   */
  async notifyOrderShipped(buyerId: string, orderId: string) {
    return this.createNotification(
      buyerId,
      `Your order ${orderId.slice(0, 8)}… has been shipped.`,
    );
  }

  /**
   * Notify buyer when order is out for delivery.
   */
  async notifyOrderOutForDelivery(buyerId: string, orderId: string) {
    return this.createNotification(
      buyerId,
      `Your order ${orderId.slice(0, 8)}… is out for delivery.`,
    );
  }

  /**
   * Notify buyer when order is delivered.
   */
  async notifyOrderDelivered(buyerId: string, orderId: string) {
    return this.createNotification(
      buyerId,
      `Your order ${orderId.slice(0, 8)}… has been delivered.`,
    );
  }

  /**
   * Notify a buyer that their order was cancelled, and why.
   *
   * The reason is the whole point: an order that changes state under someone
   * with no explanation becomes a support ticket.
   */
  async notifyOrderCancelled(buyerId: string, orderId: string, reason?: string) {
    const why = reason?.trim() ? ` Reason: ${reason.trim()}` : '';
    return this.createNotification(
      buyerId,
      `Your order ${orderId.slice(0, 8)}… has been cancelled.${why}`,
    );
  }

  /**
   * Notify seller when they receive a new order.
   */
  async notifySellerNewOrder(sellerUserId: string, orderId: string) {
    return this.createNotification(
      sellerUserId,
      `You have a new order ${orderId.slice(0, 8)}… to process.`,
    );
  }

  /**
   * Notify seller when settlement is paid out.
   */
  async notifySettlementPaid(sellerUserId: string, amount: number) {
    return this.createNotification(
      sellerUserId,
      `Settlement of ₹${amount.toFixed(2)} has been processed to your account.`,
    );
  }

  /**
   * Notify user when their account/KYC is verified.
   */
  async notifyUserVerified(userId: string, role: string) {
    const roleName = role.toLowerCase();
    return this.createNotification(
      userId,
      `Congratulations! Your ${roleName} profile has been verified. You can now access all features.`,
    );
  }

  /**
   * Notify user when their account/KYC is rejected.
   */
  async notifyUserRejected(userId: string, role: string, reason?: string) {
    const roleName = role.toLowerCase();
    return this.createNotification(
      userId,
      `Your ${roleName} profile verification was not successful.${reason ? ` Reason: ${reason}` : ' Please review your documents and resubmit.'}`,
    );
  }

  /**
   * Get all notifications for a user.
   */
  async getUserNotifications(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        message: true,
        isRead: true,
        createdAt: true,
      },
    });
  }

  /**
   * Mark a notification as read.
   */
  async markAsRead(userId: string, notificationId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    if (notification.userId !== userId) {
      throw new NotFoundException('Notification not found');
    }

    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });
  }

  /**
   * Mark all notifications as read for a user.
   */
  async markAllAsRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
  }

  /**
   * Delete a notification.
   */
  async deleteNotification(userId: string, notificationId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    if (notification.userId !== userId) {
      throw new NotFoundException('Notification not found');
    }

    return this.prisma.notification.delete({
      where: { id: notificationId },
    });
  }
}
