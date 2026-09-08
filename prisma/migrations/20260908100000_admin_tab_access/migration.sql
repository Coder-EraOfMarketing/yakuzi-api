-- Tab-level admin access.
--
-- Stamps every existing admin as an explicit Super Admin. This is a tidy-up,
-- not a prerequisite: any permissions value that is not in the new `v2:`
-- format is already READ as Super Admin by parseAdminGrants, so every admin
-- who exists today keeps exactly the access they had whether or not this
-- statement runs. Doing it here means the Admins screen shows the truth
-- instead of inferring it, and the old letter codes stop being load-bearing.
--
-- No schema change: admin_profiles.permissions is already a text column.

UPDATE "admin_profiles"
SET "permissions" = 'v2:super'
WHERE "permissions" IS NULL
   OR "permissions" NOT LIKE 'v2:%';
