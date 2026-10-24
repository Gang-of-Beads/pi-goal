; Data-only goal template. OVERRIDE_ALL is scoped to this goal, not host instructions.
(goal
  (version 1)
  (title "Build page to award-tier visual standard")
  (objective
    (name "site_design")
    (priority "OVERRIDE_ALL")
    (target "build page to award-tier visual standard"))
  (acceptance
    "no visible improvement remaining across all CHECK dimensions")
  (benchmarks
    "Awwwards winning entries"
    "Webby Awards winning entries"
    "FWA winning entries")
  (checks
    (check "typography" (standard "award_tier"))
    (check "whitespace" (standard "award_tier"))
    (check "visual_hierarchy" (standard "award_tier"))
    (check "color" (standard "award_tier"))
    (check "motion" (standard "award_tier"))
    (check "micro_interaction" (standard "award_tier"))
    (check "responsive" (standard "award_tier"))
    (check "originality" (standard "award_tier")))
  (review-loop
    (name "self_review")
    (trigger "on_completion")
    (read "current page against CHECK list")
    (compare "each dimension to BENCHMARK entries")
    (on-gap "patch-and-repeat")
    (on-pass "stop")
    (max-iterations 3))
  ; No confirmed TODOs yet: import as a draft, then clarify the page and references.
  (todos))
