# Central platform owns open-world behavior

Open-world behavior and map processing are centralized in `open-world-platform` and `map-creator`; World directories contain only declarative definitions, geography, source locks, and demand interpretation. We chose a definition-and-artifact seam over shared utilities or per-World forks so fixes reach every World automatically, accepting that contracts must be versioned and existing identities must remain stable during migration.
