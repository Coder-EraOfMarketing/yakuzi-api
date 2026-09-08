import { Logger } from '@nestjs/common';
import {
  AccessLevel,
  TabKey,
  TAB_KEYS,
  isAccessLevel,
  isTabKey,
  levelAtLeast,
} from './admin-access.types';

const logger = new Logger('AdminGrants');

/**
 * Storage format for admin_profiles.permissions.
 *
 * Everything written from now on starts with `v2:`; the rest of the string is
 * either the literal `super` or a JSON object of tab -> level (levels equal to
 * `none` are omitted, so the common case stays short).
 *
 *   v2:super
 *   v2:{"orders":"partial","tickets":"full"}
 *
 * ANY value that does not start with `v2:` - including the empty string and
 * the old letter-code format ("1357x") - is read as Super Admin. That is
 * deliberate and load-bearing: every admin who existed before this feature
 * keeps exactly the access they had, without a data migration having to run
 * successfully first. The migration that stamps `v2:super` onto those rows is
 * a tidy-up, not a prerequisite.
 */
const V2_PREFIX = 'v2:';
const SUPER_VALUE = `${V2_PREFIX}super`;

export interface AdminGrants {
  /** Unrestricted access, including tabs that do not exist yet. */
  isSuper: boolean;
  /** Explicit level per tab. Absent tabs are `none`. */
  tabs: Partial<Record<TabKey, AccessLevel>>;
}

export const SUPER_GRANTS: AdminGrants = { isSuper: true, tabs: {} };

/**
 * Reads a stored permissions string. Never throws - a request-path parser that
 * throws would turn a bad row into a 500 on every endpoint that admin touches.
 */
export function parseAdminGrants(raw: string | null | undefined): AdminGrants {
  if (!raw || !raw.startsWith(V2_PREFIX)) {
    // Legacy / empty - see the note above.
    return SUPER_GRANTS;
  }

  const body = raw.slice(V2_PREFIX.length);
  if (body === 'super') return SUPER_GRANTS;

  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('grants payload is not an object');
    }

    const tabs: Partial<Record<TabKey, AccessLevel>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      // Unknown keys are skipped rather than fatal: a tab removed from the
      // product should not lock an admin out of the tabs that remain.
      if (isTabKey(key) && isAccessLevel(value) && value !== 'none') {
        tabs[key] = value;
      }
    }
    return { isSuper: false, tabs };
  } catch (error) {
    // A `v2:` prefix means someone deliberately restricted this admin. If the
    // payload cannot be read we fail CLOSED (no access) rather than falling
    // back to super, which would silently hand out everything.
    logger.error(
      `Unreadable admin grants string, denying all tab access: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
    return { isSuper: false, tabs: {} };
  }
}

export function serializeAdminGrants(grants: AdminGrants): string {
  if (grants.isSuper) return SUPER_VALUE;

  const tabs: Record<string, AccessLevel> = {};
  for (const key of TAB_KEYS) {
    const level = grants.tabs[key];
    if (level && level !== 'none') tabs[key] = level;
  }
  return `${V2_PREFIX}${JSON.stringify(tabs)}`;
}

export function levelForTab(grants: AdminGrants, tab: TabKey): AccessLevel {
  if (grants.isSuper) return 'full';
  return grants.tabs[tab] ?? 'none';
}

export function grantsAllow(
  grants: AdminGrants,
  tab: TabKey,
  required: AccessLevel,
): boolean {
  return levelAtLeast(levelForTab(grants, tab), required);
}

/** True if the admin can do anything beyond reading, on any tab at all. */
export function hasAnyWriteAccess(grants: AdminGrants): boolean {
  if (grants.isSuper) return true;
  return Object.values(grants.tabs).some((level) => levelAtLeast(level, 'partial'));
}

/**
 * Validates and normalises what the admin app sends when granting access.
 * Unlike parseAdminGrants this is strict - a typo in a tab key or level is a
 * mistake by the caller and should surface as a 400, not be silently dropped
 * into a grant that does less than the person intended.
 */
export function grantsFromInput(input: {
  isSuper?: boolean;
  tabs?: Record<string, unknown>;
}): { grants: AdminGrants; errors: string[] } {
  const errors: string[] = [];

  if (input.isSuper) {
    return { grants: SUPER_GRANTS, errors };
  }

  const tabs: Partial<Record<TabKey, AccessLevel>> = {};
  for (const [key, value] of Object.entries(input.tabs ?? {})) {
    if (!isTabKey(key)) {
      errors.push(`Unknown tab "${key}"`);
      continue;
    }
    if (!isAccessLevel(value)) {
      errors.push(`Invalid access level "${String(value)}" for tab "${key}"`);
      continue;
    }
    if (value !== 'none') tabs[key] = value;
  }

  return { grants: { isSuper: false, tabs }, errors };
}
