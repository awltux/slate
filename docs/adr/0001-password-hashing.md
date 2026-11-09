# ADR 0001 — Password hashing: scrypt now, argon2id when packaging allows

- **Status:** accepted
- **Date:** 2026-11-09
- **Context:** `AGENTS.md` §9 and `docs/ARCHITECTURE.md` §6.1 name argon2id as the target. Slate ships as a single
  TypeScript package with no native compilation step, and the first slice must install and run on a clean machine
  without a toolchain.
- **Decision:** hash passwords with `node:crypto` scrypt (`N=16384, r=8, p=1`, 16-byte salt, 64-byte output),
  stored self-describing as `scrypt$N$r$p$salt$hash`. Verification validates and bounds the parameters, and fails
  closed on a malformed or hostile stored hash rather than throwing inside the login path.
- **Consequences:** no native dependency, one fewer install failure mode, and parameters are upgradeable per user
  without a migration. scrypt at these parameters is a defensible choice, but argon2id remains the better default;
  moving to it is a drop-in change behind `hashPassword`/`verifyPassword` once a native build is acceptable.
- **Alternatives:** `argon2` npm package (native build, per-platform binaries — rejected for slice 1);
  `pbkdf2` (weaker against GPU attackers — rejected); bcrypt (no advantage here, also native).
