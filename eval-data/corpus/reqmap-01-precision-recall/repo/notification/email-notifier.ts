/**
 * Customer email notifications (METIS requirement→code mapping eval fixture).
 */
export function sendOrderConfirmationEmail(customerEmail, order) {
  return { to: customerEmail, template: "order-confirmation", orderId: order.id };
}

export function sendRefundNotificationEmail(customerEmail, refund) {
  return { to: customerEmail, template: "refund-notification", orderId: refund.orderId };
}
