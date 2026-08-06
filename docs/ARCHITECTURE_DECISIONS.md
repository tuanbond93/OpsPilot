# OpsPilot Architecture Decisions

## ADR: Project Operational Memory

**Title**: Project Operational Memory

**Decision**: Introduce permanent documentation files `ROADMAP.md` and `KNOWN_ISSUES.md` to capture the project’s roadmap and verified issues.

**Purpose**:
- Prevent repeated work by having a single source of truth for project direction.
- Track verified issues and their status.
- Ensure all future implementation planning reads the full set of project memory artifacts before proceeding.

**Consequences**:
- All future implementation planning must read the following files before producing any implementation plan:
  - `PROJECT_STATUS.md`
  - `ARCHITECTURE_DECISIONS.md`
  - `ROADMAP.md`
  - `KNOWN_ISSUES.md`
  - latest sprint‑history file
- Teams must keep these files up‑to‑date after any change.
- Automated tooling can rely on these files for gating implementation work.
