# Environmental impact telemetry

AgentGlass stores water and energy estimates beside existing token and USD
telemetry. It never replaces those fields. Estimates describe profile,
boundary, region, and source. They are not exact request measurements unless a
local runtime supplied measured energy.

## Meaning and display

Water **consumption** is water removed from its immediate watershed or made
unavailable for near-term reuse. Water **withdrawal** is water taken from a
source before some portion returns. AgentGlass stores and aggregates them
separately.

Settings → Environmental impact offers Cost, Tokens, Water, Cost + water,
Tokens + water, and All metrics. Cost remains default. Water always carries an
inline boundary. `water unknown` means insufficient evidence, not zero.

Units are automatic, mL, L, US gallons, and 16-US-fl-oz bottles:

```text
1 US gallon = 3.785411784 L
1 bottle = 473.176473 mL
```

Bottle text is only a volume analogy. It makes no claim that bottles were
manufactured, bought, discarded, or avoided. Public values use two or three
significant digits.

## Boundaries

- **Scope 1**: direct onsite water, such as datacenter cooling.
- **Scope 2**: indirect water associated with purchased electricity.
- **Scope 3**: lifecycle effects explicitly included by a source.
- **Unknown scope**: published number lacks enough methodology for assignment.

Direct, operational, lifecycle, and unknown-boundary values are not
interchangeable. Source-native mode preserves published boundaries. It disables
combined water charts when scopes or statistical bases conflict. Lifecycle mode
stays off by default. Training and hardware manufacturing are never added
silently.

## Measured, modeled, and reported

A measured value comes from an instrumented observation or provider measurement
study. A modeled value combines assumptions, benchmarks, or regional factors.
A provider-reported value may lack independent verification. Source details
show statistical basis, method, confidence, region, profile version, and link.

Estimates vary with model, workload, response length, hardware, utilization,
cooling, power source, season, region, PUE, WUE, and accounting boundary. No
defensible universal water-per-token constant exists. AgentGlass matches
versioned provider/model/workload profiles. It never derives water from USD or
silently borrows another provider's profile.

## Built-in profiles

### Google Gemini Apps

The direct profile uses Google's median Gemini Apps text prompt: 0.26 mL direct
water and 0.24 Wh facility energy. Scope 2 and lifecycle effects are excluded.

The US operational scenario keeps 0.26 mL Scope 1 and derives 1.0848 mL Scope 2
from 0.24 Wh × 4.52 L/kWh. PUE is not applied again because disclosed energy
already includes facility overhead.

Source: [Google, Measuring the environmental impact of AI inference](https://cloud.google.com/blog/products/infrastructure/measuring-the-environmental-impact-of-ai-inference/).

### OpenAI average query

The associated average-query statement is stored as 0.32176 mL water and
0.34 Wh. Model mix, response length, region, PUE, methodology, and boundary are
undisclosed. AgentGlass assigns no scope and never adds separate electricity
water because that could double count.

Source: [Sam Altman, The Gentle Singularity](https://blog.samaltman.com/the-gentle-singularity).

The disabled `ren-reported-gpt4-revision` profile is a tier-3 report of a
private clarification. It is not labeled a peer-reviewed correction, published
erratum, or retraction. Users must select it explicitly as a proxy.

### Mistral Large 2

The profile stores a modeled 45 mL lifecycle result for a 400-output-token
response. It includes upstream effects and cannot be treated as operational.

Source: [Mistral, Our contribution to a global environmental standard for AI](https://mistral.ai/news/our-contribution-to-a-global-environmental-standard-for-ai/).

### ML.ENERGY

Energy-only profiles remain separate from complete water profiles:

- average text conversation: 184 J GPU energy
- average problem solving: 4,625 J GPU energy
- Qwen 3 32B text: 95 J GPU energy
- Qwen 3 32B problem solving: 2,192 J GPU energy

GPU-only energy is a lower bound. It omits host and facility overhead.
AgentGlass does not multiply it by a facility factor unless an explicit
host/facility model is supplied.

Source: [ML.ENERGY leaderboard methodology](https://ml.energy/blog/measurement/energy/diagnosing-inference-energy-consumption-with-the-mlenergy-leaderboard-v30/).

## Local energy

Events may provide:

```json
{
  "runtime_energy": {
    "boundary": "wall",
    "wh_central": 10,
    "wh_low": 9,
    "wh_high": 11,
    "region": "user-defined",
    "grid_factor_l_per_kwh": 4.35
  }
}
```

Measured wall energy takes precedence over provider profiles:

```text
Scope 2 = wall kWh × regional grid-water factor L/kWh
```

Wall energy already covers the local device. AgentGlass adds neither PUE nor a
datacenter cooling WUE.

```text
IT energy:
Scope 1 = IT kWh × onsite WUE
Scope 2 = IT kWh × PUE × grid factor

Facility energy:
Scope 2 = facility kWh × grid factor
```

PUE is never applied twice. GPU energy remains a lower bound unless
`host_overhead_factor` explicitly expands it to a host/facility model.

## Regional factors

Built-in LBNL scenario factors:

- US datacenter electricity mix: 4.52 L/kWh.
- Overall US electricity: 4.35 L/kWh.

These are national averages, not local measurements. Users select the factor
in Settings. Source: [LBNL, 2024 United States Data Center Energy Usage Report](https://doi.org/10.71468/P1WC7Q).

Microsoft fleet values remain reference-only:

- FY24: WUE 0.30 L/kWh; PUE 1.16.
- FY25: WUE 0.27 L/kWh; PUE 1.17.

AgentGlass never applies them to unrelated providers. Source:
[Microsoft datacenter efficiency](https://datacenters.microsoft.com/sustainability/efficiency/).

## Profiles and versioning

`impact_profiles` stores source metadata. `event_impacts` stores exact profile
ID and version. New versions do not rewrite history. Duplicate built-in
ID/version pairs are rejected.

Set `AGENTGLASS_IMPACT_PROFILES` to a JSON file containing complete
`ImpactProfile` objects. Every profile requires provider, model matches,
workload class, statistic, water type, known scopes or explicit unknown scope,
energy boundary, region, source metadata, version, and non-negative nullable
values. Invalid registries produce an `[impact]` startup warning.

Restart after registry changes. Settings change new estimates and current
aggregation, not stored historical profile/version references.

## Cumulative transcripts and attribution

Stable message keys prevent repeated cumulative snapshots from inserting the
same message twice. Each message resolves its own model and profile. A
mixed-model transcript is never recalculated using only its latest model.

Aggregations expose model requests, user turn/request groups, main agents,
individual subagents, complete sessions, providers, models, and timeline
buckets. A user turn can contain several model requests and is not called one
query. Missing agent IDs remain attributed to `Main agent`. Parent session
totals still include the complete event stream.

## Budgets

Daily, weekly, monthly, dashboard-window, and custom-period budgets are optional
user-defined thresholds. AgentGlass defines no recommended or moral allowance.

```text
remaining central = max(0, budget - used central)
remaining low     = max(0, budget - used high)
remaining high    = max(0, budget - used low)
```

Unknown impact marks budget state incomplete.

## API

`GET /impact?window=<milliseconds>` returns totals, model/provider/session/
agent/request-group breakdowns, timeline, profiles, regional factors, settings,
and budgets. Optional filters: `provider`, `model`, `agent`, and
`water_type=consumption|withdrawal`. `agent=main` selects missing agent IDs.
Queries use the same project/worktree scope as existing analytics. Results use
a one-second cache invalidated on new impact rows.

`GET /impact/profiles` lists profiles. `GET /impact/settings` reads settings.
`POST /impact/settings` applies a partial settings object.

## Historical cached-token limitation

New OpenAI events normalize cached input from nested Responses and Chat
Completions usage objects. Existing rows are not rewritten. Safe repair is
impossible when original payloads are absent or malformed, so no invented
backfill runs.

## Anthropic quota limitation

Anthropic quota remains separate from context, tokens, cost, and impact. It
uses local Claude Code OAuth credentials and an unofficial Anthropic endpoint.
That endpoint may change or disappear. Failures become `available: false`;
caching and retry backoff limit load.

## Known limits

- Built-ins cover narrow disclosed cases. Anthropic and many providers have no
  compatible water profile, so water remains unknown.
- Provider averages are comparisons, not exact per-agent measurements.
- Source-native totals cannot combine incompatible boundaries/statistics.
- National grid factors do not represent exact electricity sources.
- Lifecycle results cannot be converted into operational results.
- Replenishment claims are not subtracted from physical consumption.
- Component ranges stay unknown when sources publish only central values.
