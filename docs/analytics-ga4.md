# StreamVault GA4 Tracking

Measurement ID: `G-HBLXEBQB7H`

This app sends GA4 events through `gtag` and tracks SPA route changes manually.

## 1) Create GA4 Event-Scoped Custom Dimensions

In GA4 Admin:
`Admin -> Data display -> Custom definitions -> Create custom dimensions`

Create these event-scoped dimensions:

1. Dimension name: `Page Group`
Event parameter: `page_group`
2. Dimension name: `Wallet Type`
Event parameter: `wallet_type`
3. Dimension name: `Address Prefix`
Event parameter: `address_prefix`
4. Dimension name: `Publish Tier`
Event parameter: `tier`
5. Dimension name: `Use Turbo`
Event parameter: `use_turbo`
6. Dimension name: `Turbo Token`
Event parameter: `turbo_token`
7. Dimension name: `Connection Source`
Event parameter: `source`
8. Dimension name: `Failure Reason`
Event parameter: `reason`
9. Dimension name: `Copy Type`
Event parameter: `copy_type`
10. Dimension name: `Top Up Amount USD`
Event parameter: `amount_usd`

## 2) Create GA4 User-Scoped Custom Dimensions

In GA4 Admin:
`Admin -> Data display -> Custom definitions -> Create custom dimensions`

Create these user-scoped dimensions (User property):

1. Dimension name: `User Wallet Type`
User property: `wallet_type`
2. Dimension name: `Wallet Connected`
User property: `wallet_connected`
3. Dimension name: `Wallet Address Prefix`
User property: `wallet_address_prefix`
4. Dimension name: `Profile Connected`
User property: `profile_connected`
5. Dimension name: `Profile ID Prefix`
User property: `profile_id_prefix`
6. Dimension name: `Profile Handle`
User property: `profile_handle`
7. Dimension name: `Profile Has Avatar`
User property: `profile_has_avatar`
8. Dimension name: `Profile AO Token Count`
User property: `profile_ao_token_count`
9. Dimension name: `Profile Atomic Asset Count`
User property: `profile_atomic_asset_count`

## 3) Verification

1. Open GA4 Realtime view.
2. Open the app and navigate between routes.
3. Confirm `page_view` events arrive with `page_group`.
4. Trigger wallet and publish actions.
5. Confirm wallet/publish events and parameters appear.

Note: New custom dimensions can take time to populate in standard reports after creation.
