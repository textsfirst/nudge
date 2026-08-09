# Bundled skills

Skills that ship with Nudge. Each subdirectory here holding a SKILL.md is
seeded into DATA_DIR/skills/ at boot and kept up to date by the manifest sync
(src/bundled.ts) using Hermes-style rules: unmodified copies are upgraded in
place, edited or deleted copies are left alone forever.

This README is repo documentation only — it is never copied to the data
directory (only directories containing a SKILL.md are synced).

Layout per skill (agentskills.io-compatible):

    <lowercase-slug>/
      SKILL.md          # required; YAML frontmatter: name, description, version
      references/       # optional support files, loaded on demand
      examples/

Bump the frontmatter `version` when editing a bundled skill so installs that
kept the stock copy pick up the change on next boot.
