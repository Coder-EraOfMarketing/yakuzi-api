/**
 * Tab-level admin access control.
 *
 * Every admin holds one access level per admin-panel tab. The levels are
 * ordered, so a check is always "is the admin's level for this tab at least
 * the level this route needs".
 *
 * `partial` exists because most tabs have a handful of destructive or
 * financial actions (cancel an order, mark a settlement paid, delete a
 * listing) that a day-to-day operator should not be able to reach, while the
 * everyday actions on the same screen are harmless. Rather than asking whoever
 * grants access to tick twenty individual actions, each route declares whether
 * it is an everyday action (`partial`) or a risky one (`full`) - see
 * admin-route-map.ts.
 */
export const ACCESS_LEVELS = ['none', 'view', 'partial', 'full'] as const;

export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** Numeric rank so levels can be compared; higher includes everything lower. */
const LEVEL_RANK: Record<AccessLevel, number> = {
  none: 0,
  view: 1,
  partial: 2,
  full: 3,
};

export function levelAtLeast(held: AccessLevel, required: AccessLevel): boolean {
  return LEVEL_RANK[held] >= LEVEL_RANK[required];
}

export function isAccessLevel(value: unknown): value is AccessLevel {
  return typeof value === 'string' && (ACCESS_LEVELS as readonly string[]).includes(value);
}

/**
 * One key per tab in the admin sidebar. These strings are the storage format
 * (they end up inside admin_profiles.permissions) so they must not be renamed
 * without a data migration.
 *
 * The Dashboard is deliberately absent: it is every admin's landing page and
 * is always readable, so there is nothing to grant.
 */
export const TAB_KEYS = [
  // Catalog
  'products',
  'brands',
  'categories',
  'suggestions',
  // Orders & shipping
  'orders',
  'selfShip',
  // Customers
  'users',
  'reviews',
  'tickets',
  // Money
  'settlements',
  // Content & marketing
  'banners',
  'homepageSections',
  'marketing',
  'blogs',
  'seo',
  'chatbot',
  'notifications',
  // System
  'admins',
  'settings',
] as const;

export type TabKey = (typeof TAB_KEYS)[number];

export function isTabKey(value: unknown): value is TabKey {
  return typeof value === 'string' && (TAB_KEYS as readonly string[]).includes(value);
}

/**
 * Presentation grouping, served to the admin app so the grant screen and the
 * enforcement here can never drift apart. `partialMeans`/`fullMeans` are the
 * copy shown next to each group; they describe what admin-route-map.ts
 * actually enforces, so if a route's required level changes, change the copy
 * with it.
 */
export interface TabGroup {
  key: string;
  label: string;
  tabs: { key: TabKey; label: string }[];
  /** Tabs where `partial` is meaningless - the grant screen offers view/full only. */
  supportsPartial: boolean;
  partialMeans?: string;
  fullMeans: string;
}

export const TAB_GROUPS: TabGroup[] = [
  {
    key: 'catalog',
    label: 'Catalog',
    supportsPartial: true,
    partialMeans: 'Edit product details, activate or deactivate listings, edit brands and categories',
    fullMeans: 'Also approve or reject listings, delete, and bulk import',
    tabs: [
      { key: 'products', label: 'Products' },
      { key: 'brands', label: 'Brands' },
      { key: 'categories', label: 'Categories' },
      { key: 'suggestions', label: 'Suggestions' },
    ],
  },
  {
    key: 'orders',
    label: 'Orders & Shipping',
    supportsPartial: true,
    partialMeans: 'Update order status, print invoices, create shipments',
    fullMeans: 'Also cancel orders and confirm or reject payments',
    tabs: [
      { key: 'orders', label: 'Orders' },
      { key: 'selfShip', label: 'Self Ship' },
    ],
  },
  {
    key: 'customers',
    label: 'Customers',
    supportsPartial: true,
    partialMeans: 'Reply to tickets, edit customer details, change ticket status',
    fullMeans: 'Also block or delete users, approve or reject sellers, delete reviews',
    tabs: [
      { key: 'users', label: 'Users' },
      { key: 'reviews', label: 'Reviews' },
      { key: 'tickets', label: 'Tickets' },
    ],
  },
  {
    key: 'money',
    label: 'Money',
    supportsPartial: true,
    partialMeans: 'Sync and recalculate settlements',
    fullMeans: 'Also mark settlements paid',
    tabs: [{ key: 'settlements', label: 'Settlements' }],
  },
  {
    key: 'content',
    label: 'Content & Marketing',
    supportsPartial: true,
    partialMeans: 'Create and edit content, edit copy and metadata',
    fullMeans: 'Also publish or unpublish, delete, manage SEO redirects, and broadcast notifications',
    tabs: [
      { key: 'banners', label: 'HeroSection Image' },
      { key: 'homepageSections', label: 'Homepage Sections' },
      { key: 'marketing', label: 'Marketing' },
      { key: 'blogs', label: 'Blogs' },
      { key: 'seo', label: 'SEO' },
      { key: 'chatbot', label: 'AI Chatbot' },
      { key: 'notifications', label: 'Notifications' },
    ],
  },
  {
    key: 'system',
    label: 'System',
    // Nothing here is an "everyday" action, so partial is not offered.
    supportsPartial: false,
    fullMeans: 'Change platform settings. Granting admin access itself always requires Super Admin.',
    tabs: [
      { key: 'admins', label: 'Admins' },
      { key: 'settings', label: 'Settings' },
    ],
  },
];
