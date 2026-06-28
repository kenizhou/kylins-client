## Summary

<!-- What does this PR change and why? -->

## Checklist

- [ ] `cargo check` passes
- [ ] `cargo test` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `npx vitest run` passes
- [ ] No new `any` or `@ts-ignore` added
- [ ] Schema changes use a new migration (never edit an existing one)
- [ ] Secrets go through `services/crypto.ts` → Rust `encrypt_secret` (never plaintext in SQLite)
