# Compatible encryption hardening

Stored values retain the existing `IV.tag.ciphertext` Base64 format and AES-256-GCM. Existing readers and records remain compatible. The backend now explicitly requires a 12-byte IV, a complete 16-byte authentication tag, canonical Base64 and exactly three fields. Plaintext is returned only after authentication succeeds.

No login, group password, registration, payment or client behavior changes. This release does not rotate keys or rewrite existing records. It does not encrypt additional database fields.

## Optional future key rotation

The current write key remains `DATA_ENCRYPTION_KEY`, with the existing owner-password fallback preserved for compatibility. For a planned rotation, `DATA_ENCRYPTION_PREVIOUS_KEYS` may contain a JSON array of up to five historical key strings. Those keys are used only to read records; new records use the current key. Invalid optional JSON is ignored so it cannot interrupt reads with the current key.

Keep keys only in the hosting provider's secret environment settings, never in Git, documentation, logs or frontend code. No environment change is required for this release.

Before any future key change, securely retain the exact previous key and configure it as a historical key. If the application previously used the owner password as its encryption key, that exact previous password is the historical key. Do not remove historical keys while records still depend on them. A new random key alone cannot decrypt old records. Test the rotation with non-production records before changing production secrets.

Tests: `node --test test/crypto.test.js test/integration.test.js test/tracking.test.js` from the backend directory.
