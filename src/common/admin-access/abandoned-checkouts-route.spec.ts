import { resolveAdminRoute } from './admin-route-map';

describe('admin route map — abandoned checkouts', () => {
  it('maps the list to the Orders tab at view level', () => {
    // Unmapped admin routes resolve to `deny`, which only ever bites a
    // RESTRICTED admin (super admins never reach the fallback) — so a missing
    // rule would pass every super-admin test and still 403 the whole team.
    expect(resolveAdminRoute('GET', '/api/admin/abandoned-checkouts')).toEqual({
      kind: 'tab',
      tab: 'orders',
      required: 'view',
    });
  });

  it('tolerates a query string', () => {
    expect(
      resolveAdminRoute('GET', '/api/admin/abandoned-checkouts?state=all&page=2'),
    ).toMatchObject({ kind: 'tab', tab: 'orders' });
  });

  it('does not accidentally open sibling paths', () => {
    // The pattern is anchored: a made-up sub-path must still be denied.
    expect(resolveAdminRoute('GET', '/api/admin/abandoned-checkouts/export')).toEqual({
      kind: 'deny',
    });
  });
});
