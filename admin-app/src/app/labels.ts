// What the admin sees for each stored value. The keys are the enums in mongo/*.validator.json,
// the same as ORDER_STATUS_LABELS in the site's app.js.

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending_payment: 'Awaiting payment',
  paid: 'Paid',
  shipped: 'Shipped',
  cancelled: 'Cancelled',
};

export const MESSAGE_STATUS_LABELS: Record<string, string> = {
  new: 'New',
  answered: 'Answered',
  closed: 'Closed',
};

export const TOPIC_LABELS: Record<string, string> = {
  order: 'Order question',
  coffee: 'Coffee question',
  account: 'Account help',
  feedback: 'Feedback',
  other: 'Other',
};

export const ROLE_LABELS: Record<string, string> = {
  customer: 'Customer',
  admin: 'Administrator',
};

// { value, label } pairs in the enum's order, for <select> options.
export function options(labels: Record<string, string>) {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}
